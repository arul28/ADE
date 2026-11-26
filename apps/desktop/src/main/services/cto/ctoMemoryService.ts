import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CTO_OPEN_WORK_MAX_DONE,
  CTO_OPEN_WORK_MAX_OPEN,
  CTO_PROJECT_NOTES_MAX_BYTES,
  CTO_RULES_MAX_BYTES,
  CTO_USER_NOTES_MAX_BYTES,
  type CtoMemorySnapshot,
  type CtoNotesFile,
  type CtoNotesScope,
  type CtoOpenWorkItem,
  type CtoUpdateOpenWorkArgs,
} from "../../../shared/types/cto";
import { AdeExpectedError } from "../../../shared/expectedError";
import { clipText, nowIso, redactSecrets, writeTextAtomic } from "../shared/utils";
import { resolveAdeHomeForOwnership } from "../chat/chatRuntimeOwnership";
import type { CtoStoryRecord } from "./ctoStory";
import { createCtoLearningService } from "./ctoLearningService";
import {
  assertBaseHash,
  CTO_MEMORY_TAG_KEYS,
  matchLines,
  noteSimilarity,
  oneNoteLine,
  parseNoteLines,
  readFileOrEmpty,
  stripBullet,
  textHash,
  utf8Bytes,
  type CtoMemoryTags,
} from "./ctoNoteText";

export { CTO_MEMORY_TAG_KEYS, noteSimilarity, type CtoMemoryTagKey, type CtoMemoryTags } from "./ctoNoteText";

type Logger = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
};

type CtoMemoryServiceArgs = {
  /** The project's `.ade` directory (same value ctoStateService receives). */
  adeDir: string;
  /**
   * Where the machine-wide notes about the person live (`USER.md`). Defaults to
   * `<ADE home>/cto`, shared by the CTO of every project on this machine.
   */
  userNotesDir?: string | null;
  logger?: Logger | null;
  /** After notes or open work change, e.g. so the account copy is saved again. */
  onChanged?: (() => void) | null;
};

/*
 * The CTO's memory is two short notes files and an open-work list, all
 * injected on every turn:
 *
 * - `.ade/cto/MEMORY.md`: facts about this project, one `- ` line each.
 * - `<ADE home>/cto/USER.md`: facts about the person, for every project.
 * - `.ade/cto/open-work.json`: what the CTO has started and not finished.
 *
 * The notes are capped in bytes so the per-turn prefix stays small and the
 * CTO has to keep them tidy: a `remember` past the cap is refused, and the
 * CTO merges or forgets notes to make room. Nothing here runs a model.
 *
 * `discoveries.md` is a separate channel: any agent may append a finding, and
 * the CTO drains the new ones on each child report and decides what becomes a
 * note.
 */

const NOTE_MAX_CHARS = 400;
const OPEN_WORK_TEXT_MAX_CHARS = 300;
const OPEN_WORK_OUTCOME_MAX_CHARS = 120;
/** Done items shown in the injected list, newest first. */
const OPEN_WORK_INJECTED_DONE = 5;
/** A new note this close to an existing one is the same note said again. */
const NEAR_DUPLICATE_SIMILARITY = 0.8;
/** How many candidate lines an ambiguous `replaces`/`forget` lists back. */
const MATCH_CANDIDATES_SHOWN = 8;

// The discovery queue. Any agent can append to it, so it carries its own cap
// and an append-only archive; the CTO drains it through a byte cursor.
const DISCOVERY_READ_MAX_CHARS = 1200;
const DISCOVERY_FACT_MAX_CHARS = 400;
const DISCOVERIES_FILE_MAX_BYTES = 128 * 1024;
const DISCOVERY_READ_MAX_BYTES = 64 * 1024;
const DISCOVERIES_HEADER = "# Worker discoveries (unreviewed — the CTO decides which become notes)";
const DISCOVERIES_HEADER_BLOCK = `${DISCOVERIES_HEADER}\n\n`;

/** Marker that the one-time reset from the v1 memory files has run. */
const V2_MIGRATION_MARKER = ".v2-migrated";
const LEGACY_DIR = "legacy-v1";
/** v1 files and folders that are moved into `legacy-v1/`, never deleted. */
const LEGACY_ENTRIES = [
  "context-store.json",
  "thread-state.md",
  "daily",
  "memory-archive.md",
  "CURRENT.md",
  "sessions.jsonl",
];

/* ── Tags (discoveries) ── */

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

/** `.ade/cto/story.json` exists but is not a story this build can read. */
export class CtoStoryUnreadableError extends Error {
  constructor(detail: string) {
    super(`The CTO's story file can't be read: ${detail}`);
    this.name = "CtoStoryUnreadableError";
  }
}

/* ── Helpers ── */

function statMtimeIso(filePath: string): string | null {
  try {
    return new Date(fs.statSync(filePath).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

/** One note's text: one line, no bullet, secret-scrubbed, clipped. */
function normalizeNote(raw: string): string {
  return oneNoteLine(raw, NOTE_MAX_CHARS);
}

function renderNotes(lines: readonly string[]): string {
  return lines.length ? `${lines.map((line) => `- ${line}`).join("\n")}\n` : "";
}

function notesFullMessage(bytes: number, limit: number): string {
  return `Notes are full (${bytes} of ${limit} bytes). Merge or forget notes first.`;
}

function newWorkId(): string {
  return `w-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function normalizeOpenWorkItem(value: unknown): CtoOpenWorkItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!id || !text) return null;
  const createdAt = typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt : nowIso();
  const doneAt = typeof record.doneAt === "string" && record.doneAt.trim() ? record.doneAt : null;
  return { id, text, createdAt, doneAt, addedBy: record.addedBy === "user" ? "user" : "cto" };
}

/** Open items oldest first (a checklist), then finished ones newest first. */
function orderOpenWork(items: readonly CtoOpenWorkItem[]): CtoOpenWorkItem[] {
  const open = items.filter((item) => !item.doneAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const done = items.filter((item) => item.doneAt).sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  return [...open, ...done];
}

/** A move that never loses the source: an existing target gets a stamped name. */
function moveAside(source: string, targetDir: string): void {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  const base = path.basename(source);
  let target = path.join(targetDir, base);
  if (fs.existsSync(target)) target = path.join(targetDir, `${base}.${Date.now()}`);
  try {
    fs.renameSync(source, target);
  } catch {
    // Windows refuses a rename across volumes or of a held folder: copy, then
    // remove the source only once the copy is complete.
    fs.cpSync(source, target, { recursive: true, errorOnExist: false });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

export type CtoRememberResult =
  | { ok: true; saved: true; note: string; replaced?: string; scope: CtoNotesScope; bytes: number; limitBytes: number }
  | { ok: true; saved: false; note: string; duplicateOf: string; scope: CtoNotesScope }
  | { ok: false; error: string; candidates?: string[] };

export type CtoForgetResult =
  | { ok: true; forgotten: string; scope: CtoNotesScope }
  | { ok: false; error: string; candidates?: string[] };

export type CtoOpenWorkResult =
  | { ok: true; item: CtoOpenWorkItem }
  | { ok: false; error: string };

export function createCtoMemoryService(args: CtoMemoryServiceArgs) {
  const logger = args.logger ?? null;
  const ctoDir = path.join(args.adeDir, "cto");
  const memoryPath = path.join(ctoDir, "MEMORY.md");
  const openWorkPath = path.join(ctoDir, "open-work.json");
  const storyPath = path.join(ctoDir, "story.json");
  const discoveriesPath = path.join(ctoDir, "discoveries.md");
  const discoveriesArchivePath = path.join(ctoDir, "discoveries-archive.md");
  const discoveriesCursorPath = path.join(ctoDir, "discoveries.cursor");
  const userNotesDir = (): string => args.userNotesDir?.trim() || path.join(resolveAdeHomeForOwnership(), "cto");
  const userNotesPath = (): string => path.join(userNotesDir(), "USER.md");

  fs.mkdirSync(ctoDir, { recursive: true });

  // Rules, skills and the per-turn learning journal (`ctoLearningService.ts`).
  const learning = createCtoLearningService({
    ctoDir,
    projectNotesPath: memoryPath,
    userNotesPath,
    logger,
    onChanged: () => args.onChanged?.(),
  });
  const notesArea = (scope: CtoNotesScope) => (scope === "user" ? "user_notes" as const : "project_notes" as const);

  const warn = (message: string, error: unknown, meta?: Record<string, unknown>): void => {
    logger?.warn(message, {
      ...(meta ?? {}),
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const notesPath = (scope: CtoNotesScope): string => (scope === "user" ? userNotesPath() : memoryPath);
  const notesLimit = (scope: CtoNotesScope): number =>
    scope === "user" ? CTO_USER_NOTES_MAX_BYTES : CTO_PROJECT_NOTES_MAX_BYTES;

  /* ── Notes ── */

  const readNotes = (scope: CtoNotesScope): string => readFileOrEmpty(notesPath(scope));
  const readNoteLines = (scope: CtoNotesScope): string[] => parseNoteLines(readNotes(scope));

  const writeNoteLines = (scope: CtoNotesScope, lines: readonly string[]): number => {
    const rendered = renderNotes(lines);
    writeTextAtomic(notesPath(scope), rendered);
    args.onChanged?.();
    return utf8Bytes(rendered);
  };

  /**
   * Replace a whole notes file, one note per line (bullets optional). Over the
   * cap is refused with the same sentence the CTO's `remember` gets.
   *
   * `baseHash` is the hash of the text the editor started from. When it no
   * longer matches the file (the CTO wrote a note, another device saved), the
   * write is refused rather than silently overwriting what changed.
   */
  const writeNotes = (scope: CtoNotesFile, text: string, options?: { baseHash?: string | null }): void => {
    if (scope === "rules") {
      learning.writeRulesText(text, options);
      return;
    }
    assertBaseHash(readNotes(scope), options?.baseHash);
    const lines = parseNoteLines(text).map(normalizeNote).filter((line) => line.length > 0);
    const bytes = utf8Bytes(renderNotes(lines));
    const limit = notesLimit(scope);
    if (bytes > limit) throw new AdeExpectedError(notesFullMessage(bytes, limit), "user");
    writeNoteLines(scope, lines);
    // The person's (or an account copy's) version: never something the CTO learned.
    learning.personWrote(notesArea(scope));
  };

  const remember = (input: {
    note: string;
    scope?: CtoNotesScope;
    replaces?: string | null;
    /** The person asked for this again after undoing it. */
    personAskedAgain?: boolean;
  }): CtoRememberResult => {
    const scope = input.scope ?? "project";
    const note = normalizeNote(input.note);
    if (!note.length) return { ok: false, error: "The note is empty." };
    const lines = readNoteLines(scope);
    const replaces = input.replaces?.trim() ? stripBullet(input.replaces) : null;
    let next: string[];
    let replaced: string | undefined;
    if (replaces) {
      const matches = matchLines(lines, replaces);
      if (matches.length !== 1) {
        const candidates = matches.length
          ? matches.map((index) => lines[index]).slice(0, MATCH_CANDIDATES_SHOWN)
          : lines.slice(0, MATCH_CANDIDATES_SHOWN);
        return {
          ok: false,
          error: matches.length
            ? `${matches.length} notes contain "${replaces}". Pass more of the line you mean.`
            : `No note contains "${replaces}".`,
          candidates,
        };
      }
      replaced = lines[matches[0]];
      next = lines.map((line, index) => (index === matches[0] ? note : line));
    } else {
      const duplicate = lines.find((line) => line.toLowerCase() === note.toLowerCase())
        ?? lines.find((line) => noteSimilarity(line, note) >= NEAR_DUPLICATE_SIMILARITY);
      if (duplicate) return { ok: true, saved: false, note, duplicateOf: duplicate, scope };
      next = [...lines, note];
    }
    if (!input.personAskedAgain) {
      const refusal = learning.undoneRefusal(notesArea(scope), "write", note);
      if (refusal) return { ok: false, error: refusal };
    }
    const limit = notesLimit(scope);
    const bytes = utf8Bytes(renderNotes(next));
    if (bytes > limit) {
      return { ok: false, error: notesFullMessage(utf8Bytes(renderNotes(lines)), limit) };
    }
    writeNoteLines(scope, next);
    if (scope === "user") learning.ctoWroteUserNotes(replaced ? [note, replaced] : [note]);
    return { ok: true, saved: true, note, ...(replaced ? { replaced } : {}), scope, bytes, limitBytes: limit };
  };

  const forget = (input: { note: string; scope?: CtoNotesScope; personAskedAgain?: boolean }): CtoForgetResult => {
    const scope = input.scope ?? "project";
    const needle = stripBullet(input.note);
    if (!needle.length) return { ok: false, error: "Say which note to forget." };
    const lines = readNoteLines(scope);
    const matches = matchLines(lines, needle);
    if (matches.length !== 1) {
      return {
        ok: false,
        error: matches.length
          ? `${matches.length} notes contain "${needle}". Pass more of the line you mean.`
          : `No note contains "${needle}".`,
        candidates: (matches.length ? matches.map((index) => lines[index]) : lines).slice(0, MATCH_CANDIDATES_SHOWN),
      };
    }
    const forgotten = lines[matches[0]];
    if (!input.personAskedAgain) {
      const refusal = learning.undoneRefusal(notesArea(scope), "remove", forgotten);
      if (refusal) return { ok: false, error: refusal };
    }
    writeNoteLines(scope, lines.filter((_, index) => index !== matches[0]));
    if (scope === "user") learning.ctoWroteUserNotes([forgotten]);
    return { ok: true, forgotten, scope };
  };

  /* ── Open work ── */

  const readOpenWork = (): CtoOpenWorkItem[] => {
    const raw = readFileOrEmpty(openWorkPath);
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw) as { items?: unknown };
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      return orderOpenWork(items.map(normalizeOpenWorkItem).filter((item): item is CtoOpenWorkItem => item != null));
    } catch (error) {
      // Moved aside, not left to be overwritten: the next write would replace
      // the only copy of the list, and a hand edit gone wrong is worth reading.
      const asidePath = `${openWorkPath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(openWorkPath, asidePath);
        warn("cto_memory.open_work_unreadable", error, { movedTo: asidePath });
      } catch (renameError) {
        warn("cto_memory.open_work_unreadable", error, {
          moveFailed: renameError instanceof Error ? renameError.message : String(renameError),
        });
      }
      return [];
    }
  };

  const writeOpenWork = (items: readonly CtoOpenWorkItem[]): void => {
    const ordered = orderOpenWork(items);
    // Finished items past the cap go oldest first; open ones are never dropped.
    const open = ordered.filter((item) => !item.doneAt);
    const done = ordered.filter((item) => item.doneAt).slice(0, CTO_OPEN_WORK_MAX_DONE);
    writeTextAtomic(openWorkPath, `${JSON.stringify({ version: 1, items: [...open, ...done] }, null, 2)}\n`);
    args.onChanged?.();
  };

  /** The open-work file as it is on disk, for the account copy; null when there is none. */
  const readOpenWorkText = (): string | null => {
    try {
      return fs.readFileSync(openWorkPath, "utf8");
    } catch {
      return null;
    }
  };

  /** Puts a copy's open-work file in place; null removes this machine's list. */
  const replaceOpenWorkText = (text: string | null): void => {
    if (text == null) {
      fs.rmSync(openWorkPath, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(openWorkPath), { recursive: true });
    writeTextAtomic(openWorkPath, text);
  };

  /**
   * The story so far (`ctoStory.ts`): a summary of the conversation older
   * than what a fresh thread carries word for word. Null when there is none.
   * Throws `CtoStoryUnreadableError` when the file is there but can't be read
   * (a lock, a truncated write, a newer format): the caller must not take
   * that for "no story" and write a new one over it.
   */
  const readStory = (): CtoStoryRecord | null => {
    let raw: string;
    try {
      raw = fs.readFileSync(storyPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw new CtoStoryUnreadableError(error instanceof Error ? error.message : String(error));
    }
    if (!raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<CtoStoryRecord>;
      if (parsed?.v !== 1 || typeof parsed.summary !== "string" || typeof parsed.coveredThrough !== "string") {
        throw new Error(`not a version 1 story (v=${String(parsed?.v)})`);
      }
      const carried = parsed.carried && typeof parsed.carried.text === "string" && parsed.carried.text.trim()
        ? { fromName: typeof parsed.carried.fromName === "string" ? parsed.carried.fromName : "another computer", text: parsed.carried.text }
        : null;
      return {
        v: 1,
        summary: parsed.summary,
        coveredThrough: parsed.coveredThrough,
        startsAt: typeof parsed.startsAt === "string" ? parsed.startsAt : parsed.coveredThrough,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : parsed.coveredThrough,
        model: typeof parsed.model === "string" ? parsed.model : null,
        ...(carried ? { carried } : {}),
        ...(typeof parsed.movedAt === "string" ? { movedAt: parsed.movedAt } : {}),
        ...(parsed.movedFrom && typeof parsed.movedFrom.coveredThrough === "string"
          ? { movedFrom: { coveredThrough: parsed.movedFrom.coveredThrough } }
          : {}),
      };
    } catch (error) {
      throw new CtoStoryUnreadableError(error instanceof Error ? error.message : String(error));
    }
  };

  /** Writes the story; null removes it. Secrets in it are redacted. */
  const writeStory = (record: CtoStoryRecord | null): void => {
    if (record == null) {
      fs.rmSync(storyPath, { force: true });
    } else {
      fs.mkdirSync(path.dirname(storyPath), { recursive: true });
      const clean: CtoStoryRecord = {
        ...record,
        summary: redactSecrets(record.summary),
        ...(record.carried ? { carried: { ...record.carried, text: redactSecrets(record.carried.text) } } : {}),
      };
      writeTextAtomic(storyPath, `${JSON.stringify(clean, null, 2)}\n`);
    }
    args.onChanged?.();
  };

  const trackWork = (text: string, addedBy: CtoOpenWorkItem["addedBy"] = "cto"): CtoOpenWorkResult => {
    const normalized = clipText(redactSecrets(text.replace(/\s+/g, " ").trim()), OPEN_WORK_TEXT_MAX_CHARS);
    if (!normalized.length) return { ok: false, error: "Say what the work is." };
    const items = readOpenWork();
    if (items.filter((item) => !item.doneAt).length >= CTO_OPEN_WORK_MAX_OPEN) {
      return { ok: false, error: `Open work is full (${CTO_OPEN_WORK_MAX_OPEN} items). Finish or remove one first.` };
    }
    const existingIds = new Set(items.map((item) => item.id));
    let id = newWorkId();
    while (existingIds.has(id)) id = newWorkId();
    const item: CtoOpenWorkItem = { id, text: normalized, createdAt: nowIso(), doneAt: null, addedBy };
    writeOpenWork([...items, item]);
    return { ok: true, item };
  };

  const updateItem = (
    id: string,
    change: (item: CtoOpenWorkItem) => CtoOpenWorkItem | null,
  ): CtoOpenWorkResult => {
    const key = id.trim();
    const items = readOpenWork();
    const current = items.find((item) => item.id === key);
    if (!current) return { ok: false, error: `No open-work item has id "${key}".` };
    const updated = change(current);
    if (!updated) return { ok: false, error: `Item "${key}" cannot change that way.` };
    writeOpenWork(items.map((item) => (item.id === key ? updated : item)));
    return { ok: true, item: updated };
  };

  const finishWork = (id: string, outcome?: string | null): CtoOpenWorkResult =>
    updateItem(id, (item) => {
      if (item.doneAt) return item;
      const note = outcome?.replace(/\s+/g, " ").trim();
      return {
        ...item,
        text: note ? `${item.text} (${clipText(redactSecrets(note), OPEN_WORK_OUTCOME_MAX_CHARS)})` : item.text,
        doneAt: nowIso(),
      };
    });

  const reopenWork = (id: string): CtoOpenWorkResult => {
    if (readOpenWork().filter((item) => !item.doneAt).length >= CTO_OPEN_WORK_MAX_OPEN) {
      return { ok: false, error: `Open work is full (${CTO_OPEN_WORK_MAX_OPEN} items). Finish or remove one first.` };
    }
    return updateItem(id, (item) => ({ ...item, doneAt: null }));
  };

  const removeWork = (id: string): CtoOpenWorkResult => {
    const key = id.trim();
    const items = readOpenWork();
    const current = items.find((item) => item.id === key);
    if (!current) return { ok: false, error: `No open-work item has id "${key}".` };
    writeOpenWork(items.filter((item) => item.id !== key));
    return { ok: true, item: current };
  };

  /** The settings and panel path: the person's own edits to the list. */
  const updateOpenWork = (change: CtoUpdateOpenWorkArgs): void => {
    const result = change.op === "add"
      ? trackWork(change.text, "user")
      : change.op === "complete"
        ? finishWork(change.id)
        : change.op === "reopen"
          ? reopenWork(change.id)
          : removeWork(change.id);
    if (!result.ok) throw new AdeExpectedError(result.error, "user");
  };

  /* ── Discoveries ── */

  const readDiscoveryCursor = (): number => {
    const parsed = Number.parseInt(readFileOrEmpty(discoveriesCursorPath).trim(), 10);
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
   * Hold discoveries.md under its cap by moving the OLDEST entries to the
   * append-only archive. The read cursor is a byte offset into this file, so
   * it is rewound by exactly the bytes removed (clamped at 0: a discovery may
   * be delivered twice, never skipped).
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
      const trailing = entries.length && entries[entries.length - 1] === "" ? entries.pop() : null;
      const evicted: string[] = [];
      const render = (): string => `${header}${entries.join("\n")}${trailing === null ? "" : "\n"}`;
      let rendered = render();
      while (utf8Bytes(rendered) > DISCOVERIES_FILE_MAX_BYTES && entries.length > 1) {
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
      const removed = buffer.byteLength - utf8Bytes(rendered);
      writeTextAtomic(discoveriesPath, rendered);
      const cursor = readDiscoveryCursor();
      if (cursor > 0) writeDiscoveryCursor(cursor - removed);
    } catch (error) {
      warn("cto_memory.discovery_evict_failed", error, {});
    }
  };

  /**
   * The worker-to-CTO channel. Any agent may append a discovery; the CTO
   * drains the new ones on each child report and decides what becomes a note.
   */
  const recordDiscovery = (
    fact: string,
    tags?: CtoMemoryTags | null,
    now = new Date(),
  ): { saved: boolean; fact: string } => {
    const normalized = clipText(redactSecrets(fact.replace(/\s+/g, " ").trim()), DISCOVERY_FACT_MAX_CHARS);
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
   * Discoveries appended since the last read, advancing the cursor. Only the
   * unread window is read, and the cursor moves by exactly what was handed out,
   * so a backlog larger than one read drains over several reports. `maxChars`
   * is a drain budget: at least one line is always handed out so a single
   * oversized entry cannot wedge the queue.
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
    // Raw segments (newline kept) so the cursor lands on a byte boundary in the
    // file; splitting on "\n" alone keeps `\r\n` files byte-faithful.
    const segments = fresh.split("\n").map((part, index, all) => (index < all.length - 1 ? `${part}\n` : part));
    const lines: string[] = [];
    let keptChars = 0;
    let keptBytes = 0;
    let pendingBytes = 0;
    let stoppedEarly = false;
    for (const segment of segments) {
      const bytes = utf8Bytes(segment);
      const line = segment.trim();
      if (!line.startsWith("- ")) {
        pendingBytes += bytes;
        continue;
      }
      const projected = keptChars + (lines.length ? 1 : 0) + line.length;
      if (lines.length && projected > budget) {
        stoppedEarly = true;
        break;
      }
      lines.push(line);
      keptChars = projected;
      keptBytes += pendingBytes + bytes;
      pendingBytes = 0;
    }
    if (!stoppedEarly) keptBytes += pendingBytes;
    if (options.advance !== false) writeDiscoveryCursor(stoppedEarly ? windowStart + keptBytes : nextCursor);
    if (!lines.length) return { lines: [], text: "" };
    const joined = lines.join("\n");
    const text = joined.length > budget ? `…(older content truncated)\n${joined.slice(joined.length - budget)}` : joined;
    return { lines, text };
  };

  /* ── Snapshot and injection ── */

  const getSnapshot = (): CtoMemorySnapshot => {
    const memory = readNotes("project");
    const userNotes = readNotes("user");
    const updatedCandidates = [statMtimeIso(memoryPath), statMtimeIso(userNotesPath()), statMtimeIso(openWorkPath)]
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      memory,
      memoryBytes: utf8Bytes(memory),
      memoryLimitBytes: CTO_PROJECT_NOTES_MAX_BYTES,
      userNotes,
      userNotesBytes: utf8Bytes(userNotes),
      userNotesLimitBytes: CTO_USER_NOTES_MAX_BYTES,
      memoryHash: textHash(memory),
      userNotesHash: textHash(userNotes),
      openWork: readOpenWork(),
      rules: learning.readRules(),
      rulesBytes: utf8Bytes(learning.readRules()),
      rulesLimitBytes: CTO_RULES_MAX_BYTES,
      rulesHash: learning.rulesHash(),
      skills: learning.listSkills(),
      updatedAt: updatedCandidates.length ? updatedCandidates[updatedCandidates.length - 1] : null,
    };
  };

  /**
   * The memory half of the CTO's per-turn context: project notes, notes about
   * the person, and open work. Rebuilt on every turn; each title carries the
   * byte count so the CTO can see how close to the cap it is.
   */
  const buildMemoryContextSections = (): Array<{ title: string; body: string }> => {
    const project = readNotes("project").trim();
    const user = readNotes("user").trim();
    const items = readOpenWork();
    const open = items.filter((item) => !item.doneAt);
    const done = items.filter((item) => item.doneAt).slice(0, OPEN_WORK_INJECTED_DONE);
    const workLines = [
      ...open.map((item) => `- [ ] ${item.id}: ${item.text}`),
      ...done.map((item) => `- [x] ${item.id}: ${item.text} (done)`),
    ];
    return [
      ...learning.buildContextSections(),
      {
        title: `## Notes (project) — ${utf8Bytes(readNotes("project"))} of ${CTO_PROJECT_NOTES_MAX_BYTES} bytes`,
        body: project || "(none yet)",
      },
      {
        title: `## Notes about the person — ${utf8Bytes(readNotes("user"))} of ${CTO_USER_NOTES_MAX_BYTES} bytes`,
        body: user || "(none yet)",
      },
      {
        title: "## Open work",
        body: workLines.length ? workLines.join("\n") : "(nothing open)",
      },
    ];
  };

  /* ── One-time reset from the v1 files ── */

  /**
   * CTO v2 starts clean: the v1 files (and a v1 MEMORY.md) move into
   * `legacy-v1/` untouched, nothing is imported. Runs once per project, keyed
   * on the marker file.
   */
  const resetFromV1 = (): void => {
    const markerPath = path.join(ctoDir, V2_MIGRATION_MARKER);
    if (fs.existsSync(markerPath)) return;
    const legacyDir = path.join(ctoDir, LEGACY_DIR);
    try {
      const entries = fs.existsSync(ctoDir) ? fs.readdirSync(ctoDir) : [];
      const hasV1 = entries.some((entry) => LEGACY_ENTRIES.includes(entry) || entry.startsWith("context-store.json"));
      for (const entry of entries) {
        const isLegacy = LEGACY_ENTRIES.includes(entry) || entry.startsWith("context-store.json")
          || (hasV1 && entry === "MEMORY.md");
        if (!isLegacy) continue;
        try {
          moveAside(path.join(ctoDir, entry), legacyDir);
        } catch (error) {
          warn("cto_memory.reset_move_failed", error, { entry });
        }
      }
      fs.mkdirSync(ctoDir, { recursive: true });
      writeTextAtomic(markerPath, `${nowIso()}\n`);
      if (hasV1) logger?.info?.("cto_memory.reset_from_v1", { movedTo: LEGACY_DIR });
    } catch (error) {
      warn("cto_memory.reset_failed", error);
    }
  };

  resetFromV1();

  return {
    readNotes,
    writeNotes,
    remember,
    forget,
    readOpenWork,
    readOpenWorkText,
    replaceOpenWorkText,
    readStory,
    writeStory,
    trackWork,
    finishWork,
    updateOpenWork,
    recordDiscovery,
    readNewDiscoveries,
    getSnapshot,
    buildMemoryContextSections,
    readRules: learning.readRules,
    readUndone: learning.readUndone,
    replaceUndone: learning.replaceUndone,
    addRule: learning.addRule,
    removeRule: learning.removeRule,
    listSkills: learning.listSkills,
    readSkill: learning.readSkill,
    saveSkill: learning.saveSkill,
    writeSkillText: learning.writeSkillText,
    deleteSkill: learning.deleteSkill,
    deleteSkillAsPerson: learning.deleteSkillAsPerson,
    beginLearningTurn: learning.beginTurn,
    finishLearningTurn: learning.finishTurn,
    undoLearned: learning.undo,
  };
}

export type CtoMemoryService = ReturnType<typeof createCtoMemoryService>;
