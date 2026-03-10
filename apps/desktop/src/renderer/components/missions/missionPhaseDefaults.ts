import type { ModelConfig, PhaseCard, PhaseProfile } from "../../../shared/types";
import { getDefaultModelDescriptor } from "../../../shared/modelRegistry";

const DEFAULT_CLAUDE_PHASE_MODEL_ID = getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-4-6";
const DEFAULT_CODEX_PHASE_MODEL_ID = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.4-codex";

const DEFAULT_MODELS: Record<string, ModelConfig> = {
  planning: { modelId: DEFAULT_CLAUDE_PHASE_MODEL_ID, thinkingLevel: "medium" },
  development: { modelId: DEFAULT_CODEX_PHASE_MODEL_ID, thinkingLevel: "medium" },
  testing: { modelId: DEFAULT_CODEX_PHASE_MODEL_ID, thinkingLevel: "low" },
  validation: { modelId: DEFAULT_CLAUDE_PHASE_MODEL_ID, thinkingLevel: "medium" },
};

export function createBuiltInMissionPhaseCards(at: string = new Date().toISOString()): PhaseCard[] {
  return [
    {
      id: "builtin:planning",
      phaseKey: "planning",
      name: "Planning",
      description: "Research, clarify requirements, and design the execution DAG.",
      instructions: "Investigate the codebase, identify dependencies/risks, and produce a concrete execution plan before implementation.",
      model: DEFAULT_MODELS.planning,
      budget: {},
      orderingConstraints: { mustBeFirst: true },
      askQuestions: { enabled: true, mode: "auto_if_uncertain", maxQuestions: 5 },
      validationGate: { tier: "none", required: false },
      requiresApproval: true,
      isBuiltIn: true,
      isCustom: false,
      position: 0,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "builtin:development",
      phaseKey: "development",
      name: "Development",
      description: "Implement planned work with lane-scoped workers.",
      instructions: "Execute implementation tasks, update code, and publish structured progress/results.",
      model: DEFAULT_MODELS.development,
      budget: {},
      orderingConstraints: {},
      askQuestions: { enabled: false, mode: "never" },
      validationGate: { tier: "none", required: false },
      isBuiltIn: true,
      isCustom: false,
      position: 1,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "builtin:testing",
      phaseKey: "testing",
      name: "Testing",
      description: "Execute and stabilize test suites.",
      instructions: "Run tests, collect failures, and feed remediation details back into execution.",
      model: DEFAULT_MODELS.testing,
      budget: {},
      orderingConstraints: {},
      askQuestions: { enabled: false, mode: "never" },
      validationGate: { tier: "dedicated", required: true },
      isBuiltIn: true,
      isCustom: false,
      position: 2,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "builtin:validation",
      phaseKey: "validation",
      name: "Validation",
      description: "Cross-check mission output against requested outcomes.",
      instructions: "Validate done criteria, audit risk, and identify remaining obligations before completion.",
      model: DEFAULT_MODELS.validation,
      budget: {},
      orderingConstraints: {},
      askQuestions: { enabled: false, mode: "never" },
      validationGate: { tier: "dedicated", required: true },
      isBuiltIn: true,
      isCustom: false,
      position: 3,
      createdAt: at,
      updatedAt: at,
    },
  ];
}

export function createBuiltInMissionPhaseProfiles(cards: PhaseCard[], at: string = new Date().toISOString()): PhaseProfile[] {
  const byKey = new Map(cards.map((card) => [card.phaseKey, card] as const));
  const asPhaseList = (keys: string[]): PhaseCard[] =>
    keys
      .map((key, index) => {
        const card = byKey.get(key);
        if (!card) return null;
        return { ...card, position: index };
      })
      .filter((card): card is PhaseCard => card != null);

  return [
    {
      id: "builtin:default",
      name: "Default",
      description: "Planning -> Development -> Testing -> Validation",
      phases: asPhaseList(["planning", "development", "testing", "validation"]),
      isBuiltIn: true,
      isDefault: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "builtin:tdd",
      name: "TDD",
      description: "Planning -> Testing -> Development -> Validation",
      phases: asPhaseList(["planning", "testing", "development", "validation"]),
      isBuiltIn: true,
      isDefault: false,
      createdAt: at,
      updatedAt: at,
    },
  ];
}

export function getDefaultBuiltInMissionPhaseProfile(): PhaseProfile {
  const cards = createBuiltInMissionPhaseCards();
  return createBuiltInMissionPhaseProfiles(cards)[0]!;
}
