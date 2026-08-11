import { describe, expect, it, vi } from "vitest";
import { createSettleTeardownWiring } from "./settleTeardownWiring";

/**
 * The wiring is where teardown meets the chat service, so it is where two
 * whole-feature defects lived: a settle that destroyed the user's queued
 * prompts, and a settle that declared a restarted session quiet while its
 * background job kept running.
 */
describe("settle teardown wiring", () => {
  const neverAborted = { isAborted: () => false };

  function harness(summary: Record<string, unknown> | null) {
    const interrupt = vi.fn(async () => ({}));
    const wiring = createSettleTeardownWiring({
      agentChatService: {
        interrupt,
        getSessionSummary: async () => summary as never,
      },
      surface: "desktop",
    });
    return { wiring, interrupt };
  }

  it("never asks a provider to clear the user's queued turns", async () => {
    const { wiring, interrupt } = harness({ status: "active", provider: "claude" });

    await wiring.runSettleTeardown("session-1", neverAborted);

    // `stop_and_clear` cancels queued follow-ups. Losing a settle costs one
    // click; losing prompts the user already typed is unrecoverable.
    expect(interrupt).toHaveBeenCalledWith({ sessionId: "session-1", mode: "stop_only" });
  });

  it("treats a persisted Claude background job as work, even when the runtime is gone", async () => {
    // What a restarted session looks like: no live runtime, so the live count
    // is zero, but the daemon job is still recorded and still running.
    const { wiring, interrupt } = harness({
      status: "idle",
      provider: "claude",
      activeBackgroundTaskCount: 0,
      claudeBackgroundJobShort: "bg-42",
    });

    await wiring.runSettleTeardown("session-1", neverAborted);

    // Without this the settle sees a quiet session, stops nothing, and files it
    // as done over a job that never stopped.
    expect(interrupt, "a persisted background job must still be stopped").toHaveBeenCalled();
  });

  it("does not interrupt a session that is genuinely idle", async () => {
    const { wiring, interrupt } = harness({
      status: "idle",
      provider: "claude",
      activeBackgroundTaskCount: 0,
    });

    const outcome = await wiring.runSettleTeardown("session-1", neverAborted);

    expect(interrupt).not.toHaveBeenCalled();
    expect(outcome.residue).toEqual([]);
  });
});
