import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const spawnMock = vi.fn();
const execFileSyncMock = vi.fn();
const getAllApiKeysMock = vi.fn();
const cursorMeMock = vi.fn();
const cursorModelsListMock = vi.fn();
const reportProviderRuntimeAuthFailureMock = vi.fn();
const reportProviderRuntimeFailureMock = vi.fn();
const reportProviderRuntimeReadyMock = vi.fn();

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  const dynamicDefault = new Proxy({} as typeof actual, {
    get(_target, property) {
      const implementation = process.platform === "win32" ? actual.win32 : actual.posix;
      const value = implementation[property as keyof typeof implementation];
      return typeof value === "function" ? value.bind(implementation) : value;
    },
  });
  return { ...actual, default: dynamicDefault };
});

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

function commandBasename(command: string): string {
  return command.replace(/\\/g, "/").split("/").pop() ?? command;
}

function withExecutableMode(stat: fs.Stats): fs.Stats {
  return new Proxy(stat, {
    get(target, property, receiver) {
      if (property === "mode") return target.mode | 0o111;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

vi.mock("./cursorSdkLoader", () => ({
  loadCursorSdk: async () => ({
    Cursor: {
      me: (...args: unknown[]) => cursorMeMock(...args),
      models: {
        list: (...args: unknown[]) => cursorModelsListMock(...args),
      },
    },
  }),
}));

vi.mock("./providerRuntimeHealth", () => ({
  reportProviderRuntimeAuthFailure: (...args: unknown[]) => reportProviderRuntimeAuthFailureMock(...args),
  reportProviderRuntimeFailure: (...args: unknown[]) => reportProviderRuntimeFailureMock(...args),
  reportProviderRuntimeReady: (...args: unknown[]) => reportProviderRuntimeReadyMock(...args),
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
  cursorMeMock.mockReset();
  cursorModelsListMock.mockReset();
  reportProviderRuntimeAuthFailureMock.mockReset();
  reportProviderRuntimeFailureMock.mockReset();
  reportProviderRuntimeReadyMock.mockReset();
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
      if (commandBasename(command) === "claude" && args[0] === "auth") {
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

  it("can skip expensive CLI auth probes for passive status checks", async () => {
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (args[0] === "--version") {
        if (command === "claude") return fakeChild({ status: 0, stdout: "1.0.0\n" });
        return fakeError();
      }
      if (command === "which") {
        if (args[0] === "claude") return fakeChild({ status: 0, stdout: "/usr/local/bin/claude\n" });
        return fakeChild({ status: 1 });
      }
      if (commandBasename(command) === "claude" && args[0] === "auth") {
        throw new Error("auth probe should not run");
      }
      return fakeChild({ status: 1 });
    });

    const statuses = await detectCliAuthStatuses({ skipAuthProbe: true });
    const claude = statuses.find((entry) => entry.cli === "claude");

    expect(claude).toEqual({
      cli: "claude",
      installed: true,
      path: "/usr/local/bin/claude",
      authenticated: true,
      verified: false,
    });
    expect(spawnMock.mock.calls.some(([command, args]) => {
      const argv = Array.isArray(args) ? args : [];
      return String(command).includes("claude") && argv[0] === "auth";
    })).toBe(false);
  });

  it("detects and probes a Windows cursor-agent.cmd outside PATH", async () => {
    setPlatform("win32");
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-auth-win-"));
    const npmBin = path.join(tempHomeDir, "npm");
    const cursorAgentPath = path.join(npmBin, "cursor-agent.cmd");
    fs.mkdirSync(npmBin, { recursive: true });
    fs.writeFileSync(cursorAgentPath, "@echo off\r\n", "utf8");
    process.env.APPDATA = tempHomeDir;
    process.env.PATH = "C:\\Windows\\System32";
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      const commandLine = args.join(" ").toLowerCase();
      if (command.toLowerCase().endsWith("cmd.exe") && commandLine.includes("cursor-agent.cmd")) {
        if (commandLine.includes("--version")) return fakeChild({ status: 0, stdout: "1.0.0\n" });
        if (commandLine.includes("status")) {
          return fakeChild({ status: 0, stdout: '{"authenticated":true,"plan":"pro"}\n' });
        }
      }
      if (command === "where") return fakeChild({ status: 1 });
      return fakeError();
    });

    const statuses = await detectCliAuthStatuses({ force: true });
    expect(statuses.find((entry) => entry.cli === "cursor")).toMatchObject({
      cli: "cursor",
      installed: true,
      authenticated: true,
      verified: true,
      paidPlan: true,
    });
    expect(statuses.find((entry) => entry.cli === "cursor")?.path?.toLowerCase()).toBe(cursorAgentPath.toLowerCase());
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
      if (commandBasename(command) === "claude" && args[0] === "auth") {
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

  it("treats droid exec list-tools as a valid authenticated probe", async () => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-droid-auth-"));
    process.env.HOME = tempHomeDir;
    // Create a fake droid binary in a known bin dir so resolveDroidExecutable
    // (which uses fs.statSync against real paths) finds it without falling
    // through to the real CI PATH.
    const droidBinDir = path.join(tempHomeDir, ".local", "bin");
    fs.mkdirSync(droidBinDir, { recursive: true });
    const fakeDroidPath = path.join(droidBinDir, "droid");
    fs.writeFileSync(fakeDroidPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Strip PATH so resolveExecutableFromKnownLocations skips real binaries
    // on the CI runner and uses the temp home's known dirs.
    process.env.PATH = "";

    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (args[0] === "--version") {
        if (commandBasename(command) === "droid") return fakeChild({ status: 0, stdout: "0.70.0\n" });
        return fakeError();
      }
      if (command === "which") {
        if (args[0] === "droid") return fakeChild({ status: 0, stdout: `${fakeDroidPath}\n` });
        return fakeChild({ status: 1 });
      }
      if (commandBasename(command) === "droid" && args[0] === "exec" && args[1] === "--list-tools") {
        return fakeChild({ status: 0, stdout: "Available tools for Claude Opus 4.6\n" });
      }
      if (commandBasename(command) === "droid" && args[0] === "account") {
        return fakeChild({ status: 1, stderr: "unknown command 'account'\n" });
      }
      if (commandBasename(command) === "droid" && args[0] === "whoami") {
        return fakeChild({ status: 1, stderr: "unknown command 'whoami'\n" });
      }
      return fakeChild({ status: 1 });
    });

    const statuses = await detectCliAuthStatuses({ force: true });
    const droid = statuses.find((entry) => entry.cli === "droid");

    expect(droid).toEqual({
      cli: "droid",
      installed: true,
      path: fakeDroidPath,
      authenticated: true,
      verified: true,
    });
  });

  it("skips deep Droid auth probes during default detection without stored credentials", async () => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-droid-auth-shallow-"));
    process.env.HOME = tempHomeDir;
    const droidBinDir = path.join(tempHomeDir, ".local", "bin");
    fs.mkdirSync(droidBinDir, { recursive: true });
    const fakeDroidPath = path.join(droidBinDir, "droid");
    fs.writeFileSync(fakeDroidPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = "";
    const realStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((candidatePath: fs.PathLike, options?: fs.StatOptions) => {
      const stat = realStatSync(candidatePath, options as fs.StatOptions | undefined);
      return String(candidatePath) === fakeDroidPath ? withExecutableMode(stat) : stat;
    }) as typeof fs.statSync);

    try {
      spawnMock.mockImplementation((command: string, _args: string[] = []) => {
        if (command === "which") {
          return fakeChild({ status: 1 });
        }
        return fakeError();
      });

      const statuses = await detectCliAuthStatuses();
      const droid = statuses.find((entry) => entry.cli === "droid");

      expect(droid).toEqual({
        cli: "droid",
        installed: true,
        path: fakeDroidPath,
        authenticated: false,
        verified: false,
      });
      const droidDeepProbeCalls = spawnMock.mock.calls.filter(([command, args]) => {
        const commandText = String(command);
        const argv = Array.isArray(args) ? args as string[] : [];
        return commandBasename(commandText) === "droid"
          && (argv[0] === "exec" || argv[0] === "account" || argv[0] === "whoami");
      });
      expect(droidDeepProbeCalls).toHaveLength(0);
    } finally {
      statSpy.mockRestore();
    }
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

  it("falls back from an empty configured LM Studio endpoint to the auto-detected endpoint and preserves the preferred model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "http://lmstudio.example:1234/api/v1/models") {
          return new Response("{}", { status: 404 });
        }
        if (url === "http://lmstudio.example:1234/v1/models") {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (url === "http://127.0.0.1:1234/api/v1/models") {
          return new Response("{}", { status: 404 });
        }
        if (url === "http://127.0.0.1:1234/v1/models") {
          return new Response(JSON.stringify({
            data: [{ id: "gemma-4" }],
          }), { status: 200 });
        }
        return new Response("{}", { status: 503 });
      }),
    );

    const auth = await detectAllAuth({}, {
      localProviders: {
        lmstudio: {
          endpoint: "http://lmstudio.example:1234",
          autoDetect: true,
          preferredModelId: "lmstudio/gemma-4",
        },
      },
    });

    expect(auth).toContainEqual(expect.objectContaining({
      type: "local",
      provider: "lmstudio",
      endpoint: "http://127.0.0.1:1234",
      endpointSource: "auto",
      preferredModelId: "lmstudio/gemma-4",
    }));
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
      if (commandBasename(command) === "claude") {
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
    const preferredCodexPath = path.join(prefixDir, "bin", "codex");
    fs.mkdirSync(path.join(prefixDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(tempHomeDir, ".npmrc"), "prefix=~/.npm-global\n", "utf8");
    fs.writeFileSync(preferredCodexPath, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(preferredCodexPath, 0o755);
    process.env.HOME = tempHomeDir;
    process.env.PATH = "/usr/bin:/bin";

    const realStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((candidatePath: fs.PathLike, options?: fs.StatOptions) => {
      const resolved = String(candidatePath);
      if (commandBasename(resolved) === "codex" && resolved !== preferredCodexPath) {
        const error = new Error(`ENOENT: no such file or directory, stat '${resolved}'`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      const stat = realStatSync(candidatePath, options as fs.StatOptions | undefined);
      return resolved === preferredCodexPath ? withExecutableMode(stat) : stat;
    }) as typeof fs.statSync);

    try {
      spawnMock.mockImplementation((command: string, args: string[] = []) => {
        if (args[0] === "--version") {
          if (command === "codex") return fakeError();
          if (command === preferredCodexPath) return fakeChild({ status: 0, stdout: "0.105.0\n" });
          return fakeError();
        }
        if (command === "which") {
          return fakeChild({ status: 1 });
        }
        if (commandBasename(command) === "codex" && args[0] === "login" && args[1] === "status") {
          return fakeChild({ status: 0, stdout: "Authenticated as test-user\n" });
        }
        return fakeChild({ status: 1 });
      });

      const statuses = await detectCliAuthStatuses();
      const codex = statuses.find((entry) => entry.cli === "codex");

      expect(codex).toEqual({
        cli: "codex",
        installed: true,
        path: preferredCodexPath,
        authenticated: true,
        verified: true,
      });
    } finally {
      statSpy.mockRestore();
    }
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
      if (commandBasename(command) === "codex" && args[0] === "login" && args[1] === "status") {
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
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyProviderApiKey("openai", "sk-test");
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.statusCode).toBe(200);
    expect(result.endpoint).toBe("https://api.openai.com/v1/responses");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "gpt-5-nano",
          input: "ping",
          max_output_tokens: 1,
        }),
      }),
    );
  });

  it("falls back to gpt-5-mini when gpt-5-nano is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "The model gpt-5-nano does not exist or you do not have access to it." },
      }), { status: 404 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyProviderApiKey("openai", "sk-test");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "gpt-5-mini",
          input: "ping",
          max_output_tokens: 1,
        }),
      }),
    );
  });

  it("reports model access gaps separately from invalid OpenAI keys", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "You do not have access to model gpt-5-nano." },
      }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "You do not have access to model gpt-5-mini." },
      }), { status: 403 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyProviderApiKey("openai", "sk-test");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("API key is valid");
    expect(result.endpoint).toBe("https://api.openai.com/v1/models");
  });

  it("marks Cursor runtime ready only after API key and model access verification succeeds", async () => {
    cursorMeMock.mockResolvedValue({ userEmail: "user@example.test" });
    cursorModelsListMock.mockResolvedValue([{ id: "composer-1" }]);

    const result = await verifyProviderApiKey("cursor", "crsr_test");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("user@example.test");
    expect(result.endpoint).toBe("Cursor.me + Cursor.models.list");
    expect(cursorMeMock).toHaveBeenCalledWith({ apiKey: "crsr_test" });
    expect(cursorModelsListMock).toHaveBeenCalledWith({ apiKey: "crsr_test" });
    expect(reportProviderRuntimeReadyMock).toHaveBeenCalledWith("cursor");
    expect(reportProviderRuntimeAuthFailureMock).not.toHaveBeenCalled();
    expect(reportProviderRuntimeFailureMock).not.toHaveBeenCalled();
  });

  it("does not mark Cursor runtime ready when model access verification fails", async () => {
    cursorMeMock.mockResolvedValue({ userEmail: "user@example.test" });
    cursorModelsListMock.mockRejectedValue(new Error("Forbidden: model access denied"));

    const result = await verifyProviderApiKey("cursor", "crsr_test");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Authentication failed");
    expect(result.endpoint).toBe("Cursor.me + Cursor.models.list");
    expect(reportProviderRuntimeReadyMock).not.toHaveBeenCalled();
    expect(reportProviderRuntimeAuthFailureMock).toHaveBeenCalledWith(
      "cursor",
      "Cursor rejected the configured API key. Check the key from the Cursor dashboard API page.",
    );
  });

  it("does not mark Cursor runtime ready when model access returns no models", async () => {
    cursorMeMock.mockResolvedValue({ userEmail: "user@example.test" });
    cursorModelsListMock.mockResolvedValue([]);

    const result = await verifyProviderApiKey("cursor", "crsr_test");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("no available models");
    expect(reportProviderRuntimeReadyMock).not.toHaveBeenCalled();
    expect(reportProviderRuntimeFailureMock).toHaveBeenCalledWith(
      "cursor",
      "Cursor model verification returned no available models.",
    );
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
