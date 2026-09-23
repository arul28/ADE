import { beforeEach, describe, expect, it, vi } from "vitest";
import { copilotDialect, grokDialect, kimiDialect, qwenDialect } from "./acpDialects";
import { qwenModelIdFromAgent } from "./acpDialects/qwen";
import type { AcpDialect } from "./acpHostTypes";
import type { AcpSessionConfigOption } from "./acpProtocolTypes";
import type { Logger } from "../../logging/logger";

const openAcpSessionMock = vi.hoisted(() => vi.fn());

vi.mock("./acpSession", () => ({ openAcpSession: openAcpSessionMock }));

import { acpInvocationKey, createAcpRuntime, resolveAcpConfigValue, setAcpReasoningEffort } from "./acpRuntimeCoordinator";
import { AcpRpcError } from "./acpConnection";

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
      turnAnswered: false,
      prompt: vi.fn(),
      cancel: vi.fn(),
      setConfigOption: vi.fn().mockRejectedValue(modeError),
      noteCurrentModel: vi.fn(),
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
      turnAnswered: false,
      prompt: vi.fn(),
      cancel: vi.fn(),
      setConfigOption: vi.fn().mockRejectedValue(modeError),
      noteCurrentModel: vi.fn(),
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

  it("opens the session with the launch model token as the requested model", async () => {
    openAcpSessionMock.mockResolvedValue({
      providerId: "kimi",
      dialect: kimiDialect,
      sessionId: "acp-session-1",
      entryPlan: { mode: "new", suppressReplay: false, reason: "test" },
      connection: { isAlive: () => true, initializeResult: null },
      initialConfigOptions: [],
      initialModeId: null,
      unsupervised: false,
      turnAnswered: false,
      prompt: vi.fn(),
      cancel: vi.fn(),
      setConfigOption: vi.fn().mockResolvedValue(undefined),
      noteCurrentModel: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });

    await createAcpRuntime({
      owner: {
        session: { id: "chat-1" } as never,
        laneWorktreePath: "/lane/worktree",
        eventSequence: 0,
        transcriptBytesWritten: 0,
      },
      provider: "kimi",
      dialect: kimiDialect,
      spawnPlan: { command: "kimi", args: ["--model", "kimi-code/kimi-for-coding", "acp"], env: {}, cwd: "/lane/worktree" },
      invocationKey: "invocation-1",
      permissionMode: "default",
      modelToken: "kimi-code/kimi-for-coding",
      existingSessionId: null,
      supervisionPreflight: null,
      supervisionAlreadyNotified: false,
      logger: { warn: vi.fn(), info: vi.fn() } as unknown as Logger,
      runtimeBudget: { enforce: vi.fn() },
      existingRuntime: null,
      runtimeInvalidated: false,
      hasExistingRuntime: false,
      teardownExistingRuntime: vi.fn(),
      nativeModeValue: "default",
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
        onReady: vi.fn(),
      },
    });

    expect(openAcpSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      requestedModelId: "kimi-code/kimi-for-coding",
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Model and effort selection
// ─────────────────────────────────────────────────────────────────────────────

type ConfigCall = { configId: string; value: string | boolean };

/** One select option in ADE's normalized shape. */
function selectOption(id: string, current: string, values: string[]): AcpSessionConfigOption {
  return { id, name: id, type: "select", value: current, options: values.map((value) => ({ id: value, name: value })) };
}

const GROK_MODELS = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"];
const GROK_EFFORTS = ["xhigh", "high", "medium", "low"];

function grokOptions(model: string, effort: string): AcpSessionConfigOption[] {
  return [selectOption("model", model, GROK_MODELS), selectOption("reasoning_effort", effort, GROK_EFFORTS)];
}

/**
 * A session whose agent answers `session/set_config_option` the way Grok,
 * Qwen, and Copilot do: with the whole option set after the change.
 */
function fakeSession(
  dialect: AcpDialect,
  init: {
    options?: AcpSessionConfigOption[];
    entry?: "new" | "resume";
    /** Answer `session/set_config_option` with no option set, as Kimi does. */
    silentReplies?: boolean;
    /** Fail the set of this config id. */
    failConfigId?: { configId: string; error: Error };
  } = {},
) {
  let options = init.options ?? [];
  const configCalls: ConfigCall[] = [];
  const notedModels: string[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  return {
    providerId: dialect.providerId,
    dialect,
    sessionId: "acp-session-1",
    entryPlan: { mode: init.entry ?? "new", suppressReplay: false, reason: "test" },
    connection: {
      isAlive: () => true,
      initializeResult: null,
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }),
    },
    initialConfigOptions: options,
    initialModeId: null,
    unsupervised: false,
    turnAnswered: false,
    prompt: vi.fn(),
    cancel: vi.fn(),
    setConfigOption: vi.fn(async (call: ConfigCall) => {
      configCalls.push(call);
      if (init.failConfigId?.configId === call.configId) throw init.failConfigId.error;
      options = options.map((option) => (option.id === call.configId ? { ...option, value: call.value } : option));
      return init.silentReplies ? [] : options;
    }),
    noteCurrentModel: vi.fn((modelId: string) => { notedModels.push(modelId); }),
    close: vi.fn().mockResolvedValue(undefined),
    configCalls,
    requests,
    notedModels,
  };
}

function testLogger() {
  return { warn: vi.fn(), info: vi.fn() };
}

async function openRuntime(args: {
  dialect: AcpDialect;
  session: ReturnType<typeof fakeSession>;
  model?: string | null;
  reasoningEffort?: string | null;
  logger?: ReturnType<typeof testLogger>;
  spawnArgs?: string[];
  existingRuntime?: Awaited<ReturnType<typeof createAcpRuntime>> | null;
  teardownExistingRuntime?: () => void;
}) {
  openAcpSessionMock.mockResolvedValue(args.session);
  const onConfigOptions = vi.fn();
  const onReady = vi.fn();
  const logger = args.logger ?? testLogger();
  const spawnPlan = { command: args.dialect.binaryNames[0]!, args: args.spawnArgs ?? [], env: {}, cwd: "/lane/worktree" };
  const runtime = await createAcpRuntime({
    owner: {
      session: { id: "chat-1" } as never,
      laneWorktreePath: "/lane/worktree",
      eventSequence: 0,
      transcriptBytesWritten: 0,
    },
    provider: args.dialect.providerId,
    dialect: args.dialect,
    spawnPlan,
    invocationKey: acpInvocationKey(spawnPlan),
    permissionMode: "default",
    modelToken: args.model ?? null,
    existingSessionId: args.session.entryPlan.mode === "new" ? null : "acp-session-1",
    supervisionPreflight: null,
    supervisionAlreadyNotified: false,
    logger: logger as unknown as Logger,
    runtimeBudget: { enforce: vi.fn() },
    existingRuntime: args.existingRuntime ?? null,
    runtimeInvalidated: false,
    hasExistingRuntime: Boolean(args.existingRuntime),
    teardownExistingRuntime: args.teardownExistingRuntime ?? vi.fn(),
    nativeModeValue: "default",
    reasoningEffort: args.reasoningEffort ?? null,
    setResumeCommand: vi.fn(),
    binarySource: "test",
    callbacks: {
      onEvents: vi.fn(),
      onPermissionRequested: vi.fn(),
      onPermissionSettled: vi.fn(),
      onSlashCommands: vi.fn(),
      onConfigOptions,
      onSessionInfo: vi.fn(),
      onProcessExit: vi.fn(),
      onRuntimeCreated: vi.fn(),
      onOpenFailed: vi.fn(),
      onReady,
    },
  });
  return { runtime, onConfigOptions, onReady, logger };
}

function warningsNamed(logger: ReturnType<typeof testLogger>, key: string): unknown[] {
  return logger.warn.mock.calls.filter(([name]) => name === key).map(([, payload]) => payload);
}

describe("model and effort selection", () => {
  beforeEach(() => {
    openAcpSessionMock.mockReset();
  });

  it("sets Grok's model and effort through session/set_config_option, and sends no mode", async () => {
    // Live 1.0.40: `-m grok-4.7-build-fast` opened on grok-4.7. The config
    // option is what moves the session.
    const session = fakeSession(grokDialect, { options: grokOptions("grok-4.7", "medium") });
    const { onConfigOptions, onReady } = await openRuntime({
      dialect: grokDialect,
      session,
      model: "grok-4.7-build-fast",
      reasoningEffort: "low",
    });

    expect(session.configCalls).toEqual([
      { configId: "model", value: "grok-4.7-build-fast" },
      { configId: "reasoning_effort", value: "low" },
    ]);
    expect(session.requests).toEqual([]);
    // The chat's snapshot shows what the session runs now, not what
    // `session/new` reported before the calls.
    expect(onConfigOptions).toHaveBeenLastCalledWith(expect.anything(), {
      options: grokOptions("grok-4.7-build-fast", "low"),
      currentModeId: null,
    });
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("puts the chat's model and effort back on a resumed Grok session", async () => {
    // A model switch in the UI reopens the runtime. `session/resume` brings
    // back the model and effort the session last ran with, whatever `-m` says.
    const session = fakeSession(grokDialect, { entry: "resume", options: grokOptions("grok-4.6", "low") });
    await openRuntime({ dialect: grokDialect, session, model: "grok-4.7", reasoningEffort: "high" });
    expect(session.configCalls).toEqual([
      { configId: "model", value: "grok-4.7" },
      { configId: "reasoning_effort", value: "high" },
    ]);
  });

  it("keeps Grok's own model when it does not offer the requested one, and still runs", async () => {
    const logger = testLogger();
    const session = fakeSession(grokDialect, { options: grokOptions("grok-4.7", "medium") });
    const { onReady } = await openRuntime({
      dialect: grokDialect,
      session,
      model: "grok-9",
      // ADE's ladder runs past Grok's; the top tier lands on xhigh.
      reasoningEffort: "ultracode",
      logger,
    });
    expect(session.configCalls).toEqual([{ configId: "reasoning_effort", value: "xhigh" }]);
    expect(warningsNamed(logger, "agent_chat.acp_model_not_offered")).toEqual([
      { sessionId: "chat-1", provider: "grok", model: "grok-9", offered: GROK_MODELS },
    ]);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("sends nothing the Grok session already runs, and no effort when the chat picked none", async () => {
    const session = fakeSession(grokDialect, { options: grokOptions("grok-4.6", "medium") });
    await openRuntime({ dialect: grokDialect, session, model: "grok-4.6", reasoningEffort: null });
    expect(session.configCalls).toEqual([]);
  });

  it("sends Qwen's own suffixed id for the chat's model, and nothing for a model Qwen does not offer", async () => {
    const qwenModels = ["gpt-5.5(openai)", "qwen3-coder-plus(openai)"];
    const offered = fakeSession(qwenDialect, { options: [selectOption("model", "gpt-5.5(openai)", qwenModels)] });
    await openRuntime({ dialect: qwenDialect, session: offered, model: "qwen3-coder-plus" });
    expect(offered.configCalls.filter((call) => call.configId === "model")).toEqual([
      { configId: "model", value: "qwen3-coder-plus(openai)" },
    ]);

    // Live 0.22.3 answers an unconfigured model with -32603 and stays put.
    const logger = testLogger();
    const missing = fakeSession(qwenDialect, { options: [selectOption("model", "gpt-5.5(openai)", qwenModels)] });
    await openRuntime({ dialect: qwenDialect, session: missing, model: "qwen3.7-plus", logger });
    expect(missing.configCalls.map((call) => call.configId)).toEqual(["mode", "reasoning_effort"]);
    expect(warningsNamed(logger, "agent_chat.acp_model_not_offered")).toHaveLength(1);
  });

  it("keeps Qwen's auth type when two advertised ids name the same model", () => {
    const options = [selectOption("model", "gpt-5.5(openai-responses)", ["gpt-5.5(openai)", "gpt-5.5(openai-responses)"])];
    expect(resolveAcpConfigValue(options, "model", "gpt-5.5", qwenModelIdFromAgent)).toEqual({
      kind: "advertised",
      value: "gpt-5.5(openai-responses)",
      current: true,
    });
    expect(resolveAcpConfigValue([], "model", "gpt-5.5", qwenModelIdFromAgent)).toEqual({
      kind: "unadvertised",
      value: "gpt-5.5",
    });
  });

  it("routes Copilot's model through session/set_model, checked against a model list when Copilot sends one", async () => {
    // A plan that includes only Auto lists no `model` option; ADE still asks.
    const autoOnly = fakeSession(copilotDialect);
    await openRuntime({ dialect: copilotDialect, session: autoOnly, model: "claude-haiku-4.5" });
    expect(autoOnly.requests).toEqual([
      { method: "session/set_model", params: { sessionId: "acp-session-1", modelId: "claude-haiku-4.5" } },
    ]);

    const logger = testLogger();
    const picker = fakeSession(copilotDialect, { options: [selectOption("model", "auto", ["auto", "gpt-5.4"])] });
    await openRuntime({ dialect: copilotDialect, session: picker, model: "claude-opus-4.6", logger });
    expect(picker.requests).toEqual([]);
    expect(warningsNamed(logger, "agent_chat.acp_model_not_offered")).toHaveLength(1);
  });

  it("sets Kimi's thinking level only when the session offers it", async () => {
    const thinking = fakeSession(kimiDialect, {
      options: [selectOption("thinking", "off", ["off", "low", "high", "max"])],
    });
    await openRuntime({ dialect: kimiDialect, session: thinking, reasoningEffort: "high" });
    expect(thinking.configCalls.filter((call) => call.configId === "thinking")).toEqual([
      { configId: "thinking", value: "high" },
    ]);

    // Kimi hides `thinking` for a model without thinking control.
    const hidden = fakeSession(kimiDialect);
    await openRuntime({ dialect: kimiDialect, session: hidden, reasoningEffort: "high" });
    expect(hidden.configCalls.map((call) => call.configId)).toEqual(["mode"]);
  });

  it("applies a live Grok effort change to the open session", async () => {
    const session = fakeSession(grokDialect, { options: grokOptions("grok-4.7", "medium") });
    const { runtime } = await openRuntime({ dialect: grokDialect, session, model: "grok-4.7" });
    const update = (effort: string | null) =>
      setAcpReasoningEffort(runtime, effort, { sessionId: "chat-1", logger: testLogger() as unknown as Logger });

    await expect(update("high")).resolves.toBe("applied");
    await expect(update("high")).resolves.toBe("unchanged");
    // The chat service's "no effort" puts back the effort the session opened with.
    await expect(update("default")).resolves.toBe("applied");
    await expect(update(null)).resolves.toBe("unchanged");
    expect(session.configCalls).toEqual([
      { configId: "reasoning_effort", value: "high" },
      { configId: "reasoning_effort", value: "medium" },
    ]);
    expect(runtime.configOptions.find((option) => option.id === "reasoning_effort")?.value).toBe("medium");
  });

  it("puts back Kimi's opening thinking level on a clear, also when Kimi reports no option set", async () => {
    const session = fakeSession(kimiDialect, {
      options: [selectOption("thinking", "low", ["off", "low", "high"])],
      silentReplies: true,
    });
    const { runtime } = await openRuntime({ dialect: kimiDialect, session, reasoningEffort: "high" });
    // The silent reply still moved the local option, so the clear is not
    // skipped as "already current".
    expect(runtime.configOptions.find((option) => option.id === "thinking")?.value).toBe("high");
    await expect(setAcpReasoningEffort(runtime, null, { sessionId: "chat-1", logger: testLogger() as unknown as Logger }))
      .resolves.toBe("applied");
    expect(session.configCalls.filter((call) => call.configId === "thinking").map((call) => call.value)).toEqual(["high", "low"]);
  });

  it("sends Qwen's default on a clear, also when the session does not list it", async () => {
    const session = fakeSession(qwenDialect, {
      options: [selectOption("reasoning_effort", "high", ["low", "medium", "high"])],
    });
    const { runtime } = await openRuntime({ dialect: qwenDialect, session, reasoningEffort: null });
    expect(session.configCalls.filter((call) => call.configId === "reasoning_effort")).toEqual([
      { configId: "reasoning_effort", value: "default" },
    ]);
    await expect(setAcpReasoningEffort(runtime, "default", { sessionId: "chat-1", logger: testLogger() as unknown as Logger }))
      .resolves.toBe("applied");
  });

  it("keeps a Grok or Kimi session when the effort set fails, and fails Qwen closed", async () => {
    const timeout = new Error("session/set_config_option timed out after 60000ms");
    for (const [dialect, configId, options] of [
      [grokDialect, "reasoning_effort", grokOptions("grok-4.7", "medium")],
      [kimiDialect, "thinking", [selectOption("thinking", "off", ["off", "high"])]],
    ] as const) {
      const logger = testLogger();
      const teardown = vi.fn();
      const session = fakeSession(dialect, { options: [...options], failConfigId: { configId, error: timeout } });
      const { onReady } = await openRuntime({ dialect, session, reasoningEffort: "high", logger, teardownExistingRuntime: teardown });
      expect(onReady, dialect.providerId).toHaveBeenCalledOnce();
      expect(teardown).not.toHaveBeenCalled();
      expect(warningsNamed(logger, "agent_chat.acp_set_reasoning_effort_failed")).toEqual([
        expect.objectContaining({ provider: dialect.providerId, result: "rejected" }),
      ]);
    }

    const teardown = vi.fn();
    const qwen = fakeSession(qwenDialect, { failConfigId: { configId: "reasoning_effort", error: timeout } });
    await expect(openRuntime({ dialect: qwenDialect, session: qwen, reasoningEffort: "high", teardownExistingRuntime: teardown }))
      .rejects.toThrow("Qwen Code ACP could not apply reasoning effort 'high'.");
    expect(teardown).toHaveBeenCalledOnce();

    // An invalid value stays a plain rejection for Qwen too.
    const invalid = fakeSession(qwenDialect, {
      failConfigId: { configId: "reasoning_effort", error: new AcpRpcError("session/set_config_option", { code: -32602, message: "Invalid params" }) },
    });
    await expect(openRuntime({ dialect: qwenDialect, session: invalid, reasoningEffort: "high" })).resolves.toBeDefined();
  });

  it("records the model ADE set as the session's current model", async () => {
    // Copilot's `session/set_model` answers `{}`, so nothing else would tell
    // the turn telemetry the session moved off the entry call's model.
    const copilot = fakeSession(copilotDialect, { options: [selectOption("model", "auto", ["auto", "gpt-5.4"])] });
    const { runtime } = await openRuntime({ dialect: copilotDialect, session: copilot, model: "gpt-5.4" });
    expect(copilot.notedModels).toEqual(["gpt-5.4"]);
    expect(runtime.configOptions.find((option) => option.id === "model")?.value).toBe("gpt-5.4");

    const kimi = fakeSession(kimiDialect, {
      options: [selectOption("model", "kimi-k2-turbo-preview", ["kimi-k2-turbo-preview", "kimi-k2-thinking"])],
      silentReplies: true,
    });
    await openRuntime({ dialect: kimiDialect, session: kimi, model: "kimi-k2-thinking" });
    expect(kimi.notedModels).toEqual(["kimi-k2-thinking"]);

    // A model the agent does not offer is not recorded: the session kept its own.
    const refused = fakeSession(grokDialect, { options: grokOptions("grok-4.7", "medium") });
    await openRuntime({ dialect: grokDialect, session: refused, model: "grok-9" });
    expect(refused.notedModels).toEqual([]);
  });

  it("keeps a Grok runtime whose only change is the effort flag, when its session takes the effort as an option", async () => {
    const opened = fakeSession(grokDialect, { options: grokOptions("grok-4.7", "medium") });
    const { runtime } = await openRuntime({
      dialect: grokDialect,
      session: opened,
      spawnArgs: ["agent", "--reasoning-effort", "low", "stdio"],
    });
    openAcpSessionMock.mockClear();
    const teardown = vi.fn();
    const reused = await openRuntime({
      dialect: grokDialect,
      session: fakeSession(grokDialect),
      spawnArgs: ["agent", "--reasoning-effort", "high", "stdio"],
      existingRuntime: runtime,
      teardownExistingRuntime: teardown,
    });
    expect(reused.runtime).toBe(runtime);
    expect(openAcpSessionMock).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();

    // A build before 1.0.40 advertises no effort option: only the flag moves
    // its effort, so the runtime restarts.
    const old = await openRuntime({
      dialect: grokDialect,
      session: fakeSession(grokDialect),
      spawnArgs: ["agent", "--reasoning-effort", "low", "stdio"],
    });
    const restart = vi.fn();
    const next = await openRuntime({
      dialect: grokDialect,
      session: fakeSession(grokDialect),
      spawnArgs: ["agent", "--reasoning-effort", "high", "stdio"],
      existingRuntime: old.runtime,
      teardownExistingRuntime: restart,
    });
    expect(next.runtime).not.toBe(old.runtime);
    expect(restart).toHaveBeenCalledOnce();
  });

  it("rejects a live effort change for a dialect without an effort option", async () => {
    const session = fakeSession(copilotDialect);
    const { runtime } = await openRuntime({ dialect: copilotDialect, session });
    await expect(setAcpReasoningEffort(runtime, "high", { sessionId: "chat-1", logger: testLogger() as unknown as Logger }))
      .resolves.toBe("rejected");
  });
});
