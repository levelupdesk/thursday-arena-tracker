import { mountChart } from "./chart";
import { formatPt, formatSigned, formatWinPct, safeHttps, xProfileUrl } from "./format";
import {
  appearances,
  appearancesAcross,
  byTime,
  chartSegments,
  classifyLadder,
  climbers,
  dayMoverPlan,
  FREQUENCY_MIN_DAYS,
  defaultChartSeason,
  endedWaitingText,
  fallers,
  frequencySeason,
  justReset,
  movementSnaps,
  moversSinceStart,
  officialPrevious,
  rosterChanges,
  rosterWindow,
  seasonAgeHours,
  seasonEnded,
  seasonLabel,
  chartInstant,
  seriesFor,
  showEmptyLiveBoard,
  freshnessFallbackNote,
  showUnverifiedNote,
  sinceStartLabel,
  playersShownNote,
  topShownNote,
  isStale,
  knownHandles,
  weekMoverPlan,
  withTiedCutoff,
  type Delta,
  type Row,
  type Snap,
} from "./metrics";

const SEASON_URL = "https://thursdayarena.com/api/public/v1/season";
const BOARD_URL = "https://thursdayarena.com/api/public/v1/leaderboard?limit=100";

type SiteSnap = {
  captured_at: string;
  count: number;
  final?: boolean;
  verified?: boolean;
  complete?: boolean;
  entries: Row[];
};

type SiteSeason = {
  number: number;
  snapshot_count: number;
  has_final: boolean;
  snapshots: SiteSnap[];
};

type SeasonClock = {
  number: number;
  state: string;
  starts_at: string | null;
  ends_at: string | null;
};

type SiteData = {
  index: {
    last_checked: string | null;
    fetch_failed?: boolean;
    current: SeasonClock | null;
    next: SeasonClock | null;
    seasons: { number: number; starts_at: string | null; ends_at: string | null; state: string; has_final: boolean }[];
  };
  seasons: SiteSeason[];
  catalog: {
    captured_at: string;
    total: number;
    rarities: { rarity: string; count: number; avg_cost: number | null; avg_attack: number | null; avg_health: number | null }[];
    crews: { crew: string; count: number }[];
    season_tags: { season: number; count: number }[];
  } | null;
};

type LiveBoard = { fetchedAt: string; season: number; state: string; entries: Row[] };

function required(node: Element | null, id: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`missing #${id}`);
  return node;
}

const ladderRoot = required(document.querySelector("#ladder"), "ladder");
const previousRoot = required(document.querySelector("#previous"), "previous");
const moversRoot = required(document.querySelector("#movers"), "movers");
const rosterRoot = required(document.querySelector("#roster"), "roster");
const frequencyRoot = required(document.querySelector("#frequency"), "frequency");
const historyRoot = required(document.querySelector("#history"), "history");
const catalogRoot = required(document.querySelector("#catalog"), "catalog");
const seasonLine = required(document.querySelector("#season-line"), "season-line");
const freshness = required(document.querySelector("#freshness"), "freshness");
const resetBanner = required(document.querySelector("#reset-banner"), "reset-banner");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function mapRows(data: unknown): Row[] {
  if (!Array.isArray(data)) return [];
  const rows: Row[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.x_handle !== "string" || typeof raw.rank !== "number" || typeof raw.rating !== "number") continue;
    const row: Row = {
      x_handle: raw.x_handle,
      rank: raw.rank,
      rating: raw.rating,
      wins: typeof raw.wins === "number" ? raw.wins : 0,
      losses: typeof raw.losses === "number" ? raw.losses : 0,
      draws: typeof raw.draws === "number" ? raw.draws : 0,
    };
    if (raw.ranked === true || raw.ranked === false) row.ranked = raw.ranked;
    const rawId = [raw.player_id, raw.user_id, raw.id].find(
      (value) => (typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value)),
    );
    if (typeof rawId === "string" && rawId.trim()) row.player_id = rawId.trim();
    else if (typeof rawId === "number") row.player_id = String(rawId);
    if (typeof raw.avatar_url === "string") row.avatar_url = raw.avatar_url;
    if (raw.last_season && typeof raw.last_season === "object") {
      const prior = raw.last_season as Record<string, unknown>;
      if (typeof prior.season === "number") {
        row.last_season = {
          season: prior.season,
          rating: typeof prior.rating === "number" ? prior.rating : null,
          rank: typeof prior.rank === "number" ? prior.rank : null,
        };
      }
    }
    rows.push(row);
  }
  return rows;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function toSnaps(season: SiteSeason | null | undefined): Snap[] {
  if (!season) return [];
  return byTime(
    season.snapshots.map((snap) => ({
      captured_at: snap.captured_at,
      count: snap.count,
      season: season.number,
      final: snap.final,
      verified: snap.verified,
      complete: snap.complete,
      entries: snap.entries,
    })),
  );
}

function initials(handle: string): string {
  return handle.slice(0, 2).toUpperCase();
}

function person(handle: string, avatar: string | null | undefined, onPick: (handle: string) => void): HTMLElement {
  const box = el("div", "person");
  const safe = safeHttps(avatar);
  if (safe) {
    const img = el("img", "avatar");
    img.src = safe;
    img.alt = "";
    img.width = 36;
    img.height = 36;
    img.referrerPolicy = "no-referrer";
    box.append(img);
  } else {
    const initialsNode = el("span", "initials", initials(handle));
    initialsNode.setAttribute("aria-hidden", "true");
    box.append(initialsNode);
  }
  const who = el("div", "who");
  const pick = el("button", "linkish", handle);
  pick.type = "button";
  pick.setAttribute("aria-pressed", String(handle === selected));
  pick.addEventListener("click", () => onPick(handle));
  const link = el("a", "", "on X");
  link.href = xProfileUrl(handle);
  link.rel = "noreferrer";
  link.target = "_blank";
  link.setAttribute("aria-label", `${handle} on X`);
  who.append(pick, link);
  box.append(who);
  return box;
}

function record(row: Row): string {
  return `${row.wins}-${row.losses}-${row.draws}`;
}

function signed(value: number, noun: string): HTMLElement {
  const node = el("span", value > 0 ? "delta up" : value < 0 ? "delta down" : "", formatSigned(value));
  node.append(document.createTextNode(` ${noun}`));
  return node;
}

let selected = new URLSearchParams(location.search).get("player") || "";
let chartSeason: number | "all" = "all";

function selectPlayer(handle: string): void {
  selected = handle;
  const url = new URL(location.href);
  url.searchParams.set("player", handle);
  history.replaceState(null, "", url);
  const search = document.querySelector("#history input");
  if (search instanceof HTMLInputElement) search.value = handle;
  document.querySelectorAll("#ladder tbody tr").forEach((row) => {
    row.toggleAttribute("data-selected", row.getAttribute("data-handle") === handle);
  });
  paintChart();
  document.querySelector("#history")?.scrollIntoView({ block: "nearest" });
}

function ladderTable(rows: Row[], caption: string): HTMLTableElement {
  const table = el("table", "ladder");
  table.append(el("caption", "", caption));
  const head = el("thead");
  const hr = el("tr");
  for (const label of ["Rank", "Player", "Rating", "W-L-D", "Win%"]) {
    const cell = el("th", label === "Rank" || label === "Rating" || label === "Win%" ? "num" : "", label);
    cell.scope = "col";
    hr.append(cell);
  }
  head.append(hr);
  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    tr.dataset.handle = row.x_handle;
    if (row.x_handle === selected) tr.dataset.selected = "true";
    const rank = el("td", "num", String(row.rank));
    const player = el("td");
    player.append(person(row.x_handle, row.avatar_url, selectPlayer));
    if (row.last_season && row.last_season.rating != null) {
      const prior = el(
        "div",
        "prior",
        `Previous season ${row.last_season.season}: ${row.last_season.rating}${row.last_season.rank != null ? `, rank ${row.last_season.rank}` : ""}`,
      );
      player.append(prior);
    }
    tr.append(rank, player, el("td", "num", String(row.rating)), el("td", "num", record(row)), el("td", "num", formatWinPct(row.wins, row.losses, row.draws)));
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

function deltaLists(deltas: Delta[]): HTMLElement {
  const grid = el("div", "split-2");
  for (const [title, rows] of [
    ["Climbers", climbers(deltas)],
    ["Fallers", fallers(deltas)],
  ] as const) {
    const card = el("div");
    card.append(el("h4", "", title));
    if (!rows.length) {
      card.append(el("p", "note", "None in this pair."));
    } else {
      const list = el("ul", "clean");
      for (const row of rows) {
        const item = el("li");
        item.append(el("strong", "", row.handle), document.createTextNode(` ${row.rating} `));
        item.append(signed(row.ratingDelta, "rating"), document.createTextNode(` · rank ${row.rankThen} → ${row.rank} `));
        item.append(signed(row.rankDelta, "ranks"));
        list.append(item);
      }
      card.append(list);
    }
    grid.append(card);
  }
  return grid;
}

function seasonBounds(number: number): { endsAt: string | null; nextStartsAt: string | null } {
  const listed = site.index.seasons.find((season) => season.number === number);
  const nextListed = site.index.seasons.find((season) => season.number === number + 1);
  const nextClock =
    site.index.current?.number === number + 1 ? site.index.current : site.index.next?.number === number + 1 ? site.index.next : null;
  return {
    endsAt: listed?.ends_at ?? null,
    nextStartsAt: nextListed?.starts_at ?? nextClock?.starts_at ?? null,
  };
}

function paintChart(): void {
  const host = document.querySelector("#chart-host");
  if (!(host instanceof HTMLElement)) return;
  const seasonNumbers = chartSeason === "all" ? seasons.map((season) => season.number) : [chartSeason];
  const snaps = seasons
    .filter((season) => seasonNumbers.includes(season.number))
    .flatMap((season) => {
      const bounds = seasonBounds(season.number);
      return toSnaps(season).map((snap) => ({
        ...snap,
        captured_at: chartInstant(snap, bounds.endsAt, bounds.nextStartsAt),
      }));
    });
  const points = seriesFor(byTime(snaps), selected);
  mountChart(host, chartSegments(points));
  const tableHost = document.querySelector("#chart-table");
  if (tableHost) {
    tableHost.replaceChildren();
    if (points.length) {
      const table = el("table");
      const caption = el("caption", "", `Stored ratings for ${selected}`);
      table.append(caption);
      const head = el("thead");
      const header = el("tr");
      for (const label of ["Season", "Time", "Rating", "Rank"]) {
        const cell = el("th", label === "Rating" || label === "Rank" ? "num" : "", label);
        cell.scope = "col";
        header.append(cell);
      }
      head.append(header);
      const body = el("tbody");
      for (const point of points) {
        const tr = el("tr");
        tr.append(
          el(
            "td",
            "",
            `${seasonLabel(point.season)}${point.mark === "unverified" ? " · unverified" : point.mark === "final" ? " · final" : ""}`,
          ),
          el("td", "", formatPt(point.t)),
          el("td", "num", String(point.rating)),
          el("td", "num", String(point.rank)),
        );
        body.append(tr);
      }
      table.append(head, body);
      const details = el("details");
      details.append(el("summary", "", "Rating values"), table);
      tableHost.append(details);
    }
  }
}

let seasons: SiteSeason[] = [];
let fetchedPrevious: SiteSeason | null = null;
let clock: SeasonClock | null = null;
let current = 0;
let storedCurrent: Snap[] = [];
let live: LiveBoard | null = null;
let liveNote = "Showing the latest stored snapshot.";
let site: SiteData;

function render(): void {
  const now = Date.now();
  const previousNumber = officialPrevious(current);
  const storedPrevious = seasons.find((season) => season.number === previousNumber);
  const cardSeason = storedPrevious ?? fetchedPrevious;
  const previousSnaps = toSnaps(storedPrevious);
  const cardSnaps = toSnaps(cardSeason);
  const latest = storedCurrent[storedCurrent.length - 1] ?? null;
  const age = seasonAgeHours(clock?.starts_at ?? null, now, latest?.captured_at ?? null);
  const young = justReset(age);
  const storedHasRows = (latest?.entries.length ?? 0) > 0;
  const useLive =
    live != null &&
    live.season === current &&
    showEmptyLiveBoard(live.entries.length, storedHasRows, age);
  const boardRows = useLive && live ? live.entries : latest?.entries ?? [];
  const ladder = classifyLadder(boardRows);
  const day = storedCurrent.length
    ? dayMoverPlan(storedCurrent, clock?.starts_at ?? null, now)
    : young && live && live.season === current
      ? {
          kind: "since-start" as const,
          label: sinceStartLabel(age ?? 1),
          hours: age ?? 1,
          rows: moversSinceStart(live.entries),
        }
      : { kind: "not-computed" as const, message: "No stored snapshots for this season yet." };
  const countedCurrent = movementSnaps(storedCurrent);
  const week = weekMoverPlan(storedCurrent, current, clock?.starts_at ?? null, now);

  document.title = `${seasonLabel(current)} ladder · Thursday Arena`;
  if (clock?.ends_at && seasonEnded(clock.ends_at, now)) {
    seasonLine.textContent = endedWaitingText(current, formatPt(clock.ends_at));
  } else if (clock?.ends_at) {
    seasonLine.textContent = `${seasonLabel(current)} · ends ${formatPt(clock.ends_at)}`;
  } else {
    seasonLine.textContent = `${seasonLabel(current)}${clock?.state ? ` · ${clock.state}` : ""}`;
  }
  freshness.replaceChildren();
  if (latest) freshness.append(document.createTextNode(`Ladder snapshot: ${formatPt(latest.captured_at)}`));
  else freshness.append(document.createTextNode("Ladder snapshot: none stored yet"));
  if (site.index.last_checked) {
    freshness.append(document.createTextNode(` · Last check: ${formatPt(site.index.last_checked)}`));
  }
  if (site.index.fetch_failed) {
    freshness.append(document.createTextNode(` · ${freshnessFallbackNote(live != null)}`));
  }
  if (isStale(site.index.last_checked, latest?.captured_at ?? null, now)) {
    freshness.append(el("span", "badge stale", "Stale snapshot"));
  }
  freshness.append(el("span", "badge live", live ? `Live board ${formatPt(live.fetchedAt)}` : liveNote));
  if (young && clock?.starts_at) {
    resetBanner.hidden = false;
    resetBanner.textContent = `${seasonLabel(current)} started ${formatPt(clock.starts_at)}; ladder just reset`;
  } else {
    resetBanner.hidden = true;
  }

  const unverified = storedCurrent.filter((snap) => snap.verified === false);
  ladderRoot.replaceChildren();
  ladderRoot.append(el("h2", "", "Current top 20"));
  ladderRoot.id = "ladder";
  const ladderTitle = ladderRoot.querySelector("h2");
  if (ladderTitle) ladderTitle.id = "ladder-title";
  if (ladder.kind === "empty") {
    ladderRoot.append(el("p", "banner", ladder.message));
    ladderRoot.append(el("p", "note", "The previous season's final top 20 is below. Nothing here is a placeholder."));
  } else {
    if (ladder.kind === "partial") ladderRoot.append(el("p", "banner", ladder.message));
    const scroll = el("div", "table-scroll");
    const caption = live && live.season === current ? "Live public leaderboard." : "Latest stored snapshot.";
    scroll.append(ladderTable(ladder.rows, caption));
    ladderRoot.append(scroll);
  }
  if (showUnverifiedNote(!useLive && ladder.kind !== "empty", unverified.length)) {
    ladderRoot.append(
      el(
        "p",
        "note",
        `Unverified snapshot: ${unverified.map((snap) => formatPt(snap.captured_at)).join(", ")}. No response copy was kept for that capture.`,
      ),
    );
  }

  previousRoot.replaceChildren();
  previousRoot.className = young || ladder.kind === "empty" ? "panel prominent" : "panel";
  const previousTitle = el("h2", "", previousNumber ? `${seasonLabel(previousNumber)} final` : "Previous season");
  previousTitle.id = "previous-title";
  previousRoot.append(previousTitle);
  const finalSnap = cardSnaps.find((snap) => snap.final) ?? (cardSeason?.has_final ? cardSnaps[cardSnaps.length - 1] : null);
  const fallbackSnap = finalSnap ?? cardSnaps[cardSnaps.length - 1] ?? null;
  if (!previousNumber) {
    previousRoot.append(el("p", "note", "This is the earliest season number in the feed."));
  } else if (!fallbackSnap) {
    previousRoot.append(el("p", "note", "Official final standings are not in the stored archive yet."));
  } else {
    const official = Boolean(cardSeason?.has_final || fallbackSnap.final);
    const partial = fallbackSnap.complete === false;
    previousRoot.append(
      el(
        "p",
        "note",
        partial
          ? `Partial final for ${seasonLabel(previousNumber)} (paging stopped early) · ${formatPt(fallbackSnap.captured_at)}`
          : official
            ? `Official final fetched for ${seasonLabel(previousNumber)} · ${formatPt(fallbackSnap.captured_at)}`
            : `Last snapshot, not official final · ${formatPt(fallbackSnap.captured_at)}`,
      ),
    );
    const scroll = el("div", "table-scroll");
    const view = classifyLadder(fallbackSnap.entries);
    const rows = view.kind === "empty" ? [] : view.rows;
    if (!rows.length) previousRoot.append(el("p", "", "That archive has no ranked rows."));
    else scroll.append(ladderTable(rows, `${seasonLabel(previousNumber)} top 20`));
    previousRoot.append(scroll);
  }

  moversRoot.replaceChildren();
  const moversTitle = el("h2", "", "Movers");
  moversTitle.id = "movers-title";
  moversRoot.append(moversTitle, el("p", "note", "Snapshot to snapshot, inside this season only. The match list is not used."));
  const dayCard = el("div", "panel");
  if (day.kind === "snapshots") {
    dayCard.append(
      el("h3", "", "About 24 hours"),
      el("p", "", `From ${formatPt(day.from.captured_at)} to ${formatPt(day.to.captured_at)}.`),
      deltaLists(day.deltas),
    );
  } else if (day.kind === "since-start") {
    dayCard.append(el("h3", "", day.label), el("p", "", "Versus the 1000 starting rating. Players with no games are hidden."));
    const ups = day.rows.filter((row) => row.delta > 0);
    const downs = day.rows.filter((row) => row.delta < 0);
    const grid = el("div", "split-2");
    for (const [title, rows] of [
      ["Climbers", ups],
      ["Fallers", downs],
    ] as const) {
      const card = el("div");
      card.append(el("h4", "", title));
      if (!rows.length) card.append(el("p", "note", "None."));
      else {
        const list = el("ul", "clean");
        for (const row of rows.slice(0, 5)) {
          const item = el("li");
          item.append(el("strong", "", row.handle), document.createTextNode(` rank ${row.rank} `), signed(row.delta, "from 1000"));
          list.append(item);
        }
        card.append(list);
      }
      grid.append(card);
    }
    dayCard.append(grid);
  } else {
    dayCard.append(el("h3", "", "24 hour window"), el("p", "", day.message));
  }
  moversRoot.append(dayCard);

  const weekCard = el("div", "panel");
  if (week.kind === "snapshots") {
    weekCard.append(
      el("h3", "", "About 7 days"),
      el("p", "", `From ${formatPt(week.from.captured_at)} to ${formatPt(week.to.captured_at)}.`),
      deltaLists(week.deltas),
    );
  } else if (week.kind === "season-to-date") {
    weekCard.append(el("h3", "", week.note));
    if (week.from && week.to && week.deltas) {
      weekCard.append(el("p", "", `From ${formatPt(week.from.captured_at)} to ${formatPt(week.to.captured_at)}.`), deltaLists(week.deltas));
    } else {
      weekCard.append(el("p", "note", "Not enough stored snapshots to compare season-to-date."));
    }
    const finishSeason = previousNumber;
    const finishRows = finishSeason == null ? [] : week.versusPrevious.filter((row) => row.previousSeason === finishSeason);
    if (finishSeason != null && finishRows.length) {
      weekCard.append(el("h3", "", `Current rating vs ${seasonLabel(finishSeason)} finish (not a mover)`));
      weekCard.append(el("p", "note", "Players with no games this season are hidden. This is not a 24-hour or 7-day mover."));
      const finishLimit = 8;
      const finishNote = topShownNote(finishLimit, finishRows.length);
      if (finishNote) weekCard.append(el("p", "note", finishNote));
      const list = el("ul", "clean");
      for (const row of finishRows.slice(0, finishLimit)) {
        const item = el("li");
        item.append(
          el("strong", "", row.handle),
          document.createTextNode(` ${seasonLabel(row.previousSeason)} ${row.previousRating} → ${row.rating} `),
          signed(row.ratingDelta, "rating"),
        );
        list.append(item);
      }
      weekCard.append(list);
    }
  } else {
    weekCard.append(el("p", "", week.message));
  }
  moversRoot.append(weekCard);

  rosterRoot.replaceChildren();
  const rosterTitle = el("h2", "", "Top 20 entrants and exits");
  rosterTitle.id = "roster-title";
  rosterRoot.append(rosterTitle);
  const roster = rosterWindow(storedCurrent, clock?.starts_at ?? null, now);
  const card = el("div", "panel");
  card.append(el("h3", "", roster.title));
  card.append(el("p", "note", "A renamed handle with no stable player id appears as one exit plus one new entrant."));
  if (roster.kind === "since-start" && !roster.from) {
    card.append(el("p", "", "Since season start — everyone is new."));
  } else if (roster.kind === "not-computed") {
    card.append(el("p", "", roster.message));
  } else if (roster.from && roster.to) {
    const result = rosterChanges(roster.from, roster.to, false);
    card.append(el("p", "", `From ${formatPt(roster.from.captured_at)} to ${formatPt(roster.to.captured_at)}.`));
    if (!result.ok && result.reason === "row-counts-differ") {
      card.append(
        el(
          "p",
          "",
          `Not compared (${roster.from.count} rows vs ${roster.to.count} rows). A name missing from a shorter snapshot is not an exit from the ladder.`,
        ),
      );
    } else if (!result.ok) {
      card.append(el("p", "", "Not computed."));
    } else {
      const grid = el("div", "split-2");
      const entered = el("div");
      entered.append(el("h3", "", "Entered the top 20"));
      if (!result.value.entered.length) entered.append(el("p", "note", "None."));
      else {
        const list = el("ul", "clean");
        for (const row of result.value.entered) list.append(el("li", "", `${row.x_handle} at rank ${row.rank}`));
        entered.append(list);
      }
      const exited = el("div");
      exited.append(el("h3", "", "Left the top 20"));
      if (!result.value.exited.length) exited.append(el("p", "note", "None."));
      else {
        const list = el("ul", "clean");
        for (const row of result.value.exited) {
          const nowRank = row.rankNow == null ? "not in this snapshot" : `now rank ${row.rankNow}`;
          list.append(el("li", "", `${row.handle} was rank ${row.rankThen}, ${nowRank}`));
        }
        exited.append(list);
      }
      grid.append(entered, exited);
      card.append(grid);
    }
  }
  rosterRoot.append(card);

  frequencyRoot.replaceChildren();
  const frequencyTitle = el("h2", "", "Top-20 appearances");
  frequencyTitle.id = "frequency-title";
  frequencyRoot.append(frequencyTitle);
  const countedPrevious = movementSnaps(previousSnaps);
  const currentDays = appearances(countedCurrent).days;
  const previousDays = appearances(countedPrevious).days;
  const choice = frequencySeason(currentDays, previousDays);
  const focusSnaps = choice === "previous" ? countedPrevious : countedCurrent;
  const focusNumber = choice === "previous" && previousNumber ? previousNumber : current;
  if (choice === "previous") {
    frequencyRoot.append(
      el(
        "p",
        "note",
        `${seasonLabel(current)} has ${currentDays} UTC day${currentDays === 1 ? "" : "s"} with a verified snapshot. Frequency uses ${seasonLabel(focusNumber)} until this season has at least ${FREQUENCY_MIN_DAYS} days.`,
      ),
    );
  }
  const focus = appearances(focusSnaps);
  frequencyRoot.append(
    el(
      "p",
      "",
      `${focus.days} UTC day${focus.days === 1 ? "" : "s"} in ${seasonLabel(focusNumber)}. A player counts once per day they were in the top 20.`,
    ),
  );
  const focusShown = withTiedCutoff(focus.rows, 20);
  const focusScroll = el("div", "table-scroll");
  focusScroll.append(appearanceTable(focusShown, `${focus.days}`, `Top-20 appearances in ${seasonLabel(focusNumber)}`));
  frequencyRoot.append(focusScroll);
  const focusNote = playersShownNote(focusShown.length, focus.rows.length);
  if (focusNote) frequencyRoot.append(el("p", "note", focusNote));

  const across = appearancesAcross(seasons.map((season) => ({ season: season.number, snaps: toSnaps(season) })));
  frequencyRoot.append(el("h3", "", "All stored seasons"));
  frequencyRoot.append(el("p", "note", "The total is the sum of the per-season counts. Seasons are not mixed into one silent number."));
  const wide = el("table");
  wide.append(el("caption", "", "Appearances across stored seasons"));
  const head = el("tr");
  head.append(el("th", "", "Player"));
  for (const season of across.seasons) {
    const cell = el("th", "num", `${seasonLabel(season.number)} / ${season.days} day${season.days === 1 ? "" : "s"}`);
    cell.scope = "col";
    head.append(cell);
  }
  const totalHeader = el("th", "num", "Total");
  totalHeader.scope = "col";
  head.append(totalHeader);
  const headWrap = el("thead");
  headWrap.append(head);
  wide.append(headWrap);
  const rankedRows = [...across.rows].sort((a, b) => b.total - a.total || a.handle.localeCompare(b.handle));
  const cutoff = rankedRows.length > 20 ? rankedRows[19].total : 0;
  const shown = rankedRows.filter((row, index) => index < 20 || row.total === cutoff);
  const body = el("tbody");
  for (const row of shown) {
    const tr = el("tr");
    tr.append(el("td", "", row.handle));
    for (const item of row.bySeason) tr.append(el("td", "num", String(item.appearances)));
    tr.append(el("td", "num", String(row.total)));
    body.append(tr);
  }
  wide.append(body);
  const wideScroll = el("div", "table-scroll");
  wideScroll.append(wide);
  frequencyRoot.append(wideScroll);
  const acrossNote = playersShownNote(shown.length, rankedRows.length);
  if (acrossNote) frequencyRoot.append(el("p", "note", acrossNote));

  historyRoot.replaceChildren();
  const historyTitle = el("h2", "", "Rating history");
  historyTitle.id = "history-title";
  historyRoot.append(historyTitle, el("p", "note", "Lines stop at season boundaries. A later season does not connect back to the previous rating."));
  const counts = seasons.map((season) => ({
    season: season.number,
    points: seriesFor(toSnaps(season), selected || boardRows[0]?.x_handle || "").length,
  }));
  if (!selected) selected = boardRows[0]?.x_handle || storedCurrent[0]?.entries[0]?.x_handle || "";
  if (chartSeason === "all") {
    chartSeason = defaultChartSeason(counts, current, previousNumber);
  }
  const filters = el("div", "filters");
  const searchLabel = el("label", "", "Player");
  const search = el("input");
  search.type = "search";
  search.value = selected;
  search.setAttribute("list", "player-suggestions");
  search.addEventListener("change", () => {
    if (search.value.trim()) selectPlayer(search.value.trim().replace(/^@/, ""));
  });
  searchLabel.append(search);
  const suggestions = el("datalist");
  suggestions.id = "player-suggestions";
  const rowsForSuggestions = [
    ...seasons.flatMap((season) => season.snapshots.flatMap((snap) => snap.entries)),
    ...boardRows,
    ...(fetchedPrevious?.snapshots.flatMap((snap) => snap.entries) ?? []),
  ];
  for (const handle of knownHandles(rowsForSuggestions)) {
    const option = el("option");
    option.value = handle;
    suggestions.append(option);
  }
  filters.append(searchLabel, suggestions);
  const chips = el("div", "chips");
  const allButton = el("button", "", "All stored seasons");
  allButton.type = "button";
  allButton.setAttribute("aria-pressed", "false");
  allButton.addEventListener("click", () => {
    chartSeason = "all";
    paintSeasonChips();
    paintChart();
  });
  chips.append(allButton);
  for (const season of seasons) {
    const button = el("button", "", seasonLabel(season.number));
    button.type = "button";
    button.dataset.season = String(season.number);
    button.addEventListener("click", () => {
      chartSeason = season.number;
      paintSeasonChips();
      paintChart();
    });
    chips.append(button);
  }
  filters.append(chips);
  historyRoot.append(filters);
  const host = el("div");
  host.id = "chart-host";
  const tableHost = el("div");
  tableHost.id = "chart-table";
  historyRoot.append(host, tableHost);
  paintSeasonChips();
  paintChart();

  catalogRoot.replaceChildren();
  const catalogTitle = el("h2", "", "Catalog");
  catalogTitle.id = "catalog-title";
  catalogRoot.append(catalogTitle);
  if (!site.catalog) {
    catalogRoot.append(el("p", "", "No catalog snapshot is stored yet."));
    return;
  }
  catalogRoot.append(el("p", "note", `Catalog snapshot: ${formatPt(site.catalog.captured_at)} · ${site.catalog.total} bots`));
  const tagged = site.catalog.season_tags.find((tag) => tag.season === current);
  if (tagged) catalogRoot.append(el("p", "", `${tagged.count} bots are tagged with ${seasonLabel(current)}.`));
  const table = el("table");
  table.append(el("caption", "", "Catalog counts by rarity"));
  const header = el("tr");
  for (const label of ["Rarity", "Count", "Avg cost", "Avg attack", "Avg health"]) {
    header.append(el("th", label === "Rarity" ? "" : "num", label));
  }
  const catalogHead = el("thead");
  catalogHead.append(header);
  table.append(catalogHead);
  const catalogBody = el("tbody");
  for (const rarity of site.catalog.rarities) {
    const tr = el("tr");
    tr.append(
      el("td", "", rarity.rarity),
      el("td", "num", String(rarity.count)),
      el("td", "num", rarity.avg_cost == null ? "—" : rarity.avg_cost.toFixed(1)),
      el("td", "num", rarity.avg_attack == null ? "—" : rarity.avg_attack.toFixed(1)),
      el("td", "num", rarity.avg_health == null ? "—" : rarity.avg_health.toFixed(1)),
    );
    catalogBody.append(tr);
  }
  table.append(catalogBody);
  const catalogScroll = el("div", "table-scroll");
  catalogScroll.append(table);
  catalogRoot.append(catalogScroll);
  if (site.catalog.crews.length) {
    catalogRoot.append(el("p", "note", `Crews: ${site.catalog.crews.map((crew) => `${crew.crew} ${crew.count}`).join(" · ")}`));
  }
}

function appearanceTable(
  rows: { handle: string; appearances: number }[],
  denominator: string,
  caption: string,
): HTMLTableElement {
  const table = el("table");
  table.append(el("caption", "", caption));
  const header = el("tr");
  header.append(el("th", "", "Player"), el("th", "num", `Days of ${denominator}`));
  const head = el("thead");
  head.append(header);
  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    tr.append(el("td", "", row.handle), el("td", "num", `${row.appearances} of ${denominator}`));
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

function paintSeasonChips(): void {
  document.querySelectorAll(".chips button").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    const value = button.dataset.season;
    const pressed = value ? Number(value) === chartSeason : chartSeason === "all" && button.textContent === "All stored seasons";
    button.setAttribute("aria-pressed", String(pressed));
  });
}

async function main(): Promise<void> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/site-data.json?v=${encodeURIComponent(__SITE_BUILD__)}`);
  site = (await response.json()) as SiteData;
  seasons = site.seasons;
  const liveSeasonBody = await fetchJson(SEASON_URL);
  const liveBoardBody = await fetchJson(BOARD_URL);
  let liveClock: SeasonClock | null = null;
  if (liveSeasonBody && typeof liveSeasonBody === "object" && "current" in liveSeasonBody) {
    const currentSeason = (liveSeasonBody as { current?: Record<string, unknown> }).current;
    if (currentSeason && typeof currentSeason.number === "number") {
      liveClock = {
        number: currentSeason.number,
        state: typeof currentSeason.state === "string" ? currentSeason.state : "unknown",
        starts_at: typeof currentSeason.starts_at === "string" ? currentSeason.starts_at : null,
        ends_at: typeof currentSeason.ends_at === "string" ? currentSeason.ends_at : null,
      };
    }
  }
  if (liveBoardBody && typeof liveBoardBody === "object") {
    const body = liveBoardBody as { season?: { number?: number; state?: string }; data?: unknown };
    if (body.season && typeof body.season.number === "number") {
      live = {
        fetchedAt: new Date().toISOString(),
        season: body.season.number,
        state: body.season.state || "unknown",
        entries: mapRows(body.data),
      };
      liveNote = "Live board loaded.";
    }
  } else {
    liveNote = "Live refresh didn't load; showing the latest stored snapshot.";
  }
  current = liveClock?.number ?? live?.season ?? site.index.current?.number ?? seasons[seasons.length - 1]?.number ?? 0;
  const storedClock = site.index.seasons.find((season) => season.number === current) ?? null;
  clock =
    liveClock ??
    (storedClock
      ? {
          number: storedClock.number,
          state: storedClock.state,
          starts_at: storedClock.starts_at,
          ends_at: storedClock.ends_at,
        }
      : null) ??
    (site.index.current?.number === current ? site.index.current : null) ?? {
      number: current,
      state: live?.state ?? "unknown",
      starts_at: null,
      ends_at: null,
    };
  storedCurrent = toSnaps(seasons.find((season) => season.number === current));
  const previousNumber = officialPrevious(current);
  if (previousNumber && !seasons.some((season) => season.number === previousNumber)) {
    const body = await fetchJson(`${BOARD_URL.replace("limit=100", `season=${previousNumber}&limit=100`)}`);
    if (body && typeof body === "object") {
      const payload = body as { season?: { number?: number }; data?: unknown };
      if (payload.season?.number === previousNumber) {
        const entries = mapRows(payload.data);
        fetchedPrevious = {
          number: previousNumber,
          snapshot_count: 1,
          has_final: true,
          snapshots: [
            {
              captured_at: new Date().toISOString(),
              count: entries.length,
              final: true,
              entries,
            },
          ],
        };
      }
    }
  }
  render();
}

main().catch((error: unknown) => {
  seasonLine.textContent = error instanceof Error ? error.message : "The tracker data did not load.";
});
