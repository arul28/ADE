import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();
const getAllApiKeysMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  };
});

vi.mock("./apiKeyStore", () => ({
  getAllApiKeys: () => getAllApiKeysMock(),
}));

import { detectAllAuth, detectCliAuthStatuses, verifyProviderApiKey } from "./authDetector";

function spawnResult(args: { status: number | null; stdout?: string; stderr?: string }) {
  return {
    status: args.status,
    stdout: args.stdout ?? "",
    stderr: args.stderr ?? "",
  };
}

describe("authDetector", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    spawnSyncMock.mockReset();
    getAllApiKeysMock.mockReset();
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("reports installed-but-unauthenticated CLI providers", () => {
    spawnSyncMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "sh" && args[0] === "-lc") {
        const script = args[1] ?? "";
        if (script.includes("command -v claude >/dev/null")) return spawnResult({ status: 0 });
        if (script.includes("command -v codex >/dev/null")) return spawnResult({ status: 1 });
        if (script.includes("command -v gemini >/dev/null")) return spawnResult({ status: 1 });
        if (script.trim() === "command -v claude") {
          return spawnResult({ status: 0, stdout: "/usr/local/bin/claude\n" });
        }
      }
      if (command === "claude" && args[0] === "auth") {
        return spawnResult({ status: 1, stderr: "Not logged in. Run `claude auth login`." });
      }
      return spawnResult({ status: 1 });
    });

    const statuses = detectCliAuthStatuses();
    const claude = statuses.find((entry) => entry.cli === "claude");

    expect(claude).toEqual({
      cli: "claude",
      installed: true,
      path: "/usr/local/bin/claude",
      authenticated: false,
      verified: true,
    });
  });

  it("merges config, store, env, and local endpoint auth sources", async () => {
    getAllApiKeysMock.mockReturnValue({
      anthropic: "store-anthropic",
      openai: "store-openai",
    });

    process.env.OPENAI_API_KEY = "env-openai";
    process.env.GROQ_API_KEY = "env-groq";

    spawnSyncMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "sh" && args[0] === "-lc") {
        const script = args[1] ?? "";
        if (script.includes("command -v claude >/dev/null")) return spawnResult({ status: 0 });
        if (script.includes("command -v codex >/dev/null")) return spawnResult({ status: 1 });
        if (script.includes("command -v gemini >/dev/null")) return spawnResult({ status: 1 });
        if (script.trim() === "command -v claude") {
          return spawnResult({ status: 0, stdout: "/usr/local/bin/claude\n" });
        }
      }
      if (command === "claude" && args[0] === "auth") {
        return spawnResult({ status: 0, stdout: "Authenticated as test-user\n" });
      }
      return spawnResult({ status: 1 });
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("11434")) {
          return new Response("{}", { status: 200 });
        }
        return new Response("{}", { status: 503 });
      }),
    );

    const auth = await detectAllAuth({
      openai: "config-openai",
      deepseek: "config-deepseek",
      openrouter: "config-openrouter",
    });

    expect(auth).toContainEqual(
      expect.objectContaining({
        type: "cli-subscription",
        cli: "claude",
        authenticated: true,
        verified: true,
      }),
    );

    expect(auth).toContainEqual(
      expect.objectContaining({
        type: "api-key",
        provider: "openai",
        source: "config",
      }),
    );

    expect(auth).toContainEqual(
      expect.objectContaining({
        type: "api-key",
        provider: "anthropic",
        source: "store",
      }),
    );

    expect(auth).toContainEqual(
      expect.objectContaining({
        type: "api-key",
        provider: "deepseek",
        source: "config",
      }),
    );

    expect(auth).toContainEqual(
      expect.objectContaining({
        type: "api-key",
        provider: "groq",
        source: "env",
      }),
    );

    expect(auth).toContainEqual(
      expect.objectContaining({
        type: "openrouter",
        source: "config",
      }),
    );

    expect(auth).toContainEqual(
      expect.objectContaining({
        type: "local",
        provider: "ollama",
        endpoint: "http://localhost:11434",
      }),
    );
  });

  it("marks unsupported CLI auth checks as unverified", () => {
    spawnSyncMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "sh" && args[0] === "-lc") {
        const script = args[1] ?? "";
        if (script.includes("command -v claude >/dev/null")) return spawnResult({ status: 0 });
        if (script.includes("command -v codex >/dev/null")) return spawnResult({ status: 1 });
        if (script.includes("command -v gemini >/dev/null")) return spawnResult({ status: 1 });
        if (script.trim() === "command -v claude") {
          return spawnResult({ status: 0, stdout: "/usr/local/bin/claude\n" });
        }
      }
      if (command === "claude") {
        return spawnResult({ status: 1, stderr: "unknown command 'auth'" });
      }
      return spawnResult({ status: 1 });
    });

    const statuses = detectCliAuthStatuses();
    const claude = statuses.find((entry) => entry.cli === "claude");
    expect(claude?.verified).toBe(false);
    expect(claude?.authenticated).toBe(true);
  });

  it("verifies API keys with provider endpoints", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );

    const result = await verifyProviderApiKey("openai", "sk-test");
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.statusCode).toBe(200);
    expect(result.endpoint).toContain("api.openai.com");
  });

  it("returns auth failure for invalid API keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );

    const result = await verifyProviderApiKey("anthropic", "bad-key");
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.message).toContain("Authentication failed");
  });
});
