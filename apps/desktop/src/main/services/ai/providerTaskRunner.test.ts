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
    child.emit("close", args.exitCode ?? 0);
  });

  return child;
}

afterEach(() => {
  spawnMock.mockReset();
  resolveClaudeCodeExecutableMock.mockClear();
  resolveCodexExecutableMock.mockClear();
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
});
