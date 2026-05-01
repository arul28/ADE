import { describe, expect, it } from "vitest";
import {
  allowCursorHook,
  denyCursorHook,
  evaluateCursorSdkHook,
  resolveCursorSdkPolicy,
  summarizeCursorHook,
} from "./cursorSdkPolicy";

describe("Cursor SDK policy", () => {
  it("maps Cursor modes to ADE permission policies", () => {
    expect(resolveCursorSdkPolicy({ cursorModeId: "ask" })).toMatchObject({
      chatMode: "ask",
      approvalPolicy: "read-only",
      force: false,
    });
    expect(resolveCursorSdkPolicy({ cursorModeId: "plan" })).toMatchObject({
      chatMode: "plan",
      approvalPolicy: "read-only",
      force: false,
    });
    expect(resolveCursorSdkPolicy({ cursorModeId: "full-auto" })).toMatchObject({
      chatMode: "agent",
      approvalPolicy: "never",
      force: true,
    });
  });

  it("allows reads, asks for risky tools, and denies protected paths", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "agent" });
    const laneRoot = "/tmp/ade-lane";

    const read = summarizeCursorHook({
      toolName: "read",
      toolInput: { path: "src/app.ts" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: read, policy, laneRoot })).toBe("allow");

    const shell = summarizeCursorHook({
      toolName: "shell",
      toolInput: { command: "npm test" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: shell, policy, laneRoot })).toBe("ask");

    const secret = summarizeCursorHook({
      toolName: "write",
      toolInput: { path: ".ade/secrets/key.json" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: secret, policy, laneRoot })).toBe("deny");
    expect(secret.reason).toContain("protected");
  });

  it("blocks side effects in read-only policy", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "plan" });
    const request = summarizeCursorHook({
      toolName: "write",
      toolInput: { path: "src/app.ts", content: "x" },
    }, "/tmp/ade-lane");
    expect(evaluateCursorSdkHook({ request, policy, laneRoot: "/tmp/ade-lane" })).toBe("deny");
  });

  it("does not special-case model-visible planning tools in read-only Cursor plan mode", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "plan" });
    const laneRoot = "/tmp/ade-lane";

    const planTool = summarizeCursorHook({
      toolName: "TodoWrite",
      toolInput: {
        todos: [{ content: "Inspect wiring", status: "in_progress" }],
      },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: planTool, policy, laneRoot })).toBe("deny");

    const mcpRequest = summarizeCursorHook({
      toolName: "mcp",
      toolInput: {
        serverName: "stale-planning-tools",
        toolName: "update_plan",
        arguments: { steps: [{ text: "Plan via ADE", status: "pending" }] },
      },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: mcpRequest, policy, laneRoot })).toBe("deny");
  });

  it("formats hook decisions for Cursor hooks", () => {
    expect(allowCursorHook()).toEqual({ permission: "allow" });
    expect(denyCursorHook("nope")).toEqual({
      permission: "deny",
      user_message: "nope",
      agent_message: "nope",
    });
  });

  it("denies any path-traversal escape from the lane root regardless of approval policy", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
    const laneRoot = "/tmp/ade-lane";

    const escape = summarizeCursorHook({
      toolName: "read",
      toolInput: { path: "/etc/passwd" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: escape, policy, laneRoot })).toBe("deny");

    const traversal = summarizeCursorHook({
      toolName: "read",
      toolInput: { path: "../../etc/passwd" },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: traversal, policy, laneRoot })).toBe("deny");
  });

  it("allows shells in full-auto without prompting", () => {
    const policy = resolveCursorSdkPolicy({ cursorModeId: "full-auto" });
    const laneRoot = "/tmp/ade-lane";
    const shell = summarizeCursorHook({
      toolName: "shell",
      toolInput: { command: "npm install", cwd: laneRoot },
    }, laneRoot);
    expect(evaluateCursorSdkHook({ request: shell, policy, laneRoot })).toBe("allow");
  });
});
