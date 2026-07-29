/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_SESSION_RETENTION_FLUSH_MS,
  CHAT_SESSION_RETENTION_TTL_MS,
  MAX_RETAINED_CHAT_SESSIONS,
  adoptRetainedSession,
  configureChatSessionRetention,
  isChatSessionRetained,
  pendingRetainedChatEventCount,
  releaseAllRetainedChatSessions,
  retainChatSession,
  retainedChatSessionCount,
} from "./chatSessionRetention";
import { resolveTurnActive } from "./chatTurnState";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../shared/types";

function envelope(
  sessionId: string,
  event: AgentChatEventEnvelope["event"],
  timestamp: string,
): AgentChatEventEnvelope {
  return { sessionId, timestamp, event } as AgentChatEventEnvelope;
}

function assistantEvent(text: string): AgentChatEventEnvelope["event"] {
  return { type: "text", text };
}

/**
 * Stand-in for AgentChatPane's module-level view cache. Mirrors the real write
 * path's shape (events + derived scalars + a resident cap) without dragging the
 * whole pane in — these are pure-logic tests, nothing renders.
 */
type FakeCacheEntry = { events: AgentChatEventEnvelope[]; turnActive: boolean };

function createHarness(options?: { maxEvents?: number }) {
  const maxEvents = options?.maxEvents ?? 100;
  const cache = new Map<string, FakeCacheEntry>();
  const listeners = new Set<(envelope: AgentChatEventEnvelope) => void>();
  const unsubscribeCalls: string[] = [];
  const appendBatchSizes: number[] = [];
  let subscribeCount = 0;

  // The module coalesces on a timer, so these logic tests drive it explicitly.
  vi.useFakeTimers();

  configureChatSessionRetention({
    subscribe: (listener) => {
      subscribeCount += 1;
      const id = `sub-${subscribeCount}`;
      listeners.add(listener);
      return () => {
        unsubscribeCalls.push(id);
        listeners.delete(listener);
      };
    },
    appendEvents: (sessionId, entries) => {
      appendBatchSizes.push(entries.length);
      const cached = cache.get(sessionId);
      if (!cached) return;
      // Same shape as the real writer: build the dedupe set ONCE for the whole
      // batch, trim to the resident cap, and store only DERIVED scalars — no
      // turnActive policy here.
      const seen = new Set(cached.events.map((existing) => JSON.stringify([existing.timestamp, existing.event])));
      const fresh: AgentChatEventEnvelope[] = [];
      for (const entry of entries) {
        const key = JSON.stringify([entry.timestamp, entry.event]);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(entry);
      }
      if (!fresh.length) return;
      const merged = [...cached.events, ...fresh];
      const trimmed = merged.length > maxEvents ? merged.slice(merged.length - maxEvents) : merged;
      const last = trimmed[trimmed.length - 1]?.event;
      cache.set(sessionId, {
        events: trimmed,
        turnActive: last?.type === "status"
          ? last.turnStatus === "started"
          : last?.type === "done"
            ? false
            : cached.turnActive,
      });
    },
  });

  const deliver = (entry: AgentChatEventEnvelope) => {
    for (const listener of [...listeners]) listener(entry);
  };
  const flush = () => {
    vi.advanceTimersByTime(CHAT_SESSION_RETENTION_FLUSH_MS);
  };

  return {
    cache,
    /** Deliver one envelope and let the coalescing window close. */
    emit: (entry: AgentChatEventEnvelope) => {
      deliver(entry);
      flush();
    },
    /** Deliver without closing the coalescing window (batching tests). */
    deliver,
    flush,
    /** One entry per host `appendEvents` call, holding that batch's size. */
    appendBatchSizes,
    liveListenerCount: () => listeners.size,
    unsubscribeCalls,
    subscribeCount: () => subscribeCount,
  };
}

afterEach(() => {
  releaseAllRetainedChatSessions();
  configureChatSessionRetention(null);
  vi.useRealTimers();
});

describe("chatSessionRetention", () => {
  it("keeps appending events into the view cache after the pane hands off", () => {
    const harness = createHarness();
    harness.cache.set("s1", { events: [envelope("s1", assistantEvent("one"), "t1")], turnActive: false });

    expect(retainChatSession("s1")).toBe(true);
    expect(isChatSessionRetained("s1")).toBe(true);

    harness.emit(envelope("s1", assistantEvent("two"), "t2"));
    harness.emit(envelope("s1", assistantEvent("three"), "t3"));

    expect(harness.cache.get("s1")?.events.map((entry) => (entry.event as { text: string }).text))
      .toEqual(["one", "two", "three"]);
  });

  it("filters by session id and never invents a cache entry", () => {
    const harness = createHarness();
    harness.cache.set("s1", { events: [], turnActive: false });
    retainChatSession("s1");

    harness.emit(envelope("other", assistantEvent("not mine"), "t1"));

    expect(harness.cache.get("s1")?.events).toEqual([]);
    expect(harness.cache.has("other")).toBe(false);
  });

  it("respects the trim cap it is handed", () => {
    const harness = createHarness({ maxEvents: 3 });
    harness.cache.set("s1", { events: [], turnActive: false });
    retainChatSession("s1");

    for (let index = 0; index < 6; index += 1) {
      harness.emit(envelope("s1", assistantEvent(`m${index}`), `t${index}`));
    }

    const events = harness.cache.get("s1")?.events ?? [];
    expect(events).toHaveLength(3);
    expect(events.map((entry) => (entry.event as { text: string }).text)).toEqual(["m3", "m4", "m5"]);
  });

  it("adopt unsubscribes and hands back the current cache", () => {
    const harness = createHarness();
    harness.cache.set("s1", { events: [], turnActive: false });
    retainChatSession("s1");
    harness.emit(envelope("s1", assistantEvent("while hidden"), "t1"));

    expect(adoptRetainedSession("s1")).toBe(true);
    expect(isChatSessionRetained("s1")).toBe(false);
    expect(harness.liveListenerCount()).toBe(0);
    expect(harness.unsubscribeCalls).toEqual(["sub-1"]);
    // The cache the returning pane reads is the one the module kept current.
    expect(harness.cache.get("s1")?.events).toHaveLength(1);
  });

  it("coalesces a burst of envelopes into a single cache write", () => {
    const harness = createHarness();
    harness.cache.set("s1", { events: [], turnActive: false });
    retainChatSession("s1");

    // A streaming turn delivers text deltas far faster than a frame. Each cache
    // write re-walks the whole transcript to dedupe/trim/derive/measure, so one
    // write per envelope would make this hidden chat cost more than the visible
    // one — the exact jank the pane's own 16ms flush exists to avoid.
    for (let index = 0; index < 20; index += 1) {
      harness.deliver(envelope("s1", assistantEvent(`delta-${index}`), `t${index}`));
    }
    // Nothing has been written yet — it is all still buffered.
    expect(harness.appendBatchSizes).toEqual([]);
    expect(pendingRetainedChatEventCount("s1")).toBe(20);

    harness.flush();

    expect(harness.appendBatchSizes).toEqual([20]);
    expect(pendingRetainedChatEventCount("s1")).toBe(0);
    expect(harness.cache.get("s1")?.events).toHaveLength(20);

    // A later burst opens a NEW window rather than being swallowed by the old
    // one, so the buffer is coalescing, not one-shot.
    harness.deliver(envelope("s1", assistantEvent("later"), "t99"));
    harness.flush();
    expect(harness.appendBatchSizes).toEqual([20, 1]);
    expect(harness.cache.get("s1")?.events).toHaveLength(21);
  });

  it("adopt flushes buffered envelopes before it tears the subscription down", () => {
    const harness = createHarness();
    harness.cache.set("s1", { events: [], turnActive: false });
    retainChatSession("s1");

    // Events land inside the coalescing window and the user comes straight
    // back. Adoption must not lose them: the returning pane reads this cache.
    harness.deliver(envelope("s1", assistantEvent("mid-window one"), "t1"));
    harness.deliver(envelope("s1", assistantEvent("mid-window two"), "t2"));
    expect(harness.appendBatchSizes).toEqual([]);

    expect(adoptRetainedSession("s1")).toBe(true);

    expect(harness.appendBatchSizes).toEqual([2]);
    expect(harness.cache.get("s1")?.events.map((entry) => (entry.event as { text: string }).text))
      .toEqual(["mid-window one", "mid-window two"]);
    expect(harness.liveListenerCount()).toBe(0);

    // The pending flush timer went with it — no second write after adoption.
    harness.flush();
    expect(harness.appendBatchSizes).toEqual([2]);
  });

  it("adopting a session that was never retained reports false", () => {
    createHarness();
    expect(adoptRetainedSession("s1")).toBe(false);
    expect(adoptRetainedSession(null)).toBe(false);
  });

  it("holds no reference to pane state: unsubscribe is idempotent and nothing fires after adopt", () => {
    const harness = createHarness();
    harness.cache.set("s1", { events: [], turnActive: false });
    retainChatSession("s1");

    expect(adoptRetainedSession("s1")).toBe(true);
    // Idempotent — a second adopt (or a TTL racing the adopt) must not
    // unsubscribe twice or resurrect the handler.
    expect(adoptRetainedSession("s1")).toBe(false);
    expect(harness.unsubscribeCalls).toEqual(["sub-1"]);

    // Post-adopt traffic must not reach the module handler at all. If the
    // handler had captured pane state this is exactly where a
    // setState-after-unmount would fire.
    harness.emit(envelope("s1", assistantEvent("after adopt"), "t2"));
    expect(harness.cache.get("s1")?.events).toEqual([]);
  });

  it("re-retaining a live session does not stack a second subscription", () => {
    const harness = createHarness();
    harness.cache.set("s1", { events: [], turnActive: false });
    expect(retainChatSession("s1")).toBe(true);
    expect(retainChatSession("s1")).toBe(true);
    expect(harness.subscribeCount()).toBe(1);
    expect(harness.liveListenerCount()).toBe(1);
  });

  it("uses the pane's pinned runtime subscription during handoff", () => {
    const harness = createHarness();
    harness.cache.set("s1", { events: [], turnActive: false });
    const pinnedListeners = new Set<(entry: AgentChatEventEnvelope) => void>();
    const pinnedUnsubscribe = vi.fn();

    expect(retainChatSession("s1", {
      subscribe: (listener) => {
        pinnedListeners.add(listener);
        return () => {
          pinnedListeners.delete(listener);
          pinnedUnsubscribe();
        };
      },
    })).toBe(true);
    expect(harness.subscribeCount()).toBe(0);

    for (const listener of pinnedListeners) {
      listener(envelope("s1", assistantEvent("from pinned runtime"), "t1"));
    }
    harness.flush();
    expect(harness.cache.get("s1")?.events).toHaveLength(1);

    expect(adoptRetainedSession("s1")).toBe(true);
    expect(pinnedUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("drops the subscription on TTL expiry but keeps the warm cache", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.cache.set("s1", { events: [envelope("s1", assistantEvent("one"), "t1")], turnActive: false });
    retainChatSession("s1");
    harness.emit(envelope("s1", assistantEvent("two"), "t2"));

    vi.advanceTimersByTime(CHAT_SESSION_RETENTION_TTL_MS + 1);

    expect(isChatSessionRetained("s1")).toBe(false);
    expect(harness.liveListenerCount()).toBe(0);
    // Warm, just no longer live: the pane still paints instantly on return.
    expect(harness.cache.get("s1")?.events).toHaveLength(2);
    // …and further traffic is genuinely gone, not silently buffered.
    harness.emit(envelope("s1", assistantEvent("three"), "t3"));
    expect(harness.cache.get("s1")?.events).toHaveLength(2);
  });

  it("caps how many sessions can be retained at once", () => {
    const harness = createHarness();
    for (let index = 0; index < MAX_RETAINED_CHAT_SESSIONS + 2; index += 1) {
      harness.cache.set(`s${index}`, { events: [], turnActive: false });
      retainChatSession(`s${index}`);
    }
    expect(retainedChatSessionCount()).toBe(MAX_RETAINED_CHAT_SESSIONS);
    // Oldest-first eviction.
    expect(isChatSessionRetained("s0")).toBe(false);
    expect(isChatSessionRetained(`s${MAX_RETAINED_CHAT_SESSIONS + 1}`)).toBe(true);
  });

  it("is a no-op until a host is configured", () => {
    configureChatSessionRetention(null);
    expect(retainChatSession("s1")).toBe(false);
    expect(isChatSessionRetained("s1")).toBe(false);
  });

  it("stores raw turn scalars so adoption still resolves turnActive from the transcript", () => {
    const harness = createHarness();
    // Cached as ACTIVE — e.g. the pane was hidden mid-turn.
    harness.cache.set("s1", {
      events: [envelope("s1", { type: "status", turnStatus: "started", turnId: "turn-1" } as AgentChatEventEnvelope["event"], "t1")],
      turnActive: true,
    });
    retainChatSession("s1");

    // The turn finished while hidden. The module records the event and the
    // derived scalar; it must NOT be the thing that decides turn policy.
    harness.emit(envelope("s1", { type: "done", turnId: "turn-1" } as AgentChatEventEnvelope["event"], "t2"));

    adoptRetainedSession("s1");
    const cached = harness.cache.get("s1")!;

    // The stored scalar is re-derived from the whole merged list, so the stale
    // `true` cannot survive a terminal event. (`resolveTurnActive` short-
    // circuits on a `true` derived flag, which is exactly why the module must
    // never hand it a stale one.)
    expect(cached.turnActive).toBe(false);

    const staleActiveSummary = { sessionId: "s1", status: "active" } as AgentChatSessionSummary;
    // Adoption funnels through resolveTurnActive: terminal transcript evidence
    // outranks an eventually-consistent "active" summary.
    expect(resolveTurnActive(cached.events, cached.turnActive, staleActiveSummary)).toBe(false);
    // Control: without the terminal event the same summary WOULD read active,
    // so the assertion above is testing the transcript, not a constant.
    expect(resolveTurnActive(cached.events.slice(0, 1), false, staleActiveSummary)).toBe(true);
  });
});

describe("chatSessionRetention host isolation", () => {
  beforeEach(() => {
    releaseAllRetainedChatSessions();
  });

  it("survives a host whose subscribe throws", () => {
    configureChatSessionRetention({
      subscribe: () => {
        throw new Error("bridge gone");
      },
      appendEvents: () => undefined,
    });
    expect(retainChatSession("s1")).toBe(false);
    expect(retainedChatSessionCount()).toBe(0);
  });

  it("survives a host whose unsubscribe throws", () => {
    configureChatSessionRetention({
      subscribe: () => () => {
        throw new Error("bridge gone");
      },
      appendEvents: () => undefined,
    });
    retainChatSession("s1");
    expect(() => adoptRetainedSession("s1")).not.toThrow();
    expect(isChatSessionRetained("s1")).toBe(false);
  });
});
