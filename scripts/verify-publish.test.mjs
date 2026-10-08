import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSiteData } from "./build-data.mjs";
import { newestBoardMatch, runSnapshot } from "./snapshot.mjs";
import { verifyPublish } from "./verify-publish.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LATEST_AT = "2026-10-07T23:56:14.789Z";
const SEASON = { number: 6, state: "active", starts_at: "2026-10-03T07:00:00Z", ends_at: null };

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function row(rank, handle, rating, wins = 10, losses = 5) {
  return { rank, ranked: true, x_handle: handle, rating, wins, losses, draws: 0 };
}

const storedBoard = [row(1, "alpha", 1418, 189, 90), row(2, "bravo", 1293, 277, 328)];

function match(playedAt, handles, season = "Season 6") {
  return {
    id: `m-${playedAt}-${handles.join("-")}`,
    played_at: playedAt,
    season,
    players: handles.map((handle) => ({ x_handle: handle, outcome: "win", elo_delta: 5 })),
    result: "win",
  };
}

// A temp repo holding one stored season-6 snapshot (the "published" board).
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "arena-verify-"));
  const seasons = path.join(dir, "data/seasons");
  await writeJson(path.join(seasons, "index.json"), {
    generated_at: LATEST_AT,
    last_checked: LATEST_AT,
    current: SEASON,
    next: null,
    seasons: [{ ...SEASON, first_snapshot: LATEST_AT, last_snapshot: LATEST_AT }],
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
      {
        captured_at: LATEST_AT,
        verified: true,
        final: false,
        season: { number: 6, state: "active" },
        count: storedBoard.length,
        entries: storedBoard,
      },
    ],
  });
  await writeJson(path.join(dir, "data/catalog/2026-10-08.json"), { captured_at: LATEST_AT, bots: [] });
  return dir;
}

function api({ board = storedBoard, matches = [], failLadder = false, failMatches = false } = {}) {
  return async (url) => {
    const href = String(url);
    if (href.includes("/leaderboard")) {
      if (failLadder) return { ok: false, error: "HTTP 503 for leaderboard" };
      return {
        ok: true,
        status: 200,
        body: { season: { number: 6, name: "Season 6", state: "active" }, data: board, next_cursor: null },
      };
    }
    if (href.includes("/matches")) {
      if (failMatches) return { ok: false, error: "HTTP 500 for matches" };
      return { ok: true, status: 200, body: { data: matches } };
    }
    if (href.includes("/season")) return { ok: true, status: 200, body: { current: SEASON, next: null } };
    return { ok: false, error: `unexpected ${href}` };
  };
}

async function runAndBuild(dir, checkedAt, fetchJson) {
  const status = await runSnapshot({ root: dir, fetchJson, now: () => new Date(checkedAt) });
  const site = await buildSiteData({ root: dir, outFile: path.join(dir, "dist/data/site-data.json") });
  const result = JSON.parse(await readFile(path.join(dir, ".cache/snapshot-result.json"), "utf8"));
  return { status, site, result };
}

function cli(dir) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/verify-publish.mjs"),
      "--built",
      path.join(dir, "dist/data/site-data.json"),
      "--result",
      path.join(dir, ".cache/snapshot-result.json"),
    ],
    { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
  );
}

describe("verify-publish: green runs", () => {
  it("passes when the board changed and the new snapshot is published", async () => {
    const dir = await fixture();
    const checkedAt = "2026-10-08T02:11:05.000Z";
    const moved = [row(1, "alpha", 1430, 190, 90), row(2, "bravo", 1281, 277, 329)];
    const { status, site, result } = await runAndBuild(
      dir,
      checkedAt,
      api({ board: moved, matches: [match("2026-10-08T02:05:00.000Z", ["alpha", "bravo"])] }),
    );
    assert.equal(status, "wrote");
    assert.equal(result.wrote_ladder, true);
    assert.equal(site.index.seasons.find((season) => season.number === 6).last_snapshot, checkedAt);
    assert.deepEqual(verifyPublish(result, site).problems, []);
    assert.equal(cli(dir).status, 0);
  });

  it("passes a quiet ladder: no new matches, last_snapshot stays, last_checked moves", async () => {
    const dir = await fixture();
    const checkedAt = "2026-10-08T02:11:05.000Z";
    const { status, site, result } = await runAndBuild(
      dir,
      checkedAt,
      api({ matches: [match("2026-10-07T23:51:02.540Z", ["alpha", "bravo"])] }),
    );
    assert.equal(status === "wrote" || status === "deduped", true);
    assert.equal(result.wrote_ladder, false);
    assert.equal(result.newest_match_at, "2026-10-07T23:51:02.540Z");
    assert.equal(site.index.last_checked, checkedAt);
    assert.equal(site.index.seasons.find((season) => season.number === 6).last_snapshot, LATEST_AT);
    const outcome = verifyPublish(result, site);
    assert.deepEqual(outcome.problems, []);
    assert.equal(cli(dir).status, 0);
  });

  it("allows a match inside the grace window and ignores matches with no player on the board", async () => {
    const dir = await fixture();
    const checkedAt = "2026-10-08T02:11:05.000Z";
    const { result, site } = await runAndBuild(
      dir,
      checkedAt,
      api({
        matches: [
          match("2026-10-08T02:06:00.000Z", ["alpha", "bravo"]),
          match("2026-10-08T01:00:00.000Z", ["stranger", "nobody"]),
          match("2026-10-08T01:00:00.000Z", ["alpha", "bravo"], "Season 5"),
        ],
      }),
    );
    assert.deepEqual(verifyPublish(result, site).problems, []);
  });

  it("stays green with a warning when only the match feed is down", async () => {
    const dir = await fixture();
    const { result, site } = await runAndBuild(dir, "2026-10-08T02:11:05.000Z", api({ failMatches: true }));
    assert.equal(result.matches_checked, false);
    assert.deepEqual(verifyPublish(result, site).problems, []);
  });
});

describe("verify-publish: red runs", () => {
  it("fails when a match on the board was played after the latest snapshot but the board is unchanged", async () => {
    const dir = await fixture();
    const { status, site, result } = await runAndBuild(
      dir,
      "2026-10-08T02:11:05.000Z",
      api({ matches: [match("2026-10-08T01:30:00.000Z", ["alpha", "charlie"])] }),
    );
    assert.equal(status === "wrote" || status === "deduped", true);
    assert.equal(result.wrote_ladder, false);
    const outcome = verifyPublish(result, site);
    assert.equal(outcome.ok, false);
    assert.match(outcome.problems.join("\n"), /played at 2026-10-08T01:30:00.000Z, after the latest snapshot/);
    const run = cli(dir);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /::error title=Stale publish \(built\)::/);
  });

  it("fails when the ladder fetch fails (no more green runs on stored data)", async () => {
    const dir = await fixture();
    const { status, site, result } = await runAndBuild(dir, "2026-10-08T02:11:05.000Z", api({ failLadder: true }));
    assert.equal(status, "skipped");
    assert.equal(result.reason, "fetch_failed");
    const outcome = verifyPublish(result, site);
    assert.equal(outcome.ok, false);
    assert.match(outcome.problems[0], /status=skipped reason=fetch_failed \(HTTP 503 for leaderboard\)/);
    assert.equal(cli(dir).status, 1);
  });

  it("fails when an empty board mid-season makes the run keep stored data", async () => {
    const dir = await fixture();
    const { result, site } = await runAndBuild(dir, "2026-10-08T02:11:05.000Z", api({ board: [] }));
    assert.equal(result.reason, "empty_ladder_kept");
    assert.equal(verifyPublish(result, site).ok, false);
  });

  it("fails when the published data does not contain the snapshot this run wrote", async () => {
    const dir = await fixture();
    const stale = await buildSiteData({ root: dir, outFile: path.join(dir, "stale-site-data.json") });
    const moved = [row(1, "alpha", 1430, 190, 90), row(2, "bravo", 1281, 277, 329)];
    const { result } = await runAndBuild(dir, "2026-10-08T02:11:05.000Z", api({ board: moved }));
    const outcome = verifyPublish(result, stale);
    assert.equal(outcome.ok, false);
    const text = outcome.problems.join("\n");
    assert.match(text, /published last_checked .* is not this run's check/);
    assert.match(text, /differs from the board this run read from the API/);
    assert.match(text, /wrote snapshot 2026-10-08T02:11:05.000Z but the published last_snapshot is 2026-10-07T23:56:14.789Z/);
  });

  it("fails when the snapshot step left no result", () => {
    const outcome = verifyPublish(null, { index: {} });
    assert.equal(outcome.ok, false);
    assert.match(outcome.problems[0], /left no result/);
  });

  it("fails when the season refuses to write because the API season went backwards", async () => {
    const dir = await fixture();
    const fetchJson = async (url) => {
      const href = String(url);
      if (href.includes("/leaderboard")) {
        return { ok: true, status: 200, body: { season: { number: 5, state: "ended" }, data: storedBoard, next_cursor: null } };
      }
      if (href.includes("/season")) return { ok: true, status: 200, body: { current: SEASON, next: null } };
      return { ok: false, error: "skip" };
    };
    const { status, result, site } = await runAndBuild(dir, "2026-10-08T02:11:05.000Z", fetchJson);
    assert.equal(status, "skipped");
    assert.equal(result.reason, "season_regressed");
    assert.equal(verifyPublish(result, site).ok, false);
  });
});

describe("newestBoardMatch", () => {
  it("returns the newest same-season match with a player on the board", () => {
    const body = {
      data: [
        match("2026-10-08T01:00:00.000Z", ["alpha"]),
        match("2026-10-08T02:00:00.000Z", ["outsider"]),
        match("2026-10-08T03:00:00.000Z", ["ALPHA"], "Season 7"),
        match("2026-10-08T01:30:00.000Z", ["Bravo"]),
      ],
    };
    assert.deepEqual(newestBoardMatch(body, 6, storedBoard), { ok: true, newest_match_at: "2026-10-08T01:30:00.000Z" });
    assert.deepEqual(newestBoardMatch({ data: [] }, 6, storedBoard), { ok: true, newest_match_at: null });
    assert.equal(newestBoardMatch({}, 6, storedBoard).ok, false);
  });
});
