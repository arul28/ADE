import { randomUUID } from "node:crypto";

import type { RemoteRuntimeEventCategory } from "../../desktop/src/shared/types/remoteRuntime";

export type BufferedEvent = {
  id: number;
  timestamp: string;
  /** See `REMOTE_RUNTIME_EVENT_CATEGORIES` for the list and what each carries. */
  category: RemoteRuntimeEventCategory;
  payload: Record<string, unknown>;
};

export type EventBufferDrainResult = {
  events: BufferedEvent[];
  nextCursor: number;
  hasMore: boolean;
  eventEpoch: string;
  gap: boolean;
  oldestCursor: number | null;
};

export type EventBufferDrainOptions = {
  /**
   * Byte budget for the events one drain returns. The first event always
   * returns, so one large event cannot stall the stream.
   */
  maxBytes?: number;
  /** Returns only matching events. The cursor still moves past the rest. */
  filter?: (event: BufferedEvent) => boolean;
  /** With `filter`: the most events one drain looks at. Defaults to `limit`. */
  maxScan?: number;
};

export type EventBuffer = {
  push(event: Omit<BufferedEvent, "id">): void;
  drain(cursor: number, limit?: number, options?: EventBufferDrainOptions): EventBufferDrainResult;
  subscribe(listener: (event: BufferedEvent) => void): () => void;
  epoch(): string;
  latestCursor(): number;
  size(): number;
};

type RetainedBufferedEvent = {
  event: BufferedEvent;
  bytes: number;
};

export type EventBufferOptions = {
  maxBytes?: number;
  maxEventBytes?: number;
};

const DEFAULT_EVENT_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_EVENT_BUFFER_MAX_EVENT_BYTES = 1024 * 1024;
/**
 * A drain is one RPC reply. A remote desktop reads it over the sync socket, and
 * the host closes an RPC channel when the socket holds 12 MiB it has not sent
 * (`RPC_CHANNEL_BACKPRESSURE_BYTES`). With only a count cap, 200 full-list PR
 * events made an 11.5 MB reply, and the channel closed on every poll. Several
 * event pumps share one socket, so each reply stays small: 1 MiB, or one event
 * when that event alone is larger (the buffer keeps none over 1 MiB).
 */
export const DEFAULT_EVENT_BUFFER_DRAIN_MAX_BYTES = 1024 * 1024;

export function createEventBuffer(
  capacity = 10_000,
  options: EventBufferOptions = {},
): EventBuffer {
  const events: RetainedBufferedEvent[] = [];
  const listeners = new Set<(event: BufferedEvent) => void>();
  const eventEpoch = randomUUID();
  const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? DEFAULT_EVENT_BUFFER_MAX_BYTES));
  const maxEventBytes = Math.max(0, Math.floor(options.maxEventBytes ?? DEFAULT_EVENT_BUFFER_MAX_EVENT_BYTES));
  let nextId = 1;
  let retainedBytes = 0;
  let lastSkippedCursor: number | null = null;

  const evictOldest = (): void => {
    const evicted = events.shift();
    if (evicted) retainedBytes = Math.max(0, retainedBytes - evicted.bytes);
  };

  const drainMetadata = (cursor: number): Pick<EventBufferDrainResult, "gap" | "oldestCursor"> => {
    const oldest = events[0]?.event.id ?? null;
    const skippedGap = lastSkippedCursor != null && cursor < lastSkippedCursor;
    if (oldest == null) {
      const gap = cursor < nextId - 1 || skippedGap;
      return {
        gap,
        oldestCursor: gap ? nextId : null,
      };
    }
    const retainedGap = cursor < oldest - 1;
    return {
      gap: retainedGap || skippedGap,
      oldestCursor: skippedGap
        ? Math.max(oldest, (lastSkippedCursor ?? 0) + 1)
        : oldest,
    };
  };

  return {
    push(event) {
      const entry: BufferedEvent = { id: nextId++, ...event };
      const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (bytes > maxEventBytes) {
        lastSkippedCursor = entry.id;
      }
      if (capacity > 0 && maxBytes > 0 && bytes <= maxEventBytes) {
        events.push({ event: entry, bytes });
        retainedBytes += bytes;
        while (events.length > capacity || retainedBytes > maxBytes) {
          evictOldest();
        }
      }
      for (const listener of [...listeners]) {
        try {
          listener(entry);
        } catch {
          // Event delivery is best-effort; one subscriber must not break producers.
        }
      }
    },
    drain(cursor, limit = 100, options = {}) {
      const clamped = Math.max(1, Math.min(1000, limit));
      const maxScan = options.filter
        ? Math.max(clamped, Math.min(1000, Math.floor(options.maxScan ?? clamped)))
        : clamped;
      const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? DEFAULT_EVENT_BUFFER_DRAIN_MAX_BYTES));
      const metadata = drainMetadata(cursor);
      const startIdx = events.findIndex((e) => e.event.id > cursor);
      if (startIdx === -1) {
        return {
          events: [],
          nextCursor: metadata.gap ? nextId - 1 : cursor,
          hasMore: false,
          eventEpoch,
          ...metadata,
        };
      }
      const drained: BufferedEvent[] = [];
      let drainedBytes = 0;
      let nextCursor = cursor;
      let index = startIdx;
      for (; index < events.length && index - startIdx < maxScan && drained.length < clamped; index += 1) {
        const entry = events[index]!;
        if (options.filter && !options.filter(entry.event)) {
          nextCursor = entry.event.id;
          continue;
        }
        if (drained.length > 0 && drainedBytes + entry.bytes > maxBytes) break;
        drained.push(entry.event);
        drainedBytes += entry.bytes;
        nextCursor = entry.event.id;
      }
      return {
        events: drained,
        nextCursor,
        hasMore: index < events.length,
        eventEpoch,
        ...metadata,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    epoch() {
      return eventEpoch;
    },
    latestCursor() {
      return nextId - 1;
    },
    size() {
      return events.length;
    },
  };
}
