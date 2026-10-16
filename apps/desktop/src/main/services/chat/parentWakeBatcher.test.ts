import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatSpawnCompletion } from "../../../shared/types";
import { createParentWakeBatcher } from "./parentWakeBatcher";

const completion = (childSessionId: string) => ({ childSessionId } as unknown as AgentChatSpawnCompletion);

function setup(state: { busy?: boolean; runningSiblings?: Set<string>; failWake?: boolean } = {}) {
  const running = state.runningSiblings ?? new Set<string>();
  const wakes: Array<{ text: string; lead: AgentChatSpawnCompletion }> = [];
  const recorded: AgentChatSpawnCompletion[] = [];
  const delivered: Array<{ completions: number; heldMs: number; joinedLiveTurn: boolean }> = [];
  const batcher = createParentWakeBatcher({
    isParentBusy: () => state.busy === true,
    hasRunningSibling: (_parent, except) => [...running].some((id) => id !== except),
    deliverWake: async (_parent, text, lead) => {
      if (state.failWake) throw new Error("wake failed");
      wakes.push({ text, lead });
    },
    recordBatchedCompletion: (_parent, entry) => { recorded.push(entry); },
    onDelivered: ({ completions, heldMs, joinedLiveTurn }) => { delivered.push({ completions, heldMs, joinedLiveTurn }); },
    holdMs: 1_000,
  });
  return { batcher, running, wakes, recorded, delivered, state };
}

describe("createParentWakeBatcher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("wakes an idle parent once for siblings that finish together", async () => {
    const { batcher, running, wakes, recorded, delivered } = setup({ runningSiblings: new Set(["a", "b"]) });
    const first = batcher.wake("parent", "a", "A done", completion("a"));
    running.delete("a");
    expect(wakes).toHaveLength(0);
    running.delete("b");
    const second = batcher.wake("parent", "b", "B done", completion("b"));
    await Promise.all([first, second]);

    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toContain("2 of your subagents finished");
    expect(wakes[0].text.indexOf("A done")).toBeLessThan(wakes[0].text.indexOf("B done"));
    expect(wakes[0].lead).toEqual(completion("a"));
    // The lead's row is written by the wake itself; only the others are recorded here.
    expect(recorded).toEqual([completion("b")]);
    expect(delivered).toEqual([{ completions: 2, heldMs: 0, joinedLiveTurn: false }]);
  });

  it("sends a held result alone once the hold runs out", async () => {
    const { batcher, wakes, delivered } = setup({ runningSiblings: new Set(["a", "slow"]) });
    const held = batcher.wake("parent", "a", "A done", completion("a"));
    await vi.advanceTimersByTimeAsync(999);
    expect(wakes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await held;
    expect(wakes.map((wake) => wake.text)).toEqual(["A done"]);
    expect(delivered).toEqual([{ completions: 1, heldMs: 1_000, joinedLiveTurn: false }]);
  });

  it("gives a busy parent each result at once, including results held before it turned busy", async () => {
    const { batcher, wakes, delivered } = setup({ busy: true });
    await batcher.wake("parent", "a", "A done", completion("a"));
    expect(delivered).toEqual([{ completions: 1, heldMs: 0, joinedLiveTurn: true }]);

    const { batcher: second, wakes: secondWakes, state: secondState } = setup({ runningSiblings: new Set(["b", "c", "d"]) });
    const held = second.wake("parent", "b", "B done", completion("b"));
    secondState.busy = true;
    await second.wake("parent", "c", "C done", completion("c"));
    await held;
    expect(wakes.map((wake) => wake.text)).toEqual(["A done"]);
    expect(secondWakes).toHaveLength(1);
    expect(secondWakes[0].text).toContain("B done");
    expect(secondWakes[0].text).toContain("C done");
  });

  it("fails every held child when the wake fails or the service shuts down, recording none", async () => {
    const failing = setup({ failWake: true, runningSiblings: new Set(["a", "b"]) });
    const first = failing.batcher.wake("parent", "a", "A done", completion("a"));
    failing.running.clear();
    const second = failing.batcher.wake("parent", "b", "B done", completion("b"));
    await expect(first).rejects.toThrow("wake failed");
    await expect(second).rejects.toThrow("wake failed");
    expect(failing.recorded).toEqual([]);
    expect(failing.delivered).toEqual([]);

    const disposing = setup({ runningSiblings: new Set(["a", "b"]) });
    const held = disposing.batcher.wake("parent", "a", "A done", completion("a"));
    disposing.batcher.dispose();
    await expect(held).rejects.toThrow(/shutting down/);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(disposing.wakes).toEqual([]);
  });
});
