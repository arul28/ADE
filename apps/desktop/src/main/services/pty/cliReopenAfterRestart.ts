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
 *   start derives the list from the session rows instead (still `running`, or
 *   `detached` by the stale-row sweep, owned by a process that is gone), and
 *   this module keeps what that needs in `.ade/cache/cli-reopen/`:
 *   - `turns.<pid>.json`: the CLIs whose turn is running, by their own exact
 *     signal (Claude Code hooks, Codex OSC), kept current by the live runtime.
 *     It says which reopened CLIs are told to continue. A runtime that stops on
 *     purpose deletes its own.
 *   - `<session>.<owner>.claim`: one reopen per session per dead owner. It is
 *     created exclusively, so two runtimes, or a planned list and the derived
 *     list, never reopen one session twice.
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
    entries.push({ sessionId: sessionId.trim(), midTurn: (item as Record<string, unknown>).midTurn === true });
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

/**
 * Save this runtime's open CLIs for the project's next runtime. Synchronous:
 * it runs while the runtime shuts down.
 */
export function recordCliSessionsToReopen(
  projectRoot: string,
  entries: readonly CliReopenEntry[],
  now: () => Date = () => new Date(),
): void {
  if (entries.length === 0) return;
  const file: CliReopenFile = {
    version: 1,
    writtenAt: now().toISOString(),
    sessions: entries.slice(-MAX_ENTRIES),
  };
  const dir = cacheDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${FILE_PREFIX}${process.pid}${FILE_SUFFIX}`);
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
 * cut off long ago) adds nothing. A CLI in two lists is mid-turn if either
 * says so.
 */
export function takeCliSessionsToReopen(
  projectRoot: string,
  maxAgeMs: number,
  now: () => Date = () => new Date(),
): CliReopenEntry[] {
  const dir = cacheDir(projectRoot);
  const merged = new Map<string, CliReopenEntry>();
  for (const name of listFileNames(dir)) {
    const claimedPath = path.join(dir, `${name}.claimed-${process.pid}`);
    try {
      fs.renameSync(path.join(dir, name), claimedPath);
    } catch {
      continue;
    }
    const file = readFile(claimedPath);
    try {
      fs.rmSync(claimedPath, { force: true });
    } catch {
      // A claimed list is read only by this runtime.
    }
    const writtenMs = file ? Date.parse(file.writtenAt) : Number.NaN;
    if (!file || !Number.isFinite(writtenMs) || now().getTime() - writtenMs > maxAgeMs) continue;
    for (const entry of file.sessions) {
      const midTurn = entry.midTurn || merged.get(entry.sessionId)?.midTurn === true;
      merged.set(entry.sessionId, { sessionId: entry.sessionId, midTurn });
    }
  }
  return [...merged.values()].slice(-MAX_ENTRIES);
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

function ownerKey(ownerPid: number, ownerStartedAt: string | null | undefined): string {
  return createHash("sha256").update(`${ownerPid}\0${ownerStartedAt ?? ""}`).digest("hex").slice(0, 16);
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
export function isProcessRunning(pid: number): boolean {
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
      } catch {
        // A file left behind belongs to a pid that is gone: the next start
        // reads it only for that pid's sessions, then deletes it.
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
  try {
    const filePath = path.join(crashStateDir(projectRoot), `${TURNS_PREFIX}${ownerPid}${TURNS_SUFFIX}`);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CliTurnsFile>;
    if (parsed?.version !== 1 || parsed.pid !== ownerPid) return new Set();
    if ((parsed.ownerStartedAt ?? null) !== (ownerStartedAt ?? null)) return new Set();
    if (!Array.isArray(parsed.sessions)) return new Set();
    return new Set(parsed.sessions.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    return new Set();
  }
}

/**
 * Claim the reopen of a session that a dead owner left. True for exactly one
 * caller per session and owner, on this computer: the claim file is created
 * exclusively (`wx`), which is atomic on every platform. A claim that cannot
 * be written for another reason claims nothing, so nothing reopens.
 */
export function claimCliCrashReopen(
  projectRoot: string,
  sessionId: string,
  owner: { pid: number; startedAt: string | null | undefined },
): boolean {
  const dir = crashStateDir(projectRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${safeName(sessionId)}.${ownerKey(owner.pid, owner.startedAt)}${CLAIM_SUFFIX}`),
      "",
      { flag: "wx" },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Count one more reopen after an unclean stop and return the count in a row.
 * A count older than `maxAgeMs` starts again at 1: the session ran that long
 * without a crash. Written before the reopen starts. Throws when it cannot be
 * written; the caller then does not reopen.
 */
export function countCliCrashReopen(
  projectRoot: string,
  sessionId: string,
  maxAgeMs: number,
  now: () => Date = () => new Date(),
): number {
  const dir = crashStateDir(projectRoot);
  const filePath = path.join(dir, `${safeName(sessionId)}.json`);
  const nowMs = now().getTime();
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

/** A stop on purpose breaks the row: those sessions count from zero again. */
export function resetCliCrashReopenCount(projectRoot: string, sessionIds: Iterable<string>): void {
  const dir = crashStateDir(projectRoot);
  for (const sessionId of sessionIds) {
    try {
      fs.rmSync(path.join(dir, `${safeName(sessionId)}.json`), { force: true });
    } catch {
      // A count left behind expires with its age.
    }
  }
}

/**
 * Delete the turn files of runtimes that are gone, and claims and counts older
 * than `keepMs`. Runs once per start; the folder holds a few small files.
 * Never throws.
 */
export function pruneCliCrashReopenState(
  projectRoot: string,
  options: { keepMs: number; isPidRunning?: (pid: number) => boolean; now?: () => Date },
): void {
  const dir = crashStateDir(projectRoot);
  const isRunning = options.isPidRunning ?? isProcessRunning;
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      if (name.startsWith(TURNS_PREFIX) && name.endsWith(TURNS_SUFFIX)) {
        const pid = Number(name.slice(TURNS_PREFIX.length, -TURNS_SUFFIX.length));
        if (Number.isInteger(pid) && pid !== process.pid && !isRunning(pid)) fs.rmSync(filePath, { force: true });
        continue;
      }
      if (nowMs - fs.statSync(filePath).mtimeMs > options.keepMs) fs.rmSync(filePath, { force: true });
    } catch {
      // The next start tries again.
    }
  }
}
