import fs from "node:fs";
import path from "node:path";
import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  ExternalSessionProvider,
} from "../../../../shared/types";
import {
  finalizeExternalImportEvents,
  MAX_IMPORT_TRANSCRIPT_BYTES,
  type ExternalChatHistoryImportOptions,
} from "../../chat/externalChatHistoryImport";
import type { ExternalSessionDiscoveryRecord } from "../discoveryUtils";
import { claudeRecordsToEvents } from "./claude";
import { codexRecordsToEvents } from "./codex";
import { EnvelopeSink, type JsonlConverter } from "./common";
import { copilotRecordsToEvents } from "./copilot";
import { cursorRecordsToEvents, loadCursorStorePage } from "./cursor";
import { grokRecordsToEvents } from "./grok";
import { kimiRecordsToEvents } from "./kimi";
import { openCodeExportToEvents, runOpenCodeExport } from "./opencode";
import { cutPage, decodeEventsCursor, readJsonlWindow, type EventsCursor } from "./paging";
import { piRecordsToEvents } from "./pi";
import { qwenRecordsToEvents } from "./qwen";
import { discoverExternalSessionRecord } from "./records";

export { discoverExternalSessionRecord } from "./records";
export { decodeEventsCursor, encodeEventsCursor } from "./paging";

/**
 * Why the events are loaded. A preview omits the "Session imported from"
 * notice an import writes at the top of the chat.
 */
export type ExternalSessionEventsPurpose = "preview" | "import";

export type LoadExternalSessionEventsArgs = {
  provider: ExternalSessionProvider;
  sessionId: string;
  /** The discovery record for the session (source path, cwd, sampled messages). */
  record: ExternalSessionDiscoveryRecord | null;
  /** Written into every envelope's `sessionId`. */
  chatSessionId: string;
  laneId?: string | null;
  purpose: ExternalSessionEventsPurpose;
  /** Content events per page (notices excluded). */
  maxEvents?: number;
  /** Cursor from a previous page's `olderCursor`: load the page before it. */
  before?: string | null;
  importedAt?: number;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
};

export type ExternalSessionEventsPage = {
  /** Oldest to newest. */
  events: AgentChatEventEnvelope[];
  hasOlder: boolean;
  olderCursor: string | null;
  /** True when the source was cut (byte or event caps). */
  truncated: boolean;
};

/** Content events per preview page. */
export const EXTERNAL_SESSION_PREVIEW_PAGE_EVENTS = 200;
/** Content events an import keeps, as `externalChatHistoryImport` does. */
export const EXTERNAL_SESSION_IMPORT_MAX_EVENTS = 2000;
/** First byte window a preview page reads from a JSONL store. */
export const EXTERNAL_SESSION_PREVIEW_WINDOW_BYTES = 2 * 1024 * 1024;
/**
 * A preview window grows (doubling) until it holds a full page or reaches
 * this size. Older bytes stay reachable through `olderCursor`.
 */
export const EXTERNAL_SESSION_PREVIEW_MAX_WINDOW_BYTES = 16 * 1024 * 1024;
/** Consecutive empty windows skipped before a page gives up. */
const MAX_EMPTY_WINDOWS = 4;

const JSONL_CONVERTERS: Partial<Record<ExternalSessionProvider, JsonlConverter>> = {
  claude: claudeRecordsToEvents,
  droid: claudeRecordsToEvents,
  codex: codexRecordsToEvents,
  pi: piRecordsToEvents,
  cursor: cursorRecordsToEvents,
  qwen: qwenRecordsToEvents,
  grok: grokRecordsToEvents,
  copilot: copilotRecordsToEvents,
  kimi: kimiRecordsToEvents,
};

/**
 * The JSONL file a provider's converter reads. Discovery may point at the
 * session folder or a sibling file for the ACP stores, so those resolve the
 * conversation file inside the session folder.
 */
export function jsonlSourceFor(provider: ExternalSessionProvider, record: ExternalSessionDiscoveryRecord | null): string | null {
  const sourcePath = record?.sourcePath?.trim();
  if (!sourcePath) return null;
  const inSessionFolder = (...segments: string[]): string | null => {
    if (path.basename(sourcePath) === segments[segments.length - 1]) return sourcePath;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      return null;
    }
    const folder = stat.isDirectory() ? sourcePath : path.dirname(sourcePath);
    const candidate = path.join(folder, ...segments);
    return fs.existsSync(candidate) ? candidate : null;
  };
  switch (provider) {
    case "grok":
      return inSessionFolder("chat_history.jsonl");
    case "copilot":
      return inSessionFolder("events.jsonl");
    case "kimi":
      return sourcePath.toLowerCase().endsWith(".jsonl") ? sourcePath : inSessionFolder("agents", "main", "wire.jsonl");
    default:
      // Cursor sessions known only through `store.db` have no JSONL; see
      // `cursorStoreSourceFor`.
      return sourcePath.toLowerCase().endsWith(".jsonl") ? sourcePath : null;
  }
}

/** A Cursor chat known only through its `store.db` (no agent transcript). */
function cursorStoreSourceFor(record: ExternalSessionDiscoveryRecord | null): string | null {
  const sourcePath = record?.sourcePath?.trim();
  return sourcePath && path.basename(sourcePath) === "store.db" ? sourcePath : null;
}

type RawPage = {
  page: AgentChatEventEnvelope[];
  earlier: AgentChatEventEnvelope[];
  olderCursor: string | null;
  bytesTruncated: boolean;
};

async function loadJsonlPage(args: {
  filePath: string;
  convert: JsonlConverter;
  options: ExternalChatHistoryImportOptions;
  cursor: EventsCursor | null;
  maxEvents: number;
  initialBytes: number;
  maxBytes: number;
  /** Whole windows with no conversation to skip before giving up (0 for import). */
  maxEmptyWindows: number;
  fallbackBaseMs: number;
}): Promise<RawPage | null> {
  let end = args.cursor?.end ?? null;
  const index = args.cursor?.index ?? null;
  let bytes = Math.min(args.maxBytes, args.cursor?.bytes ?? args.initialBytes);
  let emptyWindows = 0;
  for (;;) {
    const window = await readJsonlWindow(args.filePath, { end, maxBytes: bytes });
    if (!window) return null;
    const events = args.convert(window.records, {
      options: args.options,
      lineKeys: window.offsets.map(String),
      // Offsets are absolute, so undated rows stay ordered across windows.
      fallbackMs: (i) => args.fallbackBaseMs + Math.floor((window.offsets[i] ?? 0) / 64),
    });
    if (index === null && window.start > 0) {
      // Too few events for a page: widen this window before cutting it.
      if (events.length < args.maxEvents && bytes < args.maxBytes) {
        bytes = Math.min(args.maxBytes, bytes * 2);
        continue;
      }
      // Nothing conversational in a whole window: step back a window.
      if (events.length === 0 && emptyWindows < args.maxEmptyWindows) {
        emptyWindows += 1;
        end = window.start;
        bytes = args.initialBytes;
        continue;
      }
    }
    const cut = cutPage(events, {
      maxEvents: args.maxEvents,
      index,
      windowStart: window.start,
      windowEnd: window.readEnd,
      windowBytes: bytes,
    });
    return { ...cut, bytesTruncated: window.start > 0 };
  }
}

async function loadOpenCodePage(args: {
  sessionId: string;
  record: ExternalSessionDiscoveryRecord | null;
  options: ExternalChatHistoryImportOptions;
  cursor: EventsCursor | null;
  maxEvents: number;
  fallbackBaseMs: number;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RawPage | null> {
  const exported = await runOpenCodeExport({
    sessionId: args.sessionId,
    cwd: args.record?.cwd ?? null,
    ...(args.homeDir ? { homeDir: args.homeDir } : {}),
    ...(args.env ? { env: args.env } : {}),
  });
  const events = exported == null ? null : openCodeExportToEvents(exported, args.options, args.fallbackBaseMs);
  if (!events) return null;
  const cut = cutPage(events, {
    maxEvents: args.maxEvents,
    index: args.cursor?.index ?? null,
    windowStart: null,
    windowEnd: null,
    windowBytes: null,
  });
  return { ...cut, bytesTruncated: false };
}

function sampledContentEvents(
  record: ExternalSessionDiscoveryRecord | null,
  options: ExternalChatHistoryImportOptions,
): AgentChatEventEnvelope[] {
  const sink = new EnvelopeSink(options);
  (record?.messages ?? []).forEach((message, index) => {
    const timestamp = new Date((message.at ?? record?.createdAt ?? 0) + index).toISOString();
    const id = `sampled:${index}`;
    if (message.role === "user") {
      sink.push({ type: "user_message", text: message.text, messageId: id }, timestamp, id);
    } else {
      sink.text(message.text, timestamp, id);
    }
  });
  return sink.out;
}

/** The conversation of one external session as ADE chat events. */
export async function loadExternalSessionEvents(
  args: LoadExternalSessionEventsArgs,
): Promise<ExternalSessionEventsPage> {
  const record = args.record
    ?? await discoverExternalSessionRecord(args.provider, args.sessionId, {
      ...(args.homeDir ? { homeDir: args.homeDir } : {}),
      ...(args.env ? { env: args.env } : {}),
    }).catch(() => null);
  const isImport = args.purpose === "import";
  const maxEvents = Math.max(1, Math.floor(
    args.maxEvents ?? (isImport ? EXTERNAL_SESSION_IMPORT_MAX_EVENTS : EXTERNAL_SESSION_PREVIEW_PAGE_EVENTS),
  ));
  const importedAt = args.importedAt ?? Date.now();
  const options: ExternalChatHistoryImportOptions = {
    sessionId: args.chatSessionId,
    provider: args.provider,
    externalSessionId: args.sessionId,
    importedAt,
    laneId: args.laneId ?? null,
    maxEvents,
  };
  const cursor = decodeEventsCursor(args.before);
  const fallbackBaseMs = record?.createdAt ?? record?.updatedAt ?? importedAt;
  const byteLimit = isImport ? MAX_IMPORT_TRANSCRIPT_BYTES : EXTERNAL_SESSION_PREVIEW_MAX_WINDOW_BYTES;

  const cursorStorePath = args.provider === "cursor" ? cursorStoreSourceFor(record) : null;
  let raw: RawPage | null = null;
  try {
    if (args.provider === "opencode") {
      raw = await loadOpenCodePage({
        sessionId: args.sessionId,
        record,
        options,
        cursor,
        maxEvents,
        fallbackBaseMs,
        ...(args.homeDir ? { homeDir: args.homeDir } : {}),
        ...(args.env ? { env: args.env } : {}),
      });
    } else if (cursorStorePath) {
      raw = loadCursorStorePage({
        storePath: cursorStorePath,
        options,
        cursor,
        maxEvents,
        maxBytes: byteLimit,
        fallbackBaseMs,
      });
    } else {
      const convert = JSONL_CONVERTERS[args.provider];
      const filePath = convert ? jsonlSourceFor(args.provider, record) : null;
      if (convert && filePath) {
        raw = await loadJsonlPage({
          filePath,
          convert,
          options,
          cursor,
          maxEvents,
          // An import reads its whole byte budget at once, as before.
          initialBytes: isImport ? MAX_IMPORT_TRANSCRIPT_BYTES : EXTERNAL_SESSION_PREVIEW_WINDOW_BYTES,
          maxBytes: byteLimit,
          // An import stays inside its byte budget, as before.
          maxEmptyWindows: isImport ? 0 : MAX_EMPTY_WINDOWS,
          fallbackBaseMs,
        });
      }
    }
  } catch {
    raw = null;
  }

  // Nothing convertible: the sampled messages, on the first page only.
  if (!raw || (!cursor && raw.page.length === 0 && raw.earlier.length === 0)) {
    if (cursor) return { events: [], hasOlder: false, olderCursor: null, truncated: false };
    const sampled = sampledContentEvents(record, options);
    return {
      events: isImport ? finalizeExternalImportEvents(sampled, options) : sampled.slice(-maxEvents),
      hasOlder: false,
      olderCursor: null,
      truncated: sampled.length > maxEvents,
    };
  }

  const hasOlder = raw.olderCursor !== null;
  // Import notices sit on top of the newest page only.
  const events = isImport && !cursor
    ? finalizeExternalImportEvents([...raw.earlier, ...raw.page], {
      ...options,
      transcriptBytesTruncated: raw.bytesTruncated,
      transcriptByteLimit: byteLimit,
    })
    : raw.page;
  return {
    events,
    hasOlder,
    olderCursor: raw.olderCursor,
    truncated: hasOlder,
  };
}
