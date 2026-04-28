export type BufferedEvent = {
  id: number;
  timestamp: string;
  category: "orchestrator" | "dag_mutation" | "runtime" | "mission";
  payload: Record<string, unknown>;
};

export type EventBuffer = {
  push(event: Omit<BufferedEvent, "id">): void;
  drain(cursor: number, limit?: number): { events: BufferedEvent[]; nextCursor: number; hasMore: boolean };
  size(): number;
};

export function createEventBuffer(capacity = 10_000): EventBuffer {
  const events: BufferedEvent[] = [];
  let nextId = 1;

  return {
    push(event) {
      const entry: BufferedEvent = { id: nextId++, ...event };
      events.push(entry);
      while (events.length > capacity) {
        events.shift();
      }
    },
    drain(cursor, limit = 100) {
      const clamped = Math.max(1, Math.min(1000, limit));
      const startIdx = events.findIndex((e) => e.id > cursor);
      if (startIdx === -1) {
        return { events: [], nextCursor: cursor, hasMore: false };
      }
      const slice = events.slice(startIdx, startIdx + clamped);
      const lastId = slice.length > 0 ? slice[slice.length - 1]!.id : cursor;
      return {
        events: slice,
        nextCursor: lastId,
        hasMore: startIdx + clamped < events.length,
      };
    },
    size() {
      return events.length;
    },
  };
}
