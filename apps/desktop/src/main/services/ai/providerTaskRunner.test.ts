import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const resolveClaudeCodeExecutableMock = vi.fn(() => ({
  path: "/ade-test/tools/claude",
  source: "tools-cache",
}));
const resolveCodexExecutableMock = vi.fn(() => ({
  path: "/ade-test/tools/codex",
  source: "tools-cache",
}));
const resolveCopilotExecutableMock = vi.fn(() => ({
  path: "/ade-test/tools/copilot",
  source: "tools-cache",
}));
const resolveQwenExecutableMock = vi.fn(() => ({
  path: "/ade-test/tools/qwen",
  source: "tools-cache",
}));
const resolveKimiExecutableMock = vi.fn(() => ({
  path: "/ade-test/tools/kimi",
  source: "tools-cache",
}));
const resolveGrokExecutableMock = vi.fn(() => ({
  path: "/ade-test/tools/grok",
  source: "tools-cache",
}));
const cursorLocalPromptMock = vi.fn();
const copilotUtilityMock = vi.fn();
const releaseCopilotConnectionMock = vi.fn();
const acquireCopilotConnectionMock = vi.fn(async (_args: unknown) => ({
  pooled: { utility: (...args: unknown[]) => copilotUtilityMock(...args) },
  poolKey: "copilot-pool",
  generation: 7,
}));
const assertCursorSdkSupportedMock = vi.fn();
const openCodeTextPromptMock = vi.fn();
const antigravityCredentialsMock = vi.fn(async (_env: unknown) => ({ authenticated: false, verified: false, method: null }));
const getApiKeyMock = vi.fn((_provider: string): string | null => null);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof childProcess>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

vi.mock("./claudeCodeExecutable", () => ({
  resolveClaudeCodeExecutable: () => resolveClaudeCodeExecutableMock(),
}));

vi.mock("./codexExecutable", () => ({
  resolveCodexExecutable: () => resolveCodexExecutableMock(),
}));

vi.mock("./acpExecutables", () => ({
  resolveCopilotExecutable: () => resolveCopilotExecutableMock(),
  // Copilot one-shot tasks run on the SDK runtime; the stub resolves the same path.
  resolveCopilotSdkRuntime: () => resolveCopilotExecutableMock(),
  resolveQwenExecutable: () => resolveQwenExecutableMock(),
  resolveKimiExecutable: () => resolveKimiExecutableMock(),
  resolveGrokExecutable: () => resolveGrokExecutableMock(),
  resolveAntigravityExecutable: () => ({ path: "/tools/antigravity/agy_acp_server.par", source: "tools-cache" }),
}));

// ADE's pinned copies live in the tools cache; the resolver is that boundary.
vi.mock("../pty/pinnedProviderCli", () => ({
  requirePinnedProviderCli: async (provider: string) => ({
    provider,
    command: provider === "pi" ? "/tools/node/bin/node" : `/tools/${provider}/bin/${provider}`,
    leadingArgs: provider === "pi" ? ["/tools/pi/dist/cli.js"] : [],
    env: {},
  }),
}));

// OpenCode runs an HTTP server; a misrouted task would land here.
vi.mock("../opencode/openCodeSession", () => ({
  runOpenCodeTextPrompt: (...args: unknown[]) => openCodeTextPromptMock(...args),
}));

// The real check reads the agent's settings file and the macOS keychain.
vi.mock("./antigravityAuth", () => ({
  inspectAntigravityCredentials: (env: unknown) => antigravityCredentialsMock(env),
}));

// The real store reads the OS credential store, so a developer machine with a
// Cursor key stored would silently skip the missing-key branch.
vi.mock("./apiKeyStore", () => ({
  getApiKey: (provider: string) => getApiKeyMock(provider),
}));

vi.mock("./cursorSdkLoader", () => ({
  assertCursorSdkSupportedOnThisPlatform: (...args: unknown[]) => assertCursorSdkSupportedMock(...args),
}));

vi.mock("../chat/cursorSdkPool", () => ({
  runCursorSdkLocalPrompt: (...args: unknown[]) => cursorLocalPromptMock(...args),
}));

// The Copilot SDK worker is a forked process; the pool is its boundary.
vi.mock("../chat/copilotSdkPool", () => ({
  acquireCopilotSdkConnection: (args: unknown) => acquireCopilotConnectionMock(args),
  releaseCopilotSdkConnection: (...args: unknown[]) => releaseCopilotConnectionMock(...args),
}));

import { makeCodexCompatibleJsonSchema, runProviderTask } from "./providerTaskRunner";
import { quoteWindowsCmdArg } from "../shared/processExecution";

// `runCommand` launches CLIs through `resolveCliSpawnInvocation`. On Windows an
// extensionless/`.cmd`/`.bat` launcher cannot be handed to CreateProcess, so the
// invocation becomes `%ComSpec% /d /s /c "<quoted command line>"` and every
// argument is folded into one string. These helpers assert the same argument
// content on both shapes instead of encoding the POSIX shape only.
const isWindowsLaunch = process.platform === "win32";

function expectedLaunchCommand(executablePath: string): string {
  return isWindowsLaunch ? (process.env.ComSpec?.trim() || "cmd.exe") : executablePath;
}

function launchArgvContains(argv: unknown, value: string): boolean {
  const args = Array.isArray(argv) ? (argv as string[]) : [];
  return isWindowsLaunch
    ? args.join(" ").includes(quoteWindowsCmdArg(value))
    : args.includes(value);
}

function launchArgvValueAfter(argv: unknown, flag: string): string | null {
  const args = Array.isArray(argv) ? (argv as string[]) : [];
  if (!isWindowsLaunch) {
    const index = args.indexOf(flag);
    return index >= 0 ? (args[index + 1] ?? null) : null;
  }
  const match = args
    .join(" ")
    .match(new RegExp(`${quoteWindowsCmdArg(flag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} "([^"]+)"`));
  return match?.[1] ?? null;
}

/** `values` appear as consecutive arguments, in order (e.g. `-c service_tier=default`). */
function launchArgvContainsRun(argv: unknown, values: string[]): boolean {
  const args = Array.isArray(argv) ? (argv as string[]) : [];
  if (isWindowsLaunch) return args.join(" ").includes(values.map(quoteWindowsCmdArg).join(" "));
  return args.some((_, start) => values.every((value, offset) => args[start + offset] === value));
}

type MockSpawnProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function createMockProcess(args: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  onStart?: () => void;
  deferClose?: boolean;
} = {}): MockSpawnProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), {
    end: vi.fn(),
  });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 1234,
    exitCode: null,
    signalCode: null,
  }) as MockSpawnProcess;

  queueMicrotask(() => {
    args.onStart?.();
    if (args.stdout) stdout.emit("data", Buffer.from(args.stdout, "utf8"));
    if (args.stderr) stderr.emit("data", Buffer.from(args.stderr, "utf8"));
    if (!args.deferClose) child.emit("close", args.exitCode ?? 0);
  });

  return child;
}

// Background jobs read the provider's config folder and build a private copy
// under the ADE home. Point both at a scratch folder, never the real ones.
let scratchHome = "";
beforeEach(() => {
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-provider-task-home-"));
  vi.stubEnv("ADE_HOME", path.join(scratchHome, "ade"));
  vi.stubEnv("FACTORY_HOME_OVERRIDE", scratchHome);
  vi.stubEnv("KIMI_CODE_HOME", path.join(scratchHome, "kimi"));
  vi.stubEnv("GROK_HOME", path.join(scratchHome, "grok"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(scratchHome, "config"));
  vi.stubEnv("APPDATA", path.join(scratchHome, "appdata"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(scratchHome, { recursive: true, force: true });
  spawnMock.mockReset();
  resolveClaudeCodeExecutableMock.mockClear();
  resolveCodexExecutableMock.mockClear();
  resolveCopilotExecutableMock.mockClear();
  resolveQwenExecutableMock.mockClear();
  resolveKimiExecutableMock.mockClear();
  resolveGrokExecutableMock.mockClear();
  cursorLocalPromptMock.mockReset();
  assertCursorSdkSupportedMock.mockReset();
  getApiKeyMock.mockReset();
  getApiKeyMock.mockReturnValue(null);
  openCodeTextPromptMock.mockReset();
});

describe("runProviderTask", () => {
  it("converts structured schemas to Codex-compatible strict object schemas", () => {
    const schema = {
      type: "object",
      properties: {
        reasoning: { type: "string" },
        adjustments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["no_change", "add_step"] },
              reason: { type: "string" },
              targetStepKey: { type: "string" },
              newStep: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  instructions: { type: "string" },
                },
              },
            },
            required: ["action", "reason"],
          },
        },
      },
      required: ["reasoning", "adjustments"],
    };

    const strict = makeCodexCompatibleJsonSchema(schema) as any;

    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(["reasoning", "adjustments"]);
    const itemSchema = strict.properties.adjustments.items;
    expect(itemSchema.additionalProperties).toBe(false);
    expect(itemSchema.required).toEqual(["action", "reason", "targetStepKey", "newStep"]);
    expect(itemSchema.properties.targetStepKey.type).toEqual(["string", "null"]);
    expect(itemSchema.properties.newStep.type).toEqual(["object", "null"]);
    expect(itemSchema.properties.newStep.additionalProperties).toBe(false);
    expect(itemSchema.properties.newStep.required).toEqual(["title", "instructions"]);
  });

  it("pipes Claude prompts over stdin instead of argv", async () => {
    let child: MockSpawnProcess | null = null;
    spawnMock.mockImplementationOnce(() => {
      child = createMockProcess({ stdout: '{"result":"READY"}' });
      return child;
    });

    const result = await runProviderTask({
      cwd: process.cwd(),
      descriptor: {
        family: "anthropic",
        isCliWrapped: true,
        providerModelId: "claude-sonnet-5",
      } as any,
      prompt: "Summarize the worktree state.",
      feature: "unit-test",
      projectConfig: {} as any,
    });

    expect(result.text).toBe("READY");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, argv, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe(expectedLaunchCommand("/ade-test/tools/claude"));
    expect(launchArgvContains(argv, "-p")).toBe(true);
    expect(launchArgvContains(argv, "Summarize the worktree state.")).toBe(false);
    expect(options).toMatchObject({
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(child!.stdin.end).toHaveBeenCalledWith("Summarize the worktree state.");
  });

  it.each([
    {
      label: "forwards a tier the descriptor advertises",
      descriptor: {
        family: "anthropic",
        isCliWrapped: true,
        providerModelId: "claude-haiku-5-5",
        reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
        capabilities: { reasoning: true },
      },
      reasoningEffort: "high",
      expectedEffort: "high",
    },
    {
      label: "maps ultracode onto the CLI's xhigh tier",
      descriptor: {
        family: "anthropic",
        isCliWrapped: true,
        providerModelId: "claude-fable-5-1",
        reasoningTiers: ["low", "medium", "high", "xhigh", "max", "ultracode"],
        capabilities: { reasoning: true },
      },
      reasoningEffort: "ultracode",
      expectedEffort: "xhigh",
    },
    {
      label: "omits a tier the descriptor does not advertise",
      descriptor: {
        family: "anthropic",
        isCliWrapped: true,
        providerModelId: "claude-haiku-5-5",
        reasoningTiers: ["low", "high"],
        capabilities: { reasoning: true },
      },
      reasoningEffort: "xhigh",
      expectedEffort: null,
    },
    {
      label: "omits effort entirely when the model has no reasoning",
      descriptor: {
        family: "anthropic",
        isCliWrapped: true,
        providerModelId: "claude-haiku-5-5",
        reasoningTiers: ["low", "medium", "high", "xhigh", "max"],
        capabilities: { reasoning: false },
      },
      reasoningEffort: "high",
      expectedEffort: null,
    },
  ])("$label for a Claude task", async ({ descriptor, reasoningEffort, expectedEffort }) => {
    spawnMock.mockImplementationOnce(() => createMockProcess({ stdout: '{"result":"READY"}' }));

    await runProviderTask({
      cwd: process.cwd(),
      descriptor: descriptor as any,
      prompt: "Summarize the worktree state.",
      feature: "unit-test",
      reasoningEffort,
      projectConfig: {} as any,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, argv] = spawnMock.mock.calls[0]!;
    expect(launchArgvValueAfter(argv, "--effort")).toBe(expectedEffort);
  });

  it("terminates a provider task's process group when writing its prompt fails", async () => {
    const child = createMockProcess({ deferClose: true });
    spawnMock.mockReturnValueOnce(child);
    // The mock's pid is not ours: never let the group kill reach the real OS.
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true as const) as typeof process.kill);

    const pending = runProviderTask({
      cwd: process.cwd(),
      descriptor: {
        family: "anthropic",
        isCliWrapped: true,
        providerModelId: "claude-sonnet-5",
      } as any,
      prompt: "This prompt cannot be delivered.",
      feature: "unit-test",
      projectConfig: {} as any,
    });

    await vi.waitFor(() => {
      expect(child.stdin.end).toHaveBeenCalled();
    });
    child.stdin.emit("error", Object.assign(new Error("EIO"), { code: "EIO" }));

    try {
      await expect(pending).rejects.toThrow("EIO");
      if (process.platform === "win32") expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      else expect(killSpy).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    } finally {
      // Exited, so the delayed SIGKILL refuses to fire after the spy is gone.
      child.exitCode = 1;
      killSpy.mockRestore();
    }
  });

  it("pipes Codex prompts over stdin instead of argv", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-provider-task-runner-"));
    spawnMock.mockImplementationOnce((_command: unknown, argv: string[]) => {
      const outputPath = launchArgvValueAfter(argv, "--output-last-message");
      return createMockProcess({
        onStart: () => {
          if (outputPath) {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, "DONE", "utf8");
          }
        },
      });
    });
    const mkdtempSpy = vi.spyOn(fs, "mkdtempSync").mockReturnValueOnce(tmpDir);

    try {
      const result = await runProviderTask({
        cwd: process.cwd(),
        descriptor: {
          family: "openai",
          isCliWrapped: true,
          providerModelId: "gpt-5.3-codex",
        } as any,
        prompt: "Fix the Windows launcher.",
        system: "Be concise.",
        feature: "unit-test",
        permissionMode: "edit",
        imagePaths: ["/tmp/settings.png"],
        projectConfig: {} as any,
      });

      expect(result.text).toBe("DONE");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [command, argv, options] = spawnMock.mock.calls[0]!;
      expect(command).toBe(expectedLaunchCommand("/ade-test/tools/codex"));
      expect(launchArgvContains(argv, "exec")).toBe(true);
      expect(launchArgvContains(argv, "-")).toBe(true);
      expect(launchArgvContains(argv, "--image")).toBe(true);
      expect(launchArgvContains(argv, "/tmp/settings.png")).toBe(true);
      expect(launchArgvContains(argv, "Fix the Windows launcher.")).toBe(false);
      expect(options).toMatchObject({
        stdio: ["pipe", "pipe", "pipe"],
      });
      const child = spawnMock.mock.results[0]!.value as MockSpawnProcess;
      expect(child.stdin.end).toHaveBeenCalledWith("Be concise.\n\nFix the Windows launcher.");
    } finally {
      mkdtempSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "a background utility call", backgroundUtility: true },
    { label: "an ordinary read-only call", backgroundUtility: false },
  ])("launches Claude for $label", async ({ backgroundUtility }) => {
    spawnMock.mockImplementationOnce(() => createMockProcess({ stdout: '{"result":"{\\"title\\":\\"Fix\\"}"}' }));

    await runProviderTask({
      cwd: process.cwd(),
      descriptor: { family: "anthropic", isCliWrapped: true, providerModelId: "claude-haiku-5-5" } as any,
      prompt: "Name this chat.",
      feature: "unit-test",
      jsonSchema: { type: "object", properties: { title: { type: "string" } } },
      backgroundUtility,
      projectConfig: {} as any,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, argv] = spawnMock.mock.calls[0]!;
    // A background call loads no tools or MCP servers and skips plan mode and
    // the structured-output tool (the schema is asked for in the prompt). An
    // empty `--tools` must be ONE argument to survive the Windows cmd wrapper.
    expect(launchArgvValueAfter(argv, "--permission-mode")).toBe(backgroundUtility ? "default" : "plan");
    expect(launchArgvContains(argv, "--tools=")).toBe(backgroundUtility);
    expect(launchArgvContains(argv, "--strict-mcp-config")).toBe(backgroundUtility);
    expect(launchArgvContains(argv, "--json-schema")).toBe(!backgroundUtility);
  });

  it.each([
    { family: "anthropic", providerModelId: "claude-haiku-5-5", key: "CLAUDE_CONFIG_DIR" },
    { family: "openai", providerModelId: "gpt-6-luna", key: "CODEX_HOME" },
  ])("runs the $family CLI in the caller's account config home", async ({ family, providerModelId, key }) => {
    spawnMock.mockImplementationOnce(() => createMockProcess({ stdout: '{"result":"ok"}' }));

    await runProviderTask({
      cwd: process.cwd(),
      descriptor: { family, isCliWrapped: true, providerModelId } as any,
      prompt: "Name this chat.",
      feature: "unit-test",
      backgroundUtility: true,
      accountEnv: { [key]: "/accounts/second" },
      projectConfig: {} as any,
    });

    const options = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(options?.env?.[key]).toBe("/accounts/second");
  });

  it.each([
    {
      label: "a JSON usage-limit error on a failed exit",
      stdout: `{"type":"result","is_error":true,"result":"You've hit your weekly limit · resets 6am","api_error_status":429}`,
      exitCode: 1,
      message: /weekly limit · resets 6am \(HTTP 429\)/,
    },
    {
      label: "a JSON error on a clean exit",
      stdout: `{"type":"result","is_error":true,"result":"Invalid API key"}`,
      exitCode: 0,
      message: /Invalid API key/,
    },
    {
      label: "a plain-text error with an empty stderr",
      stdout: "You've hit your weekly limit · resets 6am",
      exitCode: 1,
      message: /weekly limit · resets 6am/,
    },
  ])("reports Claude's own reason for $label", async ({ stdout, exitCode, message }) => {
    spawnMock.mockImplementationOnce(() => createMockProcess({ stdout, exitCode }));

    await expect(runProviderTask({
      cwd: process.cwd(),
      descriptor: { family: "anthropic", isCliWrapped: true, providerModelId: "claude-haiku-5-5" } as any,
      prompt: "Name this chat.",
      feature: "unit-test",
      jsonSchema: { type: "object", properties: { title: { type: "string" } } },
      backgroundUtility: true,
      projectConfig: {} as any,
    })).rejects.toThrow(message);
  });

  it.each([true, false])("pins Codex to standard speed and starts none of the user's MCP servers only for a background utility call (%s)", async (backgroundUtility) => {
    spawnMock.mockImplementationOnce(() => createMockProcess());
    // The account's config.toml and the project's own `.codex/config.toml`.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-codex-mcp-off-"));
    const codexHome = path.join(root, "codex-home");
    const project = path.join(root, "project");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(path.join(project, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), [
      "[mcp_servers.playwright]",
      'command = "npx"',
      'args = ["@playwright/mcp@latest"]',
      "",
      '[mcp_servers."docs.search"]',
      'url = "https://docs.example/mcp"',
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(project, ".codex", "config.toml"), '[mcp_servers.repo_tools]\ncommand = "repo-mcp"\n');

    try {
      await runProviderTask({
        cwd: project,
        descriptor: { family: "openai", isCliWrapped: true, providerModelId: "gpt-6-luna" } as any,
        prompt: "Name this chat.",
        feature: "unit-test",
        backgroundUtility,
        accountEnv: { CODEX_HOME: codexHome },
        projectConfig: {} as any,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, argv] = spawnMock.mock.calls[0]!;
    expect(launchArgvContains(argv, "exec")).toBe(true);
    // Unpinned, the account's config.toml service tier (Fast) applies.
    expect(launchArgvContainsRun(argv, ["-c", "service_tier=default"])).toBe(backgroundUtility);
    // An empty `mcp_servers={}` override is merged and starts them all, so
    // each configured server is switched off by name, from both config files.
    expect(launchArgvContainsRun(argv, ["-c", "mcp_servers.playwright.enabled=false"])).toBe(backgroundUtility);
    expect(launchArgvContainsRun(argv, ["-c", 'mcp_servers."docs.search".enabled=false'])).toBe(backgroundUtility);
    expect(launchArgvContainsRun(argv, ["-c", "mcp_servers.repo_tools.enabled=false"])).toBe(backgroundUtility);
  });

  it("runs Copilot metadata prompts on a tool-less SDK utility session and releases the worker", async () => {
    copilotUtilityMock.mockResolvedValueOnce({ data: { content: '{"chatTitle":"Copilot title"}' } });
    const descriptor = {
      family: "github-copilot",
      providerRoute: "copilot-sdk",
      isCliWrapped: false,
      providerModelId: "gpt-5.4",
    } as any;

    const result = await runProviderTask({
      cwd: "/tmp/lane",
      descriptor,
      prompt: "Name this chat.",
      system: "Be concise.",
      jsonSchema: { type: "object", properties: { chatTitle: { type: "string" } } },
      feature: "session-metadata",
      projectConfig: {} as any,
    });

    expect(result.structuredOutput).toEqual({ chatTitle: "Copilot title" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(acquireCopilotConnectionMock).toHaveBeenCalledWith(expect.objectContaining({
      cliPath: "/ade-test/tools/copilot",
    }));
    expect(copilotUtilityMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/lane",
      model: "gpt-5.4",
      prompt: expect.stringMatching(/^Be concise\.\n\nName this chat\.[\s\S]*Return only valid JSON/),
    }));
    expect(releaseCopilotConnectionMock).toHaveBeenCalledWith("copilot-pool", 7);

    // Auto is Copilot's default, not a model id; an image task is refused
    // before any worker starts, and a failed task still releases the worker.
    copilotUtilityMock.mockRejectedValueOnce(new Error("utility session failed"));
    await expect(runProviderTask({
      cwd: "/tmp/lane",
      descriptor: { ...descriptor, providerModelId: "auto" },
      prompt: "Name this chat.",
      feature: "session-metadata",
      projectConfig: {} as any,
    })).rejects.toThrow("utility session failed");
    expect(copilotUtilityMock.mock.calls.at(-1)?.[0]).toMatchObject({ model: undefined });
    expect(releaseCopilotConnectionMock).toHaveBeenCalledTimes(2);

    acquireCopilotConnectionMock.mockClear();
    await expect(runProviderTask({
      cwd: "/tmp/lane",
      descriptor,
      prompt: "Describe this screenshot.",
      imagePaths: ["/tmp/shot.png"],
      feature: "session-metadata",
      projectConfig: {} as any,
    })).rejects.toThrow(/Image input is not supported with Copilot/);
    expect(acquireCopilotConnectionMock).not.toHaveBeenCalled();
  });

  it("runs Qwen, Kimi, and Grok metadata prompts through their ACP CLIs", async () => {
    spawnMock
      .mockImplementationOnce(() => createMockProcess({ stdout: '{"chatTitle":"Qwen title"}' }))
      .mockImplementationOnce(() => createMockProcess({ stdout: '{"chatTitle":"Kimi title"}' }))
      .mockImplementationOnce(() => createMockProcess({ stdout: '{"chatTitle":"Grok title"}' }));

    const common = {
      cwd: "/tmp/lane",
      prompt: "Name this chat.",
      jsonSchema: { type: "object", properties: { chatTitle: { type: "string" } } },
      feature: "session-metadata",
      projectConfig: {} as any,
    };
    const writeFileSpy = vi.spyOn(fs, "writeFileSync");
    let results: Awaited<ReturnType<typeof runProviderTask>>[];
    let wroteNoToolsAgent = false;
    try {
      results = await Promise.all([
        runProviderTask({
          ...common,
          descriptor: {
            family: "qwen",
            providerRoute: "qwen-acp",
            isCliWrapped: true,
            providerModelId: "qwen/qwen3-coder-plus",
          } as any,
        }),
        runProviderTask({
          ...common,
          descriptor: {
            family: "moonshot",
            providerRoute: "kimi-acp",
            isCliWrapped: true,
            providerModelId: "moonshot/kimi-for-coding",
          } as any,
        }),
        runProviderTask({
          ...common,
          descriptor: {
            family: "xai",
            providerRoute: "grok-acp",
            isCliWrapped: true,
            providerModelId: "xai/grok-4.6",
          } as any,
        }),
      ]);
    } finally {
      wroteNoToolsAgent = writeFileSpy.mock.calls.some(([, contents]) => String(contents).includes("tools: []"));
      writeFileSpy.mockRestore();
    }
    expect(wroteNoToolsAgent).toBe(true);

    expect(results.map((result) => result.structuredOutput)).toEqual([
      { chatTitle: "Qwen title" },
      { chatTitle: "Kimi title" },
      { chatTitle: "Grok title" },
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    const launched = spawnMock.mock.calls.map((call) => call[1]);
    expect(launched[0]).toEqual(expect.arrayContaining(["--safe-mode", "--output-format", "text", "--model", "qwen3-coder-plus"]));
    expect(launched[1]).toEqual(expect.arrayContaining(["--model", "kimi-code/kimi-for-coding", "--agent-file", "--output-format", "text", "--prompt"]));
    expect(launchArgvValueAfter(launched[1], "--agent-file")).toMatch(/ade-kimi-task-/);
    expect(launched[1]).not.toContain("--plan");
    expect(launched[2]).toEqual(expect.arrayContaining(["--permission-mode", "plan", "--model", "grok-4.6", "--json-schema"]));
    expect(launched[0]).not.toContain("--prompt");
    expect((spawnMock.mock.results[0]!.value as MockSpawnProcess).stdin.end).toHaveBeenCalledWith(
      expect.stringContaining("Name this chat."),
    );
  });

  it.each([
    ["Qwen", "qwen", "qwen-acp", "qwen/qwen3-coder-plus"],
    ["Kimi", "moonshot", "kimi-acp", "moonshot/kimi-for-coding"],
    ["Grok", "xai", "grok-acp", "xai/grok-4.6"],
  ] as const)("rejects image-backed metadata tasks when %s has no native image input", async (
    providerLabel,
    family,
    providerRoute,
    providerModelId,
  ) => {
    await expect(runProviderTask({
      cwd: "/tmp/lane",
      descriptor: { family, providerRoute, isCliWrapped: true, providerModelId } as any,
      prompt: "Name this chat.",
      feature: "session-metadata",
      imagePaths: ["/tmp/settings.png"],
      projectConfig: {} as any,
  })).rejects.toThrow(
    "Image input is not supported with " + providerLabel + " native metadata tasks",
  );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("routes every Cursor task through the SDK worker pool with no policy of its own", async () => {
    cursorLocalPromptMock.mockResolvedValue({ text: "ok", agentId: "agent-1" });

    const result = await runProviderTask({
      cwd: "/tmp/lane",
      descriptor: {
        family: "cursor",
        isCliWrapped: false,
        providerModelId: "composer-2",
      } as any,
      prompt: "Ship the change.",
      feature: "unit-test",
      permissionMode: "full-auto",
      auth: [{ type: "api-key", provider: "cursor", key: "cursor-test-key" }] as any,
      projectConfig: {} as any,
    });

    expect(result.text).toBe("ok");
    expect(result.sessionId).toBe("agent-1");
    expect(assertCursorSdkSupportedMock).toHaveBeenCalledTimes(1);
    expect(cursorLocalPromptMock).toHaveBeenCalledTimes(1);
    const call = cursorLocalPromptMock.mock.calls[0]![0] as Record<string, any>;
    expect(call).toMatchObject({
      projectRoot: "/tmp/lane",
      workspacePath: "/tmp/lane",
      apiKey: "cursor-test-key",
      modelSdkId: "composer-2",
      promptText: "Ship the change.",
      feature: "unit-test",
      timeoutMs: 120_000,
    });
    // A one-shot is a tool-less text task and the pool denies every tool call
    // it makes, so `permissionMode` decides nothing: the pool owns the policy.
    expect(call.policy).toBeUndefined();
  });

  it("passes no policy for a middle-trust edit task either", async () => {
    cursorLocalPromptMock.mockResolvedValue({ text: "ok", agentId: "agent-2" });

    await runProviderTask({
      cwd: "/tmp/lane",
      descriptor: {
        family: "cursor",
        isCliWrapped: false,
        providerModelId: "composer-2",
      } as any,
      prompt: "Inspect then patch.",
      feature: "unit-test",
      permissionMode: "edit",
      auth: [{ type: "api-key", provider: "cursor", key: "cursor-test-key" }] as any,
      projectConfig: {} as any,
    });

    const call = cursorLocalPromptMock.mock.calls[0]![0] as Record<string, any>;
    expect(call.policy).toBeUndefined();
  });

  it("runs a read-only Cursor task in plan mode and parses its structured output", async () => {
    cursorLocalPromptMock.mockResolvedValue({
      text: '```json\n{"chatTitle":"Fix the namer"}\n```',
      agentId: "agent-3",
    });

    const result = await runProviderTask({
      cwd: "/tmp/lane",
      descriptor: {
        family: "cursor",
        isCliWrapped: false,
        providerModelId: "composer-2",
      } as any,
      prompt: "What does this file do?",
      system: "Be concise.",
      jsonSchema: { type: "object" },
      feature: "unit-test",
      permissionMode: "read-only",
      auth: [{ type: "api-key", provider: "cursor", key: "cursor-test-key" }] as any,
      projectConfig: {} as any,
    });

    expect(result.structuredOutput).toEqual({ chatTitle: "Fix the namer" });
    const call = cursorLocalPromptMock.mock.calls[0]![0] as Record<string, any>;
    expect(call.policy).toBeUndefined();
    // System prompt and the schema instruction are folded into one prompt: the
    // pool helper sends a single message, it has no system-prompt channel.
    expect(call.promptText.startsWith("Be concise.\n\nWhat does this file do?")).toBe(true);
    expect(call.promptText).toContain("Return only valid JSON matching this schema:");
  });

  it("surfaces a Cursor worker failure instead of swallowing it", async () => {
    cursorLocalPromptMock.mockRejectedValue(new Error("Cursor SDK task failed."));

    await expect(runProviderTask({
      cwd: "/tmp/lane",
      descriptor: {
        family: "cursor",
        isCliWrapped: false,
        providerModelId: "composer-2",
      } as any,
      prompt: "Name this chat.",
      feature: "unit-test",
      permissionMode: "read-only",
      auth: [{ type: "api-key", provider: "cursor", key: "cursor-test-key" }] as any,
      projectConfig: {} as any,
    })).rejects.toThrow("Cursor SDK task failed.");
  });

  it("never reaches the worker pool without a Cursor API key", async () => {
    await expect(runProviderTask({
      cwd: "/tmp/lane",
      descriptor: {
        family: "cursor",
        isCliWrapped: false,
        providerModelId: "composer-2",
      } as any,
      prompt: "Name this chat.",
      feature: "unit-test",
      permissionMode: "read-only",
      auth: [] as any,
      projectConfig: {} as any,
    })).rejects.toThrow("Cursor tasks require a Cursor API key.");
    expect(cursorLocalPromptMock).not.toHaveBeenCalled();
  });

  // Each provider's own model runs on that provider's pinned CLI. Before, these
  // fell through to OpenCode, which sent the chat to a model it does not own.
  it.each([
    ["Droid", { family: "factory", isCliWrapped: true, providerModelId: "custom:claude-opus-5" }, "/tools/droid/bin/droid", ["-m", "custom:claude-opus-5"]],
    ["Devin", { family: "devin", providerRoute: "devin-acp", isCliWrapped: true, providerModelId: "swe" }, "/tools/devin/bin/devin", ["--model", "swe"]],
    ["Pi", { family: "anthropic", providerRoute: "pi-sdk", isCliWrapped: false, providerModelId: "anthropic/claude-haiku-5-5" }, "/tools/node/bin/node", ["--model", "anthropic/claude-haiku-5-5"]],
  ] as const)("runs a %s model on its own pinned CLI, never OpenCode", async (_label, descriptor, command, modelFlag) => {
    // Built at spawn time: the runner resolves its pinned CLI first, and a
    // process made earlier would have closed before anyone listened.
    spawnMock.mockImplementationOnce(() => createMockProcess({ stdout: "Pinned Title\n" }));

    const result = await runProviderTask({
      cwd: "/tmp/lane",
      descriptor: descriptor as any,
      prompt: "Name this chat.",
      feature: "session-metadata",
      backgroundUtility: true,
      projectConfig: {} as any,
    });

    expect(result.text).toBe("Pinned Title");
    expect(openCodeTextPromptMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [launchedCommand, argv] = spawnMock.mock.calls[0]!;
    expect(launchedCommand).toBe(expectedLaunchCommand(command));
    expect(launchArgvContainsRun(argv, [...modelFlag])).toBe(true);
  });

  it("fails an Antigravity task before starting the agent when this machine is not signed in", async () => {
    await expect(runProviderTask({
      cwd: "/tmp/lane",
      descriptor: { family: "antigravity", providerRoute: "antigravity-acp", isCliWrapped: true, providerModelId: "gemini-3-flash" } as any,
      prompt: "Name this chat.",
      feature: "session-metadata",
      projectConfig: {} as any,
    })).rejects.toThrow("Antigravity is not signed in on this machine.");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(openCodeTextPromptMock).not.toHaveBeenCalled();
  });
});
