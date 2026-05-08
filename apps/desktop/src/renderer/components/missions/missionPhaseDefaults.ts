import type { ModelConfig, PhaseCard, PhaseProfile } from "../../../shared/types";
import { getDefaultModelDescriptor } from "../../../shared/modelRegistry";

const DEFAULT_CLAUDE_PHASE_MODEL_ID = getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-4-6";
const DEFAULT_CODEX_PHASE_MODEL_ID = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.5";

const DEFAULT_MODELS: Record<string, ModelConfig> = {
  planning: { modelId: DEFAULT_CLAUDE_PHASE_MODEL_ID, thinkingLevel: "medium" },
  development: { modelId: DEFAULT_CODEX_PHASE_MODEL_ID, thinkingLevel: "medium" },
  integration: { modelId: DEFAULT_CODEX_PHASE_MODEL_ID, thinkingLevel: "medium" },
  testing: { modelId: DEFAULT_CODEX_PHASE_MODEL_ID, thinkingLevel: "low" },
  validation: { modelId: DEFAULT_CLAUDE_PHASE_MODEL_ID, thinkingLevel: "medium" },
  closeout: { modelId: DEFAULT_CLAUDE_PHASE_MODEL_ID, thinkingLevel: "medium" },
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
      askQuestions: { enabled: true, maxQuestions: null },
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
      askQuestions: { enabled: false },
      validationGate: { tier: "none", required: false },
      isBuiltIn: true,
      isCustom: false,
      position: 1,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "builtin:integration",
      phaseKey: "integration",
      name: "Integration",
      description: "Join child-lane work into the mission result lane.",
      instructions: "After implementation workers finish, consolidate their outputs, resolve conflicts, and assemble a single reviewable result lane.",
      model: DEFAULT_MODELS.integration,
      budget: {},
      orderingConstraints: { mustFollow: ["development"] },
      askQuestions: { enabled: false },
      validationGate: {
        tier: "self",
        required: true,
        criteria: "All child-lane outputs are accounted for and the result lane can be inspected.",
        evidenceRequirements: ["changed_files_summary", "risk_notes"],
        capabilityFallback: "warn",
      },
      isBuiltIn: true,
      isCustom: false,
      position: 2,
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
      askQuestions: { enabled: false },
      validationGate: { tier: "dedicated", required: true },
      isBuiltIn: true,
      isCustom: false,
      position: 3,
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
      askQuestions: { enabled: false },
      validationGate: { tier: "dedicated", required: true },
      isBuiltIn: true,
      isCustom: false,
      position: 4,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "builtin:closeout",
      phaseKey: "closeout",
      name: "Closeout",
      description: "Collect final proof and present the finished mission output.",
      instructions: "Confirm the result lane, summarize the final product, attach required proof, and leave the mission ready for user review.",
      model: DEFAULT_MODELS.closeout,
      budget: {},
      orderingConstraints: { mustBeLast: true, mustFollow: ["validation"] },
      askQuestions: { enabled: false },
      validationGate: {
        tier: "self",
        required: true,
        criteria: "Outcome summary, changed-files summary, and remaining risks are visible before completion.",
        evidenceRequirements: ["final_outcome_summary", "changed_files_summary", "risk_notes"],
        capabilityFallback: "warn",
      },
      isBuiltIn: true,
      isCustom: false,
      position: 5,
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
      description: "Planning -> Development -> Integration -> Testing -> Validation -> Closeout",
      phases: asPhaseList(["planning", "development", "integration", "testing", "validation", "closeout"]),
      isBuiltIn: true,
      isDefault: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "builtin:tdd",
      name: "TDD",
      description: "Planning -> Testing -> Development -> Integration -> Validation -> Closeout",
      phases: asPhaseList(["planning", "testing", "development", "integration", "validation", "closeout"]),
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
