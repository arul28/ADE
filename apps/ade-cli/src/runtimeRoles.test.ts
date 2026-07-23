import { describe, expect, it } from "vitest";
import { resolveSessionBoundRole } from "./runtimeRoles";

describe("resolveSessionBoundRole", () => {
  it("clamps inherited or requested CTO authority for session-bound callers", () => {
    expect(resolveSessionBoundRole({
      defaultRole: "cto",
      requestedRole: null,
      chatSessionId: "chat-1",
    })).toBe("agent");
    expect(resolveSessionBoundRole({
      defaultRole: "cto",
      requestedRole: "cto",
      chatSessionId: "chat-1",
    })).toBe("agent");
  });

  it("preserves explicit lower-privilege session identities", () => {
    for (const requestedRole of ["orchestrator", "agent", "external", "evaluator"] as const) {
      expect(resolveSessionBoundRole({
        defaultRole: "cto",
        requestedRole,
        chatSessionId: "chat-1",
      })).toBe(requestedRole);
    }
  });

  it("leaves unbound CTO callers unchanged", () => {
    expect(resolveSessionBoundRole({
      defaultRole: "cto",
      requestedRole: "cto",
      chatSessionId: null,
    })).toBe("cto");
  });
});
