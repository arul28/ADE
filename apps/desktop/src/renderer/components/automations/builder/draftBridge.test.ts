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
    guardrails: { maxDurationMin: 10 },
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

  it("round-trips a plugin step through the action and the draft-union mirror", () => {
    const saved = applyStepsToDraft(baseDraft(), [
      { kind: "agent-session", prompt: "look at it" },
      {
        kind: "plugin",
        pluginStep: { pluginId: "ade-linear", action: "comment", args: { issueId: "{{trigger.issue.number}}" } },
      },
    ]);

    const actions = saved.execution?.kind === "built-in" ? saved.execution.builtIn?.actions ?? [] : [];
    expect(actions[1]).toMatchObject({
      type: "plugin",
      pluginStep: { pluginId: "ade-linear", action: "comment", args: { issueId: "{{trigger.issue.number}}" } },
    });
    // The normalizer builds the chain from the draft-union mirror, so a step
    // missing from `actions` would save as a rule with the step silently gone.
    expect(saved.actions?.[1]).toMatchObject({
      type: "plugin",
      pluginStep: { pluginId: "ade-linear", action: "comment" },
    });

    const reloaded = draftToSteps(saved);
    expect(reloaded[1]).toMatchObject({
      kind: "plugin",
      pluginStep: { pluginId: "ade-linear", action: "comment", args: { issueId: "{{trigger.issue.number}}" } },
    });
  });

  it("keeps a plugin step whose plugin is not installed rather than dropping it", () => {
    // The rule is the user's authored content: an uninstalled plugin is
    // reversible, and a builder that dropped the step on load would destroy
    // work a reinstall would otherwise restore.
    const saved = applyStepsToDraft(baseDraft(), [
      { kind: "plugin", pluginStep: { pluginId: "gone", action: "doThing" } },
      { kind: "run-command", command: "npm test" },
    ]);

    const reloaded = draftToSteps(saved);
    expect(reloaded.map((step) => step.kind)).toEqual(["plugin", "run-command"]);
    expect(reloaded[0]?.pluginStep).toEqual({ pluginId: "gone", action: "doThing" });
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
});
