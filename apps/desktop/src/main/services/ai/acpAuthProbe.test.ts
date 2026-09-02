import { afterEach, describe, expect, it } from "vitest";
import { AcpRpcError } from "../chat/acpHost/acpConnection";
import { createMockAcpAgent } from "../chat/acpHost/mockAcpAgent";
import { isAcpAuthError, probeAcpProviderAuth, resetAcpAuthProbeCache } from "./acpAuthProbe";

describe("isAcpAuthError", () => {
  it("matches the live Qwen 0.22.3 session/new message", () => {
    expect(
      isAcpAuthError("Authentication required: Use Qwen Code CLI to authenticate first."),
    ).toBe(true);
    expect(
      isAcpAuthError("ACP session/new failed (-32000): Authentication required: Use Qwen Code CLI to authenticate first."),
    ).toBe(true);
  });

  it("matches the live Kimi 0.39.1 session/new message", () => {
    expect(isAcpAuthError("Authentication required")).toBe(true);
    expect(isAcpAuthError("ACP session/new failed (-32000): Authentication required")).toBe(true);
  });

  it("reads Qwen authenticate's missing-key details off AcpRpcError.data", () => {
    const error = new AcpRpcError("authenticate", {
      code: -32603,
      message: "Internal error",
      data: {
        details:
          "Missing API key for openai auth. Current model: 'coder-model', baseUrl: '(default)'. Provide an API key via settings (security.auth.apiKey), or set the environment variable 'OPENAI_API_KEY'.",
      },
    });
    expect(isAcpAuthError(error)).toBe(true);
    expect(isAcpAuthError(new AcpRpcError("authenticate", { code: -32603, message: "Internal error" }))).toBe(false);
  });

  it("does not treat a generic crash as a sign-in problem", () => {
    expect(isAcpAuthError("ACP session/prompt failed (-32603): boom")).toBe(false);
    expect(isAcpAuthError("")).toBe(false);
  });
});

describe("probeAcpProviderAuth", () => {
  afterEach(() => {
    resetAcpAuthProbeCache();
  });

  it("treats a successful session/new as signed in without calling authenticate", async () => {
    const agent = createMockAcpAgent({ authMethods: [{ id: "openai", name: "OpenAI" }] });
    agent.on("session/new", () => ({ result: { sessionId: "s1" } }));
    agent.on("authenticate", () => ({
      error: {
        code: -32603,
        message: "Internal error",
        data: { details: "Missing API key" },
      },
    }));
    const result = await probeAcpProviderAuth({
      provider: "qwen",
      cwd: "/lane",
      force: true,
      spawnOverride: () => agent.child,
    });
    expect(result).toEqual({ state: "ready", message: null });
    expect(agent.methodsReceived()).toContain("session/new");
    expect(agent.methodsReceived()).not.toContain("authenticate");
  });

  it("does not hang on a terminal login method after session/new is refused", async () => {
    const agent = createMockAcpAgent({
      authMethods: [{ id: "login", name: "Login", type: "terminal" }],
    });
    agent.on("session/new", () => ({
      error: { code: -32000, message: "Authentication required" },
    }));
    const result = await probeAcpProviderAuth({
      provider: "kimi",
      cwd: "/lane",
      force: true,
      spawnOverride: () => agent.child,
    });
    expect(result.state).toBe("auth-failed");
    expect(agent.methodsReceived()).not.toContain("authenticate");
  });
});
