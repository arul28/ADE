import fs from "node:fs";
import path from "node:path";

import { resolveAdeLayout } from "../../../shared/adeLayout";

/**
 * The tracked agent CLIs (Claude Code, Codex, ...) a runtime had open when it
 * stopped on purpose (an update, a reboot), so the next runtime of the project
 * reopens them, as chats come back after a restart. One file per project, in
 * `.ade/cache/`, written at stop and read once at start: reading deletes it,
 * so a list is never acted on twice, and a crash (which writes nothing) never
 * starts a reopen loop.
 */
export const CLI_REOPEN_AFTER_RESTART_FILE = "reopen-cli-after-restart.json";

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

export function cliReopenAfterRestartPath(projectRoot: string): string {
  return path.join(resolveAdeLayout(projectRoot).cacheDir, CLI_REOPEN_AFTER_RESTART_FILE);
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
 * Add these CLIs to the project's list. Another runtime of the same project
 * may have written its own a moment ago (a desktop beside the brain), so the
 * lists merge; a CLI in both is mid-turn if either says so. Synchronous: it
 * runs while the runtime shuts down.
 */
export function recordCliSessionsToReopen(
  projectRoot: string,
  entries: readonly CliReopenEntry[],
  now: () => Date = () => new Date(),
): void {
  if (entries.length === 0) return;
  const filePath = cliReopenAfterRestartPath(projectRoot);
  const merged = new Map<string, CliReopenEntry>();
  for (const entry of [...(readFile(filePath)?.sessions ?? []), ...entries]) {
    const previous = merged.get(entry.sessionId);
    merged.set(entry.sessionId, { sessionId: entry.sessionId, midTurn: entry.midTurn || previous?.midTurn === true });
  }
  const file: CliReopenFile = {
    version: 1,
    writtenAt: now().toISOString(),
    sessions: [...merged.values()].slice(-MAX_ENTRIES),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(file));
  fs.renameSync(tmpPath, filePath);
}

/**
 * The project's list, deleted as it is read. Empty when there is none, it
 * cannot be read, or it is older than `maxAgeMs` (the work it names is stale,
 * as for a chat a restart cut off long ago).
 */
export function takeCliSessionsToReopen(
  projectRoot: string,
  maxAgeMs: number,
  now: () => Date = () => new Date(),
): CliReopenEntry[] {
  const filePath = cliReopenAfterRestartPath(projectRoot);
  const file = readFile(filePath);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A list that cannot be deleted is still read only by this runtime.
  }
  if (!file) return [];
  const writtenMs = Date.parse(file.writtenAt);
  if (!Number.isFinite(writtenMs) || now().getTime() - writtenMs > maxAgeMs) return [];
  return file.sessions;
}
