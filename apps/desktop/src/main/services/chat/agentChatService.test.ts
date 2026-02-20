import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("ai", () => ({
  streamText: vi.fn()
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn()
  };
});

vi.mock("ai-sdk-provider-claude-code", () => ({
  createClaudeCode: vi.fn(() => {
    return (model: string, options: unknown) => ({
      specificationVersion: "v3",
      model,
      __options: options
    });
  })
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  unstable_v2_createSession: vi.fn(() => ({
    supportedModels: vi.fn(async () => []),
    close: vi.fn()
  }))
}));

vi.mock("../git/git", () => ({
  runGit: vi.fn(async () => ({
    exitCode: 0,
    stdout: "abc123\n",
    stderr: ""
  }))
}));

import { streamText } from "ai";
import { spawn } from "node:child_process";
import { runGit } from "../git/git";
import { createAgentChatService } from "./agentChatService";
import type {
  AgentChatEventEnvelope,
  AgentChatProvider,
  AgentChatSession,
  TerminalSessionStatus,
  TerminalToolType
} from "../../../shared/types";

type SessionRow = {
  id: string;
  laneId: string;
  laneName: string;
  ptyId: string | null;
  tracked: boolean;
  pinned: boolean;
  goal: string | null;
  toolType: TerminalToolType | null;
  title: string;
  status: TerminalSessionStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  transcriptPath: string;
  headShaStart: string | null;
  headShaEnd: string | null;
  lastOutputPreview: string | null;
  summary: string | null;
  runtimeState: "running" | "waiting-input" | "idle" | "exited" | "killed";
  resumeCommand: string | null;
};

type MockSessionService = ReturnType<typeof createMockSessionService>;

type CreatedFixture = {
  projectRoot: string;
  adeDir: string;
  transcriptsDir: string;
  laneWorktreePath: string;
  laneService: {
    getLaneBaseAndBranch: ReturnType<typeof vi.fn>;
  };
  projectConfigService: {
    get: ReturnType<typeof vi.fn>;
  };
  sessionService: MockSessionService;
  emitted: AgentChatEventEnvelope[];
  ended: Array<{ laneId: string; sessionId: string; exitCode: number | null }>;
  service: ReturnType<typeof createAgentChatService>;
};

type SentMessage = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

function createMockSessionService() {
  const rows = new Map<string, SessionRow>();

  const service = {
    __rows: rows,
    create: vi.fn((args: {
      sessionId: string;
      laneId: string;
      ptyId: string | null;
      tracked: boolean;
      title: string;
      startedAt: string;
      transcriptPath: string;
      toolType?: TerminalToolType | null;
      resumeCommand?: string | null;
    }) => {
      rows.set(args.sessionId, {
        id: args.sessionId,
        laneId: args.laneId,
        laneName: `Lane ${args.laneId}`,
        ptyId: args.ptyId,
        tracked: args.tracked,
        pinned: false,
        goal: null,
        toolType: args.toolType ?? null,
        title: args.title,
        status: "running",
        startedAt: args.startedAt,
        endedAt: null,
        exitCode: null,
        transcriptPath: args.transcriptPath,
        headShaStart: null,
        headShaEnd: null,
        lastOutputPreview: null,
        summary: null,
        runtimeState: "running",
        resumeCommand: args.resumeCommand ?? null
      });
    }),

    get: vi.fn((sessionId: string): SessionRow | null => rows.get(sessionId) ?? null),

    list: vi.fn((args: { laneId?: string; limit?: number } = {}): SessionRow[] => {
      const laneId = args.laneId?.trim();
      const all = [...rows.values()].filter((row) => (!laneId ? true : row.laneId === laneId));
      all.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      const limit = typeof args.limit === "number" ? args.limit : all.length;
      return all.slice(0, limit);
    }),

    reopen: vi.fn((sessionId: string) => {
      const row = rows.get(sessionId);
      if (!row) return;
      row.status = "running";
      row.endedAt = null;
      row.exitCode = null;
      row.runtimeState = "running";
    }),

    setHeadShaStart: vi.fn((sessionId: string, sha: string) => {
      const row = rows.get(sessionId);
      if (!row) return;
      row.headShaStart = sha;
    }),

    setHeadShaEnd: vi.fn((sessionId: string, sha: string) => {
      const row = rows.get(sessionId);
      if (!row) return;
      row.headShaEnd = sha;
    }),

    setLastOutputPreview: vi.fn((sessionId: string, preview: string) => {
      const row = rows.get(sessionId);
      if (!row) return;
      row.lastOutputPreview = preview;
    }),

    setSummary: vi.fn((sessionId: string, summary: string | null) => {
      const row = rows.get(sessionId);
      if (!row) return;
      row.summary = summary;
    }),

    setResumeCommand: vi.fn((sessionId: string, resumeCommand: string | null) => {
      const row = rows.get(sessionId);
      if (!row) return;
      row.resumeCommand = resumeCommand;
    }),

    end: vi.fn((args: { sessionId: string; endedAt: string; exitCode: number | null; status: TerminalSessionStatus }) => {
      const row = rows.get(args.sessionId);
      if (!row) return;
      row.status = args.status;
      row.endedAt = args.endedAt;
      row.exitCode = args.exitCode;
      row.runtimeState = args.status === "running" ? "running" : args.status === "disposed" ? "killed" : "exited";
      row.ptyId = null;
    }),

    readTranscriptTail: vi.fn((transcriptPath: string, maxBytes: number) => {
      if (!transcriptPath || !fs.existsSync(transcriptPath)) return "";
      const data = fs.readFileSync(transcriptPath, "utf8");
      return data.length > maxBytes ? data.slice(-maxBytes) : data;
    })
  };

  return service;
}

function createMockCodexProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const proc = new EventEmitter() as any;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn(() => true);

  const sent: SentMessage[] = [];
  const handlers = new Map<string, (msg: SentMessage) => void>();

  let buffer = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim().length) continue;
      const parsed = JSON.parse(line) as SentMessage;
      sent.push(parsed);
      if (parsed.method && handlers.has(parsed.method)) {
        handlers.get(parsed.method)?.(parsed);
      }
    }
  });

  const writeOut = (payload: SentMessage) => {
    stdout.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    proc,
    sent,
    onRequest: (method: string, handler: (msg: SentMessage) => void) => {
      handlers.set(method, handler);
    },
    notify: (method: string, params?: unknown) => {
      writeOut({ jsonrpc: "2.0", method, params });
    },
    serverRequest: (id: string | number, method: string, params?: unknown) => {
      writeOut({ jsonrpc: "2.0", id, method, params });
    },
    respond: (id: string | number, result?: unknown) => {
      writeOut({ jsonrpc: "2.0", id, result });
    },
    reject: (id: string | number, message: string) => {
      writeOut({ jsonrpc: "2.0", id, error: { code: -32000, message } });
    }
  };
}

function makeFullStream(parts: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        yield part;
      }
    }
  };
}

function createFixture(provider: AgentChatProvider): CreatedFixture {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-agent-chat-tests-"));
  const adeDir = path.join(projectRoot, ".ade");
  const transcriptsDir = path.join(adeDir, "transcripts");
  const laneWorktreePath = path.join(projectRoot, "lane-worktree");

  fs.mkdirSync(adeDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(laneWorktreePath, { recursive: true });

  const laneService = {
    getLaneBaseAndBranch: vi.fn((laneId: string) => ({
      worktreePath: laneWorktreePath,
      baseRef: "main",
      branchRef: `feature/${laneId}`
    }))
  };

  const projectConfigService = {
    get: vi.fn(() => ({
      effective: {
        ai: {
          chat: {
            defaultApprovalPolicy: "approve_mutations",
            codexSandbox: "workspace-write",
            claudePermissionMode: "acceptEdits",
            sessionBudgetUsd: 10,
            sendOnEnter: true
          }
        }
      }
    }))
  };

  const sessionService = createMockSessionService();
  const emitted: AgentChatEventEnvelope[] = [];
  const ended: Array<{ laneId: string; sessionId: string; exitCode: number | null }> = [];

  const service = createAgentChatService({
    projectRoot,
    adeDir,
    transcriptsDir,
    laneService: laneService as any,
    sessionService: sessionService as any,
    projectConfigService: projectConfigService as any,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    } as any,
    appVersion: "0.0.0-test",
    onEvent: (event) => emitted.push(event),
    onSessionEnded: (entry) => ended.push(entry)
  });

  return {
    projectRoot,
    adeDir,
    transcriptsDir,
    laneWorktreePath,
    laneService,
    projectConfigService,
    sessionService,
    emitted,
    ended,
    service
  };
}

async function waitForEvent(events: AgentChatEventEnvelope[], predicate: (event: AgentChatEventEnvelope) => boolean) {
  await waitForCondition(() => {
    expect(events.some(predicate)).toBe(true);
  });
  return events.find(predicate) ?? null;
}

async function waitForCondition(
  assertion: () => void,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error("Timed out waiting for condition.");
}

const spawnMock = vi.mocked(spawn);
const runGitMock = vi.mocked(runGit);
const streamTextMock = vi.mocked(streamText);

describe("agentChatService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runGitMock.mockResolvedValue({ exitCode: 0, stdout: "abc123\n", stderr: "" } as any);
    streamTextMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("CodexChatBackend", () => {
    it("performs JSON-RPC handshake with initialize then initialized", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => {
        codex.respond(msg.id!, { serverInfo: { name: "codex" } });
      });
      codex.onRequest("thread/start", (msg) => {
        codex.respond(msg.id!, { thread: { id: "thread-1" } });
      });

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.3-codex"
      });

      expect(session.provider).toBe("codex");
      const initialize = codex.sent.find((entry) => entry.method === "initialize");
      expect(initialize).toBeTruthy();
      expect(initialize?.params?.clientInfo?.name).toBe("ade");
      expect(initialize?.params?.clientInfo?.title).toBe("ADE");

      const initializedIndex = codex.sent.findIndex((entry) => entry.method === "initialized");
      const initializeIndex = codex.sent.findIndex((entry) => entry.method === "initialize");
      expect(initializeIndex).toBeGreaterThanOrEqual(0);
      expect(initializedIndex).toBeGreaterThan(initializeIndex);

      await fixture.service.disposeAll();
    });

    it("sends thread/start with lane cwd, model, approval, and sandbox", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      let threadStart: SentMessage | null = null;

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => {
        threadStart = msg;
        codex.respond(msg.id!, { thread: { id: "thread-abc" } });
      });

      await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });

      expect(threadStart).toBeTruthy();
      expect(threadStart?.params?.cwd).toBe(fixture.laneWorktreePath);
      expect(threadStart?.params?.model).toBe("gpt-5.3-codex");
      expect(threadStart?.params?.approvalPolicy).toBe("on-request");
      expect(threadStart?.params?.sandbox).toBe("workspace-write");

      await fixture.service.disposeAll();
    });

    it("maps turn notifications into ChatEvents for sendMessage", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => {
        codex.respond(msg.id!, { turn: { id: "turn-1" } });

        codex.notify("item/agentMessage/delta", {
          turnId: "turn-1",
          itemId: "agent-1",
          delta: "Hello"
        });

        codex.notify("item/started", {
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "npm test",
            cwd: fixture.laneWorktreePath,
            status: "inProgress",
            aggregatedOutput: ""
          }
        });

        codex.notify("item/commandExecution/outputDelta", {
          turnId: "turn-1",
          itemId: "cmd-1",
          delta: "all good\n"
        });

        codex.notify("item/completed", {
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "npm test",
            cwd: fixture.laneWorktreePath,
            status: "completed",
            exitCode: 0,
            durationMs: 140,
            aggregatedOutput: "all good\n"
          }
        });

        codex.notify("item/started", {
          item: {
            id: "file-1",
            type: "fileChange",
            status: "inProgress",
            changes: [
              {
                path: "src/index.ts",
                kind: "add",
                diff: "+++ src/index.ts\n+export const ok = true;\n"
              }
            ]
          }
        });

        codex.notify("item/completed", {
          item: {
            id: "file-1",
            type: "fileChange",
            status: "completed",
            changes: [
              {
                path: "src/index.ts",
                kind: "add",
                diff: "+++ src/index.ts\n+export const ok = true;\n"
              }
            ]
          }
        });

        codex.notify("turn/completed", {
          turn: {
            id: "turn-1",
            status: "completed"
          }
        });
      });
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "Run checks" });

      await waitForEvent(fixture.emitted, (entry) => entry.event.type === "done");

      const eventTypes = fixture.emitted.map((entry) => entry.event.type);
      expect(eventTypes).toContain("text");
      expect(eventTypes).toContain("command");
      expect(eventTypes).toContain("file_change");
      expect(eventTypes).toContain("done");

      const turnStart = codex.sent.find((entry) => entry.method === "turn/start");
      expect(turnStart?.params?.threadId).toBe("thread-1");
      expect(turnStart?.params?.input?.[0]?.type).toBe("text");

      await fixture.service.disposeAll();
    });

    it("emits approval_request and sends accept decision response", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });

      codex.serverRequest(7001, "item/commandExecution/requestApproval", {
        itemId: "cmd-approval-1",
        command: "rm -rf tmp",
        cwd: fixture.laneWorktreePath,
        reason: "Needs user approval"
      });

      await waitForEvent(
        fixture.emitted,
        (entry) => entry.event.type === "approval_request" && entry.event.itemId === "cmd-approval-1"
      );

      await fixture.service.approveToolUse({
        sessionId: session.id,
        itemId: "cmd-approval-1",
        decision: "accept"
      });

      const response = codex.sent.find((entry) => entry.id === 7001 && Object.prototype.hasOwnProperty.call(entry, "result"));
      expect(response?.result?.decision).toBe("accept");

      await fixture.service.disposeAll();
    });

    it("sends turn/steer while turn is active", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => {
        codex.respond(msg.id!, { turn: { id: "turn-active" } });
      });
      codex.onRequest("turn/steer", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "start" });
      await fixture.service.steer({ sessionId: session.id, text: "refine" });

      const steerRequest = codex.sent.find((entry) => entry.method === "turn/steer");
      expect(steerRequest).toBeTruthy();
      expect(steerRequest?.params?.threadId).toBe("thread-1");
      expect(steerRequest?.params?.expectedTurnId).toBe("turn-active");
      expect(steerRequest?.params?.input?.[0]?.text).toBe("refine");

      await fixture.service.disposeAll();
    });

    it("sends turn/interrupt on interrupt", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => codex.respond(msg.id!, { turn: { id: "turn-active" } }));
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "start" });
      await fixture.service.interrupt({ sessionId: session.id });

      const interruptRequest = codex.sent.find((entry) => entry.method === "turn/interrupt");
      expect(interruptRequest?.params?.threadId).toBe("thread-1");
      expect(interruptRequest?.params?.turnId).toBe("turn-active");

      await fixture.service.disposeAll();
    });

    it("maps error notification with codexErrorInfo", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));

      await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });

      codex.notify("error", {
        turnId: "turn-err",
        error: {
          message: "Context exceeded",
          codexErrorInfo: {
            kind: "ContextWindowExceeded"
          }
        }
      });

      const errorEvent = await waitForEvent(fixture.emitted, (entry) => entry.event.type === "error");
      expect(errorEvent?.event.type).toBe("error");
      if (errorEvent?.event.type === "error") {
        expect(errorEvent.event.message).toContain("Context exceeded");
        expect(errorEvent.event.errorInfo).toContain("ContextWindowExceeded");
      }

      await fixture.service.disposeAll();
    });
  });

  describe("ClaudeChatBackend", () => {
    it("supports multi-turn messages and carries conversation context", async () => {
      const fixture = createFixture("claude");

      streamTextMock
        .mockImplementationOnce(() => ({
          fullStream: makeFullStream([
            { type: "text-delta", text: "hello" },
            { type: "finish", totalUsage: { inputTokens: 2, outputTokens: 3 } }
          ])
        }) as any)
        .mockImplementationOnce(() => ({
          fullStream: makeFullStream([
            { type: "text-delta", text: "next" },
            { type: "finish", totalUsage: { inputTokens: 4, outputTokens: 5 } }
          ])
        }) as any);

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "First" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "Second" });

      expect(streamTextMock).toHaveBeenCalledTimes(2);

      const firstInput = streamTextMock.mock.calls[0]?.[0] as any;
      const secondInput = streamTextMock.mock.calls[1]?.[0] as any;

      expect(firstInput.messages).toHaveLength(1);
      expect(secondInput.messages).toHaveLength(3);
      expect(secondInput.messages[2]?.content).toContain("Second");

      await fixture.service.disposeAll();
    });

    it("maps text-delta chunks into text ChatEvents", async () => {
      const fixture = createFixture("claude");

      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([
          { type: "text-delta", text: "A" },
          { type: "text-delta", text: "B" },
          { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 2 } }
        ])
      }) as any);

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "Go" });

      const textEvents = fixture.emitted.filter((entry) => entry.event.type === "text");
      expect(textEvents.map((entry) => (entry.event.type === "text" ? entry.event.text : "")).join("")).toContain("AB");

      await fixture.service.disposeAll();
    });

    it("routes tool approval through pending approval queue", async () => {
      const fixture = createFixture("claude");

      streamTextMock.mockImplementationOnce((input: any) => ({
        fullStream: {
          async *[Symbol.asyncIterator]() {
            const permission = await input.model.__options.canUseTool("Bash", { command: "ls" });
            yield { type: "text-delta", text: `tool:${permission.behavior}` };
            yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
          }
        }
      }) as any);

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const sendPromise = fixture.service.sendMessage({ sessionId: session.id, text: "Use a tool" });

      const approval = await waitForEvent(fixture.emitted, (entry) => entry.event.type === "approval_request");
      expect(approval?.event.type).toBe("approval_request");

      if (approval?.event.type === "approval_request") {
        await fixture.service.approveToolUse({
          sessionId: session.id,
          itemId: approval.event.itemId,
          decision: "accept"
        });
      }

      await sendPromise;

      const textEvent = fixture.emitted.find(
        (entry) => entry.event.type === "text" && entry.event.text.includes("tool:allow")
      );
      expect(textEvent).toBeTruthy();

      await fixture.service.disposeAll();
    });

    it("queues steer text and runs it as follow-up turn after completion", async () => {
      const fixture = createFixture("claude");
      let releaseFirstTurn: (() => void) | null = null;

      streamTextMock
        .mockImplementationOnce(() => ({
          fullStream: {
            async *[Symbol.asyncIterator]() {
              yield { type: "text-delta", text: "working" };
              await new Promise<void>((resolve) => {
                releaseFirstTurn = resolve;
              });
              yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
            }
          }
        }) as any)
        .mockImplementationOnce(() => ({
          fullStream: makeFullStream([
            { type: "text-delta", text: "steered" },
            { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }
          ])
        }) as any);

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const sendPromise = fixture.service.sendMessage({ sessionId: session.id, text: "initial" });

      await waitForEvent(fixture.emitted, (entry) => entry.event.type === "text" && entry.event.text.includes("working"));

      await fixture.service.steer({ sessionId: session.id, text: "follow-up steer" });
      releaseFirstTurn?.();
      await sendPromise;

      await waitForCondition(() => {
        expect(streamTextMock).toHaveBeenCalledTimes(2);
      });

      const secondInput = streamTextMock.mock.calls[1]?.[0] as any;
      expect(secondInput.messages[secondInput.messages.length - 1]?.content).toContain("follow-up steer");

      await fixture.service.disposeAll();
    });

    it("aborts active stream on interrupt and emits interrupted status", async () => {
      const fixture = createFixture("claude");
      let capturedSignal: AbortSignal | null = null;

      streamTextMock.mockImplementationOnce((input: any) => {
        capturedSignal = input.abortSignal;
        return {
          fullStream: {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                if (input.abortSignal.aborted) {
                  resolve();
                  return;
                }
                input.abortSignal.addEventListener("abort", () => resolve(), { once: true });
              });
              throw new Error("aborted");
            }
          }
        };
      });

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const sendPromise = fixture.service.sendMessage({ sessionId: session.id, text: "long-running" });

      await waitForCondition(() => {
        expect(capturedSignal).toBeTruthy();
      });

      await fixture.service.interrupt({ sessionId: session.id });
      await sendPromise;

      expect(capturedSignal?.aborted).toBe(true);
      const interrupted = fixture.emitted.find(
        (entry) => entry.event.type === "status" && entry.event.turnStatus === "interrupted"
      );
      expect(interrupted).toBeTruthy();

      await fixture.service.disposeAll();
    });

    it("persists session state and resumes with prior messages", async () => {
      const fixture = createFixture("claude");

      streamTextMock
        .mockImplementationOnce(() => ({
          fullStream: makeFullStream([
            { type: "text-delta", text: "first-response" },
            { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }
          ])
        }) as any)
        .mockImplementationOnce(() => ({
          fullStream: makeFullStream([
            { type: "text-delta", text: "second-response" },
            { type: "finish", totalUsage: { inputTokens: 2, outputTokens: 2 } }
          ])
        }) as any);

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "first-message" });
      await fixture.service.dispose({ sessionId: session.id });

      const metadataPath = path.join(fixture.adeDir, "chat-sessions", `${session.id}.json`);
      expect(fs.existsSync(metadataPath)).toBe(true);

      const persisted = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        messages?: Array<{ role: string; content: string }>;
      };
      expect((persisted.messages ?? []).length).toBeGreaterThanOrEqual(2);

      const resumedService = createAgentChatService({
        projectRoot: fixture.projectRoot,
        adeDir: fixture.adeDir,
        transcriptsDir: fixture.transcriptsDir,
        laneService: fixture.laneService as any,
        sessionService: fixture.sessionService as any,
        projectConfigService: fixture.projectConfigService as any,
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {}
        } as any,
        appVersion: "0.0.0-test",
        onEvent: (event) => fixture.emitted.push(event),
        onSessionEnded: (entry) => fixture.ended.push(entry)
      });

      await resumedService.resumeSession({ sessionId: session.id });
      await resumedService.sendMessage({ sessionId: session.id, text: "second-message" });

      const secondInput = streamTextMock.mock.calls[1]?.[0] as any;
      expect(secondInput.messages.length).toBeGreaterThanOrEqual(3);
      expect(secondInput.messages[0]?.content).toContain("first-message");

      await resumedService.disposeAll();
    });
  });

  describe("Session integration", () => {
    it("registers terminal_session rows with codex-chat and claude-chat tool types", async () => {
      const codexFixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);
      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-row" } }));

      await codexFixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      const codexCreateArgs = codexFixture.sessionService.create.mock.calls[0]?.[0];
      expect(codexCreateArgs.toolType).toBe("codex-chat");

      await codexFixture.service.disposeAll();

      const claudeFixture = createFixture("claude");
      await claudeFixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const claudeCreateArgs = claudeFixture.sessionService.create.mock.calls[0]?.[0];
      expect(claudeCreateArgs.toolType).toBe("claude-chat");

      await claudeFixture.service.disposeAll();
    });

    it("writes JSONL transcripts and appends ChatEvents", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => {
        codex.respond(msg.id!, { turn: { id: "turn-1" } });
        codex.notify("item/agentMessage/delta", { turnId: "turn-1", itemId: "agent-1", delta: "transcript line" });
        codex.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
      });
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "hello" });

      await waitForEvent(fixture.emitted, (entry) => entry.event.type === "done");

      const row = fixture.sessionService.__rows.get(session.id);
      expect(row).toBeTruthy();
      expect(row?.transcriptPath.endsWith(".chat.jsonl")).toBe(true);
      expect(fs.existsSync(row!.transcriptPath)).toBe(true);

      const transcript = fs.readFileSync(row!.transcriptPath, "utf8");
      const lines = transcript.trim().split(/\r?\n/).filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const parsed = JSON.parse(lines[0]!) as AgentChatEventEnvelope;
      expect(parsed.sessionId).toBe(session.id);

      await fixture.service.disposeAll();
    });

    it("disposes sessions through sessionService.end with summary and head sha metadata", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => {
        codex.respond(msg.id!, { turn: { id: "turn-1" } });
        codex.notify("item/agentMessage/delta", { turnId: "turn-1", itemId: "agent-1", delta: "preview output" });
      });
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "hello" });
      await fixture.service.dispose({ sessionId: session.id });

      expect(fixture.sessionService.end).toHaveBeenCalled();
      const endArg = fixture.sessionService.end.mock.calls.at(-1)?.[0];
      expect(endArg.sessionId).toBe(session.id);
      expect(endArg.status).toBe("disposed");

      const row = fixture.sessionService.__rows.get(session.id);
      expect(row?.lastOutputPreview).toContain("preview output");
      expect((row?.summary ?? "").toLowerCase()).toContain("session closed");
      expect(row?.headShaEnd).toBe("abc123");
    });
  });
});
