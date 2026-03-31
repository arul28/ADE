import { describe, expect, it } from "vitest";
import type { PhaseCard, PhaseProfile, MissionPhaseConfiguration } from "../../../shared/types";
import {
  BUILT_IN_PHASE_KEYS,
  createBuiltInPhaseCards,
  createBuiltInPhaseProfiles,
  validatePhaseSequence,
  normalizeProfileInput,
  applyPhaseCardsToPlanSteps,
  groupMissionStepsByPhase,
  selectMissionPhaseConfiguration,
} from "./phaseEngine";

function makePhaseCard(overrides: Partial<PhaseCard> = {}): PhaseCard {
  return {
    id: "phase-1",
    phaseKey: "development",
    name: "Development",
    description: "Implement planned work.",
    instructions: "Execute implementation tasks.",
    model: { modelId: "openai/gpt-5.4-codex", thinkingLevel: "medium" },
    budget: {},
    orderingConstraints: {},
    askQuestions: { enabled: false },
    validationGate: { tier: "none", required: false },
    isBuiltIn: true,
    isCustom: false,
    position: 1,
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("BUILT_IN_PHASE_KEYS", () => {
  it("has the expected built-in keys", () => {
    expect(BUILT_IN_PHASE_KEYS.planning).toBe("planning");
    expect(BUILT_IN_PHASE_KEYS.development).toBe("development");
    expect(BUILT_IN_PHASE_KEYS.testing).toBe("testing");
    expect(BUILT_IN_PHASE_KEYS.validation).toBe("validation");
  });
});

describe("createBuiltInPhaseCards", () => {
  it("creates 4 built-in phase cards", () => {
    const cards = createBuiltInPhaseCards("2026-03-25T00:00:00.000Z");
    expect(cards).toHaveLength(4);
    expect(cards.map((c) => c.phaseKey)).toEqual(["planning", "development", "testing", "validation"]);
  });

  it("sets planning phase as mustBeFirst and position 0", () => {
    const cards = createBuiltInPhaseCards();
    const planning = cards.find((c) => c.phaseKey === "planning")!;
    expect(planning.position).toBe(0);
    expect(planning.orderingConstraints?.mustBeFirst).toBe(true);
    expect(planning.requiresApproval).toBe(true);
    expect(planning.askQuestions.enabled).toBe(true);
  });

  it("assigns sequential positions", () => {
    const cards = createBuiltInPhaseCards();
    expect(cards.map((c) => c.position)).toEqual([0, 1, 2, 3]);
  });

  it("marks all as isBuiltIn and not isCustom", () => {
    const cards = createBuiltInPhaseCards();
    for (const card of cards) {
      expect(card.isBuiltIn).toBe(true);
      expect(card.isCustom).toBe(false);
    }
  });

  it("sets validation gates on testing and validation phases", () => {
    const cards = createBuiltInPhaseCards();
    const testing = cards.find((c) => c.phaseKey === "testing")!;
    const validation = cards.find((c) => c.phaseKey === "validation")!;
    expect(testing.validationGate.tier).toBe("dedicated");
    expect(testing.validationGate.required).toBe(true);
    expect(validation.validationGate.tier).toBe("dedicated");
    expect(validation.validationGate.required).toBe(true);
  });

  it("uses provided timestamp for createdAt and updatedAt", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const cards = createBuiltInPhaseCards(ts);
    for (const card of cards) {
      expect(card.createdAt).toBe(ts);
      expect(card.updatedAt).toBe(ts);
    }
  });
});

describe("createBuiltInPhaseProfiles", () => {
  it("creates default and TDD profiles", () => {
    const cards = createBuiltInPhaseCards();
    const profiles = createBuiltInPhaseProfiles(cards);
    expect(profiles).toHaveLength(2);
    expect(profiles[0].name).toBe("Default");
    expect(profiles[1].name).toBe("TDD");
  });

  it("default profile has Planning -> Development -> Testing -> Validation order", () => {
    const cards = createBuiltInPhaseCards();
    const profiles = createBuiltInPhaseProfiles(cards);
    const defaultProfile = profiles.find((p) => p.name === "Default")!;
    expect(defaultProfile.phases.map((p) => p.phaseKey)).toEqual([
      "planning", "development", "testing", "validation",
    ]);
  });

  it("TDD profile has Planning -> Testing -> Development -> Validation order", () => {
    const cards = createBuiltInPhaseCards();
    const profiles = createBuiltInPhaseProfiles(cards);
    const tddProfile = profiles.find((p) => p.name === "TDD")!;
    expect(tddProfile.phases.map((p) => p.phaseKey)).toEqual([
      "planning", "testing", "development", "validation",
    ]);
  });

  it("marks default profile as isDefault", () => {
    const cards = createBuiltInPhaseCards();
    const profiles = createBuiltInPhaseProfiles(cards);
    expect(profiles[0].isDefault).toBe(true);
    expect(profiles[1].isDefault).toBe(false);
  });

  it("reassigns positions based on profile order", () => {
    const cards = createBuiltInPhaseCards();
    const profiles = createBuiltInPhaseProfiles(cards);
    const tdd = profiles.find((p) => p.name === "TDD")!;
    expect(tdd.phases[0].position).toBe(0); // planning
    expect(tdd.phases[1].position).toBe(1); // testing
    expect(tdd.phases[2].position).toBe(2); // development
    expect(tdd.phases[3].position).toBe(3); // validation
  });
});

describe("validatePhaseSequence", () => {
  it("returns no errors for a valid default sequence", () => {
    const cards = createBuiltInPhaseCards();
    const errors = validatePhaseSequence(cards);
    expect(errors).toEqual([]);
  });

  it("errors when no phases provided", () => {
    const errors = validatePhaseSequence([]);
    expect(errors).toContain("At least one phase is required.");
  });

  it("errors when development phase is missing", () => {
    const errors = validatePhaseSequence([
      makePhaseCard({ phaseKey: "planning", position: 0 }),
    ]);
    expect(errors).toContain("Development phase is required.");
  });

  it("errors when planning appears after development", () => {
    const errors = validatePhaseSequence([
      makePhaseCard({ phaseKey: "development", position: 0 }),
      makePhaseCard({ id: "phase-2", phaseKey: "planning", position: 1 }),
    ]);
    expect(errors).toContain("Planning phase must appear before development.");
  });

  it("errors on duplicate phase keys", () => {
    const errors = validatePhaseSequence([
      makePhaseCard({ phaseKey: "development", position: 0 }),
      makePhaseCard({ id: "phase-dup", phaseKey: "development", position: 1 }),
    ]);
    expect(errors).toContain("Duplicate phase key: development.");
  });

  it("errors on empty phaseKey", () => {
    const errors = validatePhaseSequence([
      makePhaseCard({ phaseKey: "", position: 0 }),
      makePhaseCard({ id: "phase-dev", phaseKey: "development", position: 1 }),
    ]);
    expect(errors).toContain("Phase at position 1 is missing phaseKey.");
  });

  it("allows valid TDD ordering (planning, testing, development, validation)", () => {
    const cards = createBuiltInPhaseCards();
    const tddOrder = [
      cards.find((c) => c.phaseKey === "planning")!,
      cards.find((c) => c.phaseKey === "testing")!,
      cards.find((c) => c.phaseKey === "development")!,
      cards.find((c) => c.phaseKey === "validation")!,
    ];
    const errors = validatePhaseSequence(tddOrder);
    expect(errors).toEqual([]);
  });

  it("deduplicates error messages", () => {
    const errors = validatePhaseSequence([
      makePhaseCard({ phaseKey: "development", position: 0 }),
      makePhaseCard({ id: "phase-2", phaseKey: "development", position: 1 }),
      makePhaseCard({ id: "phase-3", phaseKey: "development", position: 2 }),
    ]);
    const dupeErrors = errors.filter((e) => e.includes("Duplicate"));
    expect(dupeErrors).toHaveLength(1);
  });
});

describe("normalizeProfileInput", () => {
  it("assigns sequential positions and timestamps", () => {
    const now = "2026-03-25T12:00:00.000Z";
    const profile = normalizeProfileInput(
      {
        id: "custom-1",
        name: "  Custom Profile  ",
        description: "  A custom profile  ",
        phases: [
          makePhaseCard({ phaseKey: "development", position: 99 }),
          makePhaseCard({ id: "phase-2", phaseKey: "testing", position: 5 }),
        ],
        isDefault: true,
      },
      now,
    );
    expect(profile.name).toBe("Custom Profile");
    expect(profile.description).toBe("A custom profile");
    expect(profile.phases[0].position).toBe(0);
    expect(profile.phases[1].position).toBe(1);
    expect(profile.isBuiltIn).toBe(false);
    expect(profile.isDefault).toBe(true);
    expect(profile.createdAt).toBe(now);
    expect(profile.updatedAt).toBe(now);
  });

  it("trims empty id to empty string", () => {
    const profile = normalizeProfileInput({
      id: "  ",
      name: "Test",
      phases: [makePhaseCard()],
    });
    expect(profile.id).toBe("");
  });

  it("defaults isDefault to false when not provided", () => {
    const profile = normalizeProfileInput({
      name: "Test",
      phases: [makePhaseCard()],
    });
    expect(profile.isDefault).toBe(false);
  });
});

describe("applyPhaseCardsToPlanSteps", () => {
  it("assigns phase metadata to plan steps based on kind/type inference", () => {
    const phases = createBuiltInPhaseCards();
    const steps = [
      { index: 0, title: "Research", detail: "Research codebase", kind: "analysis", metadata: { stepType: "analysis" } },
      { index: 1, title: "Implement", detail: "Write code", kind: "implementation", metadata: { stepType: "code" } },
      { index: 2, title: "Test", detail: "Run tests", kind: "test", metadata: { stepType: "test" } },
      { index: 3, title: "Validate", detail: "Final validation", kind: "summary", metadata: { stepType: "review" } },
    ];

    const applied = applyPhaseCardsToPlanSteps(steps, phases);

    expect(applied[0].metadata.phaseKey).toBe("planning");
    expect(applied[1].metadata.phaseKey).toBe("development");
    expect(applied[2].metadata.phaseKey).toBe("testing");
    expect(applied[3].metadata.phaseKey).toBe("validation");
  });

  it("respects explicit phaseKey in metadata", () => {
    const phases = createBuiltInPhaseCards();
    const steps = [
      { index: 0, title: "Custom", detail: "Custom step", kind: "misc", metadata: { phaseKey: "testing" } },
    ];
    const applied = applyPhaseCardsToPlanSteps(steps, phases);
    expect(applied[0].metadata.phaseKey).toBe("testing");
  });

  it("attaches phase model, budget, instructions, and validation info", () => {
    const phases = createBuiltInPhaseCards();
    const steps = [
      { index: 0, title: "Implement", detail: "Code", kind: "implementation", metadata: {} },
    ];
    const applied = applyPhaseCardsToPlanSteps(steps, phases);
    expect(applied[0].metadata.phaseName).toBe("Development");
    expect(applied[0].metadata.phaseModel).toBeDefined();
    expect(applied[0].metadata.phaseInstructions).toBeDefined();
    expect(applied[0].metadata.phaseValidation).toBeDefined();
    expect(applied[0].metadata.executorKind).toBeDefined();
  });

  it("falls back to development phase for unknown step types", () => {
    const phases = createBuiltInPhaseCards();
    const steps = [
      { index: 0, title: "Unknown", detail: "Unknown step", kind: "unknown", metadata: { stepType: "unknown" } },
    ];
    const applied = applyPhaseCardsToPlanSteps(steps, phases);
    expect(applied[0].metadata.phaseKey).toBe("development");
  });

  it("infers milestone stepType as validation", () => {
    const phases = createBuiltInPhaseCards();
    const steps = [
      { index: 0, title: "Milestone", detail: "Check milestone", kind: "task", metadata: { stepType: "milestone" } },
    ];
    const applied = applyPhaseCardsToPlanSteps(steps, phases);
    expect(applied[0].metadata.phaseKey).toBe("validation");
  });

  it("infers integration stepType as validation", () => {
    const phases = createBuiltInPhaseCards();
    const steps = [
      { index: 0, title: "Merge", detail: "Integration step", kind: "integration", metadata: { stepType: "integration" } },
    ];
    const applied = applyPhaseCardsToPlanSteps(steps, phases);
    expect(applied[0].metadata.phaseKey).toBe("validation");
  });
});

describe("groupMissionStepsByPhase", () => {
  it("groups steps by phaseKey from metadata", () => {
    const steps = [
      { metadata: { phaseKey: "planning", phaseName: "Planning" }, status: "succeeded" },
      { metadata: { phaseKey: "development", phaseName: "Development" }, status: "succeeded" },
      { metadata: { phaseKey: "development", phaseName: "Development" }, status: "in_progress" },
      { metadata: { phaseKey: "testing", phaseName: "Testing" }, status: "succeeded" },
    ];
    const groups = groupMissionStepsByPhase(steps);
    expect(groups).toEqual([
      { key: "planning", name: "Planning", total: 1, completed: 1 },
      { key: "development", name: "Development", total: 2, completed: 1 },
      { key: "testing", name: "Testing", total: 1, completed: 1 },
    ]);
  });

  it("defaults to development phase when metadata is missing", () => {
    const steps = [
      { metadata: null, status: "succeeded" },
      { metadata: {}, status: "in_progress" },
    ];
    const groups = groupMissionStepsByPhase(steps);
    expect(groups).toEqual([
      { key: "development", name: "Development", total: 2, completed: 1 },
    ]);
  });

  it("counts skipped and superseded as completed", () => {
    const steps = [
      { metadata: { phaseKey: "development", phaseName: "Development" }, status: "skipped" },
      { metadata: { phaseKey: "development", phaseName: "Development" }, status: "superseded" },
      { metadata: { phaseKey: "development", phaseName: "Development" }, status: "done" },
    ];
    const groups = groupMissionStepsByPhase(steps);
    expect(groups[0].completed).toBe(3);
    expect(groups[0].total).toBe(3);
  });

  it("does not count failed or pending as completed", () => {
    const steps = [
      { metadata: { phaseKey: "testing", phaseName: "Testing" }, status: "failed" },
      { metadata: { phaseKey: "testing", phaseName: "Testing" }, status: "pending" },
    ];
    const groups = groupMissionStepsByPhase(steps);
    expect(groups[0].completed).toBe(0);
    expect(groups[0].total).toBe(2);
  });
});

describe("selectMissionPhaseConfiguration", () => {
  const phases = createBuiltInPhaseCards();

  it("returns override phases when present", () => {
    const config: MissionPhaseConfiguration = {
      profile: { phases: [phases[0]] } as any,
      override: { phases } as any,
      selectedPhases: [phases[0]],
    };
    expect(selectMissionPhaseConfiguration(config)).toEqual(phases);
  });

  it("falls back to profile phases when no override", () => {
    const config: MissionPhaseConfiguration = {
      profile: { phases: [phases[0], phases[1]] } as any,
      override: null,
      selectedPhases: phases,
    };
    expect(selectMissionPhaseConfiguration(config)).toEqual([phases[0], phases[1]]);
  });

  it("falls back to selectedPhases when no override or profile", () => {
    const config = {
      override: null,
      selectedPhases: phases,
    } as MissionPhaseConfiguration;
    expect(selectMissionPhaseConfiguration(config)).toEqual(phases);
  });

  it("returns empty array for null config", () => {
    expect(selectMissionPhaseConfiguration(null)).toEqual([]);
  });

  it("returns empty array for undefined config", () => {
    expect(selectMissionPhaseConfiguration(undefined)).toEqual([]);
  });

  it("falls through override with empty phases array", () => {
    const config: MissionPhaseConfiguration = {
      override: { phases: [] } as any,
      profile: { phases } as any,
      selectedPhases: [],
    };
    expect(selectMissionPhaseConfiguration(config)).toEqual(phases);
  });
});
