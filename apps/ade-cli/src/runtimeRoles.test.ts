import { describe, expect, it } from "vitest";
import {
  ADE_SESSION_IDENTITY_ENV_VARS,
  describeSessionBoundRoleClamp,
  resolveSessionBoundRole,
} from "./runtimeRoles";

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

describe("describeSessionBoundRoleClamp", () => {
  it("names the inherited session, and every variable that has to go", () => {
    const message = describeSessionBoundRoleClamp("chat-1");
    expect(message).toBe(
      "This terminal carries an ADE agent session (ADE_CHAT_SESSION_ID is set),"
      + " so --role cto is clamped to agent. Run from a terminal you opened yourself,"
      + " or unset ADE_CHAT_SESSION_ID ADE_RUN_ID ADE_STEP_ID ADE_ATTEMPT_ID"
      + " ADE_OWNER_ID ADE_DEFAULT_ROLE.",
    );
    for (const variable of ADE_SESSION_IDENTITY_ENV_VARS) {
      expect(message).toContain(variable);
    }
  });

  it("stays silent for a caller whose refusal has some other cause", () => {
    // Without a session binding the clamp never ran, so blaming it would send a
    // reader to unset variables they do not have.
    expect(describeSessionBoundRoleClamp(null)).toBeNull();
    expect(describeSessionBoundRoleClamp("")).toBeNull();
  });
});
