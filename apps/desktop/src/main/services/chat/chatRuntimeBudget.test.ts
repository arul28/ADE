import { describe, expect, it } from "vitest";
import { createChatRuntimeBudget, type RuntimeBudgetParticipant } from "./chatRuntimeBudget";

/**
 * A stand-in chat service. `runtimes` is the full live set; anything with
 * `evictable: false` is a runtime the service would refuse to release (mid-turn,
 * awaiting input, genuinely working) — it still counts against the budget.
 */
function participant(
  runtimes: Array<{ id: string; lastActivityTimestamp: number; evictable?: boolean }>,
  evicted: string[],
): RuntimeBudgetParticipant {
  const live = new Map(runtimes.map((entry) => [entry.id, entry]));
  return {
    countActiveRuntimes: () => live.size,
    listEvictableRuntimes: (excludeSessionId) =>
      [...live.values()]
        .filter((entry) => entry.evictable !== false && entry.id !== excludeSessionId)
        .map((entry) => ({
          lastActivityTimestamp: entry.lastActivityTimestamp,
          evict: () => {
            live.delete(entry.id);
            evicted.push(entry.id);
          },
        })),
  };
}

describe("createChatRuntimeBudget", () => {
  it("evicts the globally least-recently-used runtime, not the oldest within one service", () => {
    // The whole point of sharing the budget: a host builds one chat service per
    // open project, and the cheapest runtime to lose is the one nobody has
    // touched — whichever project happens to own it.
    const evicted: string[] = [];
    const budget = createChatRuntimeBudget(3);
    budget.register(participant([
      { id: "a-recent", lastActivityTimestamp: 900 },
      { id: "a-older", lastActivityTimestamp: 500 },
    ], evicted));
    budget.register(participant([
      { id: "b-oldest", lastActivityTimestamp: 100 },
    ], evicted));

    budget.enforce("incoming");

    expect(evicted).toEqual(["b-oldest"]);
  });

  it("evicts at most one runtime per call", () => {
    // Draining back to the cap in one pass would run a dozen synchronous
    // teardowns on the main thread the first time a multi-project host came
    // under a shared budget. The cap is enforced incrementally, as it always was.
    const evicted: string[] = [];
    const budget = createChatRuntimeBudget(2);
    budget.register(participant([
      { id: "r1", lastActivityTimestamp: 100 },
      { id: "r2", lastActivityTimestamp: 200 },
      { id: "r3", lastActivityTimestamp: 300 },
      { id: "r4", lastActivityTimestamp: 400 },
    ], evicted));

    budget.enforce("incoming");

    expect(evicted).toEqual(["r1"]);
  });

  it("stays under budget without evicting when there is already room", () => {
    const evicted: string[] = [];
    const budget = createChatRuntimeBudget(5);
    budget.register(participant([{ id: "r1", lastActivityTimestamp: 1 }], evicted));

    budget.enforce("incoming");

    expect(evicted).toEqual([]);
  });

  it("yields rather than tearing down work when nothing is releasable", () => {
    // Being over budget is better than killing a live turn.
    const evicted: string[] = [];
    const budget = createChatRuntimeBudget(1);
    budget.register(participant([
      { id: "busy", lastActivityTimestamp: 1, evictable: false },
    ], evicted));

    expect(() => budget.enforce("incoming")).not.toThrow();
    expect(evicted).toEqual([]);
  });

  it("never evicts the session the budget is making room for", () => {
    const evicted: string[] = [];
    const budget = createChatRuntimeBudget(1);
    budget.register(participant([
      { id: "incoming", lastActivityTimestamp: 1 },
    ], evicted));

    budget.enforce("incoming");

    expect(evicted).toEqual([]);
  });

  it("stops counting a service that has been unregistered", () => {
    // A disposed service must not keep the budget pinned with runtimes that no
    // longer exist — the cap would shrink by one for the life of the process.
    const evicted: string[] = [];
    const budget = createChatRuntimeBudget(2);
    const gone = participant([
      { id: "stale-1", lastActivityTimestamp: 1 },
      { id: "stale-2", lastActivityTimestamp: 2 },
    ], evicted);
    const live = participant([{ id: "live-1", lastActivityTimestamp: 3 }], evicted);
    budget.register(gone);
    budget.register(live);

    budget.unregister(gone);
    budget.enforce("incoming");

    expect(evicted).toEqual([]);
  });
});
