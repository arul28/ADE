import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { isEnoentError } from "../shared/utils";
import type { ProviderSessionRef } from "./providerHistory";

/**
 * Deleting a lane deletes its chats' session rows (`laneService` removes
 * `terminal_sessions where lane_id = ?`) but leaves their transcript files,
 * which nothing in ADE lists or opens again. These are offered for removal
 * in Settings › Storage, review-first: never removed automatically.
 */

export type DeletedLaneChat = {
  sessionId: string;
  laneId: string;
  /** Every file the chat left: dedicated transcript, legacy copy, metadata records. */
  files: Array<{ path: string; bytes: number; mtimeMs: number }>;
  /** Transcript bytes only (the files under the transcripts directory). */
  transcriptBytes: number;
  lastModifiedMs: number;
};

const SESSION_ID_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.jsonl(\.gz)?$/;
const FIRST_LINE_MAX_BYTES = 64 * 1024;
const INSPECT_CONCURRENCY = 16;

/** The `laneId` of a transcript's `session_init` header, or null when it has none. */
async function readSessionInitLaneId(filePath: string): Promise<string | null> {
  const source = fs.createReadStream(filePath, filePath.endsWith(".gz") ? {} : { end: FIRST_LINE_MAX_BYTES - 1 });
  const input = filePath.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  let text = "";
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      text += chunk.toString("utf8");
      if (text.includes("\n") || text.length >= FIRST_LINE_MAX_BYTES) break;
    }
  } catch {
    return null;
  } finally {
    source.destroy();
    input.destroy();
  }
  const firstLine = text.split("\n", 1)[0] ?? "";
  try {
    const header = JSON.parse(firstLine) as { type?: unknown; laneId?: unknown };
    return header.type === "session_init" && typeof header.laneId === "string" && header.laneId.trim()
      ? header.laneId.trim()
      : null;
  } catch {
    return null;
  }
}

async function statFile(filePath: string): Promise<{ path: string; bytes: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.promises.lstat(filePath);
    return stat.isFile() ? { path: filePath, bytes: stat.size, mtimeMs: stat.mtimeMs } : null;
  } catch (error) {
    if (isEnoentError(error)) return null;
    throw error;
  }
}

/**
 * Chats whose session row is gone AND whose lane no longer exists, idle for
 * at least `minIdleMs`. A transcript without a lane in its header, or whose
 * lane still exists, is never listed (that is a different kind of leftover).
 * An empty lane table lists nothing: an unreadable or brand-new database
 * must never make every chat look deleted.
 */
export async function listDeletedLaneChats(args: {
  transcriptsDir: string;
  chatTranscriptsDir: string;
  chatSessionsDir: string;
  sessionIds: ReadonlySet<string>;
  laneIds: ReadonlySet<string>;
  isPathActive: (filePath: string) => boolean;
  minIdleMs: number;
  now?: number;
}): Promise<DeletedLaneChat[]> {
  if (args.laneIds.size === 0) return [];
  const now = args.now ?? Date.now();
  let names: string[];
  try {
    names = await fs.promises.readdir(args.chatTranscriptsDir);
  } catch (error) {
    if (isEnoentError(error)) return [];
    throw error;
  }
  const bySession = new Map<string, string[]>();
  for (const name of names) {
    const match = SESSION_ID_FILE.exec(name);
    if (!match || args.sessionIds.has(match[1]!)) continue;
    const list = bySession.get(match[1]!) ?? [];
    list.push(path.join(args.chatTranscriptsDir, name));
    bySession.set(match[1]!, list);
  }
  const transcriptsRoot = path.resolve(args.transcriptsDir) + path.sep;
  const inspect = async (sessionId: string, transcriptPaths: string[]): Promise<DeletedLaneChat | null> => {
    const candidates = [
      ...transcriptPaths,
      path.join(args.transcriptsDir, `${sessionId}.chat.jsonl`),
      path.join(args.transcriptsDir, `${sessionId}.chat.jsonl.gz`),
      path.join(args.chatSessionsDir, `${sessionId}.json`),
      path.join(args.chatSessionsDir, `${sessionId}.json.lkg`),
    ];
    const files = (await Promise.all(candidates.map(statFile))).filter((file) => file !== null);
    if (files.some((file) => now - file.mtimeMs < args.minIdleMs || args.isPathActive(file.path))) return null;
    const laneId = await readSessionInitLaneId(transcriptPaths[0]!);
    if (!laneId || args.laneIds.has(laneId)) return null;
    return {
      sessionId,
      laneId,
      files,
      transcriptBytes: files
        .filter((file) => path.resolve(file.path).startsWith(transcriptsRoot))
        .reduce((sum, file) => sum + file.bytes, 0),
      lastModifiedMs: Math.max(...files.map((file) => file.mtimeMs)),
    };
  };
  const chats: DeletedLaneChat[] = [];
  const entries = [...bySession];
  for (let start = 0; start < entries.length; start += INSPECT_CONCURRENCY) {
    const batch = await Promise.all(
      entries.slice(start, start + INSPECT_CONCURRENCY).map(([sessionId, paths]) => inspect(sessionId, paths)),
    );
    for (const chat of batch) if (chat) chats.push(chat);
  }
  return chats.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

/** Binds a confirmation to the exact set of files the person previewed. */
export function deletedLaneChatsIdentity(chats: readonly DeletedLaneChat[]): string {
  const hash = createHash("sha256");
  for (const chat of chats) {
    hash.update(chat.sessionId);
    for (const file of chat.files) hash.update(`\0${file.path}\0${file.bytes}\0${file.mtimeMs}`);
    hash.update("\n");
  }
  return `${chats.length}:${hash.digest("hex")}`;
}

type ChatSessionRecord = { provider?: unknown; sdkSessionId?: unknown; threadId?: unknown; importedFrom?: unknown };

async function readChatSessionRecord(chatSessionsDir: string, sessionId: string): Promise<ChatSessionRecord | null> {
  for (const name of [`${sessionId}.json`, `${sessionId}.json.lkg`]) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(path.join(chatSessionsDir, name), "utf8")) as unknown;
      if (parsed && typeof parsed === "object") return parsed as ChatSessionRecord;
    } catch {
      // missing or unreadable; try the last-known-good copy
    }
  }
  return null;
}

/** The Claude or Codex session a chat's record names, or null (other providers, or nothing recorded). */
function providerSessionRefOf(record: ChatSessionRecord | null): ProviderSessionRef | null {
  if (!record) return null;
  const id = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  if (record.provider === "claude" && id(record.sdkSessionId)) return { provider: "claude", sessionId: id(record.sdkSessionId)! };
  if (record.provider === "codex" && id(record.threadId)) return { provider: "codex", sessionId: id(record.threadId)! };
  return null;
}

/**
 * Provider sessions that ADE started for these deleted-lane chats and that
 * nothing still needs. A chat imported from the person's own CLI is skipped
 * (that session was theirs before ADE saw it), and so is any session another
 * chat that still exists in this project also names.
 */
export async function providerSessionsOfDeletedLaneChats(args: {
  chats: readonly DeletedLaneChat[];
  chatSessionsDir: string;
  liveSessionIds: ReadonlySet<string>;
}): Promise<Array<ProviderSessionRef & { chatSessionId: string }>> {
  const inUse = new Set<string>();
  for (const sessionId of args.liveSessionIds) {
    const ref = providerSessionRefOf(await readChatSessionRecord(args.chatSessionsDir, sessionId));
    if (ref) inUse.add(`${ref.provider}:${ref.sessionId}`);
  }
  const refs: Array<ProviderSessionRef & { chatSessionId: string }> = [];
  const seen = new Set<string>();
  for (const chat of args.chats) {
    const record = await readChatSessionRecord(args.chatSessionsDir, chat.sessionId);
    if (!record || record.importedFrom) continue;
    const ref = providerSessionRefOf(record);
    if (!ref) continue;
    const key = `${ref.provider}:${ref.sessionId}`;
    if (inUse.has(key) || seen.has(key)) continue;
    seen.add(key);
    refs.push({ ...ref, chatSessionId: chat.sessionId });
  }
  return refs;
}
