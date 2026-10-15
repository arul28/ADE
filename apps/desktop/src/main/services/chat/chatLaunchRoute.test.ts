import { describe, expect, it } from "vitest";
import { launchRouteTransition } from "./chatLaunchRoute";

const base = {
  currentPresetId: "deepseek",
  hasCredential: false,
  nextPresetId: null,
  explicitLeave: false,
  sameModel: false,
  providerChanged: false,
  previouslyLeft: undefined,
};

describe("launchRouteTransition", () => {
  it.each([
    ["a plain model picked on a preset chat leaves the preset", {}, { joinsPreset: false, leavesPreset: true }],
    ["the same model sent again (a settings save) keeps it", { sameModel: true }, { joinsPreset: false, leavesPreset: false }],
    ["an explicit leave leaves even for the same model", { sameModel: true, explicitLeave: true }, { joinsPreset: false, leavesPreset: true }],
    ["another preset moves the chat", { nextPresetId: "glm" }, { joinsPreset: true, leavesPreset: true }],
    ["the preset it already runs on changes nothing", { nextPresetId: "deepseek" }, { joinsPreset: false, leavesPreset: false }],
    ["a plain chat joins a preset", { currentPresetId: null, nextPresetId: "deepseek" }, { joinsPreset: true, leavesPreset: false }],
  ])("%s", (_name, overrides, expected) => {
    expect(launchRouteTransition({ ...base, ...overrides })).toMatchObject(expected);
  });

  it.each([
    ["a model of another provider", { providerChanged: true }, true],
    ["a preset", { currentPresetId: null, nextPresetId: "deepseek" }, true],
    ["a model of the same provider", { currentPresetId: null }, false],
  ])("a stored key goes with a move to %s: %s", (_name, overrides, leaves) => {
    expect(launchRouteTransition({ ...base, hasCredential: true, ...overrides }).leavesCredential).toBe(leaves);
  });

  it("remembers what the chat left, and forgets the preset it joins again", () => {
    const left = launchRouteTransition(base).leftLaunchRoute;
    expect(left).toEqual({ preset: true, credential: false });
    expect(launchRouteTransition({ ...base, currentPresetId: null, nextPresetId: "glm", previouslyLeft: left }).leftLaunchRoute)
      .toEqual({ preset: false, credential: false });
  });
});
