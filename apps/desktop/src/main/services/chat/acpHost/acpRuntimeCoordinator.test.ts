import { beforeEach, describe, expect, it, vi } from "vitest";
import { copilotDialect, kimiDialect } from "./acpDialects";
import type { Logger } from "../../logging/logger";

const openAcpSessionMock = vi.hoisted(() => vi.fn());

vi.mock("./acpSession", () => ({ openAcpSession: openAcpSessionMock }));

import { createAcpRuntime } from "./acpRuntimeCoordinator";

describe("createAcpRuntime", () => {
  beforeEach(() => {
    openAcpSessionMock.mockReset();
  });

  it("fails closed when the requested mode cannot be applied", async () => {
    const modeError = new Error("session/set_config_option unavailable");
    const session = {
      providerId: "copilot",
      dialect: copilotDialect,
      sessionId: "acp-session-1",
      entryPlan: { mode: "new", suppressReplay: false, reason: "test" },
      connection: { isAlive: () => true, initializeResult: null },
      initialConfigOptions: [],
      initialModeId: null,
      unsupervised: false,
      prompt: vi.fn(),
      cancel: vi.fn(),
      setConfigOption: vi.fn().mockRejectedValue(modeError),
      close: vi.fn().mockResolvedValue(undefined),
    };
    openAcpSessionMock.mockResolvedValue(session);

    const onRuntimeCreated = vi.fn();
    const onRuntimeSetupFailed = vi.fn();
    const onOpenFailed = vi.fn();
    const onReady = vi.fn();

    await expect(createAcpRuntime({
      owner: {
        session: { id: "chat-1" } as never,
        laneWorktreePath: "/lane/worktree",
        eventSequence: 0,
        transcriptBytesWritten: 0,
      },
      provider: "copilot",
      dialect: copilotDialect,
      spawnPlan: { command: "copilot", args: ["--acp"], env: {}, cwd: "/lane/worktree" },
      invocationKey: "invocation-1",
      permissionMode: "plan",
      modelToken: null,
      existingSessionId: null,
      supervisionPreflight: null,
      supervisionAlreadyNotified: false,
      logger: { warn: vi.fn(), info: vi.fn() } as unknown as Logger,
      runtimeBudget: { enforce: vi.fn() },
      existingRuntime: null,
      runtimeInvalidated: false,
      hasExistingRuntime: false,
      teardownExistingRuntime: vi.fn(),
      nativeModeValue: "plan",
      reasoningEffort: null,
      setResumeCommand: vi.fn(),
      binarySource: "test",
      callbacks: {
        onEvents: vi.fn(),
        onPermissionRequested: vi.fn(),
        onPermissionSettled: vi.fn(),
        onSlashCommands: vi.fn(),
        onConfigOptions: vi.fn(),
        onSessionInfo: vi.fn(),
        onProcessExit: vi.fn(),
        onRuntimeCreated,
        onRuntimeSetupFailed,
        onOpenFailed,
        onReady,
      },
    })).rejects.toBe(modeError);

    const runtime = onRuntimeCreated.mock.calls[0]?.[0];
    expect(session.close).toHaveBeenCalledWith("mode setup failed");
    expect(onRuntimeSetupFailed).toHaveBeenCalledWith(runtime, modeError);
    expect(onOpenFailed).toHaveBeenCalledWith(modeError);
    expect(onReady).not.toHaveBeenCalled();
  });

  it("degrades when an older dialect cannot apply its optional mode", async () => {
    const modeError = new Error("session/set_config_option unavailable");
    const session = {
      providerId: "kimi",
      dialect: kimiDialect,
      sessionId: "acp-session-1",
      entryPlan: { mode: "new", suppressReplay: false, reason: "test" },
      connection: { isAlive: () => true, initializeResult: null },
      initialConfigOptions: [],
      initialModeId: null,
      unsupervised: false,
      prompt: vi.fn(),
      cancel: vi.fn(),
      setConfigOption: vi.fn().mockRejectedValue(modeError),
      close: vi.fn().mockResolvedValue(undefined),
    };
    openAcpSessionMock.mockResolvedValue(session);
    const onReady = vi.fn();

    await expect(createAcpRuntime({
      owner: {
        session: { id: "chat-1" } as never,
        laneWorktreePath: "/lane/worktree",
        eventSequence: 0,
        transcriptBytesWritten: 0,
      },
      provider: "kimi",
      dialect: kimiDialect,
      spawnPlan: { command: "kimi", args: ["acp"], env: {}, cwd: "/lane/worktree" },
      invocationKey: "invocation-1",
      permissionMode: "plan",
      modelToken: null,
      existingSessionId: null,
      supervisionPreflight: null,
      supervisionAlreadyNotified: false,
      logger: { warn: vi.fn(), info: vi.fn() } as unknown as Logger,
      runtimeBudget: { enforce: vi.fn() },
      existingRuntime: null,
      runtimeInvalidated: false,
      hasExistingRuntime: false,
      teardownExistingRuntime: vi.fn(),
      nativeModeValue: "plan",
      reasoningEffort: null,
      setResumeCommand: vi.fn(),
      binarySource: "test",
      callbacks: {
        onEvents: vi.fn(),
        onPermissionRequested: vi.fn(),
        onPermissionSettled: vi.fn(),
        onSlashCommands: vi.fn(),
        onConfigOptions: vi.fn(),
        onSessionInfo: vi.fn(),
        onProcessExit: vi.fn(),
        onRuntimeCreated: vi.fn(),
        onOpenFailed: vi.fn(),
        onReady,
      },
    })).resolves.toBeDefined();

    expect(session.close).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledOnce();
  });
});
