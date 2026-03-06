import { describe, expect, it } from "vitest";
import {
  deriveMissionStatusFromRun,
  filterExecutionSteps,
  isDisplayOnlyTaskStep,
  parseChatTarget,
  sanitizeChatTarget,
  teammateThreadIdentity,
  deriveThreadTitle,
} from "./orchestratorContext";

describe("orchestratorContext teammate chat target handling", () => {
  it("parses teammate targets from persisted JSON payloads", () => {
    const parsed = parseChatTarget({
      kind: "teammate",
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    });

    expect(parsed).toEqual({
      kind: "teammate",
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    });
  });

  it("sanitizes teammate targets without dropping routing fields", () => {
    const sanitized = sanitizeChatTarget({
      kind: "teammate",
      runId: " run-1 ",
      teamMemberId: " tm-1 ",
      sessionId: " session-1 ",
    });

    expect(sanitized).toEqual({
      kind: "teammate",
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    });
  });

  it("builds teammate thread identity and title", () => {
    const target = {
      kind: "teammate" as const,
      runId: "run-1",
      teamMemberId: "tm-1",
      sessionId: "session-1",
    };

    expect(teammateThreadIdentity(target)).toBe("tm-1");
    expect(deriveThreadTitle({ target, step: null, lane: null })).toBe("Teammate: tm-1");
  });
});

describe("deriveMissionStatusFromRun", () => {
  it("keeps missions intervention_required while blocking manual input is open", () => {
    const status = deriveMissionStatusFromRun(
      {
        run: { status: "active" },
        steps: [],
        attempts: [],
        timeline: [],
        claims: [],
      } as any,
      {
        status: "in_progress",
        interventions: [
          {
            id: "iv-1",
            missionId: "mission-1",
            interventionType: "manual_input",
            status: "open",
            title: "Need answer",
            body: "Question",
            requestedAction: null,
            resolutionNote: null,
            laneId: null,
            createdAt: "",
            updatedAt: "",
            resolvedAt: null,
            metadata: { canProceedWithoutAnswer: false },
          },
        ],
      } as any
    );

    expect(status).toBe("intervention_required");
  });

  it("keeps active missions in progress when manual input is optional", () => {
    const status = deriveMissionStatusFromRun(
      {
        run: { status: "active" },
        steps: [],
        attempts: [],
        timeline: [],
        claims: [],
      } as any,
      {
        status: "in_progress",
        interventions: [
          {
            id: "iv-1",
            missionId: "mission-1",
            interventionType: "manual_input",
            status: "open",
            title: "Optional note",
            body: "Question",
            requestedAction: null,
            resolutionNote: null,
            laneId: null,
            createdAt: "",
            updatedAt: "",
            resolvedAt: null,
            metadata: { canProceedWithoutAnswer: true },
          },
        ],
      } as any
    );

    expect(status).toBe("in_progress");
  });
});

describe("display-only task helpers", () => {
  it("recognizes display-only task nodes and filters them from execution lists", () => {
    const steps = [
      { id: "task-1", stepKey: "plan", metadata: { isTask: true, displayOnlyTask: true } },
      { id: "step-1", stepKey: "impl", metadata: { stepType: "implementation" } },
    ] as any[];

    expect(isDisplayOnlyTaskStep(steps[0])).toBe(true);
    expect(isDisplayOnlyTaskStep(steps[1])).toBe(false);
    expect(filterExecutionSteps(steps).map((step) => step.stepKey)).toEqual(["impl"]);
  });
});
