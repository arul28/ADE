import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveAdeLayout } from "../../../shared/adeLayout";

/**
 * The tracked agent CLIs (Claude Code, Codex, ...) a runtime had open when it
 * stopped, so the project's next runtime reopens them, as chats come back
 * after a restart. Two kinds of stop, two sources:
 *
 * - A stop on purpose (an update, a reboot): the stopping runtime writes its
 *   own list file in `.ade/cache/`, so two runtimes of one project that stop
 *   together never overwrite each other's list. The next start claims each
 *   file with a rename before it reads it: only one runtime gets a list, and a
 *   list is never acted on twice.
 * - A crash, force quit, kill or power loss writes nothing at exit. The next
 *   start derives the list from the session rows instead
 *   (`findCliSessionsCutOffByCrash`): still `running`, or `detached` by the
 *   stale-row sweep, owned by a process of THIS computer (its local process
 *   registry knows it) that is gone. The session table syncs between
 *   machines, so a row another machine owns is never one. This module keeps
 *   what the reopen needs in `.ade/cache/cli-reopen/`:
 *   - `turns.<pid>.json`: the CLIs whose turn is running, by their own exact
 *     signal (Claude Code hooks, Codex OSC), kept current by the live runtime.
 *     It says which reopened CLIs are told to continue. A runtime that stops on
 *     purpose deletes its own.
 *   - `<session>.<owner>.claim`: one reopen per session per dead owner, for
 *     both sources. It is created exclusively right before that session's
 *     reopen, so two runtimes, or a planned list and the derived list, never
 *     reopen one session twice, and a stop during the reopens leaves the rest
 *     for the next start.
 *   - `<session>.json`: how many unclean stops in a row reopened the session.
 *     It is written before the reopen starts, so a reopen that itself stops
 *     the runtime counts too; past the cap the session stays closed.
 */
const FILE_PREFIX = "reopen-cli-after-restart.";
const FILE_SUFFIX = ".json";

export type CliReopenEntry = {
  sessionId: string;
  /** Its turn was running when the runtime stopped: it is told to continue. */
  midTurn: boolean;
  /**
   * `chat`: an agent chat whose turn ran when the brain stopped on purpose
   * (`recordPlannedBrainStop`); it is continued by id, not reopened. Older
   * runtimes read it as a CLI that is not reopenable, which does nothing.
   */
  kind?: "chat";
  /** The stop was an update the user accepted: the continue cap starts again. */
  acceptedUpdate?: true;
};

type CliReopenFile = {
  version: 1;
  writtenAt: string;
  sessions: CliReopenEntry[];
};

const MAX_ENTRIES = 200;

function cacheDir(projectRoot: string): string {
  return resolveAdeLayout(projectRoot).cacheDir;
}

/** The runtime's own list files: `reopen-cli-after-restart.<pid>.json`. */
function isListFileName(name: string): boolean {
  return name.startsWith(FILE_PREFIX)
    && name.endsWith(FILE_SUFFIX)
    && /^\d+$/.test(name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length));
}

/** The pid of the runtime that wrote the list (its file name). */
function listFileWriterPid(name: string): number {
  return Number(name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length));
}

/** A stop for good: CLIs reopen at their prompt, chats are not continued. */
function withoutContinues(entries: readonly CliReopenEntry[]): CliReopenEntry[] {
  return entries
    .filter((entry) => entry.kind !== "chat")
    .map((entry) => ({ sessionId: entry.sessionId, midTurn: false }));
}

function hasContinues(entries: readonly CliReopenEntry[]): boolean {
  return entries.some((entry) => entry.kind === "chat" || entry.midTurn || entry.acceptedUpdate);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function listFileNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(isListFileName);
  } catch {
    return [];
  }
}

function parseEntries(value: unknown): CliReopenEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: CliReopenEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const sessionId = (item as Record<string, unknown>).sessionId;
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 256) continue;
    const record = item as Record<string, unknown>;
    entries.push({
      sessionId: sessionId.trim(),
      midTurn: record.midTurn === true,
      ...(record.kind === "chat" ? { kind: "chat" as const } : {}),
      ...(record.acceptedUpdate === true ? { acceptedUpdate: true as const } : {}),
    });
  }
  return entries;
}

function readFile(filePath: string): CliReopenFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (parsed?.version !== 1 || typeof parsed.writtenAt !== "string") return null;
    return { version: 1, writtenAt: parsed.writtenAt, sessions: parseEntries(parsed.sessions) };
  } catch {
    return null;
  }
}

/** Two lists of one session: chat and accepted update if either says so, mid-turn likewise. */
function mergeEntries(lists: Iterable<readonly CliReopenEntry[]>): CliReopenEntry[] {
  const merged = new Map<string, CliReopenEntry>();
  for (const list of lists) {
    for (const entry of list) {
      const earlier = merged.get(entry.sessionId);
      merged.set(entry.sessionId, {
        sessionId: entry.sessionId,
        midTurn: entry.midTurn || earlier?.midTurn === true,
        ...(entry.kind === "chat" || earlier?.kind === "chat" ? { kind: "chat" as const } : {}),
        ...(entry.acceptedUpdate || earlier?.acceptedUpdate ? { acceptedUpdate: true as const } : {}),
      });
    }
  }
  return [...merged.values()];
}

/**
 * Save this runtime's open CLIs for the project's next runtime. Synchronous:
 * it runs while the runtime shuts down. Adds to the list this runtime already
 * wrote in this stop (a planned brain stop saves the chats first, and the
 * terminals' teardown may add its CLIs after it).
 */
export function recordCliSessionsToReopen(
  projectRoot: string,
  entries: readonly CliReopenEntry[],
  now: () => Date = () => new Date(),
): void {
  if (entries.length === 0) return;
  const dir = cacheDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${FILE_PREFIX}${process.pid}${FILE_SUFFIX}`);
  const earlier = readFile(filePath);
  const file: CliReopenFile = {
    version: 1,
    writtenAt: now().toISOString(),
    sessions: mergeEntries([earlier?.sessions ?? [], entries]).slice(-MAX_ENTRIES),
  };
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(file));
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

/**
 * Every list the project's stopped runtimes left, claimed and deleted as it is
 * read. A list another runtime claimed first, one that cannot be read, or one
 * older than `maxAgeMs` (the work it names is stale, as for a chat a restart
 * cut off long ago) adds nothing; `onStale` gets a stale list's entries, so
 * the caller can say which owed continues it drops. A CLI in two lists is
 * mid-turn if either says so. `leave`: entries that belong to another
 * runtime of this computer; they are written back, with their list's own
 * time, for that runtime to take. When that write-back fails, the whole list
 * is put back as it was and this runtime takes nothing from it: a reserved
 * entry is never acted on by the wrong runtime, and never lost.
 * `stoppedForGood`: the pids of runtimes that were stopped for good while
 * their lists could not be rewritten; their lists only reopen CLIs at the
 * prompt and continue nothing.
 */
export function takeCliSessionsToReopen(
  projectRoot: string,
  maxAgeMs: number,
  now: () => Date = () => new Date(),
  onStale?: (entries: CliReopenEntry[]) => void,
  leave?: (entry: CliReopenEntry) => boolean,
  stoppedForGood?: ReadonlySet<number>,
): CliReopenEntry[] {
  const dir = cacheDir(projectRoot);
  const taken: CliReopenEntry[][] = [];
  for (const name of listFileNames(dir)) {
    const forGood = stoppedForGood?.has(listFileWriterPid(name)) === true;
    const view = (entries: readonly CliReopenEntry[]): CliReopenEntry[] => (forGood ? withoutContinues(entries) : [...entries]);
    // A list that is all another runtime's stays where it is, untouched: a
    // claim would hide it from its owner for the moment of the write-back.
    if (leave) {
      const whole = readFile(path.join(dir, name));
      const sessions = whole ? view(whole.sessions) : [];
      if (sessions.length > 0 && sessions.every((entry) => leave(entry))) continue;
    }
    const listPath = path.join(dir, name);
    const claimedPath = path.join(dir, `${name}.claimed-${process.pid}`);
    try {
      fs.renameSync(listPath, claimedPath);
    } catch {
      continue;
    }
    const file = readFile(claimedPath);
    const writtenMs = file ? Date.parse(file.writtenAt) : Number.NaN;
    if (!file || !Number.isFinite(writtenMs) || now().getTime() - writtenMs > maxAgeMs) {
      removeClaimed(claimedPath);
      if (file && file.sessions.length > 0) onStale?.(view(file.sessions));
      continue;
    }
    const sessions = view(file.sessions);
    const left = leave ? sessions.filter((entry) => leave(entry)) : [];
    if (left.length > 0) {
      try {
        writeJsonAtomic(listPath, { ...file, sessions: left });
      } catch {
        // Put the whole list back for the runtimes it names. If even that
        // fails, the reserved entries cannot be kept, but they still do not
        // go to this runtime; it takes only its own.
        try {
          fs.renameSync(claimedPath, listPath);
          continue;
        } catch {
          // See above.
        }
      }
    }
    // The claimed original goes only now: the entries left for another
    // runtime are on disk again, under the list's own name.
    removeClaimed(claimedPath);
    taken.push(left.length > 0 ? sessions.filter((entry) => !left.includes(entry)) : sessions);
  }
  return mergeEntries(taken).slice(-MAX_ENTRIES);
}

function removeClaimed(claimedPath: string): void {
  try {
    fs.rmSync(claimedPath, { force: true });
  } catch {
    // A claimed list is read only by this runtime.
  }
}

/**
 * A stop for good: the lists that `writerPids` (the stopped brain and the
 * brains whose work it took over) wrote keep their CLIs, to reopen as before,
 * but nothing in them is continued, and their chats are not. Lists of any
 * other runtime (a sibling brain, the machine brain) are left as they are.
 * Each list keeps its own time. Never throws.
 *
 * `held`: no list of those writers can still continue anything. False when a
 * list could not be claimed for another reason than being gone (a read-only
 * or locked folder); the caller then keeps the decision elsewhere. `failed`:
 * lists that could not be handled cleanly (also a claimed list whose rewrite
 * failed: it continues nothing, and its CLIs do not reopen).
 */
export function neutralizeCliSessionsToReopen(
  projectRoot: string,
  writerPids: ReadonlySet<number>,
): { held: boolean; failed: number } {
  const dir = cacheDir(projectRoot);
  let held = true;
  let failed = 0;
  // A folder that is not there has no lists. One that cannot be read (locked,
  // unavailable) may hold lists that still continue work: not held.
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(isListFileName);
  } catch (error) {
    return isMissing(error) ? { held: true, failed: 0 } : { held: false, failed: 1 };
  }
  for (const name of names) {
    if (!writerPids.has(listFileWriterPid(name))) continue;
    const filePath = path.join(dir, name);
    // A list with nothing to continue needs no rewrite.
    const before = readFile(filePath);
    if (before && !hasContinues(before.sessions)) continue;
    // Claimed first, as a take does: a list another runtime takes meanwhile is its own.
    const claimedPath = `${filePath}.claimed-${process.pid}`;
    try {
      fs.renameSync(filePath, claimedPath);
    } catch (error) {
      // Gone (another runtime took it): nothing of it can continue here.
      if (isMissing(error)) continue;
      held = false;
      failed += 1;
      continue;
    }
    const file = readFile(claimedPath);
    const sessions = withoutContinues(file?.sessions ?? []);
    try {
      if (file && sessions.length > 0) writeJsonAtomic(filePath, { ...file, sessions });
    } catch {
      failed += 1;
    }
    removeClaimed(claimedPath);
  }
  return { held, failed };
}

/**
 * Drop the project's lists without acting on them: the project was removed
 * from this machine, so its CLIs do not come back if it is added again.
 * Never throws; a list it cannot delete only reopens those CLIs.
 */
export function forgetCliSessionsToReopen(projectRoot: string): void {
  const dir = cacheDir(projectRoot);
  for (const name of listFileNames(dir)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // See above.
    }
  }
  try {
    fs.rmSync(crashStateDir(projectRoot), { recursive: true, force: true });
  } catch {
    // See above.
  }
}

// --- After a crash --------------------------------------------------------

const TURNS_PREFIX = "turns.";
const TURNS_SUFFIX = ".json";
const CLAIM_SUFFIX = ".claim";

function crashStateDir(projectRoot: string): string {
  return path.join(cacheDir(projectRoot), "cli-reopen");
}

function safeName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ownerKey(ownerPid: number | null, ownerStartedAt: string | null | undefined): string {
  return createHash("sha256").update(`${ownerPid ?? ""}\0${ownerStartedAt ?? ""}`).digest("hex").slice(0, 16);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value));
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

/**
 * Whether a process with this id runs on this computer. `kill(pid, 0)` sends
 * nothing and works the same on macOS, Linux and Windows; EPERM means it runs
 * under another user.
 */
function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type CliTurnsFile = {
  version: 1;
  pid: number;
  ownerStartedAt: string | null;
  sessions: string[];
};

export type CliTurnRecorder = {
  /** Mark a CLI's turn as running or not. Writes only on a change. */
  setRunning(sessionId: string, running: boolean): void;
  /** The runtime stops on purpose: delete the file and write nothing more. */
  close(): void;
};

/**
 * Keeps `turns.<pid>.json` current for one runtime of the project. Writes are
 * asynchronous and coalesced, so a slow drive never holds the event loop, and
 * a write that fails only means a crash reopens that CLI at its prompt.
 */
export function createCliTurnRecorder(
  projectRoot: string,
  owner: { pid: number; ownerStartedAt: string | null },
  onWriteFailed?: (error: unknown) => void,
): CliTurnRecorder {
  const running = new Set<string>();
  const dir = crashStateDir(projectRoot);
  const filePath = path.join(dir, `${TURNS_PREFIX}${owner.pid}${TURNS_SUFFIX}`);
  let closed = false;
  let writing = false;
  let dirty = false;
  const flush = async (): Promise<void> => {
    if (writing) {
      dirty = true;
      return;
    }
    writing = true;
    try {
      do {
        dirty = false;
        if (closed) return;
        if (running.size === 0) {
          await fs.promises.rm(filePath, { force: true });
          continue;
        }
        const file: CliTurnsFile = {
          version: 1,
          pid: owner.pid,
          ownerStartedAt: owner.ownerStartedAt,
          sessions: [...running].slice(-MAX_ENTRIES),
        };
        const tmpPath = `${filePath}.tmp`;
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(tmpPath, JSON.stringify(file));
        // Checked again: close() may have run during the write.
        if (closed) {
          await fs.promises.rm(tmpPath, { force: true });
          return;
        }
        await fs.promises.rename(tmpPath, filePath);
      } while (dirty);
    } catch (error) {
      onWriteFailed?.(error);
    } finally {
      writing = false;
      // close() ran while a rename was on its way: that rename may land after
      // close() deleted the file.
      if (closed) await fs.promises.rm(filePath, { force: true }).catch(onWriteFailed);
    }
  };
  return {
    setRunning(sessionId, isRunning) {
      if (closed || running.has(sessionId) === isRunning) return;
      if (isRunning) running.add(sessionId);
      else running.delete(sessionId);
      void flush();
    },
    close() {
      if (closed) return;
      closed = true;
      running.clear();
      try {
        fs.rmSync(filePath, { force: true });
      } catch (error) {
        // A file left behind belongs to a pid that is gone, and no row of a
        // planned stop is a crash candidate; the next start deletes it.
        onWriteFailed?.(error);
      }
    },
  };
}

/**
 * The CLIs whose turn was running in that runtime when it stopped, or an
 * empty set. The file must belong to the same process (pid and start time),
 * so a reused pid never makes an idle CLI continue.
 */
export function readCliTurnsRunning(
  projectRoot: string,
  ownerPid: number,
  ownerStartedAt: string | null | undefined,
): Set<string> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(crashStateDir(projectRoot), `${TURNS_PREFIX}${ownerPid}${TURNS_SUFFIX}`), "utf8");
  } catch (error) {
    // No file: no turn of that runtime was running.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<CliTurnsFile>;
  if (parsed?.version !== 1 || parsed.pid !== ownerPid) return new Set();
  if ((parsed.ownerStartedAt ?? null) !== (ownerStartedAt ?? null)) return new Set();
  if (!Array.isArray(parsed.sessions)) return new Set();
  return new Set(parsed.sessions.filter((id): id is string => typeof id === "string" && id.length > 0));
}

/**
 * Claim the reopen of a session that a dead owner left, from either source.
 * The owner is the one the session row names when the reopen starts: two
 * runtimes that read the same row claim the same file. True for exactly one
 * caller per session and owner, on this computer: the claim file is created
 * exclusively (`wx`), which is atomic on every platform; false when it exists.
 * Any other error throws, and the caller then does not reopen.
 */
export function claimCliReopen(projectRoot: string, entry: CliSessionOwner): boolean {
  const dir = crashStateDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(dir, `${safeName(entry.sessionId)}.${ownerKey(entry.ownerPid, entry.ownerStartedAt)}${CLAIM_SUFFIX}`),
      "",
      { flag: "wx" },
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Count one more reopen after an unclean stop and return the count in a row.
 * A count older than `maxAgeMs` starts again at 1: the session ran that long
 * without a crash. Written before the reopen starts. Throws when it cannot be
 * written; the caller then does not reopen.
 */
export function countCliCrashReopen(projectRoot: string, sessionId: string, maxAgeMs: number): number {
  const dir = crashStateDir(projectRoot);
  const filePath = path.join(dir, `${safeName(sessionId)}.json`);
  const nowMs = Date.now();
  let previous = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { streak?: unknown; at?: unknown };
    const atMs = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
    if (typeof parsed.streak === "number" && Number.isFinite(atMs) && nowMs - atMs <= maxAgeMs && nowMs >= atMs) {
      previous = Math.max(0, Math.trunc(parsed.streak));
    }
  } catch {
    // No count yet.
  }
  const streak = previous + 1;
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(filePath, { streak, at: new Date(nowMs).toISOString() });
  return streak;
}

/**
 * A stop on purpose, or a resume by hand, breaks the row: those sessions count
 * from zero again. Throws when a count cannot be deleted; a count left behind
 * only keeps that session capped until it expires.
 */
export function resetCliCrashReopenCount(projectRoot: string, sessionIds: Iterable<string>): void {
  const dir = crashStateDir(projectRoot);
  for (const sessionId of sessionIds) {
    fs.rmSync(path.join(dir, `${safeName(sessionId)}.json`), { force: true });
  }
}

/**
 * Delete the turn files of runtimes that are gone, and claims and counts older
 * than `keepMs`. Runs once per start; the folder holds a few small files.
 * Never throws; returns how many files it could not handle (the next start
 * tries again).
 */
export function pruneCliCrashReopenState(projectRoot: string, options: { keepMs: number }): number {
  const dir = crashStateDir(projectRoot);
  const nowMs = Date.now();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No folder yet: nothing to prune.
    return 0;
  }
  let failed = 0;
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      if (name.startsWith(TURNS_PREFIX) && name.endsWith(TURNS_SUFFIX)) {
        const pid = Number(name.slice(TURNS_PREFIX.length, -TURNS_SUFFIX.length));
        if (Number.isInteger(pid) && pid !== process.pid && !isProcessRunning(pid)) fs.rmSync(filePath, { force: true });
        continue;
      }
      if (nowMs - fs.statSync(filePath).mtimeMs > options.keepMs) fs.rmSync(filePath, { force: true });
    } catch {
      failed += 1;
    }
  }
  return failed;
}

/** A session and the runtime process its row names as owner. */
export type CliSessionOwner = {
  sessionId: string;
  ownerPid: number | null;
  ownerStartedAt: string | null;
};

export type CliCutOffByCrash = CliSessionOwner & { ownerPid: number };

/** The fields of a tracked agent CLI row that say whether a crash cut it off. */
export type CliCrashCandidateRow = {
  id: string;
  status: string;
  archivedAt?: string | null;
  ownerPid?: number | null;
  ownerProcessStartedAt?: string | null;
};

/** A process from this computer's local registry (`runtime_processes`). */
export type CliKnownOwner = { pid: number; startedAt: string; lastSeen: string };

/**
 * The agent CLIs a runtime of this computer left open when it stopped without
 * an orderly stop. A row qualifies when it is `running` or `detached`, not
 * archived, not in `exclude` (a planned list has it), and its owner:
 *
 * - is in this computer's process registry. The session table syncs between
 *   machines and the registry does not, so this is the boundary that keeps a
 *   row another machine owns from being reopened here (the stale-row sweep
 *   uses it the same way);
 * - is not this process, and does not run (a live peer, or a reused pid: the
 *   safe side);
 * - was last seen within `maxAgeMs`: its last heartbeat is close to when it
 *   stopped. Older ones only count as `stale`.
 */
export function findCliSessionsCutOffByCrash(args: {
  rows: readonly CliCrashCandidateRow[];
  knownOwners: readonly CliKnownOwner[];
  ownPid: number;
  exclude?: ReadonlySet<string>;
  maxAgeMs: number;
}): { cutOff: CliCutOffByCrash[]; stale: number } {
  const nowMs = Date.now();
  const lastSeenByIdentity = new Map<string, number>();
  const lastSeenByPid = new Map<number, number>();
  for (const owner of args.knownOwners) {
    const seenMs = Date.parse(owner.lastSeen);
    if (!Number.isFinite(seenMs)) continue;
    lastSeenByIdentity.set(ownerKey(owner.pid, owner.startedAt), seenMs);
    lastSeenByPid.set(owner.pid, Math.max(seenMs, lastSeenByPid.get(owner.pid) ?? 0));
  }
  const cutOff: CliCutOffByCrash[] = [];
  const seen = new Set<string>();
  let stale = 0;
  for (const row of args.rows) {
    if (seen.has(row.id) || args.exclude?.has(row.id)) continue;
    seen.add(row.id);
    if ((row.status !== "running" && row.status !== "detached") || row.archivedAt) continue;
    const ownerPid = row.ownerPid;
    if (ownerPid == null || ownerPid === args.ownPid) continue;
    const ownerStartedAt = row.ownerProcessStartedAt?.trim() || null;
    const lastSeenMs = ownerStartedAt
      ? lastSeenByIdentity.get(ownerKey(ownerPid, ownerStartedAt))
      : lastSeenByPid.get(ownerPid);
    if (lastSeenMs === undefined || isProcessRunning(ownerPid)) continue;
    if (nowMs - lastSeenMs > args.maxAgeMs) {
      stale += 1;
      continue;
    }
    cutOff.push({ sessionId: row.id, ownerPid, ownerStartedAt });
  }
  return { cutOff, stale };
}
