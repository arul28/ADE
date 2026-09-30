import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexVoiceStyleInstructions,
  codexPlanIncludesVoice,
  DEFAULT_CODEX_VOICE_PREFERENCES,
  normalizeCodexVoicePreferences,
} from "../../../shared/codexVoice";
import type { Logger } from "../logging/logger";
import { startCodexVoiceHost, type CodexVoiceHost } from "./codexVoiceHost";
import {
  createCodexVoiceSessions,
  type CodexVoiceChat,
  type CodexVoiceRuntime,
} from "./codexVoiceSession";

const { voiceHostSpawn } = vi.hoisted(() => ({ voiceHostSpawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: voiceHostSpawn,
}));

type VoiceHostRpcMessage = {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

function createVoiceHostProcess() {
  const process = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  const killCalled = deferred<void>();
  process.kill = vi.fn(() => {
    killCalled.resolve();
    return true;
  });
  const requests: VoiceHostRpcMessage[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  let buffered = "";
  const writeMessage = (message: VoiceHostRpcMessage) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const waitForRequestCount = (count: number): Promise<void> => {
    if (requests.length >= count) return Promise.resolve();
    return new Promise((resolve) => waiters.push({ count, resolve }));
  };
  process.stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as VoiceHostRpcMessage;
      if (request.id === undefined || typeof request.method !== "string") continue;
      requests.push(request);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (requests.length >= waiters[index]!.count) waiters.splice(index, 1)[0]!.resolve();
      }
      if (request.method.startsWith("manual/")) continue;
      const result = request.method === "account/read"
        ? { account: { type: "chatgpt", planType: "pro" } }
        : request.method === "thread/start"
          ? { thread: { id: "relay-thread" } }
          : {};
      writeMessage({ id: request.id, result });
      if (request.method === "thread/realtime/start") {
        writeMessage({ method: "thread/realtime/sdp", params: { sdp: "remote-answer\r\n" } });
      }
    }
  });
  return {
    process,
    requests,
    waitForRequestCount,
    killCalled: killCalled.promise,
    reply: (id: string, result: unknown) => writeMessage({ id, result }),
    emitExit: () => process.emit("exit", 0, null),
  };
}

afterEach(() => {
  voiceHostSpawn.mockReset();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function nativeVoiceHarness(options: {
  planType?: string | null;
  runtimeReady?: Promise<CodexVoiceRuntime>;
  answerOnStart?: boolean;
  failRealtimeStart?: boolean;
  maxRealtimeStarts?: number;
} = {}) {
  const chat: CodexVoiceChat = {
    session: { id: "chat-1", provider: "codex", model: "gpt-6-astra" },
    runtime: null,
    laneWorktreePath: "/workspace",
    recentConversationEntries: [],
  };
  let handleNotification: (
    chat: CodexVoiceChat,
    method: string,
    params: Record<string, unknown>,
  ) => void = () => {};
  const startRequestSeen = deferred<void>();
  const sendRemoteAnswer = () => handleNotification(chat, "thread/realtime/sdp", { sdp: "remote-answer\r\n" });
  let realtimeStartCount = 0;
  const runtimeRequest = vi.fn(async (method: string) => {
    if (method === "thread/realtime/start") {
      realtimeStartCount += 1;
      startRequestSeen.resolve();
      if (options.failRealtimeStart) throw new Error("Realtime start was sent unexpectedly.");
      if (options.maxRealtimeStarts !== undefined && realtimeStartCount > options.maxRealtimeStarts) {
        throw new Error("Too many realtime starts.");
      }
      if (options.answerOnStart !== false) sendRemoteAnswer();
    }
    return {};
  });
  const runtime: CodexVoiceRuntime = {
    request: runtimeRequest as unknown as CodexVoiceRuntime["request"],
    activeTurnId: null,
    awaitingTurnStart: false,
    accountPlanType: options.planType ?? "pro",
  };
  const emitChatEvent = vi.fn();
  const analytics = { captureInternal: vi.fn() };
  const ensureCodexThread = vi.fn(async () => "thread-1");
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const sessions = createCodexVoiceSessions<CodexVoiceChat, CodexVoiceRuntime>({
    logger,
    analytics,
    requestTimeoutMs: 5_000,
    ensureChat: () => chat,
    emitChatEvent,
    sendMessage: async () => {},
    steer: async () => {},
    chatIsRunning: () => false,
    ensureCodexRuntime: () => options.runtimeReady ?? Promise.resolve(runtime),
    ensureCodexThread,
    resolveCodexExecutable: () => ({ executable: "codex", env: process.env }),
    chatSummary: () => null,
  });
  handleNotification = sessions.handleNotification;
  return {
    chat,
    runtime,
    runtimeRequest,
    startRequestSeen: startRequestSeen.promise,
    sendRemoteAnswer,
    emitChatEvent,
    analytics,
    ensureCodexThread,
    sessions,
  };
}

function hostedVoiceHarness(options: { chatIsRunning?: boolean } = {}) {
  const hostProcess = createVoiceHostProcess();
  voiceHostSpawn.mockReturnValue(hostProcess.process as unknown as ChildProcessWithoutNullStreams);
  const chat: CodexVoiceChat = {
    session: { id: "chat-host", provider: "qwen", model: "qwen-3" },
    runtime: null,
    laneWorktreePath: "/workspace",
    recentConversationEntries: [],
  };
  const messageSent = deferred<Record<string, unknown>>();
  const sendMessage = vi.fn(async (args: Record<string, unknown>) => { messageSent.resolve(args); });
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const sessions = createCodexVoiceSessions<CodexVoiceChat, CodexVoiceRuntime>({
    logger,
    requestTimeoutMs: 5_000,
    ensureChat: () => chat,
    emitChatEvent: vi.fn(),
    sendMessage,
    steer: vi.fn().mockResolvedValue(undefined),
    chatIsRunning: () => options.chatIsRunning ?? false,
    ensureCodexRuntime: async () => ({
      request: vi.fn().mockResolvedValue(undefined),
      activeTurnId: null,
      awaitingTurnStart: false,
      accountPlanType: "pro",
    }),
    ensureCodexThread: async () => "unused-native-thread",
    resolveCodexExecutable: () => ({ executable: "codex", env: process.env }),
    chatSummary: () => null,
  });
  return { chat, hostProcess, messageSent: messageSent.promise, sendMessage, sessions };
}

async function stopHostedVoiceHarness(harness: ReturnType<typeof hostedVoiceHarness>, token: string): Promise<void> {
  await harness.sessions.stop({ sessionId: harness.chat.session.id, token });
  await harness.hostProcess.killCalled;
  harness.hostProcess.emitExit();
}

describe("Codex voice preferences and plans", () => {
  it("normalizes account-synced settings before they reach Codex", () => {
    const preferences = normalizeCodexVoicePreferences({
      enabled: false,
      personality: "custom",
      customPersonality: `  ${"x".repeat(601)}  `,
      voice: "unsupported-voice",
      preferredName: `  ${"n".repeat(61)}  `,
      updates: "verbose",
      language: "  French  ",
    });

    expect(preferences.enabled).toBe(false);
    expect(preferences.personality).toBe("custom");
    expect(preferences.voice).toBe(DEFAULT_CODEX_VOICE_PREFERENCES.voice);
    expect(preferences.customPersonality).toHaveLength(600);
    expect(preferences.preferredName).toHaveLength(60);
    expect(preferences.updates).toBe(DEFAULT_CODEX_VOICE_PREFERENCES.updates);
    expect(preferences.language).toBe("French");
  });

  it("includes custom voice choices without pinning the generated wording", () => {
    const instructions = buildCodexVoiceStyleInstructions({
      ...DEFAULT_CODEX_VOICE_PREFERENCES,
      personality: "custom",
      customPersonality: "Use brief technical phrases",
      preferredName: "Sam",
      updates: "quiet",
      language: "French",
    });

    expect(instructions).toContain("Use brief technical phrases");
    expect(instructions).toContain("Sam");
    expect(instructions).toContain("French");
  });

  it("blocks plans that exclude voice and permits unknown plan names", () => {
    for (const plan of ["free", "go", "free_workspace"]) {
      expect(codexPlanIncludesVoice(plan), plan).toBe(false);
    }
    expect(codexPlanIncludesVoice("plus")).toBe(true);
    expect(codexPlanIncludesVoice("future_plan")).toBe(true);
    expect(codexPlanIncludesVoice(null)).toBe(true);
  });
});

describe("Codex voice host request transport", () => {
  it("matches out-of-order app-server responses to the request that sent them", async () => {
    const server = createVoiceHostProcess();
    voiceHostSpawn.mockReturnValue(server.process as unknown as ChildProcessWithoutNullStreams);
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    let host: CodexVoiceHost | null = null;

    try {
      host = await startCodexVoiceHost({
        executable: "codex",
        env: process.env,
        cwd: "/workspace",
        logger,
        sessionId: "chat-host",
        onNotification: vi.fn(),
        onExit: vi.fn(),
      });
      const bothRequestsReceived = server.waitForRequestCount(5);
      const first = host.request<{ label: string }>("manual/first", {}).then(
        (value) => ({ request: "first", value }),
        (error) => ({ request: "first", error }),
      );
      const second = host.request<{ label: string }>("manual/second", {}).then(
        (value) => ({ request: "second", value }),
        (error) => ({ request: "second", error }),
      );
      await bothRequestsReceived;
      const requests = server.requests.filter((request) => request.method?.startsWith("manual/"));

      server.reply(requests[1]!.id!, { label: "second" });
      await expect(Promise.race([first, second])).resolves.toEqual({
        request: "second",
        value: { label: "second" },
      });
      server.reply(requests[0]!.id!, { label: "first" });
      await expect(first).resolves.toEqual({ request: "first", value: { label: "first" } });
    } finally {
      host?.close();
      server.emitExit();
    }
  });
});

describe("createCodexVoiceSessions", () => {
  it("records voice adoption only after the realtime offer is answered", async () => {
    const harness = nativeVoiceHarness({ answerOnStart: false });
    const start = harness.sessions.start({ sessionId: "chat-1", sdp: "offer\r\n" });
    await harness.startRequestSeen;
    const adoptionEventsBeforeAnswer = harness.analytics.captureInternal.mock.calls.length;
    harness.sendRemoteAnswer();
    const result = await start;
    try {
      expect(result.sdp).toBe("remote-answer\r\n");
      expect(adoptionEventsBeforeAnswer).toBe(0);
      expect(harness.analytics.captureInternal).toHaveBeenCalledTimes(1);
      expect(harness.analytics.captureInternal).toHaveBeenCalledWith(expect.objectContaining({
        event: "ade_feature_used",
        surface: "desktop",
        sessionId: "chat-1",
        properties: {
          feature: "chat",
          action: "voice_conversation_started",
          outcome: "completed",
          provider: "codex",
        },
      }));
    } finally {
      await harness.sessions.stop({ sessionId: "chat-1", token: result.token });
    }
  });

  it("stops an in-flight native startup before it can start a realtime call", async () => {
    const ready = deferred<CodexVoiceRuntime>();
    const harness = nativeVoiceHarness({ runtimeReady: ready.promise, failRealtimeStart: true });
    const start = harness.sessions.start({ sessionId: "chat-1", sdp: "offer\r\n" });
    const stopped = expect(start).rejects.toThrow("Voice was stopped.");

    await harness.sessions.stop({ sessionId: "chat-1" });
    ready.resolve(harness.runtime);

    try {
      await stopped;
      expect(harness.ensureCodexThread).toHaveBeenCalledOnce();
      expect(harness.runtimeRequest.mock.calls.map(([method]) => method)).toEqual([
        "thread/realtime/stop",
      ]);
      expect(harness.sessions.getState({ sessionId: "chat-1", token: "stale" })).toMatchObject({
        status: "ended",
        error: null,
      });
      expect(harness.emitChatEvent).not.toHaveBeenCalled();
    } finally {
      await harness.sessions.stop({ sessionId: "chat-1" });
    }
  });

  it("rejects an ineligible plan before opening the voice thread", async () => {
    const harness = nativeVoiceHarness({ planType: "free" });

    await expect(harness.sessions.start({ sessionId: "chat-1", sdp: "offer\r\n" }))
      .rejects.toThrow("does not include Codex voice");

    expect(harness.ensureCodexThread).not.toHaveBeenCalled();
    expect(harness.runtimeRequest).not.toHaveBeenCalled();
    expect(harness.sessions.getState({ sessionId: "chat-1", token: "stale" })).toMatchObject({
      status: "ended",
      error: expect.stringContaining("does not include Codex voice"),
    });
  });

  it("replaces an in-flight startup and sends only the newer realtime start", async () => {
    vi.useFakeTimers();
    const ready = deferred<CodexVoiceRuntime>();
    const harness = nativeVoiceHarness({ runtimeReady: ready.promise, maxRealtimeStarts: 1 });
    let token: string | null = null;
    try {
      const firstStart = harness.sessions.start({ sessionId: "chat-1", sdp: "first-offer\r\n" });
      const firstStopped = expect(firstStart).rejects.toThrow("Voice was stopped.");
      const secondStart = harness.sessions.start({ sessionId: "chat-1", sdp: "second-offer\r\n" });
      ready.resolve(harness.runtime);

      const [, result] = await Promise.all([firstStopped, secondStart]);
      token = result.token;
      expect(harness.runtimeRequest.mock.calls.filter(([method]) => method === "thread/realtime/start")).toHaveLength(1);
      expect(harness.analytics.captureInternal).toHaveBeenCalledTimes(1);
    } finally {
      if (token) await harness.sessions.stop({ sessionId: "chat-1", token });
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ["thread/realtime/closed", { reason: "previous call closed" }],
    ["thread/realtime/error", { message: "previous call failed" }],
  ])("ignores %s from the previous call before this session starts", async (method, params) => {
    const ready = deferred<CodexVoiceRuntime>();
    const harness = nativeVoiceHarness({ runtimeReady: ready.promise });
    const start = harness.sessions.start({ sessionId: "chat-1", sdp: "offer\r\n" });
    harness.sessions.handleNotification(harness.chat, method, params);
    ready.resolve(harness.runtime);

    const result = await start;
    try {
      expect(result.sdp).toBe("remote-answer\r\n");
      expect(harness.sessions.getState({ sessionId: "chat-1", token: result.token }).status).toBe("live");
    } finally {
      await harness.sessions.stop({ sessionId: "chat-1", token: result.token });
    }
  });

  it("uses native transcript items and ignores the host-only flat transcript", async () => {
    const harness = nativeVoiceHarness();
    const result = await harness.sessions.start({ sessionId: "chat-1", sdp: "offer\r\n" });

    harness.sessions.handleNotification(harness.chat, "thread/realtime/transcript/delta", {
      role: "assistant",
      delta: "wrong source",
    });
    harness.sessions.handleNotification(harness.chat, "thread/realtime/item/started", {
      item: { type: "transcriptSegment", id: "assistant-1", role: "assistant", text: "" },
    });
    harness.sessions.handleNotification(harness.chat, "thread/realtime/item/transcript/delta", {
      itemId: "assistant-1",
      delta: "native answer",
    });
    harness.sessions.handleNotification(harness.chat, "thread/realtime/item/completed", {
      item: { type: "transcriptSegment", id: "assistant-1", role: "assistant", text: "native answer" },
    });

    try {
      expect(harness.sessions.getState({ sessionId: "chat-1", token: result.token }).captions).toEqual([
        { id: "assistant-1", role: "assistant", text: "native answer", final: true },
      ]);
    } finally {
      await harness.sessions.stop({ sessionId: "chat-1", token: result.token });
    }
  });

  it("ends a live voice session after the renderer stops reading state", async () => {
    vi.useFakeTimers();
    const harness = nativeVoiceHarness();
    const result = await harness.sessions.start({ sessionId: "chat-1", sdp: "offer\r\n" });

    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.sessions.getState({ sessionId: "chat-1", token: result.token })).toMatchObject({
        status: "ended",
        error: "The voice window went away.",
      });
    } finally {
      await harness.sessions.stop({ sessionId: "chat-1", token: result.token });
      vi.useRealTimers();
    }
  });

  it("attaches recent spoken requests and skips stale requests on later native turns", async () => {
    vi.useFakeTimers();
    const harness = nativeVoiceHarness();
    const result = await harness.sessions.start({ sessionId: "chat-1", sdp: "offer\r\n" });
    harness.sessions.handleNotification(harness.chat, "thread/realtime/itemAdded", {
      item: { type: "handoff_request", input_transcript: "recent spoken request" },
    });

    try {
      expect(harness.sessions.adoptTurn(harness.chat, harness.runtime, "recent-turn")).toBe(true);
      expect(harness.emitChatEvent).toHaveBeenCalledWith(harness.chat, expect.objectContaining({
        type: "user_message",
        text: "recent spoken request",
      }));

      harness.sessions.handleNotification(harness.chat, "thread/realtime/itemAdded", {
        item: { type: "handoff_request", input_transcript: "stale spoken request" },
      });
      vi.setSystemTime(Date.now() + 15_001);
      expect(harness.sessions.adoptTurn(harness.chat, harness.runtime, "late-turn")).toBe(true);
      expect(harness.emitChatEvent).toHaveBeenCalledTimes(1);
    } finally {
      await harness.sessions.stop({ sessionId: "chat-1", token: result.token });
      vi.useRealTimers();
    }
  });

  it("uses flat transcript events for a host session and ignores native transcript items", async () => {
    const harness = hostedVoiceHarness();
    const result = await harness.sessions.start({ sessionId: harness.chat.session.id, sdp: "offer\r\n" });
    harness.sessions.handleNotification(harness.chat, "thread/realtime/item/started", {
      item: { type: "transcriptSegment", id: "native-1", role: "assistant", text: "wrong source" },
    });
    harness.sessions.handleNotification(harness.chat, "thread/realtime/transcript/delta", {
      role: "assistant",
      delta: "host answer",
    });
    harness.sessions.handleNotification(harness.chat, "thread/realtime/transcript/done", {
      role: "assistant",
      text: "host answer",
    });

    try {
      expect(harness.sessions.getState({ sessionId: harness.chat.session.id, token: result.token }).captions).toEqual([
        { id: "flat-assistant-0", role: "assistant", text: "host answer", final: true },
      ]);
    } finally {
      await stopHostedVoiceHarness(harness, result.token);
    }
  });

  it("speaks the queued chat turn's answer instead of the turn already running", async () => {
    const harness = hostedVoiceHarness({ chatIsRunning: true });
    const result = await harness.sessions.start({ sessionId: harness.chat.session.id, sdp: "offer\r\n" });
    try {
      harness.sessions.handleNotification(harness.chat, "thread/realtime/itemAdded", {
        item: { type: "handoff_request", input_transcript: "spoken request" },
      });
      await expect(harness.messageSent).resolves.toMatchObject({ displayText: "spoken request" });

      harness.sessions.observeChatEvent(harness.chat, { type: "done" } as never);
      expect(harness.hostProcess.requests.filter((request) => request.method === "thread/realtime/appendSpeech")).toHaveLength(0);

      harness.sessions.observeChatEvent(harness.chat, { type: "status", turnStatus: "started", turnId: "turn-2" } as never);
      harness.sessions.observeChatEvent(harness.chat, { type: "text", text: "answer from the queued turn" } as never);
      harness.sessions.observeChatEvent(harness.chat, { type: "done" } as never);
      await harness.hostProcess.waitForRequestCount(5);
      const spoken = harness.hostProcess.requests.find((request) => request.method === "thread/realtime/appendSpeech");
      expect(spoken?.params).toMatchObject({ text: "answer from the queued turn" });
    } finally {
      await stopHostedVoiceHarness(harness, result.token);
    }
  });
});
