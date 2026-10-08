import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  appearances,
  appearancesAcross,
  byTime,
  chartInstant,
  chartSegments,
  classifyLadder,
  coveringPair,
  dayMoverPlan,
  FREQUENCY_MIN_DAYS,
  defaultChartSeason,
  frequencySeason,
  inTop20,
  isStale,
  endedWaitingText,
  justReset,
  knownHandles,
  movementSnaps,
  ratingDeltas,
  rosterChanges,
  rosterWindow,
  seasonEnded,
  seasonLabel,
  seriesFor,
  freshnessFallbackNote,
  showEmptyLiveBoard,
  showUnverifiedNote,
  playersShownNote,
  topShownNote,
  sinceStartLabel,
  versusPreviousSeason,
  weekMoverPlan,
  withTiedCutoff,
  type Row,
  type Snap,
} from "./metrics.ts";

function row(partial: Partial<Row> & Pick<Row, "x_handle" | "rank" | "rating">): Row {
  return {
    wins: 1,
    losses: 0,
    draws: 0,
    ...partial,
  };
}

function snap(season: number, iso: string, entries: Row[], count = entries.length): Snap {
  return { captured_at: iso, season, count, entries };
}

describe("season labels", () => {
  it("labels by number when the stored name disagrees", () => {
    const number = 2;
    const storedName = "Season 1";
    assert.equal(seasonLabel(number), "Season 2");
    assert.notEqual(seasonLabel(number), storedName);
  });
});

describe("player history suggestions", () => {
  it("sorts handles and removes case-insensitive duplicates", () => {
    assert.deepEqual(
      knownHandles([
        row({ x_handle: "zeta", rank: 1, rating: 1000 }),
        row({ x_handle: "Alpha", rank: 2, rating: 1000 }),
        row({ x_handle: " alpha ", rank: 3, rating: 1000 }),
      ]),
      ["alpha", "zeta"],
    );
  });
});

describe("ladder states", () => {
  it("treats an empty board as no ranked games", () => {
    const view = classifyLadder([]);
    assert.equal(view.kind, "empty");
    assert.match(view.message, /No ranked games yet this season/);
  });

  it("shows a thin ranked board without padding", () => {
    const view = classifyLadder([
      row({ x_handle: "a", rank: 1, rating: 1002, ranked: true, wins: 1 }),
      row({ x_handle: "b", rank: 2, rating: 1000, ranked: true, wins: 0, losses: 0, draws: 0 }),
      row({ x_handle: "c", rank: 3, rating: 1001, ranked: true, wins: 1 }),
    ]);
    assert.equal(view.kind, "partial");
    if (view.kind !== "partial") return;
    assert.equal(view.rankedCount, 3);
    assert.equal(view.rows.length, 3);
    assert.match(view.message, /3 ranked players so far/);
  });

  it("treats an all-unranked board as empty", () => {
    const view = classifyLadder([
      row({ x_handle: "a", rank: 1, rating: 1000, ranked: false, wins: 0, losses: 0, draws: 0 }),
      row({ x_handle: "b", rank: 2, rating: 1000, ranked: false, wins: 0, losses: 0, draws: 0 }),
      row({ x_handle: "c", rank: 3, rating: 1000, ranked: false, wins: 0, losses: 0, draws: 0 }),
    ]);
    assert.equal(view.kind, "empty");
  });
});

describe("top 20 ties and depth", () => {
  it("includes a rating tie past rank 20 and everyone in a 20-row cut", () => {
    const deep = [
      ...Array.from({ length: 19 }, (_, index) => row({ x_handle: `p${index}`, rank: index + 1, rating: 1500 - index })),
      row({ x_handle: "tied-a", rank: 20, rating: 1400 }),
      row({ x_handle: "tied-b", rank: 21, rating: 1400 }),
      row({ x_handle: "out", rank: 22, rating: 1390 }),
    ];
    const handles = inTop20(deep, deep.length).map((item) => item.x_handle);
    assert.ok(handles.includes("tied-a"));
    assert.ok(handles.includes("tied-b"));
    assert.ok(!handles.includes("out"));

    const shallow = [row({ x_handle: "only", rank: 1, rating: 1100 })];
    assert.equal(inTop20(shallow, 20).length, 1);
  });
});

describe("movers stay inside one season", () => {
  it("rejects a pair whose season numbers differ and does not return deltas", () => {
    const from = snap(2, "2026-09-18T00:00:00Z", [row({ x_handle: "a", rank: 1, rating: 1200 })]);
    const to = snap(7, "2026-09-24T00:00:00Z", [row({ x_handle: "a", rank: 1, rating: 1600 })]);
    const result = ratingDeltas(from, to);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "different-seasons");
  });

  it("does not call a short window a 24 hour delta", () => {
    const snaps = [
      snap(7, "2026-09-24T00:00:00Z", [row({ x_handle: "a", rank: 1, rating: 1100 })]),
      snap(7, "2026-09-24T02:00:00Z", [row({ x_handle: "a", rank: 1, rating: 1120 })]),
    ];
    const plan = dayMoverPlan(snaps, "2026-09-20T00:00:00Z", Date.parse("2026-09-24T02:00:00Z"));
    assert.equal(plan.kind, "not-computed");
    const young = dayMoverPlan(snaps, "2026-09-24T00:00:00Z", Date.parse("2026-09-24T02:00:00Z"));
    assert.equal(young.kind, "since-start");
    if (young.kind === "since-start") {
      assert.equal(young.label, sinceStartLabel(2));
      assert.equal(young.rows[0].delta, 120);
    }
  });

  it("hides players with no games in the season-start view", () => {
    const snaps = [snap(7, "2026-09-26T08:00:00Z", [
      row({ x_handle: "idle", rank: 2, rating: 1000, wins: 0, losses: 0, draws: 0 }),
      row({ x_handle: "played", rank: 1, rating: 1014, wins: 1 }),
    ])];
    const plan = dayMoverPlan(snaps, "2026-09-26T07:00:00Z", Date.parse("2026-09-26T08:00:00Z"));
    assert.equal(plan.kind, "since-start");
    if (plan.kind === "since-start") {
      assert.deepEqual(plan.rows.map((item) => item.handle), ["played"]);
    }
  });

  it("replaces a 7 day window that the season cannot cover", () => {
    const snaps = [
      snap(7, "2026-09-24T00:00:00Z", [
        row({ x_handle: "a", rank: 2, rating: 1100, last_season: { season: 6, rating: 1400, rank: 4 } }),
      ]),
      snap(7, "2026-09-25T00:00:00Z", [
        row({ x_handle: "a", rank: 1, rating: 1120, last_season: { season: 6, rating: 1400, rank: 4 } }),
      ]),
    ];
    const plan = weekMoverPlan(snaps, 7);
    assert.equal(plan.kind, "season-to-date");
    if (plan.kind === "season-to-date") {
      assert.match(plan.note, /7-day view spans seasons; showing season-to-date/);
      assert.equal(plan.deltas?.[0].ratingDelta, 20);
      assert.equal(plan.versusPrevious[0].previousSeason, 6);
      assert.equal(plan.versusPrevious[0].ratingDelta, 1120 - 1400);
    }
  });

  it("a Season 5 snapshot with everyone at 1000 yields no rows", () => {
    const rows = [1, 2, 3].map((rank) =>
      row({
        x_handle: `p${rank}`,
        rank,
        rating: 1000,
        wins: 0,
        losses: 0,
        draws: 0,
        last_season: { season: 4, rating: 1600, rank },
      }),
    );
    assert.equal(versusPreviousSeason(rows, 5).length, 0);
    const plan = weekMoverPlan(
      [snap(5, "2026-09-26T08:00:00Z", rows)],
      5,
      "2026-09-26T07:00:00Z",
      Date.parse("2026-09-26T08:00:00Z"),
    );
    assert.equal(plan.kind, "season-to-date");
    if (plan.kind === "season-to-date") assert.equal(plan.versusPrevious.length, 0);
  });

  it("hides the previous-season finish list during the first 24 hours", () => {
    const played = row({
      x_handle: "played",
      rank: 1,
      rating: 1010,
      wins: 1,
      last_season: { season: 4, rating: 1600, rank: 1 },
    });
    const idle = row({
      x_handle: "idle",
      rank: 2,
      rating: 1000,
      wins: 0,
      losses: 0,
      draws: 0,
      last_season: { season: 4, rating: 1500, rank: 2 },
    });
    const early = weekMoverPlan(
      [snap(5, "2026-09-26T08:00:00Z", [played, idle])],
      5,
      "2026-09-26T07:00:00Z",
      Date.parse("2026-09-26T10:00:00Z"),
    );
    assert.equal(early.kind, "season-to-date");
    if (early.kind === "season-to-date") assert.equal(early.versusPrevious.length, 0);
    const later = weekMoverPlan(
      [snap(5, "2026-09-26T08:00:00Z", [played, idle]), snap(5, "2026-09-27T12:00:00Z", [played, idle])],
      5,
      "2026-09-26T07:00:00Z",
      Date.parse("2026-09-27T12:00:00Z"),
    );
    assert.equal(later.kind, "season-to-date");
    if (later.kind === "season-to-date") {
      assert.deepEqual(later.versusPrevious.map((item) => item.handle), ["played"]);
    }
  });

  it("does not anchor movers on an unverified snapshot or a final", () => {
    const finalSnap = snap(4, "2026-09-23T20:00:00.000Z", [row({ x_handle: "a", rank: 1, rating: 900 })]);
    finalSnap.final = true;
    const unverified = snap(4, "2026-09-23T22:00:00.000Z", [row({ x_handle: "a", rank: 1, rating: 1000 })]);
    unverified.verified = false;
    const hourly = snap(4, "2026-09-23T18:00:00.000Z", [row({ x_handle: "a", rank: 1, rating: 1100 })]);
    const latest = snap(4, "2026-09-24T22:07:00.000Z", [row({ x_handle: "a", rank: 1, rating: 1200 })]);
    const plan = dayMoverPlan(
      [finalSnap, hourly, unverified, latest],
      "2026-09-23T07:00:00Z",
      Date.parse("2026-09-24T22:07:00.000Z"),
    );
    assert.equal(plan.kind, "snapshots");
    if (plan.kind === "snapshots") assert.equal(plan.from.captured_at, hourly.captured_at);
  });
});

describe("entrants and exits", () => {
  it("compares entrants to the snapshot about 24 hours earlier, not the 15 minute neighbor", () => {
    const end = Date.parse("2026-09-24T18:00:00Z");
    const snaps = snapsEvery15Minutes(end, 24 * 4);
    const roster = rosterWindow(snaps, "2026-09-20T00:00:00.000Z", end);
    assert.equal(roster.kind, "about-24-hours");
    if (roster.kind !== "about-24-hours") return;
    assert.equal(roster.title, "About 24 hours");
    const gap = Date.parse(roster.to.captured_at) - Date.parse(roster.from.captured_at);
    assert.ok(gap >= 24 * 36e5);
    assert.ok(gap < 24 * 36e5 + 15 * 60 * 1000);
    assert.notEqual(roster.from.captured_at, snaps[snaps.length - 2].captured_at);
  });

  it("does not fall back to a short interval when 24 hours is not covered", () => {
    const end = Date.parse("2026-09-24T18:00:00Z");
    const snaps = snapsEvery15Minutes(end, 4);
    const roster = rosterWindow(snaps, "2026-09-20T00:00:00.000Z", end);
    assert.equal(roster.kind, "not-computed");
  });

  it("labels a young season since season start and spans the whole season", () => {
    const snaps = [
      snap(5, "2026-09-26T08:00:00Z", [row({ x_handle: "a", rank: 1, rating: 1000 })]),
      snap(5, "2026-09-26T08:15:00Z", [row({ x_handle: "b", rank: 1, rating: 1010 })]),
    ];
    const roster = rosterWindow(snaps, "2026-09-26T07:00:00Z", Date.parse("2026-09-26T08:15:00Z"));
    assert.equal(roster.kind, "since-start");
    if (roster.kind !== "since-start") return;
    assert.match(roster.title, /^Since season start/);
    assert.equal(roster.from?.captured_at, snaps[0].captured_at);
    assert.equal(roster.to?.captured_at, snaps[1].captured_at);
  });

  it("says everyone is new when the young season has one snapshot", () => {
    const only = snap(5, "2026-09-26T08:00:00Z", [row({ x_handle: "a", rank: 1, rating: 1000 })]);
    const roster = rosterWindow([only], "2026-09-26T07:00:00Z", Date.parse("2026-09-26T08:00:00Z"));
    assert.equal(roster.kind, "since-start");
    if (roster.kind !== "since-start") return;
    assert.equal(roster.from, null);
  });

  it("suppresses the first snapshot of a season", () => {
    const only = snap(7, "2026-09-26T08:00:00Z", [row({ x_handle: "a", rank: 1, rating: 1000 })]);
    const result = rosterChanges(null, only, true);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "new-season");
  });

  it("does not treat a missing name in a shorter snapshot as an exit", () => {
    const wide = snap(7, "2026-09-24T00:00:00Z", [
      row({ x_handle: "a", rank: 1, rating: 1500 }),
      row({ x_handle: "b", rank: 21, rating: 1200 }),
    ], 100);
    const narrow = snap(7, "2026-09-24T01:00:00Z", [
      row({ x_handle: "a", rank: 1, rating: 1510 }),
    ], 20);
    const result = rosterChanges(wide, narrow, false);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "row-counts-differ");
  });

  it("reports a top-20 exit when both snapshots have the same depth", () => {
    const from = snap(7, "2026-09-24T00:00:00Z", [
      row({ x_handle: "a", rank: 1, rating: 1500 }),
      row({ x_handle: "b", rank: 2, rating: 1400 }),
    ], 20);
    const to = snap(7, "2026-09-24T01:00:00Z", [
      row({ x_handle: "a", rank: 1, rating: 1510 }),
      row({ x_handle: "c", rank: 2, rating: 1410 }),
    ], 20);
    const result = rosterChanges(from, to, false);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value.entered.map((item) => item.x_handle), ["c"]);
      assert.equal(result.value.exited[0].handle, "b");
      assert.equal(result.value.exited[0].rankNow, null);
    }
  });
});

describe("frequency", () => {
  it("counts one UTC day even when two snapshots fall on that day", () => {
    const snaps = [
      snap(7, "2026-09-24T00:00:00Z", [row({ x_handle: "a", rank: 1, rating: 10 }), row({ x_handle: "b", rank: 20, rating: 5 })], 20),
      snap(7, "2026-09-24T01:00:00Z", [row({ x_handle: "a", rank: 1, rating: 10 })], 20),
    ];
    const table = appearances(snaps);
    assert.equal(table.days, 1);
    assert.equal(table.rows.find((item) => item.handle === "a")?.appearances, 1);
    assert.equal(table.rows.find((item) => item.handle === "b")?.appearances, 1);
  });

  it("does not inflate days in the top 20 when snapshots are 15 minutes apart", () => {
    const end = Date.parse("2026-09-24T18:00:00Z");
    const snaps = snapsEvery15Minutes(end, 8).map((item, index, all) => {
      const entries = [row({ x_handle: "a", rank: 1, rating: 1500 })];
      if (index === all.length - 1) entries.push(row({ x_handle: "b", rank: 2, rating: 1400 }));
      return { ...item, count: 20, entries };
    });
    const table = appearances(snaps);
    assert.equal(snaps.length, 9);
    assert.equal(table.days, 1);
    assert.equal(table.rows.find((item) => item.handle === "a")?.appearances, 1);
    assert.equal(table.rows.find((item) => item.handle === "b")?.appearances, 1);
  });

  it("counts a second UTC day separately", () => {
    const snaps = [
      snap(4, "2026-09-24T23:50:00Z", [row({ x_handle: "a", rank: 1, rating: 1 })], 20),
      snap(4, "2026-09-25T00:05:00Z", [row({ x_handle: "a", rank: 1, rating: 1 }), row({ x_handle: "b", rank: 2, rating: 1 })], 20),
      snap(4, "2026-09-25T00:20:00Z", [row({ x_handle: "a", rank: 1, rating: 1 })], 20),
    ];
    const table = appearances(snaps);
    assert.equal(table.days, 2);
    assert.equal(table.rows.find((item) => item.handle === "a")?.appearances, 2);
    assert.equal(table.rows.find((item) => item.handle === "b")?.appearances, 1);
  });

  it("keeps the per-season breakdown on the all-time total", () => {
    const report = appearancesAcross([
      { season: 2, snaps: [snap(2, "2026-09-18T00:00:00Z", [row({ x_handle: "a", rank: 1, rating: 10 })], 20)] },
      { season: 7, snaps: [snap(7, "2026-09-24T00:00:00Z", [row({ x_handle: "a", rank: 1, rating: 11 })], 20)] },
    ]);
    assert.deepEqual(report.seasons.map((season) => season.days), [1, 1]);
    assert.equal(report.rows[0].total, 2);
    assert.deepEqual(report.rows[0].bySeason.map((item) => item.appearances), [1, 1]);
  });

  it("waits for enough distinct days before ranking a new season", () => {
    assert.equal(FREQUENCY_MIN_DAYS, 2);
    assert.equal(frequencySeason(1, 10), "previous");
    assert.equal(frequencySeason(2, 10), "current");
  });

  it("the S4 snapshot count goes from 20 to 19 once the 2:39 PM PT unverified snapshot is excluded", () => {
    const snaps = Array.from({ length: 19 }, (_, index) =>
      snap(4, `2026-09-23T${String(index).padStart(2, "0")}:00:00.000Z`, [row({ x_handle: "a", rank: 1, rating: 1400 })]),
    );
    const unverified = snap(4, "2026-09-24T21:39:55.000Z", [row({ x_handle: "a", rank: 1, rating: 1583 })], 20);
    unverified.verified = false;
    snaps.push(unverified);
    assert.equal(snaps.length, 20);
    assert.equal(movementSnaps(snaps).length, 19);
    assert.equal(appearances(snaps).days, 1);
    const withDay = appearances([
      ...snaps.filter((item) => item.verified !== false),
      snap(4, "2026-09-24T18:00:00.000Z", [row({ x_handle: "a", rank: 1, rating: 1500 })]),
    ]);
    assert.equal(withDay.days, 2);
  });

  it("counts rank 1 through 20 and skips a tied player past rank 20", () => {
    const table = appearances([
      snap(
        4,
        "2026-09-24T21:36:57.000Z",
        [row({ x_handle: "in", rank: 20, rating: 1400 }), row({ x_handle: "tie", rank: 21, rating: 1400 })],
        100,
      ),
    ]);
    assert.equal(table.rows.find((item) => item.handle === "in")?.appearances, 1);
    assert.equal(table.rows.find((item) => item.handle === "tie"), undefined);
  });

  it("includes players tied on the cutoff count", () => {
    const rows = [
      { handle: "a", appearances: 3 },
      { handle: "b", appearances: 2 },
      { handle: "c", appearances: 2 },
    ];
    assert.equal(withTiedCutoff(rows, 2).length, 3);
  });

  it("hides the unverified note while a live board is showing and names a truncated list from the counts", () => {
    assert.equal(showUnverifiedNote(false, 2), false);
    assert.equal(showUnverifiedNote(true, 0), false);
    assert.equal(showUnverifiedNote(true, 1), true);
    assert.equal(playersShownNote(25, 36), "25 of 36 players shown");
    assert.equal(playersShownNote(36, 36), null);
    assert.equal(topShownNote(8, 8), null);
    assert.equal(topShownNote(8, 12), "top 8 shown");
    assert.equal(
      freshnessFallbackNote(true),
      "last scheduled snapshot failed; history below is stored data",
    );
    assert.equal(freshnessFallbackNote(false), "showing stored data");
  });

  it("computes the Season 4 appearance cutoff from the committed snapshots", () => {
    const dir = path.resolve("data/seasons/4/snapshots");
    const snaps: Snap[] = [];
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
      const doc = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
        snapshots?: (Omit<Snap, "season"> & { season?: number | { number?: number } })[];
      };
      for (const raw of doc.snapshots || []) {
        const season = typeof raw.season === "number" ? raw.season : raw.season?.number ?? 4;
        snaps.push({ ...raw, season });
      }
    }
    const table = appearances(snaps);
    const shown = withTiedCutoff(table.rows, 20);
    // Season 4 ended Sep 26 07:00 UTC; its last committed snapshot is 2026-09-26T06:49:15Z, so these
    // counts are final. (36/25 was the count when this test was written mid-season on Sep 25.)
    assert.equal(table.rows.length, 40);
    assert.equal(shown.length, 22);
    assert.equal(playersShownNote(shown.length, table.rows.length), "22 of 40 players shown");
  });
});

describe("chart seasons", () => {
  it("places an official final at the season boundary", () => {
    const finalSnap = snap(3, "2026-09-24T22:06:41.536Z", [row({ x_handle: "qsr", rank: 1, rating: 1404 })], 452);
    finalSnap.final = true;
    const placed = chartInstant(finalSnap, null, "2026-09-23T07:00:00Z");
    const current = snap(7, "2026-09-23T18:38:30.000Z", [row({ x_handle: "qsr", rank: 2, rating: 1113 })]);
    const points = seriesFor(
      byTime([
        { ...current, captured_at: chartInstant(current, "2026-09-26T07:00:00Z", null) },
        { ...finalSnap, captured_at: placed },
      ]),
      "qsr",
    );
    assert.equal(points[0].season, 3);
    assert.equal(points[0].t, "2026-09-23T07:00:00Z");
    assert.equal(chartSegments(points).length, 2);
    assert.equal(chartSegments(points)[1].points.length, 1);
  });

  it("breaks the line when the season number changes", () => {
    const points = [
      { t: "2026-09-18T00:00:00Z", rating: 1200, rank: 1, season: 2 },
      { t: "2026-09-18T01:00:00Z", rating: 1210, rank: 1, season: 2 },
      { t: "2026-09-24T00:00:00Z", rating: 1004, rank: 4, season: 7 },
    ];
    const segments = chartSegments(points);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].points.length, 2);
    assert.equal(segments[1].season, 7);
  });

  it("defaults to the previous season when the current season has one point", () => {
    const chosen = defaultChartSeason(
      [
        { season: 7, points: 1 },
        { season: 6, points: 4 },
      ],
      7,
      6,
    );
    assert.equal(chosen, 6);
  });
});

describe("freshness", () => {
  it("flags a check older than three hours", () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    assert.equal(isStale("2026-09-24T08:00:00Z", "2026-09-24T08:00:00Z", now), true);
    assert.equal(isStale("2026-09-24T11:00:00Z", "2026-09-24T08:00:00Z", now), false);
    assert.equal(justReset(23.4), true);
    assert.equal(justReset(24), false);
    assert.equal(seasonEnded("2026-09-26T07:00:00Z", Date.parse("2026-09-26T07:01:00Z")), true);
    assert.equal(seasonEnded("2026-09-26T07:00:00Z", Date.parse("2026-09-26T06:00:00Z")), false);
    assert.equal(endedWaitingText(4, "12:00 AM PT, Sep 26"), "Season 4 ended 12:00 AM PT, Sep 26; waiting for next snapshot");
  });
});

function snapsEvery15Minutes(endMs: number, steps: number): Snap[] {
  const snaps: Snap[] = [];
  for (let i = steps; i >= 0; i--) {
    snaps.push(
      snap(4, new Date(endMs - i * 15 * 60 * 1000).toISOString(), [
        row({ x_handle: "a", rank: 1, rating: 1000 + i }),
      ]),
    );
  }
  return snaps;
}

describe("covering pair", () => {
  it("uses a snapshot at least a full day before the latest one", () => {
    const snaps = [
      snap(7, "2026-09-23T18:00:00Z", [row({ x_handle: "a", rank: 1, rating: 1 })]),
      snap(7, "2026-09-24T18:30:00Z", [row({ x_handle: "a", rank: 1, rating: 2 })]),
    ];
    const pair = coveringPair(snaps, 24);
    assert.equal(pair.ok, true);
    if (pair.ok) assert.equal(pair.value.from.captured_at, snaps[0].captured_at);
  });

  it("keeps the 24 hour mover a full day back when snapshots are 15 minutes apart", () => {
    const end = Date.parse("2026-09-24T18:00:00Z");
    const snaps = snapsEvery15Minutes(end, 24 * 4);
    const plan = dayMoverPlan(snaps, "2026-09-20T00:00:00.000Z", end);
    assert.equal(plan.kind, "snapshots");
    if (plan.kind !== "snapshots") return;
    const gap = Date.parse(plan.to.captured_at) - Date.parse(plan.from.captured_at);
    assert.ok(gap >= 24 * 36e5);
    assert.ok(gap < 24 * 36e5 + 15 * 60 * 1000);
    assert.notEqual(plan.from.captured_at, snaps[snaps.length - 2].captured_at);
  });

  it("does not treat a 15 minute neighbor as the 7 day anchor", () => {
    const end = Date.parse("2026-09-24T18:00:00Z");
    const snaps = snapsEvery15Minutes(end, 24 * 4);
    const week = weekMoverPlan(snaps, 4, "2026-09-20T00:00:00.000Z", end);
    assert.equal(week.kind, "season-to-date");
    if (week.kind !== "season-to-date") return;
    assert.equal(week.from?.captured_at, snaps[0].captured_at);
    assert.equal(week.to?.captured_at, snaps[snaps.length - 1].captured_at);
    assert.notEqual(week.from?.captured_at, snaps[snaps.length - 2].captured_at);
  });
});

describe("player id", () => {
  it("keeps a renamed player when the id is stable", () => {
    const from = snap(4, "2026-09-24T00:00:00Z", [row({ x_handle: "oldname", player_id: "p1", rank: 1, rating: 1500 })], 20);
    const to = snap(4, "2026-09-24T01:00:00Z", [row({ x_handle: "newname", player_id: "p1", rank: 1, rating: 1510 })], 20);
    const roster = rosterChanges(from, to, false);
    assert.equal(roster.ok, true);
    if (roster.ok) {
      assert.equal(roster.value.entered.length, 0);
      assert.equal(roster.value.exited.length, 0);
    }
    const deltas = ratingDeltas(from, to);
    assert.equal(deltas.ok, true);
    if (deltas.ok) {
      assert.equal(deltas.value.length, 1);
      assert.equal(deltas.value[0].handle, "newname");
      assert.equal(deltas.value[0].ratingDelta, 10);
    }
    const points = seriesFor([from, to], "newname");
    assert.equal(points.length, 2);
    assert.deepEqual(points.map((point) => point.rating), [1500, 1510]);
    const table = appearances([from, to]);
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0].handle, "newname");
    assert.equal(table.rows[0].appearances, 1);
  });

  it("still splits a rename that has only a handle", () => {
    const from = snap(4, "2026-09-24T00:00:00Z", [row({ x_handle: "oldname", rank: 1, rating: 1500 })], 20);
    const to = snap(4, "2026-09-24T01:00:00Z", [row({ x_handle: "newname", rank: 1, rating: 1510 })], 20);
    const roster = rosterChanges(from, to, false);
    assert.equal(roster.ok, true);
    if (roster.ok) {
      assert.deepEqual(roster.value.entered.map((item) => item.x_handle), ["newname"]);
      assert.equal(roster.value.exited[0].handle, "oldname");
    }
    assert.equal(seriesFor([from, to], "newname").length, 1);
  });
});

describe("empty live board", () => {
  it("keeps stored rows mid-season and allows an empty board right after reset", () => {
    assert.equal(showEmptyLiveBoard(0, true, 48), false);
    assert.equal(showEmptyLiveBoard(0, true, 2), true);
    assert.equal(showEmptyLiveBoard(0, false, 48), true);
    assert.equal(showEmptyLiveBoard(3, true, 48), true);
  });
});
