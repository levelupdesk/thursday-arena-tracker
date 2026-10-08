// Fails the publish run (exit 1) when the data it published did not move with the source.
//
// scripts/snapshot.mjs records what it read from the API in .cache/snapshot-result.json. This
// script compares that with the site data that was built (--built) or is being served (--live):
//   - the snapshot step must have read the ladder (a fetch failure, an empty mid-season board or a
//     season number below the stored one is a failure, not a quiet green run);
//   - the published last_checked must be this run's check time;
//   - the published latest board for the season must equal the board this run read from the API;
//   - a run that wrote a ladder snapshot must publish it as the season's last_snapshot;
//   - if the match feed shows a game on this board after the latest snapshot (older than the grace
//     window), the board must have changed. Every match moves wins/losses/rating, so an unchanged
//     board after a match means the snapshot is stale.
// An unchanged ladder with no new games is fine: last_snapshot stays put, last_checked moves.
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MATCH_GRACE_MS = 10 * 60 * 1000;

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function verifyPublish(result, site, options = {}) {
  const grace = options.matchGraceMs ?? MATCH_GRACE_MS;
  const problems = [];
  if (!result || typeof result !== "object") {
    return { ok: false, problems: ["snapshot step left no result (.cache/snapshot-result.json missing)"] };
  }
  if (result.status !== "wrote" && result.status !== "deduped") {
    problems.push(
      `snapshot did not read the ladder: status=${result.status ?? "missing"} reason=${result.reason ?? "unknown"}` +
        (result.error ? ` (${result.error})` : ""),
    );
    return { ok: false, problems };
  }
  if (!site || typeof site !== "object" || !site.index) {
    return { ok: false, problems: ["site data missing or has no index"] };
  }
  if (site.index.fetch_failed === true) problems.push("published index is flagged fetch_failed");
  if (site.index.last_checked !== result.checked_at) {
    problems.push(
      `published last_checked ${site.index.last_checked ?? "missing"} is not this run's check ${result.checked_at}`,
    );
  }
  const season = (site.seasons || []).find((item) => item.number === result.season);
  const snaps = season?.snapshots || [];
  const latest = snaps[snaps.length - 1];
  if (!latest) {
    problems.push(`published data has no snapshot for season ${result.season}`);
    return { ok: problems.length === 0, problems };
  }
  const publishedFp = fingerprint(result.season, latest.entries || []);
  if (publishedFp !== result.source_fingerprint) {
    problems.push(
      `published season ${result.season} board (snapshot ${latest.captured_at}) differs from the board this run read from the API`,
    );
  }
  if (result.wrote_ladder && latest.captured_at !== result.captured_at) {
    problems.push(
      `wrote snapshot ${result.captured_at} but the published last_snapshot is ${latest.captured_at}`,
    );
  }
  const latestMs = Date.parse(latest.captured_at);
  const matchMs = Date.parse(result.newest_match_at ?? "");
  const checkedMs = Date.parse(result.checked_at);
  if (
    !result.wrote_ladder &&
    Number.isFinite(matchMs) &&
    Number.isFinite(latestMs) &&
    matchMs > latestMs &&
    checkedMs - matchMs > grace
  ) {
    problems.push(
      `a match on this board was played at ${iso(matchMs)}, after the latest snapshot ${latest.captured_at}, ` +
        `but the board read at ${result.checked_at} is unchanged`,
    );
  }
  return { ok: problems.length === 0, problems, latest_snapshot: latest.captured_at };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readJsonOrNull(file) {
  try {
    return await readJson(file);
  } catch {
    return null;
  }
}

async function fetchSite(url) {
  const busted = new URL(url);
  busted.searchParams.set("cb", String(Date.now()));
  const response = await fetch(busted, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${busted}`);
  return response.json();
}

function report(label, outcome, result) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (outcome.ok) {
    const line = `${label}: OK status=${result?.status} last_checked=${result?.checked_at} last_snapshot=${outcome.latest_snapshot}`;
    console.log(line);
    if (summary) appendFileSync(summary, `- ${line}\n`);
    return;
  }
  for (const problem of outcome.problems) console.log(`::error title=Stale publish (${label})::${problem}`);
  if (summary) appendFileSync(summary, outcome.problems.map((problem) => `- ${label}: FAIL ${problem}\n`).join(""));
}

function arg(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}

async function main() {
  const resultPath = arg("--result") || path.join(root, ".cache", "snapshot-result.json");
  const result = await readJsonOrNull(resultPath);
  const built = arg("--built");
  const live = arg("--live");
  let failed = false;
  if (built) {
    const outcome = verifyPublish(result, await readJsonOrNull(built));
    report("built", outcome, result);
    failed ||= !outcome.ok;
  }
  if (live) {
    const attempts = Number(arg("--attempts") || 9);
    const waitMs = Number(arg("--wait-ms") || 20_000);
    let outcome = { ok: false, problems: ["live page never checked"] };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        outcome = verifyPublish(result, await fetchSite(live));
      } catch (error) {
        outcome = { ok: false, problems: [`live fetch failed: ${error instanceof Error ? error.message : error}`] };
      }
      // A failed snapshot read cannot be fixed by waiting for the CDN.
      if (outcome.ok || !result || (result.status !== "wrote" && result.status !== "deduped")) break;
      if (attempt < attempts) {
        console.log(`live attempt ${attempt}/${attempts}: ${outcome.problems.join("; ")}; retrying in ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    report("live", outcome, result);
    failed ||= !outcome.ok;
  }
  if (!built && !live) {
    console.log("usage: node scripts/verify-publish.mjs [--built site-data.json] [--live url] [--result file]");
    process.exit(2);
  }
  process.exit(failed ? 1 : 0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.log(`::error title=Stale publish::verify-publish crashed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
