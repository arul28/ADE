import { describe, expect, it } from "vitest";
import { mapPermissionToClaude, mapPermissionToCodex } from "./permissionMapping";

describe("permissionMapping", () => {
  it("maps Codex edit to writable guarded execution", () => {
    expect(mapPermissionToCodex("edit")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
    expect(mapPermissionToCodex("plan")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    expect(mapPermissionToCodex("default")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
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
