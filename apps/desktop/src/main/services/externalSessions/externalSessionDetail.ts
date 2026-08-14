import fs from "node:fs";
import type { ExternalSessionProvider } from "../../../shared/types/externalSessions";
import type {
  ExternalSessionDetail,
  ExternalSessionDetailArgs,
  ExternalSessionDetailMessage,
} from "../../../shared/types/externalSessionDetail";
import { discoverClaudeSessions } from "./discoverClaude";
import { discoverCodexSessions } from "./discoverCodex";
import { discoverCursorSessions } from "./discoverCursor";
import { discoverDroidSessions } from "./discoverDroid";
import { discoverOpenCodeSessions } from "./discoverOpenCode";
import { discoverPiSessions } from "./discoverPi";
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
      return value;
    default: {
      const _never: never = value as never;
      void _never;
      throw new Error("external session detail provider is invalid.");
    }
  }
}

async function discoverRecord(
  provider: ExternalSessionProvider,
  sessionId: string,
): Promise<ExternalSessionDiscoveryRecord | null> {
  const args = { sessionId, limit: 1 };
  switch (provider) {
    case "claude":
      return (await discoverClaudeSessions(args))[0] ?? null;
    case "codex":
      return (await discoverCodexSessions(args))[0] ?? null;
    case "cursor":
      return (await discoverCursorSessions(args))[0] ?? null;
    case "droid":
      return (await discoverDroidSessions(args))[0] ?? null;
    case "opencode":
      return (await discoverOpenCodeSessions(args))[0] ?? null;
    case "pi":
      return (await discoverPiSessions(args))[0] ?? null;
    default: {
      const _never: never = provider;
      return _never;
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
  return {
    provider: assertProvider(record.provider),
    sessionId: record.sessionId.trim(),
  };
}

export async function loadExternalSessionDetail(
  args: ExternalSessionDetailArgs,
): Promise<ExternalSessionDetail> {
  const record = await discoverRecord(args.provider, args.sessionId);
  if (!record) return emptyDetail(args);
  const sourcePath = record.sourcePath?.trim() || null;
  const suffix = sourcePath ? readJsonlRecordsFromSuffix(sourcePath, DETAIL_TAIL_BYTES) : [];
  const messages = suffix.length
    ? messagesFromRecords(args.provider, suffix)
    : (record.messages ?? []);
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
}): Promise<ExternalSessionDetail> {
  stopExternalSessionDetailWatch(args.senderId, args.watchId);
  const key = watchKey(args.senderId, args.watchId);
  const generation = nextWatchGeneration++;
  watchGenerations.set(key, generation);
  const detail = await loadExternalSessionDetail({
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
      void loadExternalSessionDetail({
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
