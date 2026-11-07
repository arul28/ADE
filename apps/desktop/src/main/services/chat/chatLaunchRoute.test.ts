import { describe, expect, it } from "vitest";
import { encodeRoutePresetId } from "../../../shared/harnessRoutes";
import { crossMachineRouteFor, crossMachineRouteNotice, launchRouteTransition, readCrossMachineRoute } from "./chatLaunchRoute";

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

describe("a chat's route across a move to another machine", () => {
  const keyRoute = encodeRoutePresetId({
    harness: "codex",
    source: { kind: "key", provider: "openai", credentialId: "default", label: "openai" },
    model: "openai/gpt-6-luna",
  });
  const codex = { provider: "codex", modelId: "openai/gpt-6-luna" };

  // Source side builds it, the capsule carries it as JSON, the destination reads it back.
  it.each([
    ["a key route on the same model is kept", { ...codex, presetId: keyRoute }, "codex", "openai/gpt-6-luna", { presetId: keyRoute }, false],
    ["a key route is dropped when the move changes the model", { ...codex, presetId: keyRoute }, "codex", "openai/gpt-6-sol", { dropped: true }, true],
    ["a stored key is kept for the same provider", { ...codex, credentialId: "work" }, "codex", "openai/gpt-6-sol", { credentialId: "work" }, false],
    ["a stored key is dropped for another provider", { ...codex, credentialId: "work" }, "claude", "anthropic/claude-opus-5", { dropped: true }, true],
    // Account ids are per machine ("codex-2" can be another login there): the account travels as its email.
    ["an account is carried by its email, not its id", { ...codex, instanceId: "codex-2", accountEmail: "work@example.com" }, "codex", "openai/gpt-6-luna", { account: { email: "work@example.com" } }, false],
  ])("%s", (_name, source, targetProvider, targetModelId, carried, warns) => {
    const built = crossMachineRouteFor({ source, targetProvider, targetModelId, adeHome: "/nonexistent-ade-home" });
    const route = readCrossMachineRoute(JSON.parse(JSON.stringify(built)));
    expect(route).toMatchObject(carried);
    expect(route?.label).toBeTruthy();
    const notice = crossMachineRouteNotice({ route: route!, fromMachine: "p1 route a", accountKept: true, accountHere: null, blockedReason: null });
    expect(notice.warning).toBe(warns);
    expect(notice.message).toContain("p1 route a");
  });

  it("names the sign-in it fell back to, and why, when the route can't run here", () => {
    expect(crossMachineRouteFor({ source: { provider: "codex" }, targetProvider: "codex", targetModelId: "openai/gpt-6-luna", adeHome: "/nonexistent-ade-home" })).toBeNull();
    const account = readCrossMachineRoute({ label: "Codex account · work@example.com", account: { email: "work@example.com" }, instanceId: "codex-2" })!;
    expect(account).not.toHaveProperty("instanceId");
    const missingAccount = crossMachineRouteNotice({ route: account, fromMachine: "p1 route a", accountKept: false, accountHere: "codex", blockedReason: null });
    expect(missingAccount.warning).toBe(true);
    expect(missingAccount.message).toContain("codex");
    const key = readCrossMachineRoute({ label: "API key · openai", presetId: keyRoute })!;
    const blocked = crossMachineRouteNotice({ route: key, fromMachine: "p1 route a", accountKept: true, accountHere: null, blockedReason: "ADE could not prepare it on this machine." });
    expect(blocked.warning).toBe(true);
    expect(blocked.message).toContain("ADE could not prepare it on this machine.");
    // A capsule from elsewhere: no label or an oversized id is not trusted.
    expect(readCrossMachineRoute({ presetId: keyRoute })).toBeNull();
    expect(readCrossMachineRoute({ label: "x", credentialId: "k".repeat(201) })).toEqual({ label: "x" });
  });
});
