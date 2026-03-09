import type {
  MissionStep,
  MissionStepMetadata,
  PhaseCard,
  PhaseProfile,
  SavePhaseProfileArgs,
  ModelConfig,
  MissionPhaseConfiguration,
} from "../../../shared/types";
import { getDefaultModelDescriptor } from "../../../shared/modelRegistry";
/** Inline type — formerly in the deleted missionPlanningService module. */
type MissionPlanStepDraft = {
  index: number;
  title: string;
  detail: string;
  kind: string;
  metadata: Record<string, unknown>;
};
import { phaseModelToExecutorKind } from "../orchestrator/executionPolicy";
import { nowIso } from "../shared/utils";

export const BUILT_IN_PHASE_KEYS = {
  planning: "planning",
  development: "development",
  testing: "testing",
  validation: "validation",
  /** @deprecated Legacy phase key retained only for backward compatibility with existing mission metadata. */
  prAndConflicts: "pr_conflict_resolution",
} as const;

const DEFAULT_CLAUDE_PHASE_MODEL_ID = getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-4-6";
const DEFAULT_CODEX_PHASE_MODEL_ID = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.4-codex";

const DEFAULT_MODELS: Record<string, ModelConfig> = {
  [BUILT_IN_PHASE_KEYS.planning]: { modelId: DEFAULT_CLAUDE_PHASE_MODEL_ID, thinkingLevel: "medium" },
  [BUILT_IN_PHASE_KEYS.development]: { modelId: DEFAULT_CODEX_PHASE_MODEL_ID, thinkingLevel: "medium" },
  [BUILT_IN_PHASE_KEYS.testing]: { modelId: DEFAULT_CODEX_PHASE_MODEL_ID, thinkingLevel: "low" },
  [BUILT_IN_PHASE_KEYS.validation]: { modelId: DEFAULT_CLAUDE_PHASE_MODEL_ID, thinkingLevel: "medium" },
};

export function createBuiltInPhaseCards(at: string = nowIso()): PhaseCard[] {
  return [
    {
      id: `builtin:${BUILT_IN_PHASE_KEYS.planning}`,
      phaseKey: BUILT_IN_PHASE_KEYS.planning,
      name: "Planning",
      description: "Research, clarify requirements, and design the execution DAG.",
      instructions:
        "Investigate the codebase, identify dependencies/risks, and produce a concrete execution plan before implementation.",
      model: DEFAULT_MODELS[BUILT_IN_PHASE_KEYS.planning],
      budget: {},
      orderingConstraints: {
        mustBeFirst: true,
      },
      askQuestions: {
        enabled: true,
        mode: "auto_if_uncertain",
        maxQuestions: 5,
      },
      validationGate: {
        tier: "none",
        required: false,
      },
      isBuiltIn: true,
      isCustom: false,
      position: 0,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: `builtin:${BUILT_IN_PHASE_KEYS.development}`,
      phaseKey: BUILT_IN_PHASE_KEYS.development,
      name: "Development",
      description: "Implement planned work with lane-scoped workers.",
      instructions: "Execute implementation tasks, update code, and publish structured progress/results.",
      model: DEFAULT_MODELS[BUILT_IN_PHASE_KEYS.development],
      budget: {},
      orderingConstraints: {},
      askQuestions: {
        enabled: false,
        mode: "never",
      },
      validationGate: {
        tier: "none",
        required: false,
      },
      isBuiltIn: true,
      isCustom: false,
      position: 1,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: `builtin:${BUILT_IN_PHASE_KEYS.testing}`,
      phaseKey: BUILT_IN_PHASE_KEYS.testing,
      name: "Testing",
      description: "Execute and stabilize test suites.",
      instructions: "Run tests, collect failures, and feed remediation details back into execution.",
      model: DEFAULT_MODELS[BUILT_IN_PHASE_KEYS.testing],
      budget: {},
      orderingConstraints: {},
      askQuestions: {
        enabled: false,
        mode: "never",
      },
      validationGate: {
        tier: "dedicated",
        required: true,
      },
      isBuiltIn: true,
      isCustom: false,
      position: 2,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: `builtin:${BUILT_IN_PHASE_KEYS.validation}`,
      phaseKey: BUILT_IN_PHASE_KEYS.validation,
      name: "Validation",
      description: "Cross-check mission output against requested outcomes.",
      instructions: "Validate done criteria, audit risk, and identify remaining obligations before completion.",
      model: DEFAULT_MODELS[BUILT_IN_PHASE_KEYS.validation],
      budget: {},
      orderingConstraints: {},
      askQuestions: {
        enabled: false,
        mode: "never",
      },
      validationGate: {
        tier: "dedicated",
        required: true,
      },
      isBuiltIn: true,
      isCustom: false,
      position: 3,
      createdAt: at,
      updatedAt: at,
    },
  ];
}

export function createBuiltInPhaseProfiles(cards: PhaseCard[], at: string = nowIso()): PhaseProfile[] {
  const byKey = new Map(cards.map((card) => [card.phaseKey, card] as const));
  const defaultKeys = [
    BUILT_IN_PHASE_KEYS.planning,
    BUILT_IN_PHASE_KEYS.development,
    BUILT_IN_PHASE_KEYS.testing,
    BUILT_IN_PHASE_KEYS.validation,
  ];
  const tddKeys = [
    BUILT_IN_PHASE_KEYS.planning,
    BUILT_IN_PHASE_KEYS.testing,
    BUILT_IN_PHASE_KEYS.development,
    BUILT_IN_PHASE_KEYS.validation,
  ];
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
      phases: asPhaseList(defaultKeys),
      isBuiltIn: true,
      isDefault: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "builtin:tdd",
      name: "TDD",
      description: "Planning -> Testing -> Development -> Validation",
      phases: asPhaseList(tddKeys),
      isBuiltIn: true,
      isDefault: false,
      createdAt: at,
      updatedAt: at,
    },
  ];
}

export function validatePhaseSequence(phases: PhaseCard[]): string[] {
  const errors: string[] = [];
  if (!phases.length) {
    errors.push("At least one phase is required.");
    return errors;
  }

  const byKey = new Map<string, number>();
  let firstDevelopmentIndex = -1;
  let firstPlanningIndex = -1;
  for (let i = 0; i < phases.length; i += 1) {
    const phase = phases[i]!;
    const phaseKey = phase.phaseKey.trim().toLowerCase();
    if (!phaseKey) {
      errors.push(`Phase at position ${i + 1} is missing phaseKey.`);
      continue;
    }
    if (byKey.has(phaseKey)) {
      errors.push(`Duplicate phase key: ${phase.phaseKey}.`);
    }
    byKey.set(phaseKey, i);
    if (phaseKey === BUILT_IN_PHASE_KEYS.development && firstDevelopmentIndex < 0) firstDevelopmentIndex = i;
    if (phaseKey === BUILT_IN_PHASE_KEYS.planning && firstPlanningIndex < 0) firstPlanningIndex = i;
  }

  if (!byKey.has(BUILT_IN_PHASE_KEYS.development)) {
    errors.push("Development phase is required.");
  }
  if (
    firstPlanningIndex >= 0
    && firstDevelopmentIndex >= 0
    && firstPlanningIndex > firstDevelopmentIndex
  ) {
    errors.push("Planning phase must appear before development.");
  }

  return [...new Set(errors)];
}

export function normalizeProfileInput(input: SavePhaseProfileArgs["profile"], now: string = nowIso()): PhaseProfile {
  const phases = input.phases
    .map((phase, index) => ({
      ...phase,
      position: index,
      updatedAt: now,
      createdAt: phase.createdAt ?? now,
    }))
    .sort((a, b) => a.position - b.position)
    .map((phase, index) => ({ ...phase, position: index }));
  return {
    id: input.id?.trim() || "",
    name: input.name.trim(),
    description: input.description?.trim() || "",
    phases,
    isBuiltIn: false,
    isDefault: input.isDefault === true,
    createdAt: now,
    updatedAt: now,
  };
}

function inferPhaseKeyFromStep(kind: string, metadata: MissionStepMetadata | Record<string, unknown>, phases: PhaseCard[]): string {
  const explicit = typeof metadata.phaseKey === "string" ? metadata.phaseKey.trim() : "";
  if (explicit.length && phases.some((phase) => phase.phaseKey === explicit)) {
    return explicit;
  }
  const stepType = typeof metadata.stepType === "string" ? metadata.stepType.trim() : "";
  const lowerKind = kind.toLowerCase();
  const lowerType = stepType.toLowerCase();

  if (lowerType === "analysis" || lowerType === "planning") {
    return phases.some((phase) => phase.phaseKey === BUILT_IN_PHASE_KEYS.planning)
      ? BUILT_IN_PHASE_KEYS.planning
      : BUILT_IN_PHASE_KEYS.development;
  }
  if (lowerType === "test" || lowerKind === "validation") return BUILT_IN_PHASE_KEYS.testing;
  if (lowerType === "milestone") return BUILT_IN_PHASE_KEYS.validation;
  if (lowerType === "review") return BUILT_IN_PHASE_KEYS.validation;
  if (lowerType === "integration" || lowerType === "merge" || lowerKind === "integration") return BUILT_IN_PHASE_KEYS.validation;
  if (lowerKind === "summary") return BUILT_IN_PHASE_KEYS.validation;
  return BUILT_IN_PHASE_KEYS.development;
}

export function applyPhaseCardsToPlanSteps(steps: MissionPlanStepDraft[], phases: PhaseCard[]): MissionPlanStepDraft[] {
  const byKey = new Map(phases.map((phase) => [phase.phaseKey, phase] as const));
  return steps.map((step) => {
    const metadata = { ...(step.metadata ?? {}) };
    const phaseKey = inferPhaseKeyFromStep(step.kind, metadata, phases);
    const phase = byKey.get(phaseKey) ?? phases[0] ?? null;
    if (!phase) return step;

    const executorKind = phaseModelToExecutorKind(phase.model.modelId);
    return {
      ...step,
      metadata: {
        ...metadata,
        phaseCardId: phase.id,
        phaseKey: phase.phaseKey,
        phaseName: phase.name,
        phasePosition: phase.position,
        phaseModel: phase.model,
        phaseBudget: phase.budget,
        phaseValidation: phase.validationGate,
        phaseInstructions: phase.instructions,
        executorKind,
      },
    };
  });
}

export function groupMissionStepsByPhase(steps: Array<MissionStep | { metadata: Record<string, unknown> | null; status?: string }>): Array<{
  key: string;
  name: string;
  total: number;
  completed: number;
}> {
  const map = new Map<string, { key: string; name: string; total: number; completed: number }>();
  for (const step of steps) {
    const metadata = (step.metadata && typeof step.metadata === "object" ? step.metadata : {}) as Record<string, unknown>;
    const key = typeof metadata.phaseKey === "string" && metadata.phaseKey.trim().length > 0
      ? metadata.phaseKey
      : BUILT_IN_PHASE_KEYS.development;
    const name = typeof metadata.phaseName === "string" && metadata.phaseName.trim().length > 0
      ? metadata.phaseName
      : "Development";
    const entry = map.get(key) ?? { key, name, total: 0, completed: 0 };
    entry.total += 1;
    const status = typeof (step as { status?: string }).status === "string" ? (step as { status?: string }).status : "";
    if (status === "succeeded" || status === "skipped" || status === "superseded" || status === "done") {
      entry.completed += 1;
    }
    map.set(key, entry);
  }
  return Array.from(map.values());
}

export function selectMissionPhaseConfiguration(config: MissionPhaseConfiguration | null | undefined): PhaseCard[] {
  if (!config) return [];
  if (config.override?.phases?.length) return config.override.phases;
  if (config.profile?.phases?.length) return config.profile.phases;
  return config.selectedPhases ?? [];
}
