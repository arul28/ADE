import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StorageItem } from "../../../shared/types/storage";
import { DELETED_LANE_CHATS_ITEM_ID } from "../../../shared/types/storage";
import type { AdeDb } from "../state/kvDb";
import { isEnoentError } from "../shared/utils";
import { liveChatProviderRefsFromPersistedState } from "../externalSessions/liveChatProviderRefs";
import { openHistoryReadStream } from "./historyCompression";
import { legacyChatTranscriptPaths } from "./legacyChatTranscripts";
import { listProviderCopiesOfChats, type ProviderCopy, type ProviderSessionRef } from "./providerHistory";

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
  const input = openHistoryReadStream(filePath, { plainEnd: FIRST_LINE_MAX_BYTES - 1 });
  let text = "";
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      text += chunk.toString("utf8");
      if (text.includes("\n") || text.length >= FIRST_LINE_MAX_BYTES) break;
    }
  } catch {
    // An unreadable header (a truncated .gz) leaves the chat unlisted, which is the safe answer.
    return null;
  } finally {
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
      ...legacyChatTranscriptPaths(args.transcriptsDir, sessionId),
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
 * (that session was theirs before ADE saw it), and so is any session a chat
 * that still exists in this project names in any pointer field, read with the
 * same extractor the importer uses. Other projects cannot hold one of these:
 * the Claude and Codex importers refuse ADE-originated sessions.
 */
export async function providerSessionsOfDeletedLaneChats(args: {
  chats: readonly DeletedLaneChat[];
  chatSessionsDir: string;
  liveSessionIds: ReadonlySet<string>;
}): Promise<Array<ProviderSessionRef & { chatSessionId: string }>> {
  const inUse = new Set<string>();
  for (const sessionId of args.liveSessionIds) {
    // mtime-cached per record, so a repeat scan re-parses only changed chats.
    for (const ref of await liveChatProviderRefsFromPersistedState(args.chatSessionsDir, sessionId)) {
      inUse.add(`${ref.provider}:${ref.externalId}`);
    }
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

/** Binds a provider-copy confirmation to the exact files the person previewed. */
export function providerCopiesIdentity(copies: readonly ProviderCopy[]): string {
  const hash = createHash("sha256");
  for (const copy of copies) {
    for (const file of copy.files) hash.update(`${file.path}\0${file.bytes}\n`);
  }
  return `${copies.length}:${hash.digest("hex")}`;
}

export type DeletedLaneTargetKind = "deleted_lane_chats" | "deleted_lane_provider_sessions";

const plural = (count: number) => `${count} ${count === 1 ? "chat" : "chats"}`;

/**
 * Everything Storage does with a project's chats from deleted lanes: list
 * them, summarize them for the reminder, describe them as a review-first
 * row, and plan a removal. A plan is listed fresh when a removal is confirmed
 * and must match the preview's identity, so a chat that came back (restored,
 * reopened, synced in) since the preview fails the match instead of going.
 */
export function createDeletedLaneStorage(deps: {
  db: AdeDb;
  transcriptsDir: string;
  chatTranscriptsDir: string;
  chatSessionsDir: string;
  isPathActive: (filePath: string) => boolean;
  minIdleMs: number;
}) {
  const liveSessionIds = () => new Set(deps.db.all<{ id: string }>("select id from terminal_sessions").map((row) => row.id));

  const listChats = () => listDeletedLaneChats({
    transcriptsDir: deps.transcriptsDir,
    chatTranscriptsDir: deps.chatTranscriptsDir,
    chatSessionsDir: deps.chatSessionsDir,
    sessionIds: liveSessionIds(),
    laneIds: new Set(deps.db.all<{ id: string }>("select id from lanes").map((row) => row.id)),
    isPathActive: deps.isPathActive,
    minIdleMs: deps.minIdleMs,
  });

  /** The Claude and Codex files ADE started for these chats; lists the chats itself when not given them. */
  const listProviderCopies = async (chats?: readonly DeletedLaneChat[]): Promise<ProviderCopy[]> => {
    const listed = chats ?? await listChats();
    if (listed.length === 0) return [];
    return listProviderCopiesOfChats(await providerSessionsOfDeletedLaneChats({
      chats: listed,
      chatSessionsDir: deps.chatSessionsDir,
      liveSessionIds: liveSessionIds(),
    }));
  };

  const summary = async () => {
    const chats = await listChats();
    return {
      chatCount: chats.length,
      bytes: chats.reduce((sum, chat) => sum + chat.transcriptBytes, 0),
      directory: deps.chatTranscriptsDir,
    };
  };

  /** The review-first row for the chats & history category, or null when there are none. */
  const snapshotItem = (chats: readonly DeletedLaneChat[]): StorageItem | null => {
    if (chats.length === 0) return null;
    return {
      id: DELETED_LANE_CHATS_ITEM_ID,
      label: "Chats from deleted lanes",
      path: deps.chatTranscriptsDir,
      bytes: chats.reduce((sum, chat) => sum + chat.transcriptBytes, 0),
      fileCount: chats.reduce((sum, chat) => sum + chat.files.length, 0),
      lastModifiedAt: new Date(Math.max(...chats.map((chat) => chat.lastModifiedMs))).toISOString(),
      safety: "review_first",
      detail: `${plural(chats.length)} whose lane was deleted. ADE no longer tracks or shows them, but their files are still on this machine, in this folder:`,
    };
  };

  /**
   * What a removal of `kind` would take right now, or null when there is
   * nothing to remove. `files` is exactly what the identity covers: a removal
   * deletes these and nothing else, so it can never take a file the person
   * did not preview.
   */
  const describeTarget = async (kind: DeletedLaneTargetKind): Promise<DeletedLaneTargetPlan | null> => {
    if (kind === "deleted_lane_chats") {
      const chats = await listChats();
      if (chats.length === 0) return null;
      // The chats' own records are the only place their Claude and Codex
      // session ids are kept, so the copies go in the same plan: removing the
      // chats alone would leave those copies where nothing can find them.
      const copies = await listProviderCopies(chats);
      const transcriptBytes = chats.reduce((sum, chat) => sum + chat.transcriptBytes, 0);
      const copyBytes = copies.reduce((sum, copy) => sum + copy.bytes, 0);
      return {
        bytes: transcriptBytes + copyBytes,
        label: copies.length > 0
          ? `${plural(chats.length)} from deleted lanes, with Claude and Codex copies of ${copies.length}`
          : `${plural(chats.length)} from deleted lanes`,
        identity: `${deletedLaneChatsIdentity(chats)}+${providerCopiesIdentity(copies)}`,
        files: [
          ...copies.flatMap((copy) => copy.files),
          ...chats.flatMap((chat) => chat.files.map((file) => ({ path: file.path, bytes: file.bytes, isDirectory: false }))),
        ],
      };
    }
    const copies = await listProviderCopies();
    if (copies.length === 0) return null;
    return {
      bytes: copies.reduce((sum, copy) => sum + copy.bytes, 0),
      label: `Claude and Codex copies of ${plural(copies.length)} from deleted lanes`,
      identity: providerCopiesIdentity(copies),
      files: copies.flatMap((copy) => copy.files),
    };
  };

  return { listChats, listProviderCopies, summary, snapshotItem, describeTarget };
}

export type DeletedLaneTargetPlan = {
  bytes: number;
  label: string;
  identity: string;
  files: Array<{ path: string; bytes: number; isDirectory: boolean }>;
};

/**
 * Delete a plan's files one by one. A file that cannot go (Windows keeps an
 * open file locked) is reported and the rest still go; the folders that hold
 * them always stay.
 */
export async function removeDeletedLanePlanFiles(
  plan: DeletedLaneTargetPlan,
): Promise<{ removedBytes: number; failed: Array<{ path: string; reason: string }> }> {
  let removedBytes = 0;
  const failed: Array<{ path: string; reason: string }> = [];
  for (const file of plan.files) {
    try {
      await fs.promises.rm(file.path, { recursive: file.isDirectory, force: true });
      removedBytes += file.bytes;
    } catch (error) {
      if (isEnoentError(error)) continue;
      failed.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removedBytes, failed };
}

