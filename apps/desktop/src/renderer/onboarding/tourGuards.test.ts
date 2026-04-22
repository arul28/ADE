import { describe, expect, it } from "vitest";
import {
  TOUR_ADVANCE_REQUIREMENTS,
  canAdvance,
  type TourGuardAppState,
  type TourGuardStep,
} from "./tourGuards";

function step(requires?: readonly string[]): TourGuardStep {
  return {
    id: "test.step",
    requires,
  };
}

const satisfiedStateByRequirement: Record<string, TourGuardAppState> = {
  projectOpen: { projectOpen: true },
  laneExists: { laneExists: true },
  chatStarted: { chatStarted: true },
  commitExists: { commitExists: true },
  prCreated: { prCreated: true },
  createLaneDialogOpen: { createLaneDialogOpen: true },
  managelaneDialogOpen: { managelaneDialogOpen: true },
  prCreateModalOpen: { prCreateModalOpen: true },
};

describe("canAdvance", () => {
  it("allows steps with no requirements", () => {
    expect(canAdvance(step(), {})).toBe(true);
    expect(canAdvance(step([]), {})).toBe(true);
    expect(canAdvance(null, {})).toBe(true);
  });

  it.each(TOUR_ADVANCE_REQUIREMENTS)(
    "requires %s to be satisfied in the app snapshot",
    (requirement) => {
      expect(canAdvance(step([requirement]), {})).toBe(false);
      expect(
        canAdvance(step([requirement]), satisfiedStateByRequirement[requirement]),
      ).toBe(true);
    },
  );

  it("requires every listed requirement to be satisfied", () => {
    const guardedStep = step(["projectOpen", "laneExists"]);

    expect(canAdvance(guardedStep, { projectOpen: true })).toBe(false);
    expect(canAdvance(guardedStep, { laneExists: true })).toBe(false);
    expect(
      canAdvance(guardedStep, { projectOpen: true, laneExists: true }),
    ).toBe(true);
  });

  it("allows an unmet requirement after the step fallback timeout", () => {
    const guardedStep = {
      ...step(["createLaneDialogOpen"]),
      fallbackAfterMs: 30_000,
    };

    expect(canAdvance(guardedStep, { stepElapsedMs: 29_999 })).toBe(false);
    expect(canAdvance(guardedStep, { stepElapsedMs: 30_000 })).toBe(true);
  });

  it("fails closed for unknown requirements", () => {
    expect(
      canAdvance(step(["projectOpen", "notARealRequirement"]), {
        projectOpen: true,
      }),
    ).toBe(false);
  });

  it("supports derived project, count, and dialog snapshot fields", () => {
    expect(
      canAdvance(step(["projectOpen"]), { projectRootPath: "/Users/arul/ADE" }),
    ).toBe(true);
    expect(canAdvance(step(["laneExists"]), { laneCount: 1 })).toBe(true);
    expect(canAdvance(step(["chatStarted"]), { chatSessionCount: 1 })).toBe(
      true,
    );
    expect(canAdvance(step(["commitExists"]), { commitCount: 1 })).toBe(true);
    expect(canAdvance(step(["prCreated"]), { prCount: 1 })).toBe(true);
    expect(
      canAdvance(step(["createLaneDialogOpen"]), {
        openDialogIds: ["lanes.create"],
      }),
    ).toBe(true);
    expect(
      canAdvance(step(["managelaneDialogOpen"]), {
        openDialogIds: ["lanes.manage"],
      }),
    ).toBe(true);
    expect(
      canAdvance(step(["prCreateModalOpen"]), {
        openDialogIds: ["prs.create"],
      }),
    ).toBe(true);
  });

  it("blocks the Act 0 open-project step until a project is open", () => {
    const act0OpenProject = {
      id: "act0.openProject",
      requires: ["projectOpen"],
    };

    expect(canAdvance(act0OpenProject, {})).toBe(false);
    expect(canAdvance(act0OpenProject, { projectRootPath: null })).toBe(false);
    expect(canAdvance(act0OpenProject, { projectRootPath: "   " })).toBe(
      false,
    );
    expect(
      canAdvance(act0OpenProject, { projectRootPath: "/Users/arul/ADE" }),
    ).toBe(true);
  });
});
