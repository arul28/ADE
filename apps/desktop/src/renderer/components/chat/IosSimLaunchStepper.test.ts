import { describe, expect, it } from "vitest";
import type { IosSimulatorLaunchProgress } from "../../../shared/types";
import { selectLaunchSteps } from "./IosSimLaunchStepper";

function row(
  overrides: Partial<IosSimulatorLaunchProgress> & Pick<IosSimulatorLaunchProgress, "launchId" | "step" | "status">,
): IosSimulatorLaunchProgress {
  return {
    message: overrides.status,
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectLaunchSteps", () => {
  it("returns the latest row when a step receives multiple updates", () => {
    const steps = selectLaunchSteps([
      row({ launchId: "launch-1", step: "build-app", status: "running" }),
      row({ launchId: "launch-1", step: "install-app", status: "pending" }),
      row({ launchId: "launch-1", step: "build-app", status: "failed", message: "xcodebuild failed" }),
    ]);

    expect(steps.map((item) => ({ step: item.step, status: item.status, message: item.message }))).toEqual([
      { step: "build-app", status: "failed", message: "xcodebuild failed" },
      { step: "install-app", status: "pending", message: "pending" },
    ]);
  });
});
