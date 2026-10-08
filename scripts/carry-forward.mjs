// Keeps a deploy from moving the page's freshness backwards.
//
// Runs before the snapshot step. It reads the live site-data.json and, when the live page's
// last_checked is newer than anything this checkout knows about AND the live board for the current
// season is the same board this checkout has stored, writes that time to .cache/last-check.json.
// buildSiteData already publishes the newer of the committed index and that cache, so a deploy whose
// own ladder read fails still shows the last successful check instead of the older committed one.
// A board mismatch means the live check was of a board this checkout does not have, so nothing is
// carried forward. Network errors are a no-op (exit 0): the snapshot and verify steps decide the run.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, normalizeSnap } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function latestStored(seasonsDir, number) {
  const dir = path.join(seasonsDir, String(number), "snapshots");
  let names = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return null;
  }
  let latest = null;
  for (const name of names) {
    const doc = await readJsonOrNull(path.join(dir, name));
    for (const raw of doc?.snapshots || []) {
      const snap = normalizeSnap({ ...raw, season: raw.season || { number } });
      if (snap && snap.season.number === number && (!latest || Date.parse(snap.captured_at) > Date.parse(latest.captured_at))) {
        latest = snap;
      }
    }
  }
  return latest;
}

export function carryDecision({ live, index, cache, stored }) {
  const liveChecked = live?.index?.last_checked;
  const liveMs = Date.parse(liveChecked ?? "");
  if (!Number.isFinite(liveMs)) return { carry: false, reason: "live page has no last_checked" };
  const known = Math.max(
    Number.isFinite(Date.parse(index?.last_checked ?? "")) ? Date.parse(index.last_checked) : -Infinity,
    Number.isFinite(Date.parse(cache?.checked_at ?? "")) ? Date.parse(cache.checked_at) : -Infinity,
  );
  if (liveMs <= known) return { carry: false, reason: "checkout already has a check at least as new" };
  const number = live?.index?.current?.number;
  if (!Number.isFinite(number) || !stored) return { carry: false, reason: "no stored board for the live season" };
  const season = (live.seasons || []).find((item) => item.number === number);
  const liveLatest = season?.snapshots?.[season.snapshots.length - 1];
  if (!liveLatest) return { carry: false, reason: "live page has no board for its season" };
  if (fingerprint(number, liveLatest.entries || []) !== fingerprint(number, stored.entries)) {
    return { carry: false, reason: "live board differs from the stored board" };
  }
  return { carry: true, checked_at: liveChecked, reason: `live board matches stored ${stored.captured_at}` };
}

export async function carryForward(options = {}) {
  const dataRoot = options.root || root;
  const seasonsDir = path.join(dataRoot, "data/seasons");
  const cacheFile = options.cacheFile || path.join(dataRoot, ".cache", "last-check.json");
  let live = options.live ?? null;
  if (!live) {
    try {
      const url = new URL(options.url);
      url.searchParams.set("cb", String(Date.now()));
      const response = await (options.fetchImpl || fetch)(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      live = await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`carry-forward: live page unavailable (${message}); nothing carried`);
      return { carry: false, reason: `live page unavailable: ${message}` };
    }
  }
  const index = await readJsonOrNull(path.join(seasonsDir, "index.json"));
  const cache = await readJsonOrNull(cacheFile);
  const number = live?.index?.current?.number;
  const stored = Number.isFinite(number) ? await latestStored(seasonsDir, number) : null;
  const decision = carryDecision({ live, index, cache, stored });
  if (decision.carry) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, `${JSON.stringify({ checked_at: decision.checked_at, carried_from: "live" }, null, 2)}\n`);
  }
  console.log(`carry-forward: ${decision.carry ? `carried last_checked ${decision.checked_at}` : "nothing carried"} (${decision.reason})`);
  return decision;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const url = process.argv[2];
  if (!url) {
    console.log("usage: node scripts/carry-forward.mjs <live site-data.json url>");
    process.exit(2);
  }
  await carryForward({ url });
}
