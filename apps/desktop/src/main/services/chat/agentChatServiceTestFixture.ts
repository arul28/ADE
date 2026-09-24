/**
 * Shared harness for the agentChatService*.test.ts files: the provider and
 * process mocks, the temp project root, and the per-test reset. Import it
 * before anything else in a test file so its vi.mock calls apply first.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { createTurnUsageLedger, createTurnUsageLedgerStore, type TurnUsageLedgerStore } from "../usage/turnUsageLedger";
import zlib, { gzipSync } from "node:zlib";
import { getSessionInfo, getSessionMessages, getSubagentMessages, query, renameSession, startup, tagSession, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { codexComputerUseClientCandidates } from "../../utils/codexComputerUse";
import {
  buildOpenCodePromptParts,
  openCodeEventStream,
  resolveOpenCodeExecutablePath,
  startOpenCodeSession,
} from "../opencode/openCodeRuntime";
import { loadExternalSessionEvents } from "../externalSessions/events";
import { createMockAcpAgent, respondWithSession, type MockAcpAgent } from "./acpHost/mockAcpAgent";
import { createAcpSessionPool } from "./acpHost/acpSessionPool";
import type { AcpSessionUpdate } from "./acpHost/acpProtocolTypes";
import type * as AcpHostModule from "./acpHost";
import type * as TurnUsageReconcilersModule from "../usage/turnUsageReconcilers";
import type * as PiSdkPoolModule from "./piSdkPool";
import type * as PiInstallationModule from "../ai/piInstallation";
import { openKvDb } from "../state/kvDb";
import { createCtoStateService } from "../cto/ctoStateService";
import { createCtoMemoryService } from "../cto/ctoMemoryService";
import {
  clearOpenCodeInventoryCache,
  peekOpenCodeInventoryCache,
  probeOpenCodeProviderInventory,
} from "../opencode/openCodeInventory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginIdentityConfirmHold } from "./identitySessionPolicy";
import { injectFsFault } from "../../../test/faultInjection";
import {
  resolveBuiltInBrowserActorCapability,
  type BrowserActorCapabilityIssuer,
} from "../builtInBrowser/builtInBrowserActorCapabilities";
import { loadQwenUserSettings } from "../ai/qwenUserSettings";
import {
  buildLaneAppleDeviceDirective,
  createLaneAppleDeviceLookup,
  resolveLaneAppleDeviceDirective,
} from "./laneAppleDeviceDirective";
import { isQuestionShapedPendingInput, readPendingInputRecord } from "./pendingInputRecovery";

/**
 * `vi.waitFor` polls on a timer it assumes is real. Under `vi.useFakeTimers`
 * nothing advances that clock, so a condition still waiting on a queued
 * continuation never becomes true: the wait burns its whole budget without the
 * system under test moving at all, and the test dies on the suite timeout or on
 * a stale assertion rather than on anything it meant to check. Whether it passed
 * came down to whether the work happened to finish before the first synchronous
 * probe — which is why these were the flakiest tests in the repo.
 *
 * This waits correctly under either clock. With fake timers it drains queued
 * microtasks and steps the clock in 10ms slices, stopping the moment the
 * condition holds. The slice is deliberately tiny: the watchdogs these tests
 * assert about are measured in minutes, so a bounded 500ms of fake time can
 * settle a pending async chain without ever manufacturing the timeout event
 * under test. A test that needs a watchdog to fire still advances those minutes
 * itself, explicitly, before waiting. With real timers there was never a
 * problem, so it defers to `vi.waitFor` unchanged.
 */
function usingFakeTimers(): boolean {
  try {
    vi.getTimerCount();
    return true;
  } catch {
    return false;
  }
}

// Captured before any test fakes timers. `realYield` lets pending real I/O
// settle between fake-time steps for tests a loaded CI runner can outrun.
const realSetImmediate = globalThis.setImmediate;

async function waitForFakeTimers(
  assertion: () => unknown,
  options: { steps?: number; stepMs?: number; realYield?: boolean } = {},
): Promise<void> {
  if (!usingFakeTimers()) {
    await vi.waitFor(assertion);
    return;
  }
  const steps = options.steps ?? 50;
  const stepMs = options.stepMs ?? 10;
  let lastError: unknown;
  for (let step = 0; step <= steps; step += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await vi.advanceTimersByTimeAsync(step === 0 ? 0 : stepMs);
    if (options.realYield) await new Promise<void>((resolve) => realSetImmediate(() => resolve()));
  }
  throw lastError;
}

const streamText = vi.fn();
const claudeSdkCreateSessionCompat = vi.hoisted(() => vi.fn());
const claudeSdkResumeSessionCompat = vi.hoisted(() => vi.fn());
const cursorModelsListMock = vi.hoisted(() => vi.fn());
const ORIGINAL_CURSOR_API_KEY = process.env.CURSOR_API_KEY;
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeServer: vi.fn(async () => ({
    url: "http://mock-opencode-server",
    close: vi.fn(),
  })),
  createOpencodeClient: vi.fn(() => ({})),
}));

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    models: {
      list: (...args: unknown[]) => cursorModelsListMock(...args),
    },
  },
}));

// ---------------------------------------------------------------------------
// vi.hoisted mock state
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  /**
   * Bumped by `beforeEach`. A chat service outlives the test that built it when
   * that test fails mid-turn, and its in-flight Cursor turn then records into
   * the NEXT test's freshly-emptied `cursorSdkSendCalls` — which shifts every
   * index the next test asserts on and turns one honest failure into three
   * unreadable ones. Connections stamp the generation they were acquired in and
   * stop recording once it has moved on.
   */
  generation: 0,
  sessions: new Map<string, any>(),
  sessionLinearLinks: new Map<string, any[]>(),
  uuidCounter: 0,
  mcpServerCounter: 0,
  codexThreadCounter: 0,
  codexTurnCounter: 0,
  openCodeSessionCounter: 0,
  openCodeForkCalls: [] as Array<{ id: string }>,
  openCodeSessions: new Map<string, {
    events: any[];
    waiters: Array<() => void>;
    aborted: boolean;
    promptBodies: any[];
    questionReply: ReturnType<typeof vi.fn>;
    questionReject: ReturnType<typeof vi.fn>;
    permissionReply: ReturnType<typeof vi.fn>;
  }>(),
  openCodePromptAsyncBarrier: null as Promise<void> | null,
  /** v2 `session.prompt({ delivery: "steer" })` calls, in call order. */
  openCodeV2SteerCalls: [] as any[],
  /** Set to make the mocked v2 steer throw, standing in for a refused steer. */
  openCodeV2SteerError: null as Error | null,
  /** When set, the mocked v2 steer waits on this before answering. */
  openCodeV2SteerBarrier: null as Promise<void> | null,
  openCodeTitleForNextPrompt: null as string | null,
  openCodeQuestionForNextPrompt: null as null | {
    id: string;
    questions: Array<{
      header: string;
      question: string;
      options?: Array<{ label: string; description?: string }>;
      multiple?: boolean;
      custom?: boolean;
    }>;
  },
  droidSessionCounter: 0,
  codexRequestPayloads: [] as Array<Record<string, unknown>>,
  codexResponseOverrides: new Map<string, Record<string, unknown> | ((payload: Record<string, unknown>) => Record<string, unknown>)>(),
  delayedCodexMethods: new Set<string>(),
  pendingCodexResponses: [] as Array<() => void>,
  codexCollaborationModes: [{ mode: "default" }, { mode: "plan" }] as Array<Record<string, unknown> | string>,
  codexLineHandler: null as ((line: string) => void) | null,
  cursorSdkAcquireCalls: [] as Array<Record<string, unknown>>,
  cursorSdkSendCalls: [] as Array<Record<string, unknown>>,
  cursorSdkPolicyUpdates: [] as Array<Record<string, unknown>>,
  cursorSdkPooled: null as any,
  /** Text pushed through `Run.steer()`, in call order. */
  cursorSdkSteerCalls: [] as string[],
  /** What the mocked `Run.steer()` reports back. */
  cursorSteerOutcome: "complete_delivered" as "complete_delivered" | "revert_to_followup" | "unsupported",
  /** Set to make the mocked `Run.steer()` throw, standing in for a dead worker. */
  cursorSteerError: null as Error | null,
  /** Runs inside the mocked `Run.steer()`, before it answers. */
  onCursorSteer: null as null | (() => void),
  /** When set, the mocked `Run.steer()` waits on this before answering. */
  cursorSteerGate: null as Promise<void> | null,
  cursorSdkAgentIdForNextAcquire: null as string | null,
  cursorSdkCloudRequests: [] as Array<{ type: string; payload: Record<string, unknown> }>,
  cursorSdkCloudResponses: new Map<string, unknown>(),
  /** Every `scheduleTurnUsageFollowUps` call, recorded by the pass-through mock below. */
  turnUsageFollowUps: [] as Array<Record<string, unknown>>,
  /** When set, stands in for the Pi worker pool (`acquirePiSdkConnection`). */
  piAcquire: null as null | ((args: Record<string, unknown>) => Promise<{ generation: number; pooled: any }>),
  /** When set, stands in for `resolvePiInstallation`. */
  piInstallation: null as null | Record<string, unknown>,
  cursorSendPromptGate: null as Promise<void> | null,
  cursorSendPromptError: null as unknown,
  cursorSendPromptResult: null as unknown,
  onCursorSendPrompt: null as ((pooled: any) => void) | null,
  cursorAcquireErrorOnCall: null as number | null,
  cursorSdkPoisonCalls: [] as string[],
  onCursorCancel: null as (() => void) | null,
  droidAcquireCalls: [] as Array<Record<string, unknown>>,
  droidNewSessionCalls: [] as Array<Record<string, unknown>>,
  droidPromptCalls: [] as Array<Record<string, unknown>>,
  droidSettingsUpdates: [] as Array<Record<string, unknown>>,
  droidPooled: null as any,
  droidPromptGate: null as Promise<void> | null,
  droidPromptError: null as unknown,
  emitCodexPayload(payload: Record<string, unknown>) {
    mockState.codexLineHandler?.(JSON.stringify(payload));
  },
  nextUuid: () => {
    mockState.uuidCounter += 1;
    return `test-uuid-${mockState.uuidCounter}`;
  },
  flushCodexResponses: () => {
    const pending = mockState.pendingCodexResponses.splice(0);
    for (const emitResponse of pending) {
      queueMicrotask(emitResponse);
    }
  },
  releaseCursorSendPrompt: null as (() => void) | null,
  releaseCursorSteer: null as (() => void) | null,
  cursorSendParks: [] as Array<() => void>,
  cursorSteerParks: [] as Array<() => void>,
}));

const turnDiffMockState = vi.hoisted(() => ({
  beforeTreeGates: [] as Array<Promise<Map<string, string> | null>>,
  collectSummary: null as ((args: any) => unknown) | null,
}));

/**
 * Park a Cursor `sendPrompt` on a promise whose resolver lives on
 * `mockState`, so `afterEach` can settle it. A never-resolving
 * `new Promise(() => {})` left a live turn hanging; later tests then
 * hit Vitest's 20s `testTimeout` instead of a `waitFor` assertion.
 *
 * Nested parks (a recycle that re-stalls send 3 while send 1 is still
 * open) must not settle the earlier one. `afterEach` drains the whole
 * stack.
 */
function parkCursorSend(): () => void {
  let resolveGate = () => {};
  mockState.cursorSendPromptGate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  const release = () => {
    resolveGate();
    if (mockState.cursorSendPromptGate) mockState.cursorSendPromptGate = null;
    const idx = mockState.cursorSendParks.indexOf(release);
    if (idx >= 0) mockState.cursorSendParks.splice(idx, 1);
  };
  mockState.cursorSendParks.push(release);
  mockState.releaseCursorSendPrompt = () => {
    const parks = mockState.cursorSendParks.splice(0);
    for (const park of parks) park();
  };
  return release;
}

function parkCursorSteer(): () => void {
  let resolveGate = () => {};
  mockState.cursorSteerGate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  const release = () => {
    resolveGate();
    if (mockState.cursorSteerGate) mockState.cursorSteerGate = null;
    const idx = mockState.cursorSteerParks.indexOf(release);
    if (idx >= 0) mockState.cursorSteerParks.splice(idx, 1);
  };
  mockState.cursorSteerParks.push(release);
  mockState.releaseCursorSteer = () => {
    const parks = mockState.cursorSteerParks.splice(0);
    for (const park of parks) park();
  };
  return release;
}

// ---------------------------------------------------------------------------
// vi.mock — external dependencies
// ---------------------------------------------------------------------------

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    randomUUID: () => mockState.nextUuid(),
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc: any = {
      stdin: {
        writable: true,
        write: vi.fn((line: string) => {
          const payload = JSON.parse(line);
          mockState.codexRequestPayloads.push(payload);
          if (payload?.id == null || typeof payload?.method !== "string") return true;

          let result: Record<string, unknown> = {};
          let responseError: Record<string, unknown> | null = null;
          const override = mockState.codexResponseOverrides.get(payload.method);
          if (typeof override === "function") {
            const overrideResult = override(payload);
            const overrideError = overrideResult.error;
            if (overrideError && typeof overrideError === "object" && !Array.isArray(overrideError)) {
              responseError = overrideError as Record<string, unknown>;
            } else {
              result = overrideResult;
            }
          } else if (override) {
            const overrideError = override.error;
            if (overrideError && typeof overrideError === "object" && !Array.isArray(overrideError)) {
              responseError = overrideError as Record<string, unknown>;
            } else {
              result = override;
            }
          } else if (payload.method === "thread/start") {
            mockState.codexThreadCounter += 1;
            result = { thread: { id: `thread-${mockState.codexThreadCounter}` } };
          } else if (payload.method === "turn/start" || payload.method === "review/start") {
            mockState.codexTurnCounter += 1;
            result = { turn: { id: `turn-${mockState.codexTurnCounter}` } };
          } else if (payload.method === "thread/read") {
            const params = payload.params as { threadId?: unknown } | undefined;
            result = {
              thread: {
                id: typeof params?.threadId === "string" ? params.threadId : "thread-1",
                status: { type: "active", activeFlags: [] },
              },
            };
          } else if (payload.method === "thread/turns/list") {
            result = { data: [], nextCursor: null };
          } else if (payload.method === "collaborationMode/list") {
            result = {
              collaborationModes: mockState.codexCollaborationModes,
            };
          } else if (payload.method === "skills/list") {
            result = { skills: [] };
          } else if (payload.method === "plugin/list") {
            result = { marketplaces: [] };
          } else if (payload.method === "plugin/reconcile") {
            result = {};
          } else if (payload.method === "account/rateLimits/read") {
            result = { rateLimits: { remaining: 10, limit: 100, resetAt: null } };
          } else if (payload.method === "thread/queue/add") {
            const params = payload.params as { clientUserMessageId?: unknown } | undefined;
            result = {
              queuedSubmission: {
                id: `queued-${mockState.codexRequestPayloads.length}`,
                clientUserMessageId: typeof params?.clientUserMessageId === "string"
                  ? params.clientUserMessageId
                  : "queued-client",
              },
            };
          } else if (payload.method === "thread/queue/list") {
            result = { queuedSubmissions: [] };
          } else if (
            payload.method === "thread/queue/delete"
            || payload.method === "thread/queue/update"
            || payload.method === "thread/queue/start"
            || payload.method === "thread/settings/update"
            || payload.method === "memory/reset"
            || payload.method === "thread/memoryMode/set"
            || payload.method === "thread/backgroundTerminals/terminate"
          ) {
            result = {};
          } else if (payload.method === "thread/revert") {
            const params = payload.params as { threadId?: unknown } | undefined;
            result = {
              thread: { id: typeof params?.threadId === "string" ? params.threadId : "reverted-thread" },
            };
          } else if (payload.method === "thread/shellCommand") {
            mockState.codexTurnCounter += 1;
            result = { turn: { id: `turn-${mockState.codexTurnCounter}` } };
          } else if (payload.method === "thread/backgroundTerminals/list") {
            result = { terminals: [] };
          }

          const emitResponse = () => {
            const responsePayload = responseError ? {
              jsonrpc: "2.0",
              id: payload.id,
              error: responseError,
            } : {
              jsonrpc: "2.0",
              id: payload.id,
              result,
            };
            mockState.emitCodexPayload(responsePayload);
          };
          if (mockState.delayedCodexMethods.has(payload.method)) {
            mockState.pendingCodexResponses.push(emitResponse);
          } else {
            queueMicrotask(emitResponse);
          }
          return true;
        }),
        end: vi.fn(),
      },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
      pid: 99999,
    };
    return proc;
  }),
}));

vi.mock("node:readline", () => ({
  default: {
    createInterface: vi.fn(() => ({
      on: vi.fn((event: string, handler: (line: string) => void) => {
        if (event === "line") {
          mockState.codexLineHandler = handler;
        }
      }),
      close: vi.fn(),
      [Symbol.asyncIterator]: vi.fn(),
    })),
  },
  createInterface: vi.fn(() => ({
    on: vi.fn((event: string, handler: (line: string) => void) => {
      if (event === "line") {
        mockState.codexLineHandler = handler;
      }
    }),
    close: vi.fn(),
    [Symbol.asyncIterator]: vi.fn(),
  })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  // Mirrors the real export. Structured usage-limit detection reads it, so the
  // mock has to provide it; these are the prefixes the tests below exercise.
  USAGE_LIMIT_ERROR_PREFIXES: [
    "You've hit your",
    "You've reached your",
    "You're out of usage credits",
  ] as const,
  createSdkMcpServer: vi.fn((config: any) => ({
    type: "sdk",
    name: config?.name,
    instance: {
      _registeredTools: Object.fromEntries((config?.tools ?? []).map((entry: any) => [entry.name, entry])),
    },
  })),
  getSessionInfo: vi.fn(),
  getSessionMessages: vi.fn(),
  getSubagentMessages: vi.fn(),
  listSessions: vi.fn(),
  query: vi.fn(),
  renameSession: vi.fn(async () => undefined),
  startup: vi.fn(),
  tagSession: vi.fn(async () => undefined),
  tool: vi.fn((name: string, description: string, inputSchema: unknown, handler: unknown, options?: { alwaysLoad?: boolean }) => ({
    name,
    description,
    inputSchema,
    handler,
    ...(options?.alwaysLoad ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
  })),
}));

vi.mock("@factory/droid-sdk/node", () => ({
  createSdkMcpServer: vi.fn((config: any) => ({
    async start() {
      mockState.mcpServerCounter += 1;
      return {
        type: "http",
        name: config?.name,
        url: `http://127.0.0.1:${47000 + mockState.mcpServerCounter}/mcp`,
        headers: [],
        _registeredTools: Object.fromEntries((config?.tools ?? []).map((entry: any) => [entry.name, entry])),
      };
    },
    close: vi.fn(async () => undefined),
  })),
  tool: vi.fn((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
}));

vi.mock("../ai/codexExecutable", () => ({
  resolveCodexExecutable: vi.fn(() => ({ path: "codex", source: "fallback-command" })),
}));

// The converters read provider stores (and OpenCode shells out); import tests
// script the page they return instead. Default: a session with no messages.
vi.mock("../externalSessions/events", () => ({
  loadExternalSessionEvents: vi.fn(async () => ({
    events: [],
    hasOlder: false,
    olderCursor: null,
    truncated: false,
  })),
}));

vi.mock("../opencode/openCodeRuntime", () => {
  return {
  // Real implementation, not a stub: it decides whether an incremental text
  // delta rode along on `message.part.updated`, and stubbing it to a constant
  // would silently change how the transcript is reassembled.
  openCodePartUpdatedDelta: (properties: unknown): string | undefined => {
    const candidate = (properties as { delta?: unknown } | null | undefined)?.delta;
    return typeof candidate === "string" ? candidate : undefined;
  },
  buildOpenCodePromptParts: vi.fn(({ prompt, files = [] }: { prompt: string; files?: Array<Record<string, unknown>> }) => [
    { type: "text", text: prompt },
    ...files,
  ]),
  // The v2 steer input's file shape; only the inline steer path calls this.
  buildOpenCodeV2PromptAttachments: vi.fn(
    (files: Array<{ path: string; filename?: string }>) => files.map((file) => ({
      uri: `file://${file.path}`,
      name: file.filename ?? file.path,
    })),
  ),
  mapPermissionModeToOpenCodeAgent: vi.fn((mode: string) => {
    if (mode === "plan") return "ade-plan";
    if (mode === "full-auto") return "ade-full-auto";
    return "ade-edit";
  }),
  resolveOpenCodeModelSelection: vi.fn((descriptor: Record<string, unknown>) => ({
    providerID: String(descriptor.family ?? "openai"),
    modelID: String(descriptor.providerModelId ?? descriptor.id ?? "model"),
  })),
  resolveOpenCodeExecutablePath: vi.fn(() => "/usr/local/bin/opencode"),
  startOpenCodeSession: vi.fn(async (args: { directory: string; sessionId?: string }) => {
    mockState.openCodeSessionCounter += 1;
    const sessionId = args.sessionId ?? `opencode-session-${mockState.openCodeSessionCounter}`;
    const state = {
      events: [] as any[],
      waiters: [] as Array<() => void>,
      aborted: false,
      promptBodies: [] as any[],
      questionReply: vi.fn(async ({ requestID, answers }: { requestID: string; answers?: string[][] }) => {
        pushEvent({
          type: "question.replied",
          properties: {
            sessionID: sessionId,
            requestID,
            answers: answers ?? [],
          },
        });
      }),
      questionReject: vi.fn(async ({ requestID }: { requestID: string }) => {
        pushEvent({
          type: "question.rejected",
          properties: {
            sessionID: sessionId,
            requestID,
          },
        });
      }),
      permissionReply: vi.fn(async ({ requestID, reply }: { requestID: string; reply?: string }) => {
        pushEvent({
          type: "permission.replied",
          properties: {
            sessionID: sessionId,
            requestID,
            reply,
          },
        });
      }),
    };
    mockState.openCodeSessions.set(sessionId, state);

    const pushEvent = (event: any) => {
      state.events.push(event);
      const waiters = [...state.waiters];
      state.waiters.length = 0;
      for (const waiter of waiters) waiter();
    };

    const client = {
      __sessionId: sessionId,
      // The v2 API ADE uses for inline steering: one admitted input with
      // `delivery: "steer"` folded into the live agent loop.
      v2: {
        session: {
          prompt: vi.fn(async (params: any) => {
            mockState.openCodeV2SteerCalls.push(params);
            if (mockState.openCodeV2SteerBarrier) await mockState.openCodeV2SteerBarrier;
            if (mockState.openCodeV2SteerError) throw mockState.openCodeV2SteerError;
            return { data: {} };
          }),
        },
      },
      session: {
        fork: vi.fn(async ({ sessionID }: { sessionID: string }) => {
          const forkedId = `${sessionID}-fork`;
          mockState.openCodeForkCalls.push({ id: sessionID });
          return { data: { id: forkedId } };
        }),
        // The v2 client takes one flat parameters object; there is no `body`
        // envelope. Everything ADE sends (agent/model/system/tools/parts) now
        // arrives alongside sessionID and directory.
        promptAsync: vi.fn(async (params: any = {}) => {
          state.promptBodies.push(params ?? {});
          if (mockState.openCodePromptAsyncBarrier) {
            await mockState.openCodePromptAsyncBarrier;
          }
          void (async () => {
            if (mockState.openCodeTitleForNextPrompt) {
              pushEvent({
                type: "session.updated",
                properties: {
                  info: {
                    id: sessionId,
                    title: mockState.openCodeTitleForNextPrompt,
                  },
                },
              });
              mockState.openCodeTitleForNextPrompt = null;
            }
            if (mockState.openCodeQuestionForNextPrompt) {
              const request = mockState.openCodeQuestionForNextPrompt;
              mockState.openCodeQuestionForNextPrompt = null;
              pushEvent({
                type: "question.asked",
                properties: {
                  id: request.id,
                  sessionID: sessionId,
                  questions: request.questions,
                  tool: { messageID: `message-${sessionId}`, callID: `call-${sessionId}` },
                },
              });
            }
            const result = streamText({} as any) as {
              fullStream?: AsyncIterable<Record<string, unknown>>;
            };
            // Mirror the real wire order: OpenCode announces every message
            // (with its role) before its parts arrive.
            const assistantMessageId = `message-${sessionId}`;
            pushEvent({
              type: "message.updated",
              properties: { info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } },
            });
            let text = "";
            for await (const part of result.fullStream ?? []) {
              if (state.aborted) break;
              if (part.type === "start-step") {
                pushEvent({
                  type: "message.part.updated",
                  properties: {
                    part: { id: `step-${sessionId}`, sessionID: sessionId, type: "step-start" },
                  },
                });
                continue;
              }
              if (part.type === "text-delta") {
                text += String(part.textDelta ?? "");
                pushEvent({
                  type: "message.part.updated",
                  properties: {
                    part: { id: `text-${sessionId}`, type: "text", text, messageID: assistantMessageId, sessionID: sessionId },
                  },
                });
                continue;
              }
              if (part.type === "tool-call") {
                pushEvent({
                  type: "message.part.updated",
                  properties: {
                    part: {
                      id: String(part.toolCallId ?? `tool-${sessionId}`),
                      callID: String(part.toolCallId ?? `tool-${sessionId}`),
                      sessionID: sessionId,
                      type: "tool",
                      tool: String(part.toolName ?? "tool"),
                      state: { status: "running", input: part.input ?? {} },
                    },
                  },
                });
                continue;
              }
              if (part.type === "tool-result") {
                pushEvent({
                  type: "message.part.updated",
                  properties: {
                    part: {
                      id: String(part.toolCallId ?? `tool-${sessionId}`),
                      callID: String(part.toolCallId ?? `tool-${sessionId}`),
                      sessionID: sessionId,
                      type: "tool",
                      tool: String(part.toolName ?? "tool"),
                      state: { status: "completed", input: {}, output: part.result ?? part.output ?? {} },
                    },
                  },
                });
                continue;
              }
              if (part.type === "finish") {
                const usage = (part.usage ?? part.totalUsage ?? {}) as Record<string, unknown>;
                pushEvent({
                  type: "message.part.updated",
                  properties: {
                    part: {
                      id: `finish-${sessionId}`,
                      sessionID: sessionId,
                      type: "step-finish",
                      tokens: {
                        input: Number(usage.inputTokens ?? 0),
                        output: Number(usage.outputTokens ?? 0),
                        cache: { read: 0, write: 0 },
                      },
                    },
                  },
                });
                break;
              }
            }
            pushEvent({
              type: "session.idle",
              properties: { sessionID: sessionId },
            });
          })();
        }),
        abort: vi.fn(async ({ sessionID }: { sessionID: string }) => {
          if (sessionID !== sessionId) return;
          state.aborted = true;
          pushEvent({
            type: "session.idle",
            properties: { sessionID: sessionId },
          });
        }),
      },
      question: {
        reply: state.questionReply,
        reject: state.questionReject,
      },
      permission: {
        reply: state.permissionReply,
        // The deprecated session-scoped route, still how ADE answers the
        // pre-`permission.asked` event an older user-installed OpenCode emits.
        respond: vi.fn(async (
          { sessionID, permissionID, response }:
            { sessionID: string; permissionID: string; response: string },
        ) => {
          pushEvent({
            type: "permission.replied",
            properties: {
              sessionID,
              permissionID,
              response,
            },
          });
        }),
      },
    };

    return {
      sessionId,
      directory: args.directory,
      server: {
        url: "http://mock-opencode",
        close: vi.fn(),
      },
      close: vi.fn(),
      touch: vi.fn(),
      setBusy: vi.fn(),
      setEvictionHandler: vi.fn(),
      client,
    };
  }),
  openCodeEventStream: vi.fn(async ({
    client,
    signal,
  }: {
    client: { __sessionId?: string };
    signal?: AbortSignal;
  }) => {
    const state = client.__sessionId ? mockState.openCodeSessions.get(client.__sessionId) : undefined;
    if (!state) {
      return (async function* () {})();
    }
    return (async function* () {
      while (true) {
        if (signal?.aborted) return;
        if (state.events.length > 0) {
          yield state.events.shift();
          continue;
        }
        if (state.aborted) return;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          const finish = () => {
            signal?.removeEventListener("abort", finish);
            const index = state.waiters.indexOf(finish);
            if (index >= 0) state.waiters.splice(index, 1);
            resolve();
          };
          signal?.addEventListener("abort", finish, { once: true });
          state.waiters.push(finish);
        });
      }
    })();
  }),
  };
});

vi.mock("../opencode/openCodeInventory", () => ({
  clearOpenCodeInventoryCache: vi.fn(),
  shutdownInventoryServer: vi.fn(),
  peekOpenCodeInventoryCache: vi.fn(() => null),
  probeOpenCodeProviderInventory: vi.fn(async () => ({
    modelIds: ["opencode/openai/gpt-5.4"],
    providers: [],
    error: null,
    descriptors: [],
  })),
}));

vi.mock("../ai/tools/universalTools", () => ({
  createUniversalToolSet: vi.fn((): Record<string, unknown> => ({
    readFile: { description: "stub", parameters: { type: "object", properties: {} }, execute: vi.fn() },
    grep: { description: "stub", parameters: { type: "object", properties: {} }, execute: vi.fn() },
    TodoRead: {
      description: "stub",
      inputSchema: { safeParseAsync: vi.fn(async () => ({ success: true, data: {} })) },
      execute: vi.fn(async () => ({ count: 0, todos: [] })),
    },
    TodoWrite: { description: "stub", parameters: { type: "object", properties: {} }, execute: vi.fn() },
    bash: { description: "stub", parameters: { type: "object", properties: {} }, execute: vi.fn() },
  })),
}));

vi.mock("../ai/tools/ctoOperatorTools", async () => {
  const { z } = await import("zod");
  // Returns one real ExecutableTool so tests can assert the CTO tool surface is
  // actually registered on a live session, not just enumerated for the prompt.
  // `applyCtoToolPackVisibility` is the REAL implementation: it is a pure
  // function over the map, and stubbing it out would hide a defect where the
  // advertised surface drops a tool the session can still call.
  const actual = await vi.importActual<typeof import("../ai/tools/ctoOperatorTools")>(
    "../ai/tools/ctoOperatorTools",
  );
  return {
    ...actual,
    createCtoOperatorTools: vi.fn(() => ({
      spawnChat: {
        description: "Create a native ADE work chat session.",
        inputSchema: z.object({ laneId: z.string().optional() }),
        execute: async () => ({ success: true }),
        pack: "core" as const,
        alwaysLoad: true,
      },
    })),
  };
});

vi.mock("../ai/tools/systemPrompt", () => ({
  buildCodingAgentSystemPrompt: vi.fn(() => "system prompt"),
  buildNativeSubagentRoutingGuidance: vi.fn(() => "native subagent routing"),
  composeSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../ai/claudeModelUtils", () => ({
  resolveClaudeCliModel: vi.fn((model: string) => model),
}));

vi.mock("../ai/providerRuntimeHealth", () => ({
  getProviderRuntimeHealth: vi.fn(() => null),
  reportProviderRuntimeAuthFailure: vi.fn(),
  reportProviderRuntimeFailure: vi.fn(),
  reportProviderRuntimeReady: vi.fn(),
}));

vi.mock("../ai/claudeRuntimeProbe", () => ({
  CLAUDE_RUNTIME_AUTH_ERROR: "Claude authentication failed",
  isClaudeRuntimeAuthError: vi.fn(() => false),
}));

vi.mock("../ai/claudeCodeExecutable", () => ({
  isExecutablePath: vi.fn(() => true),
  resolveClaudeCodeExecutable: vi.fn(() => ({ path: "/usr/local/bin/claude", source: "path" })),
}));

vi.mock("../ai/droidExecutable", () => ({
  resolveDroidExecutable: vi.fn(() => ({ path: "/usr/local/bin/droid", source: "path" })),
}));

vi.mock("./droidModelsDiscovery", () => ({
  discoverDroidSdkModelDescriptors: vi.fn(async () => [{
    id: "droid/custom:claude-sonnet-5-thinking-32000",
    providerModelId: "custom:claude-sonnet-5-thinking-32000",
    displayName: "Claude Sonnet 5 (High)",
    family: "droid",
    color: "#a78bfa",
    capabilities: {
      tools: true,
      vision: true,
      reasoning: true,
      streaming: true,
    },
    reasoningTiers: ["high"],
  }]),
}));

vi.mock("../ai/authDetector", () => ({
  detectAllAuth: vi.fn(async () => []),
  // The ACP adapter reads this to resolve a binary and to gate the catalog.
  // Every ACP CLI reports installed and signed in unless a test says otherwise.
  detectCliAuthStatuses: vi.fn(async () =>
    ["qwen", "kimi", "grok", "copilot"].map((cli) => ({
      cli,
      installed: true,
      path: `/usr/local/bin/${cli}`,
      authenticated: true,
      verified: false,
    })),
  ),
}));

vi.mock("../ai/qwenUserSettings", () => ({
  loadQwenUserSettings: vi.fn(async () => ({
    authenticated: false,
    models: [],
    defaultModelId: null,
    selectedType: null,
    baseUrlOrigin: null,
  })),
  parseQwenUserSettings: vi.fn(() => ({
    authenticated: false,
    models: [],
    defaultModelId: null,
    selectedType: null,
    baseUrlOrigin: null,
  })),
}));

vi.mock("../ai/localModelDiscovery", () => ({}));

vi.mock("../git/git", () => ({
  runGit: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
}));

vi.mock("./turnDiffSummary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./turnDiffSummary")>();
  return {
    ...actual,
    captureWorkingTreeFingerprint: (cwd: string) => {
      const gate = turnDiffMockState.beforeTreeGates.shift();
      if (!gate) return actual.captureWorkingTreeFingerprint(cwd);
      return gate;
    },
    collectTurnDiffSummary: (args: any) => turnDiffMockState.collectSummary
      ? turnDiffMockState.collectSummary(args)
      : actual.collectTurnDiffSummary(args),
  };
});

vi.mock("./permissionMapping", () => ({
  mapPermissionToClaude: vi.fn(() => "plan"),
  mapPermissionToCodex: vi.fn(() => ({
    approvalPolicy: "on-request",
    sandbox: "read-only",
  })),
}));

vi.mock("../../../shared/chatTranscript", () => ({
  parseAgentChatTranscript: vi.fn(() => []),
}));

vi.mock("./cursorSdkPool", () => ({
  sanitizeCursorSdkWorkerBaseEnv: vi.fn((baseEnv: NodeJS.ProcessEnv) => {
    const env = { ...baseEnv };
    delete env.CURSOR_API_KEY;
    delete env.CURSOR_AUTH_TOKEN;
    delete env.ADE_HOME;
    delete env.ADE_PACKAGE_CHANNEL;
    delete env.ADE_RUNTIME_SOCKET_PATH;
    delete env.ADE_RPC_SOCKET_PATH;
    delete env.ADE_DESKTOP_BRIDGE_SOCKET_PATH;
    delete env.ADE_RUNTIME_BUILD_HASH;
    delete env.ADE_RUNTIME_PARENT_PID;
    delete env.ADE_RUNTIME_IDLE_EXIT_MS;
    delete env.ADE_CLI_ENTRY_PATH;
    delete env.ADE_CLI_JS;
    delete env.ADE_CLI_INSTALL_NAME;
    delete env.ADE_DEFAULT_ROLE;
    delete env.ADE_DESKTOP_APP_NAME;
    delete env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION;
    delete env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL;
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }),
  isCursorSdkPooledAlive: vi.fn((pooled: any) =>
    pooled?.process?.exitCode == null
    && !pooled?.process?.killed
    && pooled?.process?.connected !== false
  ),
  acquireCursorSdkConnection: vi.fn(async (args: Record<string, unknown>) => {
    const acquiredGeneration = mockState.generation;
    mockState.cursorSdkAcquireCalls.push(args);
    if (mockState.cursorAcquireErrorOnCall === mockState.cursorSdkAcquireCalls.length) {
      throw new Error("Cursor SDK worker failed to start.");
    }
    const agentId = mockState.cursorSdkAgentIdForNextAcquire ?? "cursor-sdk-agent-1";
    mockState.cursorSdkAgentIdForNextAcquire = null;
    const pooled: any = {
      process: { exitCode: null, killed: false },
      bridge: {
        onEvent: null as any,
        onRunStarted: null as any,
        onRunResult: null as any,
        onHookRequest: null as any,
      },
      agentId,
      runId: null,
      request: vi.fn(async (type: string, payload?: unknown) => {
        if (type === "policy_update") {
          mockState.cursorSdkPolicyUpdates.push(payload as Record<string, unknown>);
        }
        if (type === "cloud.send.stream") {
          mockState.cursorSdkCloudRequests.push({ type, payload: (payload as Record<string, unknown>) ?? {} });
          if (mockState.cursorSdkCloudResponses.has(type)) {
            const response = mockState.cursorSdkCloudResponses.get(type);
            if (response instanceof Error) throw response;
            return response;
          }
          return {
            agentId: "cloud-agent-1",
            runId: "cloud-run-1",
            status: "finished",
            result: { status: "finished" },
          };
        }
        if (type === "cloud.followup") {
          mockState.cursorSdkCloudRequests.push({ type, payload: (payload as Record<string, unknown>) ?? {} });
          if (mockState.cursorSdkCloudResponses.has(type)) {
            const response = mockState.cursorSdkCloudResponses.get(type);
            if (response instanceof Error) throw response;
            return response;
          }
          return {
            agentId: (payload as Record<string, unknown>)?.agentId ?? "cloud-agent-1",
            runId: "cloud-run-2",
            status: "finished",
            result: { status: "finished" },
          };
        }
        if (type === "cloud.run.cancel") {
          mockState.cursorSdkCloudRequests.push({ type, payload: (payload as Record<string, unknown>) ?? {} });
          return { ok: true };
        }
        return {};
      }),
      sendPrompt: vi.fn(async (payload: Record<string, unknown>) => {
        // A service leaked by a failed earlier test must not write into this
        // test's ledger; see `mockState.generation`.
        if (acquiredGeneration === mockState.generation) {
          mockState.cursorSdkSendCalls.push(payload);
        }
        mockState.onCursorSendPrompt?.(pooled);
        if (mockState.cursorSendPromptGate) await mockState.cursorSendPromptGate;
        if (mockState.cursorSendPromptError) throw mockState.cursorSendPromptError;
        if (mockState.cursorSendPromptResult) return mockState.cursorSendPromptResult;
        return { id: "cursor-sdk-run-1", status: "finished" };
      }),
      updatePolicy: vi.fn(async (policy: Record<string, unknown>) => {
        mockState.cursorSdkPolicyUpdates.push(policy);
      }),
      cancel: vi.fn(async () => {
        mockState.onCursorCancel?.();
      }),
      steer: vi.fn(async (text: string) => {
        mockState.cursorSdkSteerCalls.push(text);
        // Lets a test end the live turn from inside the steer call, which is the
        // real shape of `revert_to_followup`: the turn refuses because it just
        // finished.
        mockState.onCursorSteer?.();
        if (mockState.cursorSteerGate) await mockState.cursorSteerGate;
        if (mockState.cursorSteerError) throw mockState.cursorSteerError;
        return { outcome: mockState.cursorSteerOutcome };
      }),
      dispose: vi.fn(),
    };
    mockState.cursorSdkPooled = pooled;
    return { generation: 1, pooled };
  }),
  releaseCursorSdkConnection: vi.fn(),
  poisonCursorSdkConnection: vi.fn((poolKey: string) => {
    mockState.cursorSdkPoisonCalls.push(poolKey);
    return true;
  }),
  resolveCursorSdkUserHome: vi.fn(() => "/Users/admin"),
  runCursorSdkCatalogRequest: vi.fn(async () => []),
  runCursorSdkCloudRequest: vi.fn(async (args: { type: string; payload: Record<string, unknown> }) => {
    mockState.cursorSdkCloudRequests.push({ type: args.type, payload: args.payload });
    if (mockState.cursorSdkCloudResponses.has(args.type)) {
      return mockState.cursorSdkCloudResponses.get(args.type);
    }
    return {};
  }),
}));

vi.mock("./droidSdkPool", () => ({
  acquireDroidSdkConnection: vi.fn(async (args: Record<string, unknown>) => {
    mockState.droidAcquireCalls.push(args);
    mockState.droidSessionCounter += 1;
    const sdkSessionId = typeof args.resumeSessionId === "string" && args.resumeSessionId.length
      ? args.resumeSessionId
      : `droid-sdk-session-${mockState.droidSessionCounter}`;
    const initialSettings = (args.settings ?? {}) as Record<string, unknown>;
    const availableModels = [
      { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
      { id: "custom:claude-sonnet-5-thinking-32000", displayName: "Custom Claude Sonnet 5 Thinking" },
      { id: "custom:Claude-Sonnet-5-(High)-1", displayName: "Claude Sonnet 5 (High)" },
    ];
    const pooled = {
      process: { exitCode: null, killed: false },
      bridge: {
        onEvent: null,
        onPermissionRequest: null,
        onAskUserRequest: null,
        onReady: null,
      },
      sdkSessionId,
      currentModelId: initialSettings.modelId ?? "claude-sonnet-4-5-20250929",
      availableModels,
      request: vi.fn(async (type: string) => {
        if (type === "fork_session") {
          mockState.droidSessionCounter += 1;
          return { newSessionId: `droid-forked-${mockState.droidSessionCounter}` };
        }
        return null;
      }),
      sendPrompt: vi.fn(async (payload: Record<string, unknown>) => {
        mockState.droidPromptCalls.push(payload);
        if (mockState.droidPromptGate) await mockState.droidPromptGate;
        if (mockState.droidPromptError) throw mockState.droidPromptError;
        return {
          sessionId: sdkSessionId,
          tokenUsage: { inputTokens: 3, outputTokens: 5 },
          success: true,
        };
      }),
      updateSettings: vi.fn(async (settings: Record<string, unknown>): Promise<Record<string, unknown>> => {
        mockState.droidSettingsUpdates.push(settings);
        pooled.currentModelId = settings.modelId ?? pooled.currentModelId;
        const ready: Record<string, unknown> = {
          sessionId: sdkSessionId,
          currentModelId: typeof pooled.currentModelId === "string" ? pooled.currentModelId : null,
          availableModels,
        };
        const onReady = pooled.bridge.onReady as ((ready: Record<string, unknown>) => void) | null;
        onReady?.(ready);
        return ready;
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    mockState.droidPooled = pooled;
    return {
      generation: 1,
      pooled,
    };
  }),
  releaseDroidSdkConnection: vi.fn(),
}));

// Pass-through: records which provider handles a settled turn's follow-ups were given.
vi.mock("../usage/turnUsageReconcilers", async (importOriginal) => {
  const actual = await importOriginal<typeof TurnUsageReconcilersModule>();
  return {
    ...actual,
    scheduleTurnUsageFollowUps: vi.fn((args: Parameters<typeof actual.scheduleTurnUsageFollowUps>[0]) => {
      mockState.turnUsageFollowUps.push(args as unknown as Record<string, unknown>);
      return actual.scheduleTurnUsageFollowUps(args);
    }),
  };
});

// Pass-through: a test can stand in for the Pi worker pool and the installed
// Pi SDK (`mockState.piAcquire` / `mockState.piInstallation`).
vi.mock("./piSdkPool", async (importOriginal) => {
  const actual = await importOriginal<typeof PiSdkPoolModule>();
  return {
    ...actual,
    acquirePiSdkConnection: vi.fn((args: Parameters<typeof actual.acquirePiSdkConnection>[0]) =>
      mockState.piAcquire
        ? mockState.piAcquire(args as unknown as Record<string, unknown>)
        : actual.acquirePiSdkConnection(args)),
    isPiSdkPooledAlive: vi.fn((pooled: Parameters<typeof actual.isPiSdkPooledAlive>[0]) =>
      mockState.piAcquire ? true : actual.isPiSdkPooledAlive(pooled)),
    releasePiSdkConnection: vi.fn((...args: Parameters<typeof actual.releasePiSdkConnection>) => {
      if (!mockState.piAcquire) return actual.releasePiSdkConnection(...args);
      args[2]?.();
    }),
  };
});
vi.mock("../ai/piInstallation", async (importOriginal) => {
  const actual = await importOriginal<typeof PiInstallationModule>();
  return {
    ...actual,
    resolvePiInstallation: vi.fn((...args: Parameters<typeof actual.resolvePiInstallation>) =>
      (mockState.piInstallation as ReturnType<typeof actual.resolvePiInstallation> | null)
        ?? actual.resolvePiInstallation(...args)),
  };
});

// Pass-through: a test can wrap the ACP runtime it opens (see the Stop-race test).
vi.mock("./acpHost", async (importOriginal) => {
  const actual = await importOriginal<typeof AcpHostModule>();
  return { ...actual, createAcpRuntime: vi.fn(actual.createAcpRuntime) };
});

// ---------------------------------------------------------------------------
// Import system under test (after mocks)
// ---------------------------------------------------------------------------
import { createAcpRuntime, type AcpSession } from "./acpHost";
import {
  buildOpenCodeStreamMessages,
  buildComputerUseDirective,
  computerUseDirectiveFingerprint,
  buildLinearSessionDirective,
  codexServerSupportsForkBeforeTurn,
  parseCodexServerVersion,
  writeSessionLinearIssueContextFile,
  createAgentChatService,
  restartRecoveryStopAttribution,
  CURSOR_SDK_FIRST_EVENT_WATCHDOG_MS,
  CURSOR_SDK_RECYCLE_CANCEL_TIMEOUT_MS,
} from "./agentChatService";
import { createChatRuntimeBudget } from "./chatRuntimeBudget";
import { readThreadPointerLedger } from "./threadPointerLedger";
import { SESSION_STALE_AFTER_MS } from "../../../shared/sessionCanonicalState";
import {
  enforceCrossMachineForkEncodedBudget,
  gunzipFromBase64,
} from "./crossMachineForkTransport";
import { spawn } from "node:child_process";
import { detectAllAuth, detectCliAuthStatuses } from "../ai/authDetector";
import { buildCodingAgentSystemPrompt } from "../ai/tools/systemPrompt";
import { runGit } from "../git/git";
import { deriveScheduledWorkSnapshots } from "../../../shared/chatScheduledWork";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import type { ChatScheduledWorkRecord, ChatScheduledWorkState } from "./chatScheduledWorkScheduler";
import { mapPermissionToClaude, mapPermissionToCodex } from "./permissionMapping";
import { acquireCursorSdkConnection, releaseCursorSdkConnection } from "./cursorSdkPool";
import {
  CODEX_REPLAY_MAX_CHARS,
  CROSS_PROVIDER_REPLAY_HEADER,
} from "./crossProviderReplayFork";
import { acquireDroidSdkConnection } from "./droidSdkPool";
import { clearCursorCliModelsCache, probeCursorSdkModelDiscovery } from "./cursorModelsDiscovery";
import type { AdeTurnUsageRecord, AgentChatCreateArgs, AgentChatCreateScheduledWorkArgs, AgentChatCrossMachineHandoffCapsule, AgentChatEventEnvelope, ComputerUseBackendStatus, LaneLinearIssue, PendingInputRequest } from "../../../shared/types";
import { PTY_SEND_PRE_DELIVERY_ERROR_CODE } from "../../../shared/types";
import { makeLinearIssueContextAttachment } from "../../../shared/chatContextAttachments";
import { stableStringify } from "../shared/utils";
import {
  createDynamicOpenCodeModelDescriptor,
  createDynamicPiModelDescriptor,
  getDefaultModelDescriptor,
  getDynamicAcpModelDescriptors,
  getModelById,
  replaceDynamicOpenCodeModelDescriptors,
  replaceDynamicPiModelDescriptors,
} from "../../../shared/modelRegistry";
import { CLAUDE_MUTATING_BUILTIN_TOOLS } from "../../../shared/permissionPolicy";
import { CLAUDE_READ_ONLY_TOOLS } from "./claudeToolGate";
import { SessionTurnAbandonedError } from "./sessionTurnLimits";
import { HOST_TOOL_APPROVAL_NAMES } from "../../../shared/__fixtures__/hostToolApprovalNames";

/**
 * The fake `@anthropic-ai/claude-agent-sdk` session every Claude test mounts.
 *
 * One factory at module scope because five call sites had pasted the same
 * four-field literal inline, next to two local factories that existed to
 * prevent exactly that.
 */
function claudeSdkSession(sessionId: string): Record<string, unknown> {
  return {
    send: vi.fn(),
    stream: vi.fn(async function* () {
      return;
    }),
    close: vi.fn(),
    sessionId,
  };
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHomeRoot: string;
let tmpRoot: string;

function makeDefaultClaudeSession() {
  return {
    sessionId: "sdk-session-default",
    send: vi.fn(async () => undefined),
    stream: vi.fn(async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sdk-session-default",
      };
    }),
    close: vi.fn(),
    query: {
      interrupt: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      reloadPlugins: vi.fn(async () => ({ commands: [], agents: [], plugins: [], error_count: 0 })),
      supportedCommands: vi.fn(async () => []),
    },
  };
}

function legacyClaudeSendPayload(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const record = message as {
    type?: unknown;
    shouldQuery?: unknown;
    priority?: unknown;
    message?: { content?: Array<Record<string, unknown>> };
  };
  if (record.type !== "user") {
    return message;
  }
  if (record.shouldQuery === false || record.priority != null) {
    return message;
  }
  const content = record.message?.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") {
    return message;
  }
  return String(content[0]?.text ?? "");
}

function beginClaudeStartupWarmup(session: any) {
  if (!session) {
    throw new Error("beginClaudeStartupWarmup requires a session fixture");
  }
  void (async () => {
    try {
      if (typeof session.send === "function") {
        await session.send("System initialization check. Respond with only the word READY.");
      }
      if (typeof session.stream !== "function") return;
      for await (const _message of session.stream()) {
        // Drain the legacy warmup stream. Production now uses startup(), but
        // these tests still model the old V2 warmup as the first stream call.
      }
    } catch {
      // The service under test handles query-time failures. Startup warmup
      // failures in this compatibility adapter should not fail collection.
    }
  })();
}

function bridgeClaudeSessionToQuery(sessionHandle: any, prompt: unknown) {
  const session = sessionHandle ?? makeDefaultClaudeSession();
  const stream = typeof session.stream === "function"
    ? session.stream()
    : (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: session.sessionId ?? "sdk-session-default",
      };
    })();

  let firstInputSeen = false;
  let resolveFirstInput!: () => void;
  const firstInput = new Promise<void>((resolve) => {
    resolveFirstInput = resolve;
  });
  const markFirstInput = () => {
    if (firstInputSeen) return;
    firstInputSeen = true;
    resolveFirstInput();
  };
  const send = async (message: unknown) => {
    if (typeof session.send === "function") {
      await session.send(legacyClaudeSendPayload(message));
    }
    markFirstInput();
  };

  void (async () => {
    try {
      if (typeof prompt === "string") {
        await send(prompt);
        return;
      }
      if (prompt && typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
        for await (const message of prompt as AsyncIterable<unknown>) {
          await send(message);
        }
      }
    } finally {
      markFirstInput();
    }
  })();

  const queryHandle: any = {
    async next() {
      if (!firstInputSeen) {
        await firstInput;
      }
      return stream.next();
    },
    async return() {
      markFirstInput();
      if (typeof session.close === "function") {
        session.close();
      }
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    close: vi.fn(() => {
      markFirstInput();
      if (typeof session.close === "function") {
        session.close();
      }
    }),
    interrupt: vi.fn(async () => {
      if (typeof session.interrupt === "function") {
        return session.interrupt();
      }
      if (typeof session.query?.interrupt === "function") {
        return session.query.interrupt();
      }
      return undefined;
    }),
    request: vi.fn(async (request: unknown) => {
      if (typeof session.request === "function") {
        return session.request(request);
      }
      if (typeof session.query?.request === "function") {
        return session.query.request(request);
      }
      return { response: undefined };
    }),
    stopTask: vi.fn(async (taskId: string) => {
      if (typeof session.stopTask === "function") {
        return session.stopTask(taskId);
      }
      if (typeof session.query?.stopTask === "function") {
        return session.query.stopTask(taskId);
      }
      return undefined;
    }),
    cancelAsyncMessage: vi.fn(async (uuid: string) => {
      if (typeof session.cancelAsyncMessage === "function") {
        return session.cancelAsyncMessage(uuid);
      }
      if (typeof session.query?.cancelAsyncMessage === "function") {
        return session.query.cancelAsyncMessage(uuid);
      }
      return false;
    }),
    setPermissionMode: vi.fn(async (mode: string) => {
      if (typeof session.setPermissionMode === "function") {
        return session.setPermissionMode(mode);
      }
      if (typeof session.query?.setPermissionMode === "function") {
        return session.query.setPermissionMode(mode);
      }
      return undefined;
    }),
    reloadPlugins: vi.fn(async () => {
      if (typeof session.reloadPlugins === "function") {
        return session.reloadPlugins();
      }
      if (typeof session.query?.reloadPlugins === "function") {
        return session.query.reloadPlugins();
      }
      return { commands: [], agents: [], plugins: [], error_count: 0 };
    }),
    applyFlagSettings: vi.fn(async (settings: unknown) => {
      if (typeof session.applyFlagSettings === "function") {
        return session.applyFlagSettings(settings);
      }
      if (typeof session.query?.applyFlagSettings === "function") {
        return session.query.applyFlagSettings(settings);
      }
      return undefined;
    }),
    setModel: vi.fn(async (model: string) => {
      if (typeof session.setModel === "function") {
        return session.setModel(model);
      }
      return undefined;
    }),
    supportedCommands: vi.fn(async () => {
      if (typeof session.supportedCommands === "function") {
        return session.supportedCommands();
      }
      if (typeof session.query?.supportedCommands === "function") {
        return session.query.supportedCommands();
      }
      return [];
    }),
    getContextUsage: vi.fn(async (options?: unknown) => {
      if (typeof session.getContextUsage === "function") {
        return session.getContextUsage(options);
      }
      if (typeof session.query?.getContextUsage === "function") {
        return session.query.getContextUsage(options);
      }
      return {
        categories: [],
        totalTokens: 0,
        maxTokens: 0,
        rawMaxTokens: 0,
        percentage: 0,
        gridRows: [],
        model: "",
      };
    }),
    initializationResult: vi.fn(async () => {
      if (typeof session.initializationResult === "function") {
        return session.initializationResult();
      }
      if (typeof session.query?.initializationResult === "function") {
        return session.query.initializationResult();
      }
      return {};
    }),
    rewindFiles: vi.fn(async (userMessageId: string, options?: { dryRun?: boolean }) => {
      if (typeof session.rewindFiles === "function") {
        return session.rewindFiles(userMessageId, options);
      }
      if (typeof session.query?.rewindFiles === "function") {
        return session.query.rewindFiles(userMessageId, options);
      }
      return {
        canRewind: true,
        filesChanged: ["src/example.ts"],
        insertions: 1,
        deletions: 2,
      };
    }),
    streamInput: vi.fn(async (input: AsyncIterable<unknown>) => {
      for await (const message of input) {
        await send(message);
      }
    }),
  };
  return queryHandle;
}

function installClaudeSdkCompatMocks() {
  const createSessionMock = vi.mocked(claudeSdkCreateSessionCompat);
  const resumeSessionMock = vi.mocked(claudeSdkResumeSessionCompat);

  vi.mocked(query).mockImplementation(((args: { prompt: unknown; options?: Record<string, unknown> }) => {
    const options = args.options ?? {};
    const sdkSessionId = typeof options.resume === "string" ? options.resume : null;
    const session = sdkSessionId
      ? resumeSessionMock(sdkSessionId, options as any)
      : createSessionMock(options as any);
    return bridgeClaudeSessionToQuery(session, args.prompt);
  }) as any);

  vi.mocked(startup).mockImplementation((async (args?: { options?: Record<string, unknown> }) => {
    const options = args?.options ?? {};
    const sdkSessionId = typeof options.resume === "string" ? options.resume : null;
    const session = sdkSessionId
      ? resumeSessionMock(sdkSessionId, options as any)
      : createSessionMock(options as any);
    beginClaudeStartupWarmup(session);
    return {
      query: (prompt: unknown) => bridgeClaudeSessionToQuery(session, prompt),
      close: () => {
        if (typeof session?.close === "function") {
          session.close();
        }
      },
    };
  }) as any);
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as const;
}

function createMockLaneService() {
  const laneRoots: Record<string, string> = {
    "lane-1": tmpRoot,
    "lane-2": path.join(tmpRoot, "lane-2"),
  };
  fs.mkdirSync(laneRoots["lane-2"], { recursive: true });
  const lanes = [
    {
      id: "lane-1",
      name: "Primary",
      laneType: "primary",
      branchRef: "feature/primary",
      worktreePath: laneRoots["lane-1"],
      status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    },
    {
      id: "lane-2",
      name: "Selected",
      laneType: "feature",
      branchRef: "feature/selected",
      worktreePath: laneRoots["lane-2"],
      status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    },
  ];
  return {
    getLaneBaseAndBranch: vi.fn((laneId: string) => {
      const lane = lanes.find((entry) => entry.id === laneId);
      if (lane) {
        return {
          baseRef: "main",
          branchRef: lane.branchRef,
          worktreePath: lane.worktreePath,
          laneType: lane.laneType,
        };
      }
      throw new Error(`Lane not found: ${laneId}`);
    }),
    list: vi.fn(async () => lanes),
    getSummary: vi.fn(async (laneId: string) => lanes.find((lane) => lane.id === laneId) ?? null),
    rename: vi.fn(({ laneId, name }: { laneId: string; name: string }) => {
      const lane = lanes.find((entry) => entry.id === laneId);
      if (!lane) throw new Error(`Lane not found: ${laneId}`);
      if (lane.laneType === "primary") throw new Error("Primary lane cannot be renamed");
      lane.name = name;
    }),
    importBranch: vi.fn(async ({ branchRef, name, description }: { branchRef: string; name?: string; description?: string }) => {
      const lane = {
        id: `lane-${lanes.length + 1}`,
        name: name ?? branchRef,
        description: description ?? null,
        laneType: "feature",
        branchRef,
        worktreePath: path.join(tmpRoot, `imported-lane-${lanes.length + 1}`),
        status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
      };
      fs.mkdirSync(lane.worktreePath, { recursive: true });
      lanes.push(lane);
      return lane;
    }),
    ensurePrimaryLane: vi.fn(async () => {}),
    create: vi.fn(async ({ name, description, parentLaneId }: { name: string; description?: string; parentLaneId?: string }) => {
      const lane = {
        id: `lane-${lanes.length + 1}`,
        name,
        description: description ?? null,
        laneType: "feature",
        branchRef: `feature/generated-lane-${lanes.length + 1}`,
        worktreePath: path.join(tmpRoot, `generated-lane-${lanes.length + 1}`),
        parentLaneId: parentLaneId ?? "lane-1",
        status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
      };
      fs.mkdirSync(lane.worktreePath, { recursive: true });
      lanes.push(lane);
      return lane;
    }),
    getLane: vi.fn((laneId: string) => lanes.find((lane) => lane.id === laneId) ?? null),
    // Session-scoped Linear link store so tests can assert that a launched chat
    // actually persists its attached issue (FIX 1) and that the directive
    // injection (FIX 4) sees the attached issues.
    attachLinearIssueToSession: vi.fn((args: { chatSessionId: string; issues: LaneLinearIssue[]; role?: string }) => {
      const existing = mockState.sessionLinearLinks.get(args.chatSessionId) ?? [];
      const links = args.issues.map((issue) => ({
        issue,
        role: args.role ?? "worked",
        source: "chat_attach" as const,
        includeInPr: true,
        closeOnMerge: false,
        evidence: { chatSessionId: args.chatSessionId },
      }));
      mockState.sessionLinearLinks.set(args.chatSessionId, [...existing, ...links]);
      return links;
    }),
    linkLinearIssues: vi.fn(() => {}),
    listLinearIssuesForSession: vi.fn((args: { chatSessionId: string }) =>
      mockState.sessionLinearLinks.get(args.chatSessionId) ?? []),
  } as any;
}

function createMockSessionService() {
  const sessions = mockState.sessions;
  const claudePointers = new Map<string, any>();
  return {
    create: vi.fn((args: any) => {
      sessions.set(args.sessionId, {
        id: args.sessionId,
        laneId: args.laneId,
        ptyId: args.ptyId ?? null,
        tracked: args.tracked ?? true,
        title: args.title ?? "Chat",
        toolType: args.toolType ?? "opencode-chat",
        status: "running",
        startedAt: args.startedAt ?? new Date().toISOString(),
        endedAt: null,
        archivedAt: null,
        transcriptPath: args.transcriptPath ?? "",
        resumeCommand: args.resumeCommand ?? null,
        lastOutputPreview: null,
        summary: null,
        goal: args.goal ?? null,
        statusNote: null,
        manuallyNamed: false,
        headShaStart: null,
        headShaEnd: null,
      });
    }),
    get: vi.fn((sessionId: string) => sessions.get(sessionId) ?? null),
    list: vi.fn((opts?: any) => {
      let rows = Array.from(sessions.values());
      if (typeof opts?.laneId === "string") {
        rows = rows.filter((row) => row.laneId === opts.laneId);
      }
      if (typeof opts?.status === "string") {
        rows = rows.filter((row) => row.status === opts.status);
      }
      if (Array.isArray(opts?.toolTypes) && opts.toolTypes.length > 0) {
        rows = rows.filter((row) => opts.toolTypes.includes(row.toolType));
      }
      rows = rows.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
      if (opts?.limit === null) return rows;
      const limit = typeof opts?.limit === "number" ? opts.limit : 200;
      return rows.slice(0, limit);
    }),
    reopen: vi.fn((sessionId: string) => {
      const row = sessions.get(sessionId);
      if (row) {
        row.status = "running";
        row.endedAt = null;
      }
    }),
    end: vi.fn((args: any) => {
      const sessionId = typeof args === "string" ? args : args?.sessionId;
      const row = sessions.get(sessionId);
      if (row) {
        row.status = args?.status ?? "disposed";
        row.endedAt = args?.endedAt ?? new Date().toISOString();
      }
    }),
    deleteSession: vi.fn((sessionId: string) => {
      sessions.delete(sessionId);
      return true;
    }),
    archiveSession: vi.fn((sessionId: string) => {
      const row = sessions.get(sessionId);
      if (row) row.archivedAt = row.archivedAt ?? new Date().toISOString();
      return Boolean(row);
    }),
    unarchiveSession: vi.fn((sessionId: string) => {
      const row = sessions.get(sessionId);
      if (row) row.archivedAt = null;
      return Boolean(row);
    }),
    updateMeta: vi.fn((args: any) => {
      const row = sessions.get(args.sessionId);
      if (row) {
        if (typeof args.laneId === "string" && args.laneId.trim().length) row.laneId = args.laneId.trim();
        if (args.title !== undefined) row.title = args.title;
        if (args.goal !== undefined) row.goal = args.goal;
        if (args.manuallyNamed !== undefined) row.manuallyNamed = args.manuallyNamed;
        if (args.toolType !== undefined) row.toolType = args.toolType;
        if (args.resumeCommand !== undefined) row.resumeCommand = args.resumeCommand;
      }
    }),
    setStatusNote: vi.fn((sessionId: string, note: string | null) => {
      const row = sessions.get(sessionId);
      if (row) row.statusNote = note;
      return Boolean(row);
    }),
    getStatusNoteUpdatedAt: vi.fn(() => null),
    setHeadShaStart: vi.fn(),
    setHeadShaEnd: vi.fn(),
    setLastOutputPreview: vi.fn(),
    clearTurnStartMarkers: vi.fn(),
    clearSessionActivity: vi.fn(),
    markLastTurnFailed: vi.fn(),
    clearLastTurnFailed: vi.fn(),
    setSummary: vi.fn(),
    setResumeCommand: vi.fn((sessionId: string, resumeCommand: string | null) => {
      const row = sessions.get(sessionId);
      if (row) {
        row.resumeCommand = resumeCommand;
      }
    }),
    upsertClaudeSessionPointer: vi.fn((pointer: any) => {
      const existing = pointer.chatSessionId
        ? claudePointers.get(pointer.chatSessionId)
        : Array.from(claudePointers.values()).find((candidate) => candidate.sessionId === pointer.sessionId);
      const next = {
        ...existing,
        ...pointer,
        title: pointer.title !== undefined ? pointer.title : existing?.title ?? null,
        tags: pointer.tags !== undefined ? pointer.tags : existing?.tags ?? [],
      };
      if (next.chatSessionId) claudePointers.set(next.chatSessionId, next);
      return next;
    }),
    getClaudeSessionPointer: vi.fn((sdkSessionId: string) => (
      Array.from(claudePointers.values()).find((pointer) => pointer.sessionId === sdkSessionId) ?? null
    )),
    getClaudeSessionPointerByChatSessionId: vi.fn((chatSessionId: string) => claudePointers.get(chatSessionId) ?? null),
    listClaudeSessionPointers: vi.fn(() => Array.from(claudePointers.values())),
  } as any;
}

function createMockProjectConfigService() {
  return {
    get: vi.fn(() => ({
      effective: {
        ai: {
          permissions: {
            cli: { mode: "edit" },
            inProcess: { mode: "edit" },
          },
          chat: {},
          sessionIntelligence: {},
        },
      },
    })),
    getAll: vi.fn(() => ({})),
    set: vi.fn(),
  } as any;
}

const SCHEDULED_WORK_STATE_KEY = "agent-chat:scheduled-work:v1";
const SCHEDULE_TEST_START = Date.parse("2026-07-10T09:00:00.000Z");

function createScheduledWorkDb(initialState: ChatScheduledWorkState | null = null) {
  const values = new Map<string, unknown>();
  if (initialState) values.set(SCHEDULED_WORK_STATE_KEY, structuredClone(initialState));
  return {
    db: {
      getJson: vi.fn((key: string) => structuredClone(values.get(key) ?? null)),
      setJson: vi.fn((key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      }),
    },
    readState: (): ChatScheduledWorkState | null => {
      const state = values.get(SCHEDULED_WORK_STATE_KEY);
      return state ? structuredClone(state) as ChatScheduledWorkState : null;
    },
  };
}

function storedWakeup(
  sessionId: string,
  overrides: Partial<ChatScheduledWorkRecord> = {},
): ChatScheduledWorkRecord {
  return {
    id: `wakeup:${sessionId}`,
    sessionId,
    kind: "wakeup",
    prompt: "Check PR CI and report the result.",
    reason: "Check PR CI",
    fireAt: Date.now() + 60_000,
    createdAt: Date.now(),
    status: "scheduled",
    pausedFlag: false,
    lateFlag: false,
    durable: false,
    ...overrides,
  };
}

function installClaudeWakeupFixture(args: {
  sdkSessionId: string;
  delaySeconds: number;
  prompt?: string;
  lingerAfterTurn?: Promise<void>;
}) {
  let streamCall = 0;
  const send = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  const handle = {
    send,
    stream: vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: args.sdkSessionId,
          slash_commands: [],
        };
        return;
      }
      yield {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: `tool-${args.sdkSessionId}`,
            name: "ScheduleWakeup",
            input: {
              delaySeconds: args.delaySeconds,
              reason: "Check PR CI",
              prompt: args.prompt ?? "Check PR CI and report the result.",
            },
          }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      const options = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      await options?.hooks?.PostToolUse?.[0]?.hooks[0]?.({
        hook_event_name: "PostToolUse",
        session_id: args.sdkSessionId,
        tool_name: "ScheduleWakeup",
        tool_use_id: `tool-${args.sdkSessionId}`,
        tool_input: {
          delaySeconds: args.delaySeconds,
          reason: "Check PR CI",
          prompt: args.prompt ?? "Check PR CI and report the result.",
        },
        tool_response: {
          scheduledFor: Date.now() + Math.max(60, args.delaySeconds) * 1_000,
          clampedDelaySeconds: Math.max(60, args.delaySeconds),
          wasClamped: args.delaySeconds < 60,
        },
      });
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: args.sdkSessionId,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (args.lingerAfterTurn) {
        await args.lingerAfterTurn;
      }
    })()),
    close,
    sessionId: args.sdkSessionId,
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(handle as any);
  vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(handle as any);
  return { handle, send, close };
}

function installClaudeResponseFixture(args: {
  sdkSessionId: string;
  responseText: string;
}) {
  let streamCall = 0;
  const send = vi.fn().mockResolvedValue(undefined);
  const handle = {
    send,
    stream: vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: args.sdkSessionId,
          slash_commands: [],
        };
        return;
      }
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: args.responseText }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: args.sdkSessionId,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })()),
    close: vi.fn(),
    sessionId: args.sdkSessionId,
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(handle as any);
  vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(handle as any);
  return { handle, send };
}

function createService(overrides: Record<string, unknown> = {}) {
  const logger = createLogger();
  const laneService = createMockLaneService();
  const sessionService = createMockSessionService();
  const projectConfigService = createMockProjectConfigService();
  const aiIntegrationService = {
    summarizeTerminal: vi.fn(async () => ({
      text: "",
      structuredOutput: null,
      provider: "claude",
      model: "anthropic/claude-haiku-4-5",
      sessionId: null,
      inputTokens: null,
      outputTokens: null,
      durationMs: 1,
    })),
    getMode: vi.fn(() => "subscription"),
  };
  const transcriptsDir = path.join(tmpRoot, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const service = createAgentChatService({
    projectRoot: tmpRoot,
    transcriptsDir,
    laneService,
    sessionService,
    projectConfigService,
    aiIntegrationService: aiIntegrationService as any,
    logger: logger as any,
    appVersion: "0.0.1-test",
    nativeTitleWaitMs: 0,
    getDirtyFileTextForPath: () => undefined,
    ...overrides,
  });

  return { service, logger, laneService, sessionService, projectConfigService, aiIntegrationService };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function installAutoTitleAuth(): void {
  // Auto-titling is skipped outright when no model is reachable.
  vi.mocked(detectAllAuth).mockResolvedValue([
    { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
  ] as never);
}

function installAutoTitleClaudeStream(): void {
  let streamCall = 0;
  vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
    send: vi.fn().mockResolvedValue(undefined),
    stream: vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield { type: "system", subtype: "init", session_id: "sdk-session-1", slash_commands: [] };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        return;
      }
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Done" }], usage: { input_tokens: 1, output_tokens: 1 } },
      };
      yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
    })()),
    close: vi.fn(),
    sessionId: "sdk-session-1",
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
  } as any);
}

const HANDOFF_TEST_SHA = "1234567890abcdef1234567890abcdef12345678";
const HANDOFF_BEHIND_SHA = "0123456789abcdef0123456789abcdef01234567";
const HANDOFF_DIVERGED_SHA = "fedcba9876543210fedcba9876543210fedcba98";

function installCleanCrossMachineGitFixture(
  branchRef = "feature/primary",
  porcelain = "",
  originUrl = "git@github.com:example/ade.git",
) {
  vi.mocked(runGit).mockImplementation(async (args) => {
    const command = args.join(" ");
    if (command === "status --porcelain=v1") return { stdout: porcelain, stderr: "", exitCode: 0 };
    if (command === "rev-parse HEAD") return { stdout: `${HANDOFF_TEST_SHA}\n`, stderr: "", exitCode: 0 };
    if (command === "rev-parse @{upstream}") return { stdout: `${HANDOFF_TEST_SHA}\n`, stderr: "", exitCode: 0 };
    if (command === "remote get-url origin") return { stdout: `${originUrl}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "ls-remote") return { stdout: `${HANDOFF_TEST_SHA}\trefs/heads/${branchRef}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "check-ref-format") return { stdout: `${branchRef}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "fetch") return { stdout: "", stderr: "", exitCode: 0 };
    if (command === `rev-parse refs/remotes/origin/${branchRef}`) return { stdout: `${HANDOFF_TEST_SHA}\n`, stderr: "", exitCode: 0 };
    if (command === `rev-parse --verify refs/heads/${branchRef}`) return { stdout: "", stderr: "", exitCode: 1 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

function installCrossMachineDestinationLaneGitFixture(options: {
  branchRef?: string;
  laneHead?: string;
  remoteHead?: string;
  dirtyPorcelain?: string;
  ancestorExitCode?: number;
  behindBy?: number;
  expectedReachable?: boolean;
  mergeExitCode?: number;
} = {}) {
  const branchRef = options.branchRef ?? "feature/primary";
  const laneHead = options.laneHead ?? HANDOFF_BEHIND_SHA;
  const remoteHead = options.remoteHead ?? HANDOFF_TEST_SHA;
  let merged = false;
  vi.mocked(runGit).mockImplementation(async (args) => {
    const command = args.join(" ");
    if (command === "status --porcelain=v1") {
      return { stdout: options.dirtyPorcelain ?? "", stderr: "", exitCode: 0 };
    }
    if (command === "rev-parse HEAD") {
      return { stdout: `${merged ? HANDOFF_TEST_SHA : laneHead}\n`, stderr: "", exitCode: 0 };
    }
    if (command === `rev-parse refs/remotes/origin/${branchRef}`) {
      return { stdout: `${remoteHead}\n`, stderr: "", exitCode: 0 };
    }
    if (command === `rev-parse --verify refs/heads/${branchRef}`) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    if (command === `cat-file -e ${HANDOFF_TEST_SHA}^{commit}`) {
      return {
        stdout: "",
        stderr: options.expectedReachable === false ? "missing commit" : "",
        exitCode: options.expectedReachable === false ? 1 : 0,
      };
    }
    if (command === `merge-base --is-ancestor ${laneHead} ${HANDOFF_TEST_SHA}`) {
      return { stdout: "", stderr: "", exitCode: options.ancestorExitCode ?? 0 };
    }
    if (command === `rev-list --count ${laneHead}..${HANDOFF_TEST_SHA}`) {
      return { stdout: `${options.behindBy ?? 3}\n`, stderr: "", exitCode: 0 };
    }
    if (command === `merge --ff-only ${HANDOFF_TEST_SHA}`) {
      const exitCode = options.mergeExitCode ?? 0;
      if (exitCode === 0) merged = true;
      return {
        stdout: exitCode === 0 ? "Fast-forward\n" : "",
        stderr: exitCode === 0 ? "" : "not possible to fast-forward",
        exitCode,
      };
    }
    if (args[0] === "ls-remote") {
      return { stdout: `${HANDOFF_TEST_SHA}\trefs/heads/${branchRef}\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "check-ref-format") return { stdout: `${branchRef}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "fetch") return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

function gzipForkContent(content: Buffer | string) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return {
    contentBase64Gzip: zlib.gzipSync(buffer).toString("base64"),
    uncompressedBytes: buffer.length,
  };
}

function makeForkCapsule(overrides: Partial<AgentChatCrossMachineHandoffCapsule> = {}): AgentChatCrossMachineHandoffCapsule {
  const mainContent = Buffer.from('{"type":"session_meta"}\n', "utf8");
  return {
    version: 1,
    handoffId: "handoff-fork-test-1",
    createdAt: "2026-07-10T12:00:00.000Z",
    source: {
      machineName: "Source Mac",
      sessionId: "source-session",
      provider: "claude",
      model: "claude-sonnet-5",
      title: "Fork handoff",
      laneName: "Feature lane",
      branchRef: "feature/handoff-fork",
      headSha: HANDOFF_TEST_SHA,
      originUrl: "https://github.com/example/ade.git",
    },
    target: { targetModelId: "anthropic/claude-sonnet-5" },
    brief: "Fork handoff — full conversation history transported.",
    artifacts: { fileChanges: [], commands: [], errors: [] },
    linearIssues: [],
    continuationPrompt: "This chat was handed off from another ADE machine. Continue the same task from the handoff brief, verify the destination workspace state, and keep working from the next open action.",
    mode: "fork",
    forkTransport: {
      provider: "claude",
      nativeSessionId: "claude-source-session",
      kind: "claude-jsonl",
      mainFile: {
        name: "claude-source-session.jsonl",
        ...gzipForkContent(mainContent),
      },
    },
    ...overrides,
  };
}

function installRealTranscriptParser(): void {
  vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
    raw.split(/\r?\n/).filter((line) => line.trim().length > 0).flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as AgentChatEventEnvelope;
        return parsed?.event ? [parsed] : [];
      } catch {
        return [];
      }
    }),
  );
}

function writeTestTranscriptEnvelopes(sessionId: string, envelopes: AgentChatEventEnvelope[]): void {
  const raw = `${envelopes.map((envelope) => JSON.stringify(envelope)).join("\n")}\n`;
  const legacyPath = mockState.sessions.get(sessionId)?.transcriptPath;
  if (legacyPath) {
    fs.mkdirSync(path.dirname(String(legacyPath)), { recursive: true });
    fs.writeFileSync(String(legacyPath), raw, "utf8");
  }
  const durablePath = path.join(tmpRoot, ".ade", "transcripts", "chat", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(durablePath), { recursive: true });
  fs.writeFileSync(durablePath, raw, "utf8");
}

function installCliCaptureMock(
  responseForArgs: (args: string[]) => { stdout: string | Buffer; stderr?: string; exitCode?: number },
): void {
  vi.mocked(spawn).mockImplementation(((_bin: string, args: string[]) => {
    const proc = new EventEmitter() as any;
    proc.stdin = { end: vi.fn(), write: vi.fn(), writable: true };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    proc.pid = 99_999;
    queueMicrotask(() => {
      const response = responseForArgs(args);
      if (response.stdout) proc.stdout.emit("data", response.stdout);
      if (response.stderr) proc.stderr.emit("data", response.stderr);
      proc.emit("close", response.exitCode ?? 0);
    });
    return proc;
  }) as any);
}

function readPersistedChatState(sessionId: string): Record<string, any> {
  return JSON.parse(
    fs.readFileSync(path.join(tmpRoot, ".ade", "cache", "chat-sessions", `${sessionId}.json`), "utf8"),
  ) as Record<string, any>;
}

function writePersistedChatState(sessionId: string, nextState: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(tmpRoot, ".ade", "cache", "chat-sessions", `${sessionId}.json`),
    JSON.stringify(nextState, null, 2),
    "utf8",
  );
}

/**
 * The setup every Claude approval test shares: one session whose stream never
 * yields, so the only state writes are the host's own. Returning `canUseTool`
 * (rather than raising a card here) lets each test drive its own asks.
 */
async function openClaudeApprovalHarness(sdkSessionId: string) {
  const events: AgentChatEventEnvelope[] = [];
  vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
    send: vi.fn().mockResolvedValue(undefined),
    stream: vi.fn(async function* () { return; }),
    close: vi.fn(),
    sessionId: sdkSessionId,
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
  } as any);

  const { service } = createService({
    onEvent: (event: AgentChatEventEnvelope) => events.push(event),
  });
  const session = await service.createSession({
    laneId: "lane-1",
    provider: "claude",
    model: "sonnet",
  });
  await vi.waitFor(() => { expect(claudeSdkCreateSessionCompat).toHaveBeenCalled(); });

  const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
    canUseTool?: (
      tool: string,
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  } | undefined;

  return { service, session, events, opts };
}

async function waitForEvent<T extends AgentChatEventEnvelope>(
  events: AgentChatEventEnvelope[],
  predicate: (event: AgentChatEventEnvelope) => event is T,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = events.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for agent chat event.");
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForFakeTimerCondition(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const timeoutMs = 10_000;
  for (let elapsedMs = 0; elapsedMs < timeoutMs; elapsedMs += 1) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
  }
  if (predicate()) return;
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}.`);
}

async function waitForFakeTimerPromise<T>(
  promise: Promise<T>,
  description: string,
): Promise<T> {
  let settled = false;
  const trackedPromise = promise.finally(() => { settled = true; });
  void trackedPromise.catch(() => undefined);
  await waitForFakeTimerCondition(() => settled, description);
  return trackedPromise;
}

async function createClaudeStreamFixture(args: {
  sdkSessionId: string;
  messages: Array<Record<string, unknown>>;
  getContextUsage?: (options?: unknown) => Promise<unknown>;
  initializationResult?: () => Promise<unknown>;
  serviceOverrides?: Record<string, unknown>;
}) {
  const events: AgentChatEventEnvelope[] = [];
  const setPermissionMode = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue(undefined);
  let streamCall = 0;

  const stream = vi.fn(() => (async function* () {
    streamCall += 1;
    if (streamCall === 1) {
      yield {
        type: "system",
        subtype: "init",
        session_id: args.sdkSessionId,
        slash_commands: [],
      };
      return;
    }

    for (const message of args.messages) {
      yield message;
    }
  })());

  vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
    send,
    stream,
    close: vi.fn(),
    sessionId: args.sdkSessionId,
    setPermissionMode,
    ...(args.getContextUsage ? { getContextUsage: args.getContextUsage } : {}),
    ...(args.initializationResult ? { initializationResult: args.initializationResult } : {}),
  } as any);

  const harness = createService({
    onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    ...args.serviceOverrides,
  });
  const { service } = harness;
  const session = await service.createSession({
    laneId: "lane-1",
    provider: "claude",
    model: "claude-sonnet-5",
    modelId: "anthropic/claude-sonnet-5",
  });

  await service.runSessionTurn({
    sessionId: session.id,
    text: "Exercise Claude streaming text.",
  });

  return { ...harness, events, session, send };
}

/**
 * A usage ledger whose rows stay in memory, so a test reads exactly what the
 * chat service settled without the month-file reader.
 */
function createMemoryTurnUsageLedger() {
  const rows: AdeTurnUsageRecord[] = [];
  const store = {
    dir: "/memory/usage",
    appendTurn: (record: AdeTurnUsageRecord) => { rows.push(record); },
    amendTurn: () => {},
    appendQuotaSample: () => {},
    readTurns: async () => rows,
    readQuotaSamples: async () => [],
    readQuotaSamplesSync: () => [],
  } as unknown as TurnUsageLedgerStore;
  return { ledger: createTurnUsageLedger({ store }), rows };
}

/**
 * Claude fixture that withholds the provider's answer to `/compact` until ADE
 * has actually sent it. Yielding both results up front lets the turn's own
 * post-result drain swallow the second one, which is not how the SDK behaves.
 */
async function createClaudeCompactionFixture(args: {
  sdkSessionId: string;
  first: Array<Record<string, unknown>>;
  afterCompact: Array<Record<string, unknown>>;
}) {
  const events: AgentChatEventEnvelope[] = [];
  const setPermissionMode = vi.fn().mockResolvedValue(undefined);
  let resolveCompactSent: () => void = () => {};
  const compactSent = new Promise<void>((resolve) => { resolveCompactSent = resolve; });
  const send = vi.fn(async (message: unknown) => {
    if (claudeInputText(message) === "/compact") resolveCompactSent();
  });
  let streamCall = 0;

  const stream = vi.fn(() => (async function* () {
    streamCall += 1;
    if (streamCall === 1) {
      yield {
        type: "system",
        subtype: "init",
        session_id: args.sdkSessionId,
        slash_commands: [],
      };
      return;
    }
    for (const message of args.first) yield message;
    await compactSent;
    for (const message of args.afterCompact) yield message;
  })());

  vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
    send,
    stream,
    close: vi.fn(),
    sessionId: args.sdkSessionId,
    setPermissionMode,
  } as any);

  const harness = createService({
    onEvent: (event: AgentChatEventEnvelope) => events.push(event),
  });
  const { service } = harness;
  const session = await service.createSession({
    laneId: "lane-1",
    provider: "claude",
    model: "claude-sonnet-5",
    modelId: "anthropic/claude-sonnet-5",
  });

  await service.runSessionTurn({
    sessionId: session.id,
    text: "Exercise Claude streaming text.",
  });

  return { ...harness, events, session, send };
}

function claudeNoticeMessages(events: AgentChatEventEnvelope[]): string[] {
  return events.flatMap((entry) => entry.event.type === "system_notice"
    ? [entry.event.message]
    : []);
}

async function runClaudeStreamFixture(args: {
  sdkSessionId: string;
  messages: Array<Record<string, unknown>>;
}): Promise<AgentChatEventEnvelope[]> {
  return (await createClaudeStreamFixture(args)).events;
}

function claudeInputText(message: unknown): string {
  if (typeof message === "string") return message;
  const content = (message as { message?: { content?: unknown } } | null)?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => typeof block === "string"
      ? block
      : typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string"
        ? String((block as { text: string }).text)
        : "")
    .join("");
}

async function settleDirectiveBookkeeping(): Promise<void> {
  // `runSessionTurn`'s collector resolves on the turn's `done` event, which is
  // emitted inside the provider run; the directive keys are marked when that run
  // returns. A macrotask yield lets the run's promise chain finish so the next
  // send sees the marked key. Not a wall-clock wait — nothing is being timed.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForSessionTitle(sessionService: ReturnType<typeof createMockSessionService>, sessionId: string, title: string): Promise<void> {
  await vi.waitFor(() => {
    expect(sessionService.get(sessionId)?.title).toBe(title);
  }, { timeout: 1_000 });
}

function makeLaneLinearIssue(overrides: Partial<LaneLinearIssue> = {}): LaneLinearIssue {
  return {
    id: "issue-1",
    identifier: "ADE-123",
    title: "Attach Linear context to chat",
    description: "Use this issue as prompt context.",
    url: "https://linear.app/ade/issue/ADE-123/attach-linear-context-to-chat",
    projectId: "project-1",
    projectSlug: "ade",
    projectName: "ADE",
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: ["desktop"],
    assigneeId: "user-1",
    assigneeName: "Arul",
    creatorId: "user-2",
    creatorName: "Annie",
    dueDate: null,
    estimate: null,
    branchName: "ade-123-attach-linear-context-to-chat",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-svc-home-"));
  tmpRoot = path.join(tmpHomeRoot, "project");
  fs.mkdirSync(tmpRoot, { recursive: true });
  // Ensure .ade directories exist
  fs.mkdirSync(path.join(tmpRoot, ".ade", "cache", "chat-sessions"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, ".ade", "transcripts", "chat"), { recursive: true });
  // Pin os.homedir() to an isolated temp root so user-scope slash command discovery
  // (~/.claude/commands, ~/.codex/prompts) doesn't leak the developer's real
  // home dir into tests, while project-local .claude roots remain distinct.
  vi.spyOn(os, "homedir").mockReturnValue(tmpHomeRoot);
  mockState.generation += 1;
  turnDiffMockState.beforeTreeGates = [];
  turnDiffMockState.collectSummary = null;
  mockState.sessions.clear();
  mockState.sessionLinearLinks.clear();
  mockState.uuidCounter = 0;
  mockState.mcpServerCounter = 0;
  mockState.codexThreadCounter = 0;
  mockState.codexTurnCounter = 0;
  mockState.openCodeSessionCounter = 0;
  mockState.openCodeForkCalls = [];
  mockState.openCodeSessions.clear();
  mockState.openCodePromptAsyncBarrier = null;
  mockState.openCodeV2SteerCalls = [];
  mockState.openCodeV2SteerError = null;
  mockState.openCodeV2SteerBarrier = null;
  mockState.openCodeTitleForNextPrompt = null;
  mockState.openCodeQuestionForNextPrompt = null;
  mockState.droidSessionCounter = 0;
  mockState.codexRequestPayloads = [];
  mockState.codexResponseOverrides.clear();
  mockState.delayedCodexMethods.clear();
  mockState.pendingCodexResponses = [];
  mockState.codexCollaborationModes = [{ mode: "default" }, { mode: "plan" }];
  mockState.codexLineHandler = null;
  mockState.cursorSdkAcquireCalls = [];
  mockState.cursorSdkSendCalls = [];
  mockState.cursorSdkPolicyUpdates = [];
  mockState.cursorSdkPooled = null;
  mockState.cursorSdkSteerCalls = [];
  mockState.cursorSteerOutcome = "complete_delivered";
  mockState.cursorSteerError = null;
  mockState.onCursorSteer = null;
  mockState.releaseCursorSteer = null;
  mockState.cursorSteerParks = [];
  mockState.cursorSteerGate = null;
  mockState.cursorSdkAgentIdForNextAcquire = null;
  mockState.cursorSdkCloudRequests = [];
  mockState.turnUsageFollowUps = [];
  mockState.piAcquire = null;
  mockState.piInstallation = null;
  mockState.cursorSdkCloudResponses = new Map<string, unknown>();
  mockState.releaseCursorSendPrompt = null;
  mockState.cursorSendParks = [];
  mockState.cursorSendPromptGate = null;
  mockState.cursorSendPromptError = null;
  mockState.cursorSendPromptResult = null;
  mockState.onCursorSendPrompt = null;
  mockState.cursorAcquireErrorOnCall = null;
  mockState.cursorSdkPoisonCalls = [];
  mockState.onCursorCancel = null;
  mockState.droidAcquireCalls = [];
  mockState.droidNewSessionCalls = [];
  mockState.droidPromptCalls = [];
  mockState.droidSettingsUpdates = [];
  mockState.droidPooled = null;
  mockState.droidPromptGate = null;
  mockState.droidPromptError = null;
  cursorModelsListMock.mockReset();
  vi.mocked(startOpenCodeSession).mockClear();
  vi.mocked(resolveOpenCodeExecutablePath).mockReset();
  vi.mocked(resolveOpenCodeExecutablePath).mockReturnValue("/usr/local/bin/opencode");
  vi.mocked(buildOpenCodePromptParts).mockClear();
  vi.mocked(acquireCursorSdkConnection).mockClear();
  vi.mocked(releaseCursorSdkConnection).mockClear();
  vi.mocked(acquireDroidSdkConnection).mockClear();
  vi.mocked(streamText).mockReset();
  vi.mocked(claudeSdkCreateSessionCompat).mockReset();
  vi.mocked(claudeSdkResumeSessionCompat).mockReset();
  vi.mocked(query).mockReset();
  vi.mocked(startup).mockReset();
  vi.mocked(getSessionMessages).mockReset();
  vi.mocked(getSessionMessages).mockResolvedValue([]);
  vi.mocked(getSubagentMessages).mockReset();
  vi.mocked(getSubagentMessages).mockResolvedValue([]);
  vi.mocked(tagSession).mockClear();
  installClaudeSdkCompatMocks();
  vi.mocked(resolveClaudeCodeExecutable).mockClear();
  vi.mocked(resolveClaudeCodeExecutable).mockReturnValue({ path: "/usr/local/bin/claude", source: "path" });
  vi.mocked(detectAllAuth).mockResolvedValue([]);
  vi.mocked(parseAgentChatTranscript).mockReturnValue([]);
  vi.mocked(clearOpenCodeInventoryCache).mockClear();
  clearCursorCliModelsCache();
  // No test reaches Cursor's API. A Cursor send loads the model catalog when
  // the chat names an effort, and a catalog the mocked SDK cannot list falls
  // back to api.cursor.com; a real request there made those tests depend on
  // the network. `vi.restoreAllMocks()` in afterEach puts `fetch` back.
  const passThroughFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^https:\/\/api\.cursor\.com\//u.test(url)) throw new Error("Tests do not reach Cursor's API.");
    return passThroughFetch(input, init);
  });
  vi.mocked(peekOpenCodeInventoryCache).mockReset();
  vi.mocked(peekOpenCodeInventoryCache).mockReturnValue(null);
  vi.mocked(probeOpenCodeProviderInventory).mockReset();
  vi.mocked(probeOpenCodeProviderInventory).mockResolvedValue({
    modelIds: ["opencode/openai/gpt-5.4"],
    providers: [],
    error: null,
    descriptors: [],
  });
  replaceDynamicOpenCodeModelDescriptors([]);
});

afterEach(async () => {
  // Never-resolving send/steer parks from a stalled Cursor turn must settle
  // here. Nulling the gate ref does not unblock an in-flight `await` of the
  // old promise, which left later tests (the durable-metadata compaction case
  // in particular) hanging until Vitest's 20s `testTimeout`.
  //
  // Restore the real clock first so the drained send settles on the real
  // event loop. Releasing a park while fake timers are still installed lets
  // the turn's success/fail tail run on a warped clock and leak into the
  // next test (the recycle-copy cancel notice becomes "turn failed").
  vi.useRealTimers();
  mockState.cursorSendPromptError = null;
  mockState.cursorSteerError = null;
  mockState.cursorSteerOutcome = "complete_delivered";
  mockState.releaseCursorSendPrompt?.();
  mockState.releaseCursorSteer?.();
  await new Promise<void>((resolve) => { pumpRealSetImmediate(resolve); });
  await new Promise<void>((resolve) => { pumpRealSetImmediate(resolve); });
  await Promise.resolve();
  mockState.onCursorSendPrompt = null;
  mockState.onCursorCancel = null;
  mockState.droidPromptError = null;
  vi.restoreAllMocks();
  // `vi.restoreAllMocks()` does not reset factory-created `vi.fn` mocks.
  // Reinstall the default so mode-specific approval tests cannot leak it.
  vi.mocked(mapPermissionToCodex).mockImplementation(() => ({
    approvalPolicy: "on-request",
    sandbox: "read-only",
  } as const));
  if (ORIGINAL_CURSOR_API_KEY === undefined) {
    delete process.env.CURSOR_API_KEY;
  } else {
    process.env.CURSOR_API_KEY = ORIGINAL_CURSOR_API_KEY;
  }
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
  if (ORIGINAL_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
  try {
    fs.rmSync(tmpHomeRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
});


const CURSOR_SILENCE_WATCHDOG_TRIP_MS = CURSOR_SDK_FIRST_EVENT_WATCHDOG_MS + 1;

/**
 * Recycle races `cancel()` against a 3s timeout. Advancing only the 90s
 * watchdog schedules that timer; it does not flush it. Nested timers created
 * during the watchdog callback are not included in the same advance.
 */
const flushCursorSdkSilenceRecycle = async (): Promise<void> => {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(CURSOR_SDK_RECYCLE_CANCEL_TIMEOUT_MS);
  await Promise.resolve();
};

const tripCursorSdkSilenceWatchAndRecycle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(CURSOR_SILENCE_WATCHDOG_TRIP_MS);
  await flushCursorSdkSilenceRecycle();
};

/**
 * Real wall clock and a real event-loop yield, captured before any test can
 * install fake timers. `vi.useFakeTimers()` replaces the global `Date` and
 * `setImmediate`, so a faked test that measures elapsed time or waits for the
 * poll phase has to hold the originals.
 */
const pumpRealNow = Date.now.bind(Date);
const pumpRealSetImmediate = globalThis.setImmediate;

/**
 * How long `pumpUntil` waits in REAL time. The work it waits on is genuinely
 * async — fs reads for the injected Cursor system prompt, sqlite persistence —
 * so the budget has to be wall-clock. An iteration count is not a budget: with
 * no fake timer pending, one iteration costs microseconds, so a loaded runner
 * burns the whole thing while the very first read is still queued behind the
 * libuv pool. Locally the slowest wait in this file converges in 11 iterations.
 */
const PUMP_REAL_BUDGET_MS = 5_000;
/**
 * Fake-clock advancing stays capped by iteration so 1ms-per-tick pumping can
 * never drift the virtual clock into the 90s silence watchdog by itself.
 */
const PUMP_FAKE_TICK_BUDGET = 800;
/** Real stall time before `pumpUntil` starts tripping the silence watchdog. */
const PUMP_WATCHDOG_STALL_MS = 1_000;

/**
 * Real async setup work still needs event-loop turns while the clock is faked,
 * so pump the fake clock instead of assuming a fixed number of ticks.
 *
 * Do not trip the silence watchdog while flushing that setup. On a slow
 * runner, jumping 90s during `first cursor send` recycled the turn before
 * the test queued its steer, and the later recovery wait timed out.
 */
const pumpUntil = async (label: string, ready: () => boolean): Promise<void> => {
  const startedAt = pumpRealNow();
  // A silence-watchdog recycle can arm the next attempt's timer after the first
  // 90s jump, so extra trips stay available — but keyed off real stall time
  // rather than a tick index. Tripping on a tick index recycles the runtime
  // whose recovery this is waiting for whenever the loop spins faster than the
  // pending I/O completes, which is exactly what a loaded runner does.
  let nextWatchdogTripAt = startedAt + PUMP_WATCHDOG_STALL_MS;
  let fakeTicksLeft = PUMP_FAKE_TICK_BUDGET;
  while (!ready() && pumpRealNow() - startedAt < PUMP_REAL_BUDGET_MS) {
    if (pumpRealNow() >= nextWatchdogTripAt) {
      nextWatchdogTripAt = pumpRealNow() + PUMP_WATCHDOG_STALL_MS;
      await vi.advanceTimersByTimeAsync(CURSOR_SILENCE_WATCHDOG_TRIP_MS);
      await flushCursorSdkSilenceRecycle();
    } else if (fakeTicksLeft > 0) {
      fakeTicksLeft -= 1;
      await vi.advanceTimersByTimeAsync(1);
    } else {
      // Fake budget spent: keep handing the real event loop turns so pending
      // fs/sqlite callbacks can still land, without moving the virtual clock.
      await new Promise<void>((resolve) => { pumpRealSetImmediate(resolve); });
    }
    await Promise.resolve();
  }
  if (!ready()) throw new Error(`pumpUntil timed out waiting for: ${label}`);
};


export {
  CLAUDE_MUTATING_BUILTIN_TOOLS,
  CLAUDE_READ_ONLY_TOOLS,
  CODEX_REPLAY_MAX_CHARS,
  CROSS_PROVIDER_REPLAY_HEADER,
  CURSOR_SDK_FIRST_EVENT_WATCHDOG_MS,
  CURSOR_SDK_RECYCLE_CANCEL_TIMEOUT_MS,
  CURSOR_SILENCE_WATCHDOG_TRIP_MS,
  EventEmitter,
  HANDOFF_BEHIND_SHA,
  HANDOFF_DIVERGED_SHA,
  HANDOFF_TEST_SHA,
  HOST_TOOL_APPROVAL_NAMES,
  ORIGINAL_CLAUDE_CONFIG_DIR,
  ORIGINAL_CODEX_HOME,
  ORIGINAL_CURSOR_API_KEY,
  PTY_SEND_PRE_DELIVERY_ERROR_CODE,
  PUMP_FAKE_TICK_BUDGET,
  PUMP_REAL_BUDGET_MS,
  PUMP_WATCHDOG_STALL_MS,
  SCHEDULED_WORK_STATE_KEY,
  SCHEDULE_TEST_START,
  SESSION_STALE_AFTER_MS,
  SessionTurnAbandonedError,
  acquireCursorSdkConnection,
  acquireDroidSdkConnection,
  beginClaudeStartupWarmup,
  beginIdentityConfirmHold,
  bridgeClaudeSessionToQuery,
  buildCodingAgentSystemPrompt,
  buildComputerUseDirective,
  buildLaneAppleDeviceDirective,
  buildLinearSessionDirective,
  buildOpenCodePromptParts,
  buildOpenCodeStreamMessages,
  claudeInputText,
  claudeNoticeMessages,
  claudeSdkCreateSessionCompat,
  claudeSdkResumeSessionCompat,
  claudeSdkSession,
  clearCursorCliModelsCache,
  clearOpenCodeInventoryCache,
  codexComputerUseClientCandidates,
  codexServerSupportsForkBeforeTurn,
  computerUseDirectiveFingerprint,
  createAcpRuntime,
  createAcpSessionPool,
  createAgentChatService,
  createChatRuntimeBudget,
  createClaudeCompactionFixture,
  createClaudeStreamFixture,
  createCtoMemoryService,
  createCtoStateService,
  createDynamicOpenCodeModelDescriptor,
  createDynamicPiModelDescriptor,
  createHash,
  createLaneAppleDeviceLookup,
  createLogger,
  createMemoryTurnUsageLedger,
  createMockAcpAgent,
  createMockLaneService,
  createMockProjectConfigService,
  createMockSessionService,
  createScheduledWorkDb,
  createSdkMcpServer,
  createService,
  createTurnUsageLedger,
  createTurnUsageLedgerStore,
  cursorModelsListMock,
  deriveScheduledWorkSnapshots,
  detectAllAuth,
  detectCliAuthStatuses,
  enforceCrossMachineForkEncodedBudget,
  flushCursorSdkSilenceRecycle,
  fs,
  getDefaultModelDescriptor,
  getDynamicAcpModelDescriptors,
  getModelById,
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  gunzipFromBase64,
  gzipForkContent,
  gzipSync,
  injectFsFault,
  installAutoTitleAuth,
  installAutoTitleClaudeStream,
  installClaudeResponseFixture,
  installClaudeSdkCompatMocks,
  installClaudeWakeupFixture,
  installCleanCrossMachineGitFixture,
  installCliCaptureMock,
  installCrossMachineDestinationLaneGitFixture,
  installRealTranscriptParser,
  isQuestionShapedPendingInput,
  legacyClaudeSendPayload,
  loadExternalSessionEvents,
  loadQwenUserSettings,
  makeDefaultClaudeSession,
  makeForkCapsule,
  makeLaneLinearIssue,
  makeLinearIssueContextAttachment,
  mapPermissionToClaude,
  mapPermissionToCodex,
  mockState,
  openClaudeApprovalHarness,
  openCodeEventStream,
  openKvDb,
  os,
  parkCursorSend,
  parkCursorSteer,
  parseAgentChatTranscript,
  parseCodexServerVersion,
  path,
  peekOpenCodeInventoryCache,
  probeCursorSdkModelDiscovery,
  probeOpenCodeProviderInventory,
  pumpRealNow,
  pumpRealSetImmediate,
  pumpUntil,
  query,
  readPendingInputRecord,
  readPersistedChatState,
  readThreadPointerLedger,
  realSetImmediate,
  releaseCursorSdkConnection,
  renameSession,
  replaceDynamicOpenCodeModelDescriptors,
  replaceDynamicPiModelDescriptors,
  resolveBuiltInBrowserActorCapability,
  resolveClaudeCodeExecutable,
  resolveLaneAppleDeviceDirective,
  resolveOpenCodeExecutablePath,
  respondWithSession,
  restartRecoveryStopAttribution,
  runClaudeStreamFixture,
  runGit,
  settleDirectiveBookkeeping,
  spawn,
  stableStringify,
  startOpenCodeSession,
  startup,
  storedWakeup,
  streamText,
  tagSession,
  tmpHomeRoot,
  tmpRoot,
  tripCursorSdkSilenceWatchAndRecycle,
  turnDiffMockState,
  usingFakeTimers,
  waitFor,
  waitForCondition,
  waitForEvent,
  waitForFakeTimerCondition,
  waitForFakeTimerPromise,
  waitForFakeTimers,
  waitForSessionTitle,
  writePersistedChatState,
  writeSessionLinearIssueContextFile,
  writeTestTranscriptEnvelopes,
  zlib,
};
export type {
  AcpHostModule,
  AcpSession,
  AcpSessionUpdate,
  AdeTurnUsageRecord,
  AgentChatCreateArgs,
  AgentChatCreateScheduledWorkArgs,
  AgentChatCrossMachineHandoffCapsule,
  AgentChatEventEnvelope,
  BrowserActorCapabilityIssuer,
  ChatScheduledWorkRecord,
  ChatScheduledWorkState,
  ComputerUseBackendStatus,
  LaneLinearIssue,
  MockAcpAgent,
  PendingInputRequest,
  PiInstallationModule,
  PiSdkPoolModule,
  TurnUsageLedgerStore,
  TurnUsageReconcilersModule,
};
