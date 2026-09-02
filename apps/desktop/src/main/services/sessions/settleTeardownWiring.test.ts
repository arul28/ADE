import { describe, expect, it, vi } from "vitest";
import { createSettleTeardownWiring } from "./settleTeardownWiring";

/**
 * The wiring is where teardown meets the chat service, so it is where two
 * whole-feature defects lived: a settle that destroyed the user's queued
 * prompts, and a settle that declared a restarted session quiet while its
 * background job kept running.
 */
describe("settle teardown wiring", () => {
  const neverAborted = { isAborted: () => false, mayInterruptActiveTurn: true };

  function harness(
    summary: Record<string, unknown> | null,
    backgroundJob: "alive" | "gone" | "unknown" = "alive",
  ) {
    const interrupt = vi.fn(async () => ({}));
    const hasLiveClaudeBackgroundJob = vi.fn(async () => backgroundJob);
    const wiring = createSettleTeardownWiring({
      agentChatService: {
        interrupt,
        getSessionSummary: async () => summary as never,
        hasLiveClaudeBackgroundJob,
      },
      surface: "desktop",
    });
    return { wiring, interrupt, hasLiveClaudeBackgroundJob };
  }

  it("never asks a provider to clear the user's queued turns", async () => {
    const { wiring, interrupt } = harness({ status: "active", provider: "claude" });

    await wiring.runSettleTeardown("session-1", neverAborted);

    // `stop_and_clear` cancels queued follow-ups. Losing a settle costs one
    // click; losing prompts the user already typed is unrecoverable. After
    // the stop matrix, settle still stops background work.
    expect(interrupt).toHaveBeenCalledWith({ sessionId: "session-1", mode: "stop_and_background" });
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

  it("ignores a recorded background job the daemon says is already gone", async () => {
    // The short is a RECORD, not a liveness signal — it survives the job
    // finishing. Trusting it alone makes every later settle burn the
    // confirmation budget and then report residue that does not exist.
    const { wiring, interrupt, hasLiveClaudeBackgroundJob } = harness({
      status: "idle",
      provider: "claude",
      activeBackgroundTaskCount: 0,
      claudeBackgroundJobShort: "bg-42",
    }, "gone");

    const outcome = await wiring.runSettleTeardown("session-1", neverAborted);

    expect(hasLiveClaudeBackgroundJob).toHaveBeenCalledWith("bg-42");
    expect(interrupt, "a finished job must not be stopped again").not.toHaveBeenCalled();
    expect(outcome.residue, "a finished job is not residue").toEqual([]);
  });

  it("treats an unreachable daemon as work, not as a finished job", async () => {
    // `getLiveClaudeBackgroundSocket` turns socket and request failures into a
    // null, so "cannot reach the daemon" and "the job is gone" arrive looking
    // identical. Guessing "finished" is the guess that settles over a job that
    // is still running.
    const { wiring, interrupt } = harness({
      status: "idle",
      provider: "claude",
      activeBackgroundTaskCount: 0,
      claudeBackgroundJobShort: "bg-42",
    }, "unknown");

    await wiring.runSettleTeardown("session-1", neverAborted);

    expect(interrupt, "unknown liveness must still attempt the stop").toHaveBeenCalled();
  });

  it("reports residue when a daemon job survives the interrupt", async () => {
    // `interrupt`'s daemon `stop <short>` branch is gated on there being no
    // resident Claude runtime, so a resumed session with a live `--bg` job
    // takes the SDK branch and the daemon job keeps running. Teardown must not
    // call that a clean settle — it cannot stop the job, so it says so.
    const { wiring } = harness({
      status: "idle",
      provider: "claude",
      activeBackgroundTaskCount: 0,
      claudeBackgroundJobShort: "bg-42",
    }, "alive");

    const outcome = await wiring.runSettleTeardown("session-1", neverAborted);

    expect(outcome.residue, "an unstoppable daemon job must be reported").not.toEqual([]);
    expect(outcome.residue[0]?.kind).toBe("background_tasks");
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
