import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSiteData } from "./build-data.mjs";
import { carryDecision, carryForward } from "./carry-forward.mjs";
import { runSnapshot } from "./snapshot.mjs";
import { verifyPublish } from "./verify-publish.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEASON = { number: 6, state: "active", starts_at: "2026-10-03T07:00:00Z", ends_at: null };
const SNAP_AT = "2026-10-07T23:56:14.789Z";
const COMMITTED_CHECK = "2026-10-08T00:07:24.037Z"; // 5:07 PM PT, the value the Oct 7 merge deploy regressed to
const LIVE_CHECK = "2026-10-08T02:56:16.904Z"; // 7:56 PM PT, already live before the merge

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function row(rank, handle, rating, wins = 10, losses = 5) {
  return { rank, ranked: true, x_handle: handle, rating, wins, losses, draws: 0 };
}

const board = [row(1, "kryptic_007_", 1418, 189, 90), row(2, "lucjangrzeugm2", 1293, 277, 328)];

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "arena-carry-"));
  const seasons = path.join(dir, "data/seasons");
  await writeJson(path.join(seasons, "index.json"), {
    generated_at: COMMITTED_CHECK,
    last_checked: COMMITTED_CHECK,
    current: SEASON,
    next: null,
    seasons: [{ ...SEASON, first_snapshot: SNAP_AT, last_snapshot: SNAP_AT }],
  });
  await writeJson(path.join(seasons, "5/final.json"), {
    final: true,
    complete: true,
    captured_at: "2026-10-03T07:01:00.000Z",
    season: { number: 5, state: "ended" },
    count: 1,
    entries: [row(1, "prior", 1200)],
  });
  await writeJson(path.join(seasons, "6/snapshots/2026-10-07.json"), {
    date: "2026-10-07",
    season_number: 6,
    snapshots: [
      { captured_at: SNAP_AT, verified: true, final: false, season: { number: 6, state: "active" }, count: 2, entries: board },
    ],
  });
  return dir;
}

function liveSite(lastChecked, entries = board) {
  return {
    generated_at: lastChecked,
    index: { last_checked: lastChecked, current: { number: 6, state: "active" } },
    seasons: [{ number: 6, snapshots: [{ captured_at: SNAP_AT, entries }] }],
  };
}

describe("carry-forward decision", () => {
  const stored = { captured_at: SNAP_AT, entries: board };
  it("carries a newer live check when the live board is the stored board", () => {
    const decision = carryDecision({ live: liveSite(LIVE_CHECK), index: { last_checked: COMMITTED_CHECK }, cache: null, stored });
    assert.equal(decision.carry, true);
    assert.equal(decision.checked_at, LIVE_CHECK);
  });
  it("does not carry when the live board differs from the stored board", () => {
    const other = [row(1, "kryptic_007_", 1430, 190, 90), board[1]];
    const decision = carryDecision({ live: liveSite(LIVE_CHECK, other), index: { last_checked: COMMITTED_CHECK }, stored });
    assert.equal(decision.carry, false);
    assert.match(decision.reason, /differs/);
  });
  it("does not carry an older or equal live check", () => {
    assert.equal(carryDecision({ live: liveSite(COMMITTED_CHECK), index: { last_checked: COMMITTED_CHECK }, stored }).carry, false);
    assert.equal(
      carryDecision({ live: liveSite(LIVE_CHECK), index: { last_checked: COMMITTED_CHECK }, cache: { checked_at: "2026-10-08T03:00:00Z" }, stored }).carry,
      false,
    );
  });
  it("does not carry without a live last_checked or a stored board", () => {
    assert.equal(carryDecision({ live: {}, index: {}, stored }).carry, false);
    assert.equal(carryDecision({ live: liveSite(LIVE_CHECK), index: {}, stored: null }).carry, false);
  });
});

describe("merge deploy keeps freshness", () => {
  it("publishes the live last_checked, not the older committed one, when the merge run's ladder read fails", async () => {
    const dir = await fixture();
    const decision = await carryForward({ root: dir, live: liveSite(LIVE_CHECK) });
    assert.equal(decision.carry, true);
    const status = await runSnapshot({
      root: dir,
      fetchJson: async () => ({ ok: false, error: "HTTP 503" }),
      now: () => new Date("2026-10-08T03:05:00.000Z"),
    });
    assert.equal(status, "skipped");
    const site = await buildSiteData({ root: dir, outFile: path.join(dir, "dist/data/site-data.json") });
    assert.equal(site.index.last_checked, LIVE_CHECK);
    // The run is still red: the ladder was not read.
    const result = JSON.parse(await readFile(path.join(dir, ".cache/snapshot-result.json"), "utf8"));
    assert.equal(verifyPublish(result, site).ok, false);
  });

  it("publishes this run's own check when the merge run reads the ladder", async () => {
    const dir = await fixture();
    await carryForward({ root: dir, live: liveSite(LIVE_CHECK) });
    const checkedAt = "2026-10-08T03:05:00.000Z";
    const fetchJson = async (url) => {
      const href = String(url);
      if (href.includes("/leaderboard")) {
        return { ok: true, status: 200, body: { season: { number: 6, name: "Season 6", state: "active" }, data: board, next_cursor: null } };
      }
      if (href.includes("/matches")) return { ok: true, status: 200, body: { data: [] } };
      if (href.includes("/season")) return { ok: true, status: 200, body: { current: SEASON, next: null } };
      return { ok: false, error: "skip" };
    };
    await runSnapshot({ root: dir, fetchJson, now: () => new Date(checkedAt) });
    const site = await buildSiteData({ root: dir, outFile: path.join(dir, "dist/data/site-data.json") });
    assert.equal(site.index.last_checked, checkedAt);
    const result = JSON.parse(await readFile(path.join(dir, ".cache/snapshot-result.json"), "utf8"));
    assert.deepEqual(verifyPublish(result, site).problems, []);
  });

  it("is a no-op when the live page cannot be read", async () => {
    const dir = await fixture();
    const decision = await carryForward({
      root: dir,
      url: "https://example.test/data/site-data.json",
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    assert.equal(decision.carry, false);
    const site = await buildSiteData({ root: dir, outFile: path.join(dir, "dist/data/site-data.json") });
    assert.equal(site.index.last_checked, COMMITTED_CHECK);
  });
});

describe("site.yml", () => {
  it("snapshots and verifies on every event, including push (merge) deploys", async () => {
    const yml = await readFile(path.join(root, ".github/workflows/site.yml"), "utf8");
    assert.doesNotMatch(yml, /github\.event_name != 'push'/);
    const order = [
      "uses: actions/checkout",
      "scripts/carry-forward.mjs",
      "scripts/snapshot.mjs",
      "Commit snapshot data",
      "npm run build",
      "actions/deploy-pages",
      "verify-publish.mjs --built",
      "verify-publish.mjs --live",
    ].map((needle) => yml.indexOf(needle));
    assert.ok(order.every((at) => at >= 0), `missing step: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(yml, /ref: \$\{\{ github\.ref == 'refs\/heads\/main' && 'main' \|\| github\.sha \}\}/);
  });
});
