// Pure log parsing for ade-log-viewer.
//
// Split out from `index.js` because everything here is decidable without a host:
// given bytes, it produces the panel the viewer publishes. That makes the
// interesting half testable directly (see `pilotPackages.test.ts`) and keeps
// `index.js` down to the two things that genuinely need the SDK — reading the
// file and publishing the result.
//
// CommonJS and dependency-free: the child loads plugin code with `require` and
// an official plugin ships no `node_modules`.

"use strict";

/** Levels the viewer knows, most severe first. Anything else reads as `info`. */
const LEVELS = ["error", "warn", "info", "debug"];

/**
 * Level → vocabulary tone.
 *
 * The vocabulary has no red (a failure is amber — the house rule stated in
 * `adeCard.ts`), so the mapping has three visible steps rather than four:
 * errors take the one alarming tone, warnings take the accent, and the rest
 * stay quiet. In a file where most lines are `info`, quiet is the point.
 */
const TONE_BY_LEVEL = {
  error: "warning",
  warn: "accent",
  info: "neutral",
  debug: "neutral",
};

/** Longest message kept per row. The vocabulary caps titles at 200 characters. */
const MAX_MESSAGE_CHARS = 160;

/** Panel schema ceiling, matching `PLUGIN_PANEL_SCHEMA_MAX_BYTES`. */
const MAX_SCHEMA_BYTES = 64 * 1024;

/** Rows the vocabulary will render in one list. */
const MAX_LIST_ITEMS = 100;

function normalizeLevel(value) {
  if (typeof value === "number") {
    // Bunyan/pino numeric levels: 50+ error, 40 warn, 30 info, below that debug.
    if (value >= 50) return "error";
    if (value >= 40) return "warn";
    if (value >= 30) return "info";
    return "debug";
  }
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (text === "err" || text === "error" || text === "fatal" || text === "crit" || text === "critical") return "error";
  if (text === "warn" || text === "warning") return "warn";
  if (text === "info" || text === "notice" || text === "log") return "info";
  if (text === "debug" || text === "trace" || text === "verbose") return "debug";
  return null;
}

function firstString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** `[2026-08-11T09:12:00Z] ERROR something` and the shapes around it. */
const LEVEL_WORDS = "error|err|fatal|critical|crit|warn|warning|info|notice|debug|trace";
/** A level the line LEADS with — stripped, because the panel shows it in `meta`. */
const LEADING_LEVEL_PATTERN = new RegExp(`^[[(|]?(${LEVEL_WORDS})[\\])|]?\\s*[:—-]?\\s+`, "i");
/** A level mentioned early — classifies the line but stays in the message. */
const TEXT_LEVEL_PATTERN = new RegExp(`(?:^|[\\s[(|])(${LEVEL_WORDS})(?:[\\s\\]):|]|$)`, "i");
const LEADING_TIMESTAMP_PATTERN = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s*/;

/**
 * One line → one row.
 *
 * NDJSON first, because a line that parses as an object carries its own answers
 * and guessing at them from the text would be strictly worse. Plain text falls
 * back to the two things that are actually reliable in an unknown format: a
 * leading timestamp, and a level word.
 */
function parseLogLine(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;

  if (text.startsWith("{")) {
    let decoded = null;
    try {
      decoded = JSON.parse(text);
    } catch {
      decoded = null;
    }
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      const level = normalizeLevel(decoded.level)
        ?? normalizeLevel(decoded.lvl)
        ?? normalizeLevel(decoded.severity)
        ?? "info";
      const message = firstString(decoded, ["message", "msg", "text", "event", "err", "error"])
        // A structured line with no message field is still worth showing; its
        // own JSON is the most honest thing to put in the row.
        ?? text.slice(0, MAX_MESSAGE_CHARS);
      const time = firstString(decoded, ["time", "ts", "timestamp", "@timestamp", "date"]);
      return { level, message: clip(message), time, structured: true };
    }
  }

  let rest = text;
  let time = null;
  const stamped = LEADING_TIMESTAMP_PATTERN.exec(rest);
  if (stamped) {
    time = stamped[1];
    rest = rest.slice(stamped[0].length);
  }
  const led = LEADING_LEVEL_PATTERN.exec(rest);
  if (led) {
    const level = normalizeLevel(led[1]) ?? "info";
    return { level, message: clip(rest.slice(led[0].length) || rest), time, structured: false };
  }
  const matched = TEXT_LEVEL_PATTERN.exec(rest.slice(0, 64));
  const level = matched ? normalizeLevel(matched[1]) ?? "info" : "info";
  return { level, message: clip(rest || text), time, structured: false };
}

function clip(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}

/**
 * Split a byte-range read into whole lines.
 *
 * `partial` is true when the read started mid-file, in which case the first line
 * is a fragment of a line whose beginning was never read — dropping it is the
 * difference between a truncated message and a wrong one.
 */
function splitLines(content, partial) {
  const lines = String(content ?? "").split(/\r?\n/);
  if (partial && lines.length > 1) lines.shift();
  return lines.filter((line) => line.trim().length > 0);
}

function parseLogLines(content, partial) {
  const entries = [];
  for (const line of splitLines(content, partial)) {
    const entry = parseLogLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Counts per level, for the summary badges. */
function summarize(entries) {
  const counts = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const entry of entries) {
    if (counts[entry.level] === undefined) counts.info += 1;
    else counts[entry.level] += 1;
  }
  return counts;
}

/** Filter to one level (or all), then keep the last `limit` rows. */
function selectTail(entries, options) {
  const level = options && options.level;
  const limit = clampInt(options && options.limit, 10, MAX_LIST_ITEMS, MAX_LIST_ITEMS);
  const filtered = level && level !== "all" ? entries.filter((entry) => entry.level === level) : entries;
  return filtered.slice(Math.max(0, filtered.length - limit));
}

function clampInt(value, min, max, fallback) {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "unknown size";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function levelOptions() {
  return [
    { value: "all", label: "All levels" },
    { value: "error", label: "Errors" },
    { value: "warn", label: "Warnings" },
    { value: "info", label: "Info" },
    { value: "debug", label: "Debug" },
  ];
}

/**
 * The panel a loaded file becomes.
 *
 * Everything on it is already-decided data: the plugin did the parsing on the
 * machine that holds the file, and what crosses to the client is rows. That is
 * the vocabulary's rule, and it is also why this renders identically on a phone.
 */
function buildViewerSchema(view) {
  const {
    fileName,
    filePath,
    totalSize,
    readBytes,
    truncated,
    entries,
    counts,
    level,
    limit,
  } = view;

  const rows = selectTail(entries, { level, limit });
  const badges = [
    counts.error > 0 ? { component: "badge", text: `${counts.error} error${counts.error === 1 ? "" : "s"}`, tone: "warning" } : null,
    counts.warn > 0 ? { component: "badge", text: `${counts.warn} warning${counts.warn === 1 ? "" : "s"}`, tone: "accent" } : null,
    { component: "badge", text: `${entries.length} line${entries.length === 1 ? "" : "s"} read`, tone: "neutral" },
  ].filter(Boolean);

  const summaryRows = [
    { key: "File", value: filePath },
    { key: "Size", value: formatBytes(totalSize) },
    {
      key: "Read",
      value: truncated
        ? `last ${formatBytes(readBytes)} of the file`
        : "the whole file",
    },
    {
      key: "Showing",
      value: level && level !== "all"
        ? `${rows.length} ${level} line${rows.length === 1 ? "" : "s"}, newest last`
        : `${rows.length} line${rows.length === 1 ? "" : "s"}, newest last`,
    },
  ];

  const schema = {
    v: 1,
    title: fileName,
    fallback: {
      title: fileName,
      text: `${entries.length} lines read · ${counts.error} errors · ${counts.warn} warnings`,
    },
    body: [
      { component: "stack", direction: "horizontal", gap: "sm", wrap: true, children: badges },
      { component: "keyValue", rows: summaryRows },
      {
        component: "form",
        fields: [
          {
            kind: "select",
            id: "level",
            label: "Level",
            options: levelOptions(),
            value: level && level !== "all" ? level : "all",
          },
        ],
        submit: { label: "Reload", onPress: { action: "load" } },
      },
      { component: "divider" },
      {
        component: "list",
        emptyText: level && level !== "all"
          ? `No ${level} lines in the part of the file that was read.`
          : "No lines in the part of the file that was read.",
        items: rows.map((entry) => ({
          title: entry.message,
          meta: entry.time ? `${entry.level} · ${entry.time}` : entry.level,
          tone: TONE_BY_LEVEL[entry.level] || "neutral",
        })),
      },
    ],
  };

  return fitSchema(schema);
}

/**
 * Shed rows until the schema is inside the writer's ceiling.
 *
 * The budget is enforced by the host inside its write transaction, so a schema
 * over it is refused outright — a viewer that published 100 long lines and got
 * a `plugin_budget_exceeded` would show the file as broken. Dropping the oldest
 * rows is the one truncation a tail view can make without lying.
 */
function fitSchema(schema) {
  const list = schema.body[schema.body.length - 1];
  while (byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES && list.items.length > 1) {
    list.items = list.items.slice(Math.ceil(list.items.length / 2));
  }
  return schema;
}

function byteLength(text) {
  return typeof Buffer !== "undefined" ? Buffer.byteLength(text, "utf8") : text.length;
}

/** The panel shown before a file has been read, and after an unreadable one. */
function buildPromptSchema(message) {
  return {
    v: 1,
    title: "Log",
    fallback: {
      title: "Log viewer",
      text: message || "Press Load to read the end of this file.",
    },
    body: [
      {
        component: "emptyState",
        title: "Nothing read yet",
        description: message
          || "Logs can be enormous, so this reads the end of the file on request rather than on sight.",
        icon: "list",
        action: { label: "Load", onPress: { action: "load" } },
      },
    ],
  };
}

module.exports = {
  LEVELS,
  MAX_LIST_ITEMS,
  MAX_MESSAGE_CHARS,
  MAX_SCHEMA_BYTES,
  TONE_BY_LEVEL,
  buildPromptSchema,
  buildViewerSchema,
  clampInt,
  formatBytes,
  normalizeLevel,
  parseLogLine,
  parseLogLines,
  selectTail,
  splitLines,
  summarize,
};
