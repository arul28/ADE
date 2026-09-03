import { describe, expect, it } from "vitest";
import { buildClaudeToolApprovalOptions, claudeToolNeedsDefaultToNo } from "./claudePermissionDialog";

describe("claude permission dialog options", () => {
  it("detects default_to_no from either camelCase or snake_case SDK options", () => {
    expect(claudeToolNeedsDefaultToNo({ defaultToNo: true })).toBe(true);
    expect(claudeToolNeedsDefaultToNo({ default_to_no: true })).toBe(true);
    expect(claudeToolNeedsDefaultToNo({ defaultToNo: false })).toBe(false);
    expect(claudeToolNeedsDefaultToNo({})).toBe(false);
    expect(claudeToolNeedsDefaultToNo(null)).toBe(false);
  });

  it("omits a recommended Allow and the session override on elevated-risk asks", () => {
    expect(buildClaudeToolApprovalOptions({ defaultToNo: true })).toEqual([
      { label: "Allow", value: "allow" },
      { label: "Deny", value: "deny" },
    ]);
  });

  it("keeps Allow recommended plus Allow for Session on ordinary asks", () => {
    expect(buildClaudeToolApprovalOptions({ defaultToNo: false })).toEqual([
      { label: "Allow", value: "allow", recommended: true },
      { label: "Allow for Session", value: "allow_session" },
      { label: "Deny", value: "deny" },
    ]);
  });
});
