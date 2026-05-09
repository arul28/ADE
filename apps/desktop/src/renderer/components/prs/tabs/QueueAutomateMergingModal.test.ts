import { describe, expect, it } from "vitest";
import type { PrConvergenceState } from "../../../../shared/types";
import { isWaitingForGithubAutoMerge } from "./queueAutomateMergingRuntime";

function runtime(patch: Partial<PrConvergenceState> = {}): PrConvergenceState {
  return {
    prId: "pr-1",
    autoConvergeEnabled: true,
    pathToMergeActive: true,
    status: "running",
    pollerStatus: "polling",
    currentRound: 0,
    activeSessionId: null,
    activeLaneId: null,
    activeHref: null,
    pauseReason: null,
    errorMessage: null,
    forceFinalizeUsed: false,
    ciRetryAttemptsUsed: 0,
    waitForCiStartedAt: null,
    lastDispatchHeadSha: null,
    lastBotPingHeadSha: null,
    lastBotPingAt: null,
    pauseRepeatCount: 0,
    lastPauseReasonHash: null,
    lastStartedAt: null,
    lastPolledAt: null,
    lastPausedAt: null,
    lastStoppedAt: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...patch,
  };
}

describe("isWaitingForGithubAutoMerge", () => {
  it("keeps queue automation polling after gh auto-merge is armed", () => {
    expect(isWaitingForGithubAutoMerge(runtime({
      status: "converged",
      pollerStatus: "waiting_for_checks",
      pauseReason: "auto-merge armed via gh CLI; waiting for GitHub to land.",
    }))).toBe(true);
  });

  it("does not treat operator-action converged states as active auto-merge waits", () => {
    expect(isWaitingForGithubAutoMerge(runtime({
      status: "converged",
      pollerStatus: "waiting_for_comments",
      pauseReason: "Converged but pipelineSettings.autoMerge is false; click merge when ready.",
    }))).toBe(false);

    expect(isWaitingForGithubAutoMerge(runtime({
      status: "converged",
      pollerStatus: "waiting_for_comments",
      pauseReason: "Inventory clean; merge ladder is blocked: required review.",
    }))).toBe(false);
  });
});
