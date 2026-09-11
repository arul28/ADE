/* @vitest-environment jsdom */

/**
 * The shared presence feed's one race: `getAgentPresence` is a promise, and the
 * last badge on screen can unmount while it is still in flight.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetAgentBrowserPresenceForTest,
  useAnyAgentBrowserPresence,
} from "./agentBrowserPresence";

type Deferred = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
};

function deferred(): Deferred {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function installBrowser(seeds: Deferred[]): void {
  let call = 0;
  (window as unknown as { ade?: unknown }).ade = {
    builtInBrowser: {
      onEvent: () => () => {},
      getAgentPresence: () => {
        const seed = seeds[call] ?? seeds[seeds.length - 1]!;
        call += 1;
        return seed.promise;
      },
    },
  };
}

afterEach(() => {
  cleanup();
  resetAgentBrowserPresenceForTest();
  delete (window as unknown as { ade?: unknown }).ade;
  vi.restoreAllMocks();
});

describe("agentBrowserPresence seed generation", () => {
  it("ignores a seed that lands after the last reader has detached", async () => {
    const first = deferred();
    const second = deferred();
    installBrowser([first, second]);

    const view = renderHook(() => useAnyAgentBrowserPresence());
    expect(view.result.current).toBe(false);
    view.unmount();

    // The answer to the FIRST subscription's seed, arriving after it closed.
    first.resolve([
      { chatSessionId: "chat-a", laneId: null, tabId: null, since: "1", lastActivityAt: "1" },
    ]);
    await first.promise;

    // A new reader must get its own seed rather than inherit the stale one.
    const next = renderHook(() => useAnyAgentBrowserPresence());
    expect(next.result.current).toBe(false);
    second.resolve([
      { chatSessionId: "chat-b", laneId: null, tabId: null, since: "2", lastActivityAt: "2" },
    ]);
    await second.promise;
    await Promise.resolve();
    expect(next.result.current).toBe(true);
  });

  it("applies a seed that lands while the subscription is still open", async () => {
    const seed = deferred();
    installBrowser([seed]);

    const view = renderHook(() => useAnyAgentBrowserPresence());
    seed.resolve([
      { chatSessionId: "chat-a", laneId: null, tabId: null, since: "1", lastActivityAt: "1" },
    ]);
    await seed.promise;
    await Promise.resolve();
    expect(view.result.current).toBe(true);
  });
});
