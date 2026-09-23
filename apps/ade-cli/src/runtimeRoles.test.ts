import { describe, expect, it } from "vitest";
import { callerIdentityIsAgent, resolveSessionBoundRole } from "./runtimeRoles";

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
    for (const requestedRole of ["agent", "external", "evaluator"] as const) {
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

describe("callerIdentityIsAgent", () => {
  it("treats any chat, run, step or attempt id as an agent, and a blank one as absent", () => {
    expect(callerIdentityIsAgent({ chatSessionId: "chat-1" })).toBe(true);
    expect(callerIdentityIsAgent({ runId: "run-1" })).toBe(true);
    expect(callerIdentityIsAgent({ stepId: "step-1" })).toBe(true);
    expect(callerIdentityIsAgent({ attemptId: "attempt-1" })).toBe(true);
    expect(callerIdentityIsAgent({ chatSessionId: "  ", runId: null })).toBe(false);
    expect(callerIdentityIsAgent({})).toBe(false);
    expect(callerIdentityIsAgent(null)).toBe(false);
  });
});
