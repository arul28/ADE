import { describe, expect, it } from "vitest";
import type { CloudLaneWithoutComputer } from "../../../shared/cloudLaneLife";
import { SAVED_CHATS_MACHINE_PREFIX } from "../../../shared/cloudSavedChats";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { cloudLaneWithoutComputerForBinding } from "./cloudLaneStores";

function kept(laneId: string, formerInstanceId: string, formerMachineKey: string | null): CloudLaneWithoutComputer {
  return {
    laneId,
    laneName: laneId,
    projectOrigin: "github.com/acme/app",
    branchRef: `ade/${laneId}`,
    reason: "idle_cleanup",
    type: "default",
    cpu: 2,
    memoryGb: 4,
    formerInstanceId,
    formerMachineKey,
    since: 1,
  };
}

function remote(targetId: string, hostname?: string): OpenProjectBinding {
  return {
    kind: "remote",
    key: `${targetId}:project`,
    targetId,
    runtimeName: "ADE Cloud",
    transport: "paired",
    ...(hostname ? { hostname } : {}),
    projectId: "project",
    rootPath: "",
    displayName: "app",
  };
}

// The kept lane a chat's pin points at decides what the chat's Delete removes
// and which computer's queue its next message goes to.
describe("the kept lane a chat's machine pin points at", () => {
  const lanes = [
    kept("onboarding", "inst-onboarding", "MK-Onboarding"),
    kept("pricing", "inst-pricing", null),
  ];
  it.each([
    { name: "a live pin, by the old computer's id", binding: remote("conn-1", "INST-PRICING"), expected: "pricing" },
    { name: "a pin whose target is the old machine key", binding: remote("MK-Onboarding"), expected: "onboarding" },
    {
      name: "a saved chat's pin, by the key inside its cloud-saved target, in any case",
      binding: remote(`${SAVED_CHATS_MACHINE_PREFIX}mk-onboarding`),
      expected: "onboarding",
    },
    { name: "a saved chat's pin of another computer", binding: remote(`${SAVED_CHATS_MACHINE_PREFIX}mk-other`), expected: null },
    { name: "a lane with no machine key never matches an empty target", binding: remote(""), expected: null },
    {
      name: "a local pin",
      binding: { kind: "local", key: "local", rootPath: "/repo", displayName: "app" } satisfies OpenProjectBinding,
      expected: null,
    },
  ])("$name", ({ binding, expected }) => {
    expect(cloudLaneWithoutComputerForBinding(binding, lanes)?.laneId ?? null).toBe(expected);
  });
});
