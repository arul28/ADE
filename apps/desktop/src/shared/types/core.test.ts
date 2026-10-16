import { describe, expect, it } from "vitest";
import { isBackgroundItemBlocked, type LocalRuntimeStatus } from "./core";

type BackgroundItem = NonNullable<LocalRuntimeStatus["serviceHealth"]["backgroundItem"]>;
type FailureStep = NonNullable<LocalRuntimeStatus["serviceInstall"]["failureStep"]>;

function status(
  backgroundItem: BackgroundItem | null,
  failureStep: FailureStep | null,
): Pick<LocalRuntimeStatus, "serviceInstall" | "serviceHealth"> {
  return {
    serviceInstall: {
      state: "installed",
      attempted: true,
      path: null,
      message: null,
      exitCode: null,
      updatedAt: null,
      failureStep,
    },
    serviceHealth: {
      state: "installed",
      installed: true,
      running: false,
      path: null,
      message: null,
      checkedAt: null,
      backgroundItem,
    },
  };
}

describe("isBackgroundItemBlocked", () => {
  it.each<{
    name: string;
    backgroundItem: BackgroundItem | null;
    failureStep: FailureStep | null;
    expected: boolean;
  }>([
    {
      name: "a live requires_approval reading blocks, whatever the last install recorded",
      backgroundItem: "requires_approval",
      failureStep: null,
      expected: true,
    },
    {
      name: "a live enabled reading clears a stale background_item_blocked failure",
      backgroundItem: "enabled",
      failureStep: "background_item_blocked",
      expected: false,
    },
    {
      name: "a live not_registered reading does not override a stale blocked failure",
      backgroundItem: "not_registered",
      failureStep: "background_item_blocked",
      expected: true,
    },
    {
      name: "an unknown reading with a stale blocked failure still reads as blocked",
      backgroundItem: "unknown",
      failureStep: "background_item_blocked",
      expected: true,
    },
    {
      name: "an absent reading with no recorded failure is not blocked",
      backgroundItem: null,
      failureStep: null,
      expected: false,
    },
    {
      name: "an absent reading with an unrelated failure is not blocked",
      backgroundItem: null,
      failureStep: "replacement_pid",
      expected: false,
    },
  ])("$name", ({ backgroundItem, failureStep, expected }) => {
    expect(isBackgroundItemBlocked(status(backgroundItem, failureStep))).toBe(expected);
  });
});
