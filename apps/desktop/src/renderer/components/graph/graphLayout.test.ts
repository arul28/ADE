import { describe, expect, it } from "vitest";
import { normalizeGraphPreferences } from "./graphLayout";

describe("normalizeGraphPreferences", () => {
  it("keeps the new preferences shape unchanged", () => {
    expect(normalizeGraphPreferences({ lastViewMode: "activity" })).toEqual({
      preferences: { lastViewMode: "activity" },
      migrated: false
    });
  });

  it("migrates legacy preset state to the last view mode", () => {
    const legacyState = {
      activePreset: "Risk preset",
      presets: [
        {
          name: "Risk preset",
          byViewMode: {
            risk: { viewMode: "risk" }
          }
        }
      ]
    };

    expect(normalizeGraphPreferences(legacyState)).toEqual({
      preferences: { lastViewMode: "risk" },
      migrated: true
    });
  });

  it("falls back to Overview for malformed stored data", () => {
    expect(normalizeGraphPreferences({ lastViewMode: "sideways", presets: "nope" })).toEqual({
      preferences: { lastViewMode: "all" },
      migrated: true
    });

    expect(normalizeGraphPreferences(null)).toEqual({
      preferences: { lastViewMode: "all" },
      migrated: false
    });
  });
});
