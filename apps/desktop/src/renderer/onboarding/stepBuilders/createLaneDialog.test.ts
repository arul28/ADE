import { describe, expect, it } from "vitest";
import { buildCreateLaneDialogWalkthrough } from "./createLaneDialog";

describe("buildCreateLaneDialogWalkthrough", () => {
  it("does not offer a skip path before the required create step", () => {
    const steps = buildCreateLaneDialogWalkthrough();

    expect(steps.find((step) => step.id === "createLane.create")?.requires).toEqual(["laneCountIncreased"]);
    for (const step of steps.filter((entry) => entry.id?.startsWith("createLane.") && entry.id !== "createLane.create")) {
      expect(step.fallbackAfterMs).toBeUndefined();
      expect(step.fallbackNextLabel).toBeUndefined();
      expect(step.fallbackNotice).toBeUndefined();
    }
  });
});
