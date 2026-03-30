import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const spawnMock = vi.fn();
const execFileSyncMock = vi.fn();
const getAllApiKeysMock = vi.fn();

/** Helper: create a fake ChildProcess that immediately emits close with the given result. */
function fakeChild(result: { status: number | null; stdout?: string; stderr?: string }) {
  const child = new EventEmitter() as any;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  child.stdout = stdoutEmitter;
  child.stderr = stderrEmitter;
  // Emit data + close on next microtask so the caller can attach listeners first.
  queueMicrotask(() => {
    if (result.stdout) stdoutEmitter.emit("data", Buffer.from(result.stdout));
    if (result.stderr) stderrEmitter.emit("data", Buffer.from(result.stderr));
    child.emit("close", result.status);
  });
  return child;
}

/** Helper: simulate ENOENT (command not found) — emits "error" so spawnAsync resolves with status: null. */
function fakeError() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    child.emit("error", new Error("spawn ENOENT"));
  });
  return child;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

vi.mock("./apiKeyStore", () => ({
  getAllApiKeys: () => getAllApiKeysMock(),
}));

// Import AFTER mocks are set up — must re-import to reset the module-level cache.
let detectAllAuth: typeof import("./authDetector").detectAllAuth;
let detectCliAuthStatuses: typeof import("./authDetector").detectCliAuthStatuses;
let verifyProviderApiKey: typeof import("./authDetector").verifyProviderApiKey;
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

beforeEach(async () => {
  vi.resetModules();
  setPlatform("darwin");
  const mod = await import("./authDetector");
  detectAllAuth = mod.detectAllAuth;
  detectCliAuthStatuses = mod.detectCliAuthStatuses;
  verifyProviderApiKey = mod.verifyProviderApiKey;
});

describe("authDetector", () => {
  const originalEnv = { ...process.env };
  let tempHomeDir: string | null = null;

  beforeEach(() => {
    spawnMock.mockReset();
    execFileSyncMock.mockReset();
    getAllApiKeysMock.mockReset();
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setPlatform(originalPlatform);
    vi.unstubAllGlobals();
    if (tempHomeDir) {
      fs.rmSync(tempHomeDir, { recursive: true, force: true });
      tempHomeDir = null;
    }
  });

  it("reports installed-but-unauthenticated CLI providers", async () => {
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      // commandExists: direct spawn strategy
      if (args[0] === "--version") {
        if (command === "claude") return fakeChild({ status: 0, stdout: "1.0.0\n" });
        return fakeError();
      }
      // commandPath: which strategy
      if (command === "which") {
        if (args[0] === "claude") return fakeChild({ status: 0, stdout: "/usr/local/bin/claude\n" });
        return fakeChild({ status: 1 });
      }
      if ((command === "claude" || command.endsWith("/claude")) && args[0] === "auth") {
        return fakeChild({ status: 1, stderr: "Not logged in. Run `claude auth login`." });
      }
      return fakeChild({ status: 1 });
    });

    const statuses = await detectCliAuthStatuses();
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

    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (args[0] === "--version") {
        if (command === "claude") return fakeChild({ status: 0, stdout: "1.0.0\n" });
        return fakeError();
      }
      if (command === "which") {
        if (args[0] === "claude") return fakeChild({ status: 0, stdout: "/usr/local/bin/claude\n" });
        return fakeChild({ status: 1 });
      }
      if ((command === "claude" || command.endsWith("/claude")) && args[0] === "auth") {
        return fakeChild({ status: 0, stdout: "Authenticated as test-user\n" });
      }
      return fakeChild({ status: 1 });
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("11434")) {
          return new Response(JSON.stringify({ models: [{ name: "llama3.3" }] }), { status: 200 });
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

  it("does not report openai-compatible local providers when no models are loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("1234")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response("{}", { status: 503 });
      }),
    );

    const auth = await detectAllAuth({});

    expect(auth.some((entry) => entry.type === "local" && entry.provider === "lmstudio")).toBe(false);
  });

  it("marks unsupported CLI auth checks as unverified", async () => {
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (args[0] === "--version") {
        if (command === "claude") return fakeChild({ status: 0, stdout: "1.0.0\n" });
        return fakeError();
      }
      if (command === "which") {
        if (args[0] === "claude") return fakeChild({ status: 0, stdout: "/usr/local/bin/claude\n" });
        return fakeChild({ status: 1 });
      }
      if (command === "claude" || command.endsWith("/claude")) {
        return fakeChild({ status: 1, stderr: "unknown command 'auth'" });
      }
      return fakeChild({ status: 1 });
    });

    const statuses = await detectCliAuthStatuses();
    const claude = statuses.find((entry) => entry.cli === "claude");
    expect(claude?.verified).toBe(false);
    expect(claude?.authenticated).toBe(true);
  });

  it("finds codex through an npm-global prefix when PATH lookup fails", async () => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-auth-detector-"));
    const prefixDir = path.join(tempHomeDir, ".npm-global");
    fs.mkdirSync(path.join(prefixDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(tempHomeDir, ".npmrc"), "prefix=~/.npm-global\n", "utf8");
    fs.writeFileSync(path.join(prefixDir, "bin", "codex"), "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(path.join(prefixDir, "bin", "codex"), 0o755);
    process.env.HOME = tempHomeDir;
    process.env.PATH = "/usr/bin:/bin";

    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (args[0] === "--version") {
        if (command === "codex") return fakeError();
        if (command === path.join(prefixDir, "bin", "codex")) return fakeChild({ status: 0, stdout: "0.105.0\n" });
        return fakeError();
      }
      if (command === "which") {
        return fakeChild({ status: 1 });
      }
      if ((command === "codex" || command.endsWith("/codex")) && args[0] === "login" && args[1] === "status") {
        return fakeChild({ status: 0, stdout: "Authenticated as test-user\n" });
      }
      return fakeChild({ status: 1 });
    });

    const statuses = await detectCliAuthStatuses();
    const codex = statuses.find((entry) => entry.cli === "codex");

    expect(codex).toEqual({
      cli: "codex",
      installed: true,
      path: path.join(prefixDir, "bin", "codex"),
      authenticated: true,
      verified: true,
    });
  });

  it("repairs PATH from the interactive shell during a forced refresh", async () => {
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    process.env.SHELL = "/bin/zsh";

    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "-lc") {
        return "__ADE_PATH_START__/Users/arul/.local/bin:/usr/local/bin:/usr/bin:/bin__ADE_PATH_END__";
      }
      if (args[0] === "-ic") {
        return "shell noise\n__ADE_PATH_START__/Users/arul/.npm-global/bin:/Users/arul/.local/bin:/usr/local/bin:/usr/bin:/bin__ADE_PATH_END__";
      }
      throw new Error(`unexpected shell args: ${args.join(" ")}`);
    });

    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (args[0] === "--version") {
        if (command === "codex" && process.env.PATH?.includes("/Users/arul/.npm-global/bin")) {
          return fakeChild({ status: 0, stdout: "codex-cli 0.117.0\n" });
        }
        return fakeError();
      }
      if (command === "which") {
        if (args[0] === "codex" && process.env.PATH?.includes("/Users/arul/.npm-global/bin")) {
          return fakeChild({ status: 0, stdout: "/Users/arul/.npm-global/bin/codex\n" });
        }
        return fakeChild({ status: 1 });
      }
      if ((command === "codex" || command.endsWith("/codex")) && args[0] === "login" && args[1] === "status") {
        return fakeChild({ status: 0, stdout: "Logged in using ChatGPT\n" });
      }
      return fakeChild({ status: 1 });
    });

    const statuses = await detectCliAuthStatuses({ force: true });
    const codex = statuses.find((entry) => entry.cli === "codex");

    expect(process.env.PATH).toContain("/Users/arul/.npm-global/bin");
    expect(codex).toEqual({
      cli: "codex",
      installed: true,
      path: "/Users/arul/.npm-global/bin/codex",
      authenticated: true,
      verified: true,
    });
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
