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
const MEMORY_INJECT_MAX_CHARS = 8000;
const THREAD_STATE_INJECT_MAX_CHARS = 4000;
const DAILY_INJECT_MAX_CHARS = 4000;

// Hard cap on the on-disk MEMORY.md so a runaway `saveMemory` loop cannot grow
// the file without bound. Oldest facts are dropped first when the cap is hit.
const MEMORY_FILE_MAX_BYTES = 64 * 1024;

// Per-turn journal line caps (`HH:MM — user → outcome`).
const JOURNAL_USER_MAX_CHARS = 160;
const JOURNAL_OUTCOME_MAX_CHARS = 200;

// A single fact may not dominate MEMORY.md — clip before the byte-cap pass so
// one runaway `saveMemory` payload cannot evict every other fact.
const MEMORY_FACT_MAX_CHARS = 2000;

const MEMORY_HEADER = "# CTO Durable Memory";
const MEMORY_FACTS_HEADING = "## Facts";
const THREAD_STATE_HEADER = "# CTO Thread State";

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

export function createCtoMemoryService(args: CtoMemoryServiceArgs) {
  const logger = args.logger ?? null;
  const ctoDir = path.join(args.adeDir, "cto");
  const dailyDir = path.join(ctoDir, "daily");
  const memoryPath = path.join(ctoDir, "MEMORY.md");
  const threadStatePath = path.join(ctoDir, "thread-state.md");
  const memoryArchivePath = path.join(ctoDir, "memory-archive.md");

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
  const appendMemoryFact = (fact: string): { saved: boolean; fact: string; evictedCount?: number } => {
    // Memory files are plaintext on disk and re-injected into prompts: scrub
    // secret-shaped content and clip a single fact before the byte-cap pass.
    const normalized = clipText(redactSecrets(fact.replace(/\s+/g, " ").trim()), MEMORY_FACT_MAX_CHARS);
    if (!normalized.length) return { saved: false, fact: "" };
    const bullet = `- ${normalized}`;

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
      return { saved: false, fact: normalized };
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
    return { saved: true, fact: normalized, ...(evicted.length ? { evictedCount: evicted.length } : {}) };
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
    options: { limit?: number } = {},
  ): CtoMemorySearchRow[] => {
    const needle = query.trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)));
    if (!needle.length) return [];

    const rows: CtoMemorySearchRow[] = [];
    const scan = (
      file: CtoMemorySearchRow["file"],
      date: string | null,
      content: string,
    ): void => {
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (rows.length >= limit) return;
        const raw = lines[i];
        if (!raw.trim().length) continue;
        if (!raw.toLowerCase().includes(needle)) continue;
        rows.push({ file, date, line: i + 1, snippet: raw.trim().slice(0, 240) });
      }
    };

    // Durable facts first — current then archived — before any transient
    // content (rolling thread summary, daily journals), so evicted memories
    // are never starved out of the result budget.
    scan("MEMORY.md", null, readMemory());
    if (rows.length < limit) scan("memory-archive.md", null, readFileOrEmpty(memoryArchivePath));
    if (rows.length < limit) scan("thread-state.md", null, readThreadState());
    if (rows.length < limit) {
      for (const stamp of listDailyStampsNewestFirst()) {
        if (rows.length >= limit) break;
        scan("daily", stamp, readFileOrEmpty(dailyPathFor(stamp)));
      }
    }
    return rows;
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

  return {
    readMemory,
    writeMemory,
    appendMemoryFact,
    writeThreadState,
    appendDailyEntry,
    appendTurnJournal,
    searchMemory,
    getSnapshot,
    buildMemoryContextSections,
  };
}

export type CtoMemoryService = ReturnType<typeof createCtoMemoryService>;
