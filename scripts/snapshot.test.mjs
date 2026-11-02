import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSiteData } from "./build-data.mjs";
import { summarizeCatalog } from "./lib.mjs";
import { fetchJson, maybeWriteFinal, runSnapshot } from "./snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readOrNull(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function row(rank, handle) {
  return { rank, x_handle: handle, rating: 1100, wins: 1, losses: 0, draws: 0 };
}

describe("catalog snapshot", () => {
  it("stores only summary inputs and builds the same catalog statistics", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "arena-catalog-"));
    const checkedAt = "2026-11-02T03:00:00.000Z";
    const current = { number: 1, state: "active", starts_at: checkedAt };
    const bots = [
      {
        name: "Example bot", rarity: "common", cost: 3, attack: 2, health: 5,
        crew: "ops", season: 1, authorHandle: "example_author",
        author: "Example author", extra: { unused: "metadata" },
      },
      { name: "Another bot", rarity: "rare", cost: 4, attack: 6, health: 3 },
    ];
    const fetchJson = async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/public/v1/season") return { ok: true, body: { current } };
      if (pathname === "/api/public/v1/leaderboard") {
        return { ok: true, body: { season: current, data: [row(1, "alpha")] } };
      }
      if (pathname === "/api/catalog") return { ok: true, body: bots };
      if (pathname === "/api/public/v1/matches") return { ok: true, body: { data: [] } };
      throw new Error(`unexpected URL ${url}`);
    };

    assert.equal(await runSnapshot({ root: dir, fetchJson, now: () => new Date(checkedAt) }), "wrote");
    const saved = JSON.parse(await readFile(path.join(dir, "data/catalog/2026-11-02.json"), "utf8"));
    assert.deepEqual(saved, {
      captured_at: checkedAt,
      source: "https://thursdayarena.com/api/catalog",
      count: 2,
      bots: [
        { rarity: "common", cost: 3, attack: 2, health: 5, crew: "ops", season: 1 },
        { rarity: "rare", cost: 4, attack: 6, health: 3 },
      ],
    });
    const payload = await buildSiteData({ root: dir });
    assert.deepEqual(payload.catalog, summarizeCatalog(bots, checkedAt));
  });
});

describe("partial season final", () => {
  it("saves 2000 rows with complete:false when the cursor never ends", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "arena-final-"));
    let pages = 0;
    const fetchJson = async () => {
      const start = pages * 100;
      pages += 1;
      return {
        ok: true,
        status: 200,
        body: {
          season: { number: 9, state: "ended" },
          next_cursor: `cursor-${pages}`,
          data: Array.from({ length: 100 }, (_, index) => row(start + index + 1, `player${start + index}`)),
        },
      };
    };
    const status = await maybeWriteFinal(9, {
      seasonsRoot: dir,
      fetchJson,
      now: () => new Date("2026-09-24T23:00:00.000Z"),
    });
    assert.equal(status, "wrote");
    assert.equal(pages, 20);
    const saved = JSON.parse(await readFile(path.join(dir, "9", "final.json"), "utf8"));
    assert.equal(saved.complete, false);
    assert.equal(saved.final, true);
    assert.equal(saved.count, 2000);
    assert.equal(saved.entries.length, 2000);
    assert.equal(saved.pages, 20);
  });
});

describe("quiet snapshot", () => {
  it("publishes the run time as last_checked from a temp fixture and leaves the repo untouched", async () => {
    const repoCache = path.join(root, ".cache/last-check.json");
    const cacheBefore = await readOrNull(repoCache);
    const gitBefore = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    const dir = await mkdtemp(path.join(tmpdir(), "arena-quiet-"));
    const olderAt = "2026-09-24T22:06:41.542Z";
    const latestAt = "2026-09-25T00:17:00.000Z";
    const checkedAt = "2026-09-25T00:17:00.000Z";
    const current = {
      number: 4,
      state: "active",
      starts_at: "2026-09-23T07:00:00Z",
      ends_at: "2026-09-26T07:00:00Z",
    };
    const next = { number: 5, state: "scheduled", starts_at: "2026-09-26T07:00:00Z", ends_at: null };
    const latestEntries = [row(1, "alpha")];
    const seasons = path.join(dir, "data/seasons");
    await writeJson(path.join(seasons, "index.json"), {
      generated_at: olderAt,
      last_checked: olderAt,
      current,
      next,
      seasons: [
        { number: 3, state: "ended", starts_at: null, ends_at: "2026-09-23T07:00:00Z" },
        {
          number: 4,
          state: "active",
          starts_at: current.starts_at,
          ends_at: current.ends_at,
          first_snapshot: olderAt,
          last_snapshot: latestAt,
        },
      ],
    });
    await writeJson(path.join(seasons, "3/final.json"), {
      final: true,
      captured_at: "2026-09-23T07:00:00.000Z",
      season: { number: 3, state: "ended" },
      count: 1,
      entries: [row(1, "prior")],
    });
    await writeJson(path.join(seasons, "4/snapshots/2026-09-24.json"), {
      date: "2026-09-24",
      season_number: 4,
      snapshots: [
        {
          captured_at: olderAt,
          verified: true,
          final: false,
          season: { number: 4, state: "active" },
          count: 1,
          entries: [row(1, "oldplayer")],
        },
      ],
    });
    await writeJson(path.join(seasons, "4/snapshots/2026-09-25.json"), {
      date: "2026-09-25",
      season_number: 4,
      snapshots: [
        {
          captured_at: latestAt,
          verified: true,
          final: false,
          season: { number: 4, state: "active" },
          count: 1,
          entries: latestEntries,
        },
      ],
    });
    await writeJson(path.join(dir, "data/catalog/2026-09-25.json"), {
      captured_at: latestAt,
      bots: [],
    });
    const fetchJson = async (url) => {
      const href = String(url);
      if (href.includes("/season") && !href.includes("/leaderboard")) {
        return { ok: true, status: 200, body: { current, next } };
      }
      if (href.includes("/leaderboard")) {
        return {
          ok: true,
          status: 200,
          body: {
            season: { number: 4, state: "active", name: "Season 4" },
            data: latestEntries,
            next_cursor: null,
          },
        };
      }
      throw new Error(`unexpected fetch ${href}`);
    };
    const status = await runSnapshot({
      root: dir,
      fetchJson,
      now: () => new Date(checkedAt),
    });
    assert.equal(status, "deduped");
    const cache = JSON.parse(await readFile(path.join(dir, ".cache/last-check.json"), "utf8"));
    assert.equal(cache.checked_at, checkedAt);
    const nextDay = JSON.parse(await readFile(path.join(seasons, "4/snapshots/2026-09-25.json"), "utf8"));
    const previousDay = JSON.parse(await readFile(path.join(seasons, "4/snapshots/2026-09-24.json"), "utf8"));
    assert.equal(nextDay.snapshots.length, 1);
    assert.equal(previousDay.snapshots.length, 1);
    const site = await buildSiteData({ root: dir, outFile: path.join(dir, "site-data.json") });
    assert.equal(site.index.last_checked, checkedAt);
    assert.equal(await readOrNull(repoCache), cacheBefore);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), gitBefore);
  });
});

describe("fetch failures", () => {
  it("returns ok:false on a timeout instead of throwing", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    try {
      const result = await fetchJson("https://example.test/leaderboard");
      assert.equal(result.ok, false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("retries a 429 once after Retry-After", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("slow", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const result = await fetchJson("https://example.test/leaderboard");
      assert.equal(calls, 2);
      assert.equal(result.ok, true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not throw when the injected fetch throws", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "arena-timeout-"));
    const seasons = path.join(dir, "data/seasons");
    await writeJson(path.join(seasons, "index.json"), {
      current: { number: 4, state: "active", starts_at: "2026-09-23T07:00:00Z" },
      seasons: [{ number: 4, state: "active" }],
    });
    await writeJson(path.join(seasons, "4/snapshots/2026-09-25.json"), {
      date: "2026-09-25",
      season_number: 4,
      snapshots: [
        {
          captured_at: "2026-09-25T01:00:00.000Z",
          verified: true,
          season: { number: 4, state: "active" },
          count: 1,
          entries: [row(1, "kept")],
        },
      ],
    });
    const logs = [];
    const original = console.log;
    console.log = (...args) => {
      logs.push(args.map(String).join(" "));
      original(...args);
    };
    let status;
    try {
      status = await runSnapshot({
        root: dir,
        fetchJson: async () => {
          throw new Error("timed out");
        },
        now: () => new Date("2026-09-25T02:00:00.000Z"),
      });
    } finally {
      console.log = original;
    }
    assert.equal(status, "skipped");
    assert.match(logs.join("\n"), /::warning::Leaderboard fetch failed/);
    const saved = JSON.parse(await readFile(path.join(seasons, "4/snapshots/2026-09-25.json"), "utf8"));
    assert.equal(saved.snapshots.length, 1);
    assert.equal(saved.snapshots[0].entries[0].x_handle, "kept");
    const index = JSON.parse(await readFile(path.join(seasons, "index.json"), "utf8"));
    assert.equal(index.fetch_failed, true);
    await buildSiteData({ root: dir, outFile: path.join(dir, "public/data/site-data.json") });
    const site = JSON.parse(await readFile(path.join(dir, "public/data/site-data.json"), "utf8"));
    assert.equal(site.index.fetch_failed, true);
    assert.equal(site.seasons[0].snapshots[0].entries[0].x_handle, "kept");
  });
});

describe("empty ladder mid-season", () => {
  it("keeps the last snapshot when the board comes back empty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "arena-empty-"));
    const seasons = path.join(dir, "data/seasons");
    const capturedAt = "2026-09-25T18:00:00.000Z";
    await writeJson(path.join(seasons, "index.json"), {
      current: { number: 4, state: "active", starts_at: "2026-09-23T07:00:00Z", ends_at: "2026-09-26T07:00:00Z" },
      seasons: [{ number: 4, state: "active", starts_at: "2026-09-23T07:00:00Z" }],
    });
    await writeJson(path.join(seasons, "4/snapshots/2026-09-25.json"), {
      date: "2026-09-25",
      season_number: 4,
      snapshots: [
        {
          captured_at: "2026-09-25T17:00:00.000Z",
          verified: true,
          final: false,
          season: { number: 4, state: "active" },
          count: 1,
          entries: [row(1, "kept")],
        },
      ],
    });
    const logs = [];
    const original = console.log;
    console.log = (...args) => {
      logs.push(args.map(String).join(" "));
      original(...args);
    };
    let status;
    try {
      status = await runSnapshot({
        root: dir,
        now: () => new Date(capturedAt),
        fetchJson: async (url) => {
          const href = String(url);
          if (href.includes("/leaderboard")) {
            return { ok: true, status: 200, body: { season: { number: 4, state: "active" }, data: [], next_cursor: null } };
          }
          if (href.includes("/season")) {
            return {
              ok: true,
              status: 200,
              body: {
                current: { number: 4, state: "active", starts_at: "2026-09-23T07:00:00Z", ends_at: "2026-09-26T07:00:00Z" },
                next: null,
              },
            };
          }
          return { ok: false, error: "skip" };
        },
      });
    } finally {
      console.log = original;
    }
    assert.equal(status, "skipped");
    assert.match(logs.join("\n"), /::warning::Empty leaderboard mid-season/);
    const saved = JSON.parse(await readFile(path.join(seasons, "4/snapshots/2026-09-25.json"), "utf8"));
    assert.equal(saved.snapshots.length, 1);
    assert.equal(saved.snapshots[0].entries[0].x_handle, "kept");
    const index = JSON.parse(await readFile(path.join(seasons, "index.json"), "utf8"));
    assert.equal(index.fetch_failed, true);
    assert.equal(await readOrNull(path.join(dir, ".cache/last-check.json")), null);
  });
});

describe("season final after reset", () => {
  it("stores the ended season from leaderboard?season=4, not the default board", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "arena-reset-"));
    const seasons = path.join(dir, "data/seasons");
    const asked = [];
    await writeJson(path.join(seasons, "index.json"), {
      current: { number: 4, state: "active", starts_at: "2026-09-23T07:00:00Z", ends_at: "2026-09-26T07:00:00Z" },
      seasons: [{ number: 4, state: "active" }],
    });
    await writeJson(path.join(seasons, "4/snapshots/2026-09-25.json"), {
      date: "2026-09-25",
      season_number: 4,
      snapshots: [
        {
          captured_at: "2026-09-25T18:00:00.000Z",
          verified: true,
          final: false,
          season: { number: 4, state: "active" },
          count: 1,
          entries: [row(1, "s4champ")],
        },
      ],
    });
    const status = await runSnapshot({
      root: dir,
      now: () => new Date("2026-09-26T07:05:00.000Z"),
      fetchJson: async (url) => {
        const href = String(url);
        asked.push(href);
        if (href.includes("/leaderboard") && href.includes("season=4")) {
          return {
            ok: true,
            status: 200,
            body: { season: { number: 4, state: "ended" }, data: [row(1, "s4champ")], next_cursor: null },
          };
        }
        if (href.includes("/leaderboard")) {
          return {
            ok: true,
            status: 200,
            body: { season: { number: 5, state: "active" }, data: [row(1, "s5new")], next_cursor: null },
          };
        }
        if (href.includes("/season")) {
          return {
            ok: true,
            status: 200,
            body: {
              current: { number: 5, state: "active", starts_at: "2026-09-26T07:00:00Z", ends_at: "2026-09-29T07:00:00Z" },
              next: null,
            },
          };
        }
        return { ok: false, error: "skip" };
      },
    });
    assert.equal(status, "wrote");
    assert.ok(asked.some((href) => href.includes("leaderboard") && href.includes("season=4")));
    const finalDoc = JSON.parse(await readFile(path.join(seasons, "4/final.json"), "utf8"));
    assert.equal(finalDoc.season.number, 4);
    assert.equal(finalDoc.entries[0].x_handle, "s4champ");
    assert.equal(finalDoc.entries.some((entry) => entry.x_handle === "s5new"), false);
    assert.match(finalDoc.source, /season=4/);
  });
});
