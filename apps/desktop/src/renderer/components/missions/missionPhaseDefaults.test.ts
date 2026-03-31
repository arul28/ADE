import { describe, expect, it } from "vitest";
import {
  createBuiltInMissionPhaseCards,
  createBuiltInMissionPhaseProfiles,
  getDefaultBuiltInMissionPhaseProfile,
} from "./missionPhaseDefaults";

describe("createBuiltInMissionPhaseCards", () => {
  it("returns exactly 4 cards", () => {
    const cards = createBuiltInMissionPhaseCards();
    expect(cards).toHaveLength(4);
  });

  it("returns correct phaseKeys in order", () => {
    const cards = createBuiltInMissionPhaseCards();
    expect(cards.map((c) => c.phaseKey)).toEqual([
      "planning",
      "development",
      "testing",
      "validation",
    ]);
  });

  it("assigns sequential positions 0-3", () => {
    const cards = createBuiltInMissionPhaseCards();
    expect(cards.map((c) => c.position)).toEqual([0, 1, 2, 3]);
  });

  it("marks all cards as built-in and not custom", () => {
    const cards = createBuiltInMissionPhaseCards();
    for (const card of cards) {
      expect(card.isBuiltIn).toBe(true);
      expect(card.isCustom).toBe(false);
    }
  });

  it("sets planning card constraints: mustBeFirst, requiresApproval, askQuestions.enabled", () => {
    const cards = createBuiltInMissionPhaseCards();
    const planning = cards.find((c) => c.phaseKey === "planning");
    if (!planning) throw new Error("Planning card missing");
    expect(planning.orderingConstraints.mustBeFirst).toBe(true);
    expect(planning.requiresApproval).toBe(true);
    expect(planning.askQuestions.enabled).toBe(true);
  });

  it("sets testing card validationGate: tier=dedicated, required=true", () => {
    const cards = createBuiltInMissionPhaseCards();
    const testing = cards.find((c) => c.phaseKey === "testing");
    if (!testing) throw new Error("Testing card missing");
    expect(testing.validationGate.tier).toBe("dedicated");
    expect(testing.validationGate.required).toBe(true);
  });

  it("sets validation card validationGate: tier=dedicated, required=true", () => {
    const cards = createBuiltInMissionPhaseCards();
    const validation = cards.find((c) => c.phaseKey === "validation");
    if (!validation) throw new Error("Validation card missing");
    expect(validation.validationGate.tier).toBe("dedicated");
    expect(validation.validationGate.required).toBe(true);
  });

  it("propagates custom `at` parameter to createdAt and updatedAt", () => {
    const at = "2026-01-15T10:00:00.000Z";
    const cards = createBuiltInMissionPhaseCards(at);
    for (const card of cards) {
      expect(card.createdAt).toBe(at);
      expect(card.updatedAt).toBe(at);
    }
  });

  it("uses current time when `at` is not provided", () => {
    const before = new Date().toISOString();
    const cards = createBuiltInMissionPhaseCards();
    const after = new Date().toISOString();
    for (const card of cards) {
      expect(card.createdAt >= before).toBe(true);
      expect(card.createdAt <= after).toBe(true);
    }
  });

  it("development and testing use askQuestions.enabled = false", () => {
    const cards = createBuiltInMissionPhaseCards();
    const dev = cards.find((c) => c.phaseKey === "development");
    const test = cards.find((c) => c.phaseKey === "testing");
    if (!dev) throw new Error("Development card missing");
    if (!test) throw new Error("Testing card missing");
    expect(dev.askQuestions.enabled).toBe(false);
    expect(test.askQuestions.enabled).toBe(false);
  });

  it("each card has a unique id starting with builtin:", () => {
    const cards = createBuiltInMissionPhaseCards();
    const ids = cards.map((c) => c.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) {
      expect(id).toMatch(/^builtin:/);
    }
  });
});

describe("createBuiltInMissionPhaseProfiles", () => {
  it("returns exactly 2 profiles", () => {
    const cards = createBuiltInMissionPhaseCards();
    const profiles = createBuiltInMissionPhaseProfiles(cards);
    expect(profiles).toHaveLength(2);
  });

  it("creates Default profile with P->D->T->V ordering", () => {
    const cards = createBuiltInMissionPhaseCards();
    const profiles = createBuiltInMissionPhaseProfiles(cards);
    const defaultProfile = profiles.find((p) => p.name === "Default");
    if (!defaultProfile) throw new Error("Default profile missing");
    expect(defaultProfile.phases.map((p) => p.phaseKey)).toEqual([
      "planning",
      "development",
      "testing",
      "validation",
    ]);
  });

  it("creates TDD profile with P->T->D->V ordering", () => {
    const cards = createBuiltInMissionPhaseCards();
    const profiles = createBuiltInMissionPhaseProfiles(cards);
    const tddProfile = profiles.find((p) => p.name === "TDD");
    if (!tddProfile) throw new Error("TDD profile missing");
    expect(tddProfile.phases.map((p) => p.phaseKey)).toEqual([
      "planning",
      "testing",
      "development",
      "validation",
    ]);
  });

  it("marks Default as isDefault=true and TDD as isDefault=false", () => {
    const cards = createBuiltInMissionPhaseCards();
    const profiles = createBuiltInMissionPhaseProfiles(cards);
    const defaultProfile = profiles.find((p) => p.name === "Default");
    const tddProfile = profiles.find((p) => p.name === "TDD");
    if (!defaultProfile) throw new Error("Default profile missing");
    if (!tddProfile) throw new Error("TDD profile missing");
    expect(defaultProfile.isDefault).toBe(true);
    expect(tddProfile.isDefault).toBe(false);
  });

  it("marks both profiles as built-in", () => {
    const cards = createBuiltInMissionPhaseCards();
    const profiles = createBuiltInMissionPhaseProfiles(cards);
    for (const profile of profiles) {
      expect(profile.isBuiltIn).toBe(true);
    }
  });

  it("propagates custom `at` to profile createdAt/updatedAt", () => {
    const at = "2026-06-01T00:00:00.000Z";
    const cards = createBuiltInMissionPhaseCards();
    const profiles = createBuiltInMissionPhaseProfiles(cards, at);
    for (const profile of profiles) {
      expect(profile.createdAt).toBe(at);
      expect(profile.updatedAt).toBe(at);
    }
  });

  it("reassigns positions based on profile ordering", () => {
    const cards = createBuiltInMissionPhaseCards();
    const profiles = createBuiltInMissionPhaseProfiles(cards);
    const tddProfile = profiles.find((p) => p.name === "TDD");
    if (!tddProfile) throw new Error("TDD profile missing");
    // In TDD: planning=0, testing=1, development=2, validation=3
    expect(tddProfile.phases[0]?.position).toBe(0);
    expect(tddProfile.phases[1]?.position).toBe(1);
    expect(tddProfile.phases[2]?.position).toBe(2);
    expect(tddProfile.phases[3]?.position).toBe(3);
  });

  it("filters out unknown keys gracefully", () => {
    const cards = createBuiltInMissionPhaseCards();
    // Remove one card to simulate a missing key scenario
    const reducedCards = cards.filter((c) => c.phaseKey !== "testing");
    const profiles = createBuiltInMissionPhaseProfiles(reducedCards);
    const defaultProfile = profiles.find((p) => p.name === "Default");
    if (!defaultProfile) throw new Error("Default profile missing");
    // "testing" card is missing, so it should be filtered out
    expect(defaultProfile.phases).toHaveLength(3);
    expect(defaultProfile.phases.map((p) => p.phaseKey)).toEqual([
      "planning",
      "development",
      "validation",
    ]);
  });
});

describe("getDefaultBuiltInMissionPhaseProfile", () => {
  it("returns the Default profile", () => {
    const profile = getDefaultBuiltInMissionPhaseProfile();
    expect(profile.name).toBe("Default");
    expect(profile.isDefault).toBe(true);
  });

  it("includes all 4 phases in the correct order", () => {
    const profile = getDefaultBuiltInMissionPhaseProfile();
    expect(profile.phases).toHaveLength(4);
    expect(profile.phases.map((p) => p.phaseKey)).toEqual([
      "planning",
      "development",
      "testing",
      "validation",
    ]);
  });

  it("is marked as built-in", () => {
    const profile = getDefaultBuiltInMissionPhaseProfile();
    expect(profile.isBuiltIn).toBe(true);
  });
});
