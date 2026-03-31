import { describe, expect, it } from "vitest";
import { buildCreateMissionDraft, buildMissionLaunchRequest } from "./CreateMissionDialog";
import { createBuiltInMissionPhaseCards } from "./missionPhaseDefaults";

describe("mission launch policies", () => {
  it("defaults the built-in planning phase to approval with unlimited questions", () => {
    const planning = createBuiltInMissionPhaseCards().find((phase) => phase.phaseKey === "planning");
    expect(planning?.requiresApproval).toBe(true);
    expect(planning?.askQuestions.enabled).toBe(true);
    expect(planning?.askQuestions.maxQuestions).toBeNull();
  });

  it("builds launch requests with result-lane finalization", () => {
    const draft = buildCreateMissionDraft(null);
    const phases = createBuiltInMissionPhaseCards();
    const request = buildMissionLaunchRequest({
      draft: {
        ...draft,
        prompt: "Refactor missions planning UI",
        laneId: "lane-123",
      },
      activePhases: phases,
      defaultLaneId: "fallback-lane",
    });

    expect(request.laneId).toBe("lane-123");
    expect(request.executionPolicy?.finalizationPolicyKind).toBe("result_lane");
    expect("prStrategy" in (request.executionPolicy ?? {})).toBe(false);
  });
});
