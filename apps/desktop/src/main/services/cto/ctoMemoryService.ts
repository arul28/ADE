import fs from "node:fs";
import path from "node:path";
import type { CtoMemorySearchRow, CtoMemorySnapshot } from "../../../shared/types";
import { clipText, nowIso, redactSecrets, writeTextAtomic } from "../shared/utils";

type Logger = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

type CtoMemoryServiceArgs = {
  /** The project's `.ade` directory (same value ctoStateService receives). */
  adeDir: string;
  logger?: Logger | null;
};

// Disk copies are never truncated; only the injected copies are capped so the
// reconstruction context stays within a sane token budget (~4 chars/token).
//
// These came down from 8000/4000/4000 when the live state block joined the same
// reconstruction context. Measured on this project the three memory files hold
// 1275 + 3456 + 405 chars, so the old caps were never binding — the reduction
// costs nothing today and hands the live block its 6000 without growing the
// per-turn prefix at all: 10000 here plus `CTO_LIVE_STATE_MAX_CHARS` is the
// same 16000 the three sections used to claim on their own.
const MEMORY_INJECT_MAX_CHARS = 4000;
const THREAD_STATE_INJECT_MAX_CHARS = 3000;
const DAILY_INJECT_MAX_CHARS = 3000;

// Worker (non-CTO) chats receive a much thinner slice: only the facts tagged
// with their own lane plus the rolling thread state. It rides along with the
// lane execution directive, so it is delivered once per lane change, not once
// per turn.
const LANE_FACTS_INJECT_MAX_CHARS = 1500;
const LANE_THREAD_STATE_INJECT_MAX_CHARS = 1200;

// A single discovery read-out is bounded the same way: the CTO takes it on a
// child report line, which is a one-line channel by design.
const DISCOVERY_READ_MAX_CHARS = 1200;
const DISCOVERY_FACT_MAX_CHARS = 400;

// Hard cap on the on-disk MEMORY.md so a runaway `saveMemory` loop cannot grow
// the file without bound. Oldest facts are dropped first when the cap is hit.
const MEMORY_FILE_MAX_BYTES = 64 * 1024;

// The same discipline for discoveries.md, and it needs it MORE: MEMORY.md is
// written only by the CTO's own `saveMemory`, while any agent can append a
// discovery — through the universal tool, `ade actions run
// cto_memory.recordDiscovery`, or an automation `ade-action` step — and the
// only reaper is the nightly gardener, which is a prompt, not a code path. A
// worker stuck in a retry loop files one per turn. The cap is larger than
// MEMORY.md's because this file is a drain queue, not a standing document.
const DISCOVERIES_FILE_MAX_BYTES = 128 * 1024;

// One read-out pulls at most this many bytes off the queue. The cursor then
// advances by exactly what was read, so a backlog bigger than the window is
// drained across several reports rather than skipped — and no single child
// report reads an unbounded file into memory.
const DISCOVERY_READ_MAX_BYTES = 64 * 1024;

// Per-turn journal line caps (`HH:MM — user → outcome`).
const JOURNAL_USER_MAX_CHARS = 160;
const JOURNAL_OUTCOME_MAX_CHARS = 200;

// A single fact may not dominate MEMORY.md — clip before the byte-cap pass so
// one runaway `saveMemory` payload cannot evict every other fact.
const MEMORY_FACT_MAX_CHARS = 2000;

const MEMORY_HEADER = "# CTO Durable Memory";
const MEMORY_FACTS_HEADING = "## Facts";
const THREAD_STATE_HEADER = "# CTO Thread State";
const DISCOVERIES_HEADER = "# Worker discoveries (unreviewed — the CTO distills these into facts)";
const DISCOVERIES_HEADER_BLOCK = `${DISCOVERIES_HEADER}\n\n`;

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function statMtimeIso(filePath: string): string | null {
  try {
    return new Date(fs.statSync(filePath).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

/** Local calendar date as `YYYY-MM-DD` — used for daily log file names. */
function todayStamp(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localHourMinute(now = new Date()): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Keep the newest content (tail) when a body exceeds the cap. */
function truncateKeepTail(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  return `…(older content truncated)\n${body.slice(body.length - maxChars)}`;
}

/** Keep the leading content (head) when a body exceeds the cap. */
function truncateKeepHead(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n…(truncated)`;
}

/* ── Fact tags ── */

/**
 * The closed tag vocabulary. Facts carry a trailing `[lane:x pr:123 path:a/b
 * topic:t]` suffix so a later reader can ask "what do we know about THIS lane"
 * without a database. Untagged facts predate this and stay valid everywhere —
 * nothing filters them out, they simply never satisfy a tag-scoped query.
 */
export const CTO_MEMORY_TAG_KEYS = ["lane", "pr", "path", "topic"] as const;

export type CtoMemoryTagKey = (typeof CTO_MEMORY_TAG_KEYS)[number];

export type CtoMemoryTags = Partial<Record<CtoMemoryTagKey, string | number | null>>;

/**
 * Tag values are whitespace-free by construction so the suffix stays parseable
 * with a single regex — a topic of "lane timeline" is stored as
 * `topic:lane-timeline`. Empty values are dropped rather than written blank.
 */
function normalizeTagValue(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value).replace(/[\s\]]+/g, "-").replace(/^-+|-+$/g, "").trim();
  if (!text.length) return null;
  return text.slice(0, 120);
}

/** `[lane:x pr:123 path:a/b topic:t]`, or "" when no tag has a value. */
export function formatMemoryTagSuffix(tags?: CtoMemoryTags | null): string {
  if (!tags) return "";
  const parts: string[] = [];
  for (const key of CTO_MEMORY_TAG_KEYS) {
    const value = normalizeTagValue(tags[key]);
    if (value) parts.push(`${key}:${value}`);
  }
  return parts.length ? ` [${parts.join(" ")}]` : "";
}

const MEMORY_TAG_SUFFIX_PATTERN = new RegExp(
  `\\[((?:${CTO_MEMORY_TAG_KEYS.join("|")}):[^\\]\\s]+(?:\\s+(?:${CTO_MEMORY_TAG_KEYS.join("|")}):[^\\]\\s]+)*)\\]\\s*$`,
);

/** Parsed tags for one stored line. Untagged lines return an empty record. */
export function parseMemoryTags(line: string): Record<CtoMemoryTagKey, string | undefined> {
  const parsed: Record<string, string | undefined> = {};
  const match = MEMORY_TAG_SUFFIX_PATTERN.exec(line.trimEnd());
  if (!match) return parsed as Record<CtoMemoryTagKey, string | undefined>;
  for (const token of match[1].split(/\s+/)) {
    const separator = token.indexOf(":");
    if (separator <= 0) continue;
    const key = token.slice(0, separator) as CtoMemoryTagKey;
    const value = token.slice(separator + 1);
    if (!CTO_MEMORY_TAG_KEYS.includes(key) || !value.length) continue;
    // First wins: a hand-edited line with a repeated key keeps its leading value.
    if (parsed[key] === undefined) parsed[key] = value;
  }
  return parsed as Record<CtoMemoryTagKey, string | undefined>;
}

/** True when every requested tag is present on the line with the same value. */
function lineMatchesTags(line: string, filter: CtoMemoryTags): boolean {
  const parsed = parseMemoryTags(line);
  for (const key of CTO_MEMORY_TAG_KEYS) {
    const wanted = normalizeTagValue(filter[key]);
    if (!wanted) continue;
    if ((parsed[key] ?? "").toLowerCase() !== wanted.toLowerCase()) return false;
  }
  return true;
}

/** True when any tag VALUE on the line contains the needle. */
function lineTagsMatchNeedle(line: string, needle: string): boolean {
  const parsed = parseMemoryTags(line);
  return CTO_MEMORY_TAG_KEYS.some((key) => (parsed[key] ?? "").toLowerCase().includes(needle));
}

export function createCtoMemoryService(args: CtoMemoryServiceArgs) {
  const logger = args.logger ?? null;
  const ctoDir = path.join(args.adeDir, "cto");
  const dailyDir = path.join(ctoDir, "daily");
  const memoryPath = path.join(ctoDir, "MEMORY.md");
  const threadStatePath = path.join(ctoDir, "thread-state.md");
  const memoryArchivePath = path.join(ctoDir, "memory-archive.md");
  const discoveriesPath = path.join(ctoDir, "discoveries.md");
  const discoveriesArchivePath = path.join(ctoDir, "discoveries-archive.md");
  const discoveriesCursorPath = path.join(ctoDir, "discoveries.cursor");

  fs.mkdirSync(ctoDir, { recursive: true });

  const warn = (message: string, error: unknown, meta?: Record<string, unknown>): void => {
    logger?.warn(message, {
      ...(meta ?? {}),
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const dailyPathFor = (stamp: string): string => path.join(dailyDir, `${stamp}.md`);

  /* ── MEMORY.md ── */

  const readMemory = (): string => readFileOrEmpty(memoryPath);

  const archiveMemoryContent = (content: string, reason: string): void => {
    const body = content.trim();
    if (!body.length) return;
    try {
      const archiveExists = fs.existsSync(memoryArchivePath);
      fs.appendFileSync(
        memoryArchivePath,
        `${archiveExists ? "" : "# CTO Memory Archive (facts evicted from MEMORY.md)\n\n"}<!-- ${reason} ${nowIso()} -->\n${body}\n`,
        "utf8",
      );
    } catch (error) {
      warn("cto_memory.archive_failed", error, { reason });
    }
  };

  const writeMemory = (content: string): void => {
    const next = content.trim().length ? redactSecrets(content.trim()) : MEMORY_HEADER;
    // A full rewrite that clears existing content preserves what it replaces in
    // the append-only archive — durable memory is never silently destroyed.
    if (next === MEMORY_HEADER) {
      const previous = readMemory().trim();
      if (previous.length && previous !== MEMORY_HEADER) {
        archiveMemoryContent(previous, "cleared by updateMemory");
      }
    }
    writeTextAtomic(memoryPath, `${next}\n`);
  };

  /**
   * Append a durable fact under the `## Facts` section. Exact-line duplicates
   * are ignored. If the file would exceed the byte cap, the oldest facts are
   * moved to the append-only `memory-archive.md` (never silently destroyed)
   * and the eviction is reported to the caller.
   */
  const appendMemoryFact = (
    fact: string,
    tags?: CtoMemoryTags | null,
  ): { saved: boolean; fact: string; evictedCount?: number } => {
    // Memory files are plaintext on disk and re-injected into prompts: scrub
    // secret-shaped content and clip a single fact before the byte-cap pass.
    const normalized = clipText(redactSecrets(fact.replace(/\s+/g, " ").trim()), MEMORY_FACT_MAX_CHARS);
    if (!normalized.length) return { saved: false, fact: "" };
    // The suffix is appended after the clip so a long fact can never truncate
    // its own tags away — the tags are what make it findable later.
    const tagged = `${normalized}${formatMemoryTagSuffix(tags)}`;
    const bullet = `- ${tagged}`;

    const existing = readMemory();
    const lines = existing.length ? existing.split(/\r?\n/) : [];

    // Split into a header block (everything before `## Facts`) and the fact list.
    let factsHeadingIndex = lines.findIndex((line) => line.trim() === MEMORY_FACTS_HEADING);
    const header: string[] = [];
    const facts: string[] = [];
    if (factsHeadingIndex === -1) {
      // No facts section yet — preserve any existing header content.
      for (const line of lines) header.push(line);
    } else {
      for (let i = 0; i < factsHeadingIndex; i += 1) header.push(lines[i]);
      for (let i = factsHeadingIndex + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.trim().length) facts.push(line.trimEnd());
      }
    }
    if (!header.length) header.push(MEMORY_HEADER);

    if (facts.some((line) => line.trim() === bullet)) {
      return { saved: false, fact: tagged };
    }
    facts.push(bullet);

    const render = (factList: string[]): string =>
      [
        ...header.map((line) => line.replace(/\s+$/, "")),
        "",
        MEMORY_FACTS_HEADING,
        "",
        ...factList,
        "",
      ]
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd();

    // Move oldest facts to the append-only archive until under the byte cap —
    // durable memory is never silently destroyed, only demoted out of the
    // always-injected file (the archive stays reachable via searchMemory).
    const evicted: string[] = [];
    let rendered = render(facts);
    while (Buffer.byteLength(rendered, "utf8") > MEMORY_FILE_MAX_BYTES && facts.length > 1) {
      evicted.push(facts.shift() as string);
      rendered = render(facts);
    }
    if (evicted.length) {
      archiveMemoryContent(evicted.join("\n"), "evicted by size cap");
    }

    writeTextAtomic(memoryPath, `${rendered}\n`);
    return { saved: true, fact: tagged, ...(evicted.length ? { evictedCount: evicted.length } : {}) };
  };

  /**
   * Durable facts carrying `[lane:<laneId>]`, newest last, bounded for
   * injection. Untagged facts are deliberately excluded: this is the lane-
   * scoped slice a worker chat receives, and an untagged fact has not claimed
   * to be about this lane.
   */
  const listFactsForLane = (laneId: string, maxChars = LANE_FACTS_INJECT_MAX_CHARS): string => {
    const lane = laneId.trim();
    if (!lane.length) return "";
    const matched = readMemory()
      .split(/\r?\n/)
      .filter((line) => line.trim().length && lineMatchesTags(line, { lane }))
      .map((line) => line.trimEnd());
    if (!matched.length) return "";
    return truncateKeepTail(matched.join("\n"), maxChars);
  };

  /* ── thread-state.md ── */

  const readThreadState = (): string => readFileOrEmpty(threadStatePath);

  const writeThreadState = (content: string, reason?: string): void => {
    const summary = redactSecrets(content.trim());
    if (!summary.length) return;
    const stamp = `_Updated ${nowIso()}${reason ? ` (${reason})` : ""}_`;
    const body = [THREAD_STATE_HEADER, "", stamp, "", summary].join("\n");
    writeTextAtomic(threadStatePath, `${body}\n`);
  };

  /* ── daily logs ── */

  const appendDailyEntry = (line: string, now = new Date()): void => {
    const entry = redactSecrets(line.replace(/\r?\n/g, " ").trim());
    if (!entry.length) return;
    const stamp = todayStamp(now);
    const filePath = dailyPathFor(stamp);
    fs.mkdirSync(dailyDir, { recursive: true });
    const fileExists = fs.existsSync(filePath);
    // New files get a dated header; existing files just get the appended line.
    fs.appendFileSync(filePath, fileExists ? `${entry}\n` : `# ${stamp}\n\n${entry}\n`, "utf8");
  };

  /**
   * One compact daily-log line per completed CTO turn:
   * `HH:MM — <user intent> → <outcome>`. Owns the format and caps so callers
   * only supply the raw text.
   */
  const appendTurnJournal = (
    input: { user: string; outcome: string },
    now = new Date(),
  ): void => {
    const user = input.user.replace(/\s+/g, " ").trim();
    const outcome = input.outcome.replace(/\s+/g, " ").trim();
    if (!user.length && !outcome.length) return;
    const line = `${localHourMinute(now)} — ${clipText(user, JOURNAL_USER_MAX_CHARS)} → ${clipText(outcome, JOURNAL_OUTCOME_MAX_CHARS)}`;
    appendDailyEntry(line, now);
  };

  const listDailyStampsNewestFirst = (): string[] => {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dailyDir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => name.replace(/\.md$/, ""))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  };

  const readRecentDailyEntries = (days = 2, maxChars = DAILY_INJECT_MAX_CHARS): string => {
    const stamps = listDailyStampsNewestFirst().slice(0, Math.max(1, days));
    if (!stamps.length) return "";
    // Oldest first so the newest content sits at the tail and survives truncation.
    const chronological = [...stamps].reverse();
    const blocks: string[] = [];
    for (const stamp of chronological) {
      const content = readFileOrEmpty(dailyPathFor(stamp)).trim();
      if (content.length) blocks.push(content);
    }
    return truncateKeepTail(blocks.join("\n\n"), maxChars);
  };

  /* ── search ── */

  const searchMemory = (
    query: string,
    options: { limit?: number; tags?: CtoMemoryTags | null } = {},
  ): CtoMemorySearchRow[] => {
    const needle = query.trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)));
    const tagFilter = options.tags ?? null;
    const hasTagFilter = Boolean(tagFilter && formatMemoryTagSuffix(tagFilter).length);
    // An empty query is meaningful once tags exist: "everything about lane X".
    if (!needle.length && !hasTagFilter) return [];

    // Tag hits and substring hits are collected separately so tags win the
    // result budget — a fact that declared itself to be about this lane/PR is
    // a better answer than one that merely mentions the word somewhere.
    const tagHits: CtoMemorySearchRow[] = [];
    const textHits: CtoMemorySearchRow[] = [];
    const scan = (
      file: CtoMemorySearchRow["file"],
      date: string | null,
      content: string,
    ): void => {
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (tagHits.length >= limit) return;
        const raw = lines[i];
        if (!raw.trim().length) continue;
        if (hasTagFilter && !lineMatchesTags(raw, tagFilter as CtoMemoryTags)) continue;
        const row: CtoMemorySearchRow = { file, date, line: i + 1, snippet: raw.trim().slice(0, 240) };
        if (needle.length && lineTagsMatchNeedle(raw, needle)) {
          tagHits.push(row);
          continue;
        }
        // Untagged facts still match here exactly as they always did.
        if (!needle.length || raw.toLowerCase().includes(needle)) {
          if (textHits.length < limit) textHits.push(row);
        }
      }
    };

    // Durable facts first — current then archived — before any transient
    // content (rolling thread summary, daily journals), so evicted memories
    // are never starved out of the result budget.
    const budgetLeft = (): boolean => tagHits.length + textHits.length < limit * 2;
    scan("MEMORY.md", null, readMemory());
    if (budgetLeft()) scan("memory-archive.md", null, readFileOrEmpty(memoryArchivePath));
    if (budgetLeft()) scan("thread-state.md", null, readThreadState());
    if (budgetLeft()) {
      for (const stamp of listDailyStampsNewestFirst()) {
        if (!budgetLeft()) break;
        scan("daily", stamp, readFileOrEmpty(dailyPathFor(stamp)));
      }
    }
    return [...tagHits, ...textHits].slice(0, limit);
  };

  /* ── discoveries ── */

  const readDiscoveryCursor = (): number => {
    const raw = readFileOrEmpty(discoveriesCursorPath).trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };

  const writeDiscoveryCursor = (offset: number): void => {
    try {
      writeTextAtomic(discoveriesCursorPath, `${Math.max(0, offset)}\n`);
    } catch (error) {
      warn("cto_memory.discovery_cursor_write_failed", error, {});
    }
  };

  /**
   * Hold discoveries.md under its byte cap by moving the OLDEST entries to the
   * append-only `discoveries-archive.md` — the same archive-then-evict shape
   * `appendMemoryFact` uses, because an unreviewed worker note is still
   * evidence and must not be silently destroyed.
   *
   * The read cursor is a byte offset into this file, so it is rewound by
   * exactly the number of bytes removed. An already-drained discovery stays
   * drained; if the evicted head reached past the cursor the rewind clamps to
   * 0, which can re-deliver a discovery but can never skip one — the same
   * direction every other decision on this cursor errs in.
   */
  const evictDiscoveriesOverCap = (): void => {
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(discoveriesPath);
    } catch {
      return;
    }
    if (buffer.byteLength <= DISCOVERIES_FILE_MAX_BYTES) return;
    try {
      const text = buffer.toString("utf8");
      const hasHeader = text.startsWith(DISCOVERIES_HEADER_BLOCK);
      const body = hasHeader ? text.slice(DISCOVERIES_HEADER_BLOCK.length) : text;
      const header = hasHeader ? DISCOVERIES_HEADER_BLOCK : "";
      const entries = body.split("\n");
      // `split` leaves a trailing "" for the final newline — keep it out of the
      // eviction loop so the rewritten file still ends in one.
      const trailing = entries.length && entries[entries.length - 1] === "" ? entries.pop() : null;
      const evicted: string[] = [];
      const render = (): string =>
        `${header}${entries.join("\n")}${trailing === null ? "" : "\n"}`;
      let rendered = render();
      while (Buffer.byteLength(rendered, "utf8") > DISCOVERIES_FILE_MAX_BYTES && entries.length > 1) {
        evicted.push(entries.shift() as string);
        rendered = render();
      }
      if (!evicted.length) return;
      const archiveExists = fs.existsSync(discoveriesArchivePath);
      fs.appendFileSync(
        discoveriesArchivePath,
        `${archiveExists ? "" : "# Worker discoveries archive (evicted from discoveries.md)\n\n"}<!-- evicted by size cap ${nowIso()} -->\n${evicted.join("\n")}\n`,
        "utf8",
      );
      const removed = buffer.byteLength - Buffer.byteLength(rendered, "utf8");
      writeTextAtomic(discoveriesPath, rendered);
      const cursor = readDiscoveryCursor();
      if (cursor > 0) writeDiscoveryCursor(cursor - removed);
    } catch (error) {
      warn("cto_memory.discovery_evict_failed", error, {});
    }
  };

  /**
   * The worker-to-CTO channel. Any agent — not just the CTO — may append a
   * discovery; the CTO drains the new ones on each child report and decides
   * what becomes a durable fact. Deliberately a separate file, not MEMORY.md:
   * an unreviewed worker note must not enter durable memory just by being
   * written. Appends are capped the same way `appendMemoryFact` is — the
   * writer set here is strictly wider, so the file needs the bound more.
   */
  const recordDiscovery = (
    fact: string,
    tags?: CtoMemoryTags | null,
    now = new Date(),
  ): { saved: boolean; fact: string } => {
    const normalized = clipText(
      redactSecrets(fact.replace(/\s+/g, " ").trim()),
      DISCOVERY_FACT_MAX_CHARS,
    );
    if (!normalized.length) return { saved: false, fact: "" };
    const tagged = `${normalized}${formatMemoryTagSuffix(tags)}`;
    try {
      const exists = fs.existsSync(discoveriesPath);
      fs.appendFileSync(
        discoveriesPath,
        `${exists ? "" : DISCOVERIES_HEADER_BLOCK}- ${now.toISOString()} ${tagged}\n`,
        "utf8",
      );
    } catch (error) {
      warn("cto_memory.discovery_append_failed", error, {});
      return { saved: false, fact: tagged };
    }
    evictDiscoveriesOverCap();
    return { saved: true, fact: tagged };
  };

  /**
   * Discoveries appended since the last read, advancing the cursor. Byte-offset
   * based (not line counts) so a concurrent append between read and write can
   * only ever be re-read, never skipped. A truncated or replaced file resets the
   * cursor rather than reading past the end.
   *
   * Only the unread window is read — never the whole file. A child report is
   * the caller, and the CTO files one per finished child, so a queue that a
   * runaway writer had grown must not become a full-file read per report. The
   * cursor advances by what was ACTUALLY handed out, which is what keeps a
   * backlog larger than one read drained-over-several-reports rather than
   * skipped.
   *
   * `maxChars` is a *drain* budget, not a display clip: the oldest lines that
   * fit are returned and the cursor advances over exactly those bytes, so the
   * remainder is still there for the next read. Clipping the joined text
   * instead would have destroyed it — the production caller passes no options
   * at all, so the default 1200-char budget over a 64 KB window silently ate
   * every discovery past the first three or four.
   */
  const readNewDiscoveries = (
    options: { maxChars?: number; advance?: boolean } = {},
  ): { lines: string[]; text: string } => {
    let handle: number;
    try {
      handle = fs.openSync(discoveriesPath, "r");
    } catch {
      return { lines: [], text: "" };
    }
    let fresh = "";
    let nextCursor = 0;
    let windowStart = 0;
    try {
      const size = fs.fstatSync(handle).size;
      const cursor = readDiscoveryCursor();
      const start = cursor > size ? 0 : cursor;
      nextCursor = start;
      windowStart = start;
      const window = Math.min(size - start, DISCOVERY_READ_MAX_BYTES);
      if (window > 0) {
        const buffer = Buffer.alloc(window);
        const read = fs.readSync(handle, buffer, 0, window, start);
        let slice = buffer.subarray(0, read);
        // A window that stops short of EOF almost certainly stops mid-line.
        // Rewind to the last newline inside it so a discovery is never handed
        // out in halves — and never half-skipped by the cursor either. With no
        // newline at all (a pathological single line far longer than a capped
        // discovery) the window is taken as-is, because standing still here
        // would wedge the queue permanently.
        if (start + read < size) {
          const lastBreak = slice.lastIndexOf(0x0a);
          if (lastBreak !== -1) slice = slice.subarray(0, lastBreak + 1);
        }
        fresh = slice.toString("utf8");
        nextCursor = start + slice.byteLength;
      }
    } catch (error) {
      warn("cto_memory.discovery_read_failed", error, {});
      return { lines: [], text: "" };
    } finally {
      try {
        fs.closeSync(handle);
      } catch {
        // A close failure cannot invalidate what was already read.
      }
    }
    const budget = options.maxChars ?? DISCOVERY_READ_MAX_CHARS;
    // Walk the window as raw segments (newline kept) so every kept line's byte
    // cost is known — the cursor has to land on a line boundary in the FILE,
    // and `\r\n`, the header block and blank lines all carry bytes the parsed
    // lines do not. Splitting on "\n" alone (not /\r?\n/) keeps the segments
    // byte-faithful on Windows; the trim below still normalises the text.
    const segments = fresh.split("\n").map((part, index, all) => (index < all.length - 1 ? `${part}\n` : part));
    const lines: string[] = [];
    let keptChars = 0;
    let keptBytes = 0;
    // Bytes seen since the last kept line — headers and blanks are only
    // consumed once a discovery after them is actually handed out.
    let pendingBytes = 0;
    let stoppedEarly = false;
    for (const segment of segments) {
      const bytes = Buffer.byteLength(segment, "utf8");
      const line = segment.trim();
      if (!line.startsWith("- ")) {
        pendingBytes += bytes;
        continue;
      }
      const projected = keptChars + (lines.length ? 1 : 0) + line.length;
      // Always hand out at least one line even when it alone blows the budget:
      // refusing to advance would wedge the queue on a single oversized entry.
      if (lines.length && projected > budget) {
        stoppedEarly = true;
        break;
      }
      lines.push(line);
      keptChars = projected;
      keptBytes += pendingBytes + bytes;
      pendingBytes = 0;
    }
    // Nothing was held back, so the whole window (trailing blanks included) is
    // consumed — otherwise the cursor stops right after the last kept line.
    if (!stoppedEarly) keptBytes += pendingBytes;
    if (options.advance !== false) writeDiscoveryCursor(stoppedEarly ? windowStart + keptBytes : nextCursor);
    if (!lines.length) return { lines: [], text: "" };
    // Only the single-oversized-line case can still exceed the budget here.
    return { lines, text: truncateKeepTail(lines.join("\n"), budget) };
  };

  /* ── snapshot + injection ── */

  const getSnapshot = (): CtoMemorySnapshot => {
    const dailyLogDate = todayStamp();
    const dailyLog = readFileOrEmpty(dailyPathFor(dailyLogDate));
    const updatedCandidates = [memoryPath, threadStatePath, dailyPathFor(dailyLogDate)]
      .map((filePath) => statMtimeIso(filePath))
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      memory: readMemory(),
      threadState: readThreadState(),
      dailyLog,
      dailyLogDate,
      updatedAt: updatedCandidates.length ? updatedCandidates[updatedCandidates.length - 1] : null,
    };
  };

  /**
   * Labeled memory sections for injection into the reconstruction context.
   * Only the injected copies are truncated; the on-disk files are untouched.
   */
  const buildMemoryContextSections = (): Array<{ title: string; body: string }> => {
    const sections: Array<{ title: string; body: string }> = [];
    const memory = readMemory().trim();
    if (memory.length) {
      sections.push({
        title: "Durable memory (MEMORY.md)",
        body: truncateKeepTail(memory, MEMORY_INJECT_MAX_CHARS),
      });
    }
    const threadState = readThreadState().trim();
    if (threadState.length) {
      sections.push({
        title: "Thread state",
        body: truncateKeepHead(threadState, THREAD_STATE_INJECT_MAX_CHARS),
      });
    }
    const daily = readRecentDailyEntries(2, DAILY_INJECT_MAX_CHARS).trim();
    if (daily.length) {
      sections.push({ title: "Recent daily log", body: daily });
    }
    return sections;
  };

  /**
   * The one memory section every project chat gets, not just the CTO: facts
   * tagged with the chat's own lane plus the rolling thread state. Deliberately
   * narrow — a worker needs what is known about the lane it is standing in, not
   * the CTO's whole durable memory or its daily journal.
   *
   * Returns null when there is nothing lane-scoped to say, so a worker never
   * receives an empty "here is your project memory" heading.
   */
  const buildLaneMemoryContextSection = (
    laneId: string,
  ): { title: string; body: string } | null => {
    const facts = listFactsForLane(laneId, LANE_FACTS_INJECT_MAX_CHARS).trim();
    const threadState = truncateKeepHead(readThreadState().trim(), LANE_THREAD_STATE_INJECT_MAX_CHARS).trim();
    const blocks: string[] = [];
    if (facts.length) blocks.push(["Known about this lane:", facts].join("\n"));
    if (threadState.length) blocks.push(threadState);
    if (!blocks.length) return null;
    return {
      title: "Project memory (ADE, read-only context)",
      body: blocks.join("\n\n"),
    };
  };

  return {
    readMemory,
    writeMemory,
    appendMemoryFact,
    listFactsForLane,
    writeThreadState,
    appendDailyEntry,
    appendTurnJournal,
    searchMemory,
    recordDiscovery,
    readNewDiscoveries,
    getSnapshot,
    buildMemoryContextSections,
    buildLaneMemoryContextSection,
  };
}

export type CtoMemoryService = ReturnType<typeof createCtoMemoryService>;
