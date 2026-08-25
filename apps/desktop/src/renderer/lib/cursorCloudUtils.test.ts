import { describe, expect, it } from "vitest";
import { cursorCloudAgentWebUrl, resolveCursorCloudPrCreateFields } from "./cursorCloudUtils";

describe("resolveCursorCloudPrCreateFields", () => {
  it("attaches to an existing PR and never also auto-creates", () => {
    expect(resolveCursorCloudPrCreateFields({
      existingPrUrl: "https://github.com/acme/project/pull/12",
      autoCreatePR: true,
    })).toEqual({
      autoCreatePR: false,
      prUrl: "https://github.com/acme/project/pull/12",
    });
  });

  it("passes through Open a PR when the branch has none", () => {
    expect(resolveCursorCloudPrCreateFields({ autoCreatePR: true })).toEqual({
      autoCreatePR: true,
    });
    expect(resolveCursorCloudPrCreateFields({ autoCreatePR: false })).toEqual({
      autoCreatePR: false,
    });
  });
});

describe("cursorCloudAgentWebUrl", () => {
  it("builds the public agent URL and ignores blanks", () => {
    expect(cursorCloudAgentWebUrl("bc-1")).toBe("https://cursor.com/agents?id=bc-1");
    expect(cursorCloudAgentWebUrl("  ")).toBeNull();
    expect(cursorCloudAgentWebUrl(null)).toBeNull();
  });
});
