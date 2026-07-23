/* @vitest-environment node */
import { describe, expect, it, vi, afterEach } from "vitest";

import {
  drainOutbox,
  disposeRunOutbox,
  disposeAllOutbox,
} from "./orchestrationOutbox";

/**
 * These tests exercise the module-level deferred-retry timer in isolation via a
 * minimal svc stub. An empty `listDueOutbox` makes the drain pass a no-op while
 * still leaving a future-scheduled entry, which arms exactly one coalesced retry
 * timer — the surface we want to prove is torn down on dispose.
 */
function makeStub(runId: string) {
  const nowMs = 1_000_000;
  const manifest = {
    runId,
    outbox: [
      {
        id: "O-1",
        status: "pending",
        // Scheduled 5s in the future → arms a deferred-retry timer.
        nextAttemptAt: new Date(nowMs + 5_000).toISOString(),
      },
    ],
  };
  const listDueOutbox = vi.fn(() => [] as unknown[]);
  const svc = {
    getManifestForRun: () => manifest,
    nowMs: () => nowMs,
    listDueOutbox,
  } as never;
  return { svc, listDueOutbox, ctx: { runId, bundlePath: "/tmp/bundle" } };
}

describe("orchestrationOutbox deferred-retry timer teardown", () => {
  afterEach(() => {
    disposeAllOutbox();
    vi.useRealTimers();
  });

  it("disposeRunOutbox clears the armed deferred-retry timer (no stray drain after teardown)", async () => {
    vi.useFakeTimers();
    const { svc, listDueOutbox, ctx } = makeStub("R-dispose");

    await drainOutbox(svc, {} as never, ctx);
    // One drain pass ran and armed a timer for the future entry.
    expect(listDueOutbox).toHaveBeenCalledTimes(1);

    disposeRunOutbox(ctx.runId);
    await vi.advanceTimersByTimeAsync(6_000);
    // Timer cleared on teardown → no second drain fired.
    expect(listDueOutbox).toHaveBeenCalledTimes(1);
  });

  it("without teardown the armed timer fires exactly one more drain (control)", async () => {
    vi.useFakeTimers();
    const { svc, listDueOutbox, ctx } = makeStub("R-live");

    await drainOutbox(svc, {} as never, ctx);
    expect(listDueOutbox).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6_000);
    // The armed timer fired one more drain pass.
    expect(listDueOutbox).toHaveBeenCalledTimes(2);
    disposeRunOutbox(ctx.runId);
  });
});
