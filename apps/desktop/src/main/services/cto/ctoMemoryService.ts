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
  type CtoOpenWorkLink,
  type CtoOpenWorkOwner,
  type CtoUpdateOpenWorkArgs,
} from "../../../shared/types/cto";
import { linkedWorkOutcome, normalizeOpenWorkLink, type CtoLinkedWorkResolver } from "./ctoOpenWorkLinks";

export type { CtoLinkedWorkResolver } from "./ctoOpenWorkLinks";
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
import { createCtoMemoryArchive, ctoNoteKey, type CtoArchiveRecord, type CtoMemoryArchive } from "./ctoMemoryArchive";
import { coldestFirst, createCtoMemoryArchiveOps, discoveryRecords } from "./ctoMemoryArchiveOps";

export type { CtoStoryFactRecord } from "./ctoMemoryArchiveOps";

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
  /** Linked work items closed themselves (their chat or PR finished). */
  onLinkedWorkClosed?: ((count: number) => void) | null;
  /** The archive store; defaults to `.ade/cto/archive.db` (`ctoMemoryArchive.ts`). */
  archive?: CtoMemoryArchive | null;
};

/*
 * The CTO's memory is two short notes files and an open-work list, all
 * injected on every turn:
 *
 * - `.ade/cto/MEMORY.md`: facts about this project, one `- ` line each.
 * - `<ADE home>/cto/USER.md`: facts about the person, for every project.
 * - `.ade/cto/open-work.json`: what the CTO has started and not finished.
 *
 * The notes are capped in bytes so the per-turn prefix stays small. They are
 * the pinned tier: a `remember` past the project cap moves the coldest
 * project notes (least recently written, said again or recalled) to the
 * archive (`ctoMemoryArchive.ts`), and `recallArchived` brings one back.
 * Without an archive on this machine, and always for the notes about the
 * person, the write is refused instead, so nothing is lost.
 * Nothing here runs a model.
 *
 * The archive also keeps every replaced or forgotten note, every story
 * version, the facts story folds pull out, and every discovery once drained.
 *
 * `discoveries.md` is a separate channel: any agent may append a finding, and
 * the CTO drains the new ones on each child report and decides what becomes a
 * note.
 */

const NOTE_MAX_CHARS = 400;
const OPEN_WORK_TEXT_MAX_CHARS = 300;
const OPEN_WORK_OUTCOME_MAX_CHARS = 120;
const OPEN_WORK_TITLE_MAX_CHARS = 60;
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

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOpenWorkItem(value: unknown): CtoOpenWorkItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!id || !text) return null;
  const createdAt = typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt : nowIso();
  const doneAt = typeof record.doneAt === "string" && record.doneAt.trim() ? record.doneAt : null;
  const title = optionalText(record.title);
  const link = normalizeOpenWorkLink(record.link);
  const outcome = optionalText(record.outcome);
  const closedBy = record.closedBy === "auto" || record.closedBy === "user" || record.closedBy === "cto" ? record.closedBy : null;
  return {
    id,
    text,
    createdAt,
    doneAt,
    addedBy: record.addedBy === "user" ? "user" : "cto",
    ...(title ? { title } : {}),
    ...(record.owner === "user" || record.owner === "cto" ? { owner: record.owner } : {}),
    ...(link ? { link } : {}),
    ...(outcome ? { outcome } : {}),
    ...(closedBy ? { closedBy } : {}),
  };
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
  | {
    ok: true;
    saved: true;
    note: string;
    replaced?: string;
    scope: CtoNotesScope;
    bytes: number;
    limitBytes: number;
    /** Colder notes moved to the archive to make room. */
    archived?: string[];
  }
  | { ok: true; saved: false; note: string; duplicateOf: string; scope: CtoNotesScope }
  | { ok: false; error: string; candidates?: string[] };

export type CtoForgetResult =
  | { ok: true; forgotten: string; scope: CtoNotesScope }
  | { ok: false; error: string; candidates?: string[] };

export type CtoOpenWorkResult =
  | { ok: true; item: CtoOpenWorkItem }
  | { ok: false; error: string };

/** A write that needed the archive to keep a note, when the archive write failed. */
const NOT_ARCHIVED_ERROR = "Couldn't save to the archive, so the notes did not change. Try again.";

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
  // Opened on first use, not here: building the service is on the boot path.
  const archive: CtoMemoryArchive | null = args.archive === undefined
    ? createCtoMemoryArchive({ dir: ctoDir, logger })
    : args.archive;

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
   * Moves the coldest of `lines` to the archive until the rest fit the cap,
   * never one at an index in `keep`. A refusal writes nothing, so nothing is
   * lost: "full" when they can't be made to fit (no archive, or the kept lines
   * alone are too long), "not_archived" when the archive write failed.
   *
   * Only project notes move out. The notes about the person are shared by
   * every project, and the archive belongs to one: a note moved into it would
   * leave every other project's CTO without it.
   *
   * `alsoArchive` (the old line a write replaces) goes in the same
   * transaction, so the write is refused when it can't be kept. With no
   * archive on this machine it is dropped, as before there was one.
   */
  const evictToFit = (
    scope: CtoNotesScope,
    lines: readonly string[],
    keep: ReadonlySet<number>,
    alsoArchive: readonly CtoArchiveRecord[] = [],
  ): { kept: string[]; archived: string[]; bytes: number } | "full" | "not_archived" => {
    const limit = notesLimit(scope);
    let bytes = utf8Bytes(renderNotes(lines));
    const drop = new Set<number>();
    if (bytes > limit) {
      if (scope === "user" || !archive?.available()) return "full";
      for (const index of coldestFirst(lines, archive.noteHeat(scope), keep)) {
        if (bytes <= limit) break;
        drop.add(index);
        bytes = utf8Bytes(renderNotes(lines.filter((_, kept) => !drop.has(kept))));
      }
      if (bytes > limit) return "full";
    }
    const archived = [...drop].map((index) => lines[index]!);
    const records = [...alsoArchive, ...archived.map((text): CtoArchiveRecord => ({ kind: "note", scope, text, reason: "cold" }))];
    // One transaction: all of them reach the archive, or none and the write is refused.
    if (records.length && archive?.available() && archive.addMany(records) == null) return "not_archived";
    return { kept: lines.filter((_, index) => !drop.has(index)), archived, bytes };
  };

  /**
   * Replace a whole notes file, one note per line (bullets optional). Over the
   * cap, the coldest of the lines that were already there move to the archive,
   * as for the CTO's `remember`; a line the person just wrote never does. With
   * no archive, or when the new lines alone are over the cap, the write is
   * refused with the same sentence `remember` gets.
   *
   * `baseHash` is the hash of the text the editor started from. When it no
   * longer matches the file (the CTO wrote a note, another device saved), the
   * write is refused rather than silently overwriting what changed.
   *
   * Returns the notes moved to the archive to make room.
   */
  const writeNotes = (scope: CtoNotesFile, text: string, options?: { baseHash?: string | null }): { archived: string[] } => {
    if (scope === "rules") {
      learning.writeRulesText(text, options);
      return { archived: [] };
    }
    const before = readNotes(scope);
    assertBaseHash(before, options?.baseHash);
    const lines = parseNoteLines(text).map(normalizeNote).filter((line) => line.length > 0);
    const had = new Set(readNoteLines(scope).map(ctoNoteKey));
    const typed = new Set(lines.flatMap((line, index) => (had.has(ctoNoteKey(line)) ? [] : [index])));
    const fit = evictToFit(scope, lines, typed);
    if (fit === "full") throw new AdeExpectedError(notesFullMessage(utf8Bytes(renderNotes(lines)), notesLimit(scope)), "user");
    if (fit === "not_archived") throw new AdeExpectedError(NOT_ARCHIVED_ERROR, "user");
    writeNoteLines(scope, fit.kept);
    // The person's (or an account copy's) version: never something the CTO learned.
    learning.personWrote(notesArea(scope), before);
    // A line the person just wrote is not cold, wherever it sits in the file.
    for (const index of typed) archive?.touchNote(scope, lines[index]!);
    return { archived: fit.archived };
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
    let noteIndex: number;
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
      noteIndex = matches[0];
      next = lines.map((line, index) => (index === matches[0] ? note : line));
    } else {
      const duplicate = lines.find((line) => line.toLowerCase() === note.toLowerCase())
        ?? lines.find((line) => noteSimilarity(line, note) >= NEAR_DUPLICATE_SIMILARITY);
      if (duplicate) {
        // Said again: the note is in use, so it is not cold.
        archive?.touchNote(scope, duplicate);
        return { ok: true, saved: false, note, duplicateOf: duplicate, scope };
      }
      noteIndex = lines.length;
      next = [...lines, note];
    }
    if (!input.personAskedAgain) {
      // A replace also removes the old note: the person may have undone its removal.
      const refusal = learning.undoneRefusal(notesArea(scope), "write", note)
        ?? (replaced ? learning.undoneRefusal(notesArea(scope), "remove", replaced) : null);
      if (refusal) return { ok: false, error: refusal };
    }
    const limit = notesLimit(scope);
    // Full: the coldest notes move to the archive and the new one stays.
    // With no archive on this machine the write is refused, so nothing is lost.
    const fit = evictToFit(scope, next, new Set([noteIndex]), replaced ? [{ kind: "note", scope, text: replaced, reason: "replaced" }] : []);
    if (fit === "full") return { ok: false, error: notesFullMessage(utf8Bytes(renderNotes(lines)), limit) };
    if (fit === "not_archived") return { ok: false, error: NOT_ARCHIVED_ERROR };
    next = fit.kept;
    const { archived, bytes } = fit;
    writeNoteLines(scope, next);
    if (scope === "user") learning.ctoWroteUserNotes(replaced ? [note, replaced] : [note]);
    if (replaced) learning.ctoReplaced(notesArea(scope), replaced, note);
    // Moved to the archive to make room, not dropped: not a change to show or undo.
    if (archived.length) learning.ctoArchived(notesArea(scope), archived);
    archive?.touchNote(scope, note);
    return {
      ok: true,
      saved: true,
      note,
      ...(replaced ? { replaced } : {}),
      scope,
      bytes,
      limitBytes: limit,
      ...(archived.length ? { archived } : {}),
    };
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
    // Kept first, marked forgotten (a search shows it was dropped, not that it
    // is true): when the archive can't keep it, the note stays.
    if (archive?.available() && archive.add({ kind: "note", scope, text: forgotten, reason: "forgotten" }) == null) {
      return { ok: false, error: NOT_ARCHIVED_ERROR };
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
      // The story on disk goes into the archive first, if no import took it yet.
      archiveOps.ensureImported();
      let replaced: CtoStoryRecord | null = null;
      try {
        replaced = readStory();
      } catch {
        // An unreadable story has no version to keep.
      }
      fs.mkdirSync(path.dirname(storyPath), { recursive: true });
      const clean: CtoStoryRecord = {
        ...record,
        summary: redactSecrets(record.summary),
        ...(record.carried ? { carried: { ...record.carried, text: redactSecrets(record.carried.text) } } : {}),
      };
      writeTextAtomic(storyPath, `${JSON.stringify(clean, null, 2)}\n`);
      // Every version is kept: a fold condenses, and what it drops stays here.
      // The version this write replaced goes in again (one row per text), so
      // a failed archive write last time loses nothing.
      const versions = [replaced, clean]
        .filter((story): story is CtoStoryRecord => Boolean(story?.summary.trim()))
        .map((story) => ({ kind: "story" as const, text: story.summary, sourceAt: story.coveredThrough, sourceLabel: story.model }));
      if (versions.length) archive?.addMany(versions);
    }
    args.onChanged?.();
  };

  const trackWork = (
    text: string,
    addedBy: CtoOpenWorkItem["addedBy"] = "cto",
    extra: { title?: string | null; owner?: CtoOpenWorkOwner | null; link?: CtoOpenWorkLink | null } = {},
  ): CtoOpenWorkResult => {
    const normalized = clipText(redactSecrets(text.replace(/\s+/g, " ").trim()), OPEN_WORK_TEXT_MAX_CHARS);
    if (!normalized.length) return { ok: false, error: "Say what the work is." };
    const title = extra.title
      ? clipText(redactSecrets(extra.title.replace(/\s+/g, " ").trim()), OPEN_WORK_TITLE_MAX_CHARS)
      : "";
    const link = extra.link ? normalizeOpenWorkLink(extra.link) : null;
    const items = readOpenWork();
    if (items.filter((item) => !item.doneAt).length >= CTO_OPEN_WORK_MAX_OPEN) {
      return { ok: false, error: `Open work is full (${CTO_OPEN_WORK_MAX_OPEN} items). Finish or remove one first.` };
    }
    const existingIds = new Set(items.map((item) => item.id));
    let id = newWorkId();
    while (existingIds.has(id)) id = newWorkId();
    const item: CtoOpenWorkItem = {
      id,
      text: normalized,
      createdAt: nowIso(),
      doneAt: null,
      addedBy,
      owner: extra.owner ?? "cto",
      ...(title && title !== normalized ? { title } : {}),
      ...(link ? { link } : {}),
    };
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

  const finishWork = (id: string, outcome?: string | null, closedBy: "cto" | "user" = "cto"): CtoOpenWorkResult =>
    updateItem(id, (item) => {
      if (item.doneAt) return item;
      const note = outcome?.replace(/\s+/g, " ").trim();
      return {
        ...item,
        ...(note ? { outcome: clipText(redactSecrets(note), OPEN_WORK_OUTCOME_MAX_CHARS) } : {}),
        doneAt: nowIso(),
        closedBy,
      };
    });

  const reopenWork = (id: string): CtoOpenWorkResult => {
    if (readOpenWork().filter((item) => !item.doneAt).length >= CTO_OPEN_WORK_MAX_OPEN) {
      return { ok: false, error: `Open work is full (${CTO_OPEN_WORK_MAX_OPEN} items). Finish or remove one first.` };
    }
    // Reopened by hand, it stops closing itself: the link said done once already.
    return updateItem(id, ({ outcome: _outcome, closedBy: _closedBy, link: _link, ...item }) => ({ ...item, doneAt: null }));
  };

  let linkedWorkResolver: CtoLinkedWorkResolver | null = null;
  let linkedWorkRun: Promise<number> | null = null;
  /**
   * Close every open item whose linked chat or PR has closed, with an outcome
   * line. Runs at the start of each CTO turn, on each read of the list (the
   * side panel, Settings) and when PRs change, so a merged PR's item is done
   * the next time anyone looks. Local reads only (a chat on another machine
   * answers from the last read of it); writes only when something closed.
   * One run at a time: a caller that finds one running joins it.
   */
  const reconcileLinkedWork = (): Promise<number> => {
    if (linkedWorkRun) return linkedWorkRun;
    const run = (async () => {
      const resolver = linkedWorkResolver;
      if (!resolver) return 0;
      const closures = new Map<string, string>();
      for (const item of readOpenWork()) {
        if (item.doneAt || !item.link) continue;
        try {
          const outcome = await linkedWorkOutcome(item, resolver);
          if (outcome) closures.set(item.id, clipText(redactSecrets(outcome), OPEN_WORK_OUTCOME_MAX_CHARS));
        } catch (error) {
          warn("cto_memory.linked_work_check_failed", error, { id: item.id });
        }
      }
      if (!closures.size) return 0;
      // Read again: the person may have finished, reopened or removed an item
      // while the checks ran. Close only what is still open and still linked.
      const doneAt = nowIso();
      let closed = 0;
      const next = readOpenWork().map((item) => {
        const outcome = closures.get(item.id);
        if (!outcome || item.doneAt || !item.link) return item;
        closed += 1;
        return { ...item, doneAt, outcome, closedBy: "auto" as const };
      });
      if (!closed) return 0;
      writeOpenWork(next);
      logger?.info?.("cto_memory.linked_work_closed", { count: closed });
      args.onLinkedWorkClosed?.(closed);
      return closed;
    })()
      .catch((error) => {
        warn("cto_memory.linked_work_reconcile_failed", error);
        return 0;
      })
      .finally(() => {
        if (linkedWorkRun === run) linkedWorkRun = null;
      });
    linkedWorkRun = run;
    return run;
  };

  /** Open items' chats on other machines, for the machine reads that report on them. */
  const listLinkedRemoteChats = (): Array<{ machineId: string; sessionId: string }> =>
    readOpenWork().flatMap((item) => (!item.doneAt && item.link?.kind === "chat" && item.link.machineId
      ? [{ machineId: item.link.machineId, sessionId: item.link.sessionId }]
      : []));

  /** Late-bound: the PR and session services exist after this one. */
  const setLinkedWorkResolver = (resolver: CtoLinkedWorkResolver | null): void => {
    linkedWorkResolver = resolver;
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
      ? trackWork(change.text, "user", { owner: change.owner ?? "cto" })
      : change.op === "complete"
        ? finishWork(change.id, null, "user")
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
      if (archive?.addMany(discoveryRecords(evicted, "evicted")) === null) archiveOps.importDiscoveriesAgain();
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
    if (options.advance !== false) {
      writeDiscoveryCursor(stoppedEarly ? windowStart + keptBytes : nextCursor);
      if (archive?.addMany(discoveryRecords(lines, "drained")) === null) archiveOps.importDiscoveriesAgain();
    }
    if (!lines.length) return { lines: [], text: "" };
    const joined = lines.join("\n");
    const text = joined.length > budget ? `…(older content truncated)\n${joined.slice(joined.length - budget)}` : joined;
    return { lines, text };
  };

  /* ── The archive (`ctoMemoryArchiveOps.ts`) ── */

  const archiveOps = createCtoMemoryArchiveOps({
    archive,
    readFilesBeforeArchive: () => {
      let story: CtoStoryRecord | null = null;
      try {
        story = readStory();
      } catch {
        // An unreadable story stays where it is; there is nothing to import.
      }
      return { evictedDiscoveries: readFileOrEmpty(discoveriesArchivePath), discoveries: readFileOrEmpty(discoveriesPath), story };
    },
    readNoteLines,
    remember,
    rememberAsPerson: (input) => {
      const scope = input.scope ?? "project";
      const before = readNotes(scope);
      const result = remember({ ...input, personAskedAgain: true });
      if (result.ok && result.saved) learning.personWrote(notesArea(scope), before);
      return result;
    },
  });

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
      notesOverflowArchives: archive?.available() ?? false,
      updatedAt: updatedCandidates.length ? updatedCandidates[updatedCandidates.length - 1] : null,
    };
  };

  /** The snapshot a reader shows: linked items whose chat or PR closed are closed first. */
  const getReconciledSnapshot = async (): Promise<CtoMemorySnapshot> => {
    await reconcileLinkedWork();
    return getSnapshot();
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
    const describe = (item: CtoOpenWorkItem): string => {
      const title = item.title ? `${item.title} — ` : "";
      const link = item.link
        ? item.link.kind === "pr"
          ? ` [PR #${item.link.number}]`
          : ` [chat ${item.link.sessionId}${item.link.machineId ? ` on ${item.link.machineId}` : ""}]`
        : "";
      return `${title}${item.text}${link}`;
    };
    const workLines = [
      ...open.map((item) => `- [ ] ${item.id} (${(item.owner ?? "cto") === "user" ? "waiting on the person" : "yours"}): ${describe(item)}`),
      ...done.map((item) => `- [x] ${item.id}: ${describe(item)} (done${item.outcome ? `: ${item.outcome}` : ""}${item.closedBy === "auto" ? ", closed by its link" : ""})`),
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
    ...archiveOps,
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
    reconcileLinkedWork,
    setLinkedWorkResolver,
    listLinkedRemoteChats,
    recordDiscovery,
    readNewDiscoveries,
    getSnapshot,
    getReconciledSnapshot,
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
    close: () => archive?.close(),
  };
}

export type CtoMemoryService = ReturnType<typeof createCtoMemoryService>;
