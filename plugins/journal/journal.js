"use strict";

/**
 * The pure half of Work Journal: keys, row shape, filter flags, standup text.
 *
 * Everything here is a plain function over plain data so `test/` can hold it to
 * the ceilings the host actually enforces without a running ADE. The SDK wiring
 * lives in `index.js` and this file never touches it.
 */

/** Newest-first ordering out of a store that only ever sorts by key. */
const KEY_EPOCH_CEILING = 1e15;
const KEY_DIGITS = 16;

/** Kinds a note may carry. `""` is an ordinary note and is the default. */
const KINDS = ["", "blocked", "done"];

/** The two windows the standup, the CLI and the agent tools read. Computed from `at`, never stored. */
const RANGE_TODAY = "today";
const RANGE_WEEK = "week";

/**
 * The Journal page's "When" control, as offsets the CLIENT resolves.
 *
 * A `since` operand of `{"$rel": "-24h"}` is read against the reader's own
 * clock on every re-render, so nothing here goes stale at midnight and no row
 * has to be rewritten to keep a filter true. The labels say ROLLING WINDOWS
 * rather than "Today", because that is what an offset from now actually is —
 * naming it "Today" would be the same lie the stored `today` flag used to tell
 * at 00:01.
 */
const RANGE_OPTIONS = [
  { value: "", label: "All" },
  { value: "-24h", label: "Last 24 hours" },
  { value: "-7d", label: "Last 7 days" },
];

/** A week is the last seven days INCLUDING today, which is what "this week" means to a person keeping a journal. */
const WEEK_DAYS = 7;

/** Older than this and a note is rolled off. History-shaped data has to be windowed — 4,000 rows is not forever. */
const KEEP_DAYS = 120;

/** Lane options on the Journal page's lane filter: `segmented` takes 2–8, and "All" is one of them. */
const MAX_LANE_OPTIONS = 7;

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : "0".repeat(width - text.length) + text;
}

/**
 * A note's key, built so `collections.list` returns newest first.
 *
 * The store orders by key and nothing else, so the timestamp is INVERTED:
 * a later note produces a smaller number and therefore an earlier key. The
 * random suffix keeps two notes written in the same millisecond apart.
 */
function noteKey(at, suffix) {
  const inverted = Math.max(0, KEY_EPOCH_CEILING - Math.floor(at));
  return `note:${pad(inverted, KEY_DIGITS)}-${suffix}`;
}

/** Local calendar day, as `YYYY-MM-DD`. Local, not UTC: a journal's "today" is the writer's. */
function dayKey(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** Midnight-to-midnight distance in local days. Not `(a - b) / 86400000`, which drifts across a DST boundary. */
function daysBetween(later, earlier) {
  const a = new Date(later);
  const b = new Date(earlier);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

function formatTime(at) {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDay(at) {
  return new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function normalizeKind(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "note") return "";
  return KINDS.includes(value) ? value : "";
}

/** The chip a kind draws. There is no red in the vocabulary, so "blocked" is `warning`. */
function kindBadge(kind) {
  if (kind === "blocked") return { text: "Blocked", tone: "warning" };
  if (kind === "done") return { text: "Done", tone: "success" };
  return null;
}

/** One line, trimmed and bounded. `maxLabelChars` is 200 and a title over it costs the whole row. */
function noteText(raw, limit = 180) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * A stored note, already in the shape a `list` binding renders.
 *
 * The renderer does no reshaping, so `title` / `subtitle` / `badge` / `overflow`
 * ARE the row on screen, and the extra fields below them exist only for the
 * schema's `where` clauses. Storing anything else here would replicate to every
 * device for nothing.
 *
 * There are no `today` / `week` fields any more. They were a function of NOW
 * written into a row that outlives it, so every one of them was a lie by the
 * next midnight and something had to walk the store to correct them. `at` is a
 * fact about the note, and `since` reads it against the reader's clock.
 */
function noteRow({ key, text, kind, laneId, laneName, at }) {
  const lane = laneName || "no lane";
  const badge = kindBadge(kind);
  return {
    title: noteText(text),
    subtitle: `${lane} · ${formatTime(at)}`,
    meta: formatDay(at),
    ...(badge ? { badge } : {}),
    overflow: [
      { action: "deleteNote", args: { key }, label: "Delete note", confirm: "Delete this note?" },
    ],
    // Filter fields. Compared as strings by the client and never rendered.
    kind,
    laneKey: laneId || "",
    // Read as a TIME by the panels' `since` clauses, and read back by the
    // standup writer, the CLI and the search provider.
    at,
    text: noteText(text),
    laneName: lane,
  };
}

/**
 * Is this note inside the window, RIGHT NOW?
 *
 * Computed from the note's own timestamp against the clock at the moment of the
 * question, which is the whole fix for "notes stay Today past midnight": there
 * is nothing stored that can be out of date, so there is nothing to roll
 * forward and no schedule that has to run for the answer to be right.
 *
 * A future note is in neither window rather than in both — a clock that jumped,
 * or a note that synced from a machine running ahead, should not headline
 * today's standup.
 */
function inRange(row, range, now = Date.now()) {
  if (range === "all") return true;
  const at = typeof row?.at === "number" ? row.at : null;
  if (at === null) return false;
  const age = daysBetween(now, at);
  if (age < 0) return false;
  return range === RANGE_WEEK ? age < WEEK_DAYS : age === 0;
}

/**
 * The standup, grouped the way a standup is read out loud.
 *
 * Done first because it is what the meeting is for, then what is in flight,
 * then what is stuck — and "stuck" last so it is the sentence still in the
 * room when you stop talking.
 */
function standupText(rows, now = Date.now()) {
  const done = rows.filter((row) => row.kind === "done");
  const blocked = rows.filter((row) => row.kind === "blocked");
  const progress = rows.filter((row) => row.kind === "");
  const lines = [`Standup — ${formatDay(now)}`];
  const section = (title, items) => {
    if (!items.length) return;
    lines.push("", `${title}:`);
    for (const row of items) {
      const lane = row.laneName && row.laneName !== "no lane" ? ` (${row.laneName})` : "";
      lines.push(`• ${row.text}${lane}`);
    }
  };
  section("Done", done);
  section("In progress", progress);
  section("Blocked", blocked);
  if (lines.length === 1) lines.push("", "Nothing logged today.");
  return lines.join("\n");
}

/**
 * The lane filter's options, capped at what a `segmented` control may hold.
 *
 * Busiest lanes win the slots, because a lane you wrote one note against three
 * days ago is not the one you are trying to filter down to. What did not fit is
 * returned so the caller can say so rather than silently showing fewer lanes.
 */
function laneOptions(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (!row.laneKey) continue;
    const entry = counts.get(row.laneKey) ?? { value: row.laneKey, label: row.laneName, count: 0 };
    entry.count += 1;
    entry.label = row.laneName || entry.label;
    counts.set(row.laneKey, entry);
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const shown = ranked.slice(0, MAX_LANE_OPTIONS);
  return {
    options: [
      { value: "", label: "All lanes" },
      ...shown.map((entry) => ({ value: entry.value, label: entry.label, badge: entry.count })),
    ],
    hidden: ranked.length - shown.length,
  };
}

/** Case-insensitive substring match over the note and its lane. Live on every keystroke, so it stays this cheap. */
function searchRows(rows, query, limit = 8) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return [];
  const hits = [];
  for (const row of rows) {
    const haystack = `${row.text} ${row.laneName}`.toLowerCase();
    if (!haystack.includes(needle)) continue;
    hits.push(row);
    if (hits.length >= limit) break;
  }
  return hits;
}

/** `"09:30"` → the five-field cron that fires at it. Returns null for anything that is not a real time of day. */
function cronForTime(raw) {
  const match = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(String(raw ?? ""));
  if (!match) return null;
  return `${Number(match[2])} ${Number(match[1])} * * *`;
}

/** An incoming-webhook URL we are willing to post to. The manifest declares the host; this checks the one we were given. */
function isSlackWebhook(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "hooks.slack.com";
  } catch {
    return false;
  }
}

/** Keys older than the retention window, oldest first — what a prune pass deletes. */
function expiredKeys(rows, now) {
  return rows.filter((row) => typeof row.value?.at === "number" && daysBetween(now, row.value.at) > KEEP_DAYS)
    .map((row) => row.key);
}

module.exports = {
  KEEP_DAYS,
  KINDS,
  MAX_LANE_OPTIONS,
  RANGE_OPTIONS,
  RANGE_TODAY,
  RANGE_WEEK,
  WEEK_DAYS,
  cronForTime,
  dayKey,
  daysBetween,
  expiredKeys,
  formatDay,
  formatTime,
  inRange,
  isSlackWebhook,
  kindBadge,
  laneOptions,
  noteKey,
  noteRow,
  noteText,
  normalizeKind,
  searchRows,
  standupText,
};
