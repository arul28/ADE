import { randomUUID } from "node:crypto";

export type BufferedEvent = {
  id: number;
  timestamp: string;
  category: "orchestrator" | "dag_mutation" | "runtime" | "pty";
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

export type EventBuffer = {
  push(event: Omit<BufferedEvent, "id">): void;
  drain(cursor: number, limit?: number): EventBufferDrainResult;
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

  const evictOldest = (): void => {
    const evicted = events.shift();
    if (evicted) retainedBytes = Math.max(0, retainedBytes - evicted.bytes);
  };

  const drainMetadata = (cursor: number): Pick<EventBufferDrainResult, "gap" | "oldestCursor"> => {
    const oldest = events[0]?.event.id ?? null;
    if (oldest == null) {
      return {
        gap: cursor < nextId - 1,
        oldestCursor: cursor < nextId - 1 ? nextId : null,
      };
    }
    return {
      gap: cursor < oldest - 1,
      oldestCursor: oldest,
    };
  };

  return {
    push(event) {
      const entry: BufferedEvent = { id: nextId++, ...event };
      const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
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
    drain(cursor, limit = 100) {
      const clamped = Math.max(1, Math.min(1000, limit));
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
      const slice = events.slice(startIdx, startIdx + clamped);
      const drained = slice.map((entry) => entry.event);
      const lastId = drained.length > 0 ? drained[drained.length - 1]!.id : cursor;
      return {
        events: drained,
        nextCursor: lastId,
        hasMore: startIdx + clamped < events.length,
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
