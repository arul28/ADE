import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Logger } from "../logging/logger";
import { isEnoentError } from "../shared/utils";
import { openHistoryReadStream, resolveReadableHistoryPath } from "./historyCompression";

/**
 * Chats used to write every event twice: once to the session row's
 * `<transcripts>/<id>.chat.jsonl` (byte-capped at 8 MB) and once to the
 * dedicated `<transcripts>/chat/<id>.jsonl`, which is uncapped and is what every
 * history reader prefers. The row still names the legacy file, because
 * `terminal_sessions.transcript_path` syncs to peers and older builds; readers
 * that start from the row resolve through here to the dedicated file.
 */
const LEGACY_CHAT_SUFFIX = ".chat.jsonl";

/** Both forms a chat's legacy copy may have under the transcripts directory. */
export function legacyChatTranscriptPaths(transcriptsDir: string, sessionId: string): [plain: string, gzip: string] {
  const plain = path.join(transcriptsDir, `${sessionId}${LEGACY_CHAT_SUFFIX}`);
  return [plain, `${plain}.gz`];
}

/**
 * The chat session a transcript file belongs to: `<chatTranscriptsDir>/<id>.jsonl`
 * or `<transcriptsDir>/<id>.chat.jsonl` (either may end in `.gz`). Null for any
 * other file, including terminal logs.
 */
export function chatSessionIdOfTranscript(
  filePath: string,
  dirs: { transcriptsDir: string; chatTranscriptsDir: string },
): string | null {
  const resolved = path.resolve(filePath);
  const plain = resolved.endsWith(".gz") ? resolved.slice(0, -3) : resolved;
  const dir = path.dirname(plain);
  const base = path.basename(plain);
  const suffix = dir === path.resolve(dirs.chatTranscriptsDir)
    ? ".jsonl"
    : dir === path.resolve(dirs.transcriptsDir) ? LEGACY_CHAT_SUFFIX : null;
  if (!suffix || !base.endsWith(suffix)) return null;
  return base.slice(0, -suffix.length) || null;
}

/** The dedicated transcript a legacy `<id>.chat.jsonl[.gz]` path stands for, or null for any other path. */
export function dedicatedChatTranscriptPathFor(legacyPath: string): string | null {
  if (!legacyPath) return null;
  const resolved = path.resolve(legacyPath);
  const plain = resolved.endsWith(".gz") ? resolved.slice(0, -3) : resolved;
  const base = path.basename(plain);
  if (!base.endsWith(LEGACY_CHAT_SUFFIX)) return null;
  const sessionId = base.slice(0, -LEGACY_CHAT_SUFFIX.length);
  if (!sessionId) return null;
  return path.join(path.dirname(plain), "chat", `${sessionId}.jsonl`);
}

/**
 * Where to read a chat transcript whose session row names `rowPath`: the
 * dedicated file (plain or `.gz`) when it exists, else `rowPath` unchanged.
 * Non-chat paths (terminal `.log` files) come back unchanged.
 */
export function resolveChatTranscriptReadPath(rowPath: string): string {
  const dedicated = dedicatedChatTranscriptPathFor(rowPath);
  return (dedicated && resolveReadableHistoryPath(dedicated)) ?? rowPath;
}

/** Legacy files left untouched this long have no writer (current builds never append to them). */
const LEGACY_DEDUPE_MIN_IDLE_MS = 10 * 60_000;
const DEDUPE_BETWEEN_FILES_DELAY_MS = 25;
const DEFAULT_DEDUPE_MAX_BYTES_PER_RUN = 1024 * 1024 * 1024;

export type LegacyChatDedupeSummary = {
  filesRemoved: number;
  bytesReclaimed: number;
  filesKept: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function* readLines(filePath: string): AsyncGenerator<string> {
  const input = openHistoryReadStream(filePath);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    input.destroy();
  }
}

const lineKey = (line: string): string => createHash("sha1").update(line).digest("base64");

/**
 * True when every complete event line of the legacy file is also in the
 * dedicated file, at least as many times. Order is not compared: the two
 * files are flushed independently, so the same events can land in a
 * different order. The cap notice, and the event line the cap cut in half,
 * are the only legacy lines allowed to be missing.
 */
async function legacyLinesContainedIn(legacyPath: string, dedicatedPath: string): Promise<boolean> {
  const counts = new Map<string, number>();
  for await (const line of readLines(dedicatedPath)) {
    if (!line) continue;
    const key = lineKey(line);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let pendingMiss: string | null = null;
  for await (const line of readLines(legacyPath)) {
    if (pendingMiss !== null) {
      // Only the line right before the cap notice may be missing (cut mid-event).
      if (!line.startsWith("[ADE] chat transcript limit reached")) return false;
      pendingMiss = null;
      continue;
    }
    if (!line || line.startsWith("[ADE] chat transcript limit reached")) continue;
    const key = lineKey(line);
    const remaining = counts.get(key) ?? 0;
    if (remaining > 0) {
      counts.set(key, remaining - 1);
      continue;
    }
    pendingMiss = line;
  }
  // A missing line not followed by the cap notice is the file's own last line:
  // still fine only if it is a cut (unparseable) event.
  if (pendingMiss !== null) {
    try {
      JSON.parse(pendingMiss);
      return false;
    } catch {
      return true;
    }
  }
  return true;
}

/**
 * Remove legacy `<id>.chat.jsonl[.gz]` copies whose every event is already in
 * the dedicated transcript. Lossless by construction: a file is removed only
 * after its content is proven present in the dedicated file, and only when it
 * did not change while it was checked. Anything unproven is kept.
 */
export async function removeDuplicateLegacyChatTranscripts(args: {
  transcriptsDir: string;
  logger: Logger;
  isPathActive: (filePath: string) => boolean;
  maxBytes?: number;
  now?: () => number;
}): Promise<LegacyChatDedupeSummary> {
  const summary: LegacyChatDedupeSummary = { filesRemoved: 0, bytesReclaimed: 0, filesKept: 0 };
  const now = args.now ?? Date.now;
  const budget = args.maxBytes ?? DEFAULT_DEDUPE_MAX_BYTES_PER_RUN;
  let names: string[];
  try {
    names = await fs.promises.readdir(args.transcriptsDir);
  } catch (error) {
    if (isEnoentError(error)) return summary;
    throw error;
  }
  let bytesRead = 0;
  for (const name of names) {
    if (!name.endsWith(LEGACY_CHAT_SUFFIX) && !name.endsWith(`${LEGACY_CHAT_SUFFIX}.gz`)) continue;
    if (bytesRead >= budget) break;
    const legacyPath = path.join(args.transcriptsDir, name);
    const dedicated = dedicatedChatTranscriptPathFor(legacyPath);
    const dedicatedPath = dedicated ? resolveReadableHistoryPath(dedicated) : null;
    if (!dedicatedPath) continue;
    try {
      const before = await fs.promises.lstat(legacyPath);
      if (!before.isFile() || now() - before.mtimeMs < LEGACY_DEDUPE_MIN_IDLE_MS) continue;
      if (args.isPathActive(legacyPath)) continue;
      // Each check streams the whole dedicated transcript too, so it counts.
      bytesRead += before.size + ((await fs.promises.stat(dedicatedPath).catch(() => null))?.size ?? 0);
      if (!(await legacyLinesContainedIn(legacyPath, dedicatedPath))) {
        summary.filesKept += 1;
        args.logger.info("storage.legacy_chat_transcript_kept", { path: legacyPath, reason: "content_not_in_dedicated" });
        continue;
      }
      const after = await fs.promises.lstat(legacyPath);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || args.isPathActive(legacyPath)) continue;
      await fs.promises.unlink(legacyPath);
      summary.filesRemoved += 1;
      summary.bytesReclaimed += before.size;
    } catch (error) {
      if (isEnoentError(error)) continue;
      // A file another process holds open on Windows (EBUSY/EPERM) is retried next run.
      summary.filesKept += 1;
      args.logger.warn("storage.legacy_chat_transcript_dedupe_failed", {
        path: legacyPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await delay(DEDUPE_BETWEEN_FILES_DELAY_MS);
  }
  if (summary.filesRemoved > 0) {
    args.logger.info("storage.legacy_chat_transcripts_removed", {
      files: summary.filesRemoved,
      bytes: summary.bytesReclaimed,
    });
  }
  return summary;
}
