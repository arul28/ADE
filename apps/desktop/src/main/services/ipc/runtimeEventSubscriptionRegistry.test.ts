import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

import { createRuntimeEventSubscriptionRegistry } from "./runtimeEventSubscriptionRegistry";

function fakeSender(id: number): WebContents {
  return {
    id,
    isDestroyed: () => false,
    once: () => {},
  } as unknown as WebContents;
}

describe("createRuntimeEventSubscriptionRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a subscription whose pump only wakes once a minute", async () => {
    const registry = createRuntimeEventSubscriptionRegistry();
    const sender = fakeSender(1);
    const cleanup = vi.fn();
    const subscription = registry.addRuntimeEventSubscription({
      sender,
      bindingKey: "local:/repo",
      requestKey: "local:/repo:*:replay",
      cleanup: null,
    });
    registry.attachRuntimeEventSubscriptionCleanup(
      sender.id,
      subscription.requestKey,
      subscription,
      cleanup,
    );

    // A background window's setTimeout pump is throttled to roughly one wake a
    // minute. Ten of those must not lose it its event feed.
    for (let wake = 0; wake < 10; wake += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        registry.refreshRuntimeEventSubscription(sender.id, subscription.requestKey),
      ).toBe(subscription);
    }

    expect(cleanup).not.toHaveBeenCalled();
    expect(
      registry.getRuntimeEventSubscription(sender.id, subscription.requestKey),
    ).toBe(subscription);
  });

  it("sweeps a subscription whose pump stopped refreshing", async () => {
    const registry = createRuntimeEventSubscriptionRegistry();
    const sender = fakeSender(2);
    const cleanup = vi.fn();
    const subscription = registry.addRuntimeEventSubscription({
      sender,
      bindingKey: "local:/repo",
      requestKey: "local:/repo:*:replay",
      cleanup: null,
    });
    registry.attachRuntimeEventSubscriptionCleanup(
      sender.id,
      subscription.requestKey,
      subscription,
      cleanup,
    );

    await vi.advanceTimersByTimeAsync(181_000);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(
      registry.getRuntimeEventSubscription(sender.id, subscription.requestKey),
    ).toBeNull();
  });
});
