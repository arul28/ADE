import type {
  AgentChatEventEnvelope,
  AgentChatEventHistoryPage,
} from "../../../shared/types";

const chatEventResidentSizeCache = new WeakMap<AgentChatEventEnvelope, number>();
const chatEventDedupKeyCache = new WeakMap<AgentChatEventEnvelope, string>();

export const INITIAL_SELECTED_CHAT_HISTORY_EVENTS = 1_000;
export const CHAT_HISTORY_PAGE_MAX_BYTES = 256 * 1024;
export const MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS = 60_000;
export const MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES = 32 * 1024 * 1024;
export const MAX_BACKGROUND_CHAT_SESSION_EVENTS = 1_000;
export const MAX_BACKGROUND_CHAT_SESSION_RESIDENT_BYTES = 2 * 1024 * 1024;

export function estimatedChatEventResidentBytes(event: AgentChatEventEnvelope): number {
  const cached = chatEventResidentSizeCache.get(event);
  if (cached !== undefined) return cached;
  let eventBytes: number;
  try {
    eventBytes = JSON.stringify(event).length * 2;
  } catch {
    eventBytes = Number.POSITIVE_INFINITY;
  }
  chatEventResidentSizeCache.set(event, eventBytes);
  return eventBytes;
}

export function trimChatEventHistory(
  events: AgentChatEventEnvelope[],
  maxEvents: number,
  maxBytes = Number.POSITIVE_INFINITY,
): AgentChatEventEnvelope[] {
  const countStart = Math.max(0, events.length - maxEvents);
  if (!Number.isFinite(maxBytes)) {
    return countStart > 0 ? events.slice(countStart) : events;
  }
  let estimatedBytes = 0;
  let byteStart = events.length;
  for (let index = events.length - 1; index >= countStart; index -= 1) {
    const eventBytes = estimatedChatEventResidentBytes(events[index]!);
    if (byteStart < events.length && estimatedBytes + eventBytes > maxBytes) break;
    estimatedBytes += eventBytes;
    byteStart = index;
  }
  const start = Math.max(countStart, byteStart);
  return start > 0 ? events.slice(start) : events;
}

function trimChatEventHistoryFromStart(
  events: AgentChatEventEnvelope[],
  maxEvents: number,
  maxBytes = Number.POSITIVE_INFINITY,
): AgentChatEventEnvelope[] {
  const countEnd = Math.min(events.length, maxEvents);
  if (!Number.isFinite(maxBytes)) {
    return countEnd < events.length ? events.slice(0, countEnd) : events;
  }
  let estimatedBytes = 0;
  let byteEnd = 0;
  for (let index = 0; index < countEnd; index += 1) {
    const eventBytes = estimatedChatEventResidentBytes(events[index]!);
    if (byteEnd > 0 && estimatedBytes + eventBytes > maxBytes) break;
    estimatedBytes += eventBytes;
    byteEnd = index + 1;
  }
  const end = Math.min(countEnd, byteEnd);
  return end < events.length ? events.slice(0, end) : events;
}

export function chatEventDedupKey(entry: AgentChatEventEnvelope): string {
  const cached = chatEventDedupKeyCache.get(entry);
  if (cached !== undefined) return cached;
  const key = `${entry.timestamp}#${entry.event.type}#${JSON.stringify(entry.event)}`;
  chatEventDedupKeyCache.set(entry, key);
  return key;
}

export function prependOlderChatHistoryPage(
  older: AgentChatEventEnvelope[],
  existing: AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  if (!older.length) return existing;
  if (!existing.length) return older.slice();
  const seamWindow = Math.min(existing.length, older.length + 64);
  const seamKeys = new Set<string>();
  for (let index = 0; index < seamWindow; index += 1) {
    seamKeys.add(chatEventDedupKey(existing[index]!));
  }
  const fresh = older.filter((entry) => !seamKeys.has(chatEventDedupKey(entry)));
  return fresh.length ? [...fresh, ...existing] : existing;
}

export function mergeOlderChatHistoryPageWithCap(args: {
  older: AgentChatEventEnvelope[];
  existing: AgentChatEventEnvelope[];
  maxEvents: number;
  maxBytes?: number;
}): { events: AgentChatEventEnvelope[]; hitResidentCap: boolean } {
  const merged = prependOlderChatHistoryPage(args.older, args.existing);
  const events = trimChatEventHistoryFromStart(merged, args.maxEvents, args.maxBytes);
  return {
    events,
    hitResidentCap: events.length < merged.length,
  };
}

export function resolveSnapshotHistoryCursor(snapshot: {
  hasOlderHistory?: boolean | null;
  tailStartOffset?: number | null;
}): number {
  if (snapshot.hasOlderHistory === false) return 0;
  return typeof snapshot.tailStartOffset === "number" && snapshot.tailStartOffset > 0
    ? snapshot.tailStartOffset
    : 0;
}

export function advanceOlderHistoryCursor(
  beforeOffset: number,
  page: Pick<AgentChatEventHistoryPage, "startOffset" | "hasMore">,
): number | null {
  if (!page.hasMore) return 0;
  if (!Number.isFinite(page.startOffset) || page.startOffset <= 0) return null;
  if (page.startOffset >= beforeOffset) return null;
  return page.startOffset;
}

export async function readOlderHistoryBatch(args: {
  sessionId: string;
  beforeOffset: number;
  readPage: (beforeOffset: number) => Promise<AgentChatEventHistoryPage>;
  isCurrent: () => boolean;
  maxEmptyPages?: number;
}): Promise<{ events: AgentChatEventEnvelope[]; nextCursor: number } | null> {
  let currentOffset = args.beforeOffset;
  let nextCursor = args.beforeOffset;
  const maxEmptyPages = args.maxEmptyPages ?? 8;
  for (let attempt = 0; attempt < maxEmptyPages; attempt += 1) {
    const page = await args.readPage(currentOffset);
    if (!args.isCurrent()) return null;
    if (page.unavailable === true) {
      throw new Error("Chat runtime is temporarily unavailable.");
    }
    if (page.sessionId !== args.sessionId) {
      throw new Error("Earlier-message page did not match this chat.");
    }
    if (page.sessionFound === false) {
      return { events: [], nextCursor: 0 };
    }
    const advancedCursor = advanceOlderHistoryCursor(currentOffset, page);
    if (advancedCursor == null) {
      throw new Error("Earlier-message cursor did not advance.");
    }
    nextCursor = advancedCursor;
    if (page.events?.length) {
      return {
        events: page.events.filter((event) => event.sessionId === args.sessionId),
        nextCursor,
      };
    }
    if (nextCursor <= 0) break;
    currentOffset = nextCursor;
  }
  return { events: [], nextCursor };
}

export function resolveMergedSnapshotHistoryCursor(args: {
  snapshotCursor: number;
  currentCursor: number | null | undefined;
  snapshotEvents: AgentChatEventEnvelope[];
  existingEvents: AgentChatEventEnvelope[];
  mergedEvents: AgentChatEventEnvelope[];
  detached: boolean;
}): number {
  if (
    args.snapshotCursor <= 0
    || args.currentCursor !== 0
    || args.detached
    || !args.snapshotEvents.length
    || !args.existingEvents.length
    || !args.mergedEvents.length
  ) {
    return args.snapshotCursor;
  }
  const snapshotKeys = new Set(args.snapshotEvents.map(chatEventDedupKey));
  const snapshotOverlaps = args.existingEvents.some((event) => snapshotKeys.has(chatEventDedupKey(event)));
  const oldestExistingKey = chatEventDedupKey(args.existingEvents[0]!);
  const keptOldestExisting = args.mergedEvents.some((event) => chatEventDedupKey(event) === oldestExistingKey);
  return snapshotOverlaps && keptOldestExisting
    ? 0
    : args.snapshotCursor;
}
