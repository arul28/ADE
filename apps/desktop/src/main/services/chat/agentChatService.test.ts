import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { getSessionInfo, getSessionMessages, query, startup, tagSession } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { codexComputerUseClientCandidates } from "../../utils/codexComputerUse";
import { buildOpenCodePromptParts, startOpenCodeSession } from "../opencode/openCodeRuntime";
import { openKvDb } from "../state/kvDb";
import { createCtoStateService } from "../cto/ctoStateService";
import { createCtoMemoryService } from "../cto/ctoMemoryService";
import {
  clearOpenCodeInventoryCache,
  peekOpenCodeInventoryCache,
  probeOpenCodeProviderInventory,
} from "../opencode/openCodeInventory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamText = vi.fn();
const claudeSdkCreateSessionCompat = vi.hoisted(() => vi.fn());
const claudeSdkResumeSessionCompat = vi.hoisted(() => vi.fn());
const cursorModelsListMock = vi.hoisted(() => vi.fn());
const ORIGINAL_CURSOR_API_KEY = process.env.CURSOR_API_KEY;

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
  sessions: new Map<string, any>(),
  sessionLinearLinks: new Map<string, any[]>(),
  uuidCounter: 0,
  mcpServerCounter: 0,
  codexThreadCounter: 0,
  codexTurnCounter: 0,
  openCodeSessionCounter: 0,
  openCodeSessions: new Map<string, {
    events: any[];
    waiters: Array<() => void>;
    aborted: boolean;
    promptBodies: any[];
    questionReply: ReturnType<typeof vi.fn>;
    questionReject: ReturnType<typeof vi.fn>;
    permissionReply: ReturnType<typeof vi.fn>;
  }>(),
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
  cursorSdkAgentIdForNextAcquire: null as string | null,
  cursorSdkCloudRequests: [] as Array<{ type: string; payload: Record<string, unknown> }>,
  cursorSdkCloudResponses: new Map<string, unknown>(),
  cursorSendPromptGate: null as Promise<void> | null,
  cursorSendPromptError: null as unknown,
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
}));

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
          } else if (payload.method === "account/rateLimits/read") {
            result = { rateLimits: { remaining: 10, limit: 100, resetAt: null } };
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
  createSdkMcpServer: vi.fn((config: any) => ({
    type: "sdk",
    name: config?.name,
    instance: {
      _registeredTools: Object.fromEntries((config?.tools ?? []).map((entry: any) => [entry.name, entry])),
    },
  })),
  getSessionInfo: vi.fn(),
  getSessionMessages: vi.fn(),
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

vi.mock("@factory/droid-sdk", () => ({
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

vi.mock("../opencode/openCodeRuntime", () => ({
  buildOpenCodePromptParts: vi.fn(({ prompt, files = [] }: { prompt: string; files?: Array<Record<string, unknown>> }) => [
    { type: "text", text: prompt },
    ...files,
  ]),
  refreshOpenCodeSessionToolSelection: vi.fn(async () => null),
  mapPermissionModeToOpenCodeAgent: vi.fn((mode: string) => {
    if (mode === "plan") return "ade-plan";
    if (mode === "full-auto") return "ade-full-auto";
    return "ade-edit";
  }),
  resolveOpenCodeModelSelection: vi.fn((descriptor: Record<string, unknown>) => ({
    providerID: String(descriptor.family ?? "openai"),
    modelID: String(descriptor.providerModelId ?? descriptor.id ?? "model"),
  })),
  startOpenCodeSession: vi.fn(async (args: { directory: string }) => {
    mockState.openCodeSessionCounter += 1;
    const sessionId = `opencode-session-${mockState.openCodeSessionCounter}`;
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
      session: {
        promptAsync: vi.fn(async ({ body }: { body?: any } = {}) => {
          state.promptBodies.push(body ?? {});
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
            let text = "";
            for await (const part of result.fullStream ?? []) {
              if (state.aborted) break;
              if (part.type === "start-step") {
                pushEvent({
                  type: "message.part.updated",
                  properties: {
                    part: { id: `step-${sessionId}`, sessionID: sessionId, type: "step-start" },
                    delta: "",
                  },
                });
                continue;
              }
              if (part.type === "text-delta") {
                text += String(part.textDelta ?? "");
                pushEvent({
                  type: "message.part.updated",
                  properties: {
                    part: { id: `text-${sessionId}`, sessionID: sessionId, type: "text", text },
                    delta: String(part.textDelta ?? ""),
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
                    delta: "",
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
                    delta: "",
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
                    delta: "",
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
        abort: vi.fn(async ({ path }: { path: { id: string } }) => {
          if (path.id !== sessionId) return;
          state.aborted = true;
          pushEvent({
            type: "session.idle",
            properties: { sessionID: sessionId },
          });
        }),
      },
      postSessionIdPermissionsPermissionId: vi.fn(async ({ path, body }: { path: { id: string; permissionID: string }; body: { response: string } }) => {
        pushEvent({
          type: "permission.replied",
          properties: {
            sessionID: path.id,
            permissionID: path.permissionID,
            response: body.response,
          },
        });
      }),
      v2Client: {
        question: {
          reply: state.questionReply,
          reject: state.questionReject,
        },
        permission: {
          reply: state.permissionReply,
        },
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
      v2Client: client.v2Client,
    };
  }),
  openCodeEventStream: vi.fn(async ({ client }: { client: { __sessionId?: string } }) => {
    const state = client.__sessionId ? mockState.openCodeSessions.get(client.__sessionId) : undefined;
    if (!state) {
      return (async function* () {})();
    }
    return (async function* () {
      while (true) {
        if (state.events.length > 0) {
          yield state.events.shift();
          continue;
        }
        if (state.aborted) return;
        await new Promise<void>((resolve) => state.waiters.push(resolve));
      }
    })();
  }),
}));

vi.mock("../opencode/openCodeInventory", () => ({
  clearOpenCodeInventoryCache: vi.fn(),
  shutdownInventoryServer: vi.fn(),
  peekOpenCodeInventoryCache: vi.fn(() => null),
  probeOpenCodeProviderInventory: vi.fn(async () => ({
    modelIds: ["opencode/openai/gpt-5.4"],
    catalogModelIds: ["opencode/openai/gpt-5.4"],
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

vi.mock("../ai/tools/workflowTools", () => ({
  createWorkflowTools: vi.fn(() => []),
}));

vi.mock("../ai/tools/linearTools", () => ({
  createLinearTools: vi.fn(() => []),
}));

vi.mock("../ai/tools/ctoOperatorTools", () => ({
  createCtoOperatorTools: vi.fn(() => []),
}));

vi.mock("../ai/tools/systemPrompt", () => ({
  buildCodingAgentSystemPrompt: vi.fn(() => "system prompt"),
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

vi.mock("../ai/authDetector", () => ({
  detectAllAuth: vi.fn(async () => []),
}));

vi.mock("../ai/localModelDiscovery", () => ({}));

vi.mock("../git/git", () => ({
  runGit: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
}));

vi.mock("../orchestrator/providerOrchestratorAdapter", () => ({
  resolveOpenCodeRuntimeRoot: vi.fn(() => process.cwd()),
}));

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
    mockState.cursorSdkAcquireCalls.push(args);
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
        mockState.cursorSdkSendCalls.push(payload);
        if (mockState.cursorSendPromptGate) await mockState.cursorSendPromptGate;
        if (mockState.cursorSendPromptError) throw mockState.cursorSendPromptError;
        return { id: "cursor-sdk-run-1", status: "finished" };
      }),
      updatePolicy: vi.fn(async (policy: Record<string, unknown>) => {
        mockState.cursorSdkPolicyUpdates.push(policy);
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    mockState.cursorSdkPooled = pooled;
    return { generation: 1, pooled };
  }),
  releaseCursorSdkConnection: vi.fn(),
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
      request: vi.fn(async () => null),
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

// ---------------------------------------------------------------------------
// Import system under test (after mocks)
// ---------------------------------------------------------------------------
import {
  buildOpenCodeStreamMessages,
  buildComputerUseDirective,
  buildLinearSessionDirective,
  writeSessionLinearIssueContextFile,
  createAgentChatService,
} from "./agentChatService";
import { spawn } from "node:child_process";
import { detectAllAuth } from "../ai/authDetector";
import { buildCodingAgentSystemPrompt } from "../ai/tools/systemPrompt";
import { createOrchestrationService } from "../orchestration/orchestrationService";
import { runGit } from "../git/git";
import { deriveScheduledWorkSnapshots } from "../../../shared/chatScheduledWork";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import type { ChatScheduledWorkRecord, ChatScheduledWorkState } from "./chatScheduledWorkScheduler";
import { mapPermissionToCodex } from "./permissionMapping";
import { acquireCursorSdkConnection, releaseCursorSdkConnection } from "./cursorSdkPool";
import { acquireDroidSdkConnection } from "./droidSdkPool";
import { clearCursorCliModelsCache } from "./cursorModelsDiscovery";
import type { AgentChatEventEnvelope, ComputerUseBackendStatus, LaneLinearIssue, PendingInputRequest } from "../../../shared/types";
import { makeLinearIssueContextAttachment } from "../../../shared/chatContextAttachments";
import {
  createDynamicOpenCodeModelDescriptor,
  replaceDynamicOpenCodeModelDescriptors,
} from "../../../shared/modelRegistry";

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
    message?: { content?: Array<Record<string, unknown>> };
  };
  if (record.type !== "user") {
    return message;
  }
  if (record.shouldQuery === false) {
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
    stopTask: vi.fn(async (taskId: string) => {
      if (typeof session.stopTask === "function") {
        return session.stopTask(taskId);
      }
      if (typeof session.query?.stopTask === "function") {
        return session.query.stopTask(taskId);
      }
      return undefined;
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
    getContextUsage: vi.fn(async () => {
      if (typeof session.getContextUsage === "function") {
        return session.getContextUsage();
      }
      if (typeof session.query?.getContextUsage === "function") {
        return session.query.getContextUsage();
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
    { id: "lane-1", name: "Primary", laneType: "primary", branchRef: "feature/primary", worktreePath: laneRoots["lane-1"] },
    { id: "lane-2", name: "Selected", laneType: "feature", branchRef: "feature/selected", worktreePath: laneRoots["lane-2"] },
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
      return {
        baseRef: "main",
        branchRef: "feature/selected",
        worktreePath: tmpRoot,
        laneType: "feature",
      };
    }),
    list: vi.fn(async () => lanes),
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
    setHeadShaStart: vi.fn(),
    setHeadShaEnd: vi.fn(),
    setLastOutputPreview: vi.fn(),
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
    ...overrides,
  };
}

function installClaudeWakeupFixture(args: {
  sdkSessionId: string;
  delaySeconds: number;
  prompt?: string;
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
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: args.sdkSessionId,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
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
      text: "Generated session intelligence",
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
    getDirtyFileTextForPath: () => undefined,
    ...overrides,
  });

  return { service, logger, laneService, sessionService, projectConfigService, aiIntegrationService };
}

async function createLoadedOrchestrationRun(leadSessionId = "S-lead") {
  const orchestrationService = createOrchestrationService({
    resolveLaneWorktree: () => tmpRoot,
  });
  const created = await orchestrationService.runCreate({
    laneId: "lane-1",
    leadSessionId,
    bundleRoot: tmpRoot,
    title: "test orchestration",
    goalSummary: "orchestrate the work",
  });
  return { orchestrationService, created };
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

async function runClaudeStreamFixture(args: {
  sdkSessionId: string;
  messages: Array<Record<string, unknown>>;
}): Promise<AgentChatEventEnvelope[]> {
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
  } as any);

  const { service } = createService({
    onEvent: (event: AgentChatEventEnvelope) => events.push(event),
  });
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

  return events;
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
  mockState.sessions.clear();
  mockState.sessionLinearLinks.clear();
  mockState.uuidCounter = 0;
  mockState.mcpServerCounter = 0;
  mockState.codexThreadCounter = 0;
  mockState.codexTurnCounter = 0;
  mockState.openCodeSessionCounter = 0;
  mockState.openCodeSessions.clear();
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
  mockState.cursorSdkAgentIdForNextAcquire = null;
  mockState.cursorSdkCloudRequests = [];
  mockState.cursorSdkCloudResponses = new Map<string, unknown>();
  mockState.cursorSendPromptGate = null;
  mockState.cursorSendPromptError = null;
  mockState.droidAcquireCalls = [];
  mockState.droidNewSessionCalls = [];
  mockState.droidPromptCalls = [];
  mockState.droidSettingsUpdates = [];
  mockState.droidPooled = null;
  mockState.droidPromptGate = null;
  mockState.droidPromptError = null;
  cursorModelsListMock.mockReset();
  vi.mocked(startOpenCodeSession).mockClear();
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
  vi.mocked(tagSession).mockClear();
  installClaudeSdkCompatMocks();
  vi.mocked(resolveClaudeCodeExecutable).mockClear();
  vi.mocked(resolveClaudeCodeExecutable).mockReturnValue({ path: "/usr/local/bin/claude", source: "path" });
  vi.mocked(detectAllAuth).mockResolvedValue([]);
  vi.mocked(parseAgentChatTranscript).mockReturnValue([]);
  vi.mocked(clearOpenCodeInventoryCache).mockClear();
  clearCursorCliModelsCache();
  vi.mocked(peekOpenCodeInventoryCache).mockReset();
  vi.mocked(peekOpenCodeInventoryCache).mockReturnValue(null);
  vi.mocked(probeOpenCodeProviderInventory).mockReset();
  vi.mocked(probeOpenCodeProviderInventory).mockResolvedValue({
    modelIds: ["opencode/openai/gpt-5.4"],
    catalogModelIds: ["opencode/openai/gpt-5.4"],
    providers: [],
    error: null,
    descriptors: [],
  });
  replaceDynamicOpenCodeModelDescriptors([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_CURSOR_API_KEY === undefined) {
    delete process.env.CURSOR_API_KEY;
  } else {
    process.env.CURSOR_API_KEY = ORIGINAL_CURSOR_API_KEY;
  }
  try {
    fs.rmSync(tmpHomeRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ============================================================================
// buildComputerUseDirective (exported standalone)
// ============================================================================

describe("buildComputerUseDirective", () => {
  function makeBackendStatus(
    overrides: Partial<{ ghostOs: boolean; agentBrowser: boolean; localFallback: boolean }> = {},
  ): ComputerUseBackendStatus {
    const backends: ComputerUseBackendStatus["backends"] = [];
    if (overrides.ghostOs) {
      backends.push({
        name: "Ghost OS",
        available: true,
        state: "installed",
        detail: "Ghost OS connected.",
        supportedKinds: ["screenshot"],
      });
    }
    if (overrides.agentBrowser) {
      backends.push({
        name: "agent-browser",
        available: true,
        state: "installed",
        detail: "agent-browser CLI installed.",
        supportedKinds: ["screenshot"],
      });
    }
    return {
      backends,
      localFallback: {
        available: overrides.localFallback ?? false,
        detail: overrides.localFallback
          ? "ADE local computer-use tools available."
          : "ADE local fallback missing.",
        supportedKinds: overrides.localFallback ? ["screenshot"] : [],
      },
    };
  }

  it("returns null when no backends, no local fallback, and status is non-null", () => {
    const status = makeBackendStatus({});
    const result = buildComputerUseDirective(status);
    expect(result).toBeNull();
  });

  it("returns a directive when backendStatus is null (unknown status)", () => {
    const result = buildComputerUseDirective(null);
    expect(result).not.toBeNull();
    expect(result).toContain("Computer Use");
    expect(result).toContain("get_computer_use_backend_status");
    expect(result).toContain("If it is not exposed, do not stall");
    expect(result).toContain("Respect the backend the user requested");
    expect(result).toContain("mcp__computer_use");
    expect(result).toContain("do not bootstrap `@oai/sky`");
    expect(result).toContain("does not passively ingest");
  });

  it("includes Ghost OS section when Ghost OS backend is available", () => {
    const status = makeBackendStatus({ ghostOs: true });
    const result = buildComputerUseDirective(status);
    expect(result).toContain("Ghost OS (Desktop Automation)");
    expect(result).toContain("ghost_context");
    expect(result).toContain("ghost_annotate");
  });

  it("includes agent-browser section when agent-browser is available", () => {
    const status = makeBackendStatus({ agentBrowser: true });
    const result = buildComputerUseDirective(status);
    expect(result).toContain("agent-browser (Browser Automation)");
    expect(result).not.toContain("Ghost OS (Desktop Automation)");
  });

  it("includes ADE Local fallback section when local fallback is enabled", () => {
    const status = makeBackendStatus({ localFallback: true });
    const result = buildComputerUseDirective(status);
    expect(result).toContain("ADE Local (Fallback)");
    expect(result).toContain("Proof Capture");
  });

  it("always includes Proof Capture section when directive is non-null", () => {
    const status = makeBackendStatus({ ghostOs: true });
    const result = buildComputerUseDirective(status);
    expect(result).toContain("Proof Capture");
    expect(result).toContain("ade proof");
    expect(result).toContain("ingest_computer_use_artifacts");
    expect(result).toContain("capture visual proof first");
    expect(result).toContain("Console logs and text files are supporting diagnostics only");
  });
});

describe("writeSessionLinearIssueContextFile", () => {
  function makeSessionLink(overrides: Record<string, unknown> = {}) {
    return {
      id: "link-1",
      sessionId: "sess-1",
      laneId: null,
      role: "worked",
      source: "chat_attach",
      includeInPr: true,
      closeOnMerge: false,
      evidence: null,
      createdAt: "2026-05-20T10:00:00.000Z",
      updatedAt: "2026-05-20T10:00:00.000Z",
      issue: {
        id: "issue-1",
        identifier: "ENG-431",
        title: "Fix OAuth refresh",
        url: "https://linear.app/acme/issue/ENG-431",
        stateName: "In Progress",
        teamKey: "ENG",
      },
      ...overrides,
    } as any;
  }

  let contextRoot: string;
  beforeEach(() => {
    contextRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-linear-context-"));
  });

  it("writes a context file and returns env-ready ids when links exist", () => {
    const result = writeSessionLinearIssueContextFile({
      contextDir: contextRoot,
      sessionId: "sess-1",
      links: [
        makeSessionLink(),
        makeSessionLink({ id: "link-2", issue: { ...makeSessionLink().issue, id: "issue-2", identifier: "ENG-440" } }),
      ],
      now: "2026-05-20T11:00:00.000Z",
    });

    expect(result).not.toBeNull();
    expect(result!.identifiers).toBe("ENG-431,ENG-440");
    expect(result!.issueIds).toBe("issue-1,issue-2");
    expect(result!.filePath).toBe(path.join(contextRoot, "sess-1", "linear-issues.json"));

    const written = JSON.parse(fs.readFileSync(result!.filePath, "utf8"));
    expect(written.sessionId).toBe("sess-1");
    expect(written.updatedAt).toBe("2026-05-20T11:00:00.000Z");
    expect(written.issues).toHaveLength(2);
    expect(written.issues[0]).toEqual(expect.objectContaining({
      id: "issue-1",
      identifier: "ENG-431",
      role: "worked",
      teamKey: "ENG",
    }));
  });

  it("returns null and removes a stale file when there are no links", () => {
    const filePath = path.join(contextRoot, "sess-1", "linear-issues.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{\"stale\":true}");

    const result = writeSessionLinearIssueContextFile({
      contextDir: contextRoot,
      sessionId: "sess-1",
      links: [],
      now: "2026-05-20T11:00:00.000Z",
    });

    expect(result).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe("buildLinearSessionDirective", () => {
  function makeLink(identifier: string) {
    return { issue: { identifier } } as any;
  }

  it("returns null when there are no attached issues", () => {
    expect(buildLinearSessionDirective([])).toBeNull();
  });

  it("returns null when no link carries a usable identifier", () => {
    expect(buildLinearSessionDirective([{ issue: { identifier: "" } } as any])).toBeNull();
  });

  it("steers the agent to `ade linear` over MCP and lists the deduped identifiers", () => {
    const directive = buildLinearSessionDirective([
      makeLink("ENG-12"),
      makeLink("ENG-34"),
      makeLink("ENG-12"),
    ]);
    expect(directive).toContain("Linear-tracked work");
    expect(directive).toContain("ENG-12, ENG-34");
    // Deduped — the repeated identifier appears once.
    expect(directive?.match(/ENG-12/g)).toHaveLength(1);
    expect(directive).toContain("ade linear");
    expect(directive).toContain("Prefer `ade linear`");
    expect(directive).toContain("ade-linear");
    expect(directive).toContain("ade-deeplinks");
  });
});

// ============================================================================
// createAgentChatService factory
// ============================================================================

describe("createAgentChatService", () => {
  it("returns an object with all expected methods", () => {
    const { service } = createService();
    expect(service.createSession).toBeTypeOf("function");
    expect(service.importExternalChatSession).toBeTypeOf("function");
    expect(service.handoffSession).toBeTypeOf("function");
    expect(service.sendMessage).toBeTypeOf("function");
    expect(service.steer).toBeTypeOf("function");
    expect(service.interrupt).toBeTypeOf("function");
    expect(service.resumeSession).toBeTypeOf("function");
    expect(service.listSessions).toBeTypeOf("function");
    expect(service.getSessionSummary).toBeTypeOf("function");
    expect(service.hasActiveWorkloads).toBeTypeOf("function");
    expect(service.getChatTranscript).toBeTypeOf("function");
    expect(service.ensureIdentitySession).toBeTypeOf("function");
    expect(service.approveToolUse).toBeTypeOf("function");
    expect(service.getAvailableModels).toBeTypeOf("function");
    expect(service.getSlashCommands).toBeTypeOf("function");
    expect(service.dispose).toBeTypeOf("function");
    expect(service.deleteSession).toBeTypeOf("function");
    expect(service.disposeAll).toBeTypeOf("function");
    expect(service.updateSession).toBeTypeOf("function");
    expect(service.warmupModel).toBeTypeOf("function");
    expect(service.listSubagents).toBeTypeOf("function");
    expect(service.getSessionCapabilities).toBeTypeOf("function");
    expect(service.cleanupStaleAttachments).toBeTypeOf("function");
    expect(service.setComputerUseArtifactBrokerService).toBeTypeOf("function");
  });

  it("previews native git ADE tools for regular workflow chats", () => {
    const { service } = createService();
    const toolNames = service.previewSessionToolNames({
      laneId: "lane-1",
      sessionProfile: "workflow",
      identityKey: undefined,
    });

    expect(toolNames).toEqual(expect.arrayContaining([
      "commit_changes",
      "rebase_lane",
      "stash_push",
      "list_stashes",
      "stash_pop",
      "stash_clear",
      "ask_user",
    ]));
  });

  // --------------------------------------------------------------------------
  // createSession
  // --------------------------------------------------------------------------

  describe("createSession", () => {
    it("creates a opencode session with valid model", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(session).toBeDefined();
      expect(session.id).toBe("test-uuid-1");
      expect(session.laneId).toBe("lane-1");
      expect(session.provider).toBe("opencode");
      expect(session.status).toBe("idle");
      expect(session.completion).toBeNull();
      expect(sessionService.create).toHaveBeenCalledTimes(1);
    });

    it("persists create-time goals into the backing session row", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        goal: "Run quality, tests, ship, merge, and release.",
      });

      expect(session.goal).toBe("Run quality, tests, ship, merge, and release.");
      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          goal: "Run quality, tests, ship, merge, and release.",
        }),
      );
      await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
        goal: "Run quality, tests, ship, merge, and release.",
      });
    });

    it("creates a claude session with default model", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      expect(session).toBeDefined();
      expect(session.provider).toBe("claude");
      expect(session.status).toBe("idle");
    });

    it("imports a same-cwd Claude external chat with persisted resume identity and visible history", async () => {
      const externalSessionId = "11111111-2222-3333-4444-555555555555";
      const claudeConfigRoot = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(tmpHomeRoot, ".claude");
      const claudeProjectDir = path.join(
        claudeConfigRoot,
        "projects",
        tmpRoot.replace(/[^A-Za-z0-9]/g, "-"),
      );
      fs.mkdirSync(claudeProjectDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeProjectDir, `${externalSessionId}.jsonl`),
        [
          JSON.stringify({
            type: "user",
            uuid: "user-1",
            timestamp: "2026-07-06T10:00:00.000Z",
            cwd: tmpRoot,
            sessionId: externalSessionId,
            message: { role: "user", content: [{ type: "text", text: "Please inspect the failing test." }] },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "assistant-1",
            timestamp: "2026-07-06T10:00:02.000Z",
            cwd: tmpRoot,
            sessionId: externalSessionId,
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "I will check the focused test output." },
                { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "npm test" } },
              ],
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const { service, sessionService } = createService();
      const result = await service.importExternalChatSession({
        provider: "claude",
        externalSessionId,
        laneId: "lane-1",
        cwd: tmpRoot,
        fork: false,
      });

      const persisted = readPersistedChatState(result.chatSessionId);
      expect(result.chatSummary).toMatchObject({
        sessionId: result.chatSessionId,
        laneId: "lane-1",
        provider: "claude",
        title: "Please inspect the failing test",
      });
      expect(persisted.sdkSessionId).toBe(externalSessionId);
      expect(persisted.claudeBackgroundResumeSessionId).toBe(externalSessionId);
      expect(persisted.importedFrom).toMatchObject({
        provider: "claude",
        sessionId: externalSessionId,
      });
      expect(typeof persisted.importedFrom.importedAt).toBe("number");
      expect(sessionService.getClaudeSessionPointerByChatSessionId(result.chatSessionId)).toMatchObject({
        sessionId: externalSessionId,
        laneId: "lane-1",
        chatSessionId: result.chatSessionId,
      });
      expect(sessionService.get(result.chatSessionId)?.title).toBe("Please inspect the failing test");

      const history = service.getChatEventHistory(result.chatSessionId, { maxEvents: 10 });
      expect(history.events.map((envelope) => envelope.event.type)).toEqual([
        "system_notice",
        "user_message",
        "text",
        "tool_call",
      ]);
      expect(history.events[0]!.event).toMatchObject({ type: "system_notice", message: "Session imported from claude CLI (11111111)" });
      expect(history.events[1]!.event).toMatchObject({ type: "user_message", text: "Please inspect the failing test." });
      expect(history.events[2]!.event).toMatchObject({ type: "text", text: "I will check the focused test output." });
      await expect(service.getSessionSummary(result.chatSessionId)).resolves.toMatchObject({
        importedFrom: {
          provider: "claude",
          sessionId: externalSessionId,
        },
      });
    });

    it("forks a same-cwd Claude chat import into a new SDK session id", async () => {
      const externalSessionId = "12121212-3434-4343-8343-565656565656";
      const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
      const claudeConfigRoot = path.join(tmpHomeRoot, ".claude");
      process.env.CLAUDE_CONFIG_DIR = claudeConfigRoot;
      try {
        const sourcePath = path.join(
          claudeConfigRoot,
          "projects",
          tmpRoot.replace(/[^A-Za-z0-9]/g, "-"),
          `${externalSessionId}.jsonl`,
        );
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(
          sourcePath,
          [
            JSON.stringify({
              type: "user",
              uuid: "user-1",
              timestamp: "2026-07-06T10:00:00.000Z",
              cwd: tmpRoot,
              sessionId: externalSessionId,
              message: { role: "user", content: [{ type: "text", text: "Fork this without mutating the source." }] },
            }),
          ].join("\n") + "\n",
          "utf8",
        );
        const sourceBefore = fs.readFileSync(sourcePath, "utf8");
        const readline = await import("node:readline");
        const createLineReader = (options: { input: AsyncIterable<string | Buffer> }) => ({
          on: vi.fn(),
          close: vi.fn(),
          [Symbol.asyncIterator]: () => (async function* () {
            const chunks: string[] = [];
            for await (const chunk of options.input) chunks.push(String(chunk));
            for (const line of chunks.join("").split(/\r?\n/u)) yield line;
          })(),
        });
        vi.mocked(readline.createInterface).mockImplementationOnce(createLineReader as any);
        vi.mocked((readline as any).default.createInterface).mockImplementationOnce(createLineReader as any);
        const { service } = createService();

        const result = await service.importExternalChatSession({
          provider: "claude",
          externalSessionId,
          laneId: "lane-1",
          cwd: tmpRoot,
          fork: true,
        });

        const persisted = readPersistedChatState(result.chatSessionId);
        expect(persisted.sdkSessionId).not.toBe(externalSessionId);
        expect(persisted.claudeBackgroundResumeSessionId).toBe(persisted.sdkSessionId);
        expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBefore);
        const projectsDir = path.join(claudeConfigRoot, "projects");
        const forkedPath = fs.readdirSync(projectsDir)
          .flatMap((entry) => {
            const projectDir = path.join(projectsDir, entry);
            return fs.statSync(projectDir).isDirectory()
              ? fs.readdirSync(projectDir).map((fileName) => path.join(projectDir, fileName))
              : [];
          })
          .find((candidate) => path.basename(candidate) === `${persisted.sdkSessionId}.jsonl`);
        expect(forkedPath).toBeTruthy();
        const forkedRows = fs.readFileSync(forkedPath!, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
        expect(forkedRows[0]).toMatchObject({
          cwd: fs.realpathSync(tmpRoot),
          sessionId: persisted.sdkSessionId,
        });
      } finally {
        if (previousClaudeConfigDir === undefined) {
          delete process.env.CLAUDE_CONFIG_DIR;
        } else {
          process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
        }
      }
    });

    it("preserves the source Claude JSONL when a failed cross-cwd chat import follows transplant", async () => {
      const externalSessionId = "22222222-3333-4333-8333-666666666666";
      const sourceCwd = path.join(tmpHomeRoot, "source-project");
      const claudeConfigRoot = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(tmpHomeRoot, ".claude");
      const sourcePath = path.join(
        claudeConfigRoot,
        "projects",
        sourceCwd.replace(/[^A-Za-z0-9]/g, "-"),
        `${externalSessionId}.jsonl`,
      );
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(
        sourcePath,
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-07-06T10:00:00.000Z",
          cwd: sourceCwd,
          sessionId: externalSessionId,
          message: { role: "user", content: [{ type: "text", text: "Keep my original transcript." }] },
        }) + "\n",
        "utf8",
      );
      const failingSessionService = createMockSessionService();
      vi.mocked(failingSessionService.create).mockImplementationOnce(() => {
        throw new Error("create failed after transplant");
      });
      const readline = await import("node:readline");
      const createLineReader = (options: { input: AsyncIterable<string | Buffer> }) => ({
        on: vi.fn(),
        close: vi.fn(),
        [Symbol.asyncIterator]: () => (async function* () {
          const chunks: string[] = [];
          for await (const chunk of options.input) chunks.push(String(chunk));
          for (const line of chunks.join("").split(/\r?\n/u)) yield line;
        })(),
      });
      vi.mocked(readline.createInterface).mockImplementationOnce(createLineReader as any);
      vi.mocked((readline as any).default.createInterface).mockImplementationOnce(createLineReader as any);
      const { service } = createService({ sessionService: failingSessionService });

      await expect(service.importExternalChatSession({
        provider: "claude",
        externalSessionId,
        laneId: "lane-1",
        cwd: sourceCwd,
        fork: false,
      })).rejects.toThrow("create failed after transplant");

      expect(fs.existsSync(sourcePath)).toBe(true);
    });

    it("archives a forked Codex provider thread when a chat import fails after fork", async () => {
      mockState.codexResponseOverrides.set("thread/fork", () => ({
        thread: { id: "forked-thread-1" },
      }));
      mockState.codexResponseOverrides.set("thread/read", (payload) => {
        const params = payload.params as { threadId?: unknown } | undefined;
        if (params?.threadId === "source-thread-1") {
          return { thread: { id: "source-thread-1", turns: [] } };
        }
        return {};
      });
      const { service, sessionService } = createService();

      await expect(service.importExternalChatSession({
        provider: "codex",
        externalSessionId: "source-thread-1",
        laneId: "lane-1",
        cwd: tmpRoot,
        fork: true,
      })).rejects.toThrow(/was not found by thread\/read/i);

      expect(mockState.codexRequestPayloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "thread/archive",
          params: { threadId: "forked-thread-1" },
        }),
      ]));
      expect(sessionService.get("test-uuid-1")).toBeNull();
    });

    it("reacquires a Codex runtime to archive a forked provider thread when the import runtime cannot clean up", async () => {
      let archiveAttempts = 0;
      mockState.codexResponseOverrides.set("thread/fork", () => ({
        thread: { id: "forked-thread-2" },
      }));
      mockState.codexResponseOverrides.set("thread/read", (payload) => {
        const params = payload.params as { threadId?: unknown } | undefined;
        if (params?.threadId === "source-thread-2") {
          return { thread: { id: "source-thread-2", turns: [] } };
        }
        return {};
      });
      mockState.codexResponseOverrides.set("thread/archive", () => {
        archiveAttempts += 1;
        if (archiveAttempts === 1) {
          return { error: { code: -32000, message: "dead runtime" } };
        }
        return {};
      });
      const { service, logger, sessionService } = createService();

      await expect(service.importExternalChatSession({
        provider: "codex",
        externalSessionId: "source-thread-2",
        laneId: "lane-1",
        cwd: tmpRoot,
        fork: true,
      })).rejects.toThrow(/was not found by thread\/read/i);

      const initializeRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "initialize");
      const archiveRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "thread/archive");
      expect(initializeRequests).toHaveLength(2);
      expect(archiveRequests).toEqual([
        expect.objectContaining({ params: { threadId: "forked-thread-2" } }),
        expect.objectContaining({ params: { threadId: "forked-thread-2" } }),
      ]);
      expect(logger.warn).not.toHaveBeenCalledWith(
        "agent_chat.external_import_codex_fork_cleanup_leaked",
        expect.anything(),
      );
      expect(sessionService.get("test-uuid-1")).toBeNull();
    });

    it("derives the runtime model from modelId when raw action callers omit model", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: undefined,
        modelId: "anthropic/claude-sonnet-5",
      } as any);

      expect(session.provider).toBe("claude");
      expect(session.modelId).toBe("anthropic/claude-sonnet-5");
      expect(session.model).toBe("claude-sonnet-5");
    });

    it("keeps legacy bracketed 1M model aliases on Claude Opus 4.7 1M", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-7[1m]",
      });

      expect(session.modelId).toBe("anthropic/claude-opus-4-7-1m");
      expect(session.model).toBe("claude-opus-4-7[1m]");
    });

    it.each([
      { reportedModel: "opus", usageModel: "claude-opus-4-8", expectedModel: "opus" },
      { reportedModel: "claude-opus-4-7-1m", usageModel: "claude-opus-4-7-1m", expectedModel: "claude-opus-4-8" },
    ])("preserves the Claude Opus 4.8 modelId in done events when the SDK reports $reportedModel", async ({
      reportedModel,
      usageModel,
      expectedModel,
    }) => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-opus-4-8",
              model: reportedModel,
              slash_commands: [],
            };
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: "sdk-opus-4-8",
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: { [usageModel]: { input_tokens: 1, output_tokens: 1 } },
            };
            return;
          }
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-opus-4-8",
            model: reportedModel,
            slash_commands: [],
          };
          yield {
            type: "assistant",
            message: {
              model: reportedModel,
              content: [{ type: "text", text: "Done" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-opus-4-8",
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: { [usageModel]: { input_tokens: 1, output_tokens: 1 } },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-opus-4-8",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Report the selected model.",
      });

      const doneEvent = events.filter((event) => event.event.type === "done").at(-1);
      expect(doneEvent?.event.type).toBe("done");
      expect((doneEvent!.event as any).model).toBe(expectedModel);
      expect((doneEvent!.event as any).modelId).toBe("anthropic/claude-opus-4-8");
    });

    it("preserves selected Claude Opus 4.7 1M metadata when the SDK reports bare Opus 4.7", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-opus-4-7-1m",
              model: "claude-opus-4-7",
              slash_commands: [],
            };
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: "sdk-opus-4-7-1m",
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: { "claude-opus-4-7": { input_tokens: 1, output_tokens: 1 } },
            };
            return;
          }
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-opus-4-7-1m",
            model: "claude-opus-4-7",
            slash_commands: [],
          };
          yield {
            type: "assistant",
            message: {
              model: "claude-opus-4-7",
              content: [{ type: "text", text: "Done" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-opus-4-7-1m",
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: { "claude-opus-4-7": { input_tokens: 1, output_tokens: 1 } },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-opus-4-7-1m",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-7[1m]",
        modelId: "anthropic/claude-opus-4-7-1m",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Report the selected model.",
      });

      const doneEvent = events.filter((event) => event.event.type === "done").at(-1);
      expect(doneEvent?.event.type).toBe("done");
      expect((doneEvent!.event as any).model).toBe("claude-opus-4-7[1m]");
      expect((doneEvent!.event as any).modelId).toBe("anthropic/claude-opus-4-7-1m");
    });

    it("fast-fails a logged-out Claude turn into the inline re-login card", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            // Startup warmup stream — healthy.
            yield { type: "system", subtype: "init", session_id: "sdk-auth", model: "claude-opus-4-8", slash_commands: [] };
            yield { type: "result", subtype: "success", is_error: false, session_id: "sdk-auth" };
            return;
          }
          // The SDK reports a logged-out session as an assistant message carrying
          // error="authentication_failed", with the 401 surfaced as plain text.
          yield { type: "system", subtype: "init", session_id: "sdk-auth", model: "claude-opus-4-8", slash_commands: [] };
          yield {
            type: "assistant",
            error: "authentication_failed",
            message: {
              model: "claude-opus-4-8",
              content: [{ type: "text", text: "Failed to authenticate. API Error: 401 Invalid authentication credentials" }],
            },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-auth",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
      });

      await service.runSessionTurn({ sessionId: session.id, text: "use context skill" });

      // The raw 401 is not surfaced as a plain assistant bubble.
      const authText = events.find(
        (event) => event.event.type === "text"
          && /invalid authentication credentials/i.test((event.event as any).text ?? ""),
      );
      expect(authText).toBeUndefined();

      // A single "logged out" notice replaces the "retry 1/10 … 10/10" storm.
      const notice = events.find(
        (event) => event.event.type === "system_notice"
          && /logged out/i.test((event.event as any).message ?? ""),
      );
      expect(notice).toBeTruthy();

      // The error carries the agentCli signal that renders the inline re-login card.
      const errorEvent = events.find(
        (event) => event.event.type === "error"
          && (event.event as any).errorInfo?.agentCli?.category === "unauthenticated",
      );
      expect(errorEvent).toBeTruthy();
      expect((errorEvent!.event as any).errorInfo.agentCli.agent).toBe("claude");

      const failedDone = events.filter((event) => event.event.type === "done").at(-1);
      expect((failedDone!.event as any).status).toBe("failed");
    });

    it("honors an explicit initial chat title", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        title: "  Pearl UI Audit  ",
      });

      expect(sessionService.get(session.id)?.title).toBe("Pearl UI Audit");
      expect(sessionService.get(session.id)?.manuallyNamed).toBe(true);
    });

    it("appends ADE tooling guidance to Claude SDK sessions", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-guidance",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      expect(opts?.systemPrompt?.append).toContain("control plane for ADE state");
      expect(opts?.systemPrompt?.append).toContain("read the matching `ade-*` skill");
      expect(opts?.systemPrompt?.append).toContain("ade help <command>");
      expect(opts?.systemPrompt?.append).toContain("clean up processes you start");
    });

    it("rebuilds the Claude query with the per-turn reasoning effort, not the stale warm-query effort (FIX 3)", async () => {
      // Regression: the session pre-warmed a query baked with the create-time
      // effort (medium). A later turn requesting xhigh updated the session field
      // but ensureClaudeQuery reused the stale warm query, so Claude ran medium.
      const send = vi.fn().mockResolvedValue(undefined);
      const makeSession = (sdkSessionId: string) => ({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: sdkSessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: sdkSessionId,
        query: {
          setPermissionMode: vi.fn(async () => undefined),
          supportedCommands: vi.fn(async () => []),
        },
      });
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(makeSession("sdk-effort") as any);

      const { service } = createService();
      // opus supports the xhigh tier; sonnet does not, which would clamp the
      // requested effort and mask the regression.
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "opus",
        reasoningEffort: "medium",
      });

      // The pre-warm built a query with the create-time (medium) effort.
      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });
      const warmOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { effort?: string } | undefined;
      expect(warmOpts?.effort).toBe("medium");

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Do the deep work.",
        reasoningEffort: "xhigh",
        timeoutMs: 15_000,
      });

      // The stale warm query was discarded and a fresh query built with xhigh.
      const efforts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls
        .map((call) => (call[0] as { effort?: string } | undefined)?.effort)
        .filter((value): value is string => typeof value === "string");
      expect(efforts).toContain("xhigh");
      expect(session.id).toBeDefined();
    });

    it("injects the ade-linear directive into the Claude system prompt when the session has attached issues (FIX 4)", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-linear-directive",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-linear-directive",
        query: {
          setPermissionMode: vi.fn(async () => undefined),
          supportedCommands: vi.fn(async () => []),
        },
      } as any);

      const { service, laneService } = createService();
      const issue = makeLaneLinearIssue();
      // opus supports xhigh, so the per-turn effort bump below invalidates the
      // create-time warm query (built before the attach) and forces a fresh
      // query build that now resolves the attached issue into the directive.
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "opus",
        reasoningEffort: "medium",
      });
      // Let the create-time warm query settle (built before the attach, so with
      // no directive) — the turn must then invalidate and rebuild it.
      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
      });
      laneService.attachLinearIssueToSession({
        chatSessionId: session.id,
        issues: [issue],
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Continue the tracked work.",
        reasoningEffort: "xhigh",
        timeoutMs: 15_000,
      });

      const appended = vi.mocked(claudeSdkCreateSessionCompat).mock.calls
        .map((call) => (call[0] as { systemPrompt?: { append?: string } } | undefined)?.systemPrompt?.append ?? "")
        .join("\n");
      expect(appended).toContain("Linear-tracked work");
      expect(appended).toContain("ADE-123");
      expect(appended).toContain("ade linear");
      expect(appended).toContain("Prefer `ade linear`");
      expect(appended).toContain("ade-deeplinks");
    });

    it("keeps ADE tooling guidance out of Claude SDK user turns", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-session-user-guidance",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-user-guidance",
        query: {
          setPermissionMode: vi.fn(async () => undefined),
          supportedCommands: vi.fn(async () => []),
        },
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the repo and report the chat wiring.",
        timeoutMs: 15_000,
      });

      const userTurnPayload = send.mock.calls
        .map((call) => String(call[0] ?? ""))
        .find((payload) => payload.includes("Inspect the repo and report the chat wiring."));

      expect(userTurnPayload).toContain("[ADE launch directive]");
      expect(userTurnPayload).not.toContain("control plane for ADE state");
      expect(userTurnPayload).not.toContain("ade actions list --text");
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      expect(opts?.systemPrompt?.append).toContain("control plane for ADE state");
    });

    it("keeps Claude SDK setting sources and skills enabled without output-style plugins", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-skills",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        includeHookEvents?: boolean;
        promptSuggestions?: boolean;
        settingSources?: string[];
        settings?: {
          enabledPlugins?: Record<string, boolean>;
          outputStyle?: string;
          fastMode?: boolean;
        };
        skills?: string;
      } | undefined;
      expect(opts?.settingSources).toEqual(expect.arrayContaining(["user", "project"]));
      expect(opts?.skills).toBe("all");
      expect(opts?.includeHookEvents).toBe(true);
      expect(opts?.promptSuggestions).toBe(true);
      expect(opts?.settings).toEqual(expect.objectContaining({
        outputStyle: "Default",
        fastMode: false,
        enabledPlugins: expect.objectContaining({
          "learning-output-style@claude-code-plugins": false,
          "learning-output-style@claude-plugins-official": false,
          "explanatory-output-style@claude-code-plugins": false,
          "explanatory-output-style@claude-plugins-official": false,
        }),
      }));
    });

    it("passes Claude fast mode through SDK flag settings for Opus sessions", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-fast",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
        fastMode: true,
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        settings?: { fastMode?: boolean };
      } | undefined;
      expect(opts?.settings?.fastMode).toBe(true);
    });

    it("uses updated Claude fast mode on the next SDK query", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
      });

      await service.updateSession({
        sessionId: session.id,
        fastMode: true,
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start the Claude query.",
      }, { awaitDispatch: true });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
        settings?: { fastMode?: boolean };
      } | undefined;
      expect(opts?.settings?.fastMode).toBe(true);
    });

    it("preserves Claude fast mode when switching to a fast-capable Claude model", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
        fastMode: true,
      });

      // Opus 4.8 also supports fast mode, so the toggle should survive the switch.
      await service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-opus-4-8",
      });

      expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
    });

    it("clears Claude fast mode when switching to a non-fast Claude model", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
        fastMode: true,
      });

      // Sonnet 5 has no "fast" service tier, so the toggle must be dropped.
      await service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-sonnet-5",
      });

      expect((await service.getSessionSummary(session.id))?.fastMode).not.toBe(true);
    });

    it("handles Claude /fast commands inline and persists the ADE fast setting", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
      } as any);

      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-8",
        modelId: "anthropic/claude-opus-4-8",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });
      vi.mocked(claudeSdkCreateSessionCompat).mockClear();

      await service.sendMessage({
        sessionId: session.id,
        text: "/fast on",
      }, { awaitDispatch: true });

      expect(claudeSdkCreateSessionCompat).not.toHaveBeenCalled();
      expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
      expect(readPersistedChatState(session.id).fastMode).toBe(true);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Fast mode is on."
      )).toBe(true);
    });

    it("passes discovered local Claude plugins to SDK sessions", async () => {
      const pluginRoot = path.join(tmpRoot, ".claude", "plugins", "ade-tools", "review-pack");
      fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
        name: "review-pack",
      }));
      fs.writeFileSync(path.join(tmpRoot, ".claude", "settings.json"), JSON.stringify({
        enabledPlugins: { "review-pack@local": true },
      }));
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-plugins",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        plugins?: Array<{ type?: string; path?: string }>;
      } | undefined;
      expect(opts?.plugins).toEqual([
        { type: "local", path: fs.realpathSync(pluginRoot) },
      ]);
    });

    it("loads user/project MCP servers in normal chats (no managed-only lock)", async () => {
      fs.writeFileSync(path.join(tmpRoot, ".mcp.json"), JSON.stringify({
        mcpServers: {
          projectTools: {
            command: "node",
            args: ["mcp-server.js"],
          },
        },
      }));
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-mcp",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        managedSettings?: Record<string, unknown>;
        settingSources?: string[];
        strictMcpConfig?: boolean;
      } | undefined;
      expect(opts).toBeTruthy();
      // Project/user setting sources stay enabled so the SDK reads the user's
      // configured MCP servers (.mcp.json / ~/.claude.json) — same as a terminal session.
      expect(opts?.settingSources).toEqual(expect.arrayContaining(["project"]));
      // ADE does not inject mcpServers into a normal chat (only orchestration does),
      // and it no longer locks MCP to managed-only — so the user's servers can load.
      expect(opts).not.toHaveProperty("mcpServers");
      expect(opts?.managedSettings).toBeUndefined();
      // Inverse of the lightweight test: strictMcpConfig must NOT leak into normal
      // chats, or it would silently re-block the user's MCP servers we just enabled.
      expect(opts?.strictMcpConfig).toBeUndefined();
    });

    it("keeps lightweight sessions lean by ignoring on-disk MCP config (strictMcpConfig)", async () => {
      fs.writeFileSync(path.join(tmpRoot, ".mcp.json"), JSON.stringify({
        mcpServers: {
          projectTools: {
            command: "node",
            args: ["mcp-server.js"],
          },
        },
      }));
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-light-mcp",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        sessionProfile: "light",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        strictMcpConfig?: boolean;
        managedSettings?: Record<string, unknown>;
        settingSources?: string[];
      } | undefined;
      expect(opts).toBeTruthy();
      // Lightweight side-jobs (auto-title / lane-naming) don't get settingSources,
      // and the SDK loads all MCP sources when unconstrained — so strictMcpConfig must
      // be set to keep them from spawning the user's whole MCP fleet for a trivial job.
      expect(opts?.settingSources).toBeUndefined();
      expect(opts?.strictMcpConfig).toBe(true);
      expect(opts?.managedSettings).toBeUndefined();
    });

    it("attaches ADE orchestration tools to Claude lead sessions through an SDK MCP server", async () => {
      const { orchestrationService, created } = await createLoadedOrchestrationRun("S-lead");
      try {
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send: vi.fn(),
          stream: vi.fn(async function* () {
            return;
          }),
          close: vi.fn(),
          sessionId: "sdk-session-orchestration",
        } as any);

        const { service } = createService({
          getOrchestrationService: () => orchestrationService,
        });
        await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
          modelId: "anthropic/claude-sonnet-5",
          interactionMode: "orchestrator-lead",
          orchestrationRunId: created.runId,
          orchestrationRole: "lead",
          orchestrationBundlePath: created.manifest.bundlePath,
        });

        await vi.waitFor(() => {
          expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
        });

        const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as any;
        const server = opts?.mcpServers?.["ade-orchestration"];
        expect(server?.type).toBe("sdk");
        const toolNames = Object.keys(server?.instance?._registeredTools ?? {});
        expect(toolNames).toEqual(expect.arrayContaining(["spawnAgent", "messageAgent"]));
        expect(toolNames).not.toContain("editFile");
        expect(toolNames).not.toContain("writeFile");
        expect(toolNames).not.toContain("bash");
        expect(opts?.managedSettings?.allowedMcpServers).toEqual(
          expect.arrayContaining([expect.objectContaining({ serverName: "ade-orchestration" })]),
        );
        expect(opts?.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Bash", "Edit", "Task", "TodoWrite", "Write"]));
      } finally {
        await orchestrationService.dispose();
      }
    });

    it("keeps Claude lead sessions read-only even before an orchestration bundle is allocated", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-orchestrator-draft",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        interactionMode: "orchestrator-lead",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as any;
      expect(opts?.mcpServers?.["ade-orchestration"]).toBeUndefined();
      // Regression guard (removed base MCP lock): a draft lead has no managed MCP block
      // yet, so strictMcpConfig must isolate it — user/project MCP servers must not restore
      // tool capability the read-only lead is denied.
      expect(opts?.strictMcpConfig).toBe(true);
      expect(opts?.disallowedTools).toEqual(expect.arrayContaining([
        "Agent",
        "Bash",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "Task",
        "TodoRead",
        "TodoWrite",
        "Write",
      ]));
    });

    it("keeps Claude role-marked lead sessions read-only even when interaction mode is absent", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-role-lead",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        orchestrationRole: "lead",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as any;
      // Role-marked lead (no interactionMode, no bundle) is still a read-only lead, so it
      // must be MCP-isolated too (regression guard for the removed base MCP lock).
      expect(opts?.strictMcpConfig).toBe(true);
      expect(opts?.disallowedTools).toEqual(expect.arrayContaining([
        "Agent",
        "Bash",
        "Edit",
        "Task",
        "TodoWrite",
        "Write",
      ]));
    });

    it("passes Claude subprocess spawns through the reaper", async () => {
      const spawnedProcess = { pid: 4321 };
      const claudeSubprocessReaper = {
        register: vi.fn(),
        spawnClaudeCodeProcess: vi.fn(() => spawnedProcess),
        reapForSession: vi.fn(),
        reapAll: vi.fn(),
        liveRecords: vi.fn(() => []),
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-reaper",
      } as any);

      const { service } = createService({ claudeSubprocessReaper });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        spawnClaudeCodeProcess?: (options: Record<string, unknown>) => unknown;
      } | undefined;
      const abortController = new AbortController();
      const result = opts?.spawnClaudeCodeProcess?.({
        command: "claude",
        args: ["--model", "sonnet"],
        cwd: tmpRoot,
        env: {},
        signal: abortController.signal,
      });

      expect(result).toBe(spawnedProcess);
      expect(claudeSubprocessReaper.spawnClaudeCodeProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "claude",
          args: ["--model", "sonnet"],
        }),
        expect.objectContaining({
          sessionId: session.id,
          laneId: "lane-1",
          cwd: expect.any(String),
        }),
      );

      await service.dispose({ sessionId: session.id });
      expect(claudeSubprocessReaper.reapForSession).toHaveBeenCalledWith(
        session.id,
        "ended_session",
      );
    });

    it("appends discovered project slash commands to the Claude system prompt", async () => {
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, "audit.md"), [
        "---",
        "description: Audit recent work for bugs and gaps",
        "---",
        "",
        "Audit the recent changes.",
        "",
      ].join("\n"));
      fs.writeFileSync(path.join(commandsDir, "ship-lane.md"), [
        "---",
        "description: Drive a lane through CI + review",
        "---",
        "",
        "Ship the active lane.",
        "",
      ].join("\n"));

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-slash-commands",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      expect(opts?.systemPrompt?.append).toContain("## Project slash commands");
      expect(opts?.systemPrompt?.append).toContain("pre-expands the file's body");
      expect(opts?.systemPrompt?.append).toContain("/audit — Audit recent work for bugs and gaps");
      expect(opts?.systemPrompt?.append).toContain("/ship-lane — Drive a lane through CI + review");
    });

    it("lists bundled ADE skills when no lane command files exist", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-no-slash-commands",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      expect(opts?.systemPrompt?.append).toBeTruthy();
      expect(opts?.systemPrompt?.append).toContain("## Project slash commands and skills");
      expect(opts?.systemPrompt?.append).toContain("/ade-cli-control-plane");
      expect(opts?.systemPrompt?.append).toContain("/ade-linear");
      expect(opts?.systemPrompt?.append).not.toContain("Commands (file-backed prompts):");
    });

    it("caps discovered command listings in the injected Claude prompt", async () => {
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(commandsDir, { recursive: true });
      for (let index = 0; index < 25; index += 1) {
        fs.writeFileSync(path.join(commandsDir, `cmd-${String(index).padStart(2, "0")}.md`), [
          "---",
          `description: Command ${index}`,
          "---",
          "",
          `Run command ${index}.`,
          "",
        ].join("\n"));
      }

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-many-slash-commands",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as { systemPrompt?: { append?: string } } | undefined;
      expect(opts?.systemPrompt?.append).toContain("/cmd-00 — Command 0");
      expect(opts?.systemPrompt?.append).toContain("/cmd-19 — Command 19");
      expect(opts?.systemPrompt?.append).not.toContain("/cmd-24 — Command 24");
      expect(opts?.systemPrompt?.append).toContain("5 more command(s) hidden to keep startup context lean");
    });

    it("does not attach ADE-owned tool definitions to Claude SDK sessions", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-tool-allow",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        allowedTools?: string[];
      } | undefined;
      expect(opts?.allowedTools).toBeUndefined();
    });

    it("requests markdown previews for Claude AskUserQuestion by default", async () => {
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-ask-user-preview",
      } as any);

      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        toolConfig?: { askUserQuestion?: { previewFormat?: string } };
      } | undefined;
      expect(opts?.toolConfig?.askUserQuestion?.previewFormat).toBe("markdown");
    });

    it("migrates legacy Claude plan mode into interaction mode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "plan",
      });

      expect(session.interactionMode).toBe("plan");
      expect(session.claudePermissionMode).toBe("default");
      expect(session.permissionMode).toBe("plan");
    });

    it("sets sessionProfile to workflow by default", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(session.sessionProfile).toBe("workflow");
    });

    it("respects custom sessionProfile", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        sessionProfile: "light",
      });

      expect(session.sessionProfile).toBe("light");
    });

    it("normalizes reasoning effort for opencode provider", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        reasoningEffort: "  HIGH  ",
      });

      expect(session.reasoningEffort).toBe("high");
    });

    it("sets surface to work by default", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        sessionProfile: "light",
      });

      expect(session.surface).toBe("work");
    });

    it("sets surface to automation when specified", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        surface: "automation",
      });

      expect(session.surface).toBe("automation");
    });

    it("throws when opencode provider has no known model ID", async () => {
      const { service } = createService();
      await expect(
        service.createSession({
          laneId: "lane-1",
          provider: "opencode",
          model: "nonexistent-model-xyz",
        }),
      ).rejects.toThrow(/model/i);
    });

    it("attaches identityKey when provided", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        identityKey: "cto",
      });

      expect(session.identityKey).toBe("cto");
    });

    it("persists chat state to disk after creation", async () => {
      const { service } = createService();
      await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const chatSessionsDir = path.join(tmpRoot, ".ade", "cache", "chat-sessions");
      const metaFiles = fs.readdirSync(chatSessionsDir).filter((f) => f.endsWith(".json"));
      expect(metaFiles.length).toBeGreaterThanOrEqual(1);

      const persisted = JSON.parse(fs.readFileSync(path.join(chatSessionsDir, metaFiles[0]!), "utf8"));
      expect(persisted.version).toBe(2);
      expect(persisted.provider).toBe("opencode");
    });

    it("writes a chat transcript init record", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        sessionProfile: "light",
      });

      const chatTranscriptsDir = path.join(tmpRoot, ".ade", "transcripts", "chat");
      const transcriptFiles = fs.readdirSync(chatTranscriptsDir).filter((f) => f.endsWith(".jsonl"));
      expect(transcriptFiles.length).toBeGreaterThanOrEqual(1);

      const content = fs.readFileSync(path.join(chatTranscriptsDir, transcriptFiles[0]!), "utf8").trim();
      const parsed = JSON.parse(content);
      expect(parsed.type).toBe("session_init");
      expect(parsed.sessionId).toBe(session.id);
    });

    it("rejects chat creation when the selected lane worktree is unavailable", async () => {
      const { service, laneService } = createService();
      laneService.getLaneBaseAndBranch.mockReturnValue({
        baseRef: "main",
        branchRef: "feature/test",
        worktreePath: path.join(tmpRoot, "missing-lane"),
        laneType: "feature",
      });

      await expect(service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      })).rejects.toThrow(/worktree is unavailable/i);
    });
  });

  describe("launchHeadless", () => {
    it("creates a session and fires the kickoff turn fire-and-forget without a mounted pane", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-headless",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-headless",
        query: {
          setPermissionMode: vi.fn(async () => undefined),
          supportedCommands: vi.fn(async () => []),
        },
      } as any);

      const { service, sessionService } = createService();
      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        kickoffText: "Investigate the failing build and fix it.",
      });

      // createSession ran: a real session is returned and persisted, and
      // launchHeadless returned it immediately.
      expect(session).toBeDefined();
      expect(session.laneId).toBe("lane-1");
      expect(session.provider).toBe("claude");
      expect(sessionService.create).toHaveBeenCalledTimes(1);

      // The bug this fixes: with no mounted pane the kickoff never ran. Here the
      // kickoff text reaches the SDK *after* launchHeadless already resolved,
      // proving runSessionTurn fired fire-and-forget in the background.
      await vi.waitFor(() => {
        const payload = send.mock.calls
          .map((call) => String(call[0] ?? ""))
          .find((text) => text.includes("Investigate the failing build and fix it."));
        expect(payload).toBeTruthy();
      });
    });

    it("emits a persisted error when kickoff validation fails after the durable session is created", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        kickoffText: "/login",
      });

      expect(session).toBeDefined();
      await vi.waitFor(() => {
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            sessionId: session.id,
            event: expect.objectContaining({ type: "error", message: expect.stringMatching(/login/i) }),
          }),
        ]));
      });
    });

    it("terminates and persists a failed Codex kickoff when turn/start rejects", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const writeFileSync = vi.spyOn(fs, "writeFileSync");
      mockState.codexResponseOverrides.set("turn/start", {
        error: { code: -32_000, message: "turn start exploded" },
      });
      mockState.delayedCodexMethods.add("turn/start");
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        kickoffText: "Investigate the incident.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      writeFileSync.mockClear();
      mockState.flushCodexResponses();

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "done"
          && event.event.status === "failed",
      );

      const sessionEvents = events
        .filter((event) => event.sessionId === session.id)
        .map((event) => event.event);
      const errorIndex = sessionEvents.findIndex((event) =>
        event.type === "error" && /turn start exploded/i.test(event.message),
      );
      const failedIndex = sessionEvents.findIndex((event) =>
        event.type === "status"
        && event.turnStatus === "failed"
        && /turn start exploded/i.test(event.message ?? ""),
      );
      const doneIndex = sessionEvents.findIndex((event) =>
        event.type === "done" && event.status === "failed",
      );

      expect(errorIndex).toBeGreaterThanOrEqual(0);
      expect(failedIndex).toBeGreaterThan(errorIndex);
      expect(doneIndex).toBeGreaterThan(failedIndex);
      expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(`${session.id}.json`),
        expect.any(String),
        "utf8",
      );
    });

    it("returns the session and lets a pending kickoff turn outlive the default runSessionTurn timeout", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        // A turn that hangs forever would block the launch if it were awaited.
        const send = vi.fn(() => new Promise<void>(() => {}));
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send,
          stream: vi.fn(() => (async function* () {
            await new Promise<void>(() => {});
          })()),
          close: vi.fn(),
          sessionId: "sdk-headless-pending",
          query: {
            setPermissionMode: vi.fn(async () => undefined),
            supportedCommands: vi.fn(async () => []),
          },
        } as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        // Resolves promptly despite the hanging turn -> fire-and-forget.
        const session = await service.launchHeadless({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
          kickoffText: "Start the work.",
        });

        expect(session).toBeDefined();

        await vi.advanceTimersByTimeAsync(300_001);
        expect(events.find((event) =>
          event.event.type === "status" && event.event.turnStatus === "interrupted",
        )).toBeUndefined();
        expect(events.find((event) =>
          event.event.type === "error" && event.event.message.includes("Timed out waiting for session"),
        )).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("defaults the session to autonomous full-auto when no permission controls are supplied", async () => {
      // Map modes with the real semantics (full-auto => never / danger-full-access)
      // so the derived native codex fields prove launchHeadless defaulted the
      // session to full-auto — the only mode whose background turn never stalls
      // on a permission prompt no pane could answer.
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        if (mode === "edit") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5-codex",
        modelId: "gpt-5-codex",
        kickoffText: "Triage the incident.",
      });

      expect(session.codexApprovalPolicy).toBe("never");
      expect(session.codexSandbox).toBe("danger-full-access");
      expect(session.permissionMode).toBe("full-auto");
    });

    it("honors an explicit permissionMode supplied by the caller", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        if (mode === "edit") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5-codex",
        modelId: "gpt-5-codex",
        permissionMode: "edit",
        kickoffText: "Make a focused edit.",
      });

      // The caller's explicit mode wins over the full-auto default.
      expect(session.codexApprovalPolicy).toBe("untrusted");
      expect(session.codexSandbox).toBe("workspace-write");
      expect(session.permissionMode).toBe("edit");
    });

    it("persists the attached Linear issue link for a launched chat (FIX 1)", async () => {
      // Regression: launchHeadless passed contextAttachments to runSessionTurn,
      // but runSessionTurn dropped them before prepareSendMessage, so the
      // session→issue link was never recorded and agents reached for Linear MCP.
      const send = vi.fn().mockResolvedValue(undefined);
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-link",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-link",
        query: {
          setPermissionMode: vi.fn(async () => undefined),
          supportedCommands: vi.fn(async () => []),
        },
      } as any);

      const { service, laneService } = createService();
      const issue = makeLaneLinearIssue();
      const session = await service.launchHeadless({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        kickoffText: "Fix the bug tracked by this issue.",
        contextAttachments: [makeLinearIssueContextAttachment(issue, "manual")],
      });

      // The session-scoped link is written so getSessionLinearEnv / the directive
      // resolve the issue and the agent uses `ade linear` instead of MCP.
      await vi.waitFor(() => {
        expect(laneService.attachLinearIssueToSession).toHaveBeenCalledWith(
          expect.objectContaining({
            chatSessionId: session.id,
            issues: expect.arrayContaining([expect.objectContaining({ id: issue.id })]),
          }),
        );
      });
      expect(mockState.sessionLinearLinks.get(session.id)?.[0]?.issue?.id).toBe(issue.id);
    });

    it("tags the backing terminal row with its owning chat session id (FIX 2)", async () => {
      // Regression: the chat's backing terminal was registered without a
      // chatSessionId, so laneAgents.ts could not exclude it and a phantom "CLI"
      // agent row appeared next to the chat row.
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          chatSessionId: session.id,
        }),
      );
    });
  });

  describe("handoffSession", () => {
    it("rejects handoff while the source chat is still outputting", async () => {
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      source.status = "active";

      await expect(
        service.handoffSession({
          sourceSessionId: source.id,
          targetModelId: "opencode/openai/gpt-5.4-mini",
        }),
      ).rejects.toThrow("Wait for the current response to finish before handing off this chat.");
    });

    it("clones chat settings and auto-sends the first handoff prompt", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
        sessionProfile: "light",
        reasoningEffort: "high",
        opencodePermissionMode: "full-auto",
      });
      source.executionMode = "parallel";
      sessionService.updateMeta({
        sessionId: source.id,
        goal: "Fix the work-tab handoff UI.",
      });
      const sourceRow = mockState.sessions.get(source.id);
      if (sourceRow) {
        sourceRow.summary = "The bug is narrowed to the work-tab header and OpenAI model registry.";
      }

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "opencode/openai/gpt-5.4-mini",
      });

      expect(result.usedFallbackSummary).toBe(true);
      expect(result.session.laneId).toBe(source.laneId);
      expect(result.session.modelId).toBe("opencode/openai/gpt-5.4-mini");
      expect(result.session.sessionProfile).toBe("light");
      expect(result.session.reasoningEffort).toBe("high");
      expect(result.session.opencodePermissionMode).toBe("full-auto");
      expect(result.session.executionMode).toBe("parallel");
      expect(mockState.sessions.get(result.session.id)?.goal).toBe("Fix the work-tab handoff UI.");

      const transcriptPath = mockState.sessions.get(result.session.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      // Wait for the async transcript write to flush (CI runners can be slow)
      await vi.waitFor(() => {
        const transcript = fs.readFileSync(String(transcriptPath), "utf8");
        expect(transcript).toContain("Chat handoff from previous session");
      }, { timeout: 2000, interval: 50 });
    });

    it("does not seed Codex brief handoffs as provider goals", async () => {
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      sessionService.updateMeta({
        sessionId: source.id,
        goal: "No Machine State Polish",
      });
      const sourceRow = mockState.sessions.get(source.id);
      if (sourceRow) {
        sourceRow.summary = "Fix the iPhone 17 simulator chat layout handoff.";
      }

      const handoffStart = mockState.codexRequestPayloads.length;
      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
      });

      expect(result.session.provider).toBe("codex");

      const handoffPayloads = mockState.codexRequestPayloads.slice(handoffStart);
      const requestMethods = handoffPayloads.map((payload) => String(payload.method ?? ""));
      const turnStartIndex = requestMethods.indexOf("turn/start");
      expect(turnStartIndex).toBeGreaterThanOrEqual(0);
      expect(requestMethods).not.toContain("thread/goal/set");

      const turnStartRequest = handoffPayloads[turnStartIndex] as {
        params?: { input?: Array<{ text?: unknown }> };
      };
      const inputText = turnStartRequest.params?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(inputText).toContain("This message was injected automatically by ADE during a chat handoff.");
      expect(inputText).toContain("No Machine State Polish");
      expect(mockState.sessions.get(result.session.id)?.goal ?? null).toBeNull();
    });

    it("appends an optional user note to a brief handoff prompt", async () => {
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      sessionService.updateMeta({
        sessionId: source.id,
        goal: "No Machine State Polish",
      });

      const handoffStart = mockState.codexRequestPayloads.length;
      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        handoffNote: "Focus on the collapsed drawer regression before broader cleanup.",
      });

      expect(result.session.provider).toBe("codex");
      const turnStartRequest = mockState.codexRequestPayloads
        .slice(handoffStart)
        .find((payload) => payload.method === "turn/start") as {
          params?: { input?: Array<{ text?: unknown }> };
        } | undefined;
      const inputText = turnStartRequest?.params?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(inputText).toContain("## User handoff note");
      expect(inputText).toContain("Focus on the collapsed drawer regression before broader cleanup.");
    });

    it("forks Codex handoff from the source provider thread without injecting a summary prompt", async () => {
      const { service, aiIntegrationService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      mockState.codexResponseOverrides.set("thread/fork", () => ({
        thread: { id: "forked-thread-1" },
      }));

      const handoffStart = mockState.codexRequestPayloads.length;
      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
      });

      expect(result.usedFallbackSummary).toBe(false);
      expect(result.session.provider).toBe("codex");
      expect(result.session.threadId).toBe("forked-thread-1");
      expect(mockState.sessions.get(result.session.id)?.goal ?? null).toBeNull();
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();
      const handoffPayloads = mockState.codexRequestPayloads.slice(handoffStart);
      expect(handoffPayloads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "thread/fork",
          params: expect.objectContaining({
            threadId: "source-thread-1",
            excludeTurns: true,
          }),
        }),
        expect.objectContaining({
          method: "thread/goal/clear",
          params: expect.objectContaining({
            threadId: "forked-thread-1",
          }),
        }),
      ]));
      expect(handoffPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
    });

    it("sends only the user note when forking with a handoff note", async () => {
      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      mockState.codexResponseOverrides.set("thread/fork", () => ({
        thread: { id: "forked-thread-1" },
      }));

      const handoffStart = mockState.codexRequestPayloads.length;
      await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "openai/gpt-5.5",
        mode: "fork",
        handoffNote: "Start by checking the current test failure, then continue.",
      });

      const turnStartRequest = mockState.codexRequestPayloads
        .slice(handoffStart)
        .find((payload) => payload.method === "turn/start") as {
          params?: { input?: Array<{ text?: unknown }> };
        } | undefined;
      const inputText = turnStartRequest?.params?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(inputText).toContain("Start by checking the current test failure, then continue.");
      expect(inputText).not.toContain("This message was injected automatically by ADE during a chat handoff.");
    });

    it("does not delete files during Codex rewind when git cannot prove the path was absent", async () => {
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      source.status = "idle";
      mockState.codexResponseOverrides.set("thread/rollback", () => ({
        thread: { id: "source-thread-1" },
      }));
      const changedFile = path.join(tmpRoot, "src", "safe.ts");
      fs.mkdirSync(path.dirname(changedFile), { recursive: true });
      fs.writeFileSync(changedFile, "keep me", "utf8");
      const transcriptPath = sessionService.get(source.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      const rewindEnvelopes: AgentChatEventEnvelope[] = [
        {
          sessionId: source.id,
          timestamp: "2026-07-07T20:00:00.000Z",
          event: {
            type: "user_message",
            messageId: "user-1",
            text: "change safe file",
            turnId: "turn-1",
          },
        } as AgentChatEventEnvelope,
        {
          sessionId: source.id,
          timestamp: "2026-07-07T20:00:01.000Z",
          event: {
            type: "turn_diff_summary",
            turnId: "turn-1",
            beforeSha: "before-sha",
            afterSha: "after-sha",
            files: [{ path: "src/safe.ts", additions: 1, deletions: 0 }],
            totalAdditions: 1,
            totalDeletions: 0,
          },
        } as AgentChatEventEnvelope,
      ];
      fs.writeFileSync(String(transcriptPath), `${rewindEnvelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(rewindEnvelopes);
      vi.mocked(runGit).mockImplementation(async (args) => {
        if (args[0] === "cat-file") {
          return { stdout: "", stderr: "fatal: transient cat-file failure", exitCode: 128 };
        }
        if (args[0] === "ls-tree") {
          return { stdout: "", stderr: "fatal: transient ls-tree failure", exitCode: 128 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      const result = await service.rewindFiles({
        sessionId: source.id,
        userMessageId: "user-1",
      });

      expect(result.canRewind).toBe(true);
      expect(result.conversationRollback).toBe(true);
      expect(result.filesChanged).toEqual([]);
      expect(fs.existsSync(changedFile)).toBe(true);
      expect(fs.readFileSync(changedFile, "utf8")).toBe("keep me");
      expect(vi.mocked(runGit).mock.calls.some(([args]) => args[0] === "checkout")).toBe(false);
    });

    it("does not recursively delete directories during Codex rewind", async () => {
      const { service, sessionService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        modelId: "openai/gpt-5.5",
      });
      source.threadId = "source-thread-1";
      source.status = "idle";
      mockState.codexResponseOverrides.set("thread/rollback", () => ({
        thread: { id: "source-thread-1" },
      }));
      const changedDir = path.join(tmpRoot, "src", "generated");
      const nestedFile = path.join(changedDir, "nested.ts");
      fs.mkdirSync(changedDir, { recursive: true });
      fs.writeFileSync(nestedFile, "keep nested", "utf8");
      const transcriptPath = sessionService.get(source.id)?.transcriptPath;
      expect(transcriptPath).toBeTruthy();
      const rewindEnvelopes: AgentChatEventEnvelope[] = [
        {
          sessionId: source.id,
          timestamp: "2026-07-07T20:00:00.000Z",
          event: {
            type: "user_message",
            messageId: "user-1",
            text: "create generated path",
            turnId: "turn-1",
          },
        } as AgentChatEventEnvelope,
        {
          sessionId: source.id,
          timestamp: "2026-07-07T20:00:01.000Z",
          event: {
            type: "turn_diff_summary",
            turnId: "turn-1",
            beforeSha: "before-sha",
            afterSha: "after-sha",
            files: [{ path: "src/generated", additions: 1, deletions: 0 }],
            totalAdditions: 1,
            totalDeletions: 0,
          },
        } as AgentChatEventEnvelope,
      ];
      fs.writeFileSync(String(transcriptPath), `${rewindEnvelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(rewindEnvelopes);
      vi.mocked(runGit).mockImplementation(async (args) => {
        if (args[0] === "cat-file") {
          return { stdout: "", stderr: "fatal: path absent", exitCode: 128 };
        }
        if (args[0] === "ls-tree") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      const result = await service.rewindFiles({
        sessionId: source.id,
        userMessageId: "user-1",
      });

      expect(result.canRewind).toBe(true);
      expect(result.conversationRollback).toBe(true);
      expect(result.filesChanged).toEqual([]);
      expect(fs.existsSync(nestedFile)).toBe(true);
      expect(fs.readFileSync(nestedFile, "utf8")).toBe("keep nested");
    });

    it("uses the selected Claude handoff permission instead of the source interaction mode", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-handoff",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Handoff received" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-handoff",
        setPermissionMode,
      } as any);

      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        interactionMode: "default",
        claudePermissionMode: "default",
        permissionMode: "default",
      });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        claudePermissionMode: "plan",
        permissionMode: "plan",
      });

      expect(result.session.provider).toBe("claude");
      expect(result.session.interactionMode).toBe("plan");
      expect(result.session.permissionMode).toBe("plan");
      await vi.waitFor(() => {
        expect(setPermissionMode).toHaveBeenCalledWith("plan");
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(expect.stringContaining("This message was injected automatically by ADE during a chat handoff."));
      });
    });

    it("forks Claude handoff from the source SDK session without injecting a summary prompt", async () => {
      const sourceSend = vi.fn().mockResolvedValue(undefined);
      const targetWarmupSend = vi.fn().mockResolvedValue(undefined);
      const forkWarmupSend = vi.fn().mockResolvedValue(undefined);
      const makeWarmHandle = (sdkSessionId: string, send: ReturnType<typeof vi.fn>) => ({
        send,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: sdkSessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: sdkSessionId,
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      });
      const sourceHandle = makeWarmHandle("legacy-source-sdk", sourceSend);
      const targetWarmupHandle = makeWarmHandle("legacy-target-sdk", targetWarmupSend);
      const forkWarmupHandle = makeWarmHandle("legacy-fork-sdk", forkWarmupSend);
      vi.mocked(claudeSdkCreateSessionCompat)
        .mockReturnValueOnce(sourceHandle as any)
        .mockReturnValueOnce(targetWarmupHandle as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(forkWarmupHandle as any);

      const { service, aiIntegrationService } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        interactionMode: "default",
        claudePermissionMode: "default",
        permissionMode: "default",
      });

      await vi.waitFor(() => {
        expect(readPersistedChatState(source.id).sdkSessionId).toBeTruthy();
      });
      const sourceSdkSessionId = readPersistedChatState(source.id).sdkSessionId as string;

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "anthropic/claude-sonnet-5",
        mode: "fork",
        claudePermissionMode: "plan",
        permissionMode: "plan",
      });

      expect(result.usedFallbackSummary).toBe(false);
      expect(result.session.provider).toBe("claude");
      expect(result.session.interactionMode).toBe("plan");
      expect(result.session.permissionMode).toBe("plan");
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(claudeSdkResumeSessionCompat).toHaveBeenCalledWith(
          sourceSdkSessionId,
          expect.objectContaining({
            forkSession: true,
            resume: sourceSdkSessionId,
            sessionId: expect.any(String),
          }),
        );
      });
      expect(readPersistedChatState(result.session.id).sdkSessionId).toBeTruthy();
      expect(readPersistedChatState(result.session.id).forkFromSdkSessionId).toBe(sourceSdkSessionId);
      for (const send of [sourceSend, targetWarmupSend, forkWarmupSend]) {
        expect(send).not.toHaveBeenCalledWith(expect.stringContaining("This message was injected automatically by ADE during a chat handoff."));
      }
    });

    it("does not carry a source interaction mode into non-Claude handoff targets", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const { service } = createService();
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      source.interactionMode = "plan";
      source.permissionMode = "plan";

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "opencode/openai/gpt-5.4-mini",
        opencodePermissionMode: "full-auto",
        permissionMode: "full-auto",
      });

      expect(result.session.provider).toBe("opencode");
      expect(result.session.interactionMode).toBeUndefined();
      expect(result.session.permissionMode).toBe("full-auto");
      expect(result.session.opencodePermissionMode).toBe("full-auto");
    });

    it("uses AI-generated handoff summaries when a summary model is available", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);
      vi.mocked(detectAllAuth).mockResolvedValue([
        { type: "api-key", provider: "openai" },
        { type: "cli-subscription", cli: "claude", authenticated: true },
      ] as any);
      const { service, sessionService, aiIntegrationService } = createService();
      vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
        text: [
          "## Current goal",
          "- Continue the same ADE work item.",
          "",
          "## Important decisions and preserved context",
          "- Reuse the previous lane context.",
          "",
          "## Files, commands, and errors to preserve",
          "- src/renderer/components/chat/AgentChatPane.tsx",
          "",
          "## Next action or open issue",
          "- Finish wiring the handoff flow.",
        ].join("\n"),
        structuredOutput: null,
        provider: "codex",
        model: "opencode/openai/gpt-5.4",
        sessionId: null,
        inputTokens: null,
        outputTokens: null,
        durationMs: 1,
      } as any);
      const source = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });
      sessionService.updateMeta({
        sessionId: source.id,
        goal: "Finish the handoff flow.",
      });

      const result = await service.handoffSession({
        sourceSessionId: source.id,
        targetModelId: "opencode/openai/gpt-5.4-mini",
      });

      expect(result.usedFallbackSummary).toBe(false);
      expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledWith(expect.objectContaining({
        taskType: "handoff_summary",
      }));
    });
  });

  describe("lane launch directives", () => {
    it("injects the selected lane worktree into the first opencode user turn only", async () => {
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the repo and fix the launch bug.",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Now add tests.",
      });

      const promptCalls = vi.mocked(buildOpenCodePromptParts).mock.calls;
      const firstUserContent = String(promptCalls[0]?.[0]?.prompt ?? "");
      const secondUserContent = String(promptCalls[1]?.[0]?.prompt ?? "");
      const openCodeStartCalls = vi.mocked(startOpenCodeSession).mock.calls;

      expect(openCodeStartCalls.length).toBeGreaterThan(0);
      expect(openCodeStartCalls[0]?.[0]).toEqual(expect.objectContaining({
        leaseKind: "shared",
      }));
      expect(firstUserContent).toContain("[ADE launch directive]");
      expect(firstUserContent).toContain(tmpRoot);
      expect(firstUserContent).toContain("Read-only inspection outside that worktree is allowed");
      expect(firstUserContent).toContain("mutating commands only inside that worktree");
      expect(firstUserContent).toContain("control plane for ADE state");
      expect(firstUserContent).toContain("ade actions list --text");
      expect(secondUserContent).not.toContain("[ADE launch directive]");
      expect(secondUserContent).toContain("control plane for ADE state");
    });

    it("starts Codex sessions without ADE-owned tool server injection", async () => {
      const laneRootPath = path.join(tmpRoot, "lane-2");
      fs.mkdirSync(laneRootPath, { recursive: true });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-2",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo and fix the lane launch bug.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      const startPayload = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect(startPayload?.params).toMatchObject({
        cwd: expect.stringContaining("lane-2"),
        developerInstructions: "system prompt",
      });

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnParams = turnStartRequest?.params as {
        input?: Array<{ text?: unknown }>;
        collaborationMode?: { settings?: { developer_instructions?: unknown } };
      } | undefined;
      const textInput = turnParams?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(turnParams?.collaborationMode?.settings?.developer_instructions).toBe("system prompt");
      expect(textInput).not.toContain("control plane for ADE state");
      expect(textInput).not.toContain("ade actions list --text");
      expect(textInput).toContain("Inspect the repo and fix the lane launch bug.");
    });

    it("adds dynamic orchestration tools to Codex orchestrator threads", async () => {
      const { orchestrationService, created } = await createLoadedOrchestrationRun("S-lead");
      try {
        const { service } = createService({
          getOrchestrationService: () => orchestrationService,
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
          interactionMode: "orchestrator-lead",
          orchestrationRunId: created.runId,
          orchestrationRole: "lead",
          orchestrationBundlePath: created.manifest.bundlePath,
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Plan the work.",
        });

        await vi.waitFor(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
        });

        const startPayload = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start") as any;
        const dynamicTools = startPayload?.params?.dynamicTools ?? [];
        const toolNames = dynamicTools.map((entry: { name?: string }) => entry.name);
        expect(toolNames).toEqual(expect.arrayContaining(["spawnAgent", "messageAgent", "getAgentTranscript"]));
        expect(toolNames).not.toContain("editFile");
        expect(toolNames).not.toContain("writeFile");
        expect(toolNames).not.toContain("bash");
        expect(dynamicTools.every((entry: { namespace?: string }) => entry.namespace === "ade_orchestration")).toBe(true);
        expect(startPayload?.params).toMatchObject({
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        });

        expect(toolNames.length).toBeGreaterThan(5);
      } finally {
        await orchestrationService.dispose();
      }
    });

    it("attaches ADE orchestration tools to OpenCode orchestrator sessions through MCP", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any);
      const { orchestrationService, created } = await createLoadedOrchestrationRun("S-lead");
      try {
        const { service } = createService({
          getOrchestrationService: () => orchestrationService,
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "opencode",
          model: "",
          modelId: "opencode/openai/gpt-5.4",
          interactionMode: "orchestrator-lead",
          orchestrationRunId: created.runId,
          orchestrationRole: "lead",
          orchestrationBundlePath: created.manifest.bundlePath,
        });

        await service.runSessionTurn({
          sessionId: session.id,
          text: "Plan the work.",
        });

        const startArgs = vi.mocked(startOpenCodeSession).mock.calls.at(-1)?.[0] as any;
        expect(startArgs?.mcp?.["ade-orchestration"]).toMatchObject({
          type: "remote",
          enabled: true,
          url: expect.stringContaining("/mcp"),
        });
      } finally {
        await orchestrationService.dispose();
      }
    });

    it("attaches ADE orchestration tools to Cursor SDK orchestrator sessions through MCP", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { orchestrationService, created } = await createLoadedOrchestrationRun("S-lead");
      try {
        const { service } = createService({
          getOrchestrationService: () => orchestrationService,
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "cursor",
          model: "composer-2",
          modelId: "cursor/composer-2",
          interactionMode: "orchestrator-lead",
          orchestrationRunId: created.runId,
          orchestrationRole: "lead",
          orchestrationBundlePath: created.manifest.bundlePath,
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Plan the work.",
        }, { awaitDispatch: true });

        expect(mockState.cursorSdkAcquireCalls.at(-1)?.mcpServers).toMatchObject({
          "ade-orchestration": {
            type: "http",
            url: expect.stringContaining("/mcp"),
          },
        });
      } finally {
        await orchestrationService.dispose();
      }
    });

    it("attaches ADE orchestration tools to Droid SDK orchestrator sessions through MCP", async () => {
      const { orchestrationService, created } = await createLoadedOrchestrationRun("S-lead");
      try {
        const { service } = createService({
          getOrchestrationService: () => orchestrationService,
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "droid",
          model: "custom:claude-sonnet-5-thinking-32000",
          modelId: "droid/custom:claude-sonnet-5-thinking-32000",
          interactionMode: "orchestrator-lead",
          orchestrationRunId: created.runId,
          orchestrationRole: "lead",
          orchestrationBundlePath: created.manifest.bundlePath,
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Plan the work.",
        }, { awaitDispatch: true });

        expect(mockState.droidAcquireCalls.at(-1)?.mcpServers).toEqual([
          expect.objectContaining({
            type: "http",
            name: "ade-orchestration",
            url: expect.stringContaining("/mcp"),
          }),
        ]);
      } finally {
        await orchestrationService.dispose();
      }
    });

    it("passes the selected Codex reasoning effort into app-server config", async () => {
      const laneRootPath = path.join(tmpRoot, "lane-2");
      fs.mkdirSync(laneRootPath, { recursive: true });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-2",
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "low",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo and report status.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      expect(spawn).toHaveBeenCalledWith(
        "codex",
        ["app-server", "-c", "model_reasoning_effort=\"low\""],
        expect.any(Object),
      );

      const startPayload = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const startParams = startPayload?.params as {
        config?: { model_reasoning_effort?: unknown };
        effort?: unknown;
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
      } | undefined;
      expect(startParams?.config?.model_reasoning_effort).toBe("low");
      expect(startParams?.effort).toBeUndefined();
      expect(startParams?.reasoningEffort).toBeUndefined();
      expect(startParams?.reasoning_effort).toBeUndefined();
    });

    it("routes new Codex chats to GPT-5.6 Sol with its low default", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
      });

      expect(session).toMatchObject({
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
        reasoningEffort: "low",
      });
      await service.sendMessage({ sessionId: session.id, text: "Reply only OK." });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStart = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect(threadStart?.params).toMatchObject({
        model: "gpt-5.6-sol",
        config: { model_reasoning_effort: "low" },
      });
      const turnStart = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect(turnStart?.params).toMatchObject({
        model: "gpt-5.6-sol",
        effort: "low",
      });
    });

    it("sends literal Ultra effort for Sol without aliasing it to xhigh", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
        reasoningEffort: "ultra",
      });

      await service.sendMessage({ sessionId: session.id, text: "Inspect the repo." });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStart = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect((threadStart?.params as { config?: { model_reasoning_effort?: unknown } })?.config?.model_reasoning_effort).toBe("ultra");
      const turnStart = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((turnStart?.params as { effort?: unknown })?.effort).toBe("ultra");
    });

    it("spawns Codex with ADE CLI agent env injected", async () => {
      const laneRootPath = path.join(tmpRoot, "lane-2");
      fs.mkdirSync(laneRootPath, { recursive: true });
      const getAdeCliAgentEnv = vi.fn(() => ({
        PATH: "/tmp/ade-cli/bin",
        ADE_CLI_PATH: "/tmp/ade-cli/bin/ade",
        ADE_CLI_BIN_DIR: "/tmp/ade-cli/bin",
      }));

      const { service } = createService({ getAdeCliAgentEnv });
      const session = await service.createSession({
        laneId: "lane-2",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run doctor and inspect lane status.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      expect(getAdeCliAgentEnv).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledWith(
        "codex",
        ["app-server", "-c", "model_reasoning_effort=\"medium\""],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: "/tmp/ade-cli/bin",
            ADE_CLI_PATH: "/tmp/ade-cli/bin/ade",
            ADE_CLI_BIN_DIR: "/tmp/ade-cli/bin",
          }),
        }),
      );
      const spawnCall = vi.mocked(spawn).mock.calls.find((call) =>
        call[0] === "codex" && Array.isArray(call[1]) && call[1].includes("app-server")
      );
      const spawnArgs = spawnCall?.[1] as string[] | undefined;
      expect(spawnArgs).toBeDefined();
      expect(spawnArgs).not.toContain("--disable");
      expect(spawnArgs).not.toContain("browser_use");
      expect(spawnArgs).not.toContain("computer_use");
    });

    it("passes raw CLI access env to the Cursor SDK pool for worker sanitization", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const getAdeCliAgentEnv = vi.fn(() => ({
        PATH: "/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin:/usr/bin",
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_HOME: "/Users/admin/.ade-beta",
        ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_RPC_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_CLI_PATH: "/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin/ade-beta",
        ADE_CLI_BIN_DIR: "/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin",
        ADE_CLI_ENTRY_PATH: "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs",
        ADE_CLI_JS: "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs",
        ADE_CLI_INSTALL_NAME: "ade-beta",
      }));

      const { service } = createService({ getAdeCliAgentEnv });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run locally.",
      }, { awaitDispatch: true });

      expect(getAdeCliAgentEnv).toHaveBeenCalled();
      const baseEnv = mockState.cursorSdkAcquireCalls.at(-1)?.baseEnv as NodeJS.ProcessEnv | undefined;
      expect(baseEnv).toEqual(expect.objectContaining({
        ADE_CLI_PATH: "/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin/ade-beta",
        ADE_CLI_BIN_DIR: "/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin",
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_HOME: "/Users/admin/.ade-beta",
        ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_RPC_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_CLI_ENTRY_PATH: "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs",
        ADE_CLI_JS: "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs",
        ADE_CLI_INSTALL_NAME: "ade-beta",
        ADE_CHAT_SESSION_ID: session.id,
        ADE_LANE_ID: "lane-1",
        ADE_PROJECT_ROOT: tmpRoot,
      }));
    });
  });

  // --------------------------------------------------------------------------
  // listSessions
  // --------------------------------------------------------------------------

  describe("listSessions", () => {
    it("returns empty array when no sessions exist", async () => {
      const { service } = createService();
      const sessions = await service.listSessions();
      expect(sessions).toEqual([]);
    });

    it("returns created sessions", async () => {
      const { service } = createService();

      await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.provider).toBe("opencode");
    });

    it("lists chat sessions even when newer shell sessions exceed the terminal list cap", async () => {
      const { service, sessionService } = createService();

      const chat = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5-codex",
      });

      for (let i = 0; i < 505; i++) {
        sessionService.create({
          sessionId: `shell-session-${i}`,
          laneId: "lane-1",
          toolType: "shell",
          title: `Shell ${i}`,
          startedAt: new Date(Date.UTC(2026, 2, 17, 0, 10, i)).toISOString(),
        });
      }

      const sessions = await service.listSessions("lane-1");
      expect(sessions.map((session) => session.sessionId)).toContain(chat.id);
      expect(sessionService.list).toHaveBeenLastCalledWith(expect.objectContaining({
        laneId: "lane-1",
        limit: 500,
        toolTypes: expect.arrayContaining(["codex-chat", "claude-chat", "opencode-chat", "cursor", "droid-chat"]),
      }));
    });

    it("excludes identity sessions by default", async () => {
      const { service } = createService();

      await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        identityKey: "cto",
      });

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(0);

      const sessionsWithIdentity = await service.listSessions(undefined, { includeIdentity: true });
      expect(sessionsWithIdentity.length).toBe(1);
    });

    it("excludes automation sessions by default", async () => {
      const { service } = createService();

      await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        surface: "automation",
      });

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(0);

      const sessionsWithAutomation = await service.listSessions(undefined, { includeAutomation: true });
      expect(sessionsWithAutomation.length).toBe(1);
    });

    it("keeps archived sessions by default and can filter them out", async () => {
      const { service } = createService();

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      await service.archiveSession({ sessionId: session.id });

      const sessions = await service.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.archivedAt).toEqual(expect.any(String));

      await expect(service.listSessions(undefined, { includeArchived: false })).resolves.toEqual([]);
    });

    it("does not expose completion summaries as the session summary before the chat is ended", async () => {
      const { service } = createService();

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        completion: {
          status: "completed",
          summary: "Wrapped up the first pass and proposed a follow-up.",
        },
      });

      const sessions = await service.listSessions();
      expect(sessions[0]?.summary).toBeNull();
    });

    it("hydrates requestedCwd, cursorConfigValues, and awaitingInput from persisted summaries", async () => {
      const { service, sessionService } = createService();
      sessionService.create({
        sessionId: "restored-cursor-session",
        laneId: "lane-1",
        toolType: "cursor",
        title: "Restored Cursor chat",
        startedAt: "2026-03-25T00:00:00.000Z",
      });

      writePersistedChatState("restored-cursor-session", {
        version: 2,
        sessionId: "restored-cursor-session",
        laneId: "lane-1",
        provider: "cursor",
        model: "auto",
        modelId: "cursor/auto",
        cursorModeId: "ask",
        cursorConfigValues: {
          voice: true,
          temperature: 0.5,
          notes: "mobile",
        },
        awaitingInput: true,
        requestedCwd: "apps/ios/ADE",
        updatedAt: "2026-03-25T00:00:05.000Z",
      });

      await expect(service.listSessions()).resolves.toMatchObject([
        expect.objectContaining({
          sessionId: "restored-cursor-session",
          cursorModeId: "ask",
          cursorConfigValues: {
            voice: true,
            temperature: 0.5,
            notes: "mobile",
          },
          awaitingInput: true,
          requestedCwd: "apps/ios/ADE",
        }),
      ]);
    });
  });

  describe("ensureIdentitySession", () => {
    it("hosts canonical identity sessions on the primary lane", async () => {
      const { service } = createService();

      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(session.laneId).toBe("lane-1");
      expect(session.permissionMode).toBe("full-auto");
    });

    it("reuses a foreign-lane CTO session and rebinds it onto the canonical lane", async () => {
      // The CTO is a single project-level thread (D5): a session left on a
      // non-canonical lane must be reused and rebound to the canonical lane
      // rather than forking a second parallel thread.
      const { service, sessionService } = createService();

      const legacy = await service.createSession({
        laneId: "lane-2",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        identityKey: "cto",
      });

      const canonical = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(canonical.id).toBe(legacy.id);
      expect(canonical.laneId).toBe("lane-1");
      expect(sessionService.get(legacy.id)?.laneId).toBe("lane-1");
      expect(sessionService.get(legacy.id)?.status).not.toBe("ended");

      const reused = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(reused.id).toBe(canonical.id);
      expect(reused.laneId).toBe("lane-1");
    });

    it("pins CTO execution state to the primary lane even when a foreign lane is requested", async () => {
      vi.mocked(runGit).mockImplementation(async (_args, opts) => ({
        stdout: String(opts?.cwd ?? "").includes(path.join(tmpRoot, "lane-2")) ? "lane-2-sha\n" : "lane-1-sha\n",
        stderr: "",
        exitCode: 0,
      }));

      const { service, sessionService } = createService();
      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-2",
      });

      expect(sessionService.setHeadShaStart).toHaveBeenLastCalledWith(session.id, "lane-1-sha");
    });

    it("ignores native provider permission overrides for pinned identities on create", async () => {
      const { service } = createService();
      // Callers over IPC could previously pass through `claudePermissionMode:
      // "plan"` to keep a CTO session from ever running automatically — the
      // identity pin must strip these so full-auto still wins.
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-4-7",
        modelId: "claude-sonnet-4-7",
        identityKey: "cto",
        claudePermissionMode: "plan",
        interactionMode: "plan",
      });

      // `plan` must never be persisted on the claude native fields for a
      // pinned identity — otherwise the runtime will ignore full-auto at turn
      // start. We do not assert on the synthesized permissionMode here because
      // the top-level mock for mapPermissionToClaude collapses to "plan" in
      // this test file; the native fields are the real source of truth the
      // runtime consults.
      expect(session.claudePermissionMode).not.toBe("plan");
      expect(session.interactionMode).not.toBe("plan");
    });

    it("ignores native codex permission overrides for the CTO identity on create", async () => {
      // Locally map modes so full-auto => danger-full-access / never and the
      // default mapping (used when no permissionMode is passed) stays on the
      // on-request / read-only baseline. This lets us prove the IPC-provided
      // `codexApprovalPolicy: "untrusted"` / `codexSandbox: "read-only"` never
      // land on the session — the full-auto derivation is used instead.
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        if (mode === "edit") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5-codex",
        modelId: "gpt-5-codex",
        identityKey: "cto",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
      });

      expect(session.codexApprovalPolicy).toBe("never");
      expect(session.codexSandbox).toBe("danger-full-access");
    });

    it("ignores native permission overrides for pinned identities on update", async () => {
      const { service } = createService();
      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-1",
      });
      const claudeBefore = session.claudePermissionMode;
      const opencodeBefore = session.opencodePermissionMode;

      const updated = await service.updateSession({
        sessionId: session.id,
        claudePermissionMode: "plan",
        interactionMode: "plan",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        opencodePermissionMode: "plan",
      });

      // None of the stricter native modes should have landed on the session.
      expect(updated.interactionMode).not.toBe("plan");
      if (claudeBefore !== undefined) {
        expect(updated.claudePermissionMode).toBe(claudeBefore);
      }
      if (opencodeBefore !== undefined) {
        expect(updated.opencodePermissionMode).toBe(opencodeBefore);
      }
      expect(updated.codexApprovalPolicy).not.toBe("untrusted");
      expect(updated.codexSandbox).not.toBe("read-only");
    });
  });

  describe("CTO memory + model-switch-safe thread", () => {
    async function createCtoServices() {
      const adeDir = path.join(tmpRoot, ".ade");
      fs.mkdirSync(adeDir, { recursive: true });
      const db = await openKvDb(path.join(adeDir, "ade.db"), createLogger() as any);
      const ctoMemoryService = createCtoMemoryService({ adeDir });
      const ctoStateService = createCtoStateService({
        db,
        projectId: "project-test",
        adeDir,
        ctoMemoryService,
      });
      return { db, ctoStateService, ctoMemoryService };
    }

    it("persists a CTO model switch back into identity model preferences (D3)", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      const { service } = createService({ ctoStateService, ctoMemoryService });

      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-1",
      });

      await service.updateSession({
        sessionId: session.id,
        modelId: "opencode/openai/gpt-5.2",
      });

      const prefs = ctoStateService.getIdentity().modelPreferences;
      expect(prefs.modelId).toBe("opencode/openai/gpt-5.2");
      expect(prefs.provider).toBe("opencode");

      db.close();
    });

    it("injects durable memory into the CTO reconstruction context", async () => {
      const { db, ctoStateService, ctoMemoryService } = await createCtoServices();
      ctoMemoryService.appendMemoryFact("The build long-pole is the Windows runner.");
      const { service } = createService({ ctoStateService, ctoMemoryService });

      const session = await service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-1",
      });

      // ensureIdentitySession refreshes the reconstruction context; the durable
      // memory fact must be present so it survives a fresh provider thread.
      const reconstruction = ctoStateService.buildReconstructionContext(8);
      expect(reconstruction).toContain("Durable memory (MEMORY.md)");
      expect(reconstruction).toContain("The build long-pole is the Windows runner.");
      expect(session.identityKey).toBe("cto");

      db.close();
    });
  });

  describe("identity continuity", () => {
    it("replays persisted continuity context after resuming an identity session", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall <= 2) {
          yield {
            type: "system",
            subtype: "init",
            session_id: `sdk-session-${streamCall}`,
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Acknowledged" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      const sdkHandle = {
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sdkHandle);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sdkHandle);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });

      const persisted = readPersistedChatState(session.id);
      writePersistedChatState(session.id, {
        ...persisted,
        continuitySummary: "- Keep runtime cache state machine-local.",
        continuitySummaryUpdatedAt: new Date().toISOString(),
        recentConversationEntries: [
          { role: "user", text: "What lane should frontend use?" },
          { role: "assistant", text: "Use the primary-hosted coordinator first." },
        ],
      });

      const resumed = createService().service;
      await resumed.resumeSession({ sessionId: session.id });
      await new Promise((resolve) => setTimeout(resolve, 20));
      send.mockClear();

      const result = await resumed.runSessionTurn({
        sessionId: session.id,
        text: "What should we do next?",
        timeoutMs: 15_000,
      });

      expect(result.sessionId).toBe(session.id);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Continuity Summary"));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Keep runtime cache state machine-local."));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("User: What lane should frontend use?"));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Assistant: Use the primary-hosted coordinator first."));
    });

    it("reconstructs recent conversation tail for non-identity Claude sessions after resume", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-non-identity",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        yield {
          type: "assistant",
          session_id: "sdk-session-non-identity",
          message: {
            content: [{ type: "text", text: "We should keep the lane state intact." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      const sdkHandle = {
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-non-identity",
        setPermissionMode,
      } as any;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sdkHandle);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sdkHandle);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const persisted = readPersistedChatState(session.id);
      writePersistedChatState(session.id, {
        ...persisted,
        recentConversationEntries: [
          { role: "user", text: "Can you keep the lane warm?" },
          { role: "assistant", text: "Yes, I will keep the lane session alive." },
        ],
      });

      const resumed = createService().service;
      await resumed.resumeSession({ sessionId: session.id });
      await new Promise((resolve) => setTimeout(resolve, 20));
      send.mockClear();

      const result = await resumed.runSessionTurn({
        sessionId: session.id,
        text: "What changed?",
        timeoutMs: 15_000,
      });

      expect(result.sessionId).toBe(session.id);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Recent Conversation Tail"));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("User: Can you keep the lane warm?"));
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Assistant: Yes, I will keep the lane session alive."));
      expect(send).not.toHaveBeenCalledWith(expect.stringContaining("Continuity Summary"));
    });

    it("recreates Claude sessions fresh when a resumed SDK session rejects bypassPermissions", async () => {
      let initialStreamCall = 0;
      const initialSession = {
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          initialStreamCall += 1;
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-initial",
            slash_commands: [],
          };
          if (initialStreamCall > 1) {
            yield {
              type: "assistant",
              session_id: "sdk-initial",
              message: {
                content: [{ type: "text", text: "Primed" }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
          }
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: "sdk-initial",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(initialSession as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "prime",
        timeoutMs: 15_000,
      });
      const persistedAfterPrime = readPersistedChatState(session.id);
      expect(persistedAfterPrime.lastLaneDirectiveKey).toBeTruthy();
      await service.dispose({ sessionId: session.id });

      writePersistedChatState(session.id, {
        ...persistedAfterPrime,
        sdkSessionId: "sdk-stale",
        lastLaneDirectiveKey: persistedAfterPrime.lastLaneDirectiveKey,
        claudePermissionMode: "bypassPermissions",
        permissionMode: "full-auto",
      });

      const staleSession = {
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(),
        close: vi.fn(),
        sessionId: "sdk-stale",
        setPermissionMode: vi.fn().mockRejectedValue(new Error("mode rejected")),
      };
      const freshSession = {
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-fresh",
            slash_commands: [],
          };
          yield {
            type: "assistant",
            session_id: "sdk-fresh",
            message: {
              content: [{ type: "text", text: "Recovered" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: "sdk-fresh",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(claudeSdkResumeSessionCompat).mockReset();
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(staleSession as any);
      vi.mocked(claudeSdkCreateSessionCompat).mockReset();
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(freshSession as any);

      const resumed = createService().service;
      await resumed.resumeSession({ sessionId: session.id });
      const result = await resumed.runSessionTurn({
        sessionId: session.id,
        text: "continue",
        timeoutMs: 15_000,
      });

      expect(result.outputText).toContain("Recovered");
      expect(claudeSdkResumeSessionCompat).toHaveBeenCalledWith(
        "sdk-stale",
        expect.objectContaining({ resume: "sdk-stale" }),
      );
      expect(claudeSdkCreateSessionCompat).toHaveBeenCalledWith(expect.objectContaining({
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      }));
      expect(staleSession.close).toHaveBeenCalled();
      expect(freshSession.send).toHaveBeenCalled();
      expect(readPersistedChatState(session.id).sdkSessionId).toBe("sdk-fresh");
    });

    it("persists a continuity snapshot and prewarms a fresh Claude session after identity session reset errors", async () => {
      const primarySend = vi.fn().mockResolvedValue(undefined);
      const recoverySend = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let primaryStreamCall = 0;
      const primarySession = {
        send: primarySend,
        stream: vi.fn(() => (async function* () {
          primaryStreamCall += 1;
          if (primaryStreamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-session-1",
              slash_commands: [],
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "assistant",
            session_id: "sdk-session-1",
            message: {
              content: [{ type: "text", text: "Partial answer" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          throw new Error("session expired");
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };
      const recoverySession = {
        send: recoverySend,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-2",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-2",
        setPermissionMode,
      };
      vi.mocked(claudeSdkCreateSessionCompat)
        .mockReturnValueOnce(primarySession as any)
        .mockReturnValueOnce(recoverySession as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Please keep the runtime bridge state private.",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const persisted = readPersistedChatState(session.id);
      expect(result.outputText).toContain("Partial answer");
      expect(persisted.sdkSessionId).toEqual(expect.any(String));
      expect(persisted.sdkSessionId).not.toBe("sdk-session-1");
      expect(persisted.continuitySummary).toContain("Recent continuity snapshot:");
      expect(persisted.continuitySummary).toContain("User: Please keep the runtime bridge state private.");
      expect(persisted.continuitySummary).toContain("Assistant: Partial answer");
      expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(2);
      expect(recoverySend).toHaveBeenCalledWith("System initialization check. Respond with only the word READY.");
    });

    it("keeps continuity compaction scoped to identity sessions", async () => {
      const primarySend = vi.fn().mockResolvedValue(undefined);
      const recoverySend = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let primaryStreamCall = 0;
      const primarySession = {
        send: primarySend,
        stream: vi.fn(() => (async function* () {
          primaryStreamCall += 1;
          if (primaryStreamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-session-1",
              slash_commands: [],
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "assistant",
            session_id: "sdk-session-1",
            message: {
              content: [{ type: "text", text: "Partial answer" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          throw new Error("session expired");
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };
      const recoverySession = {
        send: recoverySend,
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-2",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-2",
        setPermissionMode,
      };
      vi.mocked(claudeSdkCreateSessionCompat)
        .mockReturnValueOnce(primarySession as any)
        .mockReturnValueOnce(recoverySession as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Please keep the bridge state private.",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const persisted = readPersistedChatState(session.id);
      expect(result.outputText).toContain("Partial answer");
      expect(persisted.continuitySummary).toBeUndefined();
      expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(2);
    });
  });

  describe("compaction flush", () => {
    it("emits context_compact without a user_message carrying the flush prompt", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-compact",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        yield {
          type: "system",
          subtype: "compact_boundary",
          session_id: "sdk-session-compact",
          compact_metadata: { trigger: "auto", pre_tokens: 150_000 },
        };
        yield {
          type: "assistant",
          session_id: "sdk-session-compact",
          message: {
            content: [{ type: "text", text: "Continuing after compaction" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-compact",
        setPermissionMode,
      } as any);

      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "keep going",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const compactEvents = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "context_compact");
      expect(compactEvents).toHaveLength(1);
      expect(compactEvents[0].event).toMatchObject({
        type: "context_compact",
        trigger: "auto",
        preTokens: 150_000,
      });

      const leakedUserMessages = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) =>
          env?.event?.type === "user_message"
          && typeof env.event.text === "string"
          && env.event.text.includes("Before context compaction runs"),
        );
      expect(leakedUserMessages).toHaveLength(0);

      // Defence in depth: the pre-fix leak happened when main.ts reacted to
      // the context_compact chat event by calling steer(), which pushed the
      // flush prompt to the SDK via send(). Assert the SDK never received a
      // turn whose payload contains the flush-prompt text, regardless of
      // whether the leak originated from the SDK side or a downstream handler.
      const flushedSends = send.mock.calls.filter(([payload]) =>
        typeof payload === "string"
          ? payload.includes("Before context compaction runs")
          : JSON.stringify(payload ?? "").includes("Before context compaction runs"),
      );
      expect(flushedSends).toHaveLength(0);
    });

    it("emits a context_compact begin (started) when Claude reports compacting status", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-session-compacting", slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Begin: SDK status flips to "compacting" before the boundary lands.
        yield { type: "system", subtype: "status", session_id: "sdk-session-compacting", status: "compacting" };
        // End: the compact boundary marks completion with the real trigger/tokens.
        yield {
          type: "system",
          subtype: "compact_boundary",
          session_id: "sdk-session-compacting",
          compact_metadata: { trigger: "manual", pre_tokens: 120_000 },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-compacting",
        setPermissionMode,
      } as any);

      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await service.runSessionTurn({ sessionId: session.id, text: "keep going", timeoutMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const compactEvents = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "context_compact")
        .map((env: any) => env.event);
      // A live begin, then a completed end — no longer a plain gray "Compacting..." notice.
      expect(compactEvents).toEqual([
        expect.objectContaining({ type: "context_compact", state: "started" }),
        expect.objectContaining({ type: "context_compact", state: "completed", trigger: "manual", preTokens: 120_000 }),
      ]);
      const compactingNotices = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "system_notice"
          && typeof env.event.message === "string"
          && env.event.message.includes("Compacting conversation context"));
      expect(compactingNotices).toHaveLength(0);
    });

    it("emits a rate-limit notice when the Claude SDK reports usage pressure", async () => {
      vi.useFakeTimers();
      const send = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        yield {
          type: "rate_limit_event",
          session_id: "sdk-session-rate-limit",
          rate_limit_info: {
            status: "allowed_warning",
            utilization: 0.82,
            resetsAt: 1_770_000_000,
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-session-rate-limit",
      } as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-session-rate-limit",
      } as any);

      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      try {
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        await service.runSessionTurn({
          sessionId: session.id,
          text: "show usage pressure",
          timeoutMs: 15_000,
        });

        let rateLimitNotices = onEvent.mock.calls
          .map((call) => call[0])
          .filter((env: any) => env?.event?.type === "system_notice" && env.event.noticeKind === "rate_limit");
        expect(rateLimitNotices).toHaveLength(1);
        expect(rateLimitNotices[0].event).toMatchObject({
          type: "system_notice",
          noticeKind: "rate_limit",
          severity: "info",
          status: "allowed_warning",
          message: "Approaching Claude plan limit",
        });
        expect(rateLimitNotices[0].event.detail).toContain("82% utilized");
        expect(rateLimitNotices[0].event.detail).toContain("resets");

        await vi.advanceTimersByTimeAsync(6 * 60_000);
        expect(close).toHaveBeenCalledTimes(1);

        await service.runSessionTurn({
          sessionId: session.id,
          text: "show usage pressure again",
          timeoutMs: 15_000,
        });

        rateLimitNotices = onEvent.mock.calls
          .map((call) => call[0])
          .filter((env: any) => env?.event?.type === "system_notice" && env.event.noticeKind === "rate_limit");
        expect(rateLimitNotices).toHaveLength(1);
        expect(claudeSdkCreateSessionCompat.mock.calls.some(([options]) =>
          options?.pathToClaudeCodeExecutable === "/usr/local/bin/claude",
        )).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces Claude SDK retry, refusal fallback, informational, memory, notification, mirror, and denial events", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        if (streamCall === 2) {
          yield {
            type: "system",
            subtype: "api_retry",
            session_id: "sdk-session-events",
            attempt: 1,
            max_retries: 3,
            retry_delay_ms: 2_000,
            error_status: 529,
            error: "overloaded",
          };
          yield {
            type: "system",
            subtype: "informational",
            session_id: "sdk-session-events",
            content: "Prompt blocked by hook",
            level: "warning",
            prevent_continuation: true,
          };
          yield {
            type: "system",
            subtype: "permission_denied",
            session_id: "sdk-session-events",
            tool_name: "Bash",
            tool_use_id: "tool-denied-direct",
            decision_reason_type: "classifier",
            decision_reason: "blocked by safety policy",
            message: "Denied",
          };
          yield {
            type: "system",
            subtype: "model_refusal_fallback",
            session_id: "sdk-session-events",
            original_model: "claude-opus-4-8",
            fallback_model: "claude-sonnet-5",
            api_refusal_category: "cyber",
            api_refusal_explanation: "The original model refused.",
            content: "Retrying on fallback model.",
            retracted_message_uuids: ["refused-message-1", "refused-tool-result-1"],
          };
          yield {
            type: "system",
            subtype: "notification",
            session_id: "sdk-session-events",
            key: "heads-up",
            text: "Background monitor finished",
            priority: "high",
          };
          yield {
            type: "system",
            subtype: "memory_recall",
            session_id: "sdk-session-events",
            mode: "select",
            memories: [{
              path: "/tmp/memory.md",
              scope: "personal",
              content: "Prefer small focused patches.",
            }],
          };
          yield {
            type: "system",
            subtype: "mirror_error",
            session_id: "sdk-session-events",
            error: "store unavailable",
          };
          // This replayed/historical shutdown should be ignored because a
          // result follows it in the same stream.
          yield {
            type: "system",
            subtype: "worker_shutting_down",
            session_id: "sdk-session-events",
            reason: "host_exit",
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
            permission_denials: [
              { tool_name: "Bash", tool_use_id: "tool-denied-direct" },
            ],
          };
          return;
        }

        return;
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-session-events",
      } as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-session-events",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "show new sdk event handling",
        timeoutMs: 15_000,
      });

      const notices = events
        .map((envelope) => envelope.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
          event.type === "system_notice",
        );
      expect(notices.some((event) => {
        const detail = typeof event.detail === "string" ? event.detail : "";
        return event.noticeKind === "rate_limit"
          && event.message === "Claude API retry 1/3: overloaded"
          && detail.includes("HTTP 529")
          && detail.includes("retrying in 2s");
      })).toBe(true);
      expect(notices.some((event) =>
        event.noticeKind === "warning"
        && event.message === "Prompt blocked by hook",
      )).toBe(true);
      expect(notices.some((event) =>
        event.message === "Claude denied Bash: blocked by safety policy"
        && event.detail === "classifier",
      )).toBe(true);
      expect(notices.some((event) =>
        event.status === "model_refusal_fallback"
        && event.message === "Claude retried with claude-sonnet-5 after claude-opus-4-8 refused the request.",
      )).toBe(true);
      const refusalFallbackNotice = notices.find((event) => event.status === "model_refusal_fallback");
      expect(refusalFallbackNotice?.detail).toContain("retracted 2 SDK messages: refused-message-1, refused-tool-result-1");
      expect(notices.some((event) =>
        event.status === "notification"
        && event.noticeKind === "warning"
        && event.message === "Background monitor finished",
      )).toBe(true);
      expect(notices.some((event) =>
        event.status === "memory_recall"
        && event.message === "Claude recalled 1 memory.",
      )).toBe(true);
      expect(notices.some((event) =>
        event.status === "mirror_error"
        && event.noticeKind === "error"
        && event.detail === "store unavailable",
      )).toBe(true);
      expect(notices.filter((event) => event.message.includes("denied this turn"))).toHaveLength(0);
      expect(notices.filter((event) => event.status === "worker_shutting_down")).toHaveLength(0);
    });

    it("surfaces Claude prompt suggestions emitted after the result message", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        yield {
          type: "prompt_suggestion",
          session_id: "sdk-session-prompt-suggestion",
          uuid: "suggestion-1",
          suggestion: "Audit the Work tab",
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-prompt-suggestion",
      } as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-prompt-suggestion",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "suggest the next prompt",
        timeoutMs: 15_000,
      });

      const eventTypes = events.map((envelope) => envelope.event.type);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "prompt_suggestion",
            suggestion: "Audit the Work tab",
          }),
        }),
      ]));
      expect(eventTypes.indexOf("prompt_suggestion")).toBeLessThan(eventTypes.indexOf("done"));
      expect(service.getChatEventHistory(session.id, { maxEvents: 50 }).events
        .some((event) => event.event.type === "prompt_suggestion")).toBe(false);
    });

    it("continues draining stale post-result tail messages after a prompt suggestion", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let streamCall = 0;
        let releaseFollowUpStream!: () => void;
        const followUpStreamReady = new Promise<void>((resolve) => {
          releaseFollowUpStream = resolve;
        });
        const send = vi.fn(async (message: unknown) => {
          const text = String(legacyClaudeSendPayload(message));
          if (text.includes("follow up after the drained suggestion")) {
            releaseFollowUpStream();
          }
        });
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "result",
            session_id: "sdk-session-drain-after-suggestion",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          yield {
            type: "prompt_suggestion",
            session_id: "sdk-session-drain-after-suggestion",
            uuid: "suggestion-tail-1",
            suggestion: "Audit the next action",
          };
          yield {
            type: "tool_use_summary",
            session_id: "sdk-session-drain-after-suggestion",
            summary: "This stale summary should stay out of the next turn",
            preceding_tool_use_ids: ["stale-tool-use-1"],
          };
          yield {
            type: "system",
            subtype: "mirror_error",
            session_id: "sdk-session-drain-after-suggestion",
            error: "stale mirror error after suggestion",
          };
          await followUpStreamReady;
          yield {
            type: "assistant",
            session_id: "sdk-session-drain-after-suggestion",
            message: {
              content: [{ type: "text", text: "Still on the same Claude query after draining." }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            session_id: "sdk-session-drain-after-suggestion",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-drain-after-suggestion",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-drain-after-suggestion",
        } as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const firstTurn = service.runSessionTurn({
          sessionId: session.id,
          text: "suggest the next prompt and drain stale tail",
          timeoutMs: 15_000,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await firstTurn;

        expect(events.filter((event) => event.event.type === "prompt_suggestion")).toHaveLength(1);

        const followUp = await service.runSessionTurn({
          sessionId: session.id,
          text: "follow up after the drained suggestion",
          timeoutMs: 15_000,
        });

        expect(followUp.outputText).toContain("same Claude query after draining");
        expect(events.filter((event) => event.event.type === "tool_use_summary")).toHaveLength(0);
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.status === "mirror_error"
          && event.event.detail === "stale mirror error after suggestion",
        )).toBe(false);
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps completed Claude turns successful when the post-result drain rejects", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield {
          type: "assistant",
          session_id: "sdk-session-drain-rejects",
          message: {
            content: [{ type: "text", text: "Finished before the drain failed." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          session_id: "sdk-session-drain-rejects",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        throw new Error("SDK worker closed after result");
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-drain-rejects",
      } as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-drain-rejects",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "finish even if the post-result drain rejects",
        timeoutMs: 15_000,
      });

      expect(result.outputText).toContain("Finished before the drain failed");
      expect(events.some((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "failed",
      )).toBe(false);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "done",
            status: "completed",
          }),
        }),
      ]));
    });

    it("does not discard first next-turn system events from a carried post-result read", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let streamCall = 0;
        let releaseFollowUpStream!: () => void;
        const followUpStreamReady = new Promise<void>((resolve) => {
          releaseFollowUpStream = resolve;
        });
        const send = vi.fn(async (message: unknown) => {
          const text = String(legacyClaudeSendPayload(message));
          if (text.includes("follow up after an empty post-result drain")) {
            releaseFollowUpStream();
          }
        });
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "result",
            session_id: "sdk-session-next-turn-system",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          await followUpStreamReady;
          yield {
            type: "system",
            subtype: "memory_recall",
            session_id: "sdk-session-next-turn-system",
            mode: "select",
            memories: [{
              path: "/tmp/preference.md",
              scope: "project",
              content: "Prefer preserving next-turn system events.",
            }],
          };
          yield {
            type: "assistant",
            session_id: "sdk-session-next-turn-system",
            message: {
              content: [{ type: "text", text: "Memory recall reached the next turn." }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            session_id: "sdk-session-next-turn-system",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-next-turn-system",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-next-turn-system",
        } as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const firstTurn = service.runSessionTurn({
          sessionId: session.id,
          text: "complete without a post-result tail",
          timeoutMs: 15_000,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await firstTurn;

        const followUp = await service.runSessionTurn({
          sessionId: session.id,
          text: "follow up after an empty post-result drain",
          timeoutMs: 15_000,
        });

        expect(followUp.outputText).toContain("Memory recall reached the next turn");
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.status === "memory_recall"
          && event.event.message === "Claude recalled 1 memory.",
        )).toBe(true);
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops stale system tails that settle before the next Claude turn starts", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let streamCall = 0;
        let releaseStaleTail!: () => void;
        let releaseFollowUpStream!: () => void;
        const staleTailReady = new Promise<void>((resolve) => {
          releaseStaleTail = resolve;
        });
        const followUpStreamReady = new Promise<void>((resolve) => {
          releaseFollowUpStream = resolve;
        });
        const send = vi.fn(async (message: unknown) => {
          const text = String(legacyClaudeSendPayload(message));
          if (text.includes("follow up after a stale settled tail")) {
            releaseFollowUpStream();
          }
        });
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "result",
            session_id: "sdk-session-settled-stale-tail",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          await staleTailReady;
          yield {
            type: "system",
            subtype: "mirror_error",
            session_id: "sdk-session-settled-stale-tail",
            error: "stale mirror error before the follow-up",
          };
          await followUpStreamReady;
          yield {
            type: "assistant",
            session_id: "sdk-session-settled-stale-tail",
            message: {
              content: [{ type: "text", text: "Follow-up started after dropping the stale tail." }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            session_id: "sdk-session-settled-stale-tail",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-settled-stale-tail",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send,
          stream,
          close: vi.fn(),
          sessionId: "sdk-session-settled-stale-tail",
        } as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const firstTurn = service.runSessionTurn({
          sessionId: session.id,
          text: "complete before a stale system tail",
          timeoutMs: 15_000,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await firstTurn;

        releaseStaleTail();
        await vi.advanceTimersByTimeAsync(0);

        const followUp = await service.runSessionTurn({
          sessionId: session.id,
          text: "follow up after a stale settled tail",
          timeoutMs: 15_000,
        });

        expect(followUp.outputText).toContain("Follow-up started after dropping the stale tail");
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.status === "mirror_error"
          && event.event.detail === "stale mirror error before the follow-up",
        )).toBe(false);
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the live Claude query without replaying late post-result tail messages into the next turn", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const close = vi.fn();
        let streamCall = 0;
        let releaseFollowUpStream!: () => void;
        const followUpStreamReady = new Promise<void>((resolve) => {
          releaseFollowUpStream = resolve;
        });
        const send = vi.fn(async (message: unknown) => {
          const text = String(legacyClaudeSendPayload(message));
          if (text.includes("follow up after the suppressed suggestion")) {
            releaseFollowUpStream();
          }
        });
        const stream = vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }

          yield {
            type: "result",
            session_id: "sdk-session-no-suggestion",
            usage: { input_tokens: 1, output_tokens: 1 },
          };

          await followUpStreamReady;
          yield {
            type: "prompt_suggestion",
            session_id: "sdk-session-no-suggestion",
            uuid: "late-suggestion-1",
            suggestion: "This suggestion belongs to the previous turn",
          };
          yield {
            type: "tool_use_summary",
            session_id: "sdk-session-no-suggestion",
            summary: "This summary belongs to the previous turn",
            preceding_tool_use_ids: ["late-tool-use-1"],
          };
          yield {
            type: "system",
            subtype: "mirror_error",
            session_id: "sdk-session-no-suggestion",
            error: "late mirror error from the previous turn",
          };
          yield {
            type: "assistant",
            session_id: "sdk-session-no-suggestion",
            message: {
              content: [{ type: "text", text: "Still on the same Claude query." }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            session_id: "sdk-session-no-suggestion",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })());
        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
          send,
          stream,
          close,
          sessionId: "sdk-session-no-suggestion",
        } as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue({
          send,
          stream,
          close,
          sessionId: "sdk-session-no-suggestion",
        } as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const firstTurn = service.runSessionTurn({
          sessionId: session.id,
          text: "wait for a suppressed prompt suggestion",
          timeoutMs: 15_000,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await firstTurn;

        expect(close).not.toHaveBeenCalled();
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).not.toHaveBeenCalled();

        const followUp = await service.runSessionTurn({
          sessionId: session.id,
          text: "follow up after the suppressed suggestion",
          timeoutMs: 15_000,
        });

        expect(followUp.outputText).toContain("same Claude query");
        expect(events.filter((event) => event.event.type === "prompt_suggestion")).toHaveLength(0);
        expect(events.filter((event) => event.event.type === "tool_use_summary")).toHaveLength(0);
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.status === "mirror_error"
          && event.event.detail === "late mirror error from the previous turn",
        )).toBe(false);
        expect(close).not.toHaveBeenCalled();
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("surfaces Claude worker shutdown when it is the live stream tail", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield {
          type: "system",
          subtype: "worker_shutting_down",
          session_id: "sdk-session-worker-shutdown",
          reason: "remote_control_disabled",
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-worker-shutdown",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "show live-tail shutdown",
        timeoutMs: 15_000,
      });

      const notices = events
        .map((envelope) => envelope.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
          event.type === "system_notice",
        );
      expect(notices.some((event) =>
        event.status === "worker_shutting_down"
        && event.message === "Claude worker is shutting down: remote control disabled",
      )).toBe(true);
    });

    it("trims oversized PostToolUse outputs before they return to Claude", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-post-tool-use",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const callback = opts?.hooks?.PostToolUse?.[0]?.hooks[0];
      expect(callback).toBeDefined();

      const largeOutput = `${"a".repeat(210 * 1024)}tail-marker`;
      const result = await callback!(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "generate a lot" },
          tool_response: largeOutput,
          tool_use_id: "tool-large-output",
        } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );

      expect(result).toMatchObject({
        continue: true,
        hookSpecificOutput: { hookEventName: "PostToolUse" },
      });
      const updatedToolOutput = result.hookSpecificOutput.updatedToolOutput as string;
      expect(updatedToolOutput).toContain("Large Bash tool output trimmed");
      expect(updatedToolOutput).toContain("tail-marker");
      expect(Buffer.byteLength(updatedToolOutput, "utf8")).toBeLessThan(60 * 1024);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.noticeKind === "hook"
        && event.event.message.includes("Trimmed large tool output"),
      )).toBe(false);
    });

    it("emits failed tool results from PostToolUseFailure hooks", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-post-tool-use-failure",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const callback = opts?.hooks?.PostToolUseFailure?.[0]?.hooks[0];
      expect(callback).toBeDefined();

      const result = await callback!(
        {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: { command: "exit 1" },
          tool_use_id: "tool-failed",
          error: "command failed",
        } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );

      expect(result).toMatchObject({ continue: true });
      expect(events.some((event) =>
        event.event.type === "tool_result"
        && event.event.tool === "Bash"
        && event.event.itemId === "tool-failed"
        && event.event.status === "failed",
      )).toBe(true);
    });

    it("does not mark SubagentStop hooks completed before task notification status arrives", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () {
          return;
        }),
        close: vi.fn(),
        sessionId: "sdk-session-subagent-stop",
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });

      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const start = opts?.hooks?.SubagentStart?.[0]?.hooks[0];
      const stop = opts?.hooks?.SubagentStop?.[0]?.hooks[0];
      expect(start).toBeDefined();
      expect(stop).toBeDefined();

      await start!(
        { hook_event_name: "SubagentStart", agent_id: "agent-1", agent_type: "reviewer" } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );
      await stop!(
        { hook_event_name: "SubagentStop", agent_id: "agent-1", agent_type: "reviewer", last_assistant_message: "failed later" } as any,
        undefined as any,
        { signal: new AbortController().signal } as any,
      );

      expect(events.some((event) => event.event.type === "subagent_started")).toBe(true);
      expect(events.some((event) => event.event.type === "subagent_result")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getSessionSummary
  // --------------------------------------------------------------------------

  describe("getSessionSummary", () => {
    it("returns null for unknown session id", async () => {
      const { service } = createService();
      const summary = await service.getSessionSummary("nonexistent-id");
      expect(summary).toBeNull();
    });

    it("returns null for empty session id", async () => {
      const { service } = createService();
      const summary = await service.getSessionSummary("");
      expect(summary).toBeNull();
    });

    it("returns null for whitespace-only session id", async () => {
      const { service } = createService();
      const summary = await service.getSessionSummary("   ");
      expect(summary).toBeNull();
    });

    it("returns summary for an existing session", async () => {
      const { service } = createService();
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const summary = await service.getSessionSummary(created.id);
      expect(summary).not.toBeNull();
      expect(summary!.sessionId).toBe(created.id);
      expect(summary!.provider).toBe("opencode");
    });

    it("surfaces and updates the first mirrored Claude SDK tag", async () => {
      installClaudeResponseFixture({ sdkSessionId: "sdk-tag-session", responseText: "unused" });
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const created = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: created.id,
        text: "Create the SDK session before tagging.",
        timeoutMs: 15_000,
      });

      await service.updateSession({ sessionId: created.id, tag: "review-ready" });
      expect(tagSession).toHaveBeenCalledWith(expect.any(String), "review-ready", {
        dir: fs.realpathSync(tmpRoot),
      });
      expect(sessionService.getClaudeSessionPointerByChatSessionId(created.id)?.tags).toEqual(["review-ready"]);
      await expect(service.getSessionSummary(created.id)).resolves.toMatchObject({
        claudeTag: "review-ready",
      });
      expect(events).toContainEqual(expect.objectContaining({
        event: { type: "session_meta_updated", claudeTag: "review-ready" },
      }));

      await service.updateSession({ sessionId: created.id, tag: "" });
      expect(tagSession).toHaveBeenLastCalledWith(expect.any(String), null, {
        dir: fs.realpathSync(tmpRoot),
      });
      await expect(service.getSessionSummary(created.id)).resolves.toMatchObject({ claudeTag: null });
    });
  });

  // --------------------------------------------------------------------------
  // getSessionCapabilities
  // --------------------------------------------------------------------------

  describe("getSessionCapabilities", () => {
    it("returns default capabilities for unknown session", () => {
      const { service } = createService();
      const caps = service.getSessionCapabilities({ sessionId: "unknown-id" });
      expect(caps).toMatchObject({
        supportsSubagentInspection: false,
        supportsSubagentControl: false,
        supportsReviewMode: false,
      });
      // Unknown session → the no-op subagent descriptor (nothing listable).
      expect(caps.subagent.canList).toBe(false);
      expect(caps.subagent.canViewFullTranscript).toBe(false);
    });

    it("returns capabilities for a opencode session (subagent inspection + transcript, no review)", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const caps = service.getSessionCapabilities({ sessionId: session.id });
      // OpenCode child sessions are real sessions → listable with full transcript.
      expect(caps.supportsSubagentInspection).toBe(true);
      expect(caps.subagent.canList).toBe(true);
      expect(caps.subagent.canViewFullTranscript).toBe(true);
      expect(caps.supportsSubagentControl).toBe(false);
      expect(caps.supportsReviewMode).toBe(false);
    });

    it("returns capabilities for a claude session (subagent inspection, no review)", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const caps = service.getSessionCapabilities({ sessionId: session.id });
      expect(caps.supportsSubagentInspection).toBe(true);
      expect(caps.subagent.canViewFullTranscript).toBe(true);
      // Claude consolidates multiple subagent kinds into one list.
      expect(caps.subagent.kinds.length).toBeGreaterThan(1);
      // supportsSubagentControl is true when a Claude runtime is initialized,
      // which createSession does eagerly for Claude sessions via ensureClaudeSessionRuntime.
      expect(caps.supportsSubagentControl).toBe(true);
      expect(caps.supportsReviewMode).toBe(false);
    });

    it("returns a cursor capability that lists subagents but cannot take over a transcript", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "",
        modelId: "cursor/auto",
      });

      const caps = service.getSessionCapabilities({ sessionId: session.id });
      expect(caps.subagent.canList).toBe(true);
      expect(caps.subagent.canViewFullTranscript).toBe(false);
    });
  });

  describe("Claude SessionStore reads", () => {
    it("maps SDK messages and forwards paging plus system-message options", async () => {
      const { service } = createService();
      vi.mocked(getSessionMessages).mockResolvedValue([{
        type: "assistant",
        uuid: "wire-1",
        session_id: "sdk-session-1",
        parent_tool_use_id: null,
        message: {
          id: "msg-1",
          role: "assistant",
          content: [{ type: "text", text: "SDK transcript text" }],
        },
      }] as any);

      await expect(service.getClaudeSessionMessages({
        sessionId: "sdk-session-1",
        laneId: "lane-1",
        limit: 25,
        offset: 3,
        includeSystemMessages: true,
      })).resolves.toEqual([expect.objectContaining({
        uuid: "wire-1",
        sessionId: "sdk-session-1",
        text: "SDK transcript text",
      })]);
      expect(getSessionMessages).toHaveBeenCalledWith("sdk-session-1", {
        dir: fs.realpathSync(tmpRoot),
        limit: 25,
        offset: 3,
        includeSystemMessages: true,
      });
    });
  });

  // --------------------------------------------------------------------------
  // listSubagents
  // --------------------------------------------------------------------------

  describe("listSubagents", () => {
    it("returns empty array when no subagents are tracked", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const subagents = service.listSubagents({ sessionId: session.id });
      expect(subagents).toEqual([]);
    });

    it("returns empty array for unknown session", () => {
      const { service } = createService();
      const subagents = service.listSubagents({ sessionId: "unknown-id" });
      expect(subagents).toEqual([]);
    });

    it("hydrates stopped subagents from the persisted chat transcript", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const transcriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
      const placeholderStarted: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-30T01:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "call-spawn-1",
          parentToolUseId: "call-spawn-1",
          description: "Inspect the shared chat renderer",
          turnId: "turn-1",
        },
      };
      const agentStarted: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-30T01:00:01.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-thread-1",
          agentId: "agent-thread-1",
          agentType: "Sagan",
          parentToolUseId: "call-spawn-1",
          description: "Inspect the shared chat renderer",
          turnId: "turn-1",
        },
      };
      const stopped: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-30T01:02:00.000Z",
        event: {
          type: "subagent_result",
          taskId: "agent-thread-1",
          agentId: "agent-thread-1",
          agentType: "Sagan",
          parentToolUseId: "call-spawn-1",
          status: "stopped",
          summary: "Halted by parent turn.",
          turnId: "turn-1",
        },
      };
      fs.writeFileSync(
        transcriptFile,
        `${JSON.stringify(placeholderStarted)}\n${JSON.stringify(agentStarted)}\n${JSON.stringify(stopped)}\n`,
        "utf8",
      );

      const subagents = service.listSubagents({ sessionId: session.id });

      expect(subagents).toEqual([
        expect.objectContaining({
          taskId: "agent-thread-1",
          agentId: "agent-thread-1",
          agentType: "Sagan",
          parentToolUseId: "call-spawn-1",
          description: "Inspect the shared chat renderer",
          status: "stopped",
          summary: "Halted by parent turn.",
          endTimestamp: "2026-06-30T01:02:00.000Z",
        }),
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // Claude Workflow runs (workflow_progress fan-out) + child spawn lineage
  // --------------------------------------------------------------------------

  describe("claude workflow progress fan-out", () => {
    it("fans workflow agents out as subagent rows with stable identity and closes stragglers on workflow end", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-wf-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "wf-1",
          description: "Run review workflow",
          task_type: "local_workflow",
          workflow_name: "review",
        };
        // Tick 1: phase + one running agent, one queued agent (no startedAt).
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "wf-1",
          description: "Run review workflow",
          usage: { total_tokens: 100, tool_uses: 1, duration_ms: 50 },
          workflow_progress: [
            { type: "workflow_phase", index: 0, title: "Scan" },
            { type: "workflow_agent", index: 0, state: "start", startedAt: 1, label: "scan:auth", agentId: "agent-a", tokens: 100 },
            { type: "workflow_agent", index: 1, state: "start", label: "scan:db" },
          ],
        };
        // Tick 2: agent-a finishes, the queued agent starts.
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "wf-1",
          description: "Run review workflow",
          usage: { total_tokens: 900, tool_uses: 4, duration_ms: 900 },
          workflow_progress: [
            { type: "workflow_phase", index: 0, title: "Scan" },
            { type: "workflow_agent", index: 0, state: "done", startedAt: 1, label: "scan:auth", agentId: "agent-a", tokens: 900, durationMs: 800 },
            { type: "workflow_agent", index: 1, state: "start", startedAt: 5, label: "scan:db" },
          ],
        };
        // Workflow ends while scan:db is still running.
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "wf-1",
          status: "completed",
          summary: "workflow done",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-wf-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "Run the workflow." });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_result" && (e.event as any).taskId === "wf-1",
      );

      const agentEvents = events.filter((e) => (e.event as any).agentId === "agent-a");
      const started = agentEvents.filter((e) => e.event.type === "subagent_started");
      const results = agentEvents.filter((e) => e.event.type === "subagent_result");
      // Stable identity: exactly one started + one result despite cumulative re-emission.
      expect(started).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect((started[0]!.event as any).taskId).toBe("wf-1::a0");
      expect((started[0]!.event as any).description).toBe("scan:auth");
      expect((started[0]!.event as any).workflowName).toBe("review");
      expect((started[0]!.event as any).background).toBe(true);
      expect((results[0]!.event as any).status).toBe("completed");
      expect((results[0]!.event as any).usage?.totalTokens).toBe(900);

      // The queued agent only materializes once it starts, then is closed as
      // stopped when the workflow ends before it finishes.
      const dbRow = events.filter((e) => (e.event as any).taskId === "wf-1::a1");
      expect(dbRow.some((e) => e.event.type === "subagent_started")).toBe(true);
      const dbResult = dbRow.find((e) => e.event.type === "subagent_result");
      expect((dbResult?.event as any)?.status).toBe("stopped");
      expect((dbResult?.event as any)?.finalSummary).toContain("Workflow ended");

      // Parent workflow row derives a phase/count summary when the SDK sends none.
      const parentProgress = events.find(
        (e) => e.event.type === "subagent_progress" && (e.event as any).taskId === "wf-1",
      );
      expect((parentProgress?.event as any)?.summary).toContain("Scan");

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });
  });

  describe("child chat spawn lineage", () => {
    it("notifies the parent session with a spawn chip notice and a live subagent row", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-lineage", slash_commands: [] };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-lineage",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const parent = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const child = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Fix flaky tests",
        orchestrationParentSessionId: parent.id,
      });

      const parentEvents = events.filter((e) => e.sessionId === parent.id);
      const notice = parentEvents.find(
        (e) => e.event.type === "system_notice" && (e.event as any).status === "subagent_spawned",
      );
      expect(notice).toBeTruthy();
      expect((notice!.event as any).message).toContain("Fix flaky tests");
      expect((notice!.event as any).detail?.spawnedSession?.sessionId).toBe(child.id);

      const row = parentEvents.find(
        (e) => e.event.type === "subagent_started" && (e.event as any).taskId === `chat:${child.id}`,
      );
      expect(row).toBeTruthy();
      expect((row!.event as any).agentId).toBe(child.id);
      expect((row!.event as any).description).toBe("Fix flaky tests");

      expect(child.orchestrationParentSessionId).toBe(parent.id);
    });
  });

  // --------------------------------------------------------------------------
  // Claude subagent name capture (Task tool input -> task_started envelope)
  // --------------------------------------------------------------------------

  describe("claude subagent name capture", () => {
    it("attaches agentType from the Task tool input to subagent_* envelopes", async () => {
      const events: AgentChatEventEnvelope[] = [];

      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-name-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Assistant emits a Task tool_use block with subagent_type = "code-reviewer"
        yield {
          type: "assistant",
          message: {
            id: "msg-1",
            content: [
              {
                type: "tool_use",
                id: "toolu_task_1",
                name: "Task",
                input: {
                  subagent_type: "code-reviewer",
                  description: "Review the auth module",
                  prompt: "Please review auth.ts for security gaps.",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        // SDK emits the canonical task lifecycle system messages referencing
        // the same tool_use id via parent_tool_use_id.
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          parent_tool_use_id: "toolu_task_1",
          description: "Review the auth module",
        };
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "task-1",
          parent_tool_use_id: "toolu_task_1",
          summary: "Reading file…",
          last_tool_name: "Read",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-1",
          parent_tool_use_id: "toolu_task_1",
          status: "completed",
          summary: "Found no issues",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-name-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Spawn a code-reviewer subagent.",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_result" && (e.event as any).taskId === "task-1",
      );

      const startEnvelope = events.find(
        (e) => e.event.type === "subagent_started" && (e.event as any).taskId === "task-1",
      );
      const progressEnvelope = events.find(
        (e) => e.event.type === "subagent_progress" && (e.event as any).taskId === "task-1",
      );
      const resultEnvelope = events.find(
        (e) => e.event.type === "subagent_result" && (e.event as any).taskId === "task-1",
      );

      expect((startEnvelope?.event as any)?.agentType).toBe("code-reviewer");
      expect((progressEnvelope?.event as any)?.agentType).toBe("code-reviewer");
      expect((resultEnvelope?.event as any)?.agentType).toBe("code-reviewer");
      expect((startEnvelope?.event as any)?.parentToolUseId).toBe("toolu_task_1");

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("falls back gracefully when Task tool has no subagent_type", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-name-2", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Task tool input lacks subagent_type (older models)
        yield {
          type: "assistant",
          message: {
            id: "msg-2",
            content: [
              {
                type: "tool_use",
                id: "toolu_task_2",
                name: "Task",
                input: {
                  description: "Audit something",
                  prompt: "Audit the change log.",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-2",
          parent_tool_use_id: "toolu_task_2",
          description: "Audit something",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-2",
          parent_tool_use_id: "toolu_task_2",
          status: "completed",
          summary: "Done",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-name-2",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Run a subagent without an explicit type",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_started" && (e.event as any).taskId === "task-2",
      );

      const startEnvelope = events.find(
        (e) => e.event.type === "subagent_started" && (e.event as any).taskId === "task-2",
      );
      expect(startEnvelope).toBeDefined();
      // No agentType is fine — the renderer falls back to description.
      expect((startEnvelope?.event as any)?.agentType).toBeUndefined();
      expect((startEnvelope?.event as any)?.description).toBe("Audit something");

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("routes a background shell command to background_task scheduled_work rows, not subagent events", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-bg-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Bash run_in_background-style task: no Task tool; SDK directly emits
        // task_started with task_type: "background" and no subagent agentType.
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-bg-1",
          description: "Launch dev desktop with desktop RPC socket enabled",
          command: "npm run dev:desktop",
          task_type: "background",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-bg-1",
          status: "completed",
          summary: "Process exited",
          usage: { duration_ms: 4200 },
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-bg-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Kick off a background task.",
      });

      // A running background_task scheduled_work row appears immediately on spawn.
      const runningRow = await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "scheduled_work_update"
          && (e.event as any).id === "background:task-bg-1"
          && (e.event as any).status === "running",
      );
      expect((runningRow.event as any).kind).toBe("background_task");
      expect((runningRow.event as any).title).toBe("Launch dev desktop with desktop RPC socket enabled");

      // Terminal background_task row (with duration) on notification.
      const doneRow = await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "scheduled_work_update"
          && (e.event as any).id === "background:task-bg-1"
          && ((e.event as any).status === "completed" || (e.event as any).status === "done"),
      );
      expect((doneRow.event as any).summary).toContain("4200ms");

      // Crucially: NO subagent_* events were emitted for the background shell.
      const subagentEvents = events.filter((e) =>
        (e.event.type === "subagent_started"
          || e.event.type === "subagent_progress"
          || e.event.type === "subagent_result")
        && (e.event as any).taskId === "task-bg-1",
      );
      expect(subagentEvents).toEqual([]);

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("keeps emitting subagent_* events for a real subagent (Task tool with agentType)", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-real-sub-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "assistant",
          message: {
            id: "msg-real-1",
            content: [
              {
                type: "tool_use",
                id: "toolu_real_1",
                name: "Task",
                input: { subagent_type: "Explore", description: "Explore the repo", prompt: "Look around." },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-real-1",
          parent_tool_use_id: "toolu_real_1",
          description: "Explore the repo",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-real-1",
          parent_tool_use_id: "toolu_real_1",
          status: "completed",
          summary: "Explored",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-real-sub-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Spawn an Explore subagent.",
      });

      const startEnvelope = await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_started" && (e.event as any).taskId === "task-real-1",
      );
      expect((startEnvelope.event as any).agentType).toBe("Explore");
      // A real subagent must NOT produce a background_task scheduled row.
      expect(events.some((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:task-real-1",
      )).toBe(false);

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("suppresses task_* events entirely when the SDK marks them skip_transcript", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-skip-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Ambient task — session title generator. Must not surface anywhere.
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-ambient-1",
          description: "Generate session title",
          task_type: "other",
          skip_transcript: true,
        };
        yield {
          type: "system",
          subtype: "task_progress",
          task_id: "task-ambient-1",
          summary: "thinking…",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-ambient-1",
          status: "completed",
          summary: "Done",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-skip-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Drive an ambient task.",
      });

      // Give the runtime a beat to flush events for the ambient task.
      await vi.waitFor(() => {
        expect(events.some((e) => e.event.type === "status")).toBe(true);
      });

      const subagentEvents = events.filter((e) =>
        e.event.type === "subagent_started"
        || e.event.type === "subagent_progress"
        || e.event.type === "subagent_result"
      );

      expect(subagentEvents).toEqual([]);

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // claude background_task terminal statuses + restart reconciliation
  // --------------------------------------------------------------------------

  describe("claude background task lifecycle", () => {
    async function bootClaudeHooks(sessionId: string) {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () { return; }),
        close: vi.fn(),
        sessionId,
      } as any);
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => {
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalled();
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.SubagentStop?.[0]?.hooks[0];
      expect(stopHook).toBeDefined();
      const fireSnapshot = async (backgroundTasks: unknown[]) => {
        await stopHook!(
          {
            hook_event_name: "SubagentStop",
            agent_id: `agent-${randomSuffix()}`,
            agent_type: "reviewer",
            last_assistant_message: "",
            background_tasks: backgroundTasks,
          } as any,
          undefined as any,
          { signal: new AbortController().signal } as any,
        );
      };
      return { service, session, events, fireSnapshot };
    }

    function randomSuffix() {
      return Math.random().toString(36).slice(2, 8);
    }

    it("emits a terminal background_task row exactly once when a hook snapshot drops an id", async () => {
      const { events, fireSnapshot } = await bootClaudeHooks("sdk-bg-diff-1");

      // Snapshot A contains id X (running); snapshot B omits it.
      await fireSnapshot([{ id: "bg-X", type: "shell", status: "running", command: "sleep 5" }]);
      await fireSnapshot([]);

      const bgXEvents = events.filter(
        (e) => e.event.type === "scheduled_work_update" && (e.event as any).id === "background:bg-X",
      );
      const runningCount = bgXEvents.filter((e) => (e.event as any).status === "running").length;
      const terminalCount = bgXEvents.filter((e) =>
        (e.event as any).status === "completed" || (e.event as any).status === "stopped",
      ).length;
      expect(runningCount).toBe(1);
      expect(terminalCount).toBe(1);
    });

    it("converges hook diff-close with a task_notification terminal (no duplicate distinct terminal events)", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-bg-converge", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "bg-conv",
          description: "background convergence",
          command: "npm run watch",
          task_type: "background",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "bg-conv",
          status: "completed",
          summary: "watcher stopped",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-bg-converge", setPermissionMode,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "watch" });

      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-conv"
        && ((e.event as any).status === "completed" || (e.event as any).status === "stopped"));

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();

      // The signature-dedupe means the same terminal (completed) is emitted once.
      const terminalStatuses = events
        .filter((e) => e.event.type === "scheduled_work_update" && (e.event as any).id === "background:bg-conv")
        .map((e) => (e.event as any).status)
        .filter((s) => s === "completed" || s === "stopped");
      // Exactly one distinct terminal status survives (last-write-wins converges).
      const distinctTerminal = new Set(terminalStatuses);
      expect(distinctTerminal.size).toBeLessThanOrEqual(1);
      expect(terminalStatuses.length).toBeGreaterThanOrEqual(1);
    });

    it("stops still-open background ids at turn end when the notification never arrives", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-bg-sweep", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Background shell starts but never reports a notification this turn.
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "bg-orphan",
          description: "long lived background",
          command: "tail -f log",
          task_type: "background",
        };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-bg-sweep", setPermissionMode,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const sendPromise = service.sendMessage({ sessionId: session.id, text: "start bg" });

      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-orphan"
        && (e.event as any).status === "running");

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();

      // The turn-end sweep must settle the orphan as stopped.
      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-orphan"
        && (e.event as any).status === "stopped");
      // And no subagent_result leaked for the background shell.
      expect(events.some((e) =>
        e.event.type === "subagent_result" && (e.event as any).taskId === "bg-orphan")).toBe(false);
    });

    it("does not cross-wire finalSummary between two concurrent subagents on an empty task_notification", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let stopHooksFired: (() => void) | null = null;
      const stopHooksFiredPromise = new Promise<void>((resolve) => { stopHooksFired = resolve; });
      let turnDone: (() => void) | null = null;
      const turnDonePromise = new Promise<void>((resolve) => { turnDone = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-crosswire", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Two concurrent Task-tool subagents, A (task-A / agent-A) and B.
        yield { type: "assistant", message: { id: "m-cw", content: [
          { type: "tool_use", id: "toolu_A", name: "Task", input: { subagent_type: "reviewer", description: "review A", prompt: "a" } },
          { type: "tool_use", id: "toolu_B", name: "Task", input: { subagent_type: "reviewer", description: "review B", prompt: "b" } },
        ], usage: { input_tokens: 1, output_tokens: 1 } } };
        yield { type: "system", subtype: "task_started", task_id: "task-A", agent_id: "agent-A", parent_tool_use_id: "toolu_A", description: "review A" };
        yield { type: "system", subtype: "task_started", task_id: "task-B", agent_id: "agent-B", parent_tool_use_id: "toolu_B", description: "review B" };
        // The SubagentStop hooks fire out-of-band (below). Wait for them, then
        // deliver an EMPTY-summary notification for A.
        await stopHooksFiredPromise;
        yield { type: "system", subtype: "task_notification", task_id: "task-A", agent_id: "agent-A", parent_tool_use_id: "toolu_A", status: "completed", summary: "" };
        await turnDonePromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-crosswire", setPermissionMode,
      } as any);
      const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<any>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.SubagentStop?.[0]?.hooks[0];
      expect(stopHook).toBeDefined();

      const sendPromise = service.sendMessage({ sessionId: session.id, text: "spawn A and B" });
      await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "subagent_started" && (e.event as any).taskId === "task-B");

      const sig = { signal: new AbortController().signal } as any;
      // B finishes with a distinctive final message; A finishes with none.
      await stopHook!({ hook_event_name: "SubagentStop", agent_id: "agent-B", agent_type: "reviewer", last_assistant_message: "B-SECRET-RESULT" } as any, undefined as any, sig);
      await stopHook!({ hook_event_name: "SubagentStop", agent_id: "agent-A", agent_type: "reviewer", last_assistant_message: "" } as any, undefined as any, sig);
      stopHooksFired!();

      // A's empty-summary notification must NOT surface B's finalSummary.
      const aResult = await waitForEvent(events, (e): e is AgentChatEventEnvelope =>
        e.event.type === "subagent_result" && (e.event as any).taskId === "task-A");
      expect(JSON.stringify(aResult.event)).not.toContain("B-SECRET-RESULT");
      expect((aResult.event as any).summary ?? "").not.toContain("B-SECRET-RESULT");

      turnDone!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("reconciles orphaned background rows + open subagents after an ADE restart with one system_notice", async () => {
      // Process 1: run a completed turn so the SDK session id + a real transcript
      // are persisted to disk. (The turn's content is irrelevant; we inject the
      // orphaned tail via the transcript parser mock below.)
      let streamCall = 0;
      let warmupComplete = false;
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-restart-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } } };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: "sdk-restart-1", setPermissionMode,
      } as any);
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      await service.runSessionTurn({ sessionId: session.id, text: "seed the transcript" });

      // The persisted metadata now carries an sdkSessionId — the reconciler is
      // gated on a recovered SDK session id (any non-empty value triggers it).
      const persisted = readPersistedChatState(session.id);
      expect(typeof persisted.sdkSessionId).toBe("string");
      expect(persisted.sdkSessionId.length).toBeGreaterThan(0);

      // Process 2 (fresh host): a NEW service instance re-binds the persisted
      // session. Inject an orphaned transcript tail: one still-"running"
      // background_task row and one still-open real subagent from the previous
      // process. deriveBackgroundItems / subagentSnapshotsFromEvents read these.
      const orphanTail: AgentChatEventEnvelope[] = [
        { sessionId: session.id, timestamp: new Date().toISOString(), sequence: 1, event: {
          type: "scheduled_work_update", id: "background:bg-restart", kind: "background_task",
          status: "running", origin: "background_task", title: "npm run serve", summary: "shell",
          sourceTaskId: "bg-restart", turnId: "turn-old",
        } as any },
        { sessionId: session.id, timestamp: new Date().toISOString(), sequence: 2, event: {
          type: "subagent_started", taskId: "sub-restart", agentId: "sub-restart",
          agentType: "Explore", parentToolUseId: "toolu_sub_r", description: "look", turnId: "turn-old",
        } as any },
      ];
      vi.mocked(parseAgentChatTranscript).mockReturnValue(orphanTail);

      const events2: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn(),
        stream: vi.fn(async function* () { return; }),
        close: vi.fn(),
        sessionId: "sdk-restart-1",
      } as any);
      const { service: service2 } = createService({ onEvent: (event: AgentChatEventEnvelope) => events2.push(event) });
      await service2.resumeSession({ sessionId: session.id });

      // Background_task row settled as stopped with the restart marker.
      const bgStopped = events2.find((e) =>
        e.event.type === "scheduled_work_update"
        && (e.event as any).id === "background:bg-restart"
        && (e.event as any).status === "stopped");
      expect(bgStopped).toBeTruthy();

      // Open subagent closed as stopped (interrupt-path parity).
      const subStopped = events2.find((e) =>
        e.event.type === "subagent_result"
        && (e.event as any).taskId === "sub-restart"
        && (e.event as any).status === "stopped");
      expect(subStopped).toBeTruthy();

      // Exactly one compact reconciliation system_notice, counting background tasks.
      const notices = events2.filter((e) =>
        e.event.type === "system_notice"
        && typeof (e.event as any).message === "string"
        && (e.event as any).message.startsWith("Reconciled after restart:"));
      expect(notices).toHaveLength(1);
      expect((notices[0]!.event as any).message).toBe("Reconciled after restart: 1 background task stopped");
    });
  });

  // --------------------------------------------------------------------------
  // claude SDK session title adoption
  // --------------------------------------------------------------------------

  describe("claude SDK session title adoption", () => {
    async function runClaudeTurnWithSessionInfo(args: {
      sessionId: string;
      info: { summary?: string; customTitle?: string; firstPrompt?: string } | null;
      firstPrompt?: string;
      manuallyName?: boolean;
      turns?: number;
    }) {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: args.sessionId, slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield { type: "assistant", message: { id: `m-${streamCall}`, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } } };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send, stream, close: vi.fn(), sessionId: args.sessionId, setPermissionMode,
      } as any);
      vi.mocked(getSessionInfo).mockResolvedValue(args.info as any);

      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      if (args.manuallyName) {
        await service.updateSession({ sessionId: session.id, title: "Manual Title", manuallyNamed: true });
      }
      await vi.waitFor(() => { expect(warmupComplete).toBe(true); });
      const turns = args.turns ?? 1;
      for (let i = 0; i < turns; i += 1) {
        await service.runSessionTurn({ sessionId: session.id, text: args.firstPrompt ?? "Fix update modal flow" });
      }
      return { service, sessionService, session, events };
    }

    it("adopts the SDK summary as the title when the chat still has the default name", async () => {
      const { sessionService, session } = await runClaudeTurnWithSessionInfo({
        sessionId: "sdk-title-1",
        info: { summary: "Fix update modal flow", firstPrompt: "please help with something entirely different here" },
        firstPrompt: "please help with something entirely different here",
      });
      await waitForSessionTitle(sessionService, session.id, "Fix update modal flow");
    });

    it("does not adopt when the summary is just the first-prompt echo", async () => {
      const prompt = "Fix update modal flow";
      const { sessionService, session } = await runClaudeTurnWithSessionInfo({
        sessionId: "sdk-title-2",
        info: { summary: prompt, firstPrompt: prompt },
        firstPrompt: prompt,
      });
      // Give the fire-and-forget adopt a beat, then confirm the title stayed default.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sessionService.get(session.id)?.title).toBe("Claude Chat");
    });

    it("does not adopt when the session is manually named", async () => {
      const { sessionService, session } = await runClaudeTurnWithSessionInfo({
        sessionId: "sdk-title-3",
        info: { summary: "Runtime Suggested Title", firstPrompt: "unrelated first prompt" },
        manuallyName: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sessionService.get(session.id)?.title).toBe("Manual Title");
    });

    it("only queries getSessionInfo once — stops after the title is adopted", async () => {
      vi.mocked(getSessionInfo).mockClear();
      const { sessionService, session } = await runClaudeTurnWithSessionInfo({
        sessionId: "sdk-title-4",
        info: { summary: "Adopted Investigation", firstPrompt: "totally different opening prompt text" },
        firstPrompt: "totally different opening prompt text",
        turns: 2,
      });
      await waitForSessionTitle(sessionService, session.id, "Adopted Investigation");
      // Even across two turns, the adopt path stops after success.
      expect(vi.mocked(getSessionInfo).mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  // --------------------------------------------------------------------------
  // getSlashCommands
  // --------------------------------------------------------------------------

  describe("getSlashCommands", () => {
    it("returns empty array for unknown session", async () => {
      const { service } = createService();
      const commands = service.getSlashCommands({ sessionId: "unknown-id" });
      expect(commands).toEqual([]);
    });

    it("returns Claude commands for a draft lane before a chat session exists", async () => {
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, "shipLane.md"), [
        "---",
        "description: Ship the active lane",
        "---",
        "",
        "Ship lane.",
        "",
      ].join("\n"));
      const { service } = createService();

      const commands = service.getSlashCommands({ laneId: "lane-1", provider: "claude" });
      const names = commands.map((command) => command.name);

      expect(names).toContain("/agents");
      expect(names).toContain("/output-style");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/shipLane",
          description: "Ship the active lane",
          source: "sdk",
        }),
      ]));
      expect(names).not.toContain("/login");
    });

    it("returns Codex commands for a draft lane before a chat session exists", async () => {
      const promptsDir = path.join(tmpRoot, ".codex", "prompts");
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, "audit.md"), "Audit recent work.");
      const { service } = createService();

      const commands = service.getSlashCommands({ laneId: "lane-1", provider: "codex" });
      const names = commands.map((command) => command.name);

      expect(names).toContain("/permissions");
      expect(names).toContain("/review");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/audit",
          description: "Audit recent work.",
          source: "sdk",
        }),
      ]));
      expect(names).not.toContain("/apps");
    });

    it("returns local and filesystem-backed skill commands for an opencode session", async () => {
      const skillDir = path.join(tmpRoot, ".agents", "skills", "deploy-helper");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
        "---",
        "name: deploy-helper",
        "description: Use this skill for deployment help",
        "---",
        "",
        "Deploy safely.",
        "",
      ].join("\n"));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands.length).toBeGreaterThanOrEqual(1);

      const clearCmd = commands.find((c: any) => c.name === "/clear");
      expect(clearCmd).toBeDefined();
      expect(clearCmd!.source).toBe("local");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/deploy-helper",
          description: "Use this skill for deployment help",
          source: "sdk",
        }),
      ]));
    });

    it("returns Claude and Codex prompt commands plus /clear for a droid lane", async () => {
      const claudeCommandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(claudeCommandsDir, { recursive: true });
      fs.writeFileSync(path.join(claudeCommandsDir, "deploy.md"), [
        "---",
        "description: Deploy the active branch",
        "---",
        "",
        "Deploy.",
        "",
      ].join("\n"));
      const codexPromptsDir = path.join(tmpRoot, ".codex", "prompts");
      fs.mkdirSync(codexPromptsDir, { recursive: true });
      fs.writeFileSync(path.join(codexPromptsDir, "triage.md"), "Triage the inbox.");
      const { service } = createService();

      const commands = service.getSlashCommands({ laneId: "lane-1", provider: "droid" });
      const names = commands.map((command) => command.name);

      expect(names).toContain("/clear");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/deploy",
          description: "Deploy the active branch",
          source: "sdk",
        }),
        expect.objectContaining({
          name: "/triage",
          description: "Triage the inbox.",
          source: "sdk",
        }),
      ]));
    });

    it("returns Cursor commands, subagents, skills, and /clear for a Cursor lane", async () => {
      const commandDir = path.join(tmpRoot, ".cursor", "commands");
      const agentsDir = path.join(tmpRoot, ".cursor", "agents");
      const skillDir = path.join(tmpRoot, ".cursor", "skills", "sdk-audit");
      fs.mkdirSync(commandDir, { recursive: true });
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(commandDir, "write-tests.md"), [
        "---",
        "description: Write Cursor-backed tests",
        "---",
        "",
        "Write tests.",
        "",
      ].join("\n"));
      fs.writeFileSync(path.join(agentsDir, "verifier.md"), [
        "---",
        "description: Verify the implementation",
        "---",
        "",
        "Verify work.",
        "",
      ].join("\n"));
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
        "---",
        "name: sdk-audit",
        "description: Audit the Cursor SDK wiring",
        "---",
        "",
        "Audit Cursor.",
        "",
      ].join("\n"));
      const { service } = createService();

      const commands = service.getSlashCommands({ laneId: "lane-1", provider: "cursor" });
      const names = commands.map((command) => command.name);

      expect(names).toContain("/clear");
      expect(names).toContain("/explore");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/write-tests",
          description: "Write Cursor-backed tests",
          source: "sdk",
        }),
        expect.objectContaining({
          name: "/verifier",
          description: "Verify the implementation",
          source: "sdk",
        }),
        expect.objectContaining({
          name: "/sdk-audit",
          description: "Audit the Cursor SDK wiring",
          source: "sdk",
        }),
      ]));
    });

    it("returns the same slash command set for a live droid session", async () => {
      const codexPromptsDir = path.join(tmpRoot, ".codex", "prompts");
      fs.mkdirSync(codexPromptsDir, { recursive: true });
      fs.writeFileSync(path.join(codexPromptsDir, "summarize.md"), "Summarize this lane.");
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const names = commands.map((command) => command.name);

      expect(names).toContain("/clear");
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/summarize",
          description: "Summarize this lane.",
          source: "sdk",
        }),
      ]));
    });

    it("does not advertise /login as a Claude SDK command", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const loginCmd = commands.find((c: any) => c.name === "/login");
      expect(loginCmd).toBeUndefined();
    });

    it("advertises the ADE-hosted Claude output-style command", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/output-style",
          source: "sdk",
        }),
      ]));
    });

    it("removes dead-listed Codex slash commands from the palette", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const names = commands.map((c) => c.name);
      // §A.6 leftovers (removed handlers/IPC)
      expect(names).not.toContain("/fork");
      expect(names).not.toContain("/resume");
      expect(names).not.toContain("/rollback");
      expect(names).not.toContain("/unarchive");
      // Codex-CLI-only surfaces with no ADE consumer
      expect(names).not.toContain("/apps");
      expect(names).not.toContain("/plugins");
      expect(names).not.toContain("/ps");
      expect(names).not.toContain("/stop");
      // Duplicate ADE composer/lane flows
      expect(names).not.toContain("/mention");
      expect(names).not.toContain("/new");
      // TUI-only configuration
      expect(names).not.toContain("/statusline");
      expect(names).not.toContain("/title");
      // Destructive runtime side-effect; ADE owns /quit
      expect(names).not.toContain("/exit");
      // /inject was added by F.2
      expect(names).toContain("/inject");
    });

    it("includes project Claude Code command files before SDK init completes", async () => {
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, "automate.md"), [
        "---",
        "description: Generate test coverage",
        "argument-hint: [area]",
        "---",
        "",
        "Generate tests for $ARGUMENTS.",
        "",
      ].join("\n"));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/automate",
          description: "Generate test coverage",
          argumentHint: "[area]",
          source: "sdk",
        }),
      ]));
    });

    it("does not let a filesystem /login command replace provider auth guidance", async () => {
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, "login.md"), [
        "---",
        "description: Project login override",
        "---",
        "",
        "This should not replace ADE's login command.",
        "",
      ].join("\n"));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const loginCmd = commands.find((c: any) => c.name === "/login");
      expect(loginCmd).toBeUndefined();
    });

    it("does not include /login for opencode sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      const loginCmd = commands.find((c: any) => c.name === "/login");
      expect(loginCmd).toBeUndefined();
    });

    it("includes Codex prompt files before the app server reports dynamic commands", async () => {
      const promptsDir = path.join(tmpRoot, ".codex", "prompts");
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, "audit.md"), "Audit recent work.");

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/audit",
          description: "Audit recent work.",
          source: "sdk",
        }),
      ]));
    });

    it("advertises Codex CLI parity slash command hints for Codex sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/fast",
          argumentHint: "[on|off|status]",
          source: "local",
        }),
        expect.objectContaining({
          name: "/plan",
          argumentHint: "[prompt]",
          source: "local",
        }),
        expect.objectContaining({
          name: "/goal",
          argumentHint: "[pause|resume|clear|<objective>]",
          source: "local",
        }),
      ]));
    });

    it("includes project Claude command files for Codex-backed sessions", async () => {
      const commandsDir = path.join(tmpRoot, ".claude", "commands");
      const promptsDir = path.join(tmpRoot, ".codex", "prompts");
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, "shipLane.md"), [
        "---",
        "description: Ship the active lane",
        "---",
        "",
        "Ship lane.",
        "",
      ].join("\n"));
      fs.writeFileSync(path.join(promptsDir, "shipLane.md"), "# Codex ship lane prompt\n");

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const commands = service.getSlashCommands({ sessionId: session.id });
      expect(commands.filter((command: any) => command.name.toLowerCase() === "/shiplane")).toHaveLength(1);
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "/shipLane",
          description: "Ship the active lane",
          source: "sdk",
        }),
      ]));
    });
  });

  describe("Claude output styles", () => {
    it("lists built-in and project-local output styles for a Claude session", async () => {
      const stylesDir = path.join(tmpRoot, ".claude", "output-styles");
      fs.mkdirSync(stylesDir, { recursive: true });
      fs.writeFileSync(path.join(stylesDir, "reviewer.md"), [
        "---",
        "name: Reviewer",
        "description: Review first",
        "---",
        "",
        "Review first.",
        "",
      ].join("\n"));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      expect(service.listClaudeOutputStyles({ sessionId: session.id })).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "Default", source: "builtin" }),
        expect.objectContaining({ name: "Reviewer", source: "project", description: "Review first" }),
      ]));
    });

    it("persists and applies an output style to a live Claude query", async () => {
      const applyFlagSettings = vi.fn(async () => undefined);
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
        applyFlagSettings,
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.sendMessage({ sessionId: session.id, text: "hello" });
      const updated = await service.setClaudeOutputStyle({ sessionId: session.id, outputStyle: "Learning" });

      expect(updated.claudeOutputStyle).toBe("Learning");
      expect(applyFlagSettings).toHaveBeenCalledWith({ outputStyle: "Learning" });
      expect(JSON.parse(fs.readFileSync(path.join(tmpRoot, ".claude", "settings.local.json"), "utf8"))).toMatchObject({
        outputStyle: "Learning",
      });
    });
  });

  describe("Claude context usage", () => {
    it("normalizes used and free context categories against the full context window", async () => {
      const getContextUsage = vi.fn(async () => ({
        categories: [
          { name: "System", tokens: 10_000 },
          { name: "Messages", tokens: 30_000 },
        ],
        totalTokens: 40_000,
        maxTokens: 200_000,
        rawMaxTokens: 200_000,
        percentage: 20,
        gridRows: [],
        model: "claude-sonnet",
      }));
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
        getContextUsage,
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.sendMessage({ sessionId: session.id, text: "hello" });
      const usage = await service.getContextUsage({ sessionId: session.id });

      expect(getContextUsage).toHaveBeenCalled();
      expect(usage?.categories).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "System", percentage: 5 }),
        expect.objectContaining({ name: "Messages", percentage: 15 }),
        expect.objectContaining({ name: "Free", percentage: 80 }),
      ]));
      expect(usage?.percentage).toBe(20);
    });
  });

  describe("Claude plugins", () => {
    it("lists discovered local Claude plugins", async () => {
      const pluginRoot = path.join(tmpRoot, ".claude", "plugins", "team-tools", "review-plugin");
      fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
        name: "review-plugin",
        description: "Review helpers",
      }));
      fs.writeFileSync(path.join(tmpRoot, ".claude", "settings.json"), JSON.stringify({
        enabledPlugins: { "review-plugin@local": true },
      }));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      expect(service.listClaudePlugins({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          name: "review-plugin",
          description: "Review helpers",
          path: fs.realpathSync(pluginRoot),
        }),
      ]);
    });

    it("reloads plugins through the live Claude query", async () => {
      const reloadPlugins = vi.fn(async () => ({
        plugins: [{ name: "review-plugin", path: "/tmp/review-plugin" }],
        commands: [{ name: "review-plugin:audit", description: "Audit" }],
        agents: [{ name: "reviewer", description: "Review code" }],
        error_count: 0,
      }));
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        ...makeDefaultClaudeSession(),
        reloadPlugins,
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.sendMessage({ sessionId: session.id, text: "hello" });
      const result = await service.reloadClaudePlugins({ sessionId: session.id });

      expect(reloadPlugins).toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({
        plugins: [expect.objectContaining({ name: "review-plugin", path: "/tmp/review-plugin" })],
        commands: [expect.objectContaining({ name: "review-plugin:audit", description: "Audit" })],
        agents: [expect.objectContaining({ name: "reviewer", description: "Review code" })],
        errorCount: 0,
      }));
      expect(service.getSlashCommands({ sessionId: session.id })).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "/review-plugin:audit", description: "Audit" }),
      ]));
    });
  });

  it("sends Claude provider slash commands as the raw SDK prompt", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-slash-command",
          slash_commands: ["/automate"],
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        return;
      }
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-slash-command",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);

    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "/automate chat slash commands",
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenLastCalledWith("/automate chat slash commands");
    });
  });

  it("does not forward Claude /login into the Agent SDK", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream: vi.fn(() => (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-login-command",
          slash_commands: ["/login"],
        };
      })()),
      close: vi.fn(),
      sessionId: "sdk-session-login-command",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);

    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await expect(service.sendMessage({
      sessionId: session.id,
      text: "/login",
    })).rejects.toThrow("/login is not an SDK-dispatchable command");
    expect(send).not.toHaveBeenCalledWith("/login");
  });

  it("expands project Claude command files before sending to the SDK", async () => {
    const commandsDir = path.join(tmpRoot, ".claude", "commands");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "audit.md"), [
      "---",
      "description: Audit recent work",
      "---",
      "",
      "Audit the work you just did.",
      "",
      "Focus: $ARGUMENTS",
      "",
    ].join("\n"));

    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-project-slash-command",
          slash_commands: [],
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        return;
      }
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-project-slash-command",
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    } as any);

    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "/audit command menus",
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenLastCalledWith("Audit the work you just did.\n\nFocus: command menus");
    });
  });

  it("expands Codex prompt files before sending to the app server", async () => {
    const promptsDir = path.join(tmpRoot, ".codex", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, "audit.md"), [
      "Audit the Codex chat work.",
      "",
      "Focus: $ARGUMENTS",
      "",
    ].join("\n"));

    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "/audit command menus",
    });

    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
    });
    const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start") as any;
    expect(turnStartRequest.params.input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: "Audit the Codex chat work.\n\nFocus: command menus",
      }),
    ]));
  });

  it("expands project Claude command files before sending to Codex", async () => {
    const commandsDir = path.join(tmpRoot, ".claude", "commands");
    const promptsDir = path.join(tmpRoot, ".codex", "prompts");
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "audit.md"), [
      "---",
      "description: Audit recent work",
      "---",
      "",
      "Audit the work.",
      "",
      "Focus: $ARGUMENTS",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(promptsDir, "audit.md"), [
      "Audit the Codex prompt.",
      "",
      "Focus: $ARGUMENTS",
      "",
    ].join("\n"));

    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.5",
      modelId: "openai/gpt-5.5",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "/audit command rendering",
    }, { awaitDispatch: true });

    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
    });
    const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start") as any;
    expect(turnStartRequest.params.input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: "Audit the work.\n\nFocus: command rendering",
      }),
    ]));
  });

  it("keeps built-in Codex slash commands routed to the app server", async () => {
    const promptsDir = path.join(tmpRoot, ".codex", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, "review.md"), "This project prompt must not replace built-in review.");
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription", cli: "claude", authenticated: true },
    ] as any);

    const { service, aiIntegrationService } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "/review",
    }, { awaitDispatch: true });

    await vi.waitFor(() => {
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "review/start")).toBe(true);
    });
    expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
    expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();
  });

  describe("runtime-native chat titles", () => {
    it("adopts Codex app-server thread names from lifecycle responses", async () => {
      mockState.codexResponseOverrides.set("thread/start", () => ({
        thread: { id: "thread-runtime-title", name: "Runtime Naming Investigation" },
      }));
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({ sessionId: session.id, text: "Check session names." });

      await waitForSessionTitle(sessionService, session.id, "Runtime Naming Investigation");
      expect(sessionService.get(session.id)?.manuallyNamed).toBe(false);
    });

    it("adopts Codex thread/name/updated notifications without overwriting manual names", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({ sessionId: session.id, text: "Name this from runtime." });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/name/updated",
        params: { threadId: "thread-1", threadName: "Captured Runtime Title" },
      });
      await waitForSessionTitle(sessionService, session.id, "Captured Runtime Title");

      await service.updateSession({ sessionId: session.id, title: "Manual Title", manuallyNamed: true });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/name/updated",
        params: { threadId: "thread-1", name: "Should Not Win" },
      });
      await waitForSessionTitle(sessionService, session.id, "Manual Title");
    });

    it("lets OpenCode session.updated titles beat ADE AI fallback", async () => {
      streamText.mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      });
      mockState.openCodeTitleForNextPrompt = "OpenCode Native Title";
      const { service, sessionService, aiIntegrationService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.sendMessage({ sessionId: session.id, text: "Use runtime title." }, { awaitDispatch: true });

      await waitForSessionTitle(sessionService, session.id, "OpenCode Native Title");
      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();
      expect(vi.mocked(startOpenCodeSession).mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ title: null }),
      );
    });

    it("adopts Droid SDK session_title_updated titles", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      await service.sendMessage({ sessionId: session.id, text: "Use SDK title." }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(typeof mockState.droidPooled.bridge.onEvent).toBe("function");
      }, { timeout: 1_000 });
      mockState.droidPooled.bridge.onEvent?.({
        type: "session_title_updated",
        title: "Droid Native Title",
      });

      await waitForSessionTitle(sessionService, session.id, "Droid Native Title");
    });
  });

  // --------------------------------------------------------------------------
  // updateSession
  // --------------------------------------------------------------------------

  describe("updateSession", () => {
    it("broadcasts a session_meta_updated event with mode fields on a mode change", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      events.length = 0;

      await service.updateSession({
        sessionId: session.id,
        opencodePermissionMode: "plan",
      });

      const metaEvent = events
        .map((envelope) => envelope.event)
        .find((event): event is Extract<typeof event, { type: "session_meta_updated" }> =>
          event.type === "session_meta_updated");
      expect(metaEvent).toBeDefined();
      expect(metaEvent?.opencodePermissionMode).toBe("plan");
    });

    it("does not broadcast mode fields when no mode field is updated", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      events.length = 0;

      await service.updateSession({
        sessionId: session.id,
        reasoningEffort: "high",
      });

      const metaEventsWithMode = events
        .map((envelope) => envelope.event)
        .filter((event) => event.type === "session_meta_updated")
        .filter((event) => "opencodePermissionMode" in event
          || "permissionMode" in event
          || "codexApprovalPolicy" in event
          || "cursorModeId" in event);
      expect(metaEventsWithMode).toHaveLength(0);
    });

    it("updates the session title", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        title: "My Custom Title",
      });

      expect(updated.id).toBe(session.id);
      expect(sessionService.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id, title: "My Custom Title" }),
      );
    });

    it("resets title to default when set to empty string", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.updateSession({
        sessionId: session.id,
        title: "",
      });

      expect(sessionService.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id, title: "AI Chat" }),
      );
    });

    it("updates reasoning effort", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        reasoningEffort: "high",
      });

      expect(updated.reasoningEffort).toBe("high");
    });

    it("normalizes reasoning effort trimming and lowercase", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        reasoningEffort: "  MEDIUM  ",
      });

      expect(updated.reasoningEffort).toBe("medium");
    });

    it("throws when updating with unknown model id", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await expect(
        service.updateSession({
          sessionId: session.id,
          modelId: "totally-fake-model-123",
        }),
      ).rejects.toThrow(/unknown model/i);
    });

    it("throws when updating with empty model id", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await expect(
        service.updateSession({
          sessionId: session.id,
          modelId: "",
        }),
      ).rejects.toThrow(/modelId is required/i);
    });

    it("updates permission mode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      expect(updated.permissionMode).toBe("full-auto");
    });

    it("manuallyNamed suppresses auto-titling after sendMessage", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "sdk-session-1",
              slash_commands: [],
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Done" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any);

      const { service, sessionService, aiIntegrationService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      // Set the title manually with manuallyNamed flag
      await service.updateSession({
        sessionId: session.id,
        title: "My Title",
        manuallyNamed: true,
      });

      expect(sessionService.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id, title: "My Title" }),
      );

      // Send a message — this would normally trigger auto-titling
      await service.sendMessage({
        sessionId: session.id,
        text: "Build me a new feature",
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done",
      );

      // Give auto-title a chance to fire (it's a void promise)
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // dispose and disposeAll
  // --------------------------------------------------------------------------

  describe("hasActiveWorkloads", () => {
    it("reports active Codex app-server turns so project rebalancing keeps their context alive", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      expect(service.hasActiveWorkloads()).toBe(false);

      await service.sendMessage({
        sessionId: session.id,
        text: "Keep this turn alive during a project switch.",
      }, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      expect(service.hasActiveWorkloads()).toBe(true);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done"
          && event.event.status === "completed"
          && event.event.turnId === "turn-1",
      );

      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("reports active Claude turns so project switching does not close the chat runtime", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let finishTurn = () => {};
      const finishTurnPromise = new Promise<void>((resolve) => { finishTurn = resolve; });
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-active-claude", slash_commands: [] };
            warmupComplete = true;
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: "sdk-active-claude",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            return;
          }
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "working" },
            },
          };
          await finishTurnPromise;
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-active-claude",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-active-claude",
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
      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      try {
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this Claude turn alive during a project switch.",
        });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "text"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("reports active opencode turns so project switching does not close the chat runtime", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let finishTurn = () => {};
      const finishTurnPromise = new Promise<void>((resolve) => { finishTurn = resolve; });
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "working" };
          await finishTurnPromise;
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      try {
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this opencode turn alive during a project switch.",
        }, { awaitDispatch: true });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "text"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("reports active Cursor SDK turns so project switching does not close the chat runtime", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      let finishTurn = () => {};
      mockState.cursorSendPromptGate = new Promise<void>((resolve) => { finishTurn = resolve; });
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      try {
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this Cursor turn alive during a project switch.",
        }, { awaitDispatch: true });
        await vi.waitFor(() => {
          expect(mockState.cursorSdkSendCalls.length).toBeGreaterThan(0);
        });
        expect(mockState.cursorSdkSendCalls.at(-1)).toMatchObject({
          mode: "agent",
          idempotencyKey: expect.stringMatching(new RegExp(`^ade:${session.id}:.+:cursor-local:send$`)),
        });
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("surfaces Cursor SDK HTTP/2 backoff failures as rate limits", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      mockState.cursorSendPromptError = new Error(
        "Cursor SDK send failed: Cursor rate limited this request: [internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
      );
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Trigger Cursor backoff.",
      }, { awaitDispatch: true });

      const errorEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "error" }> } =>
          event.event.type === "error" && event.sessionId === session.id,
      );
      expect(errorEvent.event.message).toContain("Rate limited by Cursor");
      expect(errorEvent.event.errorInfo).toMatchObject({
        category: "rate_limit",
        provider: "Cursor",
      });
      expect(errorEvent.event.detail).toContain("NGHTTP2_ENHANCE_YOUR_CALM");
    });

    it("surfaces Cursor SDK transport codes as network failures", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      mockState.cursorSendPromptError = Object.assign(
        new Error("Cursor SDK send failed: [internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR"),
        {
          code: "network",
          cursorSdk: {
            message: "[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
            requestId: "req-cursor-network",
          },
        },
      );
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Trigger Cursor transport failure.",
      }, { awaitDispatch: true });

      const errorEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "error" }> } =>
          event.event.type === "error" && event.sessionId === session.id,
      );
      expect(errorEvent.event.errorInfo).toMatchObject({
        category: "network",
        provider: "Cursor",
      });
      expect(errorEvent.event.detail).toContain("req-cursor-network");
    });

    it("reacquires Cursor SDK workers that exited before a follow-up turn", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "First Cursor turn.",
      });
      const firstPooled = mockState.cursorSdkPooled;
      firstPooled.process.exitCode = 1;

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Follow-up after worker exit.",
      });

      expect(mockState.cursorSdkAcquireCalls).toHaveLength(2);
      expect(firstPooled.sendPrompt).toHaveBeenCalledTimes(1);
      expect(mockState.cursorSdkPooled).not.toBe(firstPooled);
      expect(mockState.cursorSdkPooled.sendPrompt).toHaveBeenCalledTimes(1);
    });

    it("keeps Cursor SDK state stable when policy changes require a new worker pool", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
        permissionMode: "edit",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "First Cursor turn.",
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Follow-up after policy change.",
      });

      expect(mockState.cursorSdkAcquireCalls).toHaveLength(2);
      const firstAcquire = mockState.cursorSdkAcquireCalls[0];
      const secondAcquire = mockState.cursorSdkAcquireCalls[1];
      expect(secondAcquire.poolKey).not.toBe(firstAcquire.poolKey);
      expect(secondAcquire.stateKey).toBe(firstAcquire.stateKey);
    });

    it("injects recent ADE context when Cursor SDK resume opens a new agent", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the mobile files tab parity work.",
      });
      const firstPooled = mockState.cursorSdkPooled;
      firstPooled.process.exitCode = 1;
      mockState.cursorSdkAgentIdForNextAcquire = "cursor-sdk-agent-2";

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Did you finish the prior work?",
      });

      expect(mockState.cursorSdkAcquireCalls).toHaveLength(2);
      expect(mockState.cursorSdkAcquireCalls[1]).toEqual(
        expect.objectContaining({ agentId: "cursor-sdk-agent-1" }),
      );
      const promptText = String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? "");
      expect(promptText).toContain("Cursor SDK continuity recovery");
      expect(promptText).toContain("cursor-sdk-agent-1");
      expect(promptText).toContain("cursor-sdk-agent-2");
      expect(promptText).toContain("Recent Conversation Tail");
      expect(promptText).toContain("User: Inspect the mobile files tab parity work.");
      expect(promptText).toContain("Did you finish the prior work?");
      // Prompts are prepared before the runtime is acquired, so the rotation
      // turn itself stays deduped — but the rotated agent is brand new, so the
      // lane execution directive must be re-emitted on the following turn
      // instead of staying suppressed by lastLaneDirectiveKey.
      expect(promptText).not.toContain("[ADE launch directive]");
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Continue with the next step.",
      });
      const postRotationPrompt = String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? "");
      expect(postRotationPrompt).toContain("[ADE launch directive]");
    });

    it("recreates the Cursor SDK agent with recovery context when resume state is missing", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Inspect the runtime compaction lane crash.",
      });
      const firstPooled = mockState.cursorSdkPooled;
      firstPooled.process.exitCode = 1;
      mockState.cursorSdkAgentIdForNextAcquire = "cursor-sdk-agent-2";
      vi.mocked(acquireCursorSdkConnection).mockImplementationOnce(async (args: Record<string, unknown>) => {
        mockState.cursorSdkAcquireCalls.push(args);
        throw Object.assign(
          new Error("Agent cursor-sdk-agent-1 not found (operation=Agent.resume)"),
          {
            code: "agent_not_found",
            cursorSdk: {
              code: "agent_not_found",
              message: "Agent cursor-sdk-agent-1 not found",
              operation: "Agent.resume",
            },
          },
        );
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Did the SDK resume bug come back?",
      });

      expect(mockState.cursorSdkAcquireCalls).toHaveLength(3);
      expect(mockState.cursorSdkAcquireCalls[1]).toEqual(
        expect.objectContaining({ agentId: "cursor-sdk-agent-1" }),
      );
      expect(mockState.cursorSdkAcquireCalls[2]).toEqual(
        expect.objectContaining({ agentId: null }),
      );
      const promptText = String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? "");
      expect(promptText).toContain("Cursor SDK continuity recovery");
      expect(promptText).toContain("cursor-sdk-agent-1");
      expect(promptText).toContain("cursor-sdk-agent-2");
      expect(promptText).toContain("Recent Conversation Tail");
      expect(promptText).toContain("User: Inspect the runtime compaction lane crash.");
      expect(promptText).toContain("Did the SDK resume bug come back?");
    });

    it("reports active Droid SDK turns so project switching does not close the chat runtime", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let finishTurn = () => {};
      mockState.droidPromptGate = new Promise<void>((resolve) => { finishTurn = resolve; });
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "droid",
        model: "custom:claude-sonnet-5-thinking-32000",
        modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      });

      try {
        expect(service.hasActiveWorkloads()).toBe(false);

        const turnPromise = service.sendMessage({
          sessionId: session.id,
          text: "Keep this Droid turn alive during a project switch.",
        }, { awaitDispatch: true });
        await vi.waitFor(() => {
          expect(mockState.droidPromptCalls.length).toBeGreaterThan(0);
        });
        expect(service.hasActiveWorkloads()).toBe(true);

        finishTurn();
        await expect(turnPromise).resolves.toBeUndefined();
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.status === "completed"
            && event.sessionId === session.id,
        );
        expect(service.hasActiveWorkloads()).toBe(false);
      } finally {
        finishTurn();
      }
    });

    it("does not treat an idle reusable Claude query as an active workload", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-claude",
            slash_commands: [],
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sdk-idle-claude",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        })()),
        close: vi.fn(),
        sessionId: "sdk-idle-claude",
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

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Complete a short turn.",
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done"
          && event.event.status === "completed",
      );

      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("projects the next durable wake onto the chat session summary", async () => {
      const before = Date.now();
      let streamCall = 0;
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          streamCall += 1;
          if (streamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-next-wake", slash_commands: [] };
            return;
          }
          yield {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: "tool-next-wake",
                name: "ScheduleWakeup",
                input: {
                  delaySeconds: 120,
                  reason: "Check PR CI",
                  prompt: "Check PR CI and report the result.",
                },
              }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: "sdk-next-wake",
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({ sessionId: session.id, text: "Check CI again later." });

      const summary = await service.getSessionSummary(session.id);
      const nextWakeAt = Date.parse(summary?.nextWakeAt ?? "");
      expect(summary?.scheduledWorkPaused).toBe(false);
      expect(nextWakeAt).toBeGreaterThanOrEqual(before + 119_000);
      expect(nextWakeAt).toBeLessThanOrEqual(Date.now() + 121_000);
      service.forceDisposeAll();
    });

    it("keeps the Claude SDK stream alive for scheduled wakeups after a foreground result", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startBackground!: () => void;
      let finishBackground!: () => void;
      const startBackgroundPromise = new Promise<void>((resolve) => { startBackground = resolve; });
      const finishBackgroundPromise = new Promise<void>((resolve) => { finishBackground = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-wakeup",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-wakeup",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startBackgroundPromise;
        yield {
          type: "assistant",
          uuid: "assistant-idle-tool",
          message: {
            id: "msg-idle-tool",
            content: [
              {
                type: "tool_use",
                id: "tool-wakeup-1",
                name: "ScheduleWakeup",
                input: {
                  reason: "CI was still running",
                  prompt: "Check CI again and report back.",
                },
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        };
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-idle-wakeup",
          task_id: "cron-task-1",
          task_type: "cron",
          parent_tool_use_id: "tool-wakeup-1",
          description: "Check CI again",
          agent_id: "agent-child-1",
          parent_agent_id: "agent-parent-1",
        };

        await finishBackgroundPromise;
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-idle-wakeup",
          task_id: "cron-task-1",
          task_type: "cron",
          parent_tool_use_id: "tool-wakeup-1",
          patch: { status: "completed" },
          summary: "CI passed.",
          agent_id: "agent-child-1",
          parent_agent_id: "agent-parent-1",
        };
        yield {
          type: "assistant",
          uuid: "assistant-idle-text",
          message: {
            id: "msg-idle-text",
            content: [{ type: "text", text: "CI passed." }],
            usage: { input_tokens: 2, output_tokens: 4 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-wakeup",
          usage: { input_tokens: 2, output_tokens: 4 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-wakeup",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Run CI and wake up when it finishes.",
      });
      expect(service.hasActiveWorkloads()).toBe(false);
      const wakeupId = `wakeup:${session.id}`;

      vi.mocked(runGit).mockClear();
      startBackground();
      await vi.waitFor(() => {
        expect(runGit).toHaveBeenCalledWith(["rev-parse", "HEAD"], expect.objectContaining({ timeoutMs: 8_000 }));
      });
      const wakeupEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === wakeupId,
      );
      expect(wakeupEvent.event).toMatchObject({
        kind: "wakeup",
        status: "scheduled",
        origin: "schedule_wakeup",
        reason: "CI was still running",
        prompt: "Check CI again and report back.",
      });
      expect(wakeupEvent.event.turnId).toMatch(/^claude-idle-/);
      expect(service.hasActiveWorkloads()).toBe(true);

      const cronRunningEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === wakeupId
          && event.event.status === "running",
      );
      expect(cronRunningEvent.event).toMatchObject({
        kind: "wakeup",
        origin: "cron",
        title: "Check CI again",
        sourceToolUseId: "tool-wakeup-1",
        sourceTaskId: "cron-task-1",
      });

      finishBackground();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === wakeupId
          && event.event.status === "completed",
      );
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "done"
          && event.event.turnId.startsWith("claude-idle-")
          && event.event.status === "completed",
      );
      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("groups idle-reader Claude deltas by the stable message id and suppresses the repeated snapshot", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      const messageId = "msg-idle-stable-stream";
      const fragments = ["Idle ", "Claude ", "text ", "stays ", "whole."];
      const fullText = fragments.join("");
      let streamCall = 0;
      let startIdle!: () => void;
      const startIdlePromise = new Promise<void>((resolve) => { startIdle = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-stable-stream",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-stable-stream",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startIdlePromise;
        yield {
          type: "stream_event",
          uuid: "wire-idle-message-start",
          event: {
            type: "message_start",
            message: { id: messageId, usage: { input_tokens: 1, output_tokens: 0 } },
          },
        };
        for (const [index, text] of fragments.entries()) {
          yield {
            type: "stream_event",
            uuid: `wire-idle-delta-${index + 1}`,
            event: {
              type: "content_block_delta",
              index: 0,
              message: { id: messageId },
              delta: { type: "text_delta", text },
            },
          };
        }
        yield {
          type: "assistant",
          uuid: "wire-idle-assistant-snapshot",
          supersedes: ["superseded-idle-wire-message"],
          message: {
            id: messageId,
            content: [{ type: "text", text: fullText }],
            usage: { input_tokens: 1, output_tokens: 5 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-stable-stream",
          usage: { input_tokens: 1, output_tokens: 5 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-stable-stream",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Complete the foreground turn, then stream idle work.",
      });

      startIdle();
      const idleDone = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "done"
          && event.event.turnId.startsWith("claude-idle-")
          && event.event.status === "completed",
      );

      const textEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> =>
          event.type === "text" && event.turnId === idleDone.event.turnId
        );
      expect(textEvents.map((event) => event.text).join("")).toBe(fullText);
      expect(new Set(textEvents.map((event) => event.messageId))).toEqual(new Set([messageId]));

      const retraction = events.find((event) =>
        event.event.type === "transcript_retraction"
        && event.event.turnId === idleDone.event.turnId
      );
      expect(retraction?.event).toMatchObject({
        type: "transcript_retraction",
        replacementMessageId: messageId,
      });
    });

    it("keeps idle skip_transcript tasks out of visible chat info", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startAmbient!: () => void;
      let ambientDrained = false;
      const startAmbientPromise = new Promise<void>((resolve) => { startAmbient = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-skip-transcript",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-skip-transcript",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startAmbientPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-idle-skip-transcript",
          task_id: "task-ambient-idle-1",
          description: "Generate session title",
          task_type: "other",
          skip_transcript: true,
        };
        yield {
          type: "system",
          subtype: "task_progress",
          session_id: "sdk-idle-skip-transcript",
          task_id: "task-ambient-idle-1",
          summary: "thinking",
        };
        yield {
          type: "system",
          subtype: "task_notification",
          session_id: "sdk-idle-skip-transcript",
          task_id: "task-ambient-idle-1",
          status: "completed",
          summary: "Done",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-skip-transcript",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        ambientDrained = true;
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-skip-transcript",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Complete a visible turn, then let idle housekeeping run.",
      });

      startAmbient();
      await vi.waitFor(() => {
        expect(ambientDrained).toBe(true);
      });

      expect(events.filter((event) =>
        event.sessionId === session.id
        && (event.event.type === "subagent_started"
          || event.event.type === "subagent_progress"
          || event.event.type === "subagent_result")
        && (event.event as { taskId?: string }).taskId === "task-ambient-idle-1",
      )).toEqual([]);
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "status"
        && event.event.turnId?.startsWith("claude-idle-") === true,
      )).toBe(false);
      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("delivers queued steers after an idle Claude turn completes", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startBackground!: () => void;
      let finishBackground!: () => void;
      const startBackgroundPromise = new Promise<void>((resolve) => { startBackground = resolve; });
      const finishBackgroundPromise = new Promise<void>((resolve) => { finishBackground = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-idle-queued-steer",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-queued-steer",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startBackgroundPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-idle-queued-steer",
          task_id: "cron-task-queued-steer",
          task_type: "cron",
          description: "Check queued steer",
        };

        await finishBackgroundPromise;
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-idle-queued-steer",
          task_id: "cron-task-queued-steer",
          task_type: "cron",
          patch: { status: "completed" },
          summary: "Background task completed.",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-queued-steer",
          usage: { input_tokens: 2, output_tokens: 3 },
        };

        yield {
          type: "assistant",
          uuid: "assistant-queued-steer",
          message: {
            id: "msg-queued-steer",
            content: [{ type: "text", text: "Queued steer delivered." }],
            usage: { input_tokens: 3, output_tokens: 4 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-idle-queued-steer",
          usage: { input_tokens: 3, output_tokens: 4 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idle-queued-steer",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Start a scheduled check.",
      });

      startBackground();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.status === "running",
      );

      const steerResult = await service.steer({
        sessionId: session.id,
        text: "Follow up after the background task.",
      });
      expect(steerResult.queued).toBe(true);

      finishBackground();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "text"
          && event.event.text.includes("Queued steer delivered."),
      );
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Follow up after the background task."));
      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("keys Claude cron create and delete events by the provider cron id", async () => {
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
            session_id: "sdk-cron-id",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          uuid: "assistant-cron-tools",
          message: {
            id: "msg-cron-tools",
            content: [
              {
                type: "tool_use",
                id: "tool-cron-create",
                name: "CronCreate",
                input: {
                  id: "cron-sdk-1",
                  cron: "*/15 * * * *",
                  prompt: "Check CI status.",
                },
              },
              {
                type: "tool_use",
                id: "tool-cron-delete",
                name: "CronDelete",
                input: {
                  id: "cron-sdk-1",
                },
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-id",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-id",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule and then cancel a CI cron.",
      });

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "cron");
      expect(scheduledEvents.map((event) => event.event.id)).toEqual(["cron-sdk-1", "cron-sdk-1"]);
      expect(scheduledEvents.map((event) => event.event.status)).toEqual(["scheduled", "cancelled"]);

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: "cron-sdk-1",
        status: "cancelled",
        cron: "*/15 * * * *",
        prompt: "Check CI status.",
        sourceToolUseId: "tool-cron-delete",
      });
    });

    it("waits for the provider cron id before creating a CronCreate scheduled row", async () => {
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
            session_id: "sdk-cron-provider-id",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          uuid: "assistant-cron-create-no-id",
          message: {
            id: "msg-cron-create-no-id",
            content: [
              {
                type: "tool_use",
                id: "tool-cron-create-no-id",
                name: "CronCreate",
                input: {
                  cron: "*/15 * * * *",
                  prompt: "Check CI status.",
                },
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-provider-id",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-provider-id",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule a CI cron.",
      });

      expect(events.filter((event) =>
        event.sessionId === session.id
        && event.event.type === "scheduled_work_update"
        && event.event.kind === "cron",
      )).toEqual([]);

      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [{
          id: "cron-provider-1",
          schedule: "*/15 * * * *",
          prompt: "Check CI status.",
          recurring: true,
        }],
      });

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: "cron-provider-1",
        status: "scheduled",
        cron: "*/15 * * * *",
        prompt: "Check CI status.",
      });
    });

    it("coalesces one-shot wakeup hook snapshots with the scheduled wakeup row", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let cancelWakeup!: () => void;
      const cancelWakeupPromise = new Promise<void>((resolve) => { cancelWakeup = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-wakeup-provider-id",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          uuid: "assistant-wakeup-provider-id",
          message: {
            id: "msg-wakeup-provider-id",
            content: [
              {
                type: "tool_use",
                id: "tool-wakeup-provider-id",
                name: "ScheduleWakeup",
                input: {
                  reason: "CI was still running",
                  prompt: "Check CI again.",
                },
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-wakeup-provider-id",
          usage: { input_tokens: 2, output_tokens: 3 },
        };

        await cancelWakeupPromise;
        yield {
          type: "assistant",
          uuid: "assistant-wakeup-provider-delete",
          message: {
            id: "msg-wakeup-provider-delete",
            content: [
              {
                type: "tool_use",
                id: "tool-wakeup-provider-delete",
                name: "CronDelete",
                input: {
                  id: "wakeup-provider-1",
                },
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-wakeup-provider-id",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-wakeup-provider-id",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];
      const wakeupId = `wakeup:${session.id}`;

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule a one-shot CI wakeup.",
      });

      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [{
          id: "wakeup-provider-1",
          schedule: "once",
          prompt: "Check CI again.",
          recurring: false,
        }],
      });

      cancelWakeup();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === wakeupId
          && event.event.status === "cancelled",
      );

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "wakeup");
      expect(scheduledEvents.map((event) => event.event.id)).toEqual([wakeupId, wakeupId, wakeupId]);
      expect(scheduledEvents.map((event) => event.event.status)).toEqual(["scheduled", "scheduled", "cancelled"]);

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: wakeupId,
        kind: "wakeup",
        status: "cancelled",
        prompt: "Check CI again.",
        sourceTaskId: "wakeup-provider-1",
      });
    });

    it("coalesces parentless recurring cron run events with the provider cron row", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startCronRun!: () => void;
      const startCronRunPromise = new Promise<void>((resolve) => { startCronRun = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-parentless-run",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-run",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startCronRunPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-cron-parentless-run",
          task_id: "cron-run-task-1",
          task_type: "cron",
          description: "Check CI status.",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-cron-parentless-run",
          task_id: "cron-run-task-1",
          task_type: "cron",
          patch: { status: "completed" },
          summary: "CI passed.",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-run",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-parentless-run",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule a recurring CI cron.",
      });

      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [{
          id: "cron-provider-parentless-1",
          schedule: "*/15 * * * *",
          prompt: "Check CI status.",
          recurring: true,
        }],
      });

      startCronRun();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === "cron-provider-parentless-1"
          && event.event.status === "completed",
      );

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "cron");
      expect(scheduledEvents.map((event) => event.event.id)).toEqual([
        "cron-provider-parentless-1",
        "cron-provider-parentless-1",
        "cron-provider-parentless-1",
      ]);

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: "cron-provider-parentless-1",
        kind: "cron",
        status: "completed",
        sourceTaskId: "cron-run-task-1",
      });
    });

    it("matches parentless recurring cron runs by prompt when multiple provider crons are active", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startCronRun!: () => void;
      const startCronRunPromise = new Promise<void>((resolve) => { startCronRun = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-parentless-multiple",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-multiple",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startCronRunPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-cron-parentless-multiple",
          task_id: "cron-run-task-multiple",
          task_type: "cron",
          description: "Review issue comments.",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-cron-parentless-multiple",
          task_id: "cron-run-task-multiple",
          task_type: "cron",
          patch: { status: "completed" },
          summary: "One new review comment was found.",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-multiple",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-parentless-multiple",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule two recurring crons.",
      });

      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [
          {
            id: "cron-provider-multiple-ci",
            schedule: "*/15 * * * *",
            prompt: "Check CI status.",
            recurring: true,
          },
          {
            id: "cron-provider-multiple-review",
            schedule: "*/20 * * * *",
            prompt: "Review issue comments.",
            recurring: true,
          },
        ],
      });

      startCronRun();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.id === "cron-provider-multiple-review"
          && event.event.status === "completed",
      );

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "cron");
      expect(scheduledEvents.map((event) => event.event.id)).toEqual([
        "cron-provider-multiple-ci",
        "cron-provider-multiple-review",
        "cron-provider-multiple-review",
        "cron-provider-multiple-review",
      ]);
      expect(scheduledEvents.map((event) => event.event.id)).not.toContain("cron-run-task-multiple");

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(2);
      expect(snapshots.find((snapshot) => snapshot.id === "cron-provider-multiple-ci")).toMatchObject({
        id: "cron-provider-multiple-ci",
        kind: "cron",
        status: "scheduled",
      });
      expect(snapshots.find((snapshot) => snapshot.id === "cron-provider-multiple-review")).toMatchObject({
        id: "cron-provider-multiple-review",
        kind: "cron",
        status: "completed",
        sourceTaskId: "cron-run-task-multiple",
      });
    });

    it("does not create task-id scheduled rows for ambiguous parentless cron runs", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startCronRun!: () => void;
      const startCronRunPromise = new Promise<void>((resolve) => { startCronRun = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-parentless-ambiguous",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-ambiguous",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startCronRunPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-cron-parentless-ambiguous",
          task_id: "cron-run-task-ambiguous",
          task_type: "cron",
          description: "Run scheduled maintenance.",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-cron-parentless-ambiguous",
          task_id: "cron-run-task-ambiguous",
          task_type: "cron",
          patch: { status: "completed" },
          summary: "Finished scheduled maintenance.",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-parentless-ambiguous",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-parentless-ambiguous",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule two recurring crons.",
      });

      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [
          {
            id: "cron-provider-ambiguous-ci",
            schedule: "*/15 * * * *",
            prompt: "Check CI status.",
            recurring: true,
          },
          {
            id: "cron-provider-ambiguous-review",
            schedule: "*/20 * * * *",
            prompt: "Review issue comments.",
            recurring: true,
          },
        ],
      });

      startCronRun();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "subagent_result"
          && event.event.taskId === "cron-run-task-ambiguous",
      );

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "cron");
      expect(scheduledEvents.map((event) => event.event.id)).toEqual([
        "cron-provider-ambiguous-ci",
        "cron-provider-ambiguous-review",
      ]);
      expect(scheduledEvents.map((event) => event.event.id)).not.toContain("cron-run-task-ambiguous");

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(2);
      expect(snapshots.map((snapshot) => snapshot.status).sort()).toEqual(["scheduled", "scheduled"]);
    });

    it("does not create task-id scheduled rows for parentless cron runs when aliases are empty", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let startCronRun!: () => void;
      const startCronRunPromise = new Promise<void>((resolve) => { startCronRun = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-cron-empty-aliases",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-empty-aliases",
          usage: { input_tokens: 1, output_tokens: 1 },
        };

        await startCronRunPromise;
        yield {
          type: "system",
          subtype: "task_started",
          session_id: "sdk-cron-empty-aliases",
          task_id: "cron-run-task-empty-aliases",
          task_type: "cron",
          description: "Check CI status.",
        };
        yield {
          type: "system",
          subtype: "task_updated",
          session_id: "sdk-cron-empty-aliases",
          task_id: "cron-run-task-empty-aliases",
          task_type: "cron",
          patch: { status: "completed" },
          summary: "CI passed.",
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "sdk-cron-empty-aliases",
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-cron-empty-aliases",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      const opts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
        hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
      } | undefined;
      const stopHook = opts?.hooks?.Stop?.[0]?.hooks[0];

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Resume after a persisted cron was scheduled.",
      });

      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [{
          id: "cron-provider-empty-aliases",
          schedule: "*/15 * * * *",
          prompt: "Check CI status.",
          recurring: true,
        }],
      });
      await stopHook?.({
        hook_event_name: "Stop",
        session_crons: [],
      });

      startCronRun();
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.sessionId === session.id
          && event.event.type === "subagent_result"
          && event.event.taskId === "cron-run-task-empty-aliases",
      );

      const scheduledEvents = events
        .filter((event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "scheduled_work_update" }>;
        } =>
          event.sessionId === session.id
          && event.event.type === "scheduled_work_update"
          && event.event.kind === "cron");
      expect(scheduledEvents.map((event) => event.event.id)).toEqual(["cron-provider-empty-aliases"]);
      expect(scheduledEvents.map((event) => event.event.id)).not.toContain("cron-run-task-empty-aliases");

      const snapshots = deriveScheduledWorkSnapshots(events);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: "cron-provider-empty-aliases",
        kind: "cron",
        status: "scheduled",
      });
    });
  });

  describe("hasRetainableSessions", () => {
    it("is true while any chat session is open and false after it is closed", async () => {
      const { service } = createService();
      expect(service.hasRetainableSessions()).toBe(false);

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      // Idle session (no active turn, no pending input) — hasActiveWorkloads
      // is narrow and returns false. hasRetainableSessions must still report
      // true so project-context rebalancing keeps the agent runtime alive
      // for an instant resume after a project switch.
      expect(service.hasActiveWorkloads()).toBe(false);
      expect(service.hasRetainableSessions()).toBe(true);

      await service.dispose({ sessionId: session.id });
      expect(service.hasRetainableSessions()).toBe(false);
    });
  });

  describe("dispose", () => {
    it("only writes the persisted chat summary when the session is explicitly disposed", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Investigate the flaky login tests",
      });

      expect(sessionService.setSummary).not.toHaveBeenCalled();

      await service.dispose({ sessionId: session.id });

      expect(sessionService.setSummary).toHaveBeenCalledWith(
        session.id,
        expect.stringContaining("Session closed"),
      );
    });

    it("disposes a session and marks it ended", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.dispose({ sessionId: session.id });

      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id }),
      );
    });

    it("dispose cancels durable schedules and emits cancelled scheduled_work_update", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const events: AgentChatEventEnvelope[] = [];
      installClaudeWakeupFixture({
        sdkSessionId: "sdk-dispose-cancel",
        delaySeconds: 60,
      });
      const { service, sessionService } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Check CI again later.",
      });
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({ sessionId: session.id, status: "scheduled" }),
      ]);

      await service.dispose({ sessionId: session.id });

      expect(sessionService.get(session.id)).toEqual(expect.objectContaining({
        status: "disposed",
        endedAt: expect.any(String),
      }));
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({ sessionId: session.id, status: "cancelled" }),
      ]);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sessionId: session.id,
          event: expect.objectContaining({
            type: "scheduled_work_update",
            status: "cancelled",
          }),
        }),
      ]));
      service.forceDisposeAll();
    });

    it("a scheduled fire after dispose does not resume the session", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const events: AgentChatEventEnvelope[] = [];
      installClaudeWakeupFixture({
        sdkSessionId: "sdk-dispose-no-fire",
        delaySeconds: 1,
      });
      const { service, sessionService } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Wake once to check CI.",
      });
      await service.dispose({ sessionId: session.id });
      const startedTurnsBeforeAdvance = events.filter((event) =>
        event.sessionId === session.id
        && event.event.type === "status"
        && event.event.turnStatus === "started"
      ).length;

      await vi.advanceTimersByTimeAsync(65_000);

      expect(sessionService.get(session.id)).toEqual(expect.objectContaining({
        status: "disposed",
        endedAt: expect.any(String),
      }));
      expect(scheduledWork.readState()?.schedules[0]?.status).toBe("cancelled");
      expect(events.filter((event) =>
        event.sessionId === session.id
        && event.event.type === "status"
        && event.event.turnStatus === "started"
      )).toHaveLength(startedTurnsBeforeAdvance);
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "user_message"
        && event.event.metadata?.scheduledWake != null
      )).toBe(false);
      service.forceDisposeAll();
    });

    it("finishSession clears pending native scheduled wakes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      const events: AgentChatEventEnvelope[] = [];
      installClaudeWakeupFixture({
        sdkSessionId: "sdk-pending-native-wake",
        delaySeconds: 60,
        prompt: "Stale native wake must not survive dispose.",
      });
      const { service } = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Queue a native wake.",
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(scheduledWork.readState()?.schedules[0]?.status).toBe("fired");
      expect(service.pendingNativeScheduledWakeCountForTesting(session.id)).toBe(1);

      await service.dispose({ sessionId: session.id });

      expect(service.pendingNativeScheduledWakeCountForTesting(session.id)).toBe(0);
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "user_message"
        && event.event.metadata?.scheduledWake?.reason === "Stale native wake must not survive dispose."
      )).toBe(false);
      service.forceDisposeAll();
    });

    it("evicts disposed chats from the live managed session cache", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(service.getSlashCommands({ sessionId: session.id })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "/clear" }),
        ]),
      );

      await service.dispose({ sessionId: session.id });

      expect(service.getSlashCommands({ sessionId: session.id })).toEqual([]);
    });

    it("terminates the Codex runtime process tree when disposing a live Codex chat", async () => {
      const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true as any);
      vi.useFakeTimers();
      try {
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.4",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Inspect the repo",
        });

        await service.dispose({ sessionId: session.id });

        expect(spawn).toHaveBeenCalledWith(
          "codex",
          ["app-server", "-c", "model_reasoning_effort=\"medium\""],
          expect.objectContaining({ detached: process.platform !== "win32" }),
        );
        expect(processKillSpy).toHaveBeenCalledWith(-99999, "SIGTERM");

        await vi.advanceTimersByTimeAsync(1500);
        expect(processKillSpy).toHaveBeenCalledWith(-99999, "SIGKILL");
      } finally {
        vi.useRealTimers();
      }
    });

    it("throws when disposing an unknown session", async () => {
      const { service } = createService();
      await expect(service.dispose({ sessionId: "no-such-session" })).rejects.toThrow(/not found/i);
    });

    it("maps an attach_failed OpenCode eviction reason to handle_close when tearing down the runtime", async () => {
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
        })(),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Investigate the flaky login tests",
      });

      const startMock = vi.mocked(startOpenCodeSession);
      expect(startMock.mock.results.length).toBeGreaterThan(0);
      const handle = await startMock.mock.results.at(-1)!.value as {
        setEvictionHandler: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };

      const evictionCalls = handle.setEvictionHandler.mock.calls;
      // The most-recent non-null handler registration is the one that wires up teardown.
      const registrations = evictionCalls
        .map((args) => args[0])
        .filter((fn): fn is (reason: string) => void => typeof fn === "function");
      expect(registrations.length).toBeGreaterThan(0);
      const evictionHandler = registrations[registrations.length - 1]!;

      const closeCallsBefore = handle.close.mock.calls.length;
      await evictionHandler("attach_failed");

      const closeReasonsAfter = handle.close.mock.calls.slice(closeCallsBefore).map(([reason]) => reason);
      expect(closeReasonsAfter).toContain("handle_close");
      expect(closeReasonsAfter).not.toContain("attach_failed");
    });
  });

  describe("disposeAll", () => {
    it("disposes all active sessions without throwing", async () => {
      const { service } = createService();

      await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });
      mockState.uuidCounter = 10; // avoid collision
      await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      // Should not throw
      await expect(service.disposeAll()).resolves.toBeUndefined();
    });

    it("asks the Claude subprocess reaper to terminate remaining SDK children", async () => {
      const claudeSubprocessReaper = {
        register: vi.fn(),
        spawnClaudeCodeProcess: vi.fn(),
        reapForSession: vi.fn(),
        reapAll: vi.fn(),
        liveRecords: vi.fn(() => []),
      };
      const { service } = createService({ claudeSubprocessReaper });

      await expect(service.disposeAll()).resolves.toBeUndefined();

      expect(claudeSubprocessReaper.reapAll).toHaveBeenCalledWith("dispose_all");
    });

    it("disposeAll ends sessions as detached and preserves scheduled work", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      installClaudeWakeupFixture({
        sdkSessionId: "sdk-dispose-all-detached",
        delaySeconds: 60,
      });
      const { service, sessionService } = createService({ db: scheduledWork.db });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule work across restart.",
      });

      await service.disposeAll();

      expect(sessionService.end).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: session.id,
        status: "detached",
      }));
      expect(sessionService.get(session.id)).toEqual(expect.objectContaining({
        status: "detached",
        endedAt: expect.any(String),
      }));
      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({ sessionId: session.id, status: "scheduled" }),
      ]);
    });

    it("scheduled fire into a detached session still delivers by cold resume", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      const scheduledWork = createScheduledWorkDb();
      installClaudeWakeupFixture({
        sdkSessionId: "sdk-detached-cold-resume",
        delaySeconds: 60,
        prompt: "Deliver this wake after restart.",
      });
      const first = createService({ db: scheduledWork.db });
      const session = await first.service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await first.service.runSessionTurn({
        sessionId: session.id,
        text: "Schedule restart work.",
      });
      await first.service.disposeAll();

      const events: AgentChatEventEnvelope[] = [];
      installClaudeResponseFixture({
        sdkSessionId: "sdk-detached-cold-resume",
        responseText: "Cold scheduled work delivered.",
      });
      const restarted = createService({
        db: scheduledWork.db,
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await restarted.service.refreshScheduledWork();

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.sessionId === session.id
          && event.event.type === "user_message"
          && event.event.metadata?.scheduledWake?.reason === "Check PR CI"
        )).toBe(true);
      });

      expect(restarted.sessionService.get(session.id)).toEqual(expect.objectContaining({
        status: "running",
        endedAt: null,
      }));
      expect(events.some((event) =>
        event.sessionId === session.id
        && event.event.type === "done"
        && event.event.status === "completed"
      )).toBe(true);
      expect(scheduledWork.readState()?.schedules[0]?.status).toBe("done");
      restarted.service.forceDisposeAll();
    });
  });

  describe("disposeForLane", () => {
    it("cancels schedules for lane sessions including unmanaged ones", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(SCHEDULE_TEST_START);
      mockState.sessions.set("unmanaged-lane-1", {
        id: "unmanaged-lane-1",
        laneId: "lane-1",
        toolType: "claude-chat",
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: null,
        archivedAt: null,
      });
      mockState.sessions.set("unmanaged-lane-2", {
        id: "unmanaged-lane-2",
        laneId: "lane-2",
        toolType: "claude-chat",
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: null,
        archivedAt: null,
      });
      const scheduledWork = createScheduledWorkDb({
        version: 1,
        schedules: [
          storedWakeup("unmanaged-lane-1"),
          storedWakeup("unmanaged-lane-2"),
          storedWakeup("missing-session"),
        ],
        pausedSessionIds: [],
      });
      const { service } = createService({ db: scheduledWork.db });

      await expect(service.disposeForLane("lane-1")).resolves.toBe(0);

      expect(scheduledWork.readState()?.schedules).toEqual([
        expect.objectContaining({ sessionId: "missing-session", status: "cancelled" }),
        expect.objectContaining({ sessionId: "unmanaged-lane-1", status: "cancelled" }),
        expect.objectContaining({ sessionId: "unmanaged-lane-2", status: "scheduled" }),
      ]);
      service.forceDisposeAll();
    });
  });

  describe("forceDisposeAll", () => {
    it("rejects active runSessionTurn calls during shutdown", async () => {
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => {
        releaseStream = () => resolve();
      });
      vi.mocked(streamText).mockReturnValue({
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Still working" };
          await streamGate;
        })(),
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "Keep running",
        timeoutMs: null,
      });
      const turnExpectation = expect(turn).rejects.toThrow(/shutdown/i);

      try {
        service.forceDisposeAll();
        await turnExpectation;
      } finally {
        releaseStream();
      }
    });

    it("marks an active Codex app-server turn interrupted during shutdown", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start a turn that is still active during shutdown.",
      }, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      service.forceDisposeAll();

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            message: expect.stringMatching(/stopped this Codex turn/i),
            turnId: "turn-1",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "status",
            turnStatus: "interrupted",
            turnId: "turn-1",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "done",
            status: "interrupted",
            turnId: "turn-1",
          }),
        }),
      ]));
    });
  });

  describe("deleteSession", () => {
    it("removes persisted chat artifacts and the stored session row", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const metadataPath = path.join(tmpRoot, ".ade", "cache", "chat-sessions", `${session.id}.json`);
      const dedicatedTranscriptPath = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      const mainTranscriptPath = sessionService.get(session.id)?.transcriptPath ?? "";

      fs.writeFileSync(metadataPath, JSON.stringify({ sessionId: session.id }), "utf8");
      fs.mkdirSync(path.dirname(dedicatedTranscriptPath), { recursive: true });
      fs.writeFileSync(dedicatedTranscriptPath, "{\"event\":\"done\"}\n", "utf8");
      fs.mkdirSync(path.dirname(mainTranscriptPath), { recursive: true });
      fs.writeFileSync(mainTranscriptPath, "{\"event\":\"done\"}\n", "utf8");

      await service.dispose({ sessionId: session.id });
      await service.deleteSession({ sessionId: session.id });

      expect(sessionService.deleteSession).toHaveBeenCalledWith(session.id);
      expect(sessionService.get(session.id)).toBeNull();
      expect(fs.existsSync(metadataPath)).toBe(false);
      expect(fs.existsSync(dedicatedTranscriptPath)).toBe(false);
      expect(fs.existsSync(mainTranscriptPath)).toBe(false);
      await expect(service.getSessionSummary(session.id)).resolves.toBeNull();
    });

    it("disposes running chats before purging them", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.deleteSession({ sessionId: session.id });

      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id }),
      );
      expect(sessionService.deleteSession).toHaveBeenCalledWith(session.id);
    });

    it("purges a running Codex chat even when app-server interrupt and archive requests hang", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start a Codex turn.",
      }, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.delayedCodexMethods.add("turn/interrupt");
      mockState.delayedCodexMethods.add("thread/archive");
      vi.useFakeTimers();
      try {
        const deleted = service.deleteSession({ sessionId: session.id });
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(deleted).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }

      expect(sessionService.end).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id, status: "disposed" }),
      );
      expect(sessionService.deleteSession).toHaveBeenCalledWith(session.id);
      expect(sessionService.get(session.id)).toBeNull();
    });

    it("does not follow transcript symlinks outside ADE during purge", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const mainTranscriptPath = sessionService.get(session.id)?.transcriptPath ?? "";
      const outsideTranscriptPath = path.join(tmpHomeRoot, "outside-transcript.jsonl");
      fs.writeFileSync(outsideTranscriptPath, "{\"event\":\"done\"}\n", "utf8");
      fs.mkdirSync(path.dirname(mainTranscriptPath), { recursive: true });
      fs.rmSync(mainTranscriptPath, { force: true });
      fs.symlinkSync(outsideTranscriptPath, mainTranscriptPath);

      await service.deleteSession({ sessionId: session.id });

      expect(fs.existsSync(outsideTranscriptPath)).toBe(true);
      expect(sessionService.deleteSession).toHaveBeenCalledWith(session.id);
    });
  });

  // --------------------------------------------------------------------------
  // cleanupStaleAttachments
  // --------------------------------------------------------------------------

  describe("cleanupStaleAttachments", () => {
    it("does nothing when attachments directory does not exist", () => {
      const { service } = createService();
      // Should not throw
      expect(() => service.cleanupStaleAttachments()).not.toThrow();
    });

    it("removes files older than 7 days", () => {
      const { service } = createService();
      const attachDir = path.join(tmpRoot, ".ade", "attachments");
      fs.mkdirSync(attachDir, { recursive: true });

      // Create an old file
      const oldFile = path.join(attachDir, "old-attachment.txt");
      fs.writeFileSync(oldFile, "old data");
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

      // Create a recent file
      const recentFile = path.join(attachDir, "recent-attachment.txt");
      fs.writeFileSync(recentFile, "recent data");

      service.cleanupStaleAttachments();

      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(recentFile)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Multiple sessions lifecycle
  // --------------------------------------------------------------------------

  describe("session lifecycle", () => {
    it("creates multiple sessions and lists them independently", async () => {
      const { service } = createService();

      const s1 = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      mockState.uuidCounter = 100;
      const s2 = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(s1.id).not.toBe(s2.id);

      const sessions = await service.listSessions();
      expect(sessions.length).toBe(2);
    });

    it("deduplicates Codex compatibility item notifications", async () => {
      const events: Array<{ type: string; tool?: string; itemId?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            tool: "tool" in event.event ? event.event.tool : undefined,
            itemId: "itemId" in event.event ? event.event.itemId : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Search the repo",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            arguments: { query: "AgentChatPane" },
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "codex/event/item_started",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            arguments: { query: "AgentChatPane" },
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            success: true,
            contentItems: [{ text: "Found matches" }],
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "codex/event/item_completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "item-1",
            type: "dynamicToolCall",
            tool: "search_files",
            success: true,
            contentItems: [{ text: "Found matches" }],
          },
        },
      });

      const toolCalls = events.filter((event) => event.type === "tool_call" && event.itemId === "item-1");
      const toolResults = events.filter((event) => event.type === "tool_result" && event.itemId === "item-1");

      expect(toolCalls).toHaveLength(1);
      expect(toolResults).toHaveLength(1);
    });

    it("rejects attachments outside the project root before dispatch", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const threadsBefore = mockState.codexThreadCounter;
      const turnsBefore = mockState.codexTurnCounter;
      const outsidePath = path.join(process.cwd(), `.ade-agent-chat-outside-${Date.now()}.txt`);
      fs.writeFileSync(outsidePath, "secret", "utf8");
      try {
        await expect(service.sendMessage({
          sessionId: session.id,
          text: "Review this file",
          attachments: [{ path: outsidePath, type: "file" }],
        })).rejects.toThrow(/project root/);
      } finally {
        fs.rmSync(outsidePath, { force: true });
      }
      expect(mockState.codexThreadCounter).toBe(threadsBefore);
      expect(mockState.codexTurnCounter).toBe(turnsBefore);
    });

    it("keeps public attachment paths trimmed without exposing resolved filesystem paths", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      fs.writeFileSync(path.join(tmpRoot, "note.txt"), "hello", "utf8");

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const attachments = [{ path: " note.txt ", type: "file" as const }];
      await service.sendMessage({
        sessionId: session.id,
        text: "Review this file",
        attachments,
      });

      const userMessage = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: { type: "user_message"; attachments?: Array<{ path: string; type: "file" | "image" }> } } =>
          event.event.type === "user_message",
      );

      expect(attachments[0]?.path).toBe(" note.txt ");
      expect(userMessage.event.attachments).toEqual([{ path: "note.txt", type: "file" }]);
    });

    it("injects Linear issue context into Codex prompts and public user events", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const contextAttachment = makeLinearIssueContextAttachment(makeLaneLinearIssue(), "manual");

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan the implementation.",
        contextAttachments: [contextAttachment],
      });

      const userMessage = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: { type: "user_message"; contextAttachments?: unknown[] } } =>
          event.event.type === "user_message",
      );
      expect(userMessage.event.contextAttachments).toHaveLength(1);
      expect(userMessage.event.contextAttachments?.[0]).toMatchObject({
        type: "linear_issue",
        issue: {
          id: "issue-1",
          identifier: "ADE-123",
          title: "Attach Linear context to chat",
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnParams = turnStartRequest?.params as { input?: Array<{ text?: unknown }> } | undefined;
      const textInput = turnParams?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(textInput).toContain("Attached issue context");
      expect(textInput).toContain("- Identifier: ADE-123");
      expect(textInput).toContain("Attach Linear context to chat");
      expect(textInput).toContain("do not ask the user for a Linear API key");
      expect(textInput).toContain("Plan the implementation.");
    });

    it("dispatches context-only Linear issue sends with a fallback prompt", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "",
        contextAttachments: [makeLinearIssueContextAttachment(makeLaneLinearIssue(), "manual")],
      });

      const userMessage = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: { type: "user_message"; text: string; contextAttachments?: unknown[] } } =>
          event.event.type === "user_message",
      );
      expect(userMessage.event.text).toBe("Use the attached issue context.");
      expect(userMessage.event.contextAttachments).toHaveLength(1);

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnParams = turnStartRequest?.params as { input?: Array<{ text?: unknown }> } | undefined;
      const textInput = turnParams?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(textInput).toContain("Attached issue context");
      expect(textInput).toContain("Use the attached issue context.");
    });

    it("prefers the canonical turn-scoped Codex text stream when item-scoped deltas also arrive", async () => {
      const textEvents: Array<{ text: string; itemId?: string; turnId?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          if (event.event.type !== "text") return;
          textEvents.push({
            text: event.event.text,
            itemId: event.event.itemId,
            turnId: event.event.turnId,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Say hello",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "Hello",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Hello",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          itemId: "msg-1",
          delta: " world",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: " world",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Hello world",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      expect(textEvents).toEqual([
        {
          text: "Hello world",
          turnId: "turn-1",
        },
      ]);
    });

    it("keeps Codex reasoning deltas tied to the active turn and thinking activity", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Think through the options.",
      }, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const eventsBeforeReasoningDelta = events.length;
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/reasoning/summaryTextDelta",
        params: {
          itemId: "reasoning-1",
          delta: "Checking the relevant paths.",
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "reasoning"
          && event.event.turnId === "turn-1"
          && event.event.itemId === "reasoning-1",
      );

      const newEvents = events.slice(eventsBeforeReasoningDelta);
      // The reasoning row must be produced by the post-delta boundary, not by
      // any earlier turn-start bookkeeping.
      expect(newEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "reasoning",
            text: "Checking the relevant paths.",
            itemId: "reasoning-1",
            turnId: "turn-1",
          }),
        }),
      ]));
      // And somewhere in the turn — coalescing across the initial turn-start
      // activity is fine — a thinking activity must be tied to the same turn.
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "activity",
            activity: "thinking",
            turnId: "turn-1",
          }),
        }),
      ]));
    });

    it("emits immediate startup activity for Codex before turn/start resolves", async () => {
      const events: AgentChatEventEnvelope[] = [];
      mockState.delayedCodexMethods.add("turn/start");
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Resolve the PR comments.",
      }, { awaitDispatch: true });
      let sendResolved = false;
      void sendPromise.then(() => {
        sendResolved = true;
      });

      const startedEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && !("turnId" in event.event),
      );
      const startupActivity = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "activity" }>;
        } =>
          event.event.type === "activity"
          && !("turnId" in event.event)
          && (event.event.activity === "thinking" || event.event.activity === "working"),
      );

      expect(startedEvent.event.turnStatus).toBe("started");
      expect(startupActivity.event.detail).toBeTruthy();
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      await Promise.resolve();
      expect(sendResolved).toBe(false);
      const noTurnStartedCount = events.filter((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "started"
        && !("turnId" in event.event)
      ).length;
      expect(noTurnStartedCount).toBe(1);

      mockState.flushCodexResponses();
      await sendPromise;
      expect(sendResolved).toBe(true);
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && "turnId" in event.event
          && event.event.turnId === "turn-1",
      );
    });

    it("emits only one user_message for a Codex send while turn/start is delayed", async () => {
      const events: AgentChatEventEnvelope[] = [];
      mockState.delayedCodexMethods.add("turn/start");
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Fix the duplicate first message render.",
      }, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "user_message"
          && event.event.text === "Fix the duplicate first message render.",
      );
      expect(events.filter((event) => event.event.type === "user_message")).toHaveLength(1);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "turn-1",
            status: "in_progress",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Checking the renderer path.",
        },
      });

      mockState.flushCodexResponses();
      await sendPromise;

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text"
          && event.event.text === "Checking the renderer path.",
      );
      expect(events.filter((event) => event.event.type === "user_message")).toHaveLength(1);
    });

    it("ignores unsolicited Codex turn notifications when no turn is active", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.resumeSession({ sessionId: session.id });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "foreign-turn",
            status: "inProgress",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "foreign-turn",
          delta: "This belongs to a different thread",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "foreign-turn",
            status: "completed",
          },
        },
      });

      expect(events.filter((event) => event.turnId === "foreign-turn")).toHaveLength(0);
    });

    it("attaches to in-progress Codex turn notifications after app-server resume", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string; status?: string; turnStatus?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
            status: "status" in event.event ? event.event.status : undefined,
            turnStatus: "turnStatus" in event.event ? event.event.turnStatus : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        threadId: "thread-resumed",
      });

      await service.resumeSession({ sessionId: session.id });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "resumed-turn",
            status: "inProgress",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "resumed-turn",
          delta: "Continuing after reconnect",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "resumed-turn",
            status: "completed",
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "status", turnId: "resumed-turn", turnStatus: "started" }),
        expect.objectContaining({ type: "text", turnId: "resumed-turn", text: "Continuing after reconnect" }),
        expect.objectContaining({ type: "done", turnId: "resumed-turn", status: "completed" }),
      ]));
    });

    it("ignores late duplicate Codex turn/started notifications for a completed turn", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string; status?: string; turnStatus?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
            status: "status" in event.event ? event.event.status : undefined,
            turnStatus: "turnStatus" in event.event ? event.event.turnStatus : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start coordination.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(1);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "Planner started." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await expect(firstTurn).resolves.toEqual(expect.objectContaining({
        outputText: "Planner started.",
        turnId: "turn-1",
      }));

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });

      const secondTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Continue coordination.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-2", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-2", delta: "Development started." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-2", status: "completed" } },
      });

      await expect(secondTurn).resolves.toEqual(expect.objectContaining({
        outputText: "Development started.",
        turnId: "turn-2",
      }));
      expect(events.filter((event) => event.type === "status" && event.turnId === "turn-1" && event.turnStatus === "started")).toHaveLength(1);
    });

    it("closes the Codex resumed-turn attach gate after an expected turn completes", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string; status?: string; turnStatus?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
            status: "status" in event.event ? event.event.status : undefined,
            turnStatus: "turnStatus" in event.event ? event.event.turnStatus : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        threadId: "thread-resumed",
      });
      await service.resumeSession({ sessionId: session.id });

      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "Continue after resume.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "Expected turn completed." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await expect(turn).resolves.toEqual(expect.objectContaining({
        outputText: "Expected turn completed.",
        turnId: "turn-1",
      }));

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "ghost-resumed-turn", status: "inProgress" } },
      });

      expect(events.filter((event) => event.type === "status" && event.turnId === "ghost-resumed-turn")).toHaveLength(0);
    });

    it("persists terminal Codex turn ids across runtime recreation", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string; status?: string; turnStatus?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
            status: "status" in event.event ? event.event.status : undefined,
            turnStatus: "turnStatus" in event.event ? event.event.turnStatus : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start coordination.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "Persisted turn completed." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await expect(firstTurn).resolves.toEqual(expect.objectContaining({
        outputText: "Persisted turn completed.",
        turnId: "turn-1",
      }));

      service.forceDisposeAll();
      writePersistedChatState(session.id, {
        ...readPersistedChatState(session.id),
        threadId: "thread-resumed",
      });
      await service.resumeSession({ sessionId: session.id });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });

      expect(events.filter((event) => event.type === "status" && event.turnId === "turn-1" && event.turnStatus === "started")).toHaveLength(1);
    });

    it("does not reactivate a Codex turn when turn/start resolves after turn/completed", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string; status?: string; turnStatus?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
            status: "status" in event.event ? event.event.status : undefined,
            turnStatus: "turnStatus" in event.event ? event.event.turnStatus : undefined,
          });
        },
      });
      mockState.delayedCodexMethods.add("turn/start");

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Start coordination.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(1);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-1", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "Coordinator answered." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });
      await expect(firstTurn).resolves.toEqual(expect.objectContaining({
        outputText: "Coordinator answered.",
        turnId: "turn-1",
      }));

      mockState.flushCodexResponses();
      await vi.waitFor(() => {
        expect(events.filter((event) => event.type === "status" && event.turnId === "turn-1" && event.turnStatus === "started")).toHaveLength(1);
      });

      const secondTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Continue coordination.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
      });
      mockState.flushCodexResponses();
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { turn: { id: "turn-2", status: "inProgress" } },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { turnId: "turn-2", delta: "Next turn started." },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-2", status: "completed" } },
      });

      await expect(secondTurn).resolves.toEqual(expect.objectContaining({
        outputText: "Next turn started.",
        turnId: "turn-2",
      }));
    });

    it("ignores stale Codex lifecycle notifications from a foreign turn", async () => {
      const events: Array<{ type: string; turnId?: string; text?: string }> = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push({
            type: event.event.type,
            turnId: "turnId" in event.event ? event.event.turnId ?? undefined : undefined,
            text: "text" in event.event ? event.event.text : undefined,
          });
        },
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });
      await vi.waitFor(() => {
        expect(events.some((event) => event.type === "status" && event.turnId === "turn-1")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-stale",
            status: "completed",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/aborted",
        params: {
          turnId: "turn-stale",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Still streaming",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      expect(events.filter((event) => event.type === "done").map((event) => event.turnId)).toEqual(["turn-1"]);
      expect(events.filter((event) => event.type === "status" && event.turnId === "turn-stale")).toHaveLength(0);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", turnId: "turn-1", text: "Still streaming" }),
      ]));
    });

    it("suppresses stale Codex turn notifications while waiting for turn/started", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });

      mockState.delayedCodexMethods.add("turn/start");
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-stale",
          delta: "This belongs to the previous turn",
        },
      });

      mockState.flushCodexResponses();
      await sendPromise;
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status" && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-1",
          delta: "Fresh text",
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text" && event.event.turnId === "turn-1" && event.event.text === "Fresh text",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      expect(
        events.filter((event) => "turnId" in event.event && event.event.turnId === "turn-stale"),
      ).toHaveLength(0);
    });

    it("returns an explicit steer result and emits a delivered steer bubble for Codex", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const result = await service.steer({
        sessionId: session.id,
        text: "Focus on the shared chat UI.",
      });

      expect(result.queued).toBe(false);
      expect(result.steerId).toMatch(/^test-uuid-/);
      expect(
        mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer"),
      ).toBe(true);

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message",
            text: "Focus on the shared chat UI.",
            deliveryState: "delivered",
            steerId: result.steerId,
            turnId: "turn-1",
          }),
        }),
      ]));
    });

    it("adopts Codex active turn mismatches and retries delivered steers", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.codexRequestPayloads = [];
      let attempts = 0;
      mockState.codexResponseOverrides.set("turn/steer", (payload) => {
        attempts += 1;
        const params = payload.params as Record<string, unknown>;
        if (params.expectedTurnId === "turn-1") {
          return {
            error: {
              code: -32000,
              message: "expected active turn id turn-1 but found turn-real",
            },
          };
        }
        return {};
      });

      const result = await service.steer({
        sessionId: session.id,
        text: "Keep going with the real turn.",
      });

      expect(result.queued).toBe(false);
      expect(attempts).toBe(2);
      const steerRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/steer");
      expect(steerRequests.map((payload) => (payload.params as Record<string, unknown>).expectedTurnId)).toEqual([
        "turn-1",
        "turn-real",
      ]);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message",
            text: "Keep going with the real turn.",
            deliveryState: "delivered",
            steerId: result.steerId,
            turnId: "turn-real",
          }),
        }),
      ]));
    });

    it("adopts a Codex turn/started notification that corrects the active turn id", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "turn-real",
            status: "inProgress",
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          turnId: "turn-real",
          delta: "Recovered text",
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text"
          && event.event.turnId === "turn-real"
          && event.event.text === "Recovered text",
      );
    });

    it("does not retry Codex active turn mismatches more than once", async () => {
      const { service } = createService();

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });

      mockState.codexRequestPayloads = [];
      let attempts = 0;
      mockState.codexResponseOverrides.set("turn/steer", (payload) => {
        attempts += 1;
        const params = payload.params as Record<string, unknown>;
        if (params.expectedTurnId === "turn-1") {
          return {
            error: {
              code: -32000,
              message: "expected active turn id turn-1 but found turn-real",
            },
          };
        }
        if (params.expectedTurnId === "turn-real") {
          return {
            error: {
              code: -32000,
              message: "expected active turn id turn-real but found turn-newer",
            },
          };
        }
        return {};
      });

      await expect(service.steer({
        sessionId: session.id,
        text: "Keep going with the real turn.",
      })).rejects.toThrow("expected active turn id turn-real but found turn-newer");

      expect(attempts).toBe(2);
      const steerRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/steer");
      expect(steerRequests.map((payload) => (payload.params as Record<string, unknown>).expectedTurnId)).toEqual([
        "turn-1",
        "turn-real",
      ]);
    });

    it("starts a normal Codex turn when steering stale active UI state", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const result = await service.steer({
        sessionId: session.id,
        text: "Recover from a stale active marker.",
      });

      expect(result.queued).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message",
            text: "Recover from a stale active marker.",
          }),
        }),
      ]));
    });

    it("sends Codex image steer payloads as localImage input blocks", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const imagePath = path.join(tmpRoot, "codex-steer-image.png");
      fs.writeFileSync(imagePath, "fake-image-bytes");

      const result = await service.steer({
        sessionId: session.id,
        text: "Use this screenshot while you keep going.",
        attachments: [{ path: imagePath, type: "image" }],
      });

      expect(result.queued).toBe(false);
      const steerRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/steer");
      expect(steerRequest).toBeTruthy();
      expect(steerRequest).toEqual(expect.objectContaining({
        method: "turn/steer",
        params: expect.objectContaining({
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: "Use this screenshot while you keep going.",
            }),
            expect.objectContaining({
              type: "localImage",
              path: expect.stringContaining("codex-steer-image.png"),
            }),
          ]),
        }),
      }));

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "user_message",
            text: "Use this screenshot while you keep going.",
            attachments: [{ path: imagePath, type: "image" }],
            deliveryState: "delivered",
            steerId: result.steerId,
            turnId: "turn-1",
          }),
        }),
      ]));
    });

    it("adopts Codex active turn mismatches and retries interrupt", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.codexRequestPayloads = [];
      let attempts = 0;
      mockState.codexResponseOverrides.set("turn/interrupt", (payload) => {
        attempts += 1;
        const params = payload.params as Record<string, unknown>;
        if (params.turnId === "turn-1") {
          return {
            error: {
              code: -32000,
              message: "expected active turn id turn-1 but found turn-real",
            },
          };
        }
        return {};
      });

      await service.interrupt({ sessionId: session.id });

      expect(attempts).toBe(2);
      const interruptRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt");
      expect(interruptRequests.map((payload) => (payload.params as Record<string, unknown>).turnId)).toEqual([
        "turn-1",
        "turn-real",
      ]);
    });

    it("adopts Codex active turn mismatches and retries dispose interrupt", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.codexRequestPayloads = [];
      let attempts = 0;
      mockState.codexResponseOverrides.set("turn/interrupt", (payload) => {
        attempts += 1;
        const params = payload.params as Record<string, unknown>;
        if (params.turnId === "turn-1") {
          return {
            error: {
              code: -32000,
              message: "expected active turn id turn-1 but found turn-real",
            },
          };
        }
        return {};
      });

      await service.dispose({ sessionId: session.id });

      expect(attempts).toBe(2);
      const interruptRequests = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt");
      expect(interruptRequests.map((payload) => (payload.params as Record<string, unknown>).turnId)).toEqual([
        "turn-1",
        "turn-real",
      ]);
    });

    it("marks active Codex subagents stopped on interrupt and ignores late child updates", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run a parallel code search.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabToolCall",
            tool: "spawn_agent",
            newThreadId: "agent-thread-1",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });

      await service.interrupt({ sessionId: session.id });

      expect(
        mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt"),
      ).toBe(true);

      const stoppedResults = events.filter((event) =>
        event.event.type === "subagent_result"
        && event.event.taskId === "agent-thread-1"
        && event.event.status === "stopped",
      );
      expect(stoppedResults).toHaveLength(1);
      expect(
        service.listSubagents({ sessionId: session.id }).find((snapshot) => snapshot.taskId === "agent-thread-1")?.status,
      ).toBe("stopped");

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabToolCall",
            tool: "wait",
            agentsStates: [
              {
                threadId: "agent-thread-1",
                status: "completed",
                summary: "Finished after the interrupt.",
              },
            ],
          },
        },
      });

      const completedResults = events.filter((event) =>
        event.event.type === "subagent_result"
        && event.event.taskId === "agent-thread-1"
        && event.event.status === "completed",
      );
      expect(completedResults).toHaveLength(0);
    });

    it("emits Codex subagent events for current collabAgentToolCall app-server items", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run parallel repository scans.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-1",
            receiverThreadIds: ["agent-thread-1"],
            prompt: "Inspect the shared chat renderer",
            agentsStates: {},
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent_started",
            taskId: "agent-thread-1",
            description: "Inspect the shared chat renderer",
            turnId: "turn-1",
          }),
        }),
      ]));
      expect(
        service.listSubagents({ sessionId: session.id }).find((snapshot) => snapshot.taskId === "agent-thread-1")?.status,
      ).toBe("running");

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-2",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: "thread-1",
            receiverThreadIds: ["agent-thread-1"],
            prompt: null,
            agentsStates: {
              "agent-thread-1": {
                status: "completed",
                message: "Renderer path mapped.",
              },
            },
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent_result",
            taskId: "agent-thread-1",
            status: "completed",
            summary: "Renderer path mapped.",
            turnId: "turn-1",
          }),
        }),
      ]));
      expect(
        service.listSubagents({ sessionId: session.id }).find((snapshot) => snapshot.taskId === "agent-thread-1")?.status,
      ).toBe("completed");
    });

    it("assigns Codex desktop-style fallback labels to collab agents in turn-spawn order", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Spawn two parallel agents.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-a"],
            prompt: "Inspect the renderer",
            agentsStates: {},
          },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-2",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-b"],
            prompt: "Inspect the main process",
            agentsStates: {},
          },
        },
      });

      const startedEvents = events.filter((envelope) =>
        envelope.event.type === "subagent_started"
        && (envelope.event.taskId === "agent-thread-a" || envelope.event.taskId === "agent-thread-b"),
      );

      expect(startedEvents).toHaveLength(2);
      expect(startedEvents[0]!.event).toMatchObject({
        type: "subagent_started",
        taskId: "agent-thread-a",
        agentId: "agent-thread-a",
        agentType: "Sagan",
      });
      expect(startedEvents[1]!.event).toMatchObject({
        type: "subagent_started",
        taskId: "agent-thread-b",
        agentId: "agent-thread-b",
        agentType: "Beauvoir",
      });
    });

    it("filters codex parent stream by threadId when fetching subagent transcript", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run a parallel agent.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-filter"],
            prompt: "Focused investigation",
            agentsStates: {},
          },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-2",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-filter"],
            agentsStates: {
              "agent-thread-filter": {
                status: "completed",
                message: "Investigation complete.",
              },
            },
          },
        },
      });

      const transcript = await service.getSubagentTranscript({
        sessionId: session.id,
        agentId: "agent-thread-filter",
      });
      expect(transcript).not.toBeNull();
      expect(transcript!.length).toBeGreaterThanOrEqual(2);
      const types = transcript!.map((m) => (m.message as { type: string }).type);
      expect(types).toContain("subagent_started");
      expect(types).toContain("subagent_result");
      // Filter must reject envelopes that don't carry this threadId.
      expect(transcript!.every((m) => {
        const event = m.message as { taskId?: string };
        return event.taskId === "agent-thread-filter";
      })).toBe(true);

      // A different threadId returns an empty (but non-null) array.
      const empty = await service.getSubagentTranscript({
        sessionId: session.id,
        agentId: "some-other-thread",
      });
      expect(empty).toEqual([]);
    });

    it("pulls codex subagent transcript live from the app-server via thread/turns/list", async () => {
      // When the codex runtime is alive, getSubagentTranscript should ask
      // codex's app-server for the subagent thread's own turns/items —
      // matching what the Codex desktop app does — instead of falling back
      // to filtering ADE's parent event history.
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      // Track every request to the codex app-server so we can prove we
      // actually called `thread/turns/list` instead of staying in the
      // event-history fallback.
      const appServerCalls: Array<{ method: string; params: unknown }> = [];
      mockState.codexResponseOverrides.set("thread/turns/list", (payload) => {
        appServerCalls.push({ method: "thread/turns/list", params: payload.params });
        return {
          data: [
            {
              id: "turn-sub-1",
              startedAt: 1,
              completedAt: 2,
              durationMs: 1000,
              status: "completed",
              error: null,
              itemsView: "full",
              items: [
                {
                  id: "item-reasoning",
                  type: "reasoning",
                  summary: ["Mapping the dependency graph."],
                  content: ["Need to confirm the call sites use the new helper."],
                },
                {
                  id: "item-command",
                  type: "commandExecution",
                  command: "rg --files-with-matches \"oldFn\"",
                  cwd: "/Users/admin/Projects/ADE",
                  aggregatedOutput: "src/foo.ts\nsrc/bar.ts\n",
                  exitCode: 0,
                  durationMs: 35,
                  status: "completed",
                  commandActions: [],
                  source: "shell",
                  processId: null,
                },
                {
                  id: "item-file",
                  type: "fileChange",
                  status: "completed",
                  changes: [
                    { path: "src/foo.ts", unifiedDiff: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-foo\n+bar\n", kind: "modify" },
                  ],
                },
                {
                  id: "item-text",
                  type: "agentMessage",
                  text: "Investigation complete. Two call sites updated.",
                  phase: null,
                  memoryCitation: null,
                },
              ],
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        };
      });

      // Announce the subagent thread on the parent stream so ADE registers
      // an active subagent the client can drill into. ADE only needs the
      // threadId — the actual transcript will be pulled from the app-server.
      await service.sendMessage({
        sessionId: session.id,
        text: "Spawn an investigation agent.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-live"],
            prompt: "Investigate dependencies.",
            agentsStates: {},
          },
        },
      });

      const transcript = await service.getSubagentTranscript({
        sessionId: session.id,
        agentId: "agent-thread-live",
      });

      expect(appServerCalls.length).toBeGreaterThanOrEqual(1);
      expect(appServerCalls[0].method).toBe("thread/turns/list");
      expect((appServerCalls[0].params as { threadId: string }).threadId).toBe("agent-thread-live");
      expect((appServerCalls[0].params as { itemsView: string }).itemsView).toBe("full");

      expect(transcript).not.toBeNull();
      const types = transcript!.map((m) => (m.message as { type: string }).type);
      expect(types).toEqual(["reasoning", "command", "file_change", "text"]);
      const commandEvent = transcript!.find((m) => (m.message as { type: string }).type === "command")!.message as {
        type: "command";
        command: string;
        output: string;
        status: string;
        exitCode: number;
      };
      expect(commandEvent.command).toContain("oldFn");
      expect(commandEvent.output).toContain("src/foo.ts");
      expect(commandEvent.status).toBe("completed");
      expect(commandEvent.exitCode).toBe(0);
      const fileEvent = transcript!.find((m) => (m.message as { type: string }).type === "file_change")!.message as {
        type: "file_change";
        path: string;
        diff: string;
        kind: string;
      };
      expect(fileEvent.path).toBe("src/foo.ts");
      expect(fileEvent.diff).toContain("+bar");
      expect(fileEvent.kind).toBe("modify");
    });

    it("captures Codex subagent transcript rows from live child-thread notifications", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      mockState.codexResponseOverrides.set("thread/turns/list", () => ({
        data: [],
        nextCursor: null,
        backwardsCursor: null,
      }));
      mockState.codexResponseOverrides.set("thread/read", () => ({
        thread: {
          id: "agent-thread-live-capture",
          preview: "Live child output.",
          model: "gpt-5.4",
          source: {
            subAgent: {
              parentThreadId: "thread-1",
              agentNickname: "Scout",
              agentRole: "reviewer",
            },
          },
        },
      }));

      await service.sendMessage({
        sessionId: session.id,
        text: "Spawn a child agent.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-live-capture",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-live-capture"],
            prompt: "Inspect streamed child output.",
            agentsStates: {},
          },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          threadId: "agent-thread-live-capture",
          turn: { id: "sub-turn-1", status: "inProgress" },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          threadId: "agent-thread-live-capture",
          turnId: "sub-turn-1",
          itemId: "sub-message-1",
          delta: "Live child output.",
        },
      });

      let transcript: Awaited<ReturnType<typeof service.getSubagentTranscript>> = null;
      await vi.waitFor(async () => {
        transcript = await service.getSubagentTranscript({
          sessionId: session.id,
          agentId: "agent-thread-live-capture",
        });
        expect(transcript).not.toBeNull();
        expect(transcript!.some((message) => message.text === "Live child output.")).toBe(true);
        expect(transcript!.find((message) => message.text === "Live child output.")?.subagentMetadata).toMatchObject({
          threadId: "agent-thread-live-capture",
          agentNickname: "Scout",
          agentRole: "reviewer",
          model: "gpt-5.4",
        });
      });

      expect(events.some((event) =>
        event.event.type === "text"
        && event.event.text === "Live child output."
      )).toBe(false);
      const parentHistory = service.getChatEventHistory(session.id);
      expect(parentHistory.events.some((event) =>
        event.event.type === "text"
        && event.event.text === "Live child output."
      )).toBe(false);
      expect(transcript!.map((message) => (message.message as { type: string }).type)).toContain("text");
    });

    it("falls back to event-history filter when codex app-server fails on thread/turns/list", async () => {
      // Older codex builds may not support `thread/turns/list` for spawned
      // subagent threads. The transcript pipe must still return data — fall
      // back to ADE's aggregated `subagent_*` envelopes from the parent
      // stream.
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      mockState.codexResponseOverrides.set("thread/turns/list", () => ({
        error: { code: -32601, message: "Method not found" },
      }));

      await service.sendMessage({
        sessionId: session.id,
        text: "Spawn an investigation agent.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-fallback"],
            prompt: "Investigate.",
            agentsStates: {},
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "collab-2",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            senderThreadId: "thread-main",
            receiverThreadIds: ["agent-thread-fallback"],
            agentsStates: {
              "agent-thread-fallback": {
                status: "completed",
                message: "Investigation summary recorded.",
              },
            },
          },
        },
      });

      const transcript = await service.getSubagentTranscript({
        sessionId: session.id,
        agentId: "agent-thread-fallback",
      });
      expect(transcript).not.toBeNull();
      expect(transcript!.length).toBeGreaterThanOrEqual(2);
      const types = transcript!.map((m) => (m.message as { type: string }).type);
      expect(types).toContain("subagent_started");
      expect(types).toContain("subagent_result");
    });

    it("coalesces Codex spawn placeholders when the app-server reveals the agent thread later", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });
      expect(service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "call-spawn-1",
          parentToolUseId: "call-spawn-1",
          status: "running",
        }),
      ]);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            status: "completed",
            newThreadId: "agent-thread-1",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });

      expect(service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "agent-thread-1",
          parentToolUseId: "call-spawn-1",
          status: "running",
        }),
      ]);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-wait-1",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            agentsStates: {
              "agent-thread-1": {
                status: "completed",
                message: "Renderer path mapped.",
              },
            },
          },
        },
      });

      expect(service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "agent-thread-1",
          parentToolUseId: "call-spawn-1",
          status: "completed",
          summary: "Renderer path mapped.",
        }),
      ]);
    });

    it("marks optimistic Codex spawn placeholders failed when the app-server rejects the tool call", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });

      expect(service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "call-spawn-1",
          parentToolUseId: "call-spawn-1",
          status: "running",
        }),
      ]);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            status: "rejected",
            error: { message: "spawn_agent is not available in this runtime" },
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent_result",
            taskId: "call-spawn-1",
            parentToolUseId: "call-spawn-1",
            status: "failed",
            summary: "spawn_agent is not available in this runtime",
            turnId: "turn-1",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "error",
            message: "Codex parallel agent failed: spawn_agent is not available in this runtime",
            turnId: "turn-1",
          }),
        }),
      ]));
      expect(service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "call-spawn-1",
          status: "failed",
          summary: "spawn_agent is not available in this runtime",
        }),
      ]);
      expect(service.listSubagents({ sessionId: session.id }).some((snapshot) => snapshot.status === "running")).toBe(false);
    });

    it("uses content text instead of object stringification for Codex spawn failures", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            status: "rejected",
            result: { reason: "runtime_missing" },
            contentItems: [{ text: "spawn_agent is not available in this runtime" }],
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent_result",
            taskId: "call-spawn-1",
            status: "failed",
            summary: "spawn_agent is not available in this runtime",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "error",
            message: "Codex parallel agent failed: spawn_agent is not available in this runtime",
          }),
        }),
      ]));
      expect(events.some((event) =>
        event.event.type === "subagent_result"
        && event.event.summary === "[object Object]"
      )).toBe(false);
    });

    it("reports stopped Codex subagents without error severity", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            prompt: "Inspect the shared chat renderer",
          },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            status: "cancelled",
            result: "User cancelled",
          },
        },
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "subagent_result",
            taskId: "call-spawn-1",
            status: "stopped",
            summary: "User cancelled",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "system_notice",
            noticeKind: "info",
            severity: "info",
            message: "Codex parallel agent stopped: User cancelled",
          }),
        }),
      ]));
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.noticeKind === "error"
        && event.event.message === "Codex parallel agent stopped: User cancelled"
      )).toBe(false);
    });

    it("stops foreground Codex subagents when the parent turn completes without a terminal subagent event", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run a parallel repository scan.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "call-spawn-1",
            type: "collabAgentToolCall",
            tool: "spawn_agent",
            receiverThreadIds: ["agent-thread-1"],
            prompt: "Inspect the shared chat renderer",
          },
        },
      });

      expect(service.hasActiveWorkloads()).toBe(true);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "done"
          && event.event.status === "completed"
          && event.event.turnId === "turn-1",
      );

      expect(service.listSubagents({ sessionId: session.id })).toEqual([
        expect.objectContaining({
          taskId: "agent-thread-1",
          parentToolUseId: "call-spawn-1",
          status: "stopped",
          summary: "Parent turn completed before ADE received a final subagent status",
        }),
      ]);
      expect(service.hasActiveWorkloads()).toBe(false);
    });

    it("does not add Codex cache breakdown tokens to derived totals", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Track token usage.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          tokenUsage: {
            total: {
              inputTokens: 1_000,
              outputTokens: 250,
              cacheReadTokens: 700,
              cacheWriteTokens: 50,
            },
          },
        },
      });

      const usageEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "codex_token_usage" }>;
        } => event.event.type === "codex_token_usage",
      );
      expect(usageEvent.event.usage.total).toEqual(expect.objectContaining({
        inputTokens: 1_000,
        outputTokens: 250,
        cacheReadTokens: 700,
        cacheWriteTokens: 50,
        totalTokens: 1_250,
      }));
    });

    it("switches the Claude SDK session into plan mode before a plan turn", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan ready" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        interactionMode: "plan",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Outline the implementation only.",
        interactionMode: "plan",
      });

      expect(result.outputText).toContain("Plan ready");
      expect(setPermissionMode).toHaveBeenCalledWith("plan");
      expect(setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[1]);
    });

    it("does not reapply unchanged Claude permission controls during session updates", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-stable-permission",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Ready" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-stable-permission",
        setPermissionMode,
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "bypassPermissions",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Confirm readiness.",
      });
      expect(setPermissionMode).toHaveBeenCalledWith("bypassPermissions");

      setPermissionMode.mockClear();
      const updated = await service.updateSession({
        sessionId: session.id,
        claudePermissionMode: "bypassPermissions",
      });

      expect(updated.claudePermissionMode).toBe("bypassPermissions");
      expect(setPermissionMode).not.toHaveBeenCalled();
    });

    it("uses Claude SDK query controls for plan mode when the wrapper lacks setPermissionMode", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-query-plan",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan via query control" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-query-plan",
        query: {
          setPermissionMode,
        },
      } as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        interactionMode: "plan",
      });

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Outline the implementation only.",
        interactionMode: "plan",
      });

      expect(result.outputText).toContain("Plan via query control");
      expect(setPermissionMode).toHaveBeenCalledWith("plan");
      expect(setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[1]);
    });

    it("preserves Claude access overrides when entering and exiting plan mode", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let service: ReturnType<typeof createService>["service"];
      let sessionId = "";

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-plan-preserve",
            slash_commands: [],
          };
          return;
        }

        const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
        const enterResult = await sessionOpts.canUseTool("EnterPlanMode", {}, {
          signal: new AbortController().signal,
          toolUseID: "tool-enter-plan",
        });
        expect(enterResult).toMatchObject({ behavior: "allow" });

        const entered = await service.getSessionSummary(sessionId);
        expect(entered?.permissionMode).toBe("plan");
        expect(entered?.claudePermissionMode).toBe("acceptEdits");

        const exitPromise = sessionOpts.canUseTool("ExitPlanMode", {
          planDescription: "Ship the approved Claude changes.",
        }, {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-plan",
        });

        const approvalEvent = await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope & {
            event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
          } =>
            event.event.type === "approval_request"
            && typeof ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind) === "string"
            && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
        );

        await service.approveToolUse({
          sessionId,
          itemId: approvalEvent.event.itemId,
          decision: "accept",
        });

        const exitResult = await exitPromise;
        expect(exitResult).toMatchObject({
          behavior: "allow",
        });

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan approved and preserved." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-plan-preserve",
        setPermissionMode,
      } as any);

      ({ service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      }));

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-5",
        permissionMode: "edit",
        claudePermissionMode: "acceptEdits",
      });
      sessionId = session.id;

      const result = await service.runSessionTurn({
        sessionId: session.id,
        text: "Enter plan mode, then exit it after approval.",
      });

      expect(result.outputText).toContain("Plan approved and preserved.");
      expect(setPermissionMode).toHaveBeenCalledWith("acceptEdits");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).toBe("edit");
      expect(summary?.claudePermissionMode).toBe("acceptEdits");
    });

    it("syncs session permissionMode and emits a plan-mode notice when the SDK status message reports a transition", async () => {
      // The Claude Agent SDK handles EnterPlanMode/ExitPlanMode internally in
      // the bundled `claude` binary and signals the host via an SDKStatusMessage
      // (type: "system", subtype: "status") carrying the new permissionMode.
      // ADE must update its session state and emit the standard plan-mode
      // notice from this branch — without it, the renderer's prompt-box
      // permission badge never reflects the SDK-side transition.
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
            session_id: "sdk-session-status-plan",
            slash_commands: [],
          };
          return;
        }

        // SDK reports the internal EnterPlanMode transition via a status
        // message instead of routing through canUseTool.
        yield {
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "plan",
        };

        // SDK later reports ExitPlanMode the same way.
        yield {
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "default",
        };

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan flow completed via status." }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-status-plan",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Drive plan mode via status messages.",
      });

      const planTransitionNotices = events
        .map((envelope) => envelope.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
          event.type === "system_notice"
          && (event.detail as { permissionModeTransition?: string } | undefined)?.permissionModeTransition !== undefined,
        );
      expect(planTransitionNotices.map((notice) =>
        (notice.detail as { permissionModeTransition: string }).permissionModeTransition,
      )).toEqual(["entered_plan_mode", "exited_plan_mode"]);

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).not.toBe("plan");
    });

    it("ignores SDK status messages whose permissionMode matches the session's current mode", async () => {
      // Status messages can arrive frequently. Only the transitions should
      // emit notices — a redundant `permissionMode: "default"` while the
      // session is already in a non-plan mode must be a no-op.
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
            session_id: "sdk-session-status-noop",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "default",
        };

        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-status-noop",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Status message must not spuriously toggle plan mode.",
      });

      const planTransitionNotices = events
        .map((envelope) => envelope.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
          event.type === "system_notice"
          && (event.detail as { permissionModeTransition?: string } | undefined)?.permissionModeTransition !== undefined,
        );
      expect(planTransitionNotices).toHaveLength(0);
    });

    it("emits todo_update events for Claude TodoWrite tool uses", async () => {
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
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "todo-call-1",
              name: "TodoWrite",
              input: {
                todos: [
                  {
                    content: "Inspect Claude task rendering",
                    activeForm: "Inspecting Claude task rendering",
                    status: "completed",
                  },
                  {
                    content: "Render ADE task list UI",
                    activeForm: "Rendering ADE task list UI",
                    status: "in_progress",
                  },
                ],
              },
            }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Track the current task list.",
      });

      const todoEvent = events.find((event) => event.event.type === "todo_update");
      expect(todoEvent).toBeTruthy();
      expect(todoEvent?.event).toMatchObject({
        type: "todo_update",
        items: [
          {
            id: "todo-0",
            description: "Inspect Claude task rendering",
            status: "completed",
          },
          {
            id: "todo-1",
            description: "Render ADE task list UI",
            status: "in_progress",
          },
        ],
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "tool_call",
            tool: "TodoWrite",
            itemId: "todo-call-1",
          }),
        }),
      ]));
    });

    it("emits todo_update events for Claude TaskCreate and TaskUpdate tool uses", async () => {
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
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "task-create-1",
                name: "TaskCreate",
                input: {
                  subject: "Inspect SDK changes",
                  description: "Inspect the latest Claude Agent SDK changes",
                  activeForm: "Inspecting SDK changes",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          parent_tool_use_id: "task-create-1",
          description: "Inspect SDK changes",
          task_type: "other",
        };
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "task-update-1",
                name: "TaskUpdate",
                input: {
                  taskId: "task-1",
                  status: "in_progress",
                  activeForm: "Applying SDK changes",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Track the SDK task list.",
      });

      const todoEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "todo_update" }> =>
          event.type === "todo_update",
        );
      expect(todoEvents.length).toBeGreaterThanOrEqual(3);
      expect(todoEvents.at(-1)).toMatchObject({
        type: "todo_update",
        items: [
          {
            id: "task-1",
            description: "Applying SDK changes",
            status: "in_progress",
          },
        ],
      });

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "tool_call",
            tool: "TaskCreate",
            itemId: "task-create-1",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "tool_call",
            tool: "TaskUpdate",
            itemId: "task-update-1",
          }),
        }),
      ]));
    });

    it("applies Claude task_started updates when the SDK task id matches the tool use id", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const stream = vi.fn(() => (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-1",
          slash_commands: [],
        };
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "task-1",
                name: "TaskCreate",
                input: {
                  subject: "Inspect SDK changes",
                  activeForm: "Inspecting SDK changes",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          parent_tool_use_id: "task-1",
          description: "Inspect SDK changes",
          task_type: "other",
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
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

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Track the SDK task list.",
      });

      const todoEvents = events
        .map((event) => event.event)
        .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "todo_update" }> =>
          event.type === "todo_update",
        );

      expect(todoEvents.at(-1)).toMatchObject({
        type: "todo_update",
        items: [
          {
            id: "task-1",
            description: "Inspect SDK changes",
            status: "in_progress",
          },
        ],
      });
    });
  });

  // --------------------------------------------------------------------------
  // setComputerUseArtifactBrokerService
  // --------------------------------------------------------------------------

  describe("setComputerUseArtifactBrokerService", () => {
    it("accepts a broker service without throwing", () => {
      const { service } = createService();
      const mockBroker = {
        getBackendStatus: vi.fn(() => null),
        ingest: vi.fn(),
      };

      expect(() => service.setComputerUseArtifactBrokerService(mockBroker as any)).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // warmupModel
  // --------------------------------------------------------------------------

  describe("warmupModel", () => {
    it("does nothing for unknown session id", async () => {
      const { service } = createService();
      // Should not throw
      await expect(
        service.warmupModel({ sessionId: "no-such-session", modelId: "opencode/anthropic/claude-sonnet-5" }),
      ).resolves.toBeUndefined();
    });

    it("does nothing for non-anthropic model", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      // A non-anthropic-cli model should be a no-op
      await expect(
        service.warmupModel({ sessionId: session.id, modelId: "opencode/anthropic/claude-sonnet-5" }),
      ).resolves.toBeUndefined();
    });

    it("does not rewrite a live session when the requested model does not match the backend session", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await expect(
        service.warmupModel({ sessionId: session.id, modelId: "anthropic/claude-sonnet-5" }),
      ).resolves.toBeUndefined();

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.provider).toBe("opencode");
      expect(summary?.modelId).toBe("opencode/anthropic/claude-sonnet-5");
    });
  });

  // --------------------------------------------------------------------------
  // getAvailableModels
  // --------------------------------------------------------------------------

  describe("getAvailableModels", () => {
    it("keeps OpenCode model discovery passive on a cache miss", async () => {
      clearOpenCodeInventoryCache();
      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "opencode" });

      expect(peekOpenCodeInventoryCache).toHaveBeenCalled();
      expect(probeOpenCodeProviderInventory).not.toHaveBeenCalled();
      expect(models).toEqual([]);
    });

    it("refreshes OpenCode models only when runtime activation is requested", async () => {
      clearOpenCodeInventoryCache();
      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "opencode", activateRuntime: true });

      expect(probeOpenCodeProviderInventory).toHaveBeenCalled();
      expect(models.map((model) => model.id)).toContain("opencode/openai/gpt-5.4");
    });

    it("returns an array for codex provider", async () => {
      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "codex" });
      expect(Array.isArray(models)).toBe(true);
    });

    it("pins GPT-5.6 ordering/defaults in filtered and provider-omitted catalogs", async () => {
      mockState.codexResponseOverrides.set("model/list", {
        data: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
            ],
          },
          {
            id: "gpt-5.6-luna",
            displayName: "GPT-5.6-Luna",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "xhigh", description: "Extra high" },
              { reasoningEffort: "max", description: "Max" },
            ],
            additionalSpeedTiers: ["fast"],
          },
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "xhigh", description: "Extra high" },
              { reasoningEffort: "max", description: "Max" },
              { reasoningEffort: "ultra", description: "Ultra" },
            ],
            additionalSpeedTiers: ["fast"],
          },
          {
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6-Terra",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "xhigh", description: "Extra high" },
              { reasoningEffort: "max", description: "Max" },
              { reasoningEffort: "ultra", description: "Ultra" },
            ],
            additionalSpeedTiers: ["fast"],
          },
        ],
      });
      const { service } = createService();

      const models = await service.getAvailableModels({ provider: "codex" });

      expect(models.slice(0, 4).map((model) => model.id)).toEqual([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
      ]);
      expect(models[0]).toMatchObject({
        isDefault: true,
        defaultReasoningEffort: "low",
        reasoningEfforts: [
          expect.objectContaining({ effort: "low" }),
          expect.objectContaining({ effort: "medium" }),
          expect.objectContaining({ effort: "high" }),
          expect.objectContaining({ effort: "xhigh" }),
          expect.objectContaining({ effort: "max" }),
          expect.objectContaining({ effort: "ultra" }),
        ],
        serviceTiers: ["fast"],
      });
      expect(models[1]).toMatchObject({ isDefault: false, defaultReasoningEffort: "medium" });
      expect(models[2]?.reasoningEfforts?.map((entry) => entry.effort)).toEqual([
        "low", "medium", "high", "xhigh", "max",
      ]);
      expect(models[3]?.isDefault).toBe(false);

      const aggregate = await service.getAvailableModels({});
      const codexIds = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
      const aggregatedCodexModels = aggregate.filter((model) => codexIds.has(model.id));
      expect(aggregate.length).toBeGreaterThan(0);
      expect(aggregatedCodexModels).toEqual(models.slice(0, 4));
    });

    it("returns an array for claude provider", async () => {
      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "claude" });
      expect(Array.isArray(models)).toBe(true);
    });

    it("returns Cursor CLI models without requiring a Cursor SDK API key", async () => {
      delete process.env.CURSOR_API_KEY;
      vi.mocked(detectAllAuth).mockResolvedValue([
        {
          type: "cli-subscription",
          cli: "cursor",
          path: "/usr/local/bin/cursor-agent",
          authenticated: true,
          verified: true,
          paidPlan: true,
        },
      ]);
      vi.mocked(spawn).mockImplementationOnce(() => {
        const stdout = new EventEmitter() as EventEmitter & { destroy: () => void };
        const stderr = new EventEmitter() as EventEmitter & { destroy: () => void };
        stdout.destroy = vi.fn();
        stderr.destroy = vi.fn();
        const child = new EventEmitter() as EventEmitter & {
          stdout: typeof stdout;
          stderr: typeof stderr;
          stdin: { destroy: () => void };
          kill: () => boolean;
          pid: number;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdin = { destroy: vi.fn() };
        child.kill = vi.fn(() => true);
        child.pid = 12345;
        queueMicrotask(() => {
          stdout.emit("data", Buffer.from("auto - Auto\ncomposer-2 - Composer 2\n"));
          child.emit("close", 0);
        });
        return child as any;
      });

      const { service } = createService();
      const models = await service.getAvailableModels({ provider: "cursor", activateRuntime: true });

      expect(models.map((model) => model.id)).toEqual(["cursor/auto", "cursor/composer-2"]);
      expect(models[0]).toMatchObject({
        cursorAvailability: { cli: true, sdk: false },
      });
      expect(models[0]?.description).toContain("Cursor CLI");

      // A surface that runs Cursor through the SDK (cursorSource: "sdk", e.g.
      // TUI/mobile chat) must not be offered these CLI-only models — they'd
      // fail on selection. With no SDK key configured, the sdk-scoped request
      // returns nothing rather than leaking the CLI-only rows.
      const sdkScoped = await service.getAvailableModels({
        provider: "cursor",
        activateRuntime: true,
        cursorSource: "sdk",
      });
      expect(sdkScoped).toEqual([]);
    });

    it("coalesces concurrent codex model discovery requests", async () => {
      const { service, logger } = createService();

      const [first, second] = await Promise.all([
        service.getAvailableModels({ provider: "codex" }),
        service.getAvailableModels({ provider: "codex" }),
      ]);

      expect(second).toEqual(first);
      const runtimeStarts = logger.info.mock.calls.filter(
        ([event]) => event === "agent_chat.codex_runtime_start",
      );
      expect(runtimeStarts).toHaveLength(1);
    });
  });

  describe("previewSessionToolNames", () => {
    it("includes core lane git tools for regular workflow sessions", () => {
      const { service } = createService();
      expect(service.previewSessionToolNames({
        laneId: "lane-1",
        sessionProfile: "workflow",
      } as any)).toEqual(expect.arrayContaining([
        "commit_changes",
        "rebase_lane",
        "stash_push",
        "list_stashes",
      ]));
    });
  });

  // --------------------------------------------------------------------------
  // getChatTranscript
  // --------------------------------------------------------------------------

  describe("getChatTranscript", () => {
    it("returns empty entries for a freshly created session", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      const transcript = await service.getChatTranscript({ sessionId: session.id });
      expect(transcript.sessionId).toBe(session.id);
      expect(transcript.entries).toEqual([]);
      expect(transcript.truncated).toBe(false);
      expect(transcript.totalEntries).toBe(0);
    });

    it("throws for unknown session", async () => {
      const { service } = createService();
      await expect(
        service.getChatTranscript({ sessionId: "nonexistent-id" }),
      ).rejects.toThrow(/not found/i);
    });

    it("keeps displayText as metadata while preserving the full user prompt", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Full handoff prompt with all implementation details.",
        displayText: "Pearl UI audit handoff",
      });

      const envelope = await waitForEvent(events, (event): event is AgentChatEventEnvelope => event.event.type === "user_message");
      expect(envelope.event).toMatchObject({
        type: "user_message",
        text: "Full handoff prompt with all implementation details.",
        displayText: "Pearl UI audit handoff",
      });

      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope]);
      const transcript = await service.getChatTranscript({ sessionId: session.id });
      expect(transcript.entries[0]).toMatchObject({
        role: "user",
        text: "Full handoff prompt with all implementation details.",
        displayText: "Pearl UI audit handoff",
      });
    });

    it("reads active transcripts from the uncapped dedicated transcript after the legacy cap", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const legacyEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "legacy-before-cap" },
        sequence: 1,
      };
      const dedicatedEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:01:00.000Z",
        event: { type: "text", text: "dedicated-post-cap" },
        sequence: 2,
      };

      const legacyTranscriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const dedicatedTranscriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(
        legacyTranscriptFile,
        `${JSON.stringify(legacyEnvelope)}\n[ADE] chat transcript limit reached (8MB). Further events omitted.\n`,
        "utf8",
      );
      fs.writeFileSync(dedicatedTranscriptFile, `${JSON.stringify(dedicatedEnvelope)}\n`, "utf8");
      fs.utimesSync(dedicatedTranscriptFile, new Date("2026-04-23T10:01:00.000Z"), new Date("2026-04-23T10:01:00.000Z"));
      fs.utimesSync(legacyTranscriptFile, new Date("2026-04-23T10:02:00.000Z"), new Date("2026-04-23T10:02:00.000Z"));
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("dedicated-post-cap")
          ? [dedicatedEnvelope]
          : raw.includes("legacy-before-cap")
            ? [legacyEnvelope]
            : [],
      );

      const transcript = await service.getChatTranscript({ sessionId: session.id });

      expect(transcript.entries.map((entry) => entry.text)).toEqual(["dedicated-post-cap"]);
    });

    it("coalesces streamed assistant fragments before applying transcript limits", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const events: AgentChatEventEnvelope[] = [{
        sessionId: session.id,
        timestamp: "2026-05-18T23:40:00.000Z",
        sequence: 1,
        event: {
          type: "user_message",
          text: "Count to 6000.",
          turnId: "turn-long",
        },
      }];
      for (let index = 1; index <= 130; index += 1) {
        events.push({
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:01.000Z",
          sequence: (index * 2),
          event: {
            type: "text",
            text: `${index}\n`,
            messageId: "assistant-message-long",
            turnId: "turn-long",
          },
        });
        events.push({
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:01.000Z",
          sequence: (index * 2) + 1,
          event: {
            type: "text",
            text: `other-${index}\n`,
            turnId: "turn-other",
          },
        });
      }
      fs.writeFileSync(path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`), "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(events);

      const transcript = await service.getChatTranscript({
        sessionId: session.id,
        limit: 100,
        maxChars: 40_000,
      });

      expect(transcript.totalEntries).toBe(3);
      expect(transcript.truncated).toBe(false);
      expect(transcript.entries).toHaveLength(3);
      expect(transcript.entries[1]).toMatchObject({
        role: "assistant",
        text: expect.stringMatching(/^1\n2\n3/),
        turnId: "turn-long",
      });
      expect(transcript.entries[1]!.text).toContain("\n130");
      expect(transcript.entries[2]).toMatchObject({
        role: "assistant",
        text: expect.stringMatching(/^other-1\nother-2/),
        turnId: "turn-other",
      });
    });

    it("keeps paragraph boundaries when same-turn assistant text resumes after another event", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const events: AgentChatEventEnvelope[] = [
        {
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:00.000Z",
          sequence: 1,
          event: {
            type: "text",
            text: "The fake bottom row is now a 1-point sentinel.",
            turnId: "turn-formatting",
          },
        },
        {
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:01.000Z",
          sequence: 2,
          event: {
            type: "tool_call",
            tool: "shell",
            args: {},
            itemId: "tool-1",
            turnId: "turn-formatting",
          },
        },
        {
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:02.000Z",
          sequence: 3,
          event: {
            type: "text",
            text: "Next I am threading status through the end marker.",
            turnId: "turn-formatting",
          },
        },
      ];
      fs.writeFileSync(path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`), "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(events);

      const transcript = await service.getChatTranscript({ sessionId: session.id });

      expect(transcript.entries).toHaveLength(1);
      expect(transcript.entries[0]).toMatchObject({
        role: "assistant",
        text: "The fake bottom row is now a 1-point sentinel.\n\nNext I am threading status through the end marker.",
        turnId: "turn-formatting",
      });
    });

    it("includes assistant message ids in transcript entries", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });
      const events: AgentChatEventEnvelope[] = [
        {
          sessionId: session.id,
          timestamp: "2026-05-18T23:40:00.000Z",
          sequence: 1,
          event: {
            type: "text",
            text: "Stable identified message.",
            messageId: "message-1",
            itemId: "item-1",
            turnId: "turn-ids",
          },
        },
      ];
      fs.writeFileSync(path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`), "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(events);

      const transcript = await service.getChatTranscript({ sessionId: session.id });

      expect(transcript.entries[0]).toMatchObject({
        role: "assistant",
        text: "Stable identified message.",
        messageId: "message-1",
        itemId: "item-1",
        turnId: "turn-ids",
      });
    });
  });

  describe("readTranscript", () => {
    it("refuses non-chat sessions even when a transcript file exists", async () => {
      const { service, sessionService } = createService();
      const transcriptPath = path.join(tmpRoot, "transcripts", "terminal-session.chat.jsonl");
      fs.writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          sessionId: "terminal-session",
          timestamp: "2026-06-30T12:00:00.000Z",
          event: { type: "user_message", text: "terminal secret" },
          sequence: 1,
        })}\n`,
        "utf8",
      );
      sessionService.create({
        sessionId: "terminal-session",
        laneId: "lane-1",
        toolType: "terminal",
        transcriptPath,
      });
      vi.mocked(parseAgentChatTranscript).mockReturnValue([{
        sessionId: "terminal-session",
        timestamp: "2026-06-30T12:00:00.000Z",
        event: { type: "user_message", text: "terminal secret" },
        sequence: 1,
      }]);

      await expect(service.readTranscript("terminal-session")).resolves.toEqual([]);
      expect(parseAgentChatTranscript).not.toHaveBeenCalled();
    });
  });

  describe("getChatEventHistory", () => {
    it("returns an empty history for an unknown session", async () => {
      const { service } = createService();
      const history = service.getChatEventHistory("unknown-session");
      expect(history.events).toEqual([]);
      expect(history.truncated).toBe(false);
      expect(history.transcriptTruncated).toBe(false);
      expect(history.windowTruncated).toBe(false);
      expect(history.sessionFound).toBe(false);
    });

    it("hydrates history from the on-disk transcript on first read", async () => {
      // This is the core contract that fixes chat-history-loss on project
      // switch / tab switch: a late subscriber that missed the live broadcast
      // still sees persisted recent history, because getChatEventHistory hydrates
      // itself from the transcript the first time the session is queried.
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelope1: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        event: { type: "text", text: "persisted-1" },
        sequence: 1,
      };
      const envelope2: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        event: { type: "text", text: "persisted-2" },
        sequence: 2,
      };

      // Seed the transcript file at the path managed.transcriptPath points
      // to (set by createSession → managedSessions → row.transcriptPath).
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope1)}\n${JSON.stringify(envelope2)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope1, envelope2]);

      const history = service.getChatEventHistory(session.id);
      expect(history.sessionId).toBe(session.id);
      expect(history.sessionFound).toBe(true);
      expect(history.events).toHaveLength(2);
      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["persisted-1", "persisted-2"]);
    });

    it("hydrates from the more complete dedicated chat transcript when the legacy transcript is capped", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const cappedLegacyEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "legacy-before-cap" },
        sequence: 1,
      };
      const dedicatedEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:01:00.000Z",
        event: { type: "text", text: "dedicated-after-cap" },
        sequence: 2,
      };

      const legacyTranscriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const dedicatedTranscriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(
        legacyTranscriptFile,
        `${JSON.stringify(cappedLegacyEnvelope)}\n[ADE] chat transcript limit reached (8MB). Further events omitted.\n`,
        "utf8",
      );
      fs.writeFileSync(
        dedicatedTranscriptFile,
        `${JSON.stringify(cappedLegacyEnvelope)}\n${JSON.stringify(dedicatedEnvelope)}\n`,
        "utf8",
      );
      fs.utimesSync(dedicatedTranscriptFile, new Date("2026-04-23T10:01:00.000Z"), new Date("2026-04-23T10:01:00.000Z"));
      fs.utimesSync(legacyTranscriptFile, new Date("2026-04-23T10:02:00.000Z"), new Date("2026-04-23T10:02:00.000Z"));
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("dedicated-after-cap")
          ? [cappedLegacyEnvelope, dedicatedEnvelope]
          : [cappedLegacyEnvelope],
      );

      const history = service.getChatEventHistory(session.id);

      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["legacy-before-cap", "dedicated-after-cap"]);
    });

    it("hydrates from the uncapped dedicated chat transcript when the capped legacy transcript is newer", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const cappedLegacyEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "legacy-capped-boundary" },
        sequence: 1,
      };
      const dedicatedEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "dedicated-uncapped-boundary" },
        sequence: 1,
      };

      const legacyTranscriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const dedicatedTranscriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(
        legacyTranscriptFile,
        `${JSON.stringify(cappedLegacyEnvelope)}\n[ADE] chat transcript limit reached (8MB). Further events omitted.\n`,
        "utf8",
      );
      fs.writeFileSync(dedicatedTranscriptFile, `${JSON.stringify(dedicatedEnvelope)}\n`, "utf8");
      fs.utimesSync(dedicatedTranscriptFile, new Date("2026-04-23T10:00:00.000Z"), new Date("2026-04-23T10:00:00.000Z"));
      fs.utimesSync(legacyTranscriptFile, new Date("2026-04-23T10:02:00.000Z"), new Date("2026-04-23T10:02:00.000Z"));
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("dedicated-uncapped-boundary")
          ? [dedicatedEnvelope]
          : [cappedLegacyEnvelope],
      );

      const history = service.getChatEventHistory(session.id);

      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["dedicated-uncapped-boundary"]);
    });

    it("hydrates from the legacy transcript when the newest dedicated transcript has only a header", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const legacyEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "legacy-chat-event" },
        sequence: 1,
      };

      const legacyTranscriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const dedicatedTranscriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(legacyTranscriptFile, `${JSON.stringify(legacyEnvelope)}\n`, "utf8");
      fs.writeFileSync(
        dedicatedTranscriptFile,
        `${JSON.stringify({ type: "session_init", sessionId: session.id })}\n`,
        "utf8",
      );
      fs.utimesSync(legacyTranscriptFile, new Date("2026-04-23T10:00:00.000Z"), new Date("2026-04-23T10:00:00.000Z"));
      fs.utimesSync(dedicatedTranscriptFile, new Date("2026-04-23T10:05:00.000Z"), new Date("2026-04-23T10:05:00.000Z"));
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("legacy-chat-event") ? [legacyEnvelope] : [],
      );

      const history = service.getChatEventHistory(session.id);

      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["legacy-chat-event"]);
    });

    it("hydrates from the newer dedicated chat transcript even when compacted storage makes it smaller", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const staleLegacyEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "legacy-stale-large" },
        sequence: 1,
      };
      const newerDedicatedEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:01:00.000Z",
        event: { type: "text", text: "dedicated-newer-compacted" },
        sequence: 2,
      };

      const legacyTranscriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const dedicatedTranscriptFile = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      fs.writeFileSync(
        legacyTranscriptFile,
        `${JSON.stringify(staleLegacyEnvelope)}\n${"raw-legacy-padding\n".repeat(4096)}`,
        "utf8",
      );
      fs.writeFileSync(
        dedicatedTranscriptFile,
        `${JSON.stringify(newerDedicatedEnvelope)}\n`,
        "utf8",
      );
      fs.utimesSync(legacyTranscriptFile, new Date("2026-04-23T10:00:00.000Z"), new Date("2026-04-23T10:00:00.000Z"));
      fs.utimesSync(dedicatedTranscriptFile, new Date("2026-04-23T10:01:00.000Z"), new Date("2026-04-23T10:01:00.000Z"));
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("dedicated-newer-compacted")
          ? [newerDedicatedEnvelope]
          : [staleLegacyEnvelope],
      );

      const history = service.getChatEventHistory(session.id);

      expect(fs.statSync(legacyTranscriptFile).size).toBeGreaterThan(fs.statSync(dedicatedTranscriptFile).size);
      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["dedicated-newer-compacted"]);
    });

    it("bounds oversized transcript hydration before parsing", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const oldEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T09:59:00.000Z",
        event: { type: "text", text: "old-head" },
        sequence: 1,
      };
      const recentEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:01:00.000Z",
        event: { type: "text", text: "recent-tail" },
        sequence: 2,
      };

      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const hugeMiddleEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "x".repeat(2_100_000) },
        sequence: 2,
      };
      fs.writeFileSync(
        transcriptFile,
        [
          JSON.stringify(oldEnvelope),
          JSON.stringify(hugeMiddleEnvelope),
          JSON.stringify(recentEnvelope),
          "",
        ].join("\n"),
        "utf8",
      );
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) => {
        expect(raw.length).toBeLessThan(50_000);
        expect(raw).toContain("recent-tail");
        expect(raw).not.toContain("old-head");
        return [recentEnvelope];
      });

      const history = service.getChatEventHistory(session.id);

      expect(history.truncated).toBe(true);
      expect(history.transcriptTruncated).toBe(true);
      expect(history.windowTruncated).toBe(false);
      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["recent-tail"]);
    });

    it("separates max-event window truncation from transcript-tail truncation", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelopes: AgentChatEventEnvelope[] = Array.from({ length: 5 }, (_, index) => ({
        sessionId: session.id,
        timestamp: `2026-04-23T10:0${index}:00.000Z`,
        event: { type: "text", text: `event-${index}` },
        sequence: index + 1,
      }));
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${envelopes.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(envelopes);

      const history = service.getChatEventHistory(session.id, { maxEvents: 3 });

      expect(history.truncated).toBe(true);
      expect(history.transcriptTruncated).toBe(false);
      expect(history.windowTruncated).toBe(true);
      expect(history.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["event-2", "event-3", "event-4"]);
    });

    it("byte-caps a snapshot whose merged events exceed the response budget", async () => {
      // Regression: individual chat events can carry multi-MB tool outputs.
      // Event-count caps alone let a snapshot serialize past the desktop RPC
      // client's 16 MiB per-message limit, which used to fail every in-flight
      // call on the shared runtime socket.
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelopes: AgentChatEventEnvelope[] = Array.from({ length: 4 }, (_, index) => ({
        sessionId: session.id,
        timestamp: `2026-04-23T10:0${index}:00.000Z`,
        event: { type: "text", text: `event-${index}-${"x".repeat(3_000_000)}` },
        sequence: index + 1,
      }));
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(envelopes);

      const history = service.getChatEventHistory(session.id);

      // 4 × ~3 MB events exceed the 8 MB response budget: only the newest
      // events that fit are returned, and the trim is reported as window
      // truncation so clients know to page for the rest.
      expect(history.events.length).toBeLessThan(envelopes.length);
      expect(history.events.length).toBeGreaterThan(0);
      expect(history.windowTruncated).toBe(true);
      expect(history.truncated).toBe(true);
      expect(JSON.stringify(history.events).length).toBeLessThanOrEqual(8_000_000);
      const lastEvent = history.events.at(-1)?.event;
      expect(lastEvent?.type === "text" ? lastEvent.text.startsWith("event-3-") : false).toBe(true);
    });

    it("always returns at least the newest event even when it alone exceeds the byte budget", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const giant: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "giant-".concat("y".repeat(9_000_000)) },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([giant]);

      const history = service.getChatEventHistory(session.id);
      expect(history.events).toHaveLength(1);
    });

    it("drops an oversized newest event when a strict mobile byte budget is requested", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const giant: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "giant-".concat("y".repeat(16_000)) },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([giant]);

      const history = service.getChatEventHistory(session.id, { maxBytes: 8_192 });

      expect(history.events).toHaveLength(0);
      expect(history.windowTruncated).toBe(true);
      expect(history.truncated).toBe(true);
    });

    it("marks window truncation when the service response cap removes events", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelopes: AgentChatEventEnvelope[] = Array.from({ length: 20_001 }, (_, index) => ({
        sessionId: session.id,
        timestamp: new Date(Date.UTC(2026, 3, 23, 10, 0, index)).toISOString(),
        event: { type: "text", text: `event-${index}` },
        sequence: index + 1,
      }));
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, "ignored\n", "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue(envelopes);

      const history = service.getChatEventHistory(session.id);

      expect(history.events).toHaveLength(20_000);
      expect(history.truncated).toBe(true);
      expect(history.transcriptTruncated).toBe(false);
      expect(history.windowTruncated).toBe(true);
      expect(history.events[0]?.event).toMatchObject({ type: "text", text: "event-1" });
    });

    it("reuses an unchanged parsed transcript tail across repeated history snapshots", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "persisted-once" },
        sequence: 1,
      };

      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockClear();
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) =>
        raw.includes("persisted-once") ? [envelope] : [],
      );

      const firstHistory = service.getChatEventHistory(session.id);
      const secondHistory = service.getChatEventHistory(session.id);

      expect(firstHistory.events).toHaveLength(1);
      expect(secondHistory.events).toHaveLength(1);
      expect(parseAgentChatTranscript).toHaveBeenCalledTimes(2);
    });

    it("re-reads the on-disk transcript on repeated history snapshots", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelope1: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:00:00.000Z",
        event: { type: "text", text: "persisted-before-switch" },
        sequence: 1,
      };
      const envelope2: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-04-23T10:01:00.000Z",
        event: { type: "text", text: "persisted-after-switch" },
        sequence: 2,
      };

      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope1)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) => {
        if (raw.includes("persisted-after-switch")) return [envelope1, envelope2];
        if (raw.includes("persisted-before-switch")) return [envelope1];
        return [];
      });

      const firstHistory = service.getChatEventHistory(session.id);
      expect(firstHistory.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["persisted-before-switch"]);

      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope1)}\n${JSON.stringify(envelope2)}\n`, "utf8");

      const secondHistory = service.getChatEventHistory(session.id);
      expect(secondHistory.events.map((envelope) =>
        envelope.event.type === "text" ? envelope.event.text : "",
      )).toEqual(["persisted-before-switch", "persisted-after-switch"]);
    });

    it("keeps Claude streaming fragments that share a timestamp when hydrating", async () => {
      // Claude SDK emits multiple text deltas inside tight streaming loops,
      // so two legitimate envelopes with type:"text" can land on the same
      // millisecond. A naive timestamp+type dedup key would collapse these;
      // the cross-run-safe dedup must keep distinct payloads separate.
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const sharedTimestamp = new Date().toISOString();
      const envelope1: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: sharedTimestamp,
        event: { type: "text", text: "fragment-a" },
        sequence: 1,
      };
      const envelope2: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: sharedTimestamp,
        event: { type: "text", text: "fragment-b" },
        sequence: 2,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope1)}\n${JSON.stringify(envelope2)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope1, envelope2]);

      const history = service.getChatEventHistory(session.id);
      expect(history.events).toHaveLength(2);
      expect(history.events.map((e) => e.event.type === "text" ? e.event.text : "")).toEqual([
        "fragment-a",
        "fragment-b",
      ]);
    });

    it("does not hydrate transcript symlinks that resolve outside ADE", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        event: { type: "text", text: "outside-transcript" },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const outsideTranscriptPath = path.join(tmpHomeRoot, "outside-transcript.jsonl");
      fs.writeFileSync(outsideTranscriptPath, `${JSON.stringify(envelope)}\n`, "utf8");
      fs.rmSync(transcriptFile, { force: true });
      fs.rmSync(path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`), { force: true });
      fs.symlinkSync(outsideTranscriptPath, transcriptFile);
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope]);

      const history = service.getChatEventHistory(session.id);

      expect(history.events).toEqual([]);
      expect(parseAgentChatTranscript).not.toHaveBeenCalled();
    });

    it("drops history when the underlying session is deleted", async () => {
      // We don't rely on sendMessage emitting events (mock streams vary across
      // providers), so we seed the transcript directly to verify the cleanup
      // path. deleteSession must remove both the in-memory ring buffer and
      // any hydrated-from-disk state so a subsequently-created session with
      // the same id doesn't inherit stale events.
      const emitted: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => emitted.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      // Seed the transcript on disk and populate the hydrated-from-disk cache
      // BEFORE deleting, so a regression where deleteSession fails to clear
      // the cache would actually be caught (an empty history trivially stays
      // empty).
      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        event: { type: "text", text: "before-delete" },
        sequence: 1,
      };
      // The legacy transcript is newer than the session_init-only dedicated
      // transcript, so hydration reads this seeded file.
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockReturnValue([envelope]);
      const beforeDelete = service.getChatEventHistory(session.id);
      expect(beforeDelete.events).toHaveLength(1);

      await service.deleteSession({ sessionId: session.id });

      // The transcript-returning parser mock is still wired up, so if
      // deleteSession fails to clear the cache / on-disk file, the next read
      // would still surface envelopes. An empty result proves both the
      // in-memory ring buffer and the hydrated state were cleared.
      const afterDelete = service.getChatEventHistory(session.id);
      expect(afterDelete.events).toEqual([]);
      expect(afterDelete.truncated).toBe(false);
      expect(afterDelete.sessionFound).toBe(false);
    });
  });

  describe("getChatEventHistoryPage", () => {
    // Byte-window edge cases (line-boundary cursors, oversized lines,
    // multi-byte UTF-8, concurrent appends) are covered with the REAL parser
    // in chatTranscriptHistoryPager.test.ts; these tests cover the service
    // contract around it: session validation, path resolution, subagent
    // filtering, and the tailStartOffset cursor handshake.
    const jsonLineParse = (raw: string): AgentChatEventEnvelope[] =>
      raw.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as AgentChatEventEnvelope);

    const paddedLine = (envelope: AgentChatEventEnvelope, exactBytes: number): string => {
      const baseEvent = envelope.event as { type: "text"; text: string };
      let line = `${JSON.stringify(envelope)}\n`;
      const padding = exactBytes - Buffer.byteLength(line, "utf8");
      if (padding < 0) throw new Error("fixture line too large");
      line = `${JSON.stringify({ ...envelope, event: { ...baseEvent, text: baseEvent.text + "x".repeat(padding) } })}\n`;
      expect(Buffer.byteLength(line, "utf8")).toBe(exactBytes);
      return line;
    };

    it("returns sessionFound:false for unknown sessions", () => {
      const { service } = createService();
      const page = service.getChatEventHistoryPage("unknown-session", { beforeOffset: 1_000 });
      expect(page).toEqual({
        sessionId: "unknown-session",
        events: [],
        startOffset: 0,
        hasMore: false,
        sessionFound: false,
      });
    });

    it("returns an empty head-reached page for beforeOffset <= 0", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      for (const beforeOffset of [0, -25]) {
        const page = service.getChatEventHistoryPage(session.id, { beforeOffset });
        expect(page.sessionFound).toBe(true);
        expect(page.events).toEqual([]);
        expect(page.hasMore).toBe(false);
        expect(page.startOffset).toBe(0);
      }
    });

    it("returns an empty page when the transcript file is missing", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      fs.rmSync(path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`), { force: true });
      const page = service.getChatEventHistoryPage(session.id, { beforeOffset: 5_000 });
      expect(page.sessionFound).toBe(true);
      expect(page.events).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.startOffset).toBe(0);
    });

    it("reads the requested byte window and filters Codex subagent envelopes", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });

      const parentEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-10T10:00:00.000Z",
        event: { type: "text", text: "parent-visible" },
        sequence: 1,
      };
      const subagentEnvelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-10T10:00:01.000Z",
        event: { type: "text", text: "subagent-hidden" },
        sequence: 2,
        provenance: { targetKind: "codex_subagent" },
      };
      const otherSessionEnvelope: AgentChatEventEnvelope = {
        sessionId: "other-session",
        timestamp: "2026-06-10T10:00:02.000Z",
        event: { type: "text", text: "foreign" },
        sequence: 3,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const raw = [parentEnvelope, subagentEnvelope, otherSessionEnvelope]
        .map((entry) => `${JSON.stringify(entry)}\n`).join("");
      fs.writeFileSync(transcriptFile, raw, "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation(jsonLineParse);

      const page = service.getChatEventHistoryPage(session.id, {
        beforeOffset: Buffer.byteLength(raw, "utf8"),
      });
      expect(page.sessionFound).toBe(true);
      expect(page.events.map((entry) => (entry.event.type === "text" ? entry.event.text : ""))).toEqual([
        "parent-visible",
      ]);
      expect(page.startOffset).toBe(0);
      expect(page.hasMore).toBe(false);
    });

    it("hands out a tailStartOffset that pages seamlessly into the bytes the tail skipped", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });

      // 82 lines × 25_000 bytes = 2_050_000 bytes — 50_000 bytes older than the
      // 2_000_000-byte hydration tail, i.e. exactly the first two lines.
      const LINE_BYTES = 25_000;
      const LINE_COUNT = 82;
      const lines: string[] = [];
      for (let index = 0; index < LINE_COUNT; index += 1) {
        lines.push(paddedLine({
          sessionId: session.id,
          timestamp: new Date(Date.UTC(2026, 5, 10, 10, 0, index)).toISOString(),
          event: { type: "text", text: `line-${index}-` },
          sequence: index,
        }, LINE_BYTES));
      }
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, lines.join(""), "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation(jsonLineParse);

      const history = service.getChatEventHistory(session.id);
      expect(history.transcriptTruncated).toBe(true);
      // The tail window starts exactly at line 2 (a line boundary).
      expect(history.tailStartOffset).toBe(2 * LINE_BYTES);
      expect(history.events[0]?.event).toMatchObject({ type: "text" });
      expect((history.events[0]?.event as { text: string }).text.startsWith("line-2-")).toBe(true);

      const page = service.getChatEventHistoryPage(session.id, { beforeOffset: history.tailStartOffset! });
      expect(page.sessionFound).toBe(true);
      expect(page.events.map((entry) => (entry.event.type === "text" ? entry.event.text.split("x")[0] : ""))).toEqual([
        "line-0-",
        "line-1-",
      ]);
      expect(page.startOffset).toBe(0);
      expect(page.hasMore).toBe(false);
    });

    it("reports a null tailStartOffset when the transcript is fully hydrated", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      const envelope: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-06-10T10:00:00.000Z",
        event: { type: "text", text: "small" },
        sequence: 1,
      };
      const transcriptFile = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      fs.writeFileSync(transcriptFile, `${JSON.stringify(envelope)}\n`, "utf8");
      vi.mocked(parseAgentChatTranscript).mockImplementation(jsonLineParse);

      const history = service.getChatEventHistory(session.id);
      expect(history.transcriptTruncated).toBe(false);
      expect(history.tailStartOffset).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Session creation edge cases
  // --------------------------------------------------------------------------

  describe("session creation edge cases", () => {
    it("applies automationId and automationRunId when surface is automation", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        surface: "automation",
        automationId: "auto-1",
        automationRunId: "run-1",
      });

      expect(session.surface).toBe("automation");
      expect(session.automationId).toBe("auto-1");
      expect(session.automationRunId).toBe("run-1");
    });

    it("creates a codex session with specified model", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      expect(session.provider).toBe("codex");
      expect(session.status).toBe("idle");
    });

    it("persists capabilityMode when provided", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
        capabilityMode: "cto",
      } as any);

      // capabilityMode may be resolved to a fallback if not fully supported
      expect(session.capabilityMode).toBeDefined();
    });

    it("uses default execution mode for new sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      // executionMode defaults to null or undefined for new sessions
      expect(session.executionMode == null).toBe(true);
    });

    it("does not auto-upgrade guarded local opencode sessions into plan mode", async () => {
      replaceDynamicOpenCodeModelDescriptors([
        createDynamicOpenCodeModelDescriptor("lmstudio/qwen3.5-9b", {
          displayName: "qwen3.5-9b",
          capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
          openCodeProviderId: "lmstudio",
          openCodeModelId: "qwen3.5-9b",
        }),
      ]);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "LM Studio (Auto)",
        modelId: "lmstudio/auto",
      });

      expect(session.permissionMode).toBe("edit");
      expect(session.opencodePermissionMode).toBe("edit");
    });

    it("does not force an ADE OpenCode agent when config mode is selected", async () => {
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
        opencodePermissionMode: "config-toml",
      });

      expect(session.opencodePermissionMode).toBe("config-toml");
      expect(session.permissionMode).toBe("config-toml");

      await service.sendMessage({ sessionId: session.id, text: "Use configured OpenCode behavior." }, { awaitDispatch: true });

      const openCodeState = [...mockState.openCodeSessions.values()][0]!;
      expect(openCodeState.promptBodies.at(-1)).toEqual(expect.not.objectContaining({
        agent: expect.stringMatching(/^ade-/),
      }));
    });

    it("sends the fast variant for supported OpenCode models when enabled", async () => {
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));
      replaceDynamicOpenCodeModelDescriptors([
        createDynamicOpenCodeModelDescriptor("", {
          displayName: "GPT 5.4",
          capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
          openCodeProviderId: "openai",
          openCodeModelId: "gpt-5.4",
          serviceTiers: ["fast"],
        }),
      ]);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
        fastMode: true,
      });

      expect(session.fastMode).toBe(true);

      await service.sendMessage({ sessionId: session.id, text: "Use OpenCode fast mode." }, { awaitDispatch: true });

      const openCodeState = [...mockState.openCodeSessions.values()][0]!;
      await vi.waitFor(() => {
        expect(openCodeState.promptBodies.length).toBeGreaterThan(0);
      });
      expect(openCodeState.promptBodies.at(-1)).toEqual(expect.objectContaining({
        variant: "fast",
      }));
    });
  });

  // --------------------------------------------------------------------------
  // Session status transitions
  // --------------------------------------------------------------------------

  describe("session status transitions", () => {
    it("session starts with idle status", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(session.status).toBe("idle");
    });

    it("session has null completion initially", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(session.completion).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Interaction mode handling
  // --------------------------------------------------------------------------

  describe("interaction mode", () => {
    it("defaults interaction mode to null or undefined", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      expect(session.interactionMode == null).toBe(true);
    });

    it("persists plan interaction mode for Claude sessions via claudePermissionMode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "plan",
      });

      // Plan interaction mode is derived from claudePermissionMode for Claude sessions
      expect(session.interactionMode).toBe("plan");
      expect(session.permissionMode).toBe("plan");
    });

    it("maps claude plan permission mode to interaction mode plan", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        claudePermissionMode: "plan",
      });

      expect(session.interactionMode).toBe("plan");
      expect(session.claudePermissionMode).toBe("default");
    });

    it("sends Codex plan collaboration mode on turn start for plan sessions", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });
      expect(session.permissionMode).toBe("plan");

      await service.sendMessage({
        sessionId: session.id,
        text: "Ask one planning question before coding.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "collaborationMode/list")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const threadParams = threadStartRequest?.params as { developerInstructions?: unknown } | undefined;
      const params = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown; networkAccess?: unknown; access?: { type?: unknown } };
        effort?: unknown;
        input?: Array<{ type?: unknown; text?: unknown }>;
        collaborationMode?: Record<string, unknown>;
      } | undefined;
      const collaborationMode = params?.collaborationMode as
        | { mode?: unknown; settings?: { model?: unknown; reasoning_effort?: unknown; developer_instructions?: unknown } }
        | undefined;
      const textInputs = (params?.input ?? []).filter((item) => item.type === "text");

      expect(threadParams?.developerInstructions).toBe("system prompt");
      expect(params?.approvalPolicy).toBe("untrusted");
      expect(params?.sandboxPolicy?.type).toBe("readOnly");
      expect(params?.effort).toBe("medium");
      expect(collaborationMode?.mode).toBe("plan");
      expect(collaborationMode?.settings?.model).toBe("gpt-5.4");
      expect(collaborationMode?.settings?.reasoning_effort).toBe("medium");
      expect(collaborationMode?.settings?.developer_instructions).toBeNull();
      expect(textInputs).toHaveLength(1);
      expect(textInputs.at(-1)?.text).toContain("User request:");
      expect(textInputs.at(-1)?.text).toContain("Ask one planning question before coding.");
      expect(textInputs.at(-1)?.text).not.toContain("System context (ADE runtime guidance");
      expect(vi.mocked(buildCodingAgentSystemPrompt)).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: expect.stringContaining(path.basename(tmpRoot)),
          mode: "planning",
          permissionMode: "plan",
          interactive: true,
          runtime: "codex-app-server",
        }),
      );
    });

    it("turns native Codex plan items into an implementation approval request", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "edit") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        if (mode === "config-toml") return null;
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan the fix before coding.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-1",
            type: "plan",
            text: "<proposed_plan>\n## Summary\n- Inspect the app-server wiring.\n- Patch the native plan handoff.\n</proposed_plan>",
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === "codex-plan-1"
          && (event.event.streamingText ?? "").includes("Inspect the app-server wiring"),
      );
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
      );
      const request = (approvalEvent.event.detail as { request?: { description?: string } } | undefined)?.request;

      expect(request?.description).toContain("## Summary");
      expect(request?.description).toContain("Patch the native plan handoff");
      expect(request?.description).not.toContain("<proposed_plan>");

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });

      const turnStartCountBeforeApproval = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start").length;
      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start").length)
          .toBeGreaterThan(turnStartCountBeforeApproval);
      });
      // An approved plan hands the session straight to full access — the user
      // already reviewed exactly what will happen.
      expect((await service.getSessionSummary(session.id))?.permissionMode).toBe("full-auto");
    });

    it("emits a terminal event when a streamed native Codex plan item completes", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan with a streamed native plan item.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: {
          turnId: "turn-1",
          itemId: "codex-plan-streamed",
          delta: "1. Inspect the streamed plan.",
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === "codex-plan-streamed"
          && event.event.state === "delta",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-streamed",
            type: "plan",
          },
        },
      });

      const completedPlanEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === "codex-plan-streamed"
          && event.event.state === "complete"
          && (event.event.streamingText ?? "").includes("Inspect the streamed plan"),
      );
      expect(completedPlanEvent.event.state).toBe("complete");
      expect(completedPlanEvent.event.streamingText).toContain("Inspect the streamed plan");
    });

    it("emits a terminal event when a native Codex plan item completes without text", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan with an empty native plan item.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-empty",
            type: "plan",
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === "codex-plan-empty"
          && event.event.state === "active",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "codex-plan-empty",
            type: "plan",
          },
        },
      });

      const completeEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === "codex-plan-empty"
          && event.event.state === "complete",
      );
      expect(completeEvent.event.streamingText).toBe("");
    });

    it("keeps native Codex plan deltas under a stable fallback item id", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan with streaming deltas.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: {
          turnId: "turn-1",
          delta: "1. Inspect the service\n",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: {
          turnId: "turn-1",
          delta: "2. Patch the handoff",
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === `codex-plan:${session.id}:turn-1`
          && (event.event.streamingText ?? "").includes("Patch the handoff"),
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } =>
          event.event.type === "plan"
          && event.event.itemId === `codex-plan:${session.id}:turn-1`
          && event.event.state === "complete"
          && (event.event.streamingText ?? "").includes("Patch the handoff"),
      );

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
      );
      const request = (approvalEvent.event.detail as { request?: { description?: string } } | undefined)?.request;
      expect(request?.description).toContain("1. Inspect the service");
      expect(request?.description).toContain("2. Patch the handoff");
    });

    it("does not request native Codex plan approval after a failed turn", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan but fail.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: {
          turnId: "turn-1",
          itemId: "codex-plan-failed",
          delta: "1. This should not be approvable.",
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "plan" }>;
        } => event.event.type === "plan" && event.event.itemId === "codex-plan-failed",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "failed",
            error: { message: "Plan mode crashed" },
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } => event.event.type === "status" && event.event.turnStatus === "failed",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.some((event) =>
        event.event.type === "approval_request"
        && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval")
      )).toBe(false);
    });

    it("sends Codex default collaboration mode on turn start outside plan mode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      expect(session.permissionMode).toBe("default");
      expect(session.codexApprovalPolicy).toBe("on-request");
      expect(session.codexSandbox).toBe("workspace-write");

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: {
          type?: unknown;
          networkAccess?: unknown;
          readOnlyAccess?: { type?: unknown };
          writableRoots?: unknown[];
          excludeTmpdirEnvVar?: unknown;
          excludeSlashTmp?: unknown;
        };
        effort?: unknown;
        collaborationMode?: Record<string, unknown>;
      } | undefined;
      const collaborationMode = params?.collaborationMode as
        | { mode?: unknown; settings?: { developer_instructions?: unknown } }
        | undefined;

      expect(params?.approvalPolicy).toBe("on-request");
      expect(params?.sandboxPolicy?.type).toBe("workspaceWrite");
      expect(params?.effort).toBe("medium");
      expect(collaborationMode?.mode).toBe("default");
      expect(collaborationMode?.settings?.developer_instructions).toBe("system prompt");
    });

    it("handles Codex /plan prompts inline and sends the next app-server turn in plan mode", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/plan Please plan the renderer refactor before editing app.tsx.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).toBe("plan");
      expect(summary?.interactionMode).toBe("plan");
      expect(summary?.codexApprovalPolicy).toBe("on-request");
      expect(summary?.codexSandbox).toBe("read-only");

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
        collaborationMode?: { mode?: unknown };
        input?: Array<{ text?: unknown }>;
      } | undefined;
      const textInput = params?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(textInput).toContain("Please plan the renderer refactor before editing app.tsx.");
      expect(textInput).not.toContain("/plan");
      expect(params?.approvalPolicy).toBe("on-request");
      expect(params?.sandboxPolicy?.type).toBe("readOnly");
      expect(params?.collaborationMode?.mode).toBe("plan");
    });

    it("sends fast service tier for supported Codex models when enabled", async () => {
      mockState.codexResponseOverrides.set("thread/start", (payload) => ({
        thread: { id: "thread-fast" },
        serviceTier: (payload.params as { serviceTier?: unknown } | undefined)?.serviceTier ?? null,
      }));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        fastMode: true,
      });

      expect(session.fastMode).toBe(true);

      await service.sendMessage({
        sessionId: session.id,
        text: "Use fast mode.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect((threadStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((turnStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.fastMode).toBe(true);
      expect(summary?.codexServiceTier).toBe("fast");
      const persisted = readPersistedChatState(session.id);
      expect(persisted.fastMode).toBe(true);
      expect(persisted.codexServiceTier).toBe("fast");
    });

    it("handles /fast commands inline and applies fast tier to the next app-server turn", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/fast on",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
      expect(readPersistedChatState(session.id).fastMode).toBe(true);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Fast mode is on."
      )).toBe(true);

      mockState.codexRequestPayloads = [];
      await service.sendMessage({
        sessionId: session.id,
        text: "Use fast mode now.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((turnStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");
    });

    it("handles /fast commands for Cursor models advertised as fast in the model catalog", async () => {
      process.env.CURSOR_API_KEY = "crsr_test";
      cursorModelsListMock.mockResolvedValue([
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          parameters: [
            {
              id: "speed",
              displayName: "Speed",
              values: [{ value: "fast", displayName: "Fast" }],
            },
          ],
        },
      ]);
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      await service.getModelCatalog({ mode: "force", refreshProvider: "cursor" });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2.5",
        modelId: "cursor/composer-2.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/fast on",
      }, { awaitDispatch: true });

      expect(mockState.cursorSdkSendCalls).toHaveLength(0);
      expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
      expect(readPersistedChatState(session.id).fastMode).toBe(true);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Fast mode is on."
      )).toBe(true);
    });

    it("passes standard Cursor SDK params when fast mode is off", async () => {
      process.env.CURSOR_API_KEY = "crsr_test";
      cursorModelsListMock.mockResolvedValue([
        {
          id: "composer-2.5",
          displayName: "Composer 2.5",
          parameters: [
            {
              id: "speed",
              displayName: "Speed",
              values: [
                { value: "standard", displayName: "Standard" },
                { value: "fast", displayName: "Fast" },
              ],
            },
          ],
        },
      ]);
      const { service } = createService();
      await service.getModelCatalog({ mode: "force", refreshProvider: "cursor" });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2.5",
        modelId: "cursor/composer-2.5",
        fastMode: false,
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Use standard Cursor tier.",
      }, { awaitDispatch: true });

      expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(expect.objectContaining({
        modelParams: [{ id: "speed", value: "standard" }],
      }));
      expect(mockState.cursorSdkSendCalls.at(-1)).toEqual(expect.objectContaining({
        modelParams: [{ id: "speed", value: "standard" }],
      }));
    });

    it("explicitly clears Codex service tier when fast mode is off", async () => {
      mockState.codexResponseOverrides.set("thread/start", (payload) => ({
        thread: { id: "thread-default" },
        serviceTier: (payload.params as { serviceTier?: unknown } | undefined)?.serviceTier ?? null,
      }));
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Use standard mode.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect((threadStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBeNull();
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((turnStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBeNull();
      const summary = await service.getSessionSummary(session.id);
      expect(summary?.fastMode).toBe(false);
      expect(summary?.codexServiceTier).toBeNull();
      expect(readPersistedChatState(session.id).codexServiceTier).toBeNull();
    });

    it("preserves fast mode selection on unsupported Codex models while sending standard tier", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-mini",
        fastMode: true,
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Unsupported fast model should run standard.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect((threadStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBeNull();
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((turnStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBeNull();
      expect((await service.getSessionSummary(session.id))?.fastMode).toBe(true);
    });

    it("routes Codex /goal pause and resume commands to app-server goal RPCs", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: "Ship CLI parity",
            status: params.status ?? "active",
            tokenBudget: null,
            tokensUsed: 25,
            timeUsedSeconds: 60,
            createdAt: 1_760_000_000,
            updatedAt: 1_760_000_001,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/goal pause",
      }, { awaitDispatch: true });

      const pauseRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(pauseRequest?.params).toMatchObject({
        threadId: expect.any(String),
        status: "paused",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);

      mockState.codexRequestPayloads = [];
      await service.sendMessage({
        sessionId: session.id,
        text: "/goal resume",
      }, { awaitDispatch: true });
      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        status: "active",
      });
    });

    it("sets typed Codex /goal text and starts a real app-server turn", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: null,
          },
        };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/goal Ship CLI parity",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const goalRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(goalRequest?.params).toMatchObject({
        threadId: expect.any(String),
        objective: "Ship CLI parity",
        status: "active",
      });
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnParams = turnStartRequest?.params as { input?: Array<{ text?: unknown }> } | undefined;
      const turnInputText = turnParams?.input?.map((entry) => String(entry.text ?? "")).join("\n") ?? "";
      expect(turnInputText).toContain("Ship CLI parity");
      expect(turnInputText).not.toContain("/goal");
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.text.includes("/goal")
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "completed"
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "done"
        && event.event.status === "completed"
      )).toBe(false);
    });

    it("seeds create-time ADE goals into the Codex app-server goal before the first turn", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        goal: "Run quality, tests, ship, merge, and release.",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Continue the work.",
      }, { awaitDispatch: true });

      const goalRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "thread/goal/set");
      const turnRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "turn/start");
      expect(goalRequestIndex).toBeGreaterThan(-1);
      expect(turnRequestIndex).toBeGreaterThan(-1);
      expect(goalRequestIndex).toBeLessThan(turnRequestIndex);
      expect(mockState.codexRequestPayloads[goalRequestIndex]?.params).toMatchObject({
        threadId: "thread-1",
        objective: "Run quality, tests, ship, merge, and release.",
        status: "active",
        tokenBudget: null,
      });
      expect((await service.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Run quality, tests, ship, merge, and release.",
        status: "active",
        tokenBudget: null,
      });
    });

    it("awaits and injects the opted-in signed Computer Use MCP client into Codex threads", async () => {
      const signedClient = codexComputerUseClientCandidates(path.join(tmpHomeRoot, ".codex"))[0]!;

      const { service } = createService({
        resolveCodexComputerUseMcp: async () => ({ command: signedClient, args: ["mcp"], enabled: true }),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
      });
      await service.sendMessage({ sessionId: session.id, text: "List visible apps." }, { awaitDispatch: true });

      const threadStart = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      expect(threadStart?.params).toMatchObject({
        config: {
          model_reasoning_effort: "low",
          mcp_servers: {
            computer_use: {
              command: signedClient,
              args: ["mcp"],
              enabled: true,
            },
          },
        },
      });
    });

    it("answers the app-server external clock request with Unix seconds", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
      });
      await service.sendMessage({ sessionId: session.id, text: "Check the time." }, { awaitDispatch: true });

      const before = Math.floor(Date.now() / 1_000);
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "clock-1",
        method: "currentTime/read",
        params: { threadId: "thread-1" },
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "clock-1")).toEqual({
          id: "clock-1",
          result: {
            currentTimeAt: expect.any(Number),
          },
        });
      });
      const response = mockState.codexRequestPayloads.find((payload) => payload.id === "clock-1");
      expect((response?.result as { currentTimeAt?: number })?.currentTimeAt).toBeGreaterThanOrEqual(before);
    });

    it("keeps Computer Use per-app elicitation user-controlled in full-auto sessions", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        permissionMode: "full-auto",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
      });
      await service.sendMessage({ sessionId: session.id, text: "Inspect Calculator." }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cu-approval-1",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "computer_use",
          mode: "form",
          _meta: { persist: ["always"] },
          message: "Allow Codex to use Calculator?",
          requestedSchema: { type: "object", properties: {} },
        },
      });

      const approval = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => event.event.type === "approval_request"
          && event.event.itemId === "mcp-elicitation:computer_use:cu-approval-1",
      );
      expect((approval.event.detail as any)?.request).toMatchObject({
        kind: "approval",
        description: "Allow Codex to use Calculator?",
        providerMetadata: {
          mcpElicitation: true,
          persistenceSupported: true,
        },
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.id === "cu-approval-1")).toBe(false);

      await service.respondToInput({
        sessionId: session.id,
        itemId: approval.event.itemId,
        decision: "accept_for_session",
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cu-approval-1")).toEqual({
        id: "cu-approval-1",
        result: {
          action: "accept",
          content: {},
          _meta: { persist: "always" },
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cu-approval-2",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "computer_use",
          mode: "form",
          meta: { persist: ["always"] },
          message: "Allow Codex to use Preview?",
          requestedSchema: { type: "object", properties: {} },
        },
      });
      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request"
        && event.event.itemId === "mcp-elicitation:computer_use:cu-approval-2");
      await service.respondToInput({
        sessionId: session.id,
        itemId: "mcp-elicitation:computer_use:cu-approval-2",
        decision: "accept",
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cu-approval-2")).toEqual({
        id: "cu-approval-2",
        result: { action: "accept", content: {}, _meta: null },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cu-approval-3",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "computer_use",
          mode: "form",
          message: "Allow Codex to use Notes?",
          requestedSchema: { type: "object", properties: {} },
        },
      });
      await waitForEvent(events, (event): event is AgentChatEventEnvelope =>
        event.event.type === "approval_request"
        && event.event.itemId === "mcp-elicitation:computer_use:cu-approval-3");
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "serverRequest/resolved",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "cu-approval-3",
        },
      });
      const resolved = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "pending_input_resolved" }>;
      } => event.event.type === "pending_input_resolved"
        && event.event.itemId === "mcp-elicitation:computer_use:cu-approval-3");
      expect(resolved.event.resolution).toBe("cancelled");
    });

    it("re-arms a stalled Codex turn when recovery chooses Wait", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({ onEvent: (event: AgentChatEventEnvelope) => events.push(event) });
        const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
        await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

        const result = await service.recoverCodexTurn({
          sessionId: session.id,
          turnId: "turn-1",
          action: "wait",
        });

        expect(result).toEqual({ action: "wait", turnId: "turn-1", status: "waiting" });
        expect(events.some((event) => event.event.type === "system_notice"
          && event.event.message === "Continuing to wait for Codex output.")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt")).toBe(false);

        await vi.advanceTimersByTimeAsync(120_000);
        await vi.waitFor(() => {
          expect(events.some((event) => event.event.type === "codex_turn_stalled"
            && event.event.turnId === "turn-1")).toBe(true);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends a same-turn Codex status nudge from recovery", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

      const result = await service.recoverCodexTurn({ sessionId: session.id, turnId: "turn-1", action: "steer" });

      expect(result.status).toBe("nudged");
      const steerRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/steer");
      expect(steerRequest?.params).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1" });
      expect(JSON.stringify(steerRequest?.params)).toContain("briefly report your current progress");
    });

    it("interrupts and retries a stalled Codex turn on the same thread", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

      const result = await service.recoverCodexTurn({
        sessionId: session.id,
        turnId: "turn-1",
        action: "interrupt_retry_same_thread",
      });

      expect(result.status).toBe("retrying");
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt")).toBe(true);
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "thread/start")).toHaveLength(1);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(false);
    });

    it("finalizes the adopted Codex turn before retrying recovery", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });
      mockState.codexResponseOverrides.set("turn/interrupt", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return params.turnId === "turn-1"
          ? { error: { code: -32000, message: "expected active turn id turn-1 but found turn-real" } }
          : {};
      });

      const result = await service.recoverCodexTurn({
        sessionId: session.id,
        turnId: "turn-1",
        action: "interrupt_retry_same_thread",
      });

      expect(result.status).toBe("retrying");
      const interrupts = mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt");
      expect(interrupts.map((payload) => (payload.params as Record<string, unknown>).turnId)).toEqual([
        "turn-1",
        "turn-real",
      ]);
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
    });

    it("restarts app-server, resumes the Codex thread, and retries stalled work", async () => {
      const { service } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.6-sol" });
      await service.sendMessage({ sessionId: session.id, text: "Keep working." }, { awaitDispatch: true });

      const result = await service.recoverCodexTurn({
        sessionId: session.id,
        turnId: "turn-1",
        action: "restart_resume_thread",
      });

      expect(result.status).toBe("resumed");
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt")).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume"
        && (payload.params as any)?.threadId === "thread-1")).toBe(true);
      expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/start")).toHaveLength(2);
    });

    it("surfaces Codex MCP startup failures without treating them as turn progress", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        mockState.emitCodexPayload({
          method: "mcpServer/startupStatus/updated",
          params: {
            serverName: "local-tools",
            status: "failed",
            message: "http/request failed: error sending request",
          },
        });
        mockState.emitCodexPayload({
          method: "mcpServer/startupStatus/updated",
          params: {
            serverName: "local-tools",
            status: "failed",
            message: "http/request failed: error sending request",
          },
        });

        await Promise.resolve();
        const mcpNotices = events.filter((event) =>
          event.event.type === "system_notice"
          && event.event.message.includes("Codex MCP server 'local-tools' is unavailable")
        );
        expect(mcpNotices).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(120_000);
        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.reason === "no_output"
          )).toBe(true);
        });
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message.includes("has not streamed model or tool output yet")
        )).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the Codex no-output watchdog when an approval request is surfaced", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        mockState.emitCodexPayload({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: "cmd-1",
            turnId: "turn-1",
            command: "npm test",
            cwd: ".",
            reason: "Run tests",
          },
        });

        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "approval_request"
            && event.event.itemId === "cmd-1"
          )).toBe(true);
        });

        await vi.advanceTimersByTimeAsync(120_000);

        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message.includes("has not streamed model or tool output yet")
        )).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reconciles a completed silent Codex turn from app-server state before reporting a stall", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          data: [
            {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 7, outputTokens: 3 },
              items: [
                {
                  id: "msg-1",
                  type: "agentMessage",
                  text: "Recovered assistant output.",
                },
              ],
            },
          ],
          nextCursor: null,
        }));
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "done"
            && event.event.turnId === "turn-1"
            && event.event.status === "completed"
          )).toBe(true);
        });

        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/read")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/turns/list")).toBe(true);
        expect(events.some((event) =>
          event.event.type === "text"
          && event.event.text.includes("Recovered assistant output.")
        )).toBe(true);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not complete a reconciled MCP tool call while app-server still reports it running", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          data: [
            {
              id: "turn-1",
              status: "inProgress",
              items: [
                {
                  id: "mcp-1",
                  type: "mcpToolCall",
                  server: "local-tools",
                  tool: "probe",
                  pluginId: "local-plugin",
                  appContext: {
                    connectorId: "local",
                    appName: "Local tools",
                    actionName: "Probe file",
                    resourceUri: "ui://local/probe",
                  },
                  status: "running",
                  arguments: { path: "README.md" },
                },
              ],
            },
          ],
          nextCursor: null,
        }));
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "tool_call"
            && event.event.itemId === "mcp-1"
            && event.event.mcp?.pluginId === "local-plugin"
            && event.event.mcp?.appContext?.appName === "Local tools"
          )).toBe(true);
        });

        expect(events.some((event) =>
          event.event.type === "tool_result"
          && event.event.itemId === "mcp-1"
        )).toBe(false);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves the Codex imageGeneration lifecycle and local output path", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({ sessionId: session.id, text: "Generate a tiny moon icon." }, { awaitDispatch: true });

      const item = {
        id: "image-1",
        type: "imageGeneration",
        status: "inProgress",
        prompt: "A tiny moon icon",
      };
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: { turnId: "turn-1", item },
      });
      const started = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "codex_image_generation" }> } =>
          event.event.type === "codex_image_generation" && event.event.itemId === "image-1",
      );
      expect(started.event).toMatchObject({
        prompt: "A tiny moon icon",
        status: "running",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            ...item,
            status: "completed",
            revisedPrompt: "A crisp crescent moon icon",
            result: "/tmp/generated-moon.png",
          },
        },
      });
      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "codex_image_generation"
          && event.event.itemId === "image-1"
          && event.event.status === "completed"
          && event.event.savedPath === "/tmp/generated-moon.png"
        )).toBe(true);
      });
    });

    it("preserves live Codex MCP app metadata for Sources aggregation", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
      });
      await service.sendMessage({ sessionId: session.id, text: "Use the docs connector." }, { awaitDispatch: true });

      const item = {
        id: "mcp-live-1",
        type: "mcpToolCall",
        server: "openaiDeveloperDocs",
        tool: "search",
        status: "inProgress",
        arguments: { query: "GPT-5.6" },
        pluginId: "openai-docs",
        appContext: {
          connectorId: "openai-docs",
          linkId: "docs-link",
          resourceUri: "ui://openai-docs/search",
          appName: "OpenAI Docs",
          templateId: "search-results",
          actionName: "Search documentation",
        },
      };
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: { turnId: "turn-1", item },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "tool_call" }> } =>
          event.event.type === "tool_call" && event.event.itemId === "mcp-live-1",
      );

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            ...item,
            status: "completed",
            result: { title: "GPT-5.6", url: "https://developers.openai.com/api/docs/models" },
          },
        },
      });
      const completed = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "tool_result" }> } =>
          event.event.type === "tool_result" && event.event.itemId === "mcp-live-1",
      );

      expect(completed.event).toMatchObject({
        tool: "openaiDeveloperDocs:search",
        status: "completed",
        mcp: {
          server: "openaiDeveloperDocs",
          tool: "search",
          pluginId: "openai-docs",
          resourceUri: "ui://openai-docs/search",
          appContext: {
            connectorId: "openai-docs",
            appName: "OpenAI Docs",
            actionName: "Search documentation",
          },
        },
      });
    });

    it("re-arms the Codex watchdog after partial same-thread recovery", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let turnsListCalls = 0;
        mockState.codexResponseOverrides.set("thread/turns/list", () => {
          turnsListCalls += 1;
          return {
            data: [
              {
                id: "turn-1",
                status: "inProgress",
                items: [
                  {
                    id: "reasoning-1",
                    type: "reasoning",
                    summary: ["Recovered partial reasoning."],
                  },
                ],
              },
            ],
            nextCursor: null,
          };
        });
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "reasoning"
            && event.event.text.includes("Recovered partial reasoning.")
          )).toBe(true);
        });
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);

        await vi.advanceTimersByTimeAsync(120_000);
        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.event.type === "codex_turn_stalled"
            && event.event.reason === "no_output"
          )).toBe(true);
        });
        expect(events.filter((event) =>
          event.event.type === "reasoning"
          && event.event.text.includes("Recovered partial reasoning.")
        )).toHaveLength(1);
        expect(turnsListCalls).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not double-finalize when a normal Codex completion wins the silent-turn reconciliation race", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.delayedCodexMethods.add("thread/turns/list");
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          data: [
            {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 7, outputTokens: 3 },
              items: [
                {
                  id: "msg-after-complete",
                  type: "agentMessage",
                  text: "Recovered after the normal completion.",
                },
              ],
            },
          ],
          nextCursor: null,
        }));
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await vi.waitFor(() => {
          expect(mockState.pendingCodexResponses).toHaveLength(1);
        });

        mockState.emitCodexPayload({
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 11, outputTokens: 5 },
            },
          },
        });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.turnId === "turn-1"
            && event.event.status === "completed",
        );

        mockState.flushCodexResponses();
        await Promise.resolve();

        const doneEvents = events.filter((event) =>
          event.event.type === "done"
          && event.event.turnId === "turn-1"
          && event.event.status === "completed"
        );
        expect(doneEvents).toHaveLength(1);
        expect(events.some((event) =>
          event.event.type === "text"
          && event.event.text.includes("Recovered after the normal completion.")
        )).toBe(false);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not emit a stale stall when a normal Codex completion wins after turns-list fails", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        mockState.delayedCodexMethods.add("thread/turns/list");
        mockState.codexResponseOverrides.set("thread/turns/list", () => ({
          error: { code: -32000, message: "thread state unavailable" },
        }));
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await vi.waitFor(() => {
          expect(mockState.pendingCodexResponses).toHaveLength(1);
        });

        mockState.emitCodexPayload({
          method: "turn/completed",
          params: {
            turn: {
              id: "turn-1",
              status: "completed",
              usage: { inputTokens: 11, outputTokens: 5 },
            },
          },
        });
        await waitForEvent(
          events,
          (event): event is AgentChatEventEnvelope =>
            event.event.type === "done"
            && event.event.turnId === "turn-1"
            && event.event.status === "completed",
        );

        mockState.flushCodexResponses();
        await Promise.resolve();

        expect(events.filter((event) =>
          event.event.type === "done"
          && event.event.turnId === "turn-1"
          && event.event.status === "completed"
        )).toHaveLength(1);
        expect(events.some((event) => event.event.type === "codex_turn_stalled")).toBe(false);
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && (
            event.event.message.includes("has not streamed model or tool output yet")
            || event.event.message.includes("could not confirm its app-server state")
          )
        )).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("routes structured Codex stall notices to an orchestration parent without auto-handoff", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const parent = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          orchestrationRole: "lead",
        });
        const child = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          orchestrationRole: "worker",
          orchestrationParentSessionId: parent.id,
        });

        await service.sendMessage({
          sessionId: child.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        await vi.advanceTimersByTimeAsync(120_000);
        await vi.waitFor(() => {
          expect(events.some((event) =>
            event.sessionId === parent.id
            && event.event.type === "codex_turn_stalled"
            && event.event.sourceSessionId === child.id
          )).toBe(true);
        });

        expect(events.some((event) =>
          event.sessionId === child.id
          && event.event.type === "codex_turn_stalled"
          && event.event.reason === "no_output"
        )).toBe(true);
        expect(events.some((event) =>
          event.sessionId === parent.id
          && event.event.type === "system_notice"
          && event.event.message.includes("Child Codex session")
        )).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "turn/interrupt")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the Codex no-output watchdog when useful turn events arrive", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        await service.sendMessage({
          sessionId: session.id,
          text: "Keep working.",
        }, { awaitDispatch: true });

        mockState.emitCodexPayload({
          method: "item/started",
          params: {
            turnId: "turn-1",
            item: { id: "item-1", type: "agentMessage" },
          },
        });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(120_000);

        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message.includes("has not streamed model or tool output yet")
        )).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("exposes typed Codex goal controls with unlimited budgets and persisted summaries", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective ?? "Ship CLI parity",
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
            tokensUsed: 42,
            timeUsedSeconds: 12,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const goal = await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });

      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        threadId: "thread-1",
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect(goal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
        tokensUsed: 42,
      });
      expect((await service.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });
      expect(readPersistedChatState(session.id).codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });

      mockState.codexRequestPayloads = [];
      await service.setCodexGoalStatus({
        sessionId: session.id,
        status: "paused",
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        status: "paused",
        tokenBudget: null,
      });

      mockState.codexRequestPayloads = [];
      await service.clearCodexGoal({ sessionId: session.id });
      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/clear")?.params).toMatchObject({
        threadId: "thread-1",
      });
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("does not emit a visible Codex goal-clear event when no goal was known", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start a normal turn.",
      }, { awaitDispatch: true });
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/cleared",
        params: { threadId: "thread-1" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.some((event) => event.event.type === "codex_goal_cleared")).toBe(false);
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("emits a Codex goal-clear event when a known goal is cleared by app-server", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/cleared",
        params: { threadId: "thread-1" },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "codex_goal_cleared",
      );
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("deduplicates repeated Codex goal updates while retaining latest usage state", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working.",
      }, { awaitDispatch: true });
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "active",
            tokenBudget: null,
            tokensUsed: 25,
            updatedAt: 1_760_000_001,
          },
        },
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "codex_goal_updated"
          && event.event.goal?.objective === "Ship CLI parity",
      );
      events.length = 0;

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "active",
            tokenBudget: null,
            tokensUsed: 50,
            timeUsedSeconds: 12,
            updatedAt: 1_760_000_002,
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.some((event) => event.event.type === "codex_goal_updated")).toBe(false);
      expect((await service.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
        tokensUsed: 50,
        timeUsedSeconds: 12,
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "paused",
            tokenBudget: null,
            tokensUsed: 51,
            updatedAt: 1_760_000_003,
          },
        },
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "codex_goal_updated"
          && event.event.goal?.status === "paused",
      );
    });

    it("refreshes a missing Codex goal without emitting a misleading goal-update chip", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: "active",
            tokenBudget: null,
          },
        };
      });
      mockState.codexResponseOverrides.set("thread/goal/get", () => ({
        goal: null,
      }));
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      events.length = 0;

      await expect(service.getCodexGoal({ sessionId: session.id })).resolves.toBeNull();

      expect(events.some((event) => event.event.type === "codex_goal_updated")).toBe(false);
      expect(events.some((event) => event.event.type === "codex_goal_cleared")).toBe(false);
      expect((await service.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("clears persisted Codex goals after restart by resuming the thread first", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      expect(readPersistedChatState(session.id)).toMatchObject({
        threadId: "thread-1",
        codexGoal: {
          objective: "Ship CLI parity",
          status: "active",
          tokenBudget: null,
        },
      });

      mockState.codexRequestPayloads = [];
      const resumed = createService().service;
      await resumed.clearCodexGoal({ sessionId: session.id });

      const resumeRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "thread/resume");
      const clearRequestIndex = mockState.codexRequestPayloads.findIndex((payload) => payload.method === "thread/goal/clear");
      expect(resumeRequestIndex).toBeGreaterThanOrEqual(0);
      expect(clearRequestIndex).toBeGreaterThan(resumeRequestIndex);
      expect(mockState.codexRequestPayloads[resumeRequestIndex]?.params).toMatchObject({
        threadId: "thread-1",
        excludeTurns: true,
      });
      expect(mockState.codexRequestPayloads[clearRequestIndex]?.params).toMatchObject({
        threadId: "thread-1",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(false);
      expect((await resumed.getSessionSummary(session.id))?.codexGoal).toBeNull();
    });

    it("does not rotate to a fresh Codex thread when a goal-only resume fails", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: params.tokenBudget,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.setCodexGoal({
        sessionId: session.id,
        objective: "Ship CLI parity",
      });
      expect(readPersistedChatState(session.id).threadId).toBe("thread-1");

      mockState.codexRequestPayloads = [];
      mockState.codexResponseOverrides.set("thread/resume", {
        error: { code: -32000, message: "resume unavailable" },
      });
      const resumed = createService().service;

      await expect(resumed.setCodexGoal({
        sessionId: session.id,
        objective: "Keep shipping",
      })).rejects.toThrow("Could not resume this Codex thread for goal controls");

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(false);
      expect(readPersistedChatState(session.id).threadId).toBe("thread-1");
      expect((await resumed.getSessionSummary(session.id))?.codexGoal).toMatchObject({
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });
    });

    it("rejects Codex goals over the app-server objective limit", async () => {
      const tooLongGoal = "x".repeat(4_001);
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await expect(service.setCodexGoal({
        sessionId: session.id,
        objective: tooLongGoal,
      })).rejects.toThrow("Goal is too long. Keep it under 4,000 characters.");
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);

      await service.sendMessage({
        sessionId: session.id,
        text: `/goal ${tooLongGoal}`,
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Goal is too long. Keep it under 4,000 characters."
      )).toBe(true);
    });

    it("asks before replacing an existing typed Codex goal", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: null,
          },
        };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/goal set Existing goal",
      }, { awaitDispatch: true });
      mockState.codexRequestPayloads = [];

      await service.sendMessage({
        sessionId: session.id,
        text: "/goal Replacement goal",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } => {
          const detail = event.event.type === "approval_request"
            ? (event.event.detail as { request?: PendingInputRequest } | undefined)
            : undefined;
          return event.event.type === "approval_request"
            && detail?.request?.providerMetadata?.kind === "codex_goal_replace";
        },
      );
      const request = (approvalEvent.event.detail as { request?: PendingInputRequest } | undefined)?.request;
      expect(request?.questions[0]?.options?.map((option) => option.value)).toEqual(["update_goal", "clear_goal"]);

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
        answers: {
          goal_action: "update_goal",
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) =>
          payload.method === "thread/goal/set"
          && (payload.params as { objective?: unknown } | undefined)?.objective === "Replacement goal"
        )).toBe(true);
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
    });

    it("automatically removes incoming Codex goal token limits and resumes limited goals", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective ?? "Ship CLI parity",
            status: params.status ?? "active",
            tokenBudget: Object.prototype.hasOwnProperty.call(params, "tokenBudget") ? params.tokenBudget : 5000,
            tokensUsed: 125,
            timeUsedSeconds: 90,
            createdAt: 1_760_000_000,
            updatedAt: 1_760_000_010,
          },
        };
      });

      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.codexRequestPayloads = [];

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "thread/goal/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          goal: {
            objective: "Ship CLI parity",
            status: "budgetLimited",
            tokenBudget: 5000,
            tokensUsed: 125,
            timeUsedSeconds: 90,
            createdAt: 1_760_000_000,
            updatedAt: 1_760_000_001,
          },
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
      });
      const clearRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(clearRequest?.params).toMatchObject({
        threadId: "thread-1",
        objective: "Ship CLI parity",
        status: "active",
        tokenBudget: null,
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message === "Goal limit removed. ADE keeps goals unlimited."
        )).toBe(true);
      });
      expect(events.some((event) =>
        event.event.type === "codex_goal_updated"
        && event.event.goal?.status === "budget_limited"
      )).toBe(false);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "codex_goal_updated",
            goal: expect.objectContaining({
              status: "active",
              tokenBudget: null,
              timeUsedSeconds: 90,
            }),
          }),
        }),
      ]));
    });

    it("backs off automatic Codex goal budget clearing after app-server failures", async () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      mockState.delayedCodexMethods.add("thread/goal/set");

      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start working.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );
      mockState.codexRequestPayloads = [];

      const emitBudgetLimitedGoal = () => {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "thread/goal/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            goal: {
              objective: "Ship CLI parity",
              status: "budgetLimited",
              tokenBudget: 5000,
              tokensUsed: 125,
              timeUsedSeconds: 90,
              createdAt: 1_760_000_000,
              updatedAt: 1_760_000_001,
            },
          },
        });
      };

      emitBudgetLimitedGoal();
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.filter((payload) => payload.method === "thread/goal/set")).toHaveLength(1);
      });

      const clearRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: clearRequest?.id,
        error: { code: -32001, message: "goal RPC failed" },
      });
      mockState.pendingCodexResponses = [];

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message === "Goal update failed: goal RPC failed"
        )).toBe(true);
      });

      mockState.codexRequestPayloads = [];
      emitBudgetLimitedGoal();
      await Promise.resolve();
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(false);

      nowSpy.mockReturnValue(1_031_000);
      emitBudgetLimitedGoal();
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
      });
      const retryRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: retryRequest?.id,
        result: {
          goal: {
            objective: "Ship CLI parity",
            status: "active",
            tokenBudget: null,
          },
        },
      });
      mockState.pendingCodexResponses = [];
    });

    it("treats /goal set reserved words as objective text", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/goal set clear",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        threadId: expect.any(String),
        objective: "clear",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/clear")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
    });

    it("reports Codex /goal slash command failures without completing a fake slash turn", async () => {
      mockState.delayedCodexMethods.add("thread/goal/set");
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "/goal status paused",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
      });
      const goalRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set");
      expect(goalRequest?.id).toBeTruthy();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: goalRequest?.id,
        error: { code: -32001, message: "goal RPC failed" },
      });
      await sendPromise;

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Goal update failed: goal RPC failed"
      )).toBe(true);
      expect(events.some((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "completed"
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "done"
        && event.event.status === "completed"
      )).toBe(false);
    });

    it("reports Codex /goal slash timeouts without tearing down the runtime", async () => {
      mockState.delayedCodexMethods.add("thread/goal/set");
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => {
            events.push(event);
          },
        });
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
        });

        const sendPromise = service.sendMessage({
          sessionId: session.id,
          text: "/goal status paused",
        }, { awaitDispatch: true });

        await vi.waitFor(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/goal/set")).toBe(true);
        });
        await vi.advanceTimersByTimeAsync(10_050);
        await sendPromise;

        expect(events.some((event) =>
          event.event.type === "system_notice"
          && event.event.message.includes("timed out")
        )).toBe(true);

        mockState.delayedCodexMethods.clear();
        mockState.codexRequestPayloads = [];
        await service.sendMessage({
          sessionId: session.id,
          text: "Continue after the slash timeout.",
        }, { awaitDispatch: true });
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(false);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("routes Codex goal edits through goal RPC while a turn is active instead of turn steer", async () => {
      mockState.codexResponseOverrides.set("thread/goal/set", (payload) => {
        const params = payload.params as Record<string, unknown>;
        return {
          goal: {
            objective: params.objective,
            status: params.status ?? "active",
            tokenBudget: null,
          },
        };
      });
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start a long-running turn.",
      }, { awaitDispatch: true });

      mockState.codexRequestPayloads = [];
      await service.steer({
        sessionId: session.id,
        text: "/goal set Updated from UI",
      });

      expect(mockState.codexRequestPayloads.find((payload) => payload.method === "thread/goal/set")?.params).toMatchObject({
        objective: "Updated from UI",
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/steer")).toBe(false);
    });

    it("routes Codex /inject to thread/inject_items and emits a notice", async () => {
      mockState.codexResponseOverrides.set("thread/inject_items", () => ({}));
      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/inject Remember this for the rest of the thread.\nSecond line here.",
      }, { awaitDispatch: true });

      const injectRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/inject_items");
      // ThreadInjectItemsParams.items takes raw Responses API items
      // (ResponseItem::Message), not a synthetic { type: "user_message" } shape.
      expect(injectRequest?.params).toMatchObject({
        threadId: expect.any(String),
        items: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Remember this for the rest of the thread.\nSecond line here." },
            ],
          },
        ],
      });
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      const injectedNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice" && typeof env.event.message === "string" && env.event.message.startsWith("[injected]"));
      const completionNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice" && env.event.message === "Context injected into Codex thread history.");
      expect(injectedNotice?.event.message).toContain("Remember this for the rest of the thread.");
      expect(injectedNotice?.event.turnId).toBe(completionNotice?.event.turnId);
    });

    it("completes Codex /inject when the app-server RPC fails", async () => {
      mockState.delayedCodexMethods.add("thread/inject_items");
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => {
          events.push(event);
        },
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "/inject Save this context.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/inject_items")).toBe(true);
      });
      const injectRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/inject_items");
      expect(injectRequest?.id).toBeTruthy();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: injectRequest?.id,
        error: { code: -32001, message: "inject RPC failed" },
      });
      await sendPromise;

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
      expect(events.some((event) =>
        event.event.type === "system_notice"
        && event.event.message === "Codex context injection failed: inject RPC failed"
      )).toBe(true);
      expect(events.some((event) =>
        event.event.type === "status"
        && event.event.turnStatus === "completed"
      )).toBe(true);
      expect(events.some((event) =>
        event.event.type === "done"
        && event.event.status === "completed"
      )).toBe(true);
    });

    it("rejects /inject without context body", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/inject   ",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/inject_items")).toBe(false);
      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(false);
    });

    it("does not classify compaction items as manual before /compact is accepted", async () => {
      mockState.delayedCodexMethods.add("thread/compact/start");
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "/compact",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/compact/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            id: "compact-before-ack",
            type: "contextCompaction",
          },
        },
      });

      const compactionEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "context_compact" }>;
        } =>
          event.event.type === "context_compact"
          && event.event.state === "started",
      );
      expect(compactionEvent.event.trigger).toBe("auto");

      mockState.flushCodexResponses();
      await sendPromise;
    });

    it("routes /review with no args to review/start with target type=uncommittedChanges", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review",
      }, { awaitDispatch: true });

      // ReviewTarget union (codex v2 protocol): uncommittedChanges | baseBranch | commit | custom.
      const reviewRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "review/start");
      expect(reviewRequest?.params).toMatchObject({
        threadId: expect.any(String),
        target: { type: "uncommittedChanges" },
      });
    });

    it("routes /review branch <name> to review/start with target type=baseBranch", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review branch feature/foo",
      }, { awaitDispatch: true });

      const reviewRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "review/start");
      expect(reviewRequest?.params).toMatchObject({
        target: { type: "baseBranch", branch: "feature/foo" },
      });
    });

    it("routes /review prompt <text> to review/start with target type=custom", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review prompt audit the auth middleware",
      }, { awaitDispatch: true });

      const reviewRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "review/start");
      expect(reviewRequest?.params).toMatchObject({
        target: { type: "custom", instructions: "audit the auth middleware" },
      });
    });

    it("rejects /review branch with no name and does not call review/start", async () => {
      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review branch   ",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "review/start")).toBe(false);
      const usageNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice"
          && typeof env.event.message === "string"
          && env.event.message.includes("/review branch"));
      expect(usageNotice).toBeDefined();
    });

    it("rejects /review prompt with no text and does not call review/start", async () => {
      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review prompt   ",
      }, { awaitDispatch: true });

      expect(mockState.codexRequestPayloads.some((payload) => payload.method === "review/start")).toBe(false);
      const usageNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice"
          && typeof env.event.message === "string"
          && env.event.message.includes("/review prompt"));
      expect(usageNotice).toBeDefined();
    });

    it("routes /review diff to target.uncommittedChanges", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "/review diff",
      }, { awaitDispatch: true });

      const reviewRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "review/start");
      expect(reviewRequest?.params).toMatchObject({
        target: { type: "uncommittedChanges" },
      });
    });

    it("surfaces Codex deprecation/warning/guardian/config notifications as system_notice rows", async () => {
      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Kick off codex.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "deprecationNotice",
        params: { message: "old feature gone" },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "warning",
        params: { message: "watch out" },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "guardianWarning",
        params: { message: "sandbox tripped" },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "configWarning",
        params: { message: "config layer stale" },
      });

      await vi.waitFor(() => {
        const notices = onEvent.mock.calls
          .map((call) => call[0])
          .filter((env: any) => env?.event?.type === "system_notice");
        const messages = notices.map((env: any) => env.event.message);
        expect(messages).toEqual(expect.arrayContaining([
          "⚠ deprecated: old feature gone",
          "⚠ watch out",
          "🛡 guardian: sandbox tripped",
          "⚙ config: config layer stale",
        ]));
      });

      const guardianNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice" && env.event.message.startsWith("🛡 guardian:"));
      expect(guardianNotice?.event.noticeKind).toBe("error");

      const deprecationNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice" && env.event.message.startsWith("⚠ deprecated:"));
      expect(deprecationNotice?.event.noticeKind).toBe("warning");

      const configNotice = onEvent.mock.calls
        .map((call) => call[0])
        .find((env: any) => env?.event?.type === "system_notice" && env.event.message.startsWith("⚙ config:"));
      expect(configNotice?.event.noticeKind).toBe("config");
    });

    it("populates optOutNotificationMethods in initialize when runtimeMode is 'print'", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "print",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Hello.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "initialize")).toBe(true);
      });

      const initializeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "initialize");
      const capabilities = (initializeRequest?.params as { capabilities?: { optOutNotificationMethods?: string[] } })
        ?.capabilities;
      const expectedOptOut = [
        "item/agentMessage/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
        "item/commandExecution/outputDelta",
      ];
      expect(capabilities?.optOutNotificationMethods).toEqual(expect.arrayContaining(expectedOptOut));
      expect(capabilities?.optOutNotificationMethods).toHaveLength(expectedOptOut.length);
    });

    it("sends an empty optOutNotificationMethods list when runtimeMode is undefined (default interactive)", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Hello.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "initialize")).toBe(true);
      });

      const initializeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "initialize");
      const capabilities = (initializeRequest?.params as { capabilities?: { optOutNotificationMethods?: string[] } })
        ?.capabilities;
      expect(capabilities?.optOutNotificationMethods).toEqual([]);
    });

    it("compacts large Codex command output before storing chat history", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run a noisy command.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const output = `head-marker\n${"x".repeat(96 * 1024)}\ntail-marker`;
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "cmd-large-output",
            type: "commandExecution",
            command: "npm test",
            cwd: tmpRoot,
            status: "completed",
            aggregatedOutput: output,
            exitCode: 0,
            durationMs: 1234,
          },
        },
      });

      const commandEvent = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "command" }>;
      } => event.event.type === "command" && event.event.itemId === "cmd-large-output");

      expect(commandEvent.event.output).toBe(output);
      expect(commandEvent.event.outputOriginalBytes).toBeUndefined();
      expect(commandEvent.event.outputOmittedBytes).toBeUndefined();

      const historyEvent = service.getChatEventHistory(session.id).events.find((event) =>
        event.event.type === "command" && event.event.itemId === "cmd-large-output"
      );
      expect(historyEvent?.event.type).toBe("command");
      if (historyEvent?.event.type !== "command") throw new Error("Expected command history event");
      expect(historyEvent.event.output).toContain("Large command output was shortened");
      expect(historyEvent.event.output).toContain("head-marker");
      expect(historyEvent.event.output).toContain("tail-marker");
      expect(historyEvent.event.output).not.toContain("x".repeat(80 * 1024));
      expect(historyEvent.event.outputOriginalBytes).toBe(Buffer.byteLength(output, "utf8"));
      expect(historyEvent.event.outputOmittedBytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(historyEvent.event.output, "utf8")).toBeLessThan(20 * 1024);
    });

    it("bounds stored Codex command output while streaming deltas", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run a streaming noisy command.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const chunks = [
        `stream-head\n${"a".repeat(2048)}`,
        `${"b".repeat(2048)}\nstream-tail`,
        `${"z".repeat(4096)}\nafter-close-1`,
        `${"z".repeat(4096)}\nafter-close-2`,
      ];
      for (const chunk of chunks) {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "item/commandExecution/outputDelta",
          params: {
            turnId: "turn-1",
            itemId: "cmd-stream-output",
            delta: chunk,
          },
        });
      }

      await vi.waitFor(() => {
        expect(events.filter((event) =>
          event.event.type === "command" && event.event.itemId === "cmd-stream-output"
        )).toHaveLength(4);
      });

      const commandEvents = events.filter((event) =>
        event.event.type === "command" && event.event.itemId === "cmd-stream-output"
      );
      expect(commandEvents.map((event) =>
        event.event.type === "command" ? event.event.output : "",
      )).toEqual(chunks);

      const storedCommandEvents = service.getChatEventHistory(session.id).events.filter((event) =>
        event.event.type === "command" && event.event.itemId === "cmd-stream-output"
      );
      expect(storedCommandEvents).toHaveLength(2);
      const compactedEvent = storedCommandEvents.at(-1);
      expect(compactedEvent?.event.type).toBe("command");
      if (compactedEvent?.event.type !== "command") throw new Error("Expected compacted command event");
      expect(compactedEvent.event.output).toContain("Large command output was shortened");
      expect(compactedEvent.event.output).toContain("stream-head");
      expect(compactedEvent.event.output).toContain("stream-tail");
      expect(compactedEvent.event.output).not.toContain("after-close");
      expect(compactedEvent.event.outputOriginalBytes).toBe(Buffer.byteLength(`${chunks[0]}${chunks[1]}`, "utf8"));
      expect(compactedEvent.event.outputOmittedBytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(storedCommandEvents.map((event) =>
        event.event.type === "command" ? event.event.output : "",
      ).join(""), "utf8")).toBeLessThan(12 * 1024);
      expect(storedCommandEvents.some((event) =>
        event.event.type === "command" && event.event.output.includes("after-close")
      )).toBe(false);
    });

    it("omits oversized inline Codex image data from history without changing live previews", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });
      await service.sendMessage({
        sessionId: session.id,
        text: "Generate two icons.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const smallData = "data:image/png;base64,AAAA";
      const largeData = `data:image/png;base64,${"B".repeat(80 * 1024)}`;
      for (const [id, result] of [["image-small", smallData], ["image-large", largeData]] as const) {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            turnId: "turn-1",
            item: {
              id,
              type: "imageGeneration",
              prompt: "A tiny icon",
              status: "completed",
              result,
            },
          },
        });
      }
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "image-view-large",
            type: "imageView",
            title: "Inline preview",
            status: "completed",
            url: largeData,
          },
        },
      });

      const liveLarge = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "codex_image_generation" }> } =>
          event.event.type === "codex_image_generation" && event.event.itemId === "image-large",
      );
      expect(liveLarge.event.result).toBe(largeData);
      expect(liveLarge.event.resultOriginalBytes).toBeUndefined();

      const history = service.getChatEventHistory(session.id).events;
      const storedSmall = history.find((event) =>
        event.event.type === "codex_image_generation" && event.event.itemId === "image-small"
      );
      expect(storedSmall?.event.type).toBe("codex_image_generation");
      if (storedSmall?.event.type !== "codex_image_generation") throw new Error("Expected small stored image");
      expect(storedSmall.event.result).toBe(smallData);
      expect(storedSmall.event.resultOmittedBytes).toBeUndefined();

      const storedLarge = history.find((event) =>
        event.event.type === "codex_image_generation" && event.event.itemId === "image-large"
      );
      expect(storedLarge?.event.type).toBe("codex_image_generation");
      if (storedLarge?.event.type !== "codex_image_generation") throw new Error("Expected large stored image");
      expect(storedLarge.event.result).toBeNull();
      expect(storedLarge.event.resultOriginalBytes).toBe(Buffer.byteLength(largeData, "utf8"));
      expect(storedLarge.event.resultOmittedBytes).toBe(Buffer.byteLength(largeData, "utf8"));
      expect(JSON.stringify(storedLarge.event)).not.toContain("B".repeat(1024));

      const storedView = history.find((event) =>
        event.event.type === "codex_image_view" && event.event.itemId === "image-view-large"
      );
      expect(storedView?.event.type).toBe("codex_image_view");
      if (storedView?.event.type !== "codex_image_view") throw new Error("Expected stored image view");
      expect(storedView.event.url).toBeNull();
      expect(storedView.event.urlOriginalBytes).toBe(Buffer.byteLength(largeData, "utf8"));
      expect(storedView.event.urlOmittedBytes).toBe(Buffer.byteLength(largeData, "utf8"));
    });

    it("compacts large tool result and file diff payloads before storing chat history", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Run tools.",
      }, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
        } =>
          event.event.type === "status"
          && event.event.turnStatus === "started"
          && event.event.turnId === "turn-1",
      );

      const toolResult = {
        stdout: `tool-head\n${"a".repeat(80 * 1024)}\ntool-tail`,
        metadata: { useful: true },
      };
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "tool-large-result",
            type: "toolCall",
            tool: "largeTool",
            status: "completed",
            result: toolResult,
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "tool-empty-result",
            type: "toolCall",
            tool: "emptyTool",
            status: "completed",
          },
        },
      });

      const diff = `diff --git a/file.ts b/file.ts\n${"+".repeat(1)}diff-head\n${"+x\n".repeat(40 * 1024)}+diff-tail\n`;
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            id: "file-large-diff",
            type: "fileChange",
            status: "completed",
            changes: [{ path: "src/file.ts", kind: "modify", diff }],
          },
        },
      });

      const toolEvent = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "tool_result" }>;
      } => event.event.type === "tool_result" && event.event.itemId === "tool-large-result");
      expect(toolEvent.event.result).toStrictEqual(toolResult);
      expect(toolEvent.event.resultOriginalBytes).toBeUndefined();
      expect(toolEvent.event.resultOmittedBytes).toBeUndefined();

      const emptyToolEvent = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "tool_result" }>;
      } => event.event.type === "tool_result" && event.event.itemId === "tool-empty-result");
      expect(emptyToolEvent.event.result).toBeUndefined();
      expect(emptyToolEvent.event.resultOmittedBytes).toBeUndefined();

      const fileEvent = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "file_change" }>;
      } => event.event.type === "file_change" && event.event.itemId === "file-large-diff");
      expect(fileEvent.event.diff).toBe(diff);
      expect(fileEvent.event.diffOriginalBytes).toBeUndefined();
      expect(fileEvent.event.diffOmittedBytes).toBeUndefined();

      const history = service.getChatEventHistory(session.id).events;
      const storedToolEvent = history.find((event) =>
        event.event.type === "tool_result" && event.event.itemId === "tool-large-result"
      );
      expect(storedToolEvent?.event.type).toBe("tool_result");
      if (storedToolEvent?.event.type !== "tool_result") throw new Error("Expected stored tool event");
      expect(storedToolEvent.event.resultOriginalBytes).toBeGreaterThan(80 * 1024);
      expect(storedToolEvent.event.resultOmittedBytes).toBeGreaterThan(0);
      expect(storedToolEvent.event.result).toMatchObject({
        summary: expect.stringContaining("Large tool result was shortened"),
        preview: expect.stringContaining("tool-tail"),
      });
      expect(JSON.stringify(storedToolEvent.event.result)).not.toContain("a".repeat(64 * 1024));

      const storedFileEvent = history.find((event) =>
        event.event.type === "file_change" && event.event.itemId === "file-large-diff"
      );
      expect(storedFileEvent?.event.type).toBe("file_change");
      if (storedFileEvent?.event.type !== "file_change") throw new Error("Expected stored file event");
      expect(storedFileEvent.event.diff).toContain("Large file diff was shortened");
      expect(storedFileEvent.event.diff).toContain("diff-head");
      expect(storedFileEvent.event.diff).toContain("diff-tail");
      expect(storedFileEvent.event.diffOriginalBytes).toBe(Buffer.byteLength(diff, "utf8"));
      expect(storedFileEvent.event.diffOmittedBytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(storedFileEvent.event.diff, "utf8")).toBeLessThan(36 * 1024);
    });

    it("ignores deprecation/warning notifications with missing or empty message", async () => {
      const onEvent = vi.fn();
      const { service } = createService({ onEvent });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Kick off codex.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      const beforeNoticeCount = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "system_notice").length;

      // Missing payload entirely.
      mockState.emitCodexPayload({ jsonrpc: "2.0", method: "deprecationNotice" });
      // Empty params.
      mockState.emitCodexPayload({ jsonrpc: "2.0", method: "warning", params: {} });
      // Wrong field name (handler should silently no-op).
      mockState.emitCodexPayload({ jsonrpc: "2.0", method: "configWarning", params: { note: "ignored" } });
      // Whitespace-only.
      mockState.emitCodexPayload({ jsonrpc: "2.0", method: "guardianWarning", params: { message: "   " } });

      // Settle: emit a real notice so vi.waitFor has something to wait on.
      mockState.emitCodexPayload({ jsonrpc: "2.0", method: "warning", params: { message: "real one" } });
      await vi.waitFor(() => {
        const messages = onEvent.mock.calls
          .map((call) => call[0])
          .filter((env: any) => env?.event?.type === "system_notice")
          .map((env: any) => env.event.message);
        expect(messages).toContain("⚠ real one");
      });

      const afterMessages = onEvent.mock.calls
        .map((call) => call[0])
        .filter((env: any) => env?.event?.type === "system_notice")
        .map((env: any) => env.event.message);
      // Only the real notice should have been added beyond the baseline.
      expect(afterMessages.length).toBe(beforeNoticeCount + 1);
    });

    it("clears fast mode when switching a session away from Codex", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        fastMode: true,
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-sonnet-5",
      });

      expect(updated.provider).toBe("claude");
      expect(updated.fastMode).toBeUndefined();
      expect((await service.getSessionSummary(session.id))?.fastMode).toBe(false);
      expect(readPersistedChatState(session.id).fastMode).toBeUndefined();
    });

    it("re-resumes Codex threads when fast mode changes mid-session", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Initial standard turn.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: `turn-${mockState.codexTurnCounter}`,
            status: "completed",
          },
        },
      });
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });

      mockState.codexRequestPayloads = [];
      const updated = await service.updateSession({
        sessionId: session.id,
        fastMode: true,
      });
      expect(updated.fastMode).toBe(true);

      await service.sendMessage({
        sessionId: session.id,
        text: "Next turn should re-resume fast.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const resumeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/resume");
      expect((resumeRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((turnStartRequest?.params as { serviceTier?: unknown } | undefined)?.serviceTier).toBe("fast");
    });

    it("preserves Codex edit sessions as untrusted workspace-write", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      });

      expect(session.permissionMode).toBe("edit");
      expect(session.codexApprovalPolicy).toBe("untrusted");
      expect(session.codexSandbox).toBe("workspace-write");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).toBe("edit");
    });

    it("starts Codex full-auto sessions with danger-full-access and never approval", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        if (mode === "config-toml") {
          return null;
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo and then edit files if needed.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const params = threadStartRequest?.params as {
        approvalPolicy?: unknown;
        sandbox?: unknown;
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
        effort?: unknown;
        config?: { model_reasoning_effort?: unknown };
      } | undefined;
      expect(params?.approvalPolicy).toBe("never");
      expect(params?.sandbox).toBe("danger-full-access");
      expect(params?.config?.model_reasoning_effort).toBe("medium");
      expect(params?.effort).toBeUndefined();
      expect(params?.reasoningEffort).toBeUndefined();
      expect(params?.reasoning_effort).toBeUndefined();

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
        effort?: unknown;
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("never");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("dangerFullAccess");
      expect(turnStartParams?.effort).toBe("medium");
      expect(turnStartParams?.reasoningEffort).toBeUndefined();
      expect(turnStartParams?.reasoning_effort).toBeUndefined();
    });

    it("serializes every Codex permission mode to the app-server wire shapes", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") return { approvalPolicy: "never", sandbox: "danger-full-access" };
        if (mode === "edit") return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        if (mode === "default") return { approvalPolicy: "on-request", sandbox: "workspace-write" };
        if (mode === "config-toml") return null;
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const cases = [
        {
          mode: "plan" as const,
          approvalPolicy: "on-request",
          lifecycleSandbox: "read-only",
          turnSandboxType: "readOnly",
        },
        {
          mode: "default" as const,
          approvalPolicy: "on-request",
          lifecycleSandbox: "workspace-write",
          turnSandboxType: "workspaceWrite",
        },
        {
          mode: "edit" as const,
          approvalPolicy: "untrusted",
          lifecycleSandbox: "workspace-write",
          turnSandboxType: "workspaceWrite",
        },
        {
          mode: "full-auto" as const,
          approvalPolicy: "never",
          lifecycleSandbox: "danger-full-access",
          turnSandboxType: "dangerFullAccess",
        },
        {
          mode: "config-toml" as const,
          approvalPolicy: undefined,
          lifecycleSandbox: undefined,
          turnSandboxType: undefined,
        },
      ];

      for (const scenario of cases) {
        mockState.codexRequestPayloads = [];
        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.5",
          permissionMode: scenario.mode,
        });

        await service.sendMessage({
          sessionId: session.id,
          text: `Probe ${scenario.mode} permissions.`,
        });

        await vi.waitFor(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
        });

        const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
        const threadParams = threadStartRequest?.params as {
          approvalPolicy?: unknown;
          sandbox?: unknown;
        } | undefined;
        expect(threadParams?.approvalPolicy).toBe(scenario.approvalPolicy);
        expect(threadParams?.sandbox).toBe(scenario.lifecycleSandbox);

        const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
        const turnParams = turnStartRequest?.params as {
          approvalPolicy?: unknown;
          sandboxPolicy?: { type?: unknown };
        } | undefined;
        expect(turnParams?.approvalPolicy).toBe(scenario.approvalPolicy);
        expect(turnParams?.sandboxPolicy?.type).toBe(scenario.turnSandboxType);
      }
    });

    it("keeps the requested Codex reasoning effort while applying effective thread policy", async () => {
      mockState.codexResponseOverrides.set("thread/start", () => ({
        thread: { id: "thread-effective-start" },
        approvalPolicy: "onFailure",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          readOnlyAccess: { type: "fullAccess" },
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        reasoningEffort: "high",
      }));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const threadStartParams = threadStartRequest?.params as {
        config?: { model_reasoning_effort?: unknown };
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
        effort?: unknown;
      } | undefined;
      expect(threadStartParams?.config?.model_reasoning_effort).toBe("xhigh");
      expect(threadStartParams?.effort).toBeUndefined();
      expect(threadStartParams?.reasoningEffort).toBeUndefined();
      expect(threadStartParams?.reasoning_effort).toBeUndefined();
      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
        effort?: unknown;
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("on-failure");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("workspaceWrite");
      expect(turnStartParams?.effort).toBe("xhigh");
      expect(turnStartParams?.reasoningEffort).toBeUndefined();
      expect(turnStartParams?.reasoning_effort).toBeUndefined();

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.codexApprovalPolicy).toBe("on-failure");
      expect(summary?.codexSandbox).toBe("workspace-write");
      expect(summary?.permissionMode).toBe("default");
      expect(summary?.reasoningEffort).toBe("xhigh");

      const persisted = readPersistedChatState(session.id);
      expect(persisted.codexApprovalPolicy).toBe("on-failure");
      expect(persisted.codexSandbox).toBe("workspace-write");
      expect(persisted.reasoningEffort).toBe("xhigh");
    });

    it("applies fresh Codex thread effective sandbox when it differs from requested flags", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "default") return { approvalPolicy: "on-request", sandbox: "workspace-write" };
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      mockState.codexResponseOverrides.set("thread/start", () => ({
        thread: { id: "thread-effective-start-readonly" },
        approvalPolicy: "onRequest",
        sandbox: "read-only",
      }));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "default",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const threadStartParams = threadStartRequest?.params as { approvalPolicy?: unknown; sandbox?: unknown } | undefined;
      expect(threadStartParams?.approvalPolicy).toBe("on-request");
      expect(threadStartParams?.sandbox).toBe("workspace-write");

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("on-request");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("readOnly");

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.codexApprovalPolicy).toBe("on-request");
      expect(summary?.codexSandbox).toBe("read-only");
      expect(summary?.permissionMode).toBe("plan");
    });

    it("re-resumes Codex threads when permission mode changes mid-session", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        if (mode === "config-toml") {
          return null;
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "plan",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Read the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      mockState.codexRequestPayloads = [];
      mockState.codexResponseOverrides.set("thread/resume", () => ({
        thread: { id: "thread-after-mode-switch" },
        approvalPolicy: "onRequest",
        sandbox: "read-only",
      }));

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Now make the needed changes.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const threadResumeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/resume");
      const params = threadResumeRequest?.params as {
        approvalPolicy?: unknown;
        sandbox?: unknown;
        reasoningEffort?: unknown;
        effort?: unknown;
        config?: { model_reasoning_effort?: unknown };
      } | undefined;
      expect(params?.approvalPolicy).toBe("never");
      expect(params?.sandbox).toBe("danger-full-access");
      expect(params?.config?.model_reasoning_effort).toBe("medium");
      expect(params?.effort).toBeUndefined();
      expect(params?.reasoningEffort).toBeUndefined();

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const turnStartParams = turnStartRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: { type?: unknown };
        collaborationMode?: { mode?: unknown };
        effort?: unknown;
      } | undefined;
      expect(turnStartParams?.approvalPolicy).toBe("never");
      expect(turnStartParams?.sandboxPolicy?.type).toBe("dangerFullAccess");
      expect(turnStartParams?.collaborationMode?.mode).toBe("default");
      expect(turnStartParams?.effort).toBe("medium");
    });

    it("auto-approves pending Codex approvals when switched to full-auto during an active turn", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "edit",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Make the change.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-switch-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-switch-1",
          turnId: "  turn-1  ",
          command: "/bin/zsh -lc 'npm test'",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-switch-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-switch-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          permissions: {
            fileSystem: {
              write: [path.join(tmpRoot, "generated.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-switch-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-switch-1"
        )).toBe(true);
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-switch-1")).toMatchObject({
          result: { decision: "accept" },
        });
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-switch-1")).toMatchObject({
          result: {
            permissions: {
              fileSystem: {
                write: [path.join(tmpRoot, "generated.txt")],
              },
            },
            scope: "turn",
          },
        });
        expect(events.some((event) =>
          event.event.type === "pending_input_resolved"
          && event.event.itemId === "cmd-switch-1"
          && event.event.resolution === "accepted"
          && event.event.turnId === "turn-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "pending_input_resolved"
          && event.event.itemId === "perm-switch-1"
          && event.event.resolution === "accepted"
          && event.event.turnId === "turn-1"
        )).toBe(true);
      });

      const summary = await service.getSessionSummary(session.id);
      expect(summary?.permissionMode).toBe("full-auto");
      expect(summary?.codexApprovalPolicy).toBe("never");
      expect(summary?.codexSandbox).toBe("danger-full-access");
    });

    it("keeps escaped Codex command and file-change approvals manual in full-auto", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Make the change.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.codexRequestPayloads = [];

      const outsideLane = path.dirname(tmpRoot);
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-escape-1",
          turnId: "turn-1",
          cwd: outsideLane,
          command: "/bin/zsh -lc 'pwd'",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-additional-perms-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-additional-perms-escape-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          command: "/bin/zsh -lc 'cat /tmp/escape.txt'",
          additionalPermissions: {
            fileSystem: {
              read: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-additional-perms-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-additional-perms-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "file-escape-1",
        method: "item/fileChange/requestApproval",
        params: {
          itemId: "file-escape-1",
          turnId: "turn-1",
          grantRoot: outsideLane,
          reason: "Edit outside the lane",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "file-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "file-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-escape-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-escape-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          permissions: {
            fileSystem: {
              write: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-project-roots-escape-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-project-roots-escape-1",
          turnId: "turn-1",
          cwd: path.join(tmpRoot, "src"),
          permissions: {
            fileSystem: {
              entries: [{
                access: "write",
                path: {
                  type: "special",
                  value: {
                    kind: "project_roots",
                    subpath: "..",
                  },
                },
              }],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-project-roots-escape-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-project-roots-escape-1")).toBeUndefined();

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-project-roots-whole-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-project-roots-whole-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          permissions: {
            fileSystem: {
              entries: [{
                access: "write",
                path: {
                  type: "special",
                  value: {
                    kind: "project_roots",
                  },
                },
              }],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-project-roots-whole-1"
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-project-roots-whole-1")).toBeUndefined();
    });

    it("keeps escaped pending Codex approvals manual when switched to full-auto", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "edit",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Make the change.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      mockState.codexRequestPayloads = [];

      const outsideLane = path.dirname(tmpRoot);
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-pending-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-pending-escape-1",
          turnId: "turn-1",
          cwd: outsideLane,
          command: "/bin/zsh -lc 'pwd'",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "file-pending-escape-1",
        method: "item/fileChange/requestApproval",
        params: {
          itemId: "file-pending-escape-1",
          turnId: "turn-1",
          grantRoot: outsideLane,
          reason: "Edit outside the lane",
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-pending-additional-perms-escape-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-pending-additional-perms-escape-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          command: "/bin/zsh -lc 'cat /tmp/escape.txt'",
          additionalPermissions: {
            fileSystem: {
              read: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });
      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-pending-escape-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-pending-escape-1",
          turnId: "turn-1",
          cwd: outsideLane,
          permissions: {
            fileSystem: {
              write: [path.join(outsideLane, "escape.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-pending-escape-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "file-pending-escape-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "cmd-pending-additional-perms-escape-1"
        )).toBe(true);
        expect(events.some((event) =>
          event.event.type === "approval_request"
          && event.event.itemId === "perm-pending-escape-1"
        )).toBe(true);
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-pending-escape-1")).toBeUndefined();
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "file-pending-escape-1")).toBeUndefined();
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-pending-additional-perms-escape-1")).toBeUndefined();
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-pending-escape-1")).toBeUndefined();
      expect(events.some((event) =>
        event.event.type === "pending_input_resolved"
        && (
          event.event.itemId === "cmd-pending-escape-1"
          || event.event.itemId === "file-pending-escape-1"
          || event.event.itemId === "cmd-pending-additional-perms-escape-1"
          || event.event.itemId === "perm-pending-escape-1"
        )
      )).toBe(false);

      await service.respondToInput({
        sessionId: session.id,
        itemId: "cmd-pending-escape-1",
        decision: "decline",
      });
      await service.respondToInput({
        sessionId: session.id,
        itemId: "file-pending-escape-1",
        decision: "decline",
      });
      await service.respondToInput({
        sessionId: session.id,
        itemId: "cmd-pending-additional-perms-escape-1",
        decision: "decline",
      });
      await service.respondToInput({
        sessionId: session.id,
        itemId: "perm-pending-escape-1",
        decision: "decline",
      });
    });

    it("keeps Codex planner approval guard scoped to the turn that started in plan mode", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "plan",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan the investigation.",
      }, { awaitDispatch: true });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "turn-1",
          },
        },
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-plan-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-plan-1",
          turnId: "turn-1",
          command: "/bin/zsh -lc 'ade --socket lanes list --text'",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "error"
          && event.event.turnId === "turn-1"
          && event.event.message.includes("PLANNER CONTRACT VIOLATION")
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-plan-1")).toMatchObject({
        result: { decision: "decline" },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "perm-plan-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "perm-plan-1",
          turnId: "turn-1",
          cwd: tmpRoot,
          reason: "Allow write access",
          permissions: {
            fileSystem: {
              write: [path.join(tmpRoot, "planned-edit.txt")],
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "perm-plan-1")).toMatchObject({
          result: {
            permissions: {},
            scope: "turn",
          },
        });
      });
      expect(events.some((event) =>
        event.event.type === "approval_request"
        && event.event.itemId === "perm-plan-1"
      )).toBe(false);

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });
      mockState.codexRequestPayloads = [];

      await service.sendMessage({
        sessionId: session.id,
        text: "Now inspect with the updated permissions.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-full-auto-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-full-auto-1",
          turnId: "turn-2",
          command: "/bin/zsh -lc 'ade --socket chat list --text'",
        },
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-full-auto-1")).toMatchObject({
          result: { decision: "accept" },
        });
      });
      expect(events.some((event) =>
        event.event.type === "approval_request"
        && event.event.itemId === "cmd-full-auto-1"
      )).toBe(false);
      expect(events.some((event) =>
        event.event.type === "error"
        && event.event.turnId === "turn-2"
        && event.event.message.includes("PLANNER CONTRACT VIOLATION")
      )).toBe(false);
    });

    it("carries Codex planner approval guard through async turn/started when turn/start has no id", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });
      mockState.codexResponseOverrides.set("turn/start", { turn: {} });
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "plan",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Plan the investigation.",
      }, { awaitDispatch: true });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {},
        },
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turn: {
            id: "turn-async-1",
          },
        },
      });

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        id: "cmd-plan-async-1",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "cmd-plan-async-1",
          turnId: "turn-async-1",
          command: "/bin/zsh -lc 'ade --socket lanes list --text'",
        },
      });

      await vi.waitFor(() => {
        expect(events.some((event) =>
          event.event.type === "error"
          && event.event.turnId === "turn-async-1"
          && event.event.message.includes("PLANNER CONTRACT VIOLATION")
        )).toBe(true);
      });
      expect(mockState.codexRequestPayloads.find((payload) => payload.id === "cmd-plan-async-1")).toMatchObject({
        result: { decision: "decline" },
      });
    });

    it("uses each updated Codex reasoning effort on the next post-turn send", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        modelId: "openai/gpt-5.6-sol",
      });

      const completeLatestTurn = async (): Promise<void> => {
        mockState.emitCodexPayload({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            turn: {
              id: `turn-${mockState.codexTurnCounter}`,
              status: "completed",
            },
          },
        });
        await vi.waitFor(async () => {
          expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
        });
      };

      await service.sendMessage({
        sessionId: session.id,
        text: "Initial turn.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      await completeLatestTurn();

      for (const effort of ["low", "medium", "high", "xhigh", "ultra"]) {
        await service.updateSession({
          sessionId: session.id,
          reasoningEffort: effort,
        });
        mockState.codexRequestPayloads = [];

        await service.sendMessage({
          sessionId: session.id,
          text: `Use ${effort} reasoning now.`,
        });

        await vi.waitFor(() => {
          expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
        });
        const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
        expect((turnStartRequest?.params as { effort?: unknown } | undefined)?.effort).toBe(effort);
        await completeLatestTurn();
      }
    });

    it("applies Codex reasoning effort changes made during an active turn to the next turn", async () => {
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.5",
        reasoningEffort: "low",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Start with low reasoning.",
      });
      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const firstTurnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((firstTurnStartRequest?.params as { effort?: unknown } | undefined)?.effort).toBe("low");

      await service.updateSession({
        sessionId: session.id,
        reasoningEffort: "xhigh",
      });

      mockState.emitCodexPayload({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          turn: {
            id: `turn-${mockState.codexTurnCounter}`,
            status: "completed",
          },
        },
      });
      await vi.waitFor(async () => {
        expect((await service.getSessionSummary(session.id))?.status).toBe("idle");
      });

      mockState.codexRequestPayloads = [];
      await service.sendMessage({
        sessionId: session.id,
        text: "Now use the updated reasoning.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });
      const secondTurnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      expect((secondTurnStartRequest?.params as { effort?: unknown } | undefined)?.effort).toBe("xhigh");
    });

    it("re-resumes Codex threads when switching from config-toml to full-auto flags", async () => {
      vi.mocked(mapPermissionToCodex).mockImplementation((mode) => {
        if (mode === "full-auto") {
          return { approvalPolicy: "never", sandbox: "danger-full-access" };
        }
        if (mode === "edit") {
          return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
        }
        if (mode === "config-toml") {
          return null;
        }
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexConfigSource: "config-toml",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/start")).toBe(true);
      });

      const startRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/start");
      const startParams = startRequest?.params as Record<string, unknown> | undefined;
      expect(startParams?.approvalPolicy).toBeUndefined();
      expect(startParams?.sandbox).toBeUndefined();

      const startTurnRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const startTurnParams = startTurnRequest?.params as {
        approvalPolicy?: unknown;
        sandboxPolicy?: unknown;
      } | undefined;
      expect(startTurnParams?.approvalPolicy).toBeUndefined();
      expect(startTurnParams?.sandboxPolicy).toBeUndefined();

      mockState.codexRequestPayloads = [];

      await service.updateSession({
        sessionId: session.id,
        permissionMode: "full-auto",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Now make the needed changes.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "thread/resume")).toBe(true);
      });

      const resumeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/resume");
      const resumeParams = resumeRequest?.params as { approvalPolicy?: unknown; sandbox?: unknown } | undefined;
      expect(resumeParams?.approvalPolicy).toBe("never");
      expect(resumeParams?.sandbox).toBe("danger-full-access");
    });

    it("does not auto-upgrade default Codex chats into plan mode", async () => {
      mockState.codexCollaborationModes = [{ mode: "plan" }];
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Inspect the repo.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as { collaborationMode?: Record<string, unknown> } | undefined;
      expect(params?.collaborationMode).toBeUndefined();
    });

    it("falls back to default collaboration mode when plan is not advertised", async () => {
      mockState.codexCollaborationModes = [{ mode: "default" }];
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        codexApprovalPolicy: "untrusted",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Ask one planning question before coding.",
      });

      await vi.waitFor(() => {
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "collaborationMode/list")).toBe(true);
        expect(mockState.codexRequestPayloads.some((payload) => payload.method === "turn/start")).toBe(true);
      });

      const turnStartRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "turn/start");
      const params = turnStartRequest?.params as { collaborationMode?: Record<string, unknown> } | undefined;
      const collaborationMode = params?.collaborationMode as { mode?: unknown } | undefined;

      expect(collaborationMode?.mode).toBe("default");
    });
  });

  // --------------------------------------------------------------------------
  // Resume and error recovery
  // --------------------------------------------------------------------------

  describe("resumeSession", () => {
    it("resumes a disposed session back to idle", async () => {
      const { service, sessionService } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/anthropic/claude-sonnet-5",
      });

      await service.dispose({ sessionId: session.id });
      const resumed = await service.resumeSession({ sessionId: session.id });

      expect(resumed.id).toBe(session.id);
      expect(sessionService.reopen).toHaveBeenCalledWith(session.id);
    });

    it("repairs a spliced dedicated envelope transcript before Claude resume", async () => {
      installClaudeResponseFixture({ sdkSessionId: "sdk-splice-repair", responseText: "unused" });
      const initial = createService();
      const session = await initial.service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });
      await initial.service.dispose({ sessionId: session.id });

      const persisted = readPersistedChatState(session.id);
      writePersistedChatState(session.id, { ...persisted, sdkSessionId: "sdk-splice-repair" });
      const transcriptPath = path.join(tmpRoot, ".ade", "transcripts", "chat", `${session.id}.jsonl`);
      const legacyTranscriptPath = path.join(tmpRoot, "transcripts", `${session.id}.chat.jsonl`);
      const fragments = ["Full", " ", "SDK", " ", "answer"];
      const splicedTranscript = `${fragments.map((text, index) => JSON.stringify({
        sessionId: session.id,
        timestamp: "2026-07-10T12:00:00.000Z",
        sequence: index + 1,
        event: {
          type: "text",
          text,
          messageId: `wire-${index + 1}`,
          turnId: "turn-spliced",
        },
      })).join("\n")}\n`;
      fs.writeFileSync(transcriptPath, splicedTranscript, "utf8");
      fs.writeFileSync(legacyTranscriptPath, splicedTranscript, "utf8");
      vi.mocked(getSessionMessages).mockResolvedValue([{
        type: "assistant",
        uuid: "wire-sdk",
        session_id: "sdk-splice-repair",
        parent_tool_use_id: null,
        message: {
          id: "msg-stable-sdk",
          role: "assistant",
          content: [{ type: "text", text: "Full SDK answer" }],
        },
      }] as any);
      vi.mocked(parseAgentChatTranscript).mockImplementation((raw) => String(raw)
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line)));
      installClaudeResponseFixture({ sdkSessionId: "sdk-splice-repair", responseText: "unused" });

      const repairEvents: AgentChatEventEnvelope[] = [];
      const resumed = createService({
        onEvent: (event: AgentChatEventEnvelope) => repairEvents.push(event),
      });
      await resumed.service.resumeSession({ sessionId: session.id });
      await resumed.service.runSessionTurn({
        sessionId: session.id,
        text: "Continue after resume.",
        timeoutMs: 15_000,
      });
      await vi.waitFor(() => {
        expect(getSessionMessages).toHaveBeenCalledWith("sdk-splice-repair", { dir: fs.realpathSync(tmpRoot) });
      });
      await vi.waitFor(() => {
        const textEvents = resumed.service.getChatEventHistory(session.id).events
          .filter((entry) => entry.event.type === "text");
        expect(textEvents.find((entry) => entry.event.type === "text" && entry.event.messageId === "msg-stable-sdk")?.event).toMatchObject({
          type: "text",
          text: "Full SDK answer",
          messageId: "msg-stable-sdk",
        });
      });
      expect(fs.existsSync(`${transcriptPath}.splice.bak`)).toBe(true);
      expect(resumed.logger.info).toHaveBeenCalledWith(
        "agent_chat.envelope_splice_repaired",
        expect.objectContaining({ sessionId: session.id, repairedTurns: 1 }),
      );
      expect(repairEvents).toContainEqual(expect.objectContaining({
        sessionId: session.id,
        event: { type: "session_meta_updated", historyInvalidated: true },
      }));
    });

    it("resolves an ADE chat id to persisted and pointer-backed Claude main transcripts", async () => {
      installClaudeResponseFixture({ sdkSessionId: "sdk-main-transcript", responseText: "unused" });
      const { service, sessionService } = createService();
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await service.dispose({ sessionId: session.id });

      const persisted = readPersistedChatState(session.id);
      writePersistedChatState(session.id, { ...persisted, sdkSessionId: "sdk-persisted-main" });
      vi.mocked(getSessionMessages).mockResolvedValue([{
        type: "assistant",
        uuid: "assistant-persisted",
        session_id: "sdk-persisted-main",
        parent_tool_use_id: null,
        message: { id: "msg-persisted", role: "assistant", content: [{ type: "text", text: "Persisted transcript" }] },
      }] as any);

      expect(await service.getMainTranscript({ sessionId: session.id })).toEqual([
        expect.objectContaining({ uuid: "assistant-persisted", text: "Persisted transcript" }),
      ]);
      expect(getSessionMessages).toHaveBeenLastCalledWith("sdk-persisted-main", expect.objectContaining({
        dir: fs.realpathSync(tmpRoot),
        includeSystemMessages: true,
      }));

      const pointerState = { ...persisted };
      delete pointerState.sdkSessionId;
      writePersistedChatState(session.id, pointerState);
      sessionService.upsertClaudeSessionPointer({
        sessionId: "sdk-pointer-main",
        laneId: "lane-1",
        laneName: "Primary",
        chatSessionId: session.id,
        title: null,
        tags: [],
        createdAt: "2026-07-10T12:00:00.000Z",
        updatedAt: "2026-07-10T12:00:00.000Z",
      });
      vi.mocked(getSessionMessages).mockResolvedValue([{
        type: "system",
        uuid: "system-pointer",
        session_id: "sdk-pointer-main",
        parent_tool_use_id: null,
        message: { role: "system", content: "Pointer transcript" },
      }] as any);

      expect(await service.getMainTranscript({ sessionId: session.id })).toEqual([
        expect.objectContaining({ uuid: "system-pointer", type: "system", text: "Pointer transcript" }),
      ]);
      expect(getSessionMessages).toHaveBeenLastCalledWith("sdk-pointer-main", expect.objectContaining({
        includeSystemMessages: true,
      }));
    });

    it("gates main transcripts to Claude and byte-bounds the response", async () => {
      const { service } = createService();
      const codex = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.4" });
      expect(await service.getMainTranscript({ sessionId: codex.id })).toBeNull();
      expect(getSessionMessages).not.toHaveBeenCalled();

      installClaudeResponseFixture({ sdkSessionId: "sdk-bounded-main", responseText: "unused" });
      const claude = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await service.dispose({ sessionId: claude.id });
      const persisted = readPersistedChatState(claude.id);
      writePersistedChatState(claude.id, { ...persisted, sdkSessionId: "sdk-bounded-main" });
      const huge = "x".repeat(2_200_000);
      vi.mocked(getSessionMessages).mockResolvedValue([
        { type: "assistant", uuid: "old-huge", session_id: "sdk-bounded-main", parent_tool_use_id: null, message: { role: "assistant", content: huge } },
        { type: "assistant", uuid: "new-huge", session_id: "sdk-bounded-main", parent_tool_use_id: null, message: { role: "assistant", content: huge } },
      ] as any);

      const result = await service.getMainTranscript({ sessionId: claude.id });
      expect(result).toHaveLength(1);
      expect(result?.[0]?.uuid).toBe("new-huge");
    });

    it("keeps requested Codex policy and reasoning effort across resume", async () => {
      mockState.codexResponseOverrides.set("thread/resume", () => ({
        thread: { id: "thread-effective-resume" },
        approvalPolicy: "onFailure",
        sandbox: { type: "workspaceWrite" },
        reasoningEffort: "high",
      }));

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        permissionMode: "full-auto",
      });

      await service.dispose({ sessionId: session.id });
      const persistedBefore = readPersistedChatState(session.id);
      writePersistedChatState(session.id, {
        ...persistedBefore,
        threadId: "thread-stale-persisted",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
        reasoningEffort: "xhigh",
      });

      const resumed = await service.resumeSession({ sessionId: session.id });

      const resumeRequest = mockState.codexRequestPayloads.find((payload) => payload.method === "thread/resume");
      const resumeParams = resumeRequest?.params as {
        config?: { model_reasoning_effort?: unknown };
        reasoningEffort?: unknown;
        reasoning_effort?: unknown;
        effort?: unknown;
        dynamicTools?: unknown;
        persistExtendedHistory?: unknown;
      } | undefined;
      expect(resumeParams?.config?.model_reasoning_effort).toBe("xhigh");
      expect(resumeParams?.effort).toBeUndefined();
      expect(resumeParams?.reasoningEffort).toBeUndefined();
      expect(resumeParams?.reasoning_effort).toBeUndefined();
      expect(resumeParams?.dynamicTools).toBeUndefined();
      expect(resumeParams?.persistExtendedHistory).toBeUndefined();
      expect(resumed.codexApprovalPolicy).toBe("never");
      expect(resumed.codexSandbox).toBe("danger-full-access");
      expect(resumed.permissionMode).toBe("full-auto");
      expect(resumed.reasoningEffort).toBe("xhigh");

      const persistedAfter = readPersistedChatState(session.id);
      expect(persistedAfter.threadId).toBe("thread-effective-resume");
      expect(persistedAfter.codexApprovalPolicy).toBe("never");
      expect(persistedAfter.codexSandbox).toBe("danger-full-access");
      expect(persistedAfter.reasoningEffort).toBe("xhigh");
    });

    it("throws when resuming an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.resumeSession({ sessionId: "unknown-session-id" }),
      ).rejects.toThrow(/not found/i);
    });

    it("preserves Claude SDK session continuity after a runSessionTurn timeout", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        let primaryStreamCall = 0;
        let releaseInterruptedTurn = false;
        const primarySend = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);

        const primarySession = {
          send: primarySend,
          stream: vi.fn(() => (async function* () {
            primaryStreamCall += 1;
            if (primaryStreamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-1",
                slash_commands: [],
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }

            yield {
              type: "assistant",
              session_id: "sdk-session-1",
              message: {
                content: [{ type: "text", text: "Partial answer" }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };

            if (primaryStreamCall === 2) {
              while (!releaseInterruptedTurn) {
                await new Promise((resolve) => setTimeout(resolve, 1_000));
              }
              return;
            }

            if (primaryStreamCall === 3) {
              yield {
                type: "assistant",
                session_id: "sdk-session-1",
                message: {
                  content: [{ type: "text", text: "You were asking about the new chat buttons." }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }

            while (true) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
          })()),
          close: vi.fn(),
          sessionId: "sdk-session-1",
          setPermissionMode,
        };

        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(primarySession as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(primarySession as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });

        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const firstTurn = service.runSessionTurn({
          sessionId: session.id,
          text: "Add the new chat button",
          timeoutMs: 120_000,
        });
        const firstTurnError = firstTurn
          .then(() => null as Error | null)
          .catch((error) => error instanceof Error ? error : new Error(String(error)));
        await vi.advanceTimersByTimeAsync(120_000);
        expect(events.find((event) =>
          event.event.type === "status" && event.event.turnStatus === "interrupted",
        )).toBeDefined();
        releaseInterruptedTurn = true;
        await vi.advanceTimersByTimeAsync(1_000);
        const timeoutError = await firstTurnError;
        expect(timeoutError?.message ?? "").toMatch(/Timed out waiting for session .* The turn was interrupted, but the chat stayed open\./i);

        const persistedAfterTimeout = readPersistedChatState(session.id);
        expect(persistedAfterTimeout.sdkSessionId).toEqual(expect.any(String));
        const timeoutSdkSessionId = persistedAfterTimeout.sdkSessionId!;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(events.find((event) =>
          event.event.type === "status" && event.event.turnStatus === "failed",
        )).toBeUndefined();

        events.length = 0;
        const followUp = await service.runSessionTurn({
          sessionId: session.id,
          text: "what happened?",
          timeoutMs: 15_000,
        });

        expect(primarySession.close).toHaveBeenCalledTimes(1);
        expect(claudeSdkResumeSessionCompat).toHaveBeenCalledWith(timeoutSdkSessionId, expect.any(Object));
        expect(primarySend).toHaveBeenCalledTimes(3);
        expect(followUp.outputText).toContain("new chat buttons");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not abort Claude turns solely because they run longer than five minutes", async () => {
      vi.useFakeTimers();
      try {
        const events: AgentChatEventEnvelope[] = [];
        const send = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);
        let streamCall = 0;

        const sessionHandle = {
          send,
          stream: vi.fn(() => (async function* () {
            streamCall += 1;
            if (streamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-long-running",
                slash_commands: [],
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }

            for (let index = 0; index < 6; index += 1) {
              yield {
                type: "assistant",
                session_id: "sdk-session-long-running",
                message: {
                  content: [{ type: "text", text: `Chunk ${index + 1}. ` }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              };
              await new Promise((resolve) => setTimeout(resolve, 60_000));
            }

            yield {
              type: "assistant",
              session_id: "sdk-session-long-running",
              message: {
                content: [{ type: "text", text: "Finished after a long run." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          })()),
          close: vi.fn(),
          sessionId: "sdk-session-long-running",
          setPermissionMode,
        };

        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sessionHandle as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sessionHandle as any);

        const { service } = createService({
          onEvent: (event: AgentChatEventEnvelope) => events.push(event),
        });

        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        const turn = service.runSessionTurn({
          sessionId: session.id,
          text: "Keep working until the implementation is done.",
          timeoutMs: 500_000,
        });

        for (let index = 0; index < 6; index += 1) {
          await vi.advanceTimersByTimeAsync(60_000);
        }
        await vi.advanceTimersByTimeAsync(1_000);
        const result = await turn;

        expect(result.outputText).toContain("Finished after a long run.");
        expect(events.find((event) => event.event.type === "status" && event.event.turnStatus === "failed")).toBeUndefined();
        expect(events.find((event) => event.event.type === "status" && event.event.turnStatus === "interrupted")).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("tears down idle Claude runtimes after the inactivity ttl without losing resume state", async () => {
      vi.useFakeTimers();
      try {
        const close = vi.fn();
        let streamCall = 0;
        const send = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);

        const sessionHandle = {
          send,
          stream: vi.fn(() => (async function* () {
            streamCall += 1;
            if (streamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-idle-ttl",
                slash_commands: [],
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }

            yield {
              type: "assistant",
              session_id: "sdk-session-idle-ttl",
              message: {
                content: [{ type: "text", text: "Done." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield {
              type: "result",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          })()),
          close,
          sessionId: "sdk-session-idle-ttl",
          setPermissionMode,
        };

        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sessionHandle as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sessionHandle as any);

        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        await service.runSessionTurn({
          sessionId: session.id,
          text: "Say hi",
          timeoutMs: 15_000,
        });

        await vi.advanceTimersByTimeAsync(6 * 60_000);

        expect(close).toHaveBeenCalledTimes(1);
        const persistedAfterIdle = readPersistedChatState(session.id);
        expect(persistedAfterIdle.sdkSessionId).toEqual(expect.any(String));
        const idleSdkSessionId = persistedAfterIdle.sdkSessionId!;
        expect(persistedAfterIdle.lastLaneDirectiveKey).toEqual(expect.any(String));

        await service.runSessionTurn({
          sessionId: session.id,
          text: "Follow up with the previous context",
          timeoutMs: 15_000,
        });

        expect(claudeSdkResumeSessionCompat).toHaveBeenCalledWith(idleSdkSessionId, expect.any(Object));
        expect(claudeSdkCreateSessionCompat).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(3);
        expect(String(send.mock.calls[2]?.[0] ?? "")).toContain("Follow up with the previous context");
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves Claude resume metadata across idle_ttl followed by shutdown", async () => {
      vi.useFakeTimers();
      try {
        const close = vi.fn();
        let streamCall = 0;
        const send = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);

        const sessionHandle = {
          send,
          stream: vi.fn(() => (async function* () {
            streamCall += 1;
            if (streamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-preserve",
                slash_commands: [],
              };
              yield {
                type: "result",
                usage: { input_tokens: 1, output_tokens: 1 },
              };
              return;
            }
            yield {
              type: "assistant",
              session_id: "sdk-session-preserve",
              message: {
                content: [{ type: "text", text: "Done." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          })()),
          close,
          sessionId: "sdk-session-preserve",
          setPermissionMode,
        };

        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sessionHandle as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sessionHandle as any);

        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        await service.runSessionTurn({
          sessionId: session.id,
          text: "Say hi",
          timeoutMs: 15_000,
        });

        // Idle-ttl teardown persists sdkSessionId + laneDirectiveKey.
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        const persistedAfterIdle = readPersistedChatState(session.id);
        expect(persistedAfterIdle.sdkSessionId).toEqual(expect.any(String));
        const preservedSdkSessionId = persistedAfterIdle.sdkSessionId!;
        const preservedLaneDirective = persistedAfterIdle.lastLaneDirectiveKey;
        expect(preservedLaneDirective).toEqual(expect.any(String));

        // Shutdown re-enters teardownRuntime with runtime already null. Must
        // NOT clobber the preserved sdkSessionId/laneDirectiveKey.
        service.forceDisposeAll();

        const persistedAfterShutdown = readPersistedChatState(session.id);
        expect(persistedAfterShutdown.sdkSessionId).toBe(preservedSdkSessionId);
        expect(persistedAfterShutdown.lastLaneDirectiveKey).toBe(preservedLaneDirective);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears Claude resume metadata when a terminal teardown runs after idle_ttl", async () => {
      vi.useFakeTimers();
      try {
        const close = vi.fn();
        let streamCall = 0;
        const send = vi.fn().mockResolvedValue(undefined);
        const setPermissionMode = vi.fn().mockResolvedValue(undefined);

        const sessionHandle = {
          send,
          stream: vi.fn(() => (async function* () {
            streamCall += 1;
            if (streamCall === 1) {
              yield {
                type: "system",
                subtype: "init",
                session_id: "sdk-session-terminal",
                slash_commands: [],
              };
              yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
              return;
            }
            yield {
              type: "assistant",
              session_id: "sdk-session-terminal",
              message: {
                content: [{ type: "text", text: "Done." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          })()),
          close,
          sessionId: "sdk-session-terminal",
          setPermissionMode,
        };

        vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(sessionHandle as any);
        vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(sessionHandle as any);

        const { service } = createService();
        const session = await service.createSession({
          laneId: "lane-1",
          provider: "claude",
          model: "sonnet",
        });

        await service.runSessionTurn({
          sessionId: session.id,
          text: "Say hi",
          timeoutMs: 15_000,
        });

        // idle_ttl preserves sdkSessionId/laneDirectiveKey.
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        const persistedAfterIdle = readPersistedChatState(session.id);
        expect(persistedAfterIdle.sdkSessionId).toEqual(expect.any(String));
        expect(persistedAfterIdle.lastLaneDirectiveKey).toEqual(expect.any(String));

        // Terminal teardown (user closes the chat) runs teardownRuntime with
        // reason "ended_session" and runtime already null. Must still clear
        // the preserved lane directive so a future resume of a different
        // chat can't reattach to this ended session's lane context.
        // dispose → finishSession → teardownRuntime("ended_session") without
        // deleting the persisted state file.
        await service.dispose({ sessionId: session.id });

        const persistedAfterDispose = readPersistedChatState(session.id);
        expect(persistedAfterDispose.lastLaneDirectiveKey ?? null).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Interrupt
  // --------------------------------------------------------------------------

  describe("interrupt", () => {
    it("throws when interrupting an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.interrupt({ sessionId: "unknown-session-id" }),
      ).rejects.toThrow(/not found/i);
    });

    it("cursor interrupt before runtime setup does not create a Claude session", async () => {
      process.env.CURSOR_API_KEY = "test-cursor-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      vi.mocked(claudeSdkCreateSessionCompat).mockClear();
      await service.interrupt({ sessionId: session.id });
      expect(claudeSdkCreateSessionCompat).not.toHaveBeenCalled();
    });

    it("releases the cursor pool slot when interrupted during SDK setup", async () => {
      process.env.CURSOR_API_KEY = "test-cursor-key";
      let unblockAcquire: (() => void) | null = null;
      const acquireGate = new Promise<void>((resolve) => {
        unblockAcquire = resolve;
      });
      vi.mocked(acquireCursorSdkConnection).mockImplementationOnce(async (args: Record<string, unknown>) => {
        mockState.cursorSdkAcquireCalls.push(args);
        await acquireGate;
        const pooled: any = {
          process: { exitCode: null, killed: false },
          bridge: { onEvent: null, onRunStarted: null, onRunResult: null, onHookRequest: null },
          agentId: "cursor-sdk-agent-setup-interrupt",
          runId: null,
          request: vi.fn(async () => ({})),
          sendPrompt: vi.fn(async () => ({ id: "cursor-sdk-run-setup", status: "finished" })),
          updatePolicy: vi.fn(async () => {}),
          cancel: vi.fn(async () => {}),
          dispose: vi.fn(),
        };
        mockState.cursorSdkPooled = pooled;
        return { generation: 9, pooled };
      });

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });
      const turnPromise = service.runSessionTurn({
        sessionId: session.id,
        text: "Start cursor turn",
        displayText: "Start cursor turn",
      });
      await vi.waitFor(() => {
        expect(mockState.cursorSdkAcquireCalls.length).toBe(1);
      });
      await service.interrupt({ sessionId: session.id });
      unblockAcquire!();
      await expect(turnPromise).rejects.toThrow(/Cursor session interrupted/i);
      expect(releaseCursorSdkConnection).toHaveBeenCalledWith(
        expect.any(String),
        9,
      );
    });

    it("emits subagent_result stopped for active subagents on claude interrupt", async () => {
      const events: AgentChatEventEnvelope[] = [];

      // The stream function is called multiple times: once for warmup, once for the actual turn.
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stopTask = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          // Warmup stream — init + result to complete prewarm
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-interrupt-sub-1",
            slash_commands: [],
          };
          // Set before final yield: prewarm breaks the stream on `result` without draining further.
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        // Actual turn stream — emit two task_started events, then hang
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "sub-task-1",
          description: "Subagent A",
        };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "sub-task-2",
          description: "Subagent B",
        };
        // Hang until test resolves the promise (simulating a long-running turn)
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-interrupt-sub-1",
        setPermissionMode,
        stopTask,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      // Start the turn (don't await — it will hang)
      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Do something with subagents",
      });

      // Wait for the subagent_started events to appear
      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope =>
          e.event.type === "subagent_started" && (e.event as any).taskId === "sub-task-2",
      );

      // Now interrupt — should emit subagent_result "stopped" for both
      await service.interrupt({ sessionId: session.id });

      const stoppedEvents = events.filter(
        (e) => e.event.type === "subagent_result" && (e.event as any).status === "stopped",
      );
      expect(stoppedEvents).toHaveLength(2);

      const stoppedTaskIds = stoppedEvents.map((e) => (e.event as any).taskId).sort();
      expect(stoppedTaskIds).toEqual(["sub-task-1", "sub-task-2"]);
      expect(stopTask).toHaveBeenCalledTimes(2);
      expect(stopTask.mock.calls.map((call) => call[0]).sort()).toEqual(["sub-task-1", "sub-task-2"]);

      // After interrupt, listSubagents should reflect the stopped status
      const subagents = service.listSubagents({ sessionId: session.id });
      const stoppedSubagents = subagents.filter((s: any) => s.status === "stopped");
      expect(stoppedSubagents).toHaveLength(2);

      // Clean up: unblock the hanging stream so sendPromise resolves
      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("claude interrupt idempotency — second call is a no-op", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-idem-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "working" },
          },
        };
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-idem-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Hello",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope => e.event.type === "text",
      );

      await service.interrupt({ sessionId: session.id });
      const eventsAfterFirst = events.length;

      await service.interrupt({ sessionId: session.id });
      const newEvents = events.slice(eventsAfterFirst);
      expect(newEvents).toHaveLength(0);

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("claude interrupt with no active subagents emits no subagent events", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-no-sub-1", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "tick" },
          },
        };
        await hangPromise;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-no-sub-1",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Hello",
      });

      await waitForEvent(
        events,
        (e): e is AgentChatEventEnvelope => e.event.type === "text",
      );

      await service.interrupt({ sessionId: session.id });

      const subagentResultEvents = events.filter(
        (e) => e.event.type === "subagent_result",
      );
      expect(subagentResultEvents).toHaveLength(0);

      const eventsAfterFirst = events.length;
      await service.interrupt({ sessionId: session.id });
      const newEvents = events.slice(eventsAfterFirst);
      expect(newEvents).toHaveLength(0);

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();
    });

    it("emits a single interrupted status and done event and closes the Claude session", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let streamCall = 0;
      let warmupComplete = false;
      let hangResolve: (() => void) | null = null;
      const hangPromise = new Promise<void>((resolve) => { hangResolve = resolve; });
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-single-interrupt", slash_commands: [] };
          warmupComplete = true;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }

        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "still working" },
          },
        };
        await hangPromise;
        return;
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close,
        sessionId: "sdk-single-interrupt",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(warmupComplete).toBe(true);
      });

      const sendPromise = service.sendMessage({
        sessionId: session.id,
        text: "Please keep working",
      });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope => event.event.type === "text",
      );

      await service.interrupt({ sessionId: session.id });

      const interruptedStatuses = events.filter(
        (event) => event.event.type === "status" && event.event.turnStatus === "interrupted",
      );
      const interruptedDone = events.filter(
        (event) => event.event.type === "done" && event.event.status === "interrupted",
      );
      expect(interruptedStatuses).toHaveLength(1);
      expect(interruptedDone).toHaveLength(1);
      expect(close).toHaveBeenCalledTimes(1);

      hangResolve!();
      await expect(sendPromise).resolves.toBeUndefined();

      expect(events.filter(
        (event) => event.event.type === "status" && event.event.turnStatus === "interrupted",
      )).toHaveLength(1);
      expect(events.filter(
        (event) => event.event.type === "done" && event.event.status === "interrupted",
      )).toHaveLength(1);
    });

    it("resumes through a fresh SDK session after interrupt so stale stream text is not replayed", async () => {
      const events: AgentChatEventEnvelope[] = [];
      let primaryStreamCall = 0;
      let releaseInterruptedStream = false;
      const primaryClose = vi.fn();
      const primarySend = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);

      const primarySession = {
        send: primarySend,
        stream: vi.fn(() => (async function* () {
          primaryStreamCall += 1;
          if (primaryStreamCall === 1) {
            yield { type: "system", subtype: "init", session_id: "sdk-stale-replay", slash_commands: [] };
            yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
            return;
          }

          if (primaryStreamCall === 2) {
            yield {
              type: "assistant",
              session_id: "sdk-stale-replay",
              message: {
                content: [{ type: "text", text: "partial first answer" }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            };
            while (!releaseInterruptedStream) {
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            return;
          }

          yield {
            type: "assistant",
            session_id: "sdk-stale-replay",
            message: {
              content: [{ type: "text", text: "stale tail from interrupted turn" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: primaryClose,
        sessionId: "sdk-stale-replay",
        setPermissionMode,
      };
      const resumedSession = {
        send: vi.fn().mockResolvedValue(undefined),
        stream: vi.fn(() => (async function* () {
          yield {
            type: "assistant",
            session_id: "sdk-stale-replay",
            message: {
              content: [{ type: "text", text: "fresh follow-up answer" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
        })()),
        close: vi.fn(),
        sessionId: "sdk-stale-replay",
        setPermissionMode,
      };

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(primarySession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(resumedSession as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      await vi.waitFor(() => {
        expect(primaryStreamCall).toBeGreaterThanOrEqual(1);
      });

      const firstTurn = service.sendMessage({
        sessionId: session.id,
        text: "answer the first question",
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text" && event.event.text.includes("partial first answer"),
      );

      await service.interrupt({ sessionId: session.id });
      releaseInterruptedStream = true;
      await firstTurn;

      const followUp = await service.runSessionTurn({
        sessionId: session.id,
        text: "answer the follow up",
        timeoutMs: 15_000,
      });

      const persistedAfterInterrupt = readPersistedChatState(session.id);
      expect(primaryClose).toHaveBeenCalledTimes(1);
      expect(persistedAfterInterrupt.sdkSessionId).toEqual(expect.any(String));
      expect(claudeSdkResumeSessionCompat).toHaveBeenCalledWith(persistedAfterInterrupt.sdkSessionId, expect.any(Object));
      expect(followUp.outputText).toContain("fresh follow-up answer");
      expect(followUp.outputText).not.toContain("stale tail");
    });

  });

  // --------------------------------------------------------------------------
  // steer
  // --------------------------------------------------------------------------

  describe("steer", () => {
    it("routes a send during an active Claude turn through the queued steer path", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let finishActiveTurn!: () => void;
      const activeTurnGate = new Promise<void>((resolve) => { finishActiveTurn = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-send-to-steer", slash_commands: [] };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Still working" }], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          await activeTurnGate;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Queued send delivered" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-send-to-steer",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do the foreground work",
        timeoutMs: 15_000,
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text" && event.event.text.includes("Still working"),
      );

      const result = await service.sendMessage({
        sessionId: session.id,
        text: "Follow up when the active turn finishes",
        displayText: "Follow up soon",
        reasoningEffort: "high",
        executionMode: "subagents",
        interactionMode: "plan",
      }, { routeActiveToSteer: true });
      expect(result).toMatchObject({ queued: true, steerId: expect.any(String) });
      // The queued chip shows the display text, not the raw prompt text.
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.text === "Follow up soon"
        && event.event.deliveryState === "queued"
      )).toBe(true);

      finishActiveTurn();
      await activeTurn;
      await vi.waitFor(() => {
        // The delivered prompt carries the raw text plus the applied execution
        // and interaction mode directives.
        expect(send).toHaveBeenCalledWith(expect.stringContaining("Follow up when the active turn finishes"));
        const deliveredPrompt = send.mock.calls
          .map((call) => String(call[0]))
          .find((prompt) => prompt.includes("Follow up when the active turn finishes"));
        expect(deliveredPrompt).toContain("Use Claude subagents");
        expect(deliveredPrompt).toContain("plan mode for this turn");
      });
      // The delivered transcript message keeps the display text distinct from
      // the raw prompt text.
      expect(events.some((event) =>
        event.event.type === "user_message"
        && event.event.deliveryState !== "queued"
        && (event.event.displayText === "Follow up soon" || event.event.text === "Follow up soon")
      )).toBe(true);
    });

    it("does not steer an empty send during an active turn", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let finishActiveTurn!: () => void;
      const activeTurnGate = new Promise<void>((resolve) => { finishActiveTurn = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-empty-steer", slash_commands: [] };
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Still working" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        await activeTurnGate;
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-empty-steer",
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

      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do the foreground work",
        timeoutMs: 15_000,
      });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "text" && event.event.text.includes("Still working"),
      );

      const result = await service.sendMessage({
        sessionId: session.id,
        text: "   ",
      }, { routeActiveToSteer: true });
      expect(result).toBeUndefined();
      expect(events.some((event) =>
        event.event.type === "user_message" && event.event.deliveryState === "queued",
      )).toBe(false);

      finishActiveTurn();
      await activeTurn;
      // A queued steer would have started a third stream turn on delivery.
      expect(streamCall).toBe(2);
    });

    it("defers wake messages to the active Claude turn boundary", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let finishActiveTurn!: () => void;
      const activeTurnGate = new Promise<void>((resolve) => { finishActiveTurn = resolve; });

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-wake-boundary", slash_commands: [] };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Still working" }], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          await activeTurnGate;
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Scheduled check complete" }], usage: { input_tokens: 1, output_tokens: 1 } },
        };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-wake-boundary",
        setPermissionMode,
      } as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do the foreground work",
        timeoutMs: 15_000,
      });
      const activeText = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "text" }>;
      } => event.event.type === "text" && event.event.text.includes("Still working"));
      const activeTurnId = activeText.event.turnId;

      const result = await service.messageSession({
        sessionId: session.id,
        text: "Check PR CI",
        kind: "wake",
        metadata: {
          scheduledWake: {
            scheduleId: "wake-boundary-1",
            kind: "wakeup",
            firedAt: "2026-07-09T09:00:00.000Z",
            reason: "Check PR CI",
          },
        },
      });

      expect(result).toMatchObject({ routedAction: "steer", delivery: "queued", queued: true });
      const queued = events.find((event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>;
      } =>
        event.event.type === "user_message"
        && event.event.deliveryState === "queued"
        && event.event.text === "Check PR CI");
      expect(queued?.event.metadata?.scheduledWake).toBeUndefined();

      finishActiveTurn();
      await activeTurn;
      const delivered = await waitForEvent(events, (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>;
      } =>
        event.event.type === "user_message"
        && event.event.metadata?.scheduledWake?.scheduleId === "wake-boundary-1");
      expect(delivered.event.turnId).toBeTruthy();
      expect(delivered.event.turnId).not.toBe(activeTurnId);
      expect(send).toHaveBeenCalledWith(expect.stringContaining("Check PR CI"));
    });

    it("throws when steering an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.steer({
          sessionId: "unknown-session-id",
          text: "refocus on the main bug",
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("cancelSteer removes a queued steer and emits a system_notice", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let interruptedTurnClosed = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          // init stream
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        if (streamCall === 2) {
          // The blocking turn — yields an assistant message then waits
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Still working" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          while (!interruptedTurnClosed) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return;
        }

        // streamCall >= 3: any follow-up turn — should NOT happen because the steer was cancelled
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Follow up" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => {
          interruptedTurnClosed = true;
        }),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      // Start a turn so the runtime is busy
      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do some work",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Queue a steer — runtime is busy so it should be queued
      await service.steer({ sessionId: session.id, text: "queued steer text" });

      // Find the queued user_message event to get the steerId
      const queuedEvent = events.find(
        (e) =>
          e.event.type === "user_message"
          && (e.event as any).deliveryState === "queued"
          && (e.event as any).text === "queued steer text",
      );
      expect(queuedEvent).toBeDefined();
      const steerId = (queuedEvent!.event as any).steerId as string;
      expect(steerId).toBeTruthy();

      // Cancel the steer
      await service.cancelSteer({ sessionId: session.id, steerId });

      // Verify a system_notice with "Queued message cancelled." was emitted
      const cancelNotice = events.find(
        (e) =>
          e.event.type === "system_notice"
          && (e.event as any).message === "Queued message cancelled.",
      );
      expect(cancelNotice).toBeDefined();

      // Interrupt the turn to let it complete
      await service.interrupt({ sessionId: session.id });
      await activeTurn;

      // The cancelled steer should NOT have been delivered — `send` should not have been
      // called with "queued steer text"
      const sendCalls = send.mock.calls.map((c: any[]) => c[0]);
      const deliveredSteer = sendCalls.find(
        (arg: any) =>
          (typeof arg === "string" && arg.includes("queued steer text"))
          || (typeof arg === "object" && JSON.stringify(arg).includes("queued steer text")),
      );
      expect(deliveredSteer).toBeUndefined();
    });

    it("editSteer updates the queued steer text and cancels on interrupt", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let interruptedTurnClosed = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "Still working" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          while (!interruptedTurnClosed) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return;
        }

        // streamCall >= 3: follow-up turn after steer delivery
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Responding to updated text" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => {
          interruptedTurnClosed = true;
        }),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      // Start a turn so the runtime is busy
      const activeTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Do some work",
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Queue a steer
      await service.steer({ sessionId: session.id, text: "original steer text" });

      // Get the steerId from the queued user_message event
      const queuedEvent = events.find(
        (e) =>
          e.event.type === "user_message"
          && (e.event as any).deliveryState === "queued"
          && (e.event as any).text === "original steer text",
      );
      expect(queuedEvent).toBeDefined();
      const steerId = (queuedEvent!.event as any).steerId as string;
      expect(steerId).toBeTruthy();

      // Edit the steer
      await service.editSteer({ sessionId: session.id, steerId, text: "updated text" });

      // Verify a user_message with updated text and deliveryState "queued" was emitted
      const editedEvent = events.find(
        (e) =>
          e.event.type === "user_message"
          && (e.event as any).deliveryState === "queued"
          && (e.event as any).text === "updated text"
          && (e.event as any).steerId === steerId,
      );
      expect(editedEvent).toBeDefined();

      // Interrupt the turn — queued steers should be cancelled, not delivered
      await service.interrupt({ sessionId: session.id });
      await activeTurn;

      // Wait for the cancellation notice for the queued steer
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "system_notice"
          && (event.event as any).steerId === steerId
          && /cancelled/i.test((event.event as any).message),
      );

      // The steer should NOT have been delivered via send
      const sendCalls = send.mock.calls.map((c: any[]) => c[0]);
      const deliveredWithUpdatedText = sendCalls.find(
        (arg: any) =>
          (typeof arg === "string" && arg.includes("updated text"))
          || (typeof arg === "object" && JSON.stringify(arg).includes("updated text")),
      );
      expect(deliveredWithUpdatedText).toBeUndefined();
    });

    it("dispatchSteer mode:'inline' sends with shouldQuery:false and clears the queue", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let interruptedTurnClosed = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-session-1", slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          while (!interruptedTurnClosed) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return;
        }
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => { interruptedTurnClosed = true; }),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({ onEvent: (e: AgentChatEventEnvelope) => events.push(e) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      const activeTurn = service.runSessionTurn({ sessionId: session.id, text: "Do work", timeoutMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 25));

      await service.steer({ sessionId: session.id, text: "fold this in" });
      const queued = events.find((e) =>
        e.event.type === "user_message"
        && (e.event as any).deliveryState === "queued"
        && (e.event as any).text === "fold this in",
      );
      expect(queued).toBeDefined();
      const steerId = (queued!.event as any).steerId as string;

      // Dispatch inline — should call session.send with shouldQuery:false
      const result = await service.dispatchSteer({ sessionId: session.id, steerId, mode: "inline" });
      expect(result.dispatchedAt).not.toBeNull();

      // The 2nd send call (after the initial turn's send) is the inline dispatch
      const inlineSendCall = send.mock.calls.find((c: any[]) => {
        const arg = c[0];
        return typeof arg === "object" && arg && (arg as any).shouldQuery === false;
      });
      expect(inlineSendCall).toBeDefined();
      const inlinePayload = inlineSendCall![0] as any;
      expect(inlinePayload.shouldQuery).toBe(false);
      expect(inlinePayload.message?.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("fold this in") })]),
      );

      // user_message with deliveryState:"inline" should have been emitted
      const inlineEvent = events.find((e) =>
        e.event.type === "user_message"
        && (e.event as any).steerId === steerId
        && (e.event as any).deliveryState === "inline",
      );
      expect(inlineEvent).toBeDefined();

      // Cleanup
      await service.interrupt({ sessionId: session.id });
      await activeTurn;
    });

    it("dispatchSteer mode:'interrupt' moves the steer to head, sets interrupted, and calls query.interrupt", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const queryInterrupt = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      let interruptedTurnClosed = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-session-1", slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          while (!interruptedTurnClosed) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return;
        }
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => { interruptedTurnClosed = true; }),
        sessionId: "sdk-session-1",
        setPermissionMode,
        query: { interrupt: queryInterrupt },
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({ onEvent: (e: AgentChatEventEnvelope) => events.push(e) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      const activeTurn = service.runSessionTurn({ sessionId: session.id, text: "Do work", timeoutMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Queue two steers — the second one will be the dispatch target
      await service.steer({ sessionId: session.id, text: "first queued" });
      await service.steer({ sessionId: session.id, text: "interrupt with me" });

      const target = events.find((e) =>
        e.event.type === "user_message"
        && (e.event as any).deliveryState === "queued"
        && (e.event as any).text === "interrupt with me",
      );
      expect(target).toBeDefined();
      const steerId = (target!.event as any).steerId as string;

      const result = await service.dispatchSteer({ sessionId: session.id, steerId, mode: "interrupt" });
      expect(result.dispatchedAt).not.toBeNull();

      // The SDK's query.interrupt should have been invoked
      expect(queryInterrupt).toHaveBeenCalledTimes(1);

      // Simulate the SDK responding to the interrupt by letting the mock stream exit.
      // (service.interrupt() would short-circuit here because dispatchSteer already
      // set runtime.interrupted = true.)
      interruptedTurnClosed = true;
      await activeTurn.catch(() => {});
    });

    it("dispatchSteer no-ops when the steerId is not in the queue", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const stream = vi.fn(() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-session-1", slash_commands: [] };
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());
      const mockSession = {
        send, stream, close: vi.fn(), sessionId: "sdk-session-1", setPermissionMode,
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({ onEvent: () => {} });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      const result = await service.dispatchSteer({
        sessionId: session.id,
        steerId: "this-steer-id-does-not-exist",
        mode: "inline",
      });
      expect(result.dispatchedAt).toBeNull();
    });

    it("dispatchSteer rejects on Codex sessions", async () => {
      const { service } = createService({ onEvent: () => {} });
      const session = await service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5-codex" });

      await expect(
        service.dispatchSteer({ sessionId: session.id, steerId: "any", mode: "inline" }),
      ).rejects.toThrow(/not supported on Codex/i);
    });

    it("cancelDispatchedSteer reports inline-dispatched Claude steers as non-cancellable", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const cancelAsyncMessage = vi.fn().mockResolvedValue({ cancelled: true });
      let streamCall = 0;
      let interruptedTurnClosed = false;

      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield { type: "system", subtype: "init", session_id: "sdk-session-1", slash_commands: [] };
          yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
          return;
        }
        if (streamCall === 2) {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "Working..." }], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          while (!interruptedTurnClosed) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return;
        }
        yield { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(() => { interruptedTurnClosed = true; }),
        sessionId: "sdk-session-1",
        setPermissionMode,
        query: { cancelAsyncMessage },
      };
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService({ onEvent: (e: AgentChatEventEnvelope) => events.push(e) });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      const activeTurn = service.runSessionTurn({ sessionId: session.id, text: "Do work", timeoutMs: 15_000 });
      await new Promise((resolve) => setTimeout(resolve, 25));

      await service.steer({ sessionId: session.id, text: "fold this in" });
      const queued = events.find((e) =>
        e.event.type === "user_message"
        && (e.event as any).deliveryState === "queued"
        && (e.event as any).text === "fold this in",
      );
      const steerId = (queued!.event as any).steerId as string;

      await service.dispatchSteer({ sessionId: session.id, steerId, mode: "inline" });

      // Capture the UUID we sent on the SDK message
      const inlineSendCall = send.mock.calls.find((c: any[]) => {
        const arg = c[0];
        return typeof arg === "object" && arg && (arg as any).shouldQuery === false;
      });
      const sentUuid = (inlineSendCall![0] as any).uuid as string;
      expect(typeof sentUuid).toBe("string");
      expect(sentUuid.length).toBeGreaterThan(0);

      const cancelResult = await service.cancelDispatchedSteer({ sessionId: session.id, steerId });
      expect(cancelResult.cancelled).toBe(false);
      expect(cancelAsyncMessage).not.toHaveBeenCalled();

      const notice = events.find((e) =>
        e.event.type === "system_notice"
        && (e.event as any).steerId === steerId
        && /does not support cancelling/i.test((e.event as any).message),
      );
      expect(notice).toBeDefined();

      // Cleanup
      await service.interrupt({ sessionId: session.id });
      await activeTurn;
    });

    it("cancelDispatchedSteer returns cancelled:false when steerId not tracked", async () => {
      const { service } = createService({ onEvent: () => {} });
      const session = await service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });

      const result = await service.cancelDispatchedSteer({ sessionId: session.id, steerId: "never-dispatched" });
      expect(result.cancelled).toBe(false);
    });

    it("delivers queued OpenCode steers with attachments after the active turn settles", async () => {
      const events: AgentChatEventEnvelope[] = [];
      const firstTurnControl: { release?: () => void } = {};
      let streamCallCount = 0;
      vi.mocked(streamText).mockImplementation(() => {
        streamCallCount += 1;
        if (streamCallCount === 1) {
          return {
            fullStream: (async function* () {
              await new Promise<void>((resolve) => {
                firstTurnControl.release = resolve;
              });
              yield { type: "finish", usage: {} };
            })(),
          } as any;
        }
        return {
          fullStream: (async function* () {
            yield { type: "finish", usage: {} };
          })(),
        } as any;
      });
      vi.mocked(buildOpenCodePromptParts).mockClear();

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const firstTurn = service.runSessionTurn({
        sessionId: session.id,
        text: "Finish the active turn first.",
      });
      for (let attempt = 0; attempt < 20 && vi.mocked(buildOpenCodePromptParts).mock.calls.length < 1; attempt += 1) {
        await Promise.resolve();
      }
      expect(vi.mocked(buildOpenCodePromptParts).mock.calls.length).toBeGreaterThanOrEqual(1);

      const attachmentPath = path.join(tmpRoot, "opencode-steer-context.txt");
      fs.writeFileSync(attachmentPath, "OpenCode steer attachment context.");

      const steerResult = await service.steer({
        sessionId: session.id,
        text: "Then review the attached context.",
        attachments: [{ path: attachmentPath, type: "file" }],
      });
      expect(steerResult.queued).toBe(true);

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "user_message"
          && (event.event as any).deliveryState === "queued"
          && event.event.text === "Then review the attached context."
          && JSON.stringify((event.event as any).attachments ?? []).includes("opencode-steer-context.txt"),
      );

      expect(firstTurnControl.release).toBeTypeOf("function");
      firstTurnControl.release!();
      await firstTurn;

      for (let attempt = 0; attempt < 50 && vi.mocked(buildOpenCodePromptParts).mock.calls.length < 2; attempt += 1) {
        await Promise.resolve();
      }
      expect(vi.mocked(buildOpenCodePromptParts).mock.calls).toHaveLength(2);
      expect(vi.mocked(buildOpenCodePromptParts).mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        prompt: expect.stringContaining("Then review the attached context."),
        files: expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringContaining("opencode-steer-context.txt"),
            filename: "opencode-steer-context.txt",
          }),
        ]),
      }));

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope =>
          event.event.type === "user_message"
          && event.event.text === "Then review the attached context."
          && JSON.stringify((event.event as any).attachments ?? []).includes("opencode-steer-context.txt")
          && (event.event as any).deliveryState !== "queued",
      );
    });

    it("bridges OpenCode question events through ADE's question UI", async () => {
      const events: AgentChatEventEnvelope[] = [];
      vi.mocked(streamText).mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: "finish", usage: {} };
        })(),
      } as any));
      mockState.openCodeQuestionForNextPrompt = {
        id: "opencode-question-1",
        questions: [
          {
            header: "Scope",
            question: "Which surface should I inspect first?",
            options: [
              { label: "CLI", description: "Check terminal resume." },
              { label: "Chat", description: "Check SDK chat." },
            ],
            custom: true,
          },
        ],
      };

      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "opencode",
        model: "",
        modelId: "opencode/openai/gpt-5.4",
      });

      const turn = service.runSessionTurn({
        sessionId: session.id,
        text: "Ask a clarifying question.",
      });

      const questionEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope => {
          if (event.event.type !== "approval_request") return false;
          const detail = event.event.detail as { request?: PendingInputRequest } | undefined;
          return detail?.request?.source === "opencode"
            && detail.request.kind === "structured_question"
            && detail.request.providerMetadata?.openCodeQuestion === true;
        },
      );
      const request = ((questionEvent.event as any).detail as { request: PendingInputRequest }).request;
      expect(request.questions[0]?.question).toBe("Which surface should I inspect first?");
      expect(request.questions[0]?.options?.map((option) => option.value)).toEqual(["CLI", "Chat"]);

      await service.respondToInput({
        sessionId: session.id,
        itemId: request.itemId ?? request.requestId,
        decision: "accept",
        answers: { q_1: "Chat" },
      });
      await turn;

      const openCodeState = [...mockState.openCodeSessions.values()][0]!;
      expect(openCodeState.questionReply).toHaveBeenCalledWith({
        requestID: "opencode-question-1",
        directory: expect.stringMatching(/project$/),
        answers: [["Chat"]],
      }, { throwOnError: true });
    });

    it("sends Claude image follow-ups as SDK user messages after an earlier text turn", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-1",
            slash_commands: [],
          };
          yield {
            type: "result",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          return;
        }

        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: streamCall === 2 ? "First turn done" : "Follow-up done" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());

      const mockSession = {
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-1",
        setPermissionMode,
      };

      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue(mockSession as any);
      vi.mocked(claudeSdkResumeSessionCompat).mockReturnValue(mockSession as any);

      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      const imagePath = path.join(tmpRoot, "follow-up.png");
      fs.writeFileSync(imagePath, "fake-image-bytes");

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Start with text only",
      });

      await service.runSessionTurn({
        sessionId: session.id,
        text: "Now use this screenshot",
        attachments: [{ path: imagePath, type: "image" }],
      });

      expect(send).toHaveBeenCalledTimes(3);
      expect(String(send.mock.calls[1]?.[0] ?? "")).toContain("Start with text only");

      const followUpPayload = send.mock.calls[2]?.[0] as Record<string, unknown>;
      expect(followUpPayload.type).toBe("user");
      expect(followUpPayload.session_id).toEqual(expect.any(String));
      expect(followUpPayload.session_id).not.toBe("");
      expect(followUpPayload.parent_tool_use_id).toBeNull();

      const message = followUpPayload.message as { role: string; content: Array<Record<string, unknown>> };
      expect(message.role).toBe("user");
      expect(message.content[0]?.type).toBe("text");
      expect(String(message.content[0]?.text ?? "")).toContain("Now use this screenshot");
      expect(message.content[1]?.type).toBe("image");
      expect((message.content[1]?.source as Record<string, unknown>).type).toBe("base64");
    });

    it("omits large Cursor SDK file attachments without reading the full file", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const { service } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      const largePath = path.join(tmpRoot, "large-context.txt");
      const largeContent = `${"x".repeat(512 * 1024 + 1)}large-tail-marker`;
      fs.writeFileSync(largePath, largeContent);

      const readFileSpy = vi.spyOn(fs, "readFileSync");
      let readFileCalls: unknown[][] = [];
      try {
        await service.runSessionTurn({
          sessionId: session.id,
          text: "Use this large file",
          attachments: [{ path: largePath, type: "file" }],
        });
        readFileCalls = [...readFileSpy.mock.calls];
      } finally {
        readFileSpy.mockRestore();
      }

      expect(readFileCalls.some(([target]) => typeof target === "number")).toBe(false);
      const payloadText = String(mockState.cursorSdkSendCalls.at(-1)?.promptText ?? "");
      expect(payloadText).toContain(`[File: ${largePath} omitted: size ${largeContent.length} bytes]`);
      expect(payloadText).not.toContain("large-tail-marker");
    });
  });

  // --------------------------------------------------------------------------
  // approveToolUse
  // --------------------------------------------------------------------------

  describe("approveToolUse", () => {
    it("throws when approving for an unknown session", async () => {
      const { service } = createService();
      await expect(
        service.approveToolUse({
          sessionId: "unknown-session-id",
          itemId: "unknown-item-id",
          decision: "accept",
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("gracefully handles missing Claude approval without throwing", async () => {
      const setPermissionMode = vi.fn().mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);
      let streamCall = 0;
      const stream = vi.fn(() => (async function* () {
        streamCall += 1;
        if (streamCall === 1) {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sdk-session-missing-approval",
            slash_commands: [],
          };
          return;
        }
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Done" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })());
      vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
        send,
        stream,
        close: vi.fn(),
        sessionId: "sdk-session-missing-approval",
        setPermissionMode,
      } as any);

      const { service, logger } = createService();
      const session = await service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
      });

      // Run a turn so the Claude runtime gets created
      await service.runSessionTurn({
        sessionId: session.id,
        text: "Hello",
      });

      // Call approveToolUse with a non-existent itemId — should NOT throw
      await service.approveToolUse({
        sessionId: session.id,
        itemId: "nonexistent-item-id",
        decision: "accept",
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.claude_approval_not_found",
        expect.objectContaining({
          sessionId: session.id,
          itemId: "nonexistent-item-id",
          decision: "accept",
        }),
      );
    });

  it("preserves original attachments across local auto-continuation retries", async () => {
      const resolvedPath = path.join(tmpRoot, "note.txt");
      fs.writeFileSync(resolvedPath, "remember this", "utf8");

      const streamMessages = await buildOpenCodeStreamMessages({
        messages: [
          {
            role: "user",
            content: "Add an about me page.\n\nAttached context:\n- file: note.txt",
          },
          {
            role: "assistant",
            content: "I will explore the src directory to identify where pages and routing are defined in the application.",
          },
          {
            role: "user",
            content: "Continue from your last step.",
          },
        ],
        persistedTurnUserMessageIndex: 0,
        resolvedAttachments: [{
          path: "note.txt",
          type: "file",
          _rootPath: tmpRoot,
          _resolvedPath: resolvedPath,
        }],
        modelDescriptor: {
          id: "lmstudio/qwen2.5-coder:32b",
          displayName: "qwen2.5-coder:32b",
          family: "lmstudio",
          authTypes: ["local"],
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
          color: "#64748B",
          providerRoute: "@ai-sdk/openai-compatible",
          providerModelId: "qwen2.5-coder:32b",
          isCliWrapped: false,
          harnessProfile: "verified",
        } as any,
        getDirtyFileTextForPath: () => "remember unsaved edits",
        logger: createLogger() as any,
      });

      expect(streamMessages).toHaveLength(3);
      expect(streamMessages[0]?.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "file", filename: "note.txt" }),
      ]));
      const persistedContent = streamMessages[0]?.content as Array<Record<string, unknown>>;
      const filePart = persistedContent.find((part) => part.type === "file") as { data?: Buffer } | undefined;
      expect(filePart?.data?.toString("utf8")).toBe("remember unsaved edits");
      expect(streamMessages[2]).toEqual({
        role: "user",
        content: "Continue from your last step.",
      });
    });
  });

  it("emits immediate startup activity before opencode stream output arrives", async () => {
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });

    vi.mocked(streamText).mockImplementation(() => ({
      fullStream: (async function* () {
        await streamGate;
        yield { type: "finish", usage: {} };
      })(),
    }) as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "opencode",
      model: "opencode/openai/gpt-5.4",
      modelId: "opencode/openai/gpt-5.4",
    });

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const startedEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
      } => event.event.type === "status" && event.event.turnStatus === "started",
    );

    const startupActivity = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "activity" }>;
      } =>
        event.event.type === "activity"
        && event.event.turnId === startedEvent.event.turnId
        && (event.event.activity === "thinking" || event.event.activity === "working"),
    );

    expect(startupActivity.event.detail).toBeTruthy();

    releaseStream();
    await sendPromise;
  });

  it("renders assistant OpenCode image file parts without echoing user attachments", async () => {
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });
    vi.mocked(streamText).mockImplementation(() => ({
      fullStream: (async function* () {
        await streamGate;
        yield { type: "finish", usage: {} };
      })(),
    }) as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "opencode",
      model: "opencode/openai/gpt-5.4",
      modelId: "opencode/openai/gpt-5.4",
    });
    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Generate a small diagram.",
    });
    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope =>
        event.event.type === "status" && event.event.turnStatus === "started",
    );

    const state = [...mockState.openCodeSessions.values()][0]!;
    const inlineData = `data:image/png;base64,${"A".repeat(80 * 1024)}`;
    state.events.push(
      {
        type: "message.updated",
        properties: { info: { id: "user-msg", sessionID: "opencode-session-1", role: "user" } },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "user-image",
            sessionID: "opencode-session-1",
            messageID: "user-msg",
            type: "file",
            mime: "image/png",
            filename: "reference.png",
            url: "file:///tmp/reference.png",
          },
          delta: "",
        },
      },
      {
        type: "message.updated",
        properties: { info: { id: "assistant-msg", sessionID: "opencode-session-1", role: "assistant" } },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "generated-image",
            sessionID: "opencode-session-1",
            messageID: "assistant-msg",
            type: "file",
            mime: "image/png",
            filename: "diagram.png",
            url: "file:///tmp/diagram.png",
          },
          delta: "",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "image-tool-part",
            callID: "image-tool-call",
            sessionID: "opencode-session-1",
            messageID: "assistant-msg",
            type: "tool",
            tool: "generate_image",
            state: {
              status: "completed",
              input: { prompt: "Inline image" },
              output: "Generated image",
              title: "Generate image",
              metadata: {},
              time: { start: 1, end: 2 },
              attachments: [{
                id: "generated-inline-image",
                sessionID: "opencode-session-1",
                messageID: "assistant-msg",
                type: "file",
                mime: "image/png",
                filename: "inline.png",
                url: inlineData,
              }],
            },
          },
          delta: "",
        },
      },
    );
    const waiters = [...state.waiters];
    state.waiters.length = 0;
    waiters.forEach((waiter) => waiter());

    const image = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "codex_image_generation" }> } =>
        event.event.type === "codex_image_generation" && event.event.itemId === "generated-image",
    );
    expect(image.event).toMatchObject({
      prompt: "diagram.png",
      result: "file:///tmp/diagram.png",
      savedPath: "/tmp/diagram.png",
      status: "completed",
    });
    expect(events.some((event) =>
      event.event.type === "codex_image_generation" && event.event.itemId === "user-image"
    )).toBe(false);

    const inlineImage = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "codex_image_generation" }> } =>
        event.event.type === "codex_image_generation" && event.event.itemId === "generated-inline-image",
    );
    expect(inlineImage.event.result).toBe(inlineData);
    expect(inlineImage.event.resultOriginalBytes).toBeUndefined();

    const storedInlineImage = service.getChatEventHistory(session.id).events.find((event) =>
      event.event.type === "codex_image_generation" && event.event.itemId === "generated-inline-image"
    );
    expect(storedInlineImage?.event.type).toBe("codex_image_generation");
    if (storedInlineImage?.event.type !== "codex_image_generation") throw new Error("Expected stored image event");
    expect(storedInlineImage.event.result).toBeNull();
    expect(storedInlineImage.event.resultOriginalBytes).toBe(Buffer.byteLength(inlineData, "utf8"));
    expect(storedInlineImage.event.resultOmittedBytes).toBe(Buffer.byteLength(inlineData, "utf8"));
    expect(JSON.stringify(storedInlineImage.event)).not.toContain("A".repeat(1024));
    expect(JSON.stringify(service.getChatEventHistory(session.id).events)).not.toContain("A".repeat(1024));

    const storedToolResult = service.getChatEventHistory(session.id).events.find((event) =>
      event.event.type === "tool_result" && event.event.itemId === "image-tool-call"
    );
    expect(storedToolResult?.event.type).toBe("tool_result");
    if (storedToolResult?.event.type !== "tool_result") throw new Error("Expected stored tool result");
    expect(JSON.stringify(storedToolResult.event.result)).toContain("Inline image data omitted");

    releaseStream();
    await sendPromise;
  });

  it("dedupes repeated OpenCode compaction part updates without relying on part ids", async () => {
    const events: AgentChatEventEnvelope[] = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });

    vi.mocked(streamText).mockImplementation(() => ({
      fullStream: (async function* () {
        await streamGate;
        yield { type: "finish", usage: {} };
      })(),
    }) as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "opencode",
      model: "opencode/openai/gpt-5.4",
      modelId: "opencode/openai/gpt-5.4",
    });

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Compact this context.",
    });

    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
      } => event.event.type === "status" && event.event.turnStatus === "started",
    );

    const state = [...mockState.openCodeSessions.values()][0]!;
    state.events.push(
      {
        type: "message.part.updated",
        properties: {
          part: { sessionID: "opencode-session-1", type: "compaction", auto: false },
          delta: "",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { sessionID: "opencode-session-1", type: "compaction", auto: false },
          delta: "",
        },
      },
      {
        type: "session.compacted",
        properties: { sessionID: "opencode-session-1" },
      },
    );
    const waiters = [...state.waiters];
    state.waiters.length = 0;
    waiters.forEach((waiter) => waiter());

    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "context_compact" }>;
      } => event.event.type === "context_compact" && event.event.state === "completed",
    );

    const compactionEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "context_compact" }> =>
        event.type === "context_compact"
      );
    expect(compactionEvents).toHaveLength(2);
    expect(compactionEvents.map((event) => event.state)).toEqual(["started", "completed"]);
    expect(compactionEvents.every((event) => event.trigger === "manual")).toBe(true);

    releaseStream();
    await sendPromise;
  });

  it("emits immediate startup activity before Claude SDK stream output arrives", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = () => resolve();
    });

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-1",
          slash_commands: [],
        };
        return;
      }

      await streamGate;
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-1",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const startedEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "status" }>;
      } => event.event.type === "status" && event.event.turnStatus === "started",
    );

    const startupActivity = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "activity" }>;
      } =>
        event.event.type === "activity"
        && event.event.turnId === startedEvent.event.turnId
        && (event.event.activity === "thinking" || event.event.activity === "working"),
    );

    expect(startupActivity.event.detail).toBeTruthy();

    releaseStream();
    await sendPromise;
  });

  it("does not duplicate Claude thinking when the final assistant message repeats streamed content", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    let reasoningCountAfterDelta = -1;

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-thinking",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Checking both imports before editing.",
          },
        },
      };
      await new Promise((resolve) => setTimeout(resolve, 120));
      reasoningCountAfterDelta = events.filter((event) => event.event.type === "reasoning").length;
      yield {
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "Checking both imports before editing." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-thinking",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const reasoningEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "reasoning" }> => event.type === "reasoning");
    expect(reasoningEvents.map((event) => event.text)).toEqual(["Checking both imports before editing."]);
    // The streamed thinking_delta must be what created the reasoning row — not the
    // final assistant message (which would also produce a row if dedupe broke).
    expect(reasoningCountAfterDelta).toBe(1);
    expect(events.some((event) => event.event.type === "activity" && event.event.activity === "thinking")).toBe(true);
    const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls[0]?.[0] as {
      includePartialMessages?: boolean;
      agentProgressSummaries?: boolean;
      forwardSubagentText?: boolean;
    } | undefined;
    expect(sessionOpts).toEqual(expect.objectContaining({
      includePartialMessages: true,
      agentProgressSummaries: true,
      forwardSubagentText: true,
    }));
  });

  it("groups Claude text deltas by the stable message id and suppresses the repeated snapshot", async () => {
    const messageId = "msg-stable-stream";
    const fragments = ["Stable ", "Claude ", "text ", "stays ", "whole."];
    const fullText = fragments.join("");
    const events = await runClaudeStreamFixture({
      sdkSessionId: "sdk-session-stable-stream",
      messages: [
        {
          type: "stream_event",
          uuid: "wire-message-start",
          event: {
            type: "message_start",
            message: { id: messageId, usage: { input_tokens: 1, output_tokens: 0 } },
          },
        },
        ...fragments.map((text, index) => ({
          type: "stream_event",
          uuid: `wire-delta-${index + 1}`,
          event: {
            type: "content_block_delta",
            index: 0,
            message: { id: messageId },
            delta: { type: "text_delta", text },
          },
        })),
        {
          type: "assistant",
          uuid: "wire-assistant-snapshot",
          supersedes: ["superseded-wire-message"],
          message: {
            id: messageId,
            content: [{ type: "text", text: fullText }],
            usage: { input_tokens: 1, output_tokens: 5 },
          },
        },
        { type: "result", usage: { input_tokens: 1, output_tokens: 5 } },
      ],
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text).join("")).toBe(fullText);
    expect(new Set(textEvents.map((event) => event.messageId))).toEqual(new Set([messageId]));

    const retraction = events.find((event) => event.event.type === "transcript_retraction");
    expect(retraction?.event).toMatchObject({
      type: "transcript_retraction",
      replacementMessageId: messageId,
    });
  });

  it("keeps sequential Claude text blocks ordered under one stable message id", async () => {
    const messageId = "msg-stable-blocks";
    const events = await runClaudeStreamFixture({
      sdkSessionId: "sdk-session-stable-blocks",
      messages: [
        {
          type: "stream_event",
          uuid: "wire-blocks-start",
          event: {
            type: "message_start",
            message: { id: messageId, usage: { input_tokens: 1, output_tokens: 0 } },
          },
        },
        {
          type: "stream_event",
          uuid: "wire-block-0-delta-1",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "First " },
          },
        },
        {
          type: "stream_event",
          uuid: "wire-block-0-delta-2",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "block. " },
          },
        },
        {
          type: "stream_event",
          uuid: "wire-block-1-delta-1",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "Second " },
          },
        },
        {
          type: "stream_event",
          uuid: "wire-block-1-delta-2",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "block." },
          },
        },
        {
          type: "assistant",
          uuid: "wire-blocks-snapshot",
          message: {
            id: messageId,
            content: [
              { type: "text", text: "First block. " },
              { type: "text", text: "Second block." },
            ],
            usage: { input_tokens: 1, output_tokens: 4 },
          },
        },
        { type: "result", usage: { input_tokens: 1, output_tokens: 4 } },
      ],
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text).join("")).toBe("First block. Second block.");
    expect(textEvents.every((event) => event.messageId === messageId)).toBe(true);
  });

  it("falls back to Claude wire UUIDs when streamed text has no stable message id", async () => {
    const events = await runClaudeStreamFixture({
      sdkSessionId: "sdk-session-wire-fallback",
      messages: [
        {
          type: "stream_event",
          uuid: "wire-fallback-start",
          event: { type: "message_start", message: {} },
        },
        {
          type: "stream_event",
          uuid: "wire-fallback-delta",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Fallback text." },
          },
        },
        {
          type: "assistant",
          uuid: "wire-fallback-snapshot",
          message: {
            content: [
              { type: "text", text: "Fallback text." },
              { type: "text", text: " Snapshot fallback." },
            ],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
        { type: "result", usage: { input_tokens: 1, output_tokens: 2 } },
      ],
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text).join("")).toBe("Fallback text. Snapshot fallback.");
    expect(textEvents.map((event) => event.messageId)).toEqual([
      "wire-fallback-delta",
      "wire-fallback-snapshot",
    ]);
  });

  it("does not duplicate Claude text when an assistant snapshot repeats id-less streamed deltas", async () => {
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
          session_id: "sdk-session-text-dedupe",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Got it. Let me check" },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: " the desktop app structure." },
        },
      };
      yield {
        type: "assistant",
        message: {
          id: "msg-text-dedupe",
          content: [{ type: "text", text: "Got it. Let me check the desktop app structure." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-text-dedupe",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text)).toEqual(["Got it. Let me check the desktop app structure."]);
  });

  it("does not duplicate Claude text when the final assistant snapshot extends streamed deltas", async () => {
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
          session_id: "sdk-session-text-suffix",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "I checked the renderer" },
        },
      };
      yield {
        type: "assistant",
        message: {
          id: "msg-text-suffix",
          content: [{ type: "text", text: "I checked the renderer and added focused tests." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-text-suffix",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text).join("")).toBe("I checked the renderer and added focused tests.");
  });

  it("keeps Claude streamed text dedupable when a tool-use start arrives before the assistant snapshot", async () => {
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
          session_id: "sdk-session-text-tool-dedupe",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Let me check the desktop app." },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            id: "tool-use-after-text",
            name: "Bash",
            input: { command: "ls" },
          },
        },
      };
      yield {
        type: "assistant",
        message: {
          id: "msg-text-tool-dedupe",
          content: [
            { type: "text", text: "Let me check the desktop app." },
            { type: "tool_use", id: "tool-use-after-text", name: "Bash", input: { command: "ls" } },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-text-tool-dedupe",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Resolve the PR comments.",
    });

    const textEvents = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "text" }> => event.type === "text");
    expect(textEvents.map((event) => event.text)).toEqual(["Let me check the desktop app."]);
    expect(events.some((event) => event.event.type === "tool_call" && event.event.tool === "Bash")).toBe(true);
  });

  it("re-emits a Claude tool_call with parsed args once the input has streamed in after content_block_start", async () => {
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
          session_id: "sdk-session-streamed-args",
          slash_commands: [],
        };
        return;
      }

      // Stream path: tool_use starts with NO input; the input arrives via
      // input_json_delta and only parses at content_block_stop. Without the
      // enriched re-emit the persisted tool_call keeps args:{} forever.
      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool-use-streamed-args", name: "Read", input: {} },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"apps/desk" },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "top/src/a.ts\"}" },
        },
      };
      yield {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-streamed-args",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Read the file.",
    });

    const toolCalls = events
      .map((event) => event.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "tool_call" }> => event.type === "tool_call")
      .filter((event) => event.tool === "Read");
    expect(toolCalls).toHaveLength(2);
    // Same itemId so renderers collapse both into a single entry.
    expect(new Set(toolCalls.map((event) => event.itemId)).size).toBe(1);
    expect(toolCalls[0]?.args).toEqual({});
    expect(toolCalls[1]?.args).toEqual({ file_path: "apps/desktop/src/a.ts" });
  });

  it("normalizes Claude server web and MCP blocks into compact activity lifecycles", async () => {
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
          session_id: "sdk-session-structured-activity",
          slash_commands: [],
        };
        return;
      }
      yield {
        type: "assistant",
        message: {
          id: "msg-structured-activity",
          content: [
            {
              type: "server_tool_use",
              id: "search-1",
              name: "web_search",
              input: { query: "ADE transcript UI" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "search-1",
              content: [{
                type: "web_search_result",
                title: "ADE",
                url: "https://example.com/ade",
                encrypted_content: "opaque",
              }],
            },
            {
              type: "mcp_tool_use",
              id: "mcp-1",
              server_name: "github",
              name: "search_issues",
              input: { query: "label:bug" },
            },
            {
              type: "mcp_tool_result",
              tool_use_id: "mcp-1",
              is_error: false,
              content: [{ type: "text", text: "Issue 1" }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());
    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-structured-activity",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    await service.runSessionTurn({
      sessionId: session.id,
      text: "Research the transcript UI.",
    });

    expect(events.filter((event) =>
      event.event.type === "web_search" && event.event.itemId === "search-1"
    ).map((event) => event.event.type === "web_search" ? event.event.status : null)).toEqual([
      "running",
      "completed",
    ]);
    expect(events.filter((event) =>
      (event.event.type === "tool_call" || event.event.type === "tool_result")
      && event.event.itemId === "mcp-1"
    ).map((event) => event.event.type)).toEqual(["tool_call", "tool_result"]);
    expect(events.find((event) =>
      event.event.type === "tool_call" && event.event.itemId === "mcp-1"
    )?.event).toMatchObject({
      tool: "github:search_issues",
      mcp: { server: "github", tool: "search_issues" },
    });
  });

  it("emits completed Claude tool_result rows when tool_use_summary arrives", async () => {
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
          session_id: "sdk-session-tool-summary",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-use-1",
            name: "Read",
            input: { file_path: "apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx" },
          },
        },
      };
      yield {
        type: "tool_use_summary",
        summary: "Checked the shared chat renderer",
        preceding_tool_use_ids: ["tool-use-1"],
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-tool-summary",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Inspect the shared chat renderer.",
    });

    const completedToolResults = events.filter((event) =>
      event.event.type === "tool_result"
      && event.event.itemId === "tool-use-1"
      && event.event.status === "completed"
    );

    expect(completedToolResults).toHaveLength(1);
    expect(completedToolResults[0]!.event.type).toBe("tool_result");
    if (completedToolResults[0]!.event.type !== "tool_result") {
      throw new Error("Expected tool_result");
    }
    expect(completedToolResults[0]!.event.result).toMatchObject({
      synthetic: true,
      source: "claude_tool_use_summary",
      summary: "Checked the shared chat renderer",
    });
  });

  it("emits completed Claude tool_result rows for open tools when the turn ends without a tool summary", async () => {
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
          session_id: "sdk-session-tool-fallback",
          slash_commands: [],
        };
        return;
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-use-2",
            name: "Read",
            input: { file_path: "apps/desktop/src/renderer/components/chat/ChatWorkLogBlock.tsx" },
          },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-tool-fallback",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Inspect the grouped work log renderer.",
    });

    const completedToolResults = events.filter((event) =>
      event.event.type === "tool_result"
      && event.event.itemId === "tool-use-2"
      && event.event.status === "completed"
    );

    expect(completedToolResults).toHaveLength(1);
    expect(completedToolResults[0]!.event.type).toBe("tool_result");
    if (completedToolResults[0]!.event.type !== "tool_result") {
      throw new Error("Expected tool_result");
    }
    expect(completedToolResults[0]!.event.result).toMatchObject({
      synthetic: true,
      source: "claude_turn_finalization",
      finalTurnStatus: "completed",
    });
  });

  it("suppresses the 'tool calls were denied' notice for tool_use_ids resolved inline via canUseTool", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    let service: ReturnType<typeof createService>["service"];
    let sessionId = "";

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-denial-suppression",
          slash_commands: [],
        };
        return;
      }

      const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;

      // Approve plan exit through canUseTool — this records the tool_use_id in
      // runtime.resolvedToolUseIds so the SDK's later permission_denials echo
      // for the same id should NOT surface a "denied this turn" notice.
      await sessionOpts.canUseTool("EnterPlanMode", {}, {
        signal: new AbortController().signal,
        toolUseID: "tool-enter-plan-suppress",
      });
      const exitPromise = sessionOpts.canUseTool("ExitPlanMode", {
        planDescription: "Ship the approved plan.",
      }, {
        signal: new AbortController().signal,
        toolUseID: "tool-exit-plan-suppress",
      });
      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && typeof ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind) === "string"
          && ((event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval"),
      );
      await service.approveToolUse({
        sessionId,
        itemId: approvalEvent.event.itemId,
        decision: "accept",
      });
      await exitPromise;

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-exit-plan-suppress",
            name: "ExitPlanMode",
            input: { planDescription: "Ship the approved plan." },
          },
        },
      };
      yield {
        type: "system",
        subtype: "permission_denied",
        session_id: "sdk-session-denial-suppression",
        tool_name: "ExitPlanMode",
        tool_use_id: "tool-exit-plan-suppress",
        decision_reason: "echoed denial from the SDK",
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
        permission_denials: [
          // Resolved inline — must not surface a notice.
          { tool_name: "ExitPlanMode", tool_use_id: "tool-exit-plan-suppress" },
          // Genuine denial — must still surface a notice.
          { tool_name: "Bash", tool_use_id: "tool-bash-unresolved" },
        ],
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-denial-suppression",
      setPermissionMode,
    } as any);

    ({ service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    }));

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
    });
    sessionId = session.id;

    await service.runSessionTurn({
      sessionId: session.id,
      text: "Plan, approve, and report.",
    });

    const denialNotices = events
      .map((envelope) => envelope.event)
      .filter((event): event is Extract<AgentChatEventEnvelope["event"], { type: "system_notice" }> =>
        event.type === "system_notice" && typeof event.message === "string" && event.message.includes("denied this turn"),
      );

    expect(denialNotices).toHaveLength(1);
    expect(denialNotices[0]!.message).toContain("Bash");
    expect(denialNotices[0]!.message).not.toContain("ExitPlanMode");
    expect(denialNotices[0]!.message).toMatch(/^1 tool call was denied this turn/);
    expect(events.filter((envelope) =>
      envelope.event.type === "tool_result"
      && envelope.event.itemId === "tool-exit-plan-suppress"
      && envelope.event.status === "failed"
    )).toHaveLength(0);
  });

  it("bridges Claude AskUserQuestion through ADE's question UI", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    let streamCall = 0;
    let permissionResult: Record<string, unknown> | null = null;

    const askInput = {
      questions: [
        {
          question: "What should we do about the two task list views?",
          header: "Task views",
          options: [
            {
              label: "Remove the TurnSummaryCard tasks",
              description: "Keep only the inline task list.",
              preview: "<div><strong>Inline only</strong><p>Compact stream, no bottom summary card.</p></div>",
            },
            {
              label: "Keep both, improve summary",
              description: "Keep both task views, but make the summary less intrusive.",
              preview: "<div><strong>Hybrid</strong><p>Inline progress plus a compact summary card.</p></div>",
            },
          ],
          multiSelect: false,
        },
        {
          question: "Should the inline task list pin while tasks are active?",
          header: "Inline pinning",
          options: [
            { label: "Yes, pin while active" },
            { label: "No, let it scroll" },
          ],
          multiSelect: false,
        },
      ],
    };

    const stream = vi.fn(() => (async function* () {
      streamCall += 1;
      if (streamCall === 1) {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-session-ask-user",
          slash_commands: [],
        };
        return;
      }

      const sessionOpts = vi.mocked(claudeSdkCreateSessionCompat).mock.calls.at(-1)?.[0] as any;
      permissionResult = await sessionOpts.canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-user-1",
      });

      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Thanks, I can continue now." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
      yield {
        type: "result",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    })());

    vi.mocked(claudeSdkCreateSessionCompat).mockReturnValue({
      send,
      stream,
      close: vi.fn(),
      sessionId: "sdk-session-ask-user",
      setPermissionMode,
    } as any);

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      modelId: "anthropic/claude-sonnet-5",
      permissionMode: "plan",
    });

    const sendPromise = service.sendMessage({
      sessionId: session.id,
      text: "Figure out the task list UX and ask any clarifying questions you need.",
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } =>
        event.event.type === "approval_request"
        && typeof (event.event.detail as { request?: { providerMetadata?: { tool?: string } } } | undefined)?.request?.providerMetadata?.tool === "string"
        && ((event.event.detail as { request?: { providerMetadata?: { tool?: string } } }).request?.providerMetadata?.tool === "AskUserQuestion"),
    );

    const request = (approvalEvent.event.detail as {
      request: {
        kind: string;
        questions: Array<{
          id: string;
          question: string;
          options?: Array<{ preview?: string; previewFormat?: string }>;
        }>;
      };
    }).request;
    expect(request.kind).toBe("structured_question");
    expect(request.questions.map((question) => question.question)).toEqual([
      "What should we do about the two task list views?",
      "Should the inline task list pin while tasks are active?",
    ]);
    expect(request.questions[0]?.options?.[0]).toMatchObject({
      preview: "<div><strong>Inline only</strong><p>Compact stream, no bottom summary card.</p></div>",
      previewFormat: "markdown",
    });

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      answers: {
        question_1: "Keep both, improve summary",
        question_2: "Yes, pin while active",
      },
    });

    await sendPromise;

    expect(permissionResult).toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: {
          "What should we do about the two task list views?": "Keep both, improve summary",
          "Should the inline task list pin while tasks are active?": "Yes, pin while active",
        },
      },
    });
  });

  it("keeps standalone ask_user declines explicit without emitting a fake cleanup tool_result", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Planning question",
      body: "Which part of the planning UI should we test first?",
      questions: [{
        id: "answer",
        header: "Question 1",
        question: "Which part of the planning UI should we test first?",
        options: [
          { label: "Question flow", value: "question_flow" },
          { label: "Plan updates", value: "plan_updates" },
        ],
        allowsFreeform: true,
      }],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Planning question";
      },
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "decline",
    });

    const result = await requestPromise;
    expect(result.decision).toBe("decline");
    expect(events.filter((event) => event.event.type === "tool_result")).toHaveLength(0);
  });

  it("persists awaitingInput while chat input is pending and clears it after resolution", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Pending question",
      body: "Which path should we take?",
      questions: [{
        id: "answer",
        header: "Question 1",
        question: "Which path should we take?",
        allowsFreeform: true,
      }],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Pending question";
      },
    );

    expect(readPersistedChatState(session.id).awaitingInput).toBe(true);
    await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
      awaitingInput: true,
      pendingInputItemId: approvalEvent.event.itemId,
    });

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      responseText: "Take the safe path.",
    });

    await expect(requestPromise).resolves.toMatchObject({
      decision: "accept",
      answers: { answer: ["Take the safe path."] },
      responseText: "Take the safe path.",
    });
    expect(readPersistedChatState(session.id).awaitingInput).toBeUndefined();
  });

  it("rejects normal chat sends while a pending input request is waiting", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Pending question",
      body: "Which path should we take?",
      questions: [{
        id: "answer",
        header: "Question 1",
        question: "Which path should we take?",
        allowsFreeform: true,
      }],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Pending question";
      },
    );

    await expect(service.sendMessage({
      sessionId: session.id,
      text: "Treat this as the answer even though it came through chat.send.",
    })).rejects.toThrow("Answer or decline the pending request before sending another message.");

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "decline",
    });

    await expect(requestPromise).resolves.toMatchObject({ decision: "decline" });
  });

  it("maps freeform replies to the single pending question when only one answer is needed", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Single question",
      body: "Which area should we test first?",
      questions: [{
        id: "answer",
        header: "Question 1",
        question: "Which area should we test first?",
        allowsFreeform: true,
      }],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Single question";
      },
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      responseText: "Question flow",
    });

    await expect(requestPromise).resolves.toMatchObject({
      decision: "accept",
      answers: { answer: ["Question flow"] },
      responseText: "Question flow",
    });
  });

  it("does not fan a single freeform reply out across multiple structured questions", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    const requestPromise = service.requestChatInput({
      chatSessionId: session.id,
      title: "Multiple questions",
      body: "Tell me which plan we should use and whether to pin tasks.",
      questions: [
        {
          id: "plan_focus",
          header: "Plan focus",
          question: "What kind of planning scenario should I use?",
          allowsFreeform: true,
        },
        {
          id: "task_pinning",
          header: "Task pinning",
          question: "Should the inline task list stay pinned?",
          allowsFreeform: true,
        },
      ],
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? (event.event.detail as { request?: { title?: string } } | undefined)
          : undefined;
        return event.event.type === "approval_request" && detail?.request?.title === "Multiple questions";
      },
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
      responseText: "Start with the UI planning case.",
    });

    await expect(requestPromise).resolves.toMatchObject({
      decision: "accept",
      answers: { response: ["Start with the UI planning case."] },
      responseText: "Start with the UI planning case.",
    });
  });

  it("responds to native Codex requestUserInput declines with empty answers instead of interrupting the turn", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      codexApprovalPolicy: "untrusted",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Ask one planning question before coding.",
    }, { awaitDispatch: true });

    mockState.emitCodexPayload({
      jsonrpc: "2.0",
      id: "native-request-1",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "codex-question-1",
        threadId: "thread-1",
        turnId: "turn-1",
        questions: [
          {
            id: "plan_focus",
            header: "Plan focus",
            question: "What kind of planning scenario should I use?",
            isOther: true,
            options: [
              { label: "UI planning" },
              { label: "Bug fix planning" },
            ],
          },
        ],
      },
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } =>
        event.event.type === "approval_request"
        && event.event.itemId === "codex-question-1",
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "cancel",
    });

    expect(
      mockState.codexRequestPayloads.some((payload) => payload.method === "turn/interrupt"),
    ).toBe(false);
    expect(
      mockState.codexRequestPayloads.find((payload) => payload.id === "native-request-1"),
    ).toMatchObject({
      id: "native-request-1",
      result: {
        answers: {},
      },
    });
  });

  it("renders Cursor SDK private plan control blocks without exposing them as chat text", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Plan this.",
    }, { awaitDispatch: true });

    mockState.cursorSdkPooled.bridge.onEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: [
            "```ade_update_plan",
            "{\"steps\":[{\"text\":\"Inspect current chat wiring\",\"status\":\"completed\"},{\"text\":\"Render ADE plan UI\",\"status\":\"in_progress\"}],\"explanation\":\"Cursor SDK should use ADE-native planning UI.\"}",
            "```",
          ].join("\n"),
        }],
      },
    });

    expect(events.some((event) =>
      event.event.type === "plan"
      && event.event.steps[1]?.text === "Render ADE plan UI"
    )).toBe(true);
    expect(events.some((event) =>
      event.event.type === "text"
      && event.event.text.includes("ade_update_plan")
    )).toBe(false);
  });

  it("does not pass ADE default titles as Cursor SDK agent names", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Run locally.",
    }, { awaitDispatch: true });

    expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(
      expect.objectContaining({ agentName: null }),
    );
  });

  it("passes only manual titles as Cursor SDK agent names", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const { service } = createService();
    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
    });
    await service.updateSession({
      sessionId: session.id,
      title: "Manual Cursor Title",
      manuallyNamed: true,
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Run locally.",
    }, { awaitDispatch: true });

    expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(
      expect.objectContaining({ agentName: "Manual Cursor Title" }),
    );
  });

  it("buffers streamed Cursor SDK control blocks before rendering ADE plan UI", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Plan this.",
    }, { awaitDispatch: true });

    mockState.cursorSdkPooled.bridge.onEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: "```ade_",
        }],
      },
    });
    mockState.cursorSdkPooled.bridge.onEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: "update_plan{\"steps\":[{\"text\":\"Buffered Cursor plan\",\"status\":\"in_progress\"}],\"explanation\":\"No raw controls should leak.\"}```",
        }],
      },
    });

    expect(events.some((event) =>
      event.event.type === "plan"
      && event.event.steps[0]?.text === "Buffered Cursor plan"
    )).toBe(true);
    expect(events.some((event) =>
      event.event.type === "text"
      && (event.event.text.includes("ade_update_plan") || event.event.text.includes("```ade_"))
    )).toBe(false);
  });

  it("drops malformed Cursor SDK control blocks without crashing or leaking raw text", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Plan this.",
    }, { awaitDispatch: true });

    expect(() => {
      mockState.cursorSdkPooled.bridge.onEvent({
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: "Before ```ade_update_plan{\"steps\":[``` after",
          }],
        },
      });
    }).not.toThrow();

    expect(events.some((event) =>
      event.event.type === "text"
      && (event.event.text.includes("ade_update_plan") || event.event.text.includes("```ade_"))
    )).toBe(false);
  });

  it("preserves Cursor SDK text chunk spacing while parsing private controls", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Plan this.",
    }, { awaitDispatch: true });

    for (const text of ["Publishing", " a short", " demo", " plan."]) {
      mockState.cursorSdkPooled.bridge.onEvent({
        type: "assistant",
        message: {
          content: [{ type: "text", text }],
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    const streamedText = events
      .filter((event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "text" }>;
      } => event.event.type === "text")
      .map((event) => event.event.text)
      .join("");
    expect(streamedText).toContain("Publishing a short demo plan.");
  });

  it("uses Cursor SDK private question control blocks for ADE pending input", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Make a plan.",
    }, { awaitDispatch: true });

    mockState.cursorSdkPooled.bridge.onEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: [
            "```ade_request_user_input",
            "{\"title\":\"Plan question\",\"questions\":[{\"id\":\"scope\",\"header\":\"Scope\",\"question\":\"Which scope should I plan around?\",\"options\":[{\"label\":\"UI flow\"},{\"label\":\"Backend flow\"}],\"allowsFreeform\":true}]}",
            "```",
          ].join("\n"),
        }],
      },
    });

    const questionEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } => {
        const detail = event.event.type === "approval_request"
          ? event.event.detail as { request?: { title?: string; kind?: string } } | undefined
          : undefined;
        return event.event.type === "approval_request"
          && detail?.request?.title === "Plan question"
          && detail.request.kind === "structured_question";
      },
    );

    const sendCallCountBeforeAnswer = mockState.cursorSdkSendCalls.length;
    await service.respondToInput({
      sessionId: session.id,
      itemId: questionEvent.event.itemId,
      decision: "accept",
      answers: { scope: ["UI flow"] },
      responseText: "UI flow",
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (mockState.cursorSdkSendCalls.length > sendCallCountBeforeAnswer) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(mockState.cursorSdkSendCalls.length).toBeGreaterThan(sendCallCountBeforeAnswer);
    expect(mockState.cursorSdkSendCalls.at(-1)?.promptText).toEqual(
      expect.stringContaining("The user answered the Cursor planning question"),
    );
    expect(events.some((event) =>
      event.event.type === "user_message"
      && event.event.text.includes("The user answered the Cursor planning question")
    )).toBe(false);
  });

  it("keeps Cursor SDK approvals live when preview persistence fails", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service, sessionService, logger } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "agent",
    });

    const previewError = new Error("database is not open");
    vi.mocked(sessionService.setLastOutputPreview).mockImplementation(() => {
      throw previewError;
    });

    let releaseGate: () => void = () => {};
    mockState.cursorSendPromptGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const pendingTurn = service.sendMessage({
      sessionId: session.id,
      text: "Run a command that needs approval.",
    }, { awaitDispatch: true });

    try {
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBe(1);
      });

      expect(() => {
        mockState.cursorSdkPooled.bridge.onEvent({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "I need to inspect the lane." }],
          },
        });
      }).not.toThrow();

      const hookResponse = mockState.cursorSdkPooled.bridge.onHookRequest({
        id: "cursor-hook-preview-failure",
        toolName: "shell",
        title: "Run shell command",
        summary: "Run git status",
        cwd: tmpRoot,
        raw: { command: "git status --short" },
        toolInput: { command: "git status --short" },
        risk: "shell",
      });

      const approvalEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & {
          event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
        } =>
          event.event.type === "approval_request"
          && event.event.itemId === "cursor-hook-preview-failure",
      );

      await service.respondToInput({
        sessionId: session.id,
        itemId: approvalEvent.event.itemId,
        decision: "accept_for_session",
      });

      await expect(hookResponse).resolves.toEqual({ permission: "allow" });
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_chat.preview_update_failed",
        expect.objectContaining({
          sessionId: session.id,
          error: "database is not open",
        }),
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        "agent_chat.approval_without_live_runtime",
        expect.anything(),
      );
      expect(releaseCursorSdkConnection).not.toHaveBeenCalled();
    } finally {
      releaseGate();
      await pendingTurn;
    }
  });

  it("exits Cursor SDK plan mode through ADE plan approval control blocks", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Make a plan.",
    }, { awaitDispatch: true });

    mockState.cursorSdkPooled.bridge.onEvent({
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: [
            "```ade_plan_approval{\"planDescription\":\"1. Inspect wiring\\n2. Patch Cursor controls\\n3. Verify\"}```",
          ].join("\n"),
        }],
      },
    });

    const approvalEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "approval_request" }>;
      } =>
        event.event.type === "approval_request"
        && (event.event.detail as { request?: { kind?: string } } | undefined)?.request?.kind === "plan_approval",
    );

    await service.respondToInput({
      sessionId: session.id,
      itemId: approvalEvent.event.itemId,
      decision: "accept",
    });

    expect(mockState.cursorSdkPolicyUpdates.at(-1)).toMatchObject({
      chatMode: "agent",
      approvalPolicy: "on-request",
    });
    await expect(service.getSessionSummary(session.id)).resolves.toMatchObject({
      cursorModeId: "agent",
    });
  });

  it("pushes Cursor SDK mode changes into the live worker while a turn is active", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const { service } = createService();

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "agent",
    });

    let releaseGate: () => void = () => {};
    mockState.cursorSendPromptGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const pendingTurn = service.sendMessage({
      sessionId: session.id,
      text: "Keep this Cursor turn open while I switch modes.",
    }, { awaitDispatch: true });

    try {
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBeGreaterThan(0);
      });

      const updated = await service.updateSession({
        sessionId: session.id,
        cursorModeId: "full-auto",
      });

      expect(updated.cursorModeId).toBe("full-auto");
      expect(updated.cursorModeSnapshot?.currentModeId).toBe("full-auto");
      expect(mockState.cursorSdkPolicyUpdates.at(-1)).toMatchObject({
        chatMode: "agent",
        approvalPolicy: "never",
        force: true,
      });
    } finally {
      releaseGate();
      await pendingTurn;
    }
  });

  it("defers Cursor SDK runtime reset when switching models during an active turn", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const { service } = createService();

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "cursor",
      model: "composer-2",
      modelId: "cursor/composer-2",
      cursorModeId: "agent",
    });

    let releaseGate: () => void = () => {};
    mockState.cursorSendPromptGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const pendingTurn = service.sendMessage({
      sessionId: session.id,
      text: "Keep this Cursor turn open while I switch models.",
    }, { awaitDispatch: true });

    try {
      await vi.waitFor(() => {
        expect(mockState.cursorSdkSendCalls.length).toBe(1);
      });

      await expect(service.updateSession({
        sessionId: session.id,
        modelId: "cursor/composer-2.5",
      })).resolves.toMatchObject({
        provider: "cursor",
        model: "cursor/composer-2.5",
        modelId: "cursor/composer-2.5",
      });

      expect(releaseCursorSdkConnection).not.toHaveBeenCalled();
    } finally {
      releaseGate();
      await pendingTurn;
    }

    await vi.waitFor(() => {
      expect(releaseCursorSdkConnection).toHaveBeenCalledTimes(1);
    });
    mockState.cursorSendPromptGate = null;

    await service.sendMessage({
      sessionId: session.id,
      text: "Use the newly selected Cursor model.",
    }, { awaitDispatch: true });

    expect(mockState.cursorSdkAcquireCalls.at(-1)).toEqual(
      expect.objectContaining({ modelSdkId: "composer-2.5" }),
    );
    expect(mockState.cursorSdkSendCalls.at(-1)).toEqual(
      expect.objectContaining({ modelSdkId: "composer-2.5" }),
    );
  });

  it("configures a new Droid SDK session with the selected model before prompting", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "droid",
      model: "custom:claude-sonnet-5-thinking-32000",
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Use the selected Droid model.",
    }, { awaitDispatch: true });

    const doneEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "done" }>;
      } => event.event.type === "done" && event.sessionId === session.id,
    );
    const updated = await service.getSessionSummary(session.id);

    expect(mockState.droidAcquireCalls[0]?.settings).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
    });
    expect(mockState.droidSettingsUpdates.at(-1)).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
      interactionMode: "auto",
    });
    expect(mockState.droidPromptCalls[0]?.settings).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
    });
    expect(vi.mocked(buildCodingAgentSystemPrompt)).toHaveBeenCalledWith(expect.objectContaining({
      runtime: "droid-sdk",
      mode: "coding",
    }));
    expect(mockState.droidPromptCalls[0]?.promptText).toContain("system prompt\n\n## User Request");
    const settingsOrder = mockState.droidPooled.updateSettings.mock.invocationCallOrder[0];
    const firstPromptOrder = mockState.droidPooled.sendPrompt.mock.invocationCallOrder[0];
    expect(settingsOrder).toBeDefined();
    expect(firstPromptOrder).toBeDefined();
    expect(settingsOrder).toBeLessThan(firstPromptOrder!);
    expect(updated?.model).toBe("custom:claude-sonnet-5-thinking-32000");
    expect(updated?.modelId).toBe("droid/custom:claude-sonnet-5-thinking-32000");
    expect(doneEvent.event.model).toBe("custom:claude-sonnet-5-thinking-32000");
    expect(doneEvent.event.modelId).toBe("droid/custom:claude-sonnet-5-thinking-32000");
  });

  it("uses Droid spec mode for ADE plan mode", async () => {
    const events: AgentChatEventEnvelope[] = [];
    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "droid",
      model: "custom:claude-sonnet-5-thinking-32000",
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
      interactionMode: "plan",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "Draft a Droid spec.",
    }, { awaitDispatch: true });

    await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope => event.event.type === "done" && event.sessionId === session.id,
    );

    expect(mockState.droidAcquireCalls[0]?.settings).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
      interactionMode: "spec",
      specModeModelId: "custom:claude-sonnet-5-thinking-32000",
    });
    expect(mockState.droidSettingsUpdates.at(-1)).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
      interactionMode: "spec",
      specModeModelId: "custom:claude-sonnet-5-thinking-32000",
    });
  });

  it("resumes a Droid SDK session and applies the selected model during warmup", async () => {
    const { service } = createService();

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "droid",
      model: "custom:claude-sonnet-5-thinking-32000",
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
    });

    const persisted = readPersistedChatState(session.id);
    writePersistedChatState(session.id, {
      ...persisted,
      droidSdkSessionId: "persisted-droid-session-1",
    });

    await service.warmupModel({
      sessionId: session.id,
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
    });

    const updated = await service.getSessionSummary(session.id);

    expect(mockState.droidAcquireCalls[0]).toMatchObject({
      resumeSessionId: "persisted-droid-session-1",
      workspacePath: fs.realpathSync(tmpRoot),
    });
    expect(mockState.droidSettingsUpdates.at(-1)).toMatchObject({
      modelId: "custom:claude-sonnet-5-thinking-32000",
    });
    expect(mockState.droidNewSessionCalls).toHaveLength(0);
    expect(updated?.model).toBe("custom:claude-sonnet-5-thinking-32000");
    expect(updated?.modelId).toBe("droid/custom:claude-sonnet-5-thinking-32000");
  });

  it("surfaces structured Droid SDK failures without collapsing them to [object Object]", async () => {
    const events: AgentChatEventEnvelope[] = [];
    mockState.droidPromptError = {
      code: -32603,
      message: "Connection error.",
      data: "This might be a network issue. Please check your internet connection.",
    };

    const { service } = createService({
      onEvent: (event: AgentChatEventEnvelope) => events.push(event),
    });

    const session = await service.createSession({
      laneId: "lane-1",
      provider: "droid",
      model: "custom:claude-sonnet-5-thinking-32000",
      modelId: "droid/custom:claude-sonnet-5-thinking-32000",
    });

    await service.sendMessage({
      sessionId: session.id,
      text: "test",
    }, { awaitDispatch: true });

    const errorEvent = await waitForEvent(
      events,
      (event): event is AgentChatEventEnvelope & {
        event: Extract<AgentChatEventEnvelope["event"], { type: "error" }>;
      } => event.event.type === "error" && event.sessionId === session.id,
    );

    expect(errorEvent.event.message).toBe("Connection error.");
    expect(errorEvent.event.detail).toContain("network issue");
    expect(errorEvent.event.errorInfo).toMatchObject({
      category: "network",
      provider: "Factory Droid",
    });
  });

  describe("Cursor Cloud routing", () => {
    it("dispatches cloud.send.stream and persists cloud session fields on first cloud send", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Promote to cloud.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      const cloudCalls = mockState.cursorSdkCloudRequests.filter((r) => r.type === "cloud.send.stream");
      expect(cloudCalls.length).toBeGreaterThan(0);
      const sentPayload = cloudCalls[0].payload;
      expect(sentPayload.repoUrl).toBe("https://github.com/example/repo.git");
      expect(typeof sentPayload.promptText).toBe("string");
      expect(String(sentPayload.idempotencyKey ?? "")).toMatch(new RegExp(`^ade:${session.id}:.+:cursor-cloud:create$`));
      expect(sentPayload.mode).toBe("agent");

      const refreshed = await service.getSessionSummary(session.id);
      expect(refreshed?.cursorCloudAgentId).toBe("cloud-agent-1");
      expect(refreshed?.cursorRuntime).toBe("cloud");
      expect(refreshed?.cursorPromotedTurnId).toBeTruthy();
    });

    it("adopts Cursor Cloud auto-generated agent names and omits ADE defaults", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      mockState.cursorSdkCloudResponses.set("cloud.send.stream", {
        agentId: "cloud-agent-1",
        runId: "cloud-run-1",
        status: "finished",
        result: { status: "finished" },
        agentName: "Cursor Cloud Native Title",
      });
      const events: AgentChatEventEnvelope[] = [];
      const { service, sessionService } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Let Cursor Cloud name this.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );
      await waitForSessionTitle(sessionService, session.id, "Cursor Cloud Native Title");

      const sent = mockState.cursorSdkCloudRequests.find((r) => r.type === "cloud.send.stream");
      expect(sent?.payload.agentName).toBeUndefined();
      expect(sessionService.get(session.id)?.manuallyNamed).toBe(false);
    });

    it("uses cloud.followup with the durable agentId on subsequent cloud sends", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "First.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      // Drain previous done so we can wait for the next one cleanly.
      events.length = 0;
      await service.sendMessage({
        sessionId: session.id,
        text: "Follow-up.",
        runtime: "cloud",
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      const types = mockState.cursorSdkCloudRequests.map((r) => r.type);
      expect(types).toEqual(expect.arrayContaining(["cloud.send.stream", "cloud.followup"]));
      const followup = mockState.cursorSdkCloudRequests.find((r) => r.type === "cloud.followup");
      expect(followup?.payload.agentId).toBe("cloud-agent-1");
      expect(String(followup?.payload.idempotencyKey ?? "")).toContain(":cursor-cloud:followup");
      expect(followup?.payload.mode).toBe("agent");
    });

    it("surfaces Cursor SDK agent busy conflicts as busy cloud errors", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "First.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });
      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      mockState.cursorSdkCloudResponses.set("cloud.followup", Object.assign(
        new Error("Cursor SDK cloud.followup failed: Cursor agent is already running another task. (agent_busy)"),
        { code: "agent_busy" },
      ));
      events.length = 0;

      await service.sendMessage({
        sessionId: session.id,
        text: "Second.",
        runtime: "cloud",
      } as any, { awaitDispatch: true });

      const errorEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "error" }> } =>
          event.event.type === "error" && event.sessionId === session.id,
      );

      expect(errorEvent.event.message).toContain("already running this agent");
      expect(errorEvent.event.errorInfo).toMatchObject({
        category: "busy",
        provider: "Cursor Cloud",
      });
    });

    it("emits a 'done' event after a cloud send and flips session runtime to cloud", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Cloud, please.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });

      const doneEvent = await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );
      expect(doneEvent.event.status).toBe("completed");
      const summary = await service.getSessionSummary(session.id);
      expect(summary?.cursorRuntime).toBe("cloud");
    });

    it("includes the cursorSdkSystemPrompt directive in the first cloud send promptText", async () => {
      process.env.CURSOR_API_KEY = "cursor-test-key";
      process.env.ADE_CURSOR_PROMPT_INJECT = "1";
      const events: AgentChatEventEnvelope[] = [];
      const { service } = createService({
        onEvent: (event: AgentChatEventEnvelope) => events.push(event),
      });

      const session = await service.createSession({
        laneId: "lane-1",
        provider: "cursor",
        model: "composer-2",
        modelId: "cursor/composer-2",
      });

      await service.sendMessage({
        sessionId: session.id,
        text: "Hi cloud.",
        runtime: "cloud",
        cloudOverrides: { repoUrl: "https://github.com/example/repo.git" },
      } as any, { awaitDispatch: true });

      await waitForEvent(
        events,
        (event): event is AgentChatEventEnvelope & { event: Extract<AgentChatEventEnvelope["event"], { type: "done" }> } =>
          event.event.type === "done" && event.sessionId === session.id,
      );

      const sent = mockState.cursorSdkCloudRequests.find((r) => r.type === "cloud.send.stream");
      expect(sent).toBeTruthy();
      const promptText = String(sent!.payload.promptText ?? "");
      // System-prompt sections should be present
      expect(promptText).toContain("ADE control protocol");
      expect(promptText).toContain("Cursor Cloud capability");
      expect(promptText).toContain("runtime: cloud");
      expect(promptText.length).toBeLessThanOrEqual(promptText.indexOf("Hi cloud.") + 1024);
    });
  });
});

describe("suggestLaneNameFromPrompt", () => {
  function createProjectConfigServiceWithTitleOptions(
    options: { titleGenerationEnabled?: boolean; titleModelId?: string | null; legacyTitleModelId?: string } = {},
  ) {
    const titleOptions: Record<string, unknown> = {};
    if (typeof options.titleGenerationEnabled === "boolean") titleOptions.enabled = options.titleGenerationEnabled;
    if (options.titleModelId !== undefined) titleOptions.modelId = options.titleModelId;
    const sessionIntelligence = Object.keys(titleOptions).length ? { titles: titleOptions } : {};
    return {
      get: vi.fn(() => ({
        effective: {
          ai: {
            permissions: {
              cli: { mode: "edit" },
              inProcess: { mode: "edit" },
            },
            chat: {
              ...(options.legacyTitleModelId ? { autoTitleModelId: options.legacyTitleModelId } : {}),
            },
            sessionIntelligence,
          },
        },
      })),
      getAll: vi.fn(() => ({})),
      set: vi.fn(),
    } as any;
  }

  function createSuggestService(options: { titleGenerationEnabled?: boolean; titleModelId?: string | null; legacyTitleModelId?: string } = {}) {
    return createService({
      projectConfigService: createProjectConfigServiceWithTitleOptions(options),
    });
  }

  it("returns 'parallel-task' for an empty prompt", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("parallel-task");
  });

  it("returns 'parallel-task' for a whitespace-only prompt", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "   \t\n  ",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("parallel-task");
  });

  it("returns a slug from a short prompt via fallback (no auth = no models)", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix the login bug",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("fix-login-bug");
  });

  it("takes the first 5 meaningful words of a long prompt", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Refactor the authentication service to use JWT tokens",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("refactor-authentication-service-jwt-tokens");
  });

  it("strips special characters from the prompt slug", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix bug #123 in module!",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("fix-bug-123-module");
  });

  it("truncates the fallback slug to 48 characters", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "superlongwordthatexceedsfortyeightcharacterswhenalone secondword thirdword fourthword",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result.length).toBeLessThanOrEqual(48);
  });

  it("collapses multiple whitespace in the prompt", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "  fix   the   bug   now   please  ",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });
    expect(result).toBe("fix-bug-now");
  });

  it("falls back when the model runtime throws an error", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);

    const { service, logger, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockRejectedValue(new Error("API rate limited"));
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Write a test suite",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result).toBe("write-test-suite");
    expect(logger.warn).toHaveBeenCalledWith(
      "agent_chat.suggest_lane_name_failed",
      expect.objectContaining({ error: "API rate limited" }),
    );
  });

  it("uses the deterministic prompt fallback when title generation is disabled", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);

    const { service, aiIntegrationService } = createSuggestService({ titleGenerationEnabled: false });
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix the authentication login failure in the dashboard",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
      fallbackName: "chat-20260514-010203",
    });

    expect(result).toBe("fix-authentication-login-failure-dashboard");
    expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalled();
  });

  it("preserves the generated suffix when the prompt fallback is generic", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: "!!!",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
      fallbackName: "chat-20260514-010203",
    });

    expect(result).toBe("parallel-task-20260514-010203");
  });

  it("uses AI-generated name when the model runtime succeeds", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValue({
      text: "Login Bug Fix",
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix the authentication login failure in the dashboard",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result).toBe("login-bug-fix");
  });

  it("prefers the configured title model over the requested composer model", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "codex", authenticated: true, path: "/usr/bin/codex", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService({ titleModelId: "openai/gpt-5.4-mini" });
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: "Auto Create Lane Fix",
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix auto create lane routing and naming",
      modelId: "openai/gpt-5.5",
      laneId: "lane-1",
      fallbackName: "chat-20260514-010203",
    });

    expect(result).toBe("auto-create-lane-fix");
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "openai/gpt-5.4-mini",
      taskType: "session_title",
    }));
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to a legacy title model when session intelligence model is explicitly cleared", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService({
      titleModelId: null,
      legacyTitleModelId: "openai/gpt-5.4-mini",
    });
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValueOnce({
      text: "Fallback Title",
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Fix null model clearing for background jobs",
      modelId: "",
      laneId: "lane-1",
    });

    expect(result).toBe("fallback-title");
    expect(aiIntegrationService.summarizeTerminal).not.toHaveBeenCalledWith(expect.objectContaining({
      model: "openai/gpt-5.4-mini",
    }));
    expect(aiIntegrationService.summarizeTerminal).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: "anthropic/claude-haiku-4-5",
    }));
  });

  it("normalizes AI-generated name: strips special chars and lowercases", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValue({
      text: "JWT Auth Refactor!",
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Refactor auth to use JWT",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result).toBe("jwt-auth-refactor");
  });

  it("normalizes AI-generated name: truncates to 60 characters", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const longName = "a".repeat(70);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValue({
      text: longName,
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Do a very long task",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("trims edge hyphens after AI title truncation", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValue({
      text: `${"a".repeat(55)}- tail`,
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Trim the generated lane name",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result).toBe("a".repeat(55));
  });

  it("falls back when AI returns empty text after sanitization", async () => {
    vi.mocked(detectAllAuth).mockResolvedValue([
      { type: "cli-subscription" as any, cli: "claude", authenticated: true, path: "/usr/bin/claude", verified: true },
    ]);
    const { service, aiIntegrationService } = createSuggestService();
    vi.mocked(aiIntegrationService.summarizeTerminal).mockResolvedValue({
      text: "!!!",
      inputTokens: 10,
      outputTokens: 5,
    } as any);

    const result = await service.suggestLaneNameFromPrompt({
      prompt: "Something useful",
      modelId: "anthropic/claude-haiku-4-5",
      laneId: "lane-1",
    });

    expect(result).toBe("something-useful");
  });

  it("handles null/undefined args fields gracefully", async () => {
    const { service } = createSuggestService();
    const result = await service.suggestLaneNameFromPrompt({
      prompt: null as any,
      modelId: null as any,
      laneId: null as any,
    });
    expect(result).toBe("parallel-task");
  });
});
