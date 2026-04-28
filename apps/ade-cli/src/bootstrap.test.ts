import { describe, expect, it } from "vitest";
import { createEventBuffer, type BufferedEvent } from "./eventBuffer";

describe("createEventBuffer", () => {
  it("pushes events and assigns monotonically increasing IDs", () => {
    const buffer = createEventBuffer();

    buffer.push({ timestamp: "2026-03-01T00:00:00Z", category: "orchestrator", payload: { a: 1 } });
    buffer.push({ timestamp: "2026-03-01T00:01:00Z", category: "runtime", payload: { b: 2 } });

    expect(buffer.size()).toBe(2);

    const result = buffer.drain(0);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.id).toBe(1);
    expect(result.events[1]!.id).toBe(2);
    expect(result.events[0]!.category).toBe("orchestrator");
    expect(result.events[1]!.category).toBe("runtime");
    expect(result.nextCursor).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  it("evicts oldest events when capacity is exceeded", () => {
    const buffer = createEventBuffer(3);

    for (let i = 0; i < 5; i++) {
      buffer.push({ timestamp: `2026-03-01T00:0${i}:00Z`, category: "orchestrator", payload: { i } });
    }

    expect(buffer.size()).toBe(3);

    const result = buffer.drain(0);
    // Should have IDs 3, 4, 5 (the oldest 1, 2 were evicted)
    expect(result.events.map((e) => e.id)).toEqual([3, 4, 5]);
    expect(result.events[0]!.payload).toEqual({ i: 2 });
  });

  it("drains events after cursor", () => {
    const buffer = createEventBuffer();

    for (let i = 0; i < 5; i++) {
      buffer.push({ timestamp: `2026-03-01T00:0${i}:00Z`, category: "dag_mutation", payload: { i } });
    }

    const result = buffer.drain(3);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.id).toBe(4);
    expect(result.events[1]!.id).toBe(5);
    expect(result.nextCursor).toBe(5);
    expect(result.hasMore).toBe(false);
  });

  it("returns empty result when cursor is at the end", () => {
    const buffer = createEventBuffer();

    buffer.push({ timestamp: "2026-03-01T00:00:00Z", category: "mission", payload: {} });

    const result = buffer.drain(1);
    expect(result.events).toHaveLength(0);
    expect(result.nextCursor).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it("respects the limit parameter for draining", () => {
    const buffer = createEventBuffer();

    for (let i = 0; i < 10; i++) {
      buffer.push({ timestamp: `2026-03-01T00:0${i}:00Z`, category: "orchestrator", payload: { i } });
    }

    const result = buffer.drain(0, 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0]!.id).toBe(1);
    expect(result.events[2]!.id).toBe(3);
    expect(result.nextCursor).toBe(3);
    expect(result.hasMore).toBe(true);
  });

  it("clamps limit to range [1, 1000]", () => {
    const buffer = createEventBuffer();

    for (let i = 0; i < 5; i++) {
      buffer.push({ timestamp: `2026-03-01T00:0${i}:00Z`, category: "orchestrator", payload: { i } });
    }

    // Limit of 0 should be clamped to 1
    const resultMin = buffer.drain(0, 0);
    expect(resultMin.events).toHaveLength(1);

    // Limit beyond 1000 should be clamped to 1000
    const resultMax = buffer.drain(0, 9999);
    expect(resultMax.events).toHaveLength(5);
  });

  it("returns correct hasMore when more events exist past the limit", () => {
    const buffer = createEventBuffer();

    for (let i = 0; i < 5; i++) {
      buffer.push({ timestamp: `2026-03-01T00:0${i}:00Z`, category: "runtime", payload: { i } });
    }

    const result1 = buffer.drain(0, 2);
    expect(result1.hasMore).toBe(true);
    expect(result1.nextCursor).toBe(2);

    const result2 = buffer.drain(result1.nextCursor, 10);
    expect(result2.hasMore).toBe(false);
    expect(result2.events).toHaveLength(3);
  });

  it("handles drain on empty buffer", () => {
    const buffer = createEventBuffer();

    const result = buffer.drain(0);
    expect(result.events).toHaveLength(0);
    expect(result.nextCursor).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("size returns correct count after pushes and evictions", () => {
    const buffer = createEventBuffer(2);

    expect(buffer.size()).toBe(0);
    buffer.push({ timestamp: "t1", category: "orchestrator", payload: {} });
    expect(buffer.size()).toBe(1);
    buffer.push({ timestamp: "t2", category: "orchestrator", payload: {} });
    expect(buffer.size()).toBe(2);
    buffer.push({ timestamp: "t3", category: "orchestrator", payload: {} });
    expect(buffer.size()).toBe(2);
  });

  it("preserves event category and payload through push and drain", () => {
    const buffer = createEventBuffer();
    const categories: BufferedEvent["category"][] = ["orchestrator", "dag_mutation", "runtime", "mission"];

    for (const category of categories) {
      buffer.push({ timestamp: "t", category, payload: { kind: category } });
    }

    const result = buffer.drain(0);
    expect(result.events).toHaveLength(4);
    for (let i = 0; i < categories.length; i++) {
      expect(result.events[i]!.category).toBe(categories[i]);
      expect(result.events[i]!.payload).toEqual({ kind: categories[i] });
    }
  });
});
