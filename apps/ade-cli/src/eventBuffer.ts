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
  /**
   * Byte budget for the events one drain returns. The first event always
   * returns, so one large event cannot stall the stream.
   */
  drainMaxBytes?: number;
  /**
   * Events that are delivered to live listeners but never retained for replay.
   * A screencast frame is one: replaying a stale frame is useless, and kept in
   * the buffer each 80-350 KB frame pushes real state changes out of the byte
   * budget within a second, so every reconnect read as a gap. A transient
   * event still takes an id, and it is never measured.
   */
  isTransient?: (event: BufferedEvent) => boolean;
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
  const drainMaxBytes = Math.max(0, Math.floor(options.drainMaxBytes ?? DEFAULT_EVENT_BUFFER_DRAIN_MAX_BYTES));
  let nextId = 1;
  let retainedBytes = 0;
  let lastSkippedCursor: number | null = null;
  // The newest id a drain can no longer return: evicted, or never kept because
  // the buffer retains nothing. Transient ids are not lost -- nobody replays
  // them -- so ids are not contiguous and a gap is judged against this.
  let lostThroughCursor = 0;

  const evictOldest = (): void => {
    const evicted = events.shift();
    if (!evicted) return;
    retainedBytes = Math.max(0, retainedBytes - evicted.bytes);
    lostThroughCursor = evicted.event.id;
  };

  const drainMetadata = (cursor: number): Pick<EventBufferDrainResult, "gap" | "oldestCursor"> => {
    const oldest = events[0]?.event.id ?? null;
    const skippedGap = lastSkippedCursor != null && cursor < lastSkippedCursor;
    const lostGap = cursor < lostThroughCursor;
    if (oldest == null) {
      const gap = lostGap || skippedGap;
      return {
        gap,
        oldestCursor: gap ? nextId : null,
      };
    }
    return {
      gap: lostGap || skippedGap,
      oldestCursor: skippedGap
        ? Math.max(oldest, (lastSkippedCursor ?? 0) + 1)
        : oldest,
    };
  };

  return {
    push(event) {
      const entry: BufferedEvent = { id: nextId++, ...event };
      if (!options.isTransient?.(entry)) {
        const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
        if (bytes > maxEventBytes) {
          lastSkippedCursor = entry.id;
        } else if (capacity > 0 && maxBytes > 0) {
          events.push({ event: entry, bytes });
          retainedBytes += bytes;
          while (events.length > capacity || retainedBytes > maxBytes) {
            evictOldest();
          }
        } else {
          lostThroughCursor = entry.id;
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
    drain(cursor, limit = 100, drainOptions = {}) {
      const clamped = Math.max(1, Math.min(1000, limit));
      const { filter } = drainOptions;
      const maxScan = filter
        ? Math.max(clamped, Math.min(1000, Math.floor(drainOptions.maxScan ?? clamped)))
        : clamped;
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
        if (filter && !filter(entry.event)) {
          nextCursor = entry.event.id;
          continue;
        }
        if (drained.length > 0 && drainedBytes + entry.bytes > drainMaxBytes) break;
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
