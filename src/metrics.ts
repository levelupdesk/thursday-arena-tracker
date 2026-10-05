export const SEASON_START_RATING = 1000;
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
export const FREQUENCY_MIN_DAYS = 2;
export const TOP_CUT = 20;

export type LastSeason = {
  season: number;
  rating: number | null;
  rank: number | null;
};

export type Row = {
  x_handle: string;
  rank: number;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  ranked?: boolean;
  player_id?: string | null;
  avatar_url?: string | null;
  last_season?: LastSeason | null;
};

export type Snap = {
  captured_at: string;
  count: number;
  season: number;
  final?: boolean;
  verified?: boolean;
  complete?: boolean;
  entries: Row[];
};

export type Delta = {
  handle: string;
  rating: number;
  ratingDelta: number;
  rank: number;
  rankThen: number;
  rankDelta: number;
};

export type ExitRow = {
  handle: string;
  rankThen: number;
  rankNow: number | null;
};

export type Failure = "different-seasons" | "row-counts-differ" | "short" | "missing" | "new-season";

export type Result<T> = { ok: true; value: T } | { ok: false; reason: Failure };

export function seasonLabel(number: number): string {
  return `Season ${number}`;
}

export function games(row: Row): number {
  return row.wins + row.losses + row.draws;
}

export function byTime(snaps: Snap[]): Snap[] {
  return [...snaps].sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
}

export function knownHandles(rows: Row[]): string[] {
  const handles = new Map<string, string>();
  for (const row of rows) {
    const handle = row.x_handle.trim();
    if (handle) handles.set(handle.toLowerCase(), handle);
  }
  return [...handles.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function officialPrevious(current: number): number | null {
  return current > 1 ? current - 1 : null;
}

export function forMovement(snap: Snap): boolean {
  return snap.verified !== false && snap.final !== true;
}

export function movementSnaps(snaps: Snap[]): Snap[] {
  return snaps.filter(forMovement);
}

/** Stable id when the API sends one. The live board currently has only x_handle. */
export function playerKey(row: { player_id?: string | null; x_handle: string }): string {
  if (typeof row.player_id === "string" && row.player_id.trim()) return `id:${row.player_id.trim()}`;
  return `handle:${row.x_handle}`;
}

export function strictTop20(entries: Row[]): Row[] {
  return entries.filter((row) => row.rank >= 1 && row.rank <= TOP_CUT).sort((a, b) => a.rank - b.rank);
}

export function inTop20(entries: Row[], count = entries.length): Row[] {
  const sorted = [...entries].sort((a, b) => a.rank - b.rank || a.x_handle.localeCompare(b.x_handle));
  if (count <= TOP_CUT) return sorted;
  const core = sorted.filter((row) => row.rank <= TOP_CUT);
  if (!core.length) return [];
  const floor = Math.min(...core.map((row) => row.rating));
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const row of [...core, ...sorted.filter((row) => row.rank > TOP_CUT && row.rating === floor)]) {
    if (seen.has(row.x_handle)) continue;
    seen.add(row.x_handle);
    out.push(row);
  }
  return out;
}

export type LadderView =
  | { kind: "empty"; message: string }
  | { kind: "partial"; rows: Row[]; rankedCount: number; message: string }
  | { kind: "full"; rows: Row[] }
  | { kind: "legacy"; rows: Row[] };

export function classifyLadder(rows: Row[]): LadderView {
  if (!rows.length) {
    return { kind: "empty", message: "No ranked games yet this season" };
  }
  const hasFlag = rows.some((row) => row.ranked === true || row.ranked === false);
  if (!hasFlag) {
    return { kind: "legacy", rows: inTop20(rows, rows.length) };
  }
  const ranked = rows.filter((row) => row.ranked === true).sort((a, b) => a.rank - b.rank);
  if (!ranked.length) {
    return { kind: "empty", message: "No ranked games yet this season" };
  }
  if (ranked.length < TOP_CUT) {
    const noun = ranked.length === 1 ? "player" : "players";
    return {
      kind: "partial",
      rows: ranked,
      rankedCount: ranked.length,
      message: `${ranked.length} ranked ${noun} so far`,
    };
  }
  return { kind: "full", rows: inTop20(ranked, ranked.length) };
}

function sameSeason(from: Snap, to: Snap): Result<true> {
  if (from.season !== to.season) return { ok: false, reason: "different-seasons" };
  return { ok: true, value: true };
}

export function ratingDeltas(from: Snap, to: Snap): Result<Delta[]> {
  const gate = sameSeason(from, to);
  if (!gate.ok) return gate;
  const thenBy = new Map(from.entries.map((row) => [playerKey(row), row]));
  const deltas: Delta[] = [];
  for (const row of to.entries) {
    const prev = thenBy.get(playerKey(row));
    if (!prev) continue;
    deltas.push({
      handle: row.x_handle,
      rating: row.rating,
      ratingDelta: row.rating - prev.rating,
      rank: row.rank,
      rankThen: prev.rank,
      rankDelta: prev.rank - row.rank,
    });
  }
  return { ok: true, value: deltas };
}

export function climbers(rows: Delta[], limit = 5): Delta[] {
  return rows
    .filter((row) => row.ratingDelta > 0 || (row.ratingDelta === 0 && row.rankDelta > 0))
    .sort((a, b) => b.ratingDelta - a.ratingDelta || b.rankDelta - a.rankDelta)
    .slice(0, limit);
}

export function fallers(rows: Delta[], limit = 5): Delta[] {
  return rows
    .filter((row) => row.ratingDelta < 0 || (row.ratingDelta === 0 && row.rankDelta < 0))
    .sort((a, b) => a.ratingDelta - b.ratingDelta || a.rankDelta - b.rankDelta)
    .slice(0, limit);
}

export function coveringPair(snaps: Snap[], hours: number): Result<{ from: Snap; to: Snap }> {
  const usable = movementSnaps(snaps);
  if (usable.length < 2) return { ok: false, reason: "missing" };
  const season = usable[0].season;
  if (usable.some((snap) => snap.season !== season)) return { ok: false, reason: "different-seasons" };
  const end = usable[usable.length - 1];
  const target = Date.parse(end.captured_at) - hours * 36e5;
  let anchor: Snap | null = null;
  for (const snap of usable) {
    if (snap === end) break;
    if (Date.parse(snap.captured_at) <= target) anchor = snap;
  }
  if (!anchor) return { ok: false, reason: "short" };
  return { ok: true, value: { from: anchor, to: end } };
}

export function seasonAgeHours(startsAt: string | null, nowMs: number, firstSnapshot: string | null): number | null {
  const origin = startsAt || firstSnapshot;
  if (!origin) return null;
  const start = Date.parse(origin);
  if (Number.isNaN(start)) return null;
  return (nowMs - start) / 36e5;
}

export function justReset(ageHours: number | null): boolean {
  return ageHours != null && ageHours >= 0 && ageHours < 24;
}

/** An empty live board replaces stored rows only right after reset, or when nothing is stored yet. */
export function showEmptyLiveBoard(liveCount: number, storedHasRows: boolean, ageHours: number | null): boolean {
  if (liveCount > 0) return true;
  if (!storedHasRows) return true;
  return justReset(ageHours);
}

export function sinceStartLabel(hours: number): string {
  const rounded = Math.max(1, Math.round(hours));
  return `Movers since season start (${rounded} h)`;
}

export type StartMover = {
  handle: string;
  rating: number;
  delta: number;
  rank: number;
  games: number;
};

export function moversSinceStart(rows: Row[]): StartMover[] {
  return rows
    .filter((row) => games(row) > 0)
    .map((row) => ({
      handle: row.x_handle,
      rating: row.rating,
      delta: row.rating - SEASON_START_RATING,
      rank: row.rank,
      games: games(row),
    }))
    .sort((a, b) => b.delta - a.delta || a.rank - b.rank);
}

export type DayPlan =
  | { kind: "snapshots"; from: Snap; to: Snap; deltas: Delta[] }
  | { kind: "since-start"; label: string; hours: number; rows: StartMover[] }
  | { kind: "not-computed"; message: string };

export function dayMoverPlan(snaps: Snap[], startsAt: string | null, nowMs: number): DayPlan {
  const usable = movementSnaps(snaps);
  if (usable.some((snap, index) => index > 0 && snap.season !== usable[0].season)) {
    return { kind: "not-computed", message: "Refusing to mix seasons." };
  }
  const pair = coveringPair(usable, 24);
  if (pair.ok) {
    const deltas = ratingDeltas(pair.value.from, pair.value.to);
    if (!deltas.ok) return { kind: "not-computed", message: "Refusing to mix seasons." };
    return { kind: "snapshots", from: pair.value.from, to: pair.value.to, deltas: deltas.value };
  }
  if (pair.reason === "different-seasons") {
    return { kind: "not-computed", message: "Refusing to mix seasons." };
  }
  const age = seasonAgeHours(startsAt, nowMs, usable[0]?.captured_at ?? null);
  if (justReset(age) && usable.length) {
    const latest = usable[usable.length - 1];
    return {
      kind: "since-start",
      label: sinceStartLabel(age ?? 0),
      hours: age ?? 0,
      rows: moversSinceStart(latest.entries),
    };
  }
  return {
    kind: "not-computed",
    message: "No stored snapshot covers 24 hours inside this season. Not computed.",
  };
}

export type PreviousSeasonRow = {
  handle: string;
  rating: number;
  rank: number;
  previousSeason: number;
  previousRating: number;
  previousRank: number | null;
  ratingDelta: number;
  rankDelta: number | null;
};

export function versusPreviousSeason(rows: Row[], currentSeason: number): PreviousSeasonRow[] {
  const out: PreviousSeasonRow[] = [];
  for (const row of rows) {
    if (games(row) < 1) continue;
    const prior = row.last_season;
    if (!prior || prior.season === currentSeason || prior.rating == null) continue;
    out.push({
      handle: row.x_handle,
      rating: row.rating,
      rank: row.rank,
      previousSeason: prior.season,
      previousRating: prior.rating,
      previousRank: prior.rank,
      ratingDelta: row.rating - prior.rating,
      rankDelta: prior.rank == null ? null : prior.rank - row.rank,
    });
  }
  return out.sort((a, b) => b.ratingDelta - a.ratingDelta || a.rank - b.rank);
}

export type WeekPlan =
  | { kind: "snapshots"; from: Snap; to: Snap; deltas: Delta[] }
  | {
      kind: "season-to-date";
      note: string;
      from: Snap | null;
      to: Snap | null;
      deltas: Delta[] | null;
      versusPrevious: PreviousSeasonRow[];
    }
  | { kind: "not-computed"; message: string };

const WEEK_NOTE = "7-day view spans seasons; showing season-to-date";

export function weekMoverPlan(snaps: Snap[], currentSeason: number, startsAt: string | null = null, nowMs?: number): WeekPlan {
  const usable = movementSnaps(snaps);
  if (!usable.length) {
    return { kind: "not-computed", message: "No stored snapshots for this season." };
  }
  if (usable.some((snap) => snap.season !== currentSeason)) {
    return { kind: "not-computed", message: "Refusing to mix seasons." };
  }
  const pair = coveringPair(usable, 24 * 7);
  if (pair.ok) {
    const deltas = ratingDeltas(pair.value.from, pair.value.to);
    if (!deltas.ok) return { kind: "not-computed", message: "Refusing to mix seasons." };
    return { kind: "snapshots", from: pair.value.from, to: pair.value.to, deltas: deltas.value };
  }
  if (pair.reason === "different-seasons") {
    return { kind: "not-computed", message: "Refusing to mix seasons." };
  }
  const from = usable[0];
  const to = usable[usable.length - 1];
  let deltas: Delta[] | null = null;
  if (from !== to) {
    const compared = ratingDeltas(from, to);
    deltas = compared.ok ? compared.value : null;
  }
  const age = nowMs == null ? null : seasonAgeHours(startsAt, nowMs, from.captured_at);
  return {
    kind: "season-to-date",
    note: WEEK_NOTE,
    from,
    to,
    deltas,
    versusPrevious: justReset(age) ? [] : versusPreviousSeason(to.entries, currentSeason),
  };
}

export type Roster = {
  entered: Row[];
  exited: ExitRow[];
};

export function rosterChanges(from: Snap | null, to: Snap | null, firstSnapshot: boolean): Result<Roster> {
  if (firstSnapshot || !from || !to) return { ok: false, reason: "new-season" };
  if (from.season !== to.season) return { ok: false, reason: "different-seasons" };
  if (from.count !== to.count) return { ok: false, reason: "row-counts-differ" };
  const thenTop = inTop20(from.entries, from.count);
  const nowTop = inTop20(to.entries, to.count);
  const thenKeys = new Set(thenTop.map((row) => playerKey(row)));
  const nowKeys = new Set(nowTop.map((row) => playerKey(row)));
  const nowBy = new Map(to.entries.map((row) => [playerKey(row), row]));
  return {
    ok: true,
    value: {
      entered: nowTop.filter((row) => !thenKeys.has(playerKey(row))),
      exited: thenTop
        .filter((row) => !nowKeys.has(playerKey(row)))
        .map((row) => ({
          handle: row.x_handle,
          rankThen: row.rank,
          rankNow: nowBy.get(playerKey(row))?.rank ?? null,
        })),
    },
  };
}

export type Appearance = { key: string; handle: string; appearances: number };

export function utcDay(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** One appearance per UTC day in the top 20. Extra snapshots on the same day do not add. */
export function appearances(snaps: Snap[]): { days: number; rows: Appearance[] } {
  const days = new Set<string>();
  const byKey = new Map<string, { handle: string; days: Set<string> }>();
  for (const snap of movementSnaps(snaps)) {
    const day = utcDay(snap.captured_at);
    if (!day) continue;
    days.add(day);
    for (const row of strictTop20(snap.entries)) {
      const key = playerKey(row);
      const bucket = byKey.get(key) ?? { handle: row.x_handle, days: new Set<string>() };
      bucket.handle = row.x_handle;
      bucket.days.add(day);
      byKey.set(key, bucket);
    }
  }
  return {
    days: days.size,
    rows: [...byKey.entries()]
      .map(([key, bucket]) => ({ key, handle: bucket.handle, appearances: bucket.days.size }))
      .sort((a, b) => b.appearances - a.appearances || a.handle.localeCompare(b.handle)),
  };
}

export function withTiedCutoff(rows: Appearance[], limit: number): Appearance[] {
  if (rows.length <= limit) return rows;
  const floor = rows[limit - 1].appearances;
  let end = limit;
  while (end < rows.length && rows[end].appearances === floor) end += 1;
  return rows.slice(0, end);
}

/** What to say when the scheduled snapshot failed. The live board and the stored history are different. */
export function freshnessFallbackNote(liveLoaded: boolean): string {
  return liveLoaded
    ? "last scheduled snapshot failed; history below is stored data"
    : "showing stored data";
}

/** The unverified-snapshot note belongs on the stored board, not under a live top 20. */
export function showUnverifiedNote(showingStoredBoard: boolean, unverifiedCount: number): boolean {
  return showingStoredBoard && unverifiedCount > 0;
}

/** "25 of 36 players shown" when a ranked list is cut. Null when every row is on the page. */
export function playersShownNote(shown: number, total: number): string | null {
  if (total <= 0 || shown >= total) return null;
  return `${shown} of ${total} players shown`;
}

/** "top 8 shown" when a list is sliced to a fixed limit. */
export function topShownNote(limit: number, total: number): string | null {
  if (total <= limit) return null;
  return `top ${limit} shown`;
}

export type SeasonAppearances = {
  seasons: { number: number; days: number }[];
  rows: { handle: string; total: number; bySeason: { season: number; appearances: number }[] }[];
};

export function appearancesAcross(groups: { season: number; snaps: Snap[] }[]): SeasonAppearances {
  const prepared = groups
    .map((group) => ({ season: group.season, table: appearances(group.snaps) }))
    .filter((item) => item.table.days > 0);
  const seasons = prepared.map((item) => ({ number: item.season, days: item.table.days }));
  const byKey = new Map<string, { handle: string; counts: Map<number, number> }>();
  for (const item of prepared) {
    const table = item.table;
    for (const row of table.rows) {
      const existing = byKey.get(row.key) ?? { handle: row.handle, counts: new Map<number, number>() };
      existing.handle = row.handle;
      existing.counts.set(item.season, row.appearances);
      byKey.set(row.key, existing);
    }
  }
  const rows = [...byKey.entries()]
    .map(([, bucket]) => {
      const handle = bucket.handle;
      const counts = bucket.counts;
      const bySeason = seasons.map((season) => ({
        season: season.number,
        appearances: counts.get(season.number) || 0,
      }));
      return {
        handle,
        total: bySeason.reduce((sum, item) => sum + item.appearances, 0),
        bySeason,
      };
    })
    .sort((a, b) => b.total - a.total || a.handle.localeCompare(b.handle));
  return { seasons, rows };
}

export function frequencySeason(currentDays: number, previousDays: number): "current" | "previous" {
  if (currentDays >= FREQUENCY_MIN_DAYS) return "current";
  if (previousDays > 0) return "previous";
  return "current";
}

export type RosterWindow =
  | { kind: "about-24-hours"; title: string; from: Snap; to: Snap }
  | { kind: "since-start"; title: string; from: Snap | null; to: Snap | null }
  | { kind: "not-computed"; title: string; message: string };

/** Entrants and exits use the ~24 hour anchor, or the whole young season. Never the 15-minute neighbor. */
export function rosterWindow(snaps: Snap[], startsAt: string | null, nowMs: number): RosterWindow {
  const usable = byTime(movementSnaps(snaps));
  const latest = usable.length ? usable[usable.length - 1] : null;
  const pair = coveringPair(usable, 24);
  if (pair.ok) {
    return { kind: "about-24-hours", title: "About 24 hours", from: pair.value.from, to: pair.value.to };
  }
  const age = seasonAgeHours(startsAt, nowMs, usable[0]?.captured_at ?? null);
  if (justReset(age)) {
    const rounded = Math.max(1, Math.round(age ?? 0));
    return {
      kind: "since-start",
      title: `Since season start (${rounded} h)`,
      from: usable.length >= 2 ? usable[0] : null,
      to: latest,
    };
  }
  return {
    kind: "not-computed",
    title: "About 24 hours",
    message: "No stored snapshot covers about 24 hours inside this season. Not computed.",
  };
}

export type Point = { t: string; rating: number; rank: number; season: number; mark?: "unverified" | "final" };

export function seasonEnded(endsAt: string | null, nowMs: number): boolean {
  if (!endsAt) return false;
  const end = Date.parse(endsAt);
  return !Number.isNaN(end) && nowMs > end;
}

export function endedWaitingText(number: number, endsAtLabel: string): string {
  return `${seasonLabel(number)} ended ${endsAtLabel}; waiting for next snapshot`;
}

/** Final standings are the season's close, not the later hour we downloaded them. */
export function chartInstant(snap: Snap, endsAt: string | null, nextStartsAt: string | null): string {
  if (snap.final !== true) return snap.captured_at;
  return endsAt || nextStartsAt || snap.captured_at;
}

export function seriesFor(snaps: Snap[], handle: string): Point[] {
  let key = `handle:${handle}`;
  for (let index = snaps.length - 1; index >= 0; index -= 1) {
    const match = snaps[index].entries.find((entry) => entry.x_handle === handle);
    if (match) {
      key = playerKey(match);
      break;
    }
  }
  const points: Point[] = [];
  for (const snap of snaps) {
    const row = snap.entries.find((entry) => playerKey(entry) === key);
    if (!row) continue;
    const mark = snap.final === true ? "final" : snap.verified === false ? "unverified" : undefined;
    points.push({ t: snap.captured_at, rating: row.rating, rank: row.rank, season: snap.season, ...(mark ? { mark } : {}) });
  }
  return points;
}

export function chartSegments(points: Point[]): { season: number; points: Point[] }[] {
  const segments: { season: number; points: Point[] }[] = [];
  for (const point of points) {
    const last = segments[segments.length - 1];
    if (!last || last.season !== point.season) segments.push({ season: point.season, points: [point] });
    else last.points.push(point);
  }
  return segments;
}

export function defaultChartSeason(
  counts: { season: number; points: number }[],
  current: number,
  previous: number | null,
): number {
  const currentPoints = counts.find((item) => item.season === current)?.points ?? 0;
  if (currentPoints >= 2) return current;
  if (previous != null) {
    const previousPoints = counts.find((item) => item.season === previous)?.points ?? 0;
    if (previousPoints >= 2) return previous;
  }
  return current;
}

export function isStale(lastChecked: string | null, newestSnapshot: string | null, nowMs: number): boolean {
  const stamp = lastChecked || newestSnapshot;
  if (!stamp) return true;
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return true;
  return nowMs - at > STALE_AFTER_MS;
}

export function winPct(wins: number, losses: number, draws: number): number | null {
  const total = wins + losses + draws;
  if (!Number.isFinite(total) || total <= 0) return null;
  return (100 * wins) / total;
}
