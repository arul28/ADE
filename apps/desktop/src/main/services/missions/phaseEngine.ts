import type {
  MissionStep,
  MissionStepMetadata,
  PhaseCard,
  PhaseProfile,
  SavePhaseProfileArgs,
  ModelConfig,
  MissionPhaseConfiguration,
} from "../../../shared/types";
import type { MissionPlanStepDraft } from "./missionPlanningService";
import { phaseModelToExecutorKind } from "../orchestrator/executionPolicy";
import { nowIso } from "../shared/utils";

export const BUILT_IN_PHASE_KEYS = {
  planning: "planning",
  development: "development",
  testing: "testing",
  validation: "validation",
  prAndConflicts: "pr_conflict_resolution",
} as const;

const DEFAULT_MODELS: Record<string, ModelConfig> = {
  [BUILT_IN_PHASE_KEYS.planning]: { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
  [BUILT_IN_PHASE_KEYS.development]: { provider: "codex", modelId: "gpt-5.3-codex", thinkingLevel: "medium" },
  [BUILT_IN_PHASE_KEYS.testing]: { provider: "codex", modelId: "gpt-5.3-codex", thinkingLevel: "low" },
  [BUILT_IN_PHASE_KEYS.validation]: { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
  [BUILT_IN_PHASE_KEYS.prAndConflicts]: { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "low" },
};

export function createBuiltInPhaseCards(at: string = nowIso()): PhaseCard[] {
  return [
    {
      id: `builtin:${BUILT_IN_PHASE_KEYS.planning}`,
      phaseKey: BUILT_IN_PHASE_KEYS.planning,
      name: "Planning",
      description: "Decompose mission goals into executable milestones and tasks.",
      instructions: "Plan the mission into concrete steps, dependencies, and validation expectations before implementation.",
      model: DEFAULT_MODELS[BUILT_IN_PHASE_KEYS.planning],
      budget: {},
      orderingConstraints: {
        mustBeFirst: true,
        mustPrecede: [BUILT_IN_PHASE_KEYS.development],
      },
      askQuestions: {
        enabled: true,
        mode: "auto_if_uncertain",
        maxQuestions: 5,
      },
      validationGate: {
        tier: "self",
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
      orderingConstraints: {
        mustFollow: [BUILT_IN_PHASE_KEYS.planning],
      },
      askQuestions: {
        enabled: true,
        mode: "auto_if_uncertain",
        maxQuestions: 3,
      },
      validationGate: {
        tier: "spot-check",
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
      orderingConstraints: {
        canLoop: true,
        loopTarget: BUILT_IN_PHASE_KEYS.development,
      },
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
      orderingConstraints: {
        mustFollow: [BUILT_IN_PHASE_KEYS.development],
      },
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
    {
      id: `builtin:${BUILT_IN_PHASE_KEYS.prAndConflicts}`,
      phaseKey: BUILT_IN_PHASE_KEYS.prAndConflicts,
      name: "PR & Conflict Resolution",
      description: "Prepare PR strategy outputs and resolve merge conflicts.",
      instructions: "Produce PR artifacts, integrate lane outputs, and resolve conflicts with full audit trail.",
      model: DEFAULT_MODELS[BUILT_IN_PHASE_KEYS.prAndConflicts],
      budget: {},
      orderingConstraints: {
        mustBeLast: true,
        mustFollow: [BUILT_IN_PHASE_KEYS.validation],
      },
      askQuestions: {
        enabled: false,
        mode: "never",
      },
      validationGate: {
        tier: "self",
        required: false,
      },
      isBuiltIn: true,
      isCustom: false,
      position: 4,
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
    BUILT_IN_PHASE_KEYS.prAndConflicts,
  ];
  const tddKeys = [
    BUILT_IN_PHASE_KEYS.planning,
    BUILT_IN_PHASE_KEYS.testing,
    BUILT_IN_PHASE_KEYS.development,
    BUILT_IN_PHASE_KEYS.validation,
    BUILT_IN_PHASE_KEYS.prAndConflicts,
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
      description: "Planning -> Development -> Testing -> Validation -> PR",
      phases: asPhaseList(defaultKeys),
      isBuiltIn: true,
      isDefault: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "builtin:tdd",
      name: "TDD",
      description: "Planning -> Testing -> Development -> Validation -> PR",
      phases: asPhaseList(tddKeys),
      isBuiltIn: true,
      isDefault: false,
      createdAt: at,
      updatedAt: at,
    },
  ];
}

function hasCycle(edges: Array<[string, string]>): boolean {
  const nodes = new Set<string>();
  for (const [from, to] of edges) {
    nodes.add(from);
    nodes.add(to);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const list = adjacency.get(from) ?? [];
    list.push(to);
    adjacency.set(from, list);
  }

  const dfs = (node: string): boolean => {
    if (visited.has(node)) return false;
    if (visiting.has(node)) return true;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (const node of nodes) {
    if (dfs(node)) return true;
  }
  return false;
}

export function validatePhaseSequence(phases: PhaseCard[]): string[] {
  const errors: string[] = [];
  if (!phases.length) {
    errors.push("At least one phase is required.");
    return errors;
  }

  const byKey = new Map<string, number>();
  for (let i = 0; i < phases.length; i += 1) {
    const phase = phases[i]!;
    if (!phase.phaseKey.trim()) {
      errors.push(`Phase at position ${i + 1} is missing phaseKey.`);
      continue;
    }
    if (byKey.has(phase.phaseKey)) {
      errors.push(`Duplicate phase key: ${phase.phaseKey}.`);
    }
    byKey.set(phase.phaseKey, i);
    if (phase.orderingConstraints.mustBeFirst && i !== 0) {
      errors.push(`${phase.name} must be first.`);
    }
    if (phase.orderingConstraints.mustBeLast && i !== phases.length - 1) {
      errors.push(`${phase.name} must be last.`);
    }
    if (phase.orderingConstraints.canLoop && phase.orderingConstraints.loopTarget) {
      if (!byKey.has(phase.orderingConstraints.loopTarget) && !phases.some((p) => p.phaseKey === phase.orderingConstraints.loopTarget)) {
        errors.push(`${phase.name} loop target does not exist: ${phase.orderingConstraints.loopTarget}.`);
      }
    }
  }

  for (let i = 0; i < phases.length; i += 1) {
    const phase = phases[i]!;
    for (const dep of phase.orderingConstraints.mustFollow ?? []) {
      const depPos = byKey.get(dep);
      if (depPos == null) {
        errors.push(`${phase.name} requires missing predecessor: ${dep}.`);
      } else if (depPos >= i) {
        errors.push(`${phase.name} must follow ${dep}.`);
      }
    }
    for (const dep of phase.orderingConstraints.mustPrecede ?? []) {
      const depPos = byKey.get(dep);
      if (depPos == null) {
        errors.push(`${phase.name} requires missing successor: ${dep}.`);
      } else if (depPos <= i) {
        errors.push(`${phase.name} must precede ${dep}.`);
      }
    }
  }

  const edges: Array<[string, string]> = [];
  for (const phase of phases) {
    for (const dep of phase.orderingConstraints.mustFollow ?? []) {
      edges.push([dep, phase.phaseKey]);
    }
    for (const dep of phase.orderingConstraints.mustPrecede ?? []) {
      edges.push([phase.phaseKey, dep]);
    }
  }
  if (hasCycle(edges)) {
    errors.push("Phase ordering constraints contain a cycle.");
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

  if (lowerType === "analysis") return BUILT_IN_PHASE_KEYS.planning;
  if (lowerType === "test" || lowerKind === "validation") return BUILT_IN_PHASE_KEYS.testing;
  if (lowerType === "review") return BUILT_IN_PHASE_KEYS.validation;
  if (lowerType === "integration" || lowerType === "merge" || lowerKind === "integration") return BUILT_IN_PHASE_KEYS.prAndConflicts;
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

    const executorKind = phaseModelToExecutorKind(`${phase.model.provider}/${phase.model.modelId}`);
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
