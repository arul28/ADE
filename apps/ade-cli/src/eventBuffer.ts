import { randomUUID } from "node:crypto";

export type BufferedEvent = {
  id: number;
  timestamp: string;
  category: "orchestrator" | "dag_mutation" | "runtime" | "mission" | "pty";
  payload: Record<string, unknown>;
};

export type EventBufferDrainResult = {
  events: BufferedEvent[];
  nextCursor: number;
  hasMore: boolean;
  eventEpoch: string;
};

export type EventBuffer = {
  push(event: Omit<BufferedEvent, "id">): void;
  drain(cursor: number, limit?: number): EventBufferDrainResult;
  subscribe(listener: (event: BufferedEvent) => void): () => void;
  size(): number;
};

export function createEventBuffer(capacity = 10_000): EventBuffer {
  const events: BufferedEvent[] = [];
  const listeners = new Set<(event: BufferedEvent) => void>();
  const eventEpoch = randomUUID();
  let nextId = 1;

  return {
    push(event) {
      const entry: BufferedEvent = { id: nextId++, ...event };
      events.push(entry);
      while (events.length > capacity) {
        events.shift();
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
      const startIdx = events.findIndex((e) => e.id > cursor);
      if (startIdx === -1) {
        return { events: [], nextCursor: cursor, hasMore: false, eventEpoch };
      }
      const slice = events.slice(startIdx, startIdx + clamped);
      const lastId = slice.length > 0 ? slice[slice.length - 1]!.id : cursor;
      return {
        events: slice,
        nextCursor: lastId,
        hasMore: startIdx + clamped < events.length,
        eventEpoch,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    size() {
      return events.length;
    },
  };
}
