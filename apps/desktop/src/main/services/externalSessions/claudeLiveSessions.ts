import fs from "node:fs";
import path from "node:path";
import { claudeConfigDir } from "./discoverClaude";
import { safeParseJson, safeStat, type ExternalSessionDiscoveryArgs } from "./discoveryUtils";

/**
 * Claude CLI writes `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` for each running
 * session and leaves the file behind when the process dies. A live pid is a far
 * better activity signal than the transcript's mtime, which says "was written
 * recently", not "is open right now" — a session idling for ten minutes is
 * still the one the user must not resume from a second terminal.
 */
/**
 * Cap on registry files opened per call. Claude never deletes these, so the
 * directory is mostly dead sessions and the cap has to be applied newest-first:
 * in raw `readdir` order a live session can fall outside it, and reporting it as
 * not running is exactly the mistake this registry exists to prevent.
 */
const MAX_REGISTRY_FILES = 256;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/**
 * Session ids Claude currently has open, from its own live-session registry.
 * Returns null when the registry does not exist, so callers keep their mtime
 * heuristic instead of silently reporting nothing as active.
 */
export function liveClaudeSessionIds(
  args: Pick<ExternalSessionDiscoveryArgs, "homeDir" | "env"> = {},
): Set<string> | null {
  const dir = path.join(claudeConfigDir(args), "sessions");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Missing or unreadable is "no answer", not "nothing is running".
    return null;
  }
  const newestFirst = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      return { filePath, mtimeMs: safeStat(filePath)?.mtimeMs ?? 0 };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath))
    .slice(0, MAX_REGISTRY_FILES);

  const live = new Set<string>();
  for (const { filePath } of newestFirst) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const record = safeParseJson(raw);
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const { pid, sessionId } = record as { pid?: unknown; sessionId?: unknown };
    if (typeof sessionId !== "string" || !sessionId.trim()) continue;
    // A stale entry keeps its pid, so liveness has to be checked, not assumed.
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !processAlive(pid)) continue;
    live.add(sessionId.trim());
  }
  return live;
}
