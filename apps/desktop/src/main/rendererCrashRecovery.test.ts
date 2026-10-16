import { describe, expect, it } from "vitest";
import {
  RENDERER_RECOVERY_MAX_ATTEMPTS,
  RENDERER_RECOVERY_WINDOW_MS,
  createRendererCrashRecoveryBudget,
  isRecoverableRenderProcessGone,
} from "./rendererCrashRecovery";

describe("renderer crash recovery policy", () => {
  it("treats a clean exit as teardown, not a crash", () => {
    expect(isRecoverableRenderProcessGone("clean-exit")).toBe(false);
  });

  it("recovers from every abnormal end, including an externally killed renderer", () => {
    // `killed` is what an external `kill <renderer pid>` produces, which is also
    // how this behavior gets verified by hand.
    for (const reason of ["crashed", "oom", "abnormal-exit", "killed", "launch-failed", "integrity-failure"]) {
      expect(isRecoverableRenderProcessGone(reason)).toBe(true);
    }
  });

  it("never spends budget on a clean exit", () => {
    const budget = createRendererCrashRecoveryBudget();

    for (let i = 0; i < 10; i += 1) {
      expect(budget.requestAttempt("clean-exit", 1_000 + i)).toEqual({
        recover: false,
        cause: "clean-exit",
        attempts: 0,
      });
    }
    expect(budget.requestAttempt("crashed", 2_000)).toEqual({ recover: true, attempt: 1 });
  });

  it("stops a boot-crash from reload-looping forever", () => {
    const budget = createRendererCrashRecoveryBudget();

    for (let i = 1; i <= RENDERER_RECOVERY_MAX_ATTEMPTS; i += 1) {
      expect(budget.requestAttempt("crashed", i * 100)).toEqual({ recover: true, attempt: i });
    }
    expect(budget.requestAttempt("crashed", 400)).toEqual({
      recover: false,
      cause: "budget-exhausted",
      attempts: RENDERER_RECOVERY_MAX_ATTEMPTS,
    });
  });

  it("restores the budget once the rolling window clears", () => {
    const budget = createRendererCrashRecoveryBudget();
    const start = 10_000;

    for (let i = 0; i < RENDERER_RECOVERY_MAX_ATTEMPTS; i += 1) {
      expect(budget.requestAttempt("crashed", start + i).recover).toBe(true);
    }
    expect(budget.requestAttempt("crashed", start + 10).recover).toBe(false);

    // A crash well past the window is a new incident, not a continuing loop.
    const afterWindow = start + RENDERER_RECOVERY_WINDOW_MS + 1_000;
    expect(budget.requestAttempt("crashed", afterWindow)).toEqual({ recover: true, attempt: 1 });
  });

  it("expires only the attempts that fell out of the window", () => {
    const budget = createRendererCrashRecoveryBudget({ maxAttempts: 3, windowMs: 1_000 });

    expect(budget.requestAttempt("crashed", 0).recover).toBe(true);
    expect(budget.requestAttempt("crashed", 900).recover).toBe(true);
    expect(budget.requestAttempt("crashed", 950).recover).toBe(true);
    expect(budget.requestAttempt("crashed", 980).recover).toBe(false);

    // t=1500 drops only the t=0 attempt; the other two still count.
    expect(budget.requestAttempt("crashed", 1_500)).toEqual({ recover: true, attempt: 3 });
    expect(budget.requestAttempt("crashed", 1_501).recover).toBe(false);
  });
});
