import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const resolveClaudeCodeExecutableMock = vi.fn(() => ({
  path: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
  source: "path",
}));
const resolveCodexExecutableMock = vi.fn(() => ({
  path: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
  source: "path",
}));
const resolveCopilotExecutableMock = vi.fn(() => ({
  path: "C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd",
  source: "path",
}));
const resolveQwenExecutableMock = vi.fn(() => ({
  path: "C:\\Users\\me\\AppData\\Roaming\\npm\\qwen.cmd",
  source: "path",
}));
const resolveKimiExecutableMock = vi.fn(() => ({
  path: "C:\\Users\\me\\.kimi-code\\bin\\kimi.exe",
  source: "path",
}));
const resolveGrokExecutableMock = vi.fn(() => ({
  path: "C:\\Users\\me\\.grok\\bin\\grok.exe",
  source: "path",
}));
const cursorLocalPromptMock = vi.fn();
const assertCursorSdkSupportedMock = vi.fn();
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
  resolveQwenExecutable: () => resolveQwenExecutableMock(),
  resolveKimiExecutable: () => resolveKimiExecutableMock(),
  resolveGrokExecutable: () => resolveGrokExecutableMock(),
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

afterEach(() => {
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
    const child = createMockProcess({
      stdout: '{"result":"READY"}',
    });
    spawnMock.mockReturnValueOnce(child);

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
    expect(command).toBe(expectedLaunchCommand("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"));
    expect(launchArgvContains(argv, "-p")).toBe(true);
    expect(launchArgvContains(argv, "Summarize the worktree state.")).toBe(false);
    expect(options).toMatchObject({
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(child.stdin.end).toHaveBeenCalledWith("Summarize the worktree state.");
  });

  it("terminates a provider task when writing its prompt fails", async () => {
    const child = createMockProcess({ deferClose: true });
    spawnMock.mockReturnValueOnce(child);

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

    await expect(pending).rejects.toThrow("EIO");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
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
      expect(command).toBe(expectedLaunchCommand("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"));
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

  it("runs Copilot metadata prompts with the selected model and no tools", async () => {
    spawnMock.mockReturnValueOnce(createMockProcess({
      stdout: '{"chatTitle":"Copilot title"}',
    }));

    const result = await runProviderTask({
      cwd: "/tmp/lane",
      descriptor: {
        family: "github-copilot",
        providerRoute: "copilot-acp",
        isCliWrapped: true,
        providerModelId: "github-copilot/gpt-5.4",
      } as any,
      prompt: "Name this chat.",
      system: "Be concise.",
      jsonSchema: { type: "object", properties: { chatTitle: { type: "string" } } },
      feature: "session-metadata",
      projectConfig: {} as any,
    });

    expect(result.text).toBe('{"chatTitle":"Copilot title"}');
    expect(result.structuredOutput).toEqual({ chatTitle: "Copilot title" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, argv, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe(expectedLaunchCommand("C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd"));
    expect(launchArgvContains(argv, "--model")).toBe(true);
    expect(launchArgvValueAfter(argv, "--model")).toBe("gpt-5.4");
    expect(launchArgvContains(argv, "--deny-tool=*")).toBe(true);
    expect(launchArgvContains(argv, "--deny-url=*")).toBe(true);
    expect(launchArgvContains(argv, "--prompt")).toBe(false);
    expect(options).toMatchObject({
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = spawnMock.mock.results[0]!.value as MockSpawnProcess;
    expect(child.stdin.end).toHaveBeenCalledWith(
      'Be concise.\n\nName this chat.\n\nReturn only valid JSON matching this schema:\n{\n  "type": "object",\n  "properties": {\n    "chatTitle": {\n      "type": "string"\n    }\n  }\n}',
    );
  });

  it("runs Qwen, Kimi, and Grok metadata prompts through their ACP CLIs", async () => {
    spawnMock
      .mockReturnValueOnce(createMockProcess({ stdout: '{"chatTitle":"Qwen title"}' }))
      .mockReturnValueOnce(createMockProcess({ stdout: '{"chatTitle":"Kimi title"}' }))
      .mockReturnValueOnce(createMockProcess({ stdout: '{"chatTitle":"Grok title"}' }));

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
});
