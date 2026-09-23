import { describe, expect, it } from "vitest";
import type { AutomationRuleDraft } from "../../../../shared/types";
import { applyStepsToDraft, draftToSteps } from "./draftBridge";

function baseDraft(overrides: Partial<AutomationRuleDraft> = {}): AutomationRuleDraft {
  return {
    name: "Bridge rule",
    enabled: true,
    mode: "review",
    triggers: [{ type: "manual" }],
    trigger: { type: "manual" },
    execution: { kind: "built-in", builtIn: { actions: [] } },
    executor: { mode: "automation-bot" },
    prompt: "",
    reviewProfile: "quick",
    toolPalette: ["repo"],
    contextSources: [],
    guardrails: {},
    outputs: { disposition: "comment-only", createArtifact: false },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: "auto:bridge",
    actions: [],
    legacyActions: [],
    ...overrides,
  } as AutomationRuleDraft;
}

describe("draftBridge step round-trips", () => {
  it("preserves alwaysRun on every step kind through save and reload", () => {
    // Regression: stepRuntime dropped alwaysRun for non-delete-lane steps, so
    // the "Always run" toggle silently reverted on save and the executor
    // skipped the step after an earlier failure.
    const saved = applyStepsToDraft(baseDraft(), [
      { kind: "agent-session", prompt: "do work" },
      { kind: "run-command", command: "npm test", alwaysRun: true },
      { kind: "delete-lane", alwaysRun: true, laneDeleteOptions: { deleteBranch: true } },
    ]);

    const actions = saved.execution?.kind === "built-in" ? saved.execution.builtIn?.actions ?? [] : [];
    expect(actions.map((action) => action.alwaysRun ?? false)).toEqual([false, true, true]);

    const reloaded = draftToSteps(saved);
    expect(reloaded.map((step) => step.alwaysRun ?? false)).toEqual([false, true, true]);
  });

  it("round-trips delete-lane options, delay, and run-tests suite through the draft union", () => {
    const saved = applyStepsToDraft(baseDraft(), [
      { kind: "run-tests", suiteId: "unit" },
      { kind: "delete-lane", afterMinutes: 30, laneDeleteOptions: { deleteBranch: true, deleteRemoteBranch: false, force: true } },
    ]);

    // The planner normalizer reads the draft-union mirror, where run-tests
    // carries `suite` (not the runtime `suiteId`) — the mismatch made saved
    // rules fail validation with "run-tests requires a suite."
    expect(saved.actions).toEqual([
      expect.objectContaining({ type: "run-tests", suite: "unit" }),
      expect.objectContaining({
        type: "delete-lane",
        afterMinutes: 30,
        laneDeleteOptions: { deleteBranch: true, deleteRemoteBranch: false, force: true },
      }),
    ]);
    expect(saved.legacyActions).toEqual(saved.actions);

    const reloaded = draftToSteps(saved);
    expect(reloaded[0]).toMatchObject({ kind: "run-tests", suiteId: "unit" });
    expect(reloaded[1]).toMatchObject({
      kind: "delete-lane",
      afterMinutes: 30,
      laneDeleteOptions: { deleteBranch: true, deleteRemoteBranch: false, force: true },
    });
  });

  it("folds a bare single agent step to agent-session execution and back", () => {
    const saved = applyStepsToDraft(baseDraft(), [
      { kind: "agent-session", prompt: "review the diff", sessionTitle: "Review" },
    ]);

    expect(saved.execution?.kind).toBe("agent-session");
    expect(saved.prompt).toBe("review the diff");
    expect(saved.actions).toEqual([]);

    const reloaded = draftToSteps(saved);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({ kind: "agent-session", prompt: "review the diff", sessionTitle: "Review" });
  });

  it("keeps a solo agent's limits on the session and a chained agent's limits on its action", () => {
    const solo = applyStepsToDraft(baseDraft(), [
      { kind: "agent-session", prompt: "release", stopAfterMin: 120, stopWhenIdleMin: 30 },
    ]);
    // Limits must not block the solo-agent collapse.
    expect(solo.execution?.kind).toBe("agent-session");
    expect(solo.execution?.session).toMatchObject({ stopAfterMin: 120, stopWhenIdleMin: 30 });
    expect(draftToSteps(solo)[0]).toMatchObject({ stopAfterMin: 120, stopWhenIdleMin: 30 });

    const cleared = applyStepsToDraft(solo, [{ kind: "agent-session", prompt: "release" }]);
    expect(cleared.execution?.session).not.toHaveProperty("stopAfterMin");
    expect(cleared.execution?.session).not.toHaveProperty("stopWhenIdleMin");

    const chain = applyStepsToDraft(baseDraft(), [
      { kind: "run-command", command: "npm run build", timeoutMs: 20 * 60_000 },
      { kind: "agent-session", prompt: "ship it", stopWhenIdleMin: 15 },
    ]);
    const actions = chain.execution?.kind === "built-in" ? chain.execution.builtIn?.actions ?? [] : [];
    expect(actions[0]).toMatchObject({ type: "run-command", timeoutMs: 20 * 60_000 });
    expect(actions[1]).toMatchObject({ type: "agent-session", stopWhenIdleMin: 15 });
    expect(chain.actions[1]).toMatchObject({ type: "agent-session", stopWhenIdleMin: 15 });
  });

  it("caps absurd agent limits and drops non-positive ones on save", () => {
    const saved = applyStepsToDraft(baseDraft(), [
      { kind: "agent-session", prompt: "release", stopAfterMin: 10_000_000, stopWhenIdleMin: -5 },
    ]);
    // Past ~24.8 days a timer fires at once, so a huge value is capped at 7 days.
    expect(saved.execution?.session?.stopAfterMin).toBe(7 * 24 * 60);
    expect(saved.execution?.session).not.toHaveProperty("stopWhenIdleMin");
    expect(draftToSteps(saved)[0]).toMatchObject({ stopAfterMin: 7 * 24 * 60 });
  });

  it("drops a legacy step time limit from agent steps so it no longer caps them", () => {
    const legacy = baseDraft({
      execution: {
        kind: "built-in",
        builtIn: { actions: [{ type: "agent-session", prompt: "long job", timeoutMs: 20 * 60_000 }] },
      },
    });
    const steps = draftToSteps(legacy);
    expect(steps[0]).not.toHaveProperty("timeoutMs");
    // Without the stale timeout the lone agent step folds back to a plain agent rule.
    expect(applyStepsToDraft(legacy, steps).execution?.kind).toBe("agent-session");
  });
});
