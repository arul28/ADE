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
  integration: "integration",
  testing: "testing",
  validation: "validation",
  closeout: "closeout",
  /** @deprecated Legacy phase key retained only for backward compatibility with existing mission metadata. */
  prAndConflicts: "pr_conflict_resolution",
} as const;

function normalizePhaseKey(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isDevelopmentLikePhaseKey(phaseKey: string | null | undefined): boolean {
  const key = normalizePhaseKey(phaseKey);
  if (!key) return false;
  if (key === BUILT_IN_PHASE_KEYS.development || key === "implementation" || key === "code") return true;
  return (
    key.startsWith("development_")
    || key.startsWith("implementation_")
    || key.endsWith("_development")
    || key.endsWith("_implementation")
  );
}

function isCustomExecutablePhase(phase: PhaseCard): boolean {
  const key = normalizePhaseKey(phase.phaseKey);
  if (!key || phase.isBuiltIn === true || phase.isCustom !== true) return false;
  return !Object.values(BUILT_IN_PHASE_KEYS).includes(key as (typeof BUILT_IN_PHASE_KEYS)[keyof typeof BUILT_IN_PHASE_KEYS]);
}

function isDevelopmentLikePhase(phase: PhaseCard): boolean {
  return isDevelopmentLikePhaseKey(phase.phaseKey) || isCustomExecutablePhase(phase);
}

export function resolveDevelopmentPhaseKey(phases: PhaseCard[]): string {
  const phase = phases.find((entry) => isDevelopmentLikePhase(entry));
  return phase?.phaseKey ?? BUILT_IN_PHASE_KEYS.development;
}

const DEFAULT_CLAUDE_PHASE_MODEL_ID = getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-4-6";
const DEFAULT_CODEX_PHASE_MODEL_ID = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.5";

const DEFAULT_MODELS: Record<string, ModelConfig> = {
  [BUILT_IN_PHASE_KEYS.planning]: { modelId: DEFAULT_CLAUDE_PHASE_MODEL_ID, thinkingLevel: "medium" },
  [BUILT_IN_PHASE_KEYS.development]: { modelId: DEFAULT_CODEX_PHASE_MODEL_ID, thinkingLevel: "medium" },
  [BUILT_IN_PHASE_KEYS.integration]: { modelId: DEFAULT_CODEX_PHASE_MODEL_ID, thinkingLevel: "medium" },
  [BUILT_IN_PHASE_KEYS.testing]: { modelId: DEFAULT_CODEX_PHASE_MODEL_ID, thinkingLevel: "low" },
  [BUILT_IN_PHASE_KEYS.validation]: { modelId: DEFAULT_CLAUDE_PHASE_MODEL_ID, thinkingLevel: "medium" },
  [BUILT_IN_PHASE_KEYS.closeout]: { modelId: DEFAULT_CLAUDE_PHASE_MODEL_ID, thinkingLevel: "medium" },
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
        maxQuestions: null,
      },
      validationGate: {
        tier: "none",
        required: false,
      },
      requiresApproval: true,
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
      id: `builtin:${BUILT_IN_PHASE_KEYS.integration}`,
      phaseKey: BUILT_IN_PHASE_KEYS.integration,
      name: "Integration",
      description: "Join child-lane work into the mission result lane.",
      instructions:
        "After implementation workers finish, consolidate their outputs, resolve conflicts, and assemble a single reviewable result lane.",
      model: DEFAULT_MODELS[BUILT_IN_PHASE_KEYS.integration],
      budget: {},
      orderingConstraints: {
        mustFollow: [BUILT_IN_PHASE_KEYS.development],
      },
      askQuestions: {
        enabled: false,
      },
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
      },
      validationGate: {
        tier: "dedicated",
        required: true,
      },
      isBuiltIn: true,
      isCustom: false,
      position: 4,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: `builtin:${BUILT_IN_PHASE_KEYS.closeout}`,
      phaseKey: BUILT_IN_PHASE_KEYS.closeout,
      name: "Closeout",
      description: "Collect final proof and present the finished mission output.",
      instructions:
        "Confirm the result lane, summarize the final product, attach required proof, and leave the mission ready for user review.",
      model: DEFAULT_MODELS[BUILT_IN_PHASE_KEYS.closeout],
      budget: {},
      orderingConstraints: {
        mustBeLast: true,
        mustFollow: [BUILT_IN_PHASE_KEYS.validation],
      },
      askQuestions: {
        enabled: false,
      },
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

export function createBuiltInPhaseProfiles(cards: PhaseCard[], at: string = nowIso()): PhaseProfile[] {
  const byKey = new Map(cards.map((card) => [card.phaseKey, card] as const));
  const defaultKeys = [
    BUILT_IN_PHASE_KEYS.planning,
    BUILT_IN_PHASE_KEYS.development,
    BUILT_IN_PHASE_KEYS.integration,
    BUILT_IN_PHASE_KEYS.testing,
    BUILT_IN_PHASE_KEYS.validation,
    BUILT_IN_PHASE_KEYS.closeout,
  ];
  const tddKeys = [
    BUILT_IN_PHASE_KEYS.planning,
    BUILT_IN_PHASE_KEYS.testing,
    BUILT_IN_PHASE_KEYS.development,
    BUILT_IN_PHASE_KEYS.integration,
    BUILT_IN_PHASE_KEYS.validation,
    BUILT_IN_PHASE_KEYS.closeout,
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
      description: "Planning -> Development -> Integration -> Testing -> Validation -> Closeout",
      phases: asPhaseList(defaultKeys),
      isBuiltIn: true,
      isDefault: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "builtin:tdd",
      name: "TDD",
      description: "Planning -> Testing -> Development -> Integration -> Validation -> Closeout",
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
  const labelForKey = (phaseKey: string): string => {
    const phase = phases.find((entry) => normalizePhaseKey(entry.phaseKey) === normalizePhaseKey(phaseKey));
    return phase?.name?.trim() || phaseKey;
  };
  let firstDevelopmentIndex = -1;
  let firstPlanningIndex = -1;
  for (let i = 0; i < phases.length; i += 1) {
    const phase = phases[i]!;
    const phaseKey = normalizePhaseKey(phase.phaseKey);
    if (!phaseKey) {
      errors.push(`Phase at position ${i + 1} is missing phaseKey.`);
      continue;
    }
    if (byKey.has(phaseKey)) {
      errors.push(`Duplicate phase key: ${phase.phaseKey}.`);
    }
    byKey.set(phaseKey, i);
    if (isDevelopmentLikePhase(phase) && firstDevelopmentIndex < 0) firstDevelopmentIndex = i;
    if (phaseKey === BUILT_IN_PHASE_KEYS.planning && firstPlanningIndex < 0) firstPlanningIndex = i;
  }

  phases.forEach((phase, index) => {
    const phaseKey = normalizePhaseKey(phase.phaseKey);
    if (!phaseKey) return;
    const label = phase.name.trim() || phase.phaseKey;
    const orderingConstraints = phase.orderingConstraints ?? {};
    if (orderingConstraints.mustBeFirst && index !== 0) {
      errors.push(`${label} phase must be first.`);
    }
    if (orderingConstraints.mustBeLast && index !== phases.length - 1) {
      errors.push(`${label} phase must be last.`);
    }
    for (const requiredPredecessor of orderingConstraints.mustFollow ?? []) {
      const predecessorKey = normalizePhaseKey(requiredPredecessor);
      const predecessorIndex = byKey.get(predecessorKey);
      if (predecessorIndex == null) {
        errors.push(`${label} phase requires ${labelForKey(predecessorKey)} phase.`);
      } else if (predecessorIndex >= index) {
        errors.push(`${label} phase must come after ${labelForKey(predecessorKey)}.`);
      }
    }
    for (const requiredSuccessor of orderingConstraints.mustPrecede ?? []) {
      const successorKey = normalizePhaseKey(requiredSuccessor);
      const successorIndex = byKey.get(successorKey);
      if (successorIndex == null) {
        errors.push(`${label} phase requires ${labelForKey(successorKey)} phase.`);
      } else if (successorIndex <= index) {
        errors.push(`${label} phase must come before ${labelForKey(successorKey)}.`);
      }
    }
  });

  if (firstDevelopmentIndex < 0) {
    errors.push("Development or implementation phase is required.");
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
  const lowerKind = kind.trim().toLowerCase();
  const lowerType = stepType.toLowerCase();
  const phaseByLowerKey = new Map(phases.map((phase) => [phase.phaseKey.trim().toLowerCase(), phase.phaseKey] as const));
  const directTypePhase = lowerType ? phaseByLowerKey.get(lowerType) : undefined;
  if (directTypePhase) return directTypePhase;
  const directKindPhase = lowerKind ? phaseByLowerKey.get(lowerKind) : undefined;
  if (directKindPhase) return directKindPhase;

  if (lowerType === "analysis" || lowerType === "planning") {
    return phases.some((phase) => phase.phaseKey === BUILT_IN_PHASE_KEYS.planning)
      ? BUILT_IN_PHASE_KEYS.planning
      : resolveDevelopmentPhaseKey(phases);
  }
  if (lowerType === "test" || lowerKind === "test" || lowerKind === "testing") return BUILT_IN_PHASE_KEYS.testing;
  if (lowerType === "milestone" || lowerType === "validation" || lowerKind === "validation") return BUILT_IN_PHASE_KEYS.validation;
  if (lowerType === "review") return BUILT_IN_PHASE_KEYS.validation;
  if (lowerType === "integration" || lowerType === "merge" || lowerKind === "integration") {
    return phases.some((phase) => phase.phaseKey === BUILT_IN_PHASE_KEYS.integration)
      ? BUILT_IN_PHASE_KEYS.integration
      : BUILT_IN_PHASE_KEYS.validation;
  }
  if (lowerKind === "summary" || lowerType === "closeout" || lowerKind === "closeout") {
    return phases.some((phase) => phase.phaseKey === BUILT_IN_PHASE_KEYS.closeout)
      ? BUILT_IN_PHASE_KEYS.closeout
      : BUILT_IN_PHASE_KEYS.validation;
  }
  return resolveDevelopmentPhaseKey(phases);
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
