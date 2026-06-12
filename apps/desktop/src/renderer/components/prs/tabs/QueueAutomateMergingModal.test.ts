import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERGENCE_RUNTIME_STATE, type ConvergenceRuntimeStatus, type PrConvergenceState } from "../../../../shared/types";
import { classifyWatcherOutcome } from "./queueAutomateMergingRuntime";

function runtime(status: ConvergenceRuntimeStatus): PrConvergenceState {
  return {
    ...DEFAULT_CONVERGENCE_RUNTIME_STATE,
    prId: "pr-1",
    pathToMergeActive: true,
    status,
  };
}

describe("classifyWatcherOutcome", () => {
  it("treats a ground-truth merge as merged", () => {
    expect(classifyWatcherOutcome(runtime("merged"))).toBe("merged");
  });

  it("keeps the watcher working while the agent is launching, running, or polling", () => {
    expect(classifyWatcherOutcome(runtime("launching"))).toBe("working");
    expect(classifyWatcherOutcome(runtime("running"))).toBe("working");
    expect(classifyWatcherOutcome(runtime("polling"))).toBe("working");
  });

  it("halts on paused, failed, cancelled, or stopped", () => {
    expect(classifyWatcherOutcome(runtime("paused"))).toBe("halted");
    expect(classifyWatcherOutcome(runtime("failed"))).toBe("halted");
    expect(classifyWatcherOutcome(runtime("cancelled"))).toBe("halted");
    expect(classifyWatcherOutcome(runtime("stopped"))).toBe("halted");
  });

  it("defaults to working when there is no runtime yet", () => {
    expect(classifyWatcherOutcome(null)).toBe("working");
  });
});
