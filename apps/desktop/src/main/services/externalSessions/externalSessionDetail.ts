import fs from "node:fs";
import type { ExternalSessionProvider } from "../../../shared/types/externalSessions";
import type {
  ExternalSessionDetail,
  ExternalSessionDetailArgs,
  ExternalSessionDetailMessage,
} from "../../../shared/types/externalSessionDetail";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import { discoverExternalSessionRecord, jsonlSourceFor, loadExternalSessionEvents } from "./events";
import {
  asRecord,
  asString,
  canonicalCodexRecords,
  clipExternalSessionText,
  extractText,
  externalSessionMessageFromRecord,
  readJsonlRecordsFromSuffix,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

const DETAIL_TAIL_BYTES = 2 * 1024 * 1024;
const DETAIL_MAX_MESSAGES = 80;
const DETAIL_MESSAGE_MAX_CHARS = 4000;
export const EXTERNAL_SESSION_DETAIL_WATCH_DEBOUNCE_MS = 250;

export type ExternalSessionDetailWatch = {
  close: () => void;
};

type WatchEntry = {
  watcher: fs.FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  sourcePath: string | null;
};

const watches = new Map<string, WatchEntry>();
/**
 * Registration is async (the transcript load is awaited before the watcher is
 * installed), so two starts — or a start racing an unwatch — can settle out of
 * order. Each start claims a generation for its key; a start that no longer
 * owns its key when its load resolves installs nothing, so exactly one watcher
 * survives and none is left orphaned behind a replaced map entry.
 */
const watchGenerations = new Map<string, number>();
let nextWatchGeneration = 1;

function assertProvider(value: string): ExternalSessionProvider {
  switch (value) {
    case "claude":
    case "codex":
    case "cursor":
    case "droid":
    case "opencode":
    case "pi":
    case "qwen":
    case "kimi":
    case "grok":
    case "copilot":
      return value;
    default: {
      const _never: never = value as never;
      void _never;
      throw new Error("external session detail provider is invalid.");
    }
  }
}

function clipPreservingNewlines(raw: string, max: number): string {
  const trimmed = raw.replace(/[ \t]+\n/gu, "\n").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function generousMessageFromRecord(record: unknown): ExternalSessionDetailMessage | null {
  const sampled = externalSessionMessageFromRecord(record);
  if (!sampled) return null;
  const extracted = extractText(record);
  const longer = extracted ? clipPreservingNewlines(extracted, DETAIL_MESSAGE_MAX_CHARS) : null;
  const text = longer && longer.length > sampled.text.length
    ? longer
    : clipExternalSessionText(sampled.text, DETAIL_MESSAGE_MAX_CHARS) ?? sampled.text;
  return { role: sampled.role, text, at: sampled.at };
}

function messagesFromEvents(events: readonly AgentChatEventEnvelope[]): ExternalSessionDetailMessage[] {
  const messages: ExternalSessionDetailMessage[] = [];
  for (const { event, timestamp } of events) {
    if (event.type !== "user_message" && event.type !== "text") continue;
    const text = event.text.trim();
    if (!text) continue;
    const at = Date.parse(timestamp);
    messages.push({ role: event.type === "user_message" ? "user" : "assistant", text, at: Number.isFinite(at) ? at : null });
  }
  return messages.slice(-DETAIL_MAX_MESSAGES);
}

function messagesFromRecords(
  provider: ExternalSessionProvider,
  records: unknown[],
): ExternalSessionDetailMessage[] {
  const source = provider === "codex" ? canonicalCodexRecords(records) : records;
  const messages: ExternalSessionDetailMessage[] = [];
  for (const record of source) {
    const message = generousMessageFromRecord(record);
    if (message) messages.push(message);
  }
  return messages.slice(-DETAIL_MAX_MESSAGES);
}

function recoverModel(
  record: ExternalSessionDiscoveryRecord,
  records: unknown[],
): string | null {
  const fromLaunch = record.launch?.model?.trim();
  if (fromLaunch) return fromLaunch;
  for (const item of records.slice().reverse()) {
    const obj = asRecord(item);
    if (!obj) continue;
    const payload = asRecord(obj.payload);
    const model = asString(obj.model)
      ?? asString(obj.modelId)
      ?? asString(payload?.model)
      ?? asString(payload?.modelId);
    if (model?.trim()) return model.trim();
  }
  return null;
}

function emptyDetail(args: ExternalSessionDetailArgs): ExternalSessionDetail {
  return {
    provider: args.provider,
    id: args.sessionId,
    cwd: null,
    title: null,
    model: null,
    createdAt: null,
    updatedAt: null,
    messageCount: null,
    messages: [],
    sourcePath: null,
    watchable: false,
  };
}

export function normalizeExternalSessionDetailArgs(arg: unknown): ExternalSessionDetailArgs {
  if (!arg || typeof arg !== "object") {
    throw new Error("external session detail expects an object payload.");
  }
  const record = arg as Record<string, unknown>;
  if (typeof record.provider !== "string") {
    throw new Error("external session detail provider is invalid.");
  }
  if (typeof record.sessionId !== "string" || !record.sessionId.trim()) {
    throw new Error("external session detail sessionId must be a string.");
  }
  const before = typeof record.before === "string" && record.before.trim() ? record.before.trim() : null;
  return {
    provider: assertProvider(record.provider),
    sessionId: record.sessionId.trim(),
    ...(before ? { before } : {}),
  };
}

/** The chat-session id preview events carry; also the renderer's list key. */
export function externalSessionPreviewChatId(provider: ExternalSessionProvider, sessionId: string): string {
  return `external-preview:${provider}:${sessionId}`;
}

/**
 * One session's detail. `messages` stays the text tail old clients (iOS, TUI)
 * read; `events` is the newest page of the full conversation as ADE chat
 * events (or the page before `args.before`), with no "Session imported from"
 * notice. `options.maxEvents` shrinks the page (the phone asks for fewer);
 * paging stays exact because the cursor never encodes a page size.
 */
export async function loadExternalSessionDetail(
  args: ExternalSessionDetailArgs,
  options: { maxEvents?: number; homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExternalSessionDetail> {
  const home = {
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
  const record = await discoverExternalSessionRecord(args.provider, args.sessionId, home);
  if (!record) return emptyDetail(args);
  const sourcePath = record.sourcePath?.trim() || null;
  // The same conversation file the converters read: a session folder or a
  // Cursor `store.db` is not JSONL.
  const jsonlPath = jsonlSourceFor(args.provider, record);
  const suffix = jsonlPath ? readJsonlRecordsFromSuffix(jsonlPath, DETAIL_TAIL_BYTES) : [];
  const page = await loadExternalSessionEvents({
    provider: args.provider,
    sessionId: args.sessionId,
    record,
    chatSessionId: externalSessionPreviewChatId(args.provider, args.sessionId),
    purpose: "preview",
    before: args.before ?? null,
    ...(options.maxEvents != null ? { maxEvents: options.maxEvents } : {}),
    ...home,
  }).catch(() => null);
  // `messages` is the text tail older iOS and TUI clients read. Without a
  // JSONL tail (a store-only Cursor chat) it comes from the preview events.
  const messages = suffix.length
    ? messagesFromRecords(args.provider, suffix)
    : record.messages?.length
      ? record.messages
      : messagesFromEvents(page?.events ?? []);
  return {
    provider: record.provider,
    id: record.id,
    cwd: record.cwd,
    title: record.title,
    model: recoverModel(record, suffix),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messageCount,
    messages,
    sourcePath,
    watchable: Boolean(sourcePath),
    events: page?.events ?? null,
    hasOlder: page?.hasOlder ?? false,
    olderCursor: page?.olderCursor ?? null,
  };
}

function watchKey(senderId: number, watchId: string): string {
  return `${senderId}:${watchId}`;
}

export function stopExternalSessionDetailWatch(senderId: number, watchId: string): void {
  const key = watchKey(senderId, watchId);
  // Drop the generation even when no entry exists yet: a start still awaiting
  // its transcript load must not install a watcher after this unwatch.
  watchGenerations.delete(key);
  const entry = watches.get(key);
  if (!entry) return;
  entry.closed = true;
  if (entry.timer) clearTimeout(entry.timer);
  entry.watcher?.close();
  if (entry.sourcePath) fs.unwatchFile(entry.sourcePath);
  watches.delete(key);
}

export function stopExternalSessionDetailWatchesForSender(senderId: number): void {
  const prefix = `${senderId}:`;
  // Include keys that only have a claimed generation so far — those are starts
  // still loading, and they must be cancelled along with the installed ones.
  for (const key of new Set([...watches.keys(), ...watchGenerations.keys()])) {
    if (!key.startsWith(prefix)) continue;
    const watchId = key.slice(prefix.length);
    stopExternalSessionDetailWatch(senderId, watchId);
  }
}

export async function startExternalSessionDetailWatch(args: {
  senderId: number;
  watchId: string;
  provider: ExternalSessionProvider;
  sessionId: string;
  onUpdate: (detail: ExternalSessionDetail) => void;
  /**
   * Loads the detail, first and on every change; the external sessions
   * service's `getDetail`, so the watch reads the same home as a plain get.
   */
  loadDetail: (args: ExternalSessionDetailArgs) => Promise<ExternalSessionDetail>;
}): Promise<ExternalSessionDetail> {
  stopExternalSessionDetailWatch(args.senderId, args.watchId);
  const key = watchKey(args.senderId, args.watchId);
  const generation = nextWatchGeneration++;
  watchGenerations.set(key, generation);
  const { loadDetail } = args;
  const detail = await loadDetail({
    provider: args.provider,
    sessionId: args.sessionId,
  });
  // A newer start (or an unwatch) took the key while this load was in flight.
  // Hand back the snapshot without installing a watcher nobody would close.
  if (watchGenerations.get(key) !== generation) return detail;
  if (!detail.watchable || !detail.sourcePath) {
    watchGenerations.delete(key);
    return detail;
  }

  const entry: WatchEntry = { watcher: null, timer: null, closed: false, sourcePath: detail.sourcePath };
  watches.set(key, entry);

  const emit = () => {
    if (entry.closed) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      // Always the newest page (no `before`): a live update shows the tail,
      // and a client that paged back keeps its older pages.
      void loadDetail({
        provider: args.provider,
        sessionId: args.sessionId,
      }).then((next) => {
        if (!entry.closed) args.onUpdate(next);
      }).catch(() => undefined);
    }, EXTERNAL_SESSION_DETAIL_WATCH_DEBOUNCE_MS);
  };

  try {
    entry.watcher = fs.watch(detail.sourcePath, { persistent: false }, emit);
    entry.watcher.on("error", () => {
      stopExternalSessionDetailWatch(args.senderId, args.watchId);
    });
  } catch {
    entry.watcher = null;
  }
  // `fs.watch` is silent on some hosts for append-only JSONL; poll the inode too.
  fs.watchFile(detail.sourcePath, { interval: 200, persistent: false }, emit);
  return detail;
}
