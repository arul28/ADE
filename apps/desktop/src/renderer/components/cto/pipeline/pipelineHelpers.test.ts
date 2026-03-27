import { describe, expect, it } from "vitest";
import type { LinearWorkflowTarget } from "../../../../shared/types/linearSync";
import {
  flattenTargetChain,
  rebuildTargetChain,
  countStages,
  getStageAt,
  insertStageAt,
  removeStageAt,
  updateStageAt,
  createDefaultStage,
  type PipelineStage,
} from "./pipelineHelpers";

/* ── Helpers ── */

function makeTarget(overrides: Partial<LinearWorkflowTarget> = {}): LinearWorkflowTarget {
  return {
    type: "worker_run",
    runMode: "autopilot",
    workerSelector: { mode: "none" },
    laneSelection: "fresh_issue_lane",
    prTiming: "none",
    ...overrides,
  };
}

function makeChain(length: number): LinearWorkflowTarget {
  const types: LinearWorkflowTarget["type"][] = [
    "worker_run",
    "employee_session",
    "mission",
    "pr_resolution",
    "review_gate",
  ];
  let chain: LinearWorkflowTarget | null = null;
  for (let i = length - 1; i >= 0; i--) {
    const stage: LinearWorkflowTarget = {
      type: types[i % types.length],
      runMode: "autopilot",
    };
    if (chain) {
      stage.downstreamTarget = chain;
    }
    chain = stage;
  }
  return chain!;
}

/* ── flattenTargetChain ── */

describe("flattenTargetChain", () => {
  it("returns a single-element array for a target with no downstream", () => {
    const target = makeTarget();
    const stages = flattenTargetChain(target);
    expect(stages).toHaveLength(1);
    expect(stages[0].type).toBe("worker_run");
    expect("downstreamTarget" in stages[0]).toBe(false);
  });

  it("flattens a two-stage chain", () => {
    const target = makeTarget({
      downstreamTarget: {
        type: "review_gate",
        runMode: "manual",
      },
    });
    const stages = flattenTargetChain(target);
    expect(stages).toHaveLength(2);
    expect(stages[0].type).toBe("worker_run");
    expect(stages[1].type).toBe("review_gate");
    expect(stages[1].runMode).toBe("manual");
  });

  it("flattens a deep chain of 5 stages", () => {
    const target = makeChain(5);
    const stages = flattenTargetChain(target);
    expect(stages).toHaveLength(5);
    expect(stages.every((s) => !("downstreamTarget" in s))).toBe(true);
  });

  it("strips downstreamTarget from each stage", () => {
    const target = makeTarget({
      downstreamTarget: {
        type: "mission",
        runMode: "autopilot",
        missionTemplate: "default",
      },
    });
    const stages = flattenTargetChain(target);
    for (const stage of stages) {
      expect(stage).not.toHaveProperty("downstreamTarget");
    }
  });
});

/* ── rebuildTargetChain ── */

describe("rebuildTargetChain", () => {
  it("throws on empty array", () => {
    expect(() => rebuildTargetChain([])).toThrow("Cannot build target chain from empty array");
  });

  it("rebuilds a single stage with no downstreamTarget", () => {
    const stage: PipelineStage = { type: "worker_run", runMode: "autopilot" };
    const chain = rebuildTargetChain([stage]);
    expect(chain.type).toBe("worker_run");
    expect(chain.downstreamTarget).toBeUndefined();
  });

  it("rebuilds a two-stage chain with correct nesting", () => {
    const stages: PipelineStage[] = [
      { type: "worker_run", runMode: "autopilot" },
      { type: "review_gate", runMode: "manual" },
    ];
    const chain = rebuildTargetChain(stages);
    expect(chain.type).toBe("worker_run");
    expect(chain.downstreamTarget).toBeDefined();
    expect(chain.downstreamTarget!.type).toBe("review_gate");
  });

  it("is the inverse of flattenTargetChain", () => {
    const original = makeChain(4);
    const flat = flattenTargetChain(original);
    const rebuilt = rebuildTargetChain(flat);
    // Re-flatten and compare
    const reflat = flattenTargetChain(rebuilt);
    expect(reflat).toEqual(flat);
  });
});

/* ── countStages ── */

describe("countStages", () => {
  it("returns 1 for a single target", () => {
    expect(countStages(makeTarget())).toBe(1);
  });

  it("returns 3 for a 3-stage chain", () => {
    expect(countStages(makeChain(3))).toBe(3);
  });
});

/* ── getStageAt ── */

describe("getStageAt", () => {
  it("returns the stage at the given index", () => {
    const target = makeChain(3);
    const stage = getStageAt(target, 1);
    expect(stage).not.toBeNull();
    expect(stage!.type).toBe("employee_session");
  });

  it("returns null for out-of-bounds index", () => {
    const target = makeTarget();
    expect(getStageAt(target, 5)).toBeNull();
    expect(getStageAt(target, -1)).toBeNull();
  });

  it("returns the first stage at index 0", () => {
    const target = makeChain(3);
    const stage = getStageAt(target, 0);
    expect(stage).not.toBeNull();
    expect(stage!.type).toBe("worker_run");
  });
});

/* ── insertStageAt ── */

describe("insertStageAt", () => {
  it("inserts at the beginning (index 0)", () => {
    const target = makeTarget();
    const newStage: PipelineStage = { type: "review_gate", runMode: "manual" };
    const result = insertStageAt(target, 0, newStage);
    const flat = flattenTargetChain(result);
    expect(flat).toHaveLength(2);
    expect(flat[0].type).toBe("review_gate");
    expect(flat[1].type).toBe("worker_run");
  });

  it("appends at the end", () => {
    const target = makeTarget();
    const newStage: PipelineStage = { type: "mission", runMode: "autopilot" };
    const result = insertStageAt(target, 1, newStage);
    const flat = flattenTargetChain(result);
    expect(flat).toHaveLength(2);
    expect(flat[0].type).toBe("worker_run");
    expect(flat[1].type).toBe("mission");
  });

  it("inserts in the middle of a 3-stage chain", () => {
    const target = makeChain(3);
    const newStage: PipelineStage = { type: "pr_resolution", runMode: "autopilot" };
    const result = insertStageAt(target, 1, newStage);
    const flat = flattenTargetChain(result);
    expect(flat).toHaveLength(4);
    expect(flat[1].type).toBe("pr_resolution");
  });

  it("throws for out-of-bounds index", () => {
    const target = makeTarget();
    const newStage: PipelineStage = { type: "mission", runMode: "autopilot" };
    expect(() => insertStageAt(target, -1, newStage)).toThrow("out of range");
    expect(() => insertStageAt(target, 5, newStage)).toThrow("out of range");
  });
});

/* ── removeStageAt ── */

describe("removeStageAt", () => {
  it("removes a stage from a two-stage chain", () => {
    const target = makeChain(2);
    const result = removeStageAt(target, 1);
    const flat = flattenTargetChain(result);
    expect(flat).toHaveLength(1);
    expect(flat[0].type).toBe("worker_run");
  });

  it("removes the first stage", () => {
    const target = makeChain(2);
    const result = removeStageAt(target, 0);
    const flat = flattenTargetChain(result);
    expect(flat).toHaveLength(1);
    expect(flat[0].type).toBe("employee_session");
  });

  it("throws when removing the only stage", () => {
    const target = makeTarget();
    expect(() => removeStageAt(target, 0)).toThrow("Cannot remove the only stage");
  });

  it("throws for out-of-bounds index", () => {
    const target = makeChain(2);
    expect(() => removeStageAt(target, -1)).toThrow("out of range");
    expect(() => removeStageAt(target, 5)).toThrow("out of range");
  });
});

/* ── updateStageAt ── */

describe("updateStageAt", () => {
  it("updates a stage in place", () => {
    const target = makeChain(3);
    const result = updateStageAt(target, 1, (stage) => ({
      ...stage,
      runMode: "manual",
    }));
    const flat = flattenTargetChain(result);
    expect(flat[1].runMode).toBe("manual");
    // Other stages unchanged
    expect(flat[0].type).toBe("worker_run");
    expect(flat[2].type).toBe("mission");
  });

  it("throws for out-of-bounds index", () => {
    const target = makeTarget();
    expect(() => updateStageAt(target, 5, (s) => s)).toThrow("out of range");
    expect(() => updateStageAt(target, -1, (s) => s)).toThrow("out of range");
  });

  it("preserves chain length", () => {
    const target = makeChain(4);
    const result = updateStageAt(target, 2, (stage) => ({
      ...stage,
      type: "review_gate" as const,
    }));
    expect(countStages(result)).toBe(4);
  });
});

/* ── createDefaultStage ── */

describe("createDefaultStage", () => {
  it("creates a default employee_session stage", () => {
    const stage = createDefaultStage("employee_session");
    expect(stage.type).toBe("employee_session");
    expect(stage.runMode).toBe("assisted");
    expect(stage.sessionTemplate).toBe("default");
    expect(stage.laneSelection).toBe("fresh_issue_lane");
    expect(stage.sessionReuse).toBe("fresh_session");
    expect(stage.prTiming).toBe("none");
  });

  it("creates a default worker_run stage", () => {
    const stage = createDefaultStage("worker_run");
    expect(stage.type).toBe("worker_run");
    expect(stage.runMode).toBe("autopilot");
    expect(stage.workerSelector).toEqual({ mode: "none" });
    expect(stage.laneSelection).toBe("fresh_issue_lane");
    expect(stage.prTiming).toBe("none");
  });

  it("creates a default mission stage", () => {
    const stage = createDefaultStage("mission");
    expect(stage.type).toBe("mission");
    expect(stage.runMode).toBe("autopilot");
    expect(stage.missionTemplate).toBe("default");
  });

  it("creates a default pr_resolution stage", () => {
    const stage = createDefaultStage("pr_resolution");
    expect(stage.type).toBe("pr_resolution");
    expect(stage.runMode).toBe("autopilot");
    expect(stage.prStrategy).toEqual({ kind: "per-lane", draft: true });
    expect(stage.prTiming).toBe("after_target_complete");
  });

  it("creates a default review_gate stage", () => {
    const stage = createDefaultStage("review_gate");
    expect(stage.type).toBe("review_gate");
    expect(stage.runMode).toBe("manual");
  });
});
