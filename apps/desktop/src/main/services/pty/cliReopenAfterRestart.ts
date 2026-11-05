import fs from "node:fs";
import path from "node:path";

import { resolveAdeLayout } from "../../../shared/adeLayout";

/**
 * The tracked agent CLIs (Claude Code, Codex, ...) a runtime had open when it
 * stopped on purpose (an update, a reboot), so the next runtime of the project
 * reopens them, as chats come back after a restart.
 *
 * Each stopping runtime writes its own file in `.ade/cache/`, so two runtimes
 * of one project that stop together never overwrite each other's list. The
 * next start claims each file with a rename before it reads it: only one
 * runtime gets a list, a list is never acted on twice, and a crash (which
 * writes nothing) never starts a reopen loop.
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
}
