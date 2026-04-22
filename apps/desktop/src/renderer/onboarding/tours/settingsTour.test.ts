import { describe, expect, it } from "vitest";
import { settingsTour } from "./settingsTour";
import { docs } from "../docsLinks";
import { getTour } from "../registry";

const VALID_DOCS_PREFIX = "https://www.ade-app.dev";

describe("settingsTour", () => {
  it("registers under id 'settings' and variant 'full'", () => {
    expect(settingsTour.id).toBe("settings");
    expect(settingsTour.variant).toBe("full");
    expect(getTour("settings", "full")).toBe(settingsTour);
  });

  it("has at least 6 non-empty steps", () => {
    expect(settingsTour.steps.length).toBeGreaterThanOrEqual(6);
  });

  it("opens with an actIntro hero step", () => {
    const hero = settingsTour.steps[0];
    expect(hero?.actIntro).toBeDefined();
    expect(hero?.target).toBe("");
  });

  it("every step has a title and docUrl", () => {
    for (const step of settingsTour.steps) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.docUrl).toBeDefined();
    }
  });

  it("every docUrl starts with the public docs prefix and has no /docs/ segment", () => {
    for (const step of settingsTour.steps) {
      expect(step.docUrl!.startsWith(VALID_DOCS_PREFIX)).toBe(true);
      expect(step.docUrl!).not.toContain("/docs/");
    }
  });

  it("uses only docUrls sourced from the shared docsLinks module", () => {
    const allowed = new Set<string>(Object.values(docs));
    for (const step of settingsTour.steps) {
      expect(allowed.has(step.docUrl!)).toBe(true);
    }
  });
});
