import { describe, expect, it } from "vitest";
import { mapPermissionToClaude, mapPermissionToCodex } from "./permissionMapping";

describe("permissionMapping", () => {
  it("maps Codex edit to writable guarded execution", () => {
    expect(mapPermissionToCodex("edit")).toEqual({
      approvalPolicy: "on-failure",
      sandbox: "workspace-write",
    });
    expect(mapPermissionToCodex("plan")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
    });
  });

  it("preserves Codex full-auto and Claude accept-edits semantics", () => {
    expect(mapPermissionToCodex("full-auto")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(mapPermissionToClaude("edit")).toBe("acceptEdits");
  });
});
