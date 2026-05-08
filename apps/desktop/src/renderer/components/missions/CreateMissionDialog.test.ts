import { describe, expect, it } from "vitest";
import type { ModelConfig, PhaseCard, PhaseProfile } from "../../../shared/types";
import {
  applyCodexLowFullAutoPresetToDraft,
  applyModelToMissionPhases,
  buildMissionLaunchRequest,
  createCustomPhaseFromTemplate,
  insertPhaseBeforeCloseout,
  phasesMatchProfile,
  withLowReasoning,
  type CreateDraft,
} from "./CreateMissionDialog";

function phase(id: string, phaseKey: string, position: number): PhaseCard {
  return {
    id,
    phaseKey,
    name: phaseKey,
    description: "",
    instructions: "",
    model: { provider: "claude", modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" },
    budget: {},
    orderingConstraints: {},
    askQuestions: { enabled: false },
    validationGate: { tier: "none", required: false },
    isBuiltIn: true,
    isCustom: false,
    position,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("CreateMissionDialog launch helpers", () => {
  it("applies one model config to every phase without mutating the original cards", () => {
    const model: ModelConfig = { provider: "codex", modelId: "openai/gpt-5.5", thinkingLevel: "low" };
    const phases = [phase("phase-1", "planning", 9), phase("phase-2", "development", 10)];

    const result = applyModelToMissionPhases(phases, model);

    expect(result).toEqual([
      expect.objectContaining({ id: "phase-1", position: 0, model }),
      expect.objectContaining({ id: "phase-2", position: 1, model }),
    ]);
    expect(result[0]).not.toBe(phases[0]);
    expect(result[0]!.model).not.toBe(model);
    expect(phases[0]!.model).toMatchObject({ modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" });
  });

  it("keeps phase model overrides in the create mission launch request", () => {
    const model: ModelConfig = { provider: "codex", modelId: "openai/gpt-5.5", thinkingLevel: "low" };
    const activePhases = applyModelToMissionPhases([phase("phase-1", "planning", 0), phase("phase-2", "development", 1)], model);
    const draft: CreateDraft = {
      title: "Smoke mission",
      prompt: "Run a throwaway mission smoke test.",
      laneId: "",
      priority: "normal",
      modelConfig: {
        orchestratorModel: model,
        decisionTimeoutCapHours: 24,
        smartBudget: { enabled: false, fiveHourThresholdUsd: 10, weeklyThresholdUsd: 50 },
      },
      phaseProfileId: "builtin:default",
      phaseOverride: activePhases,
      agentRuntime: { allowParallelAgents: true, allowSubAgents: true, allowClaudeAgentTeams: true },
      permissionConfig: { providers: { codex: "full-auto", codexSandbox: "danger-full-access" } },
    };

    const request = buildMissionLaunchRequest({ draft, activePhases, defaultLaneId: "lane-primary" });

    expect(request.laneId).toBe("lane-primary");
    expect(request.modelConfig?.orchestratorModel).toEqual(model);
    expect(request.phaseProfileId).toBe("builtin:default");
    expect(request.phaseOverride).toHaveLength(2);
    expect(request.phaseOverride?.every((entry) => entry.model.modelId === "openai/gpt-5.5" && entry.model.thinkingLevel === "low")).toBe(true);
    expect(request.autostart).toBe(true);
    expect(request.executionPolicy?.finalizationPolicyKind).toBe("result_lane");
  });

  it("sets low reasoning on the currently selected model without changing the selected model id", () => {
    const selected: ModelConfig = { provider: "codex", modelId: "openai/gpt-5.4", thinkingLevel: "high" };

    expect(withLowReasoning(selected)).toEqual({ provider: "codex", modelId: "openai/gpt-5.4", thinkingLevel: "low" });
    expect(selected.thinkingLevel).toBe("high");
  });

  it("applies the Codex low full-auto preset to orchestrator, phases, and worker permissions", () => {
    const draft: CreateDraft = {
      title: "Smoke mission",
      prompt: "Run a throwaway mission smoke test.",
      laneId: "",
      priority: "normal",
      modelConfig: {
        orchestratorModel: { provider: "claude", modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" },
        decisionTimeoutCapHours: 24,
        smartBudget: { enabled: false, fiveHourThresholdUsd: 10, weeklyThresholdUsd: 50 },
      },
      phaseProfileId: "builtin:default",
      phaseOverride: [phase("phase-1", "planning", 0), phase("phase-2", "development", 1)],
      agentRuntime: { allowParallelAgents: true, allowSubAgents: true, allowClaudeAgentTeams: true },
      permissionConfig: { providers: { claude: "full-auto", codex: "default", codexSandbox: "workspace-write" } },
    };

    const result = applyCodexLowFullAutoPresetToDraft(draft);

    expect(result.modelConfig.orchestratorModel).toMatchObject({
      provider: "codex",
      modelId: "openai/gpt-5.5",
      thinkingLevel: "low",
    });
    expect(result.phaseOverride.every((entry) =>
      entry.model.provider === "codex"
      && entry.model.modelId === "openai/gpt-5.5"
      && entry.model.thinkingLevel === "low",
    )).toBe(true);
    expect(result.permissionConfig.providers).toMatchObject({
      codex: "full-auto",
      codexSandbox: "danger-full-access",
    });
    expect(draft.permissionConfig.providers?.codex).toBe("default");
  });

  it("uses the current orchestrator model for newly added custom phases", () => {
    const model: ModelConfig = { provider: "codex", modelId: "openai/gpt-5.5", thinkingLevel: "low" };

    const result = createCustomPhaseFromTemplate({
      template: "generic",
      index: 2,
      phaseKey: "custom_3",
      at: "2026-01-01T00:00:00.000Z",
      model,
    });

    expect(result.model).toEqual(model);
    expect(result.model).not.toBe(model);
  });

  it("detects when launch phases have drifted from the selected profile", () => {
    const profile: PhaseProfile = {
      id: "builtin:default",
      name: "Default",
      description: "Default phases",
      phases: [phase("phase-1", "planning", 0), phase("phase-2", "development", 1)],
      isBuiltIn: true,
      isDefault: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(phasesMatchProfile(profile, profile.phases)).toBe(true);
    expect(phasesMatchProfile(profile, [profile.phases[1]!, profile.phases[0]!])).toBe(false);
    expect(phasesMatchProfile(profile, applyModelToMissionPhases(profile.phases, { provider: "codex", modelId: "openai/gpt-5.5", thinkingLevel: "low" }))).toBe(false);
  });

  it("inserts custom phases before closeout and renumbers the phase order", () => {
    const phases = [
      phase("phase-1", "planning", 0),
      phase("phase-2", "development", 1),
      phase("phase-3", "closeout", 2),
    ];
    const custom = { ...phase("custom-1", "design_review", 3), isBuiltIn: false, isCustom: true };

    const result = insertPhaseBeforeCloseout(phases, custom);

    expect(result.map((entry) => entry.phaseKey)).toEqual(["planning", "development", "design_review", "closeout"]);
    expect(result.map((entry) => entry.position)).toEqual([0, 1, 2, 3]);
    expect(result[2]?.name).toBe("design_review");
  });
});
