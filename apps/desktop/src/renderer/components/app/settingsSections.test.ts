import { describe, expect, it } from "vitest";
import {
  getVisibleSettingsSections,
  resolveSettingsSectionFromTab,
} from "./settingsSections";

describe("settingsSections", () => {
  it("does not expose a dedicated onboarding settings section", () => {
    const ids = getVisibleSettingsSections(true).map((section) => section.id);
    expect(ids).not.toContain("onboarding");
  });

  it("redirects legacy help and onboarding tabs to General", () => {
    expect(resolveSettingsSectionFromTab("onboarding", true)).toBe("general");
    expect(resolveSettingsSectionFromTab("help", true)).toBe("general");
    expect(resolveSettingsSectionFromTab("tours", true)).toBe("general");
  });

  it("hides local-only sections outside dev/local builds", () => {
    const ids = getVisibleSettingsSections(false).map((section) => section.id);
    expect(ids).not.toContain("mobile-push");
  });

  it("shows and resolves local-only sections in dev/local builds", () => {
    const ids = getVisibleSettingsSections(true).map((section) => section.id);
    expect(ids).toContain("mobile-push");
    expect(resolveSettingsSectionFromTab("mobile-push", true)).toBe("mobile-push");
  });

  it("does not resolve local-only tabs outside dev/local builds", () => {
    expect(resolveSettingsSectionFromTab("mobile-push", false)).toBeNull();
  });
});
