import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ text: "" })),
  streamText: vi.fn(),
  stepCountIs: vi.fn(() => () => false),
  tool: vi.fn((def: unknown) => def),
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

vi.mock("../git/git", () => ({
  runGit: vi.fn(async () => ({
    exitCode: 0,
    stdout: "abc123\n",
    stderr: ""
  }))
}));

vi.mock("../ai/authDetector", () => ({
  detectAllAuth: vi.fn(async () => [])
}));

import { generateText, streamText } from "ai";
import { spawn } from "node:child_process";
import { runGit } from "../git/git";
import { detectAllAuth } from "../ai/authDetector";
import * as providerResolver from "../ai/providerResolver";
import { createAgentChatService } from "./agentChatService";
import type {
  AgentChatEventEnvelope,
  AgentChatProvider,
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
  packService: {
    getProjectExport: ReturnType<typeof vi.fn>;
    getLaneExport: ReturnType<typeof vi.fn>;
    getConflictExport: ReturnType<typeof vi.fn>;
    getPlanExport: ReturnType<typeof vi.fn>;
    getFeatureExport: ReturnType<typeof vi.fn>;
    getMissionExport: ReturnType<typeof vi.fn>;
  };
  laneService: {
    getLaneBaseAndBranch: ReturnType<typeof vi.fn>;
  };
  projectConfigService: {
    get: ReturnType<typeof vi.fn>;
  };
  memoryService: {
    addMemory: ReturnType<typeof vi.fn>;
    searchMemories: ReturnType<typeof vi.fn>;
  };
  ctoStateService: {
    getIdentity: ReturnType<typeof vi.fn>;
    buildReconstructionContext: ReturnType<typeof vi.fn>;
    updateCoreMemory: ReturnType<typeof vi.fn>;
    appendSessionLog: ReturnType<typeof vi.fn>;
    appendSubordinateActivity: ReturnType<typeof vi.fn>;
  };
  workerAgentService: {
    getAgent: ReturnType<typeof vi.fn>;
    buildReconstructionContext: ReturnType<typeof vi.fn>;
    updateCoreMemory: ReturnType<typeof vi.fn>;
    appendSessionLog: ReturnType<typeof vi.fn>;
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

    updateMeta: vi.fn((args: {
      sessionId: string;
      title?: string;
      goal?: string | null;
      toolType?: TerminalToolType | null;
      resumeCommand?: string | null;
    }) => {
      const row = rows.get(args.sessionId);
      if (!row) return null;
      if (typeof args.title === "string" && args.title.trim().length) {
        row.title = args.title.trim();
      }
      if (args.goal !== undefined) {
        row.goal = args.goal ?? null;
      }
      if (args.toolType !== undefined) {
        row.toolType = args.toolType ?? null;
      }
      if (args.resumeCommand !== undefined) {
        row.resumeCommand = args.resumeCommand ?? null;
      }
      return row;
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

function createFixture(_provider: AgentChatProvider): CreatedFixture {
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
  const packService = {
    getProjectExport: vi.fn(async () => ({ content: "# Project\nLive export", truncated: false })),
    getLaneExport: vi.fn(async ({ laneId }: { laneId: string }) => ({ content: `# Lane\n${laneId}`, truncated: false })),
    getConflictExport: vi.fn(async ({ laneId }: { laneId: string }) => ({ content: `# Conflict\n${laneId}`, truncated: false })),
    getPlanExport: vi.fn(async ({ laneId }: { laneId: string }) => ({ content: `# Plan\n${laneId}`, truncated: false })),
    getFeatureExport: vi.fn(async ({ featureKey }: { featureKey: string }) => ({ content: `# Feature\n${featureKey}`, truncated: false })),
    getMissionExport: vi.fn(async ({ missionId }: { missionId: string }) => ({ content: `# Mission\n${missionId}`, truncated: false })),
  };
  const memoryService = {
    addMemory: vi.fn(() => ({
      id: "memory-1",
      createdAt: new Date().toISOString()
    })),
    searchMemories: vi.fn(() => [])
  };
  const ctoStateService = {
    getIdentity: vi.fn(() => ({
      name: "CTO",
      version: 1,
      persona: "Persistent CTO",
      modelPreferences: {
        provider: "claude",
        model: "sonnet",
        modelId: "anthropic/claude-sonnet-4-6-cli",
        reasoningEffort: "high"
      },
      memoryPolicy: {
        autoCompact: true,
        compactionThreshold: 0.7,
        preCompactionFlush: true,
        temporalDecayHalfLifeDays: 30
      },
      updatedAt: new Date().toISOString()
    })),
    buildReconstructionContext: vi.fn(() => "CTO Identity\n- Name: CTO\nCore Memory\n- Project summary: test"),
    updateCoreMemory: vi.fn(() => ({
      identity: null,
      coreMemory: {
        version: 2,
        updatedAt: "2026-03-05T01:00:00.000Z",
        projectSummary: "test",
        criticalConventions: [],
        userPreferences: [],
        activeFocus: [],
        notes: []
      },
      recentSessions: []
    })),
    appendSessionLog: vi.fn(() => ({ id: "log-1" })),
    appendSubordinateActivity: vi.fn(() => ({ id: "subordinate-1" }))
  };
  const workerAgentService = {
    getAgent: vi.fn((agentId: string) => ({
      id: agentId,
      name: "Worker Agent",
      adapterType: "codex-local",
      adapterConfig: {
        model: "gpt-5.3-codex",
        modelId: "openai/gpt-5.3-codex"
      }
    })),
    buildReconstructionContext: vi.fn((agentId: string) => `Worker Identity\n- Id: ${agentId}\nCore Memory\n- Project summary: worker test`),
    updateCoreMemory: vi.fn(() => ({
      version: 2,
      updatedAt: "2026-03-05T01:00:00.000Z",
      projectSummary: "worker test",
      criticalConventions: [],
      userPreferences: [],
      activeFocus: [],
      notes: []
    })),
    appendSessionLog: vi.fn(() => ({ id: "worker-log-1" }))
  };
  const emitted: AgentChatEventEnvelope[] = [];
  const ended: Array<{ laneId: string; sessionId: string; exitCode: number | null }> = [];

  const service = createAgentChatService({
    projectRoot,
    adeDir,
    transcriptsDir,
    projectId: "project-1",
    memoryService: memoryService as any,
    packService: packService as any,
    ctoStateService: ctoStateService as any,
    workerAgentService: workerAgentService as any,
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
    packService,
    laneService,
    projectConfigService,
    memoryService,
    ctoStateService,
    workerAgentService,
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
const detectAllAuthMock = vi.mocked(detectAllAuth);
const generateTextMock = vi.mocked(generateText);
const streamTextMock = vi.mocked(streamText);

describe("agentChatService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runGitMock.mockResolvedValue({ exitCode: 0, stdout: "abc123\n", stderr: "" } as any);
    detectAllAuthMock.mockResolvedValue([]);
    generateTextMock.mockResolvedValue({ text: "" } as any);
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
      codex.onRequest("turn/start", (msg) => {
        codex.respond(msg.id!, { turn: { id: "turn-bootstrap" } });
      });
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.3-codex"
      });
      await fixture.service.sendMessage({ sessionId: session.id, text: "bootstrap" });

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

    it("sends thread/start with lane cwd, model, reasoning effort, approval, and sandbox", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      let threadStart: SentMessage | null = null;

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => {
        threadStart = msg;
        codex.respond(msg.id!, { thread: { id: "thread-abc" } });
      });
      codex.onRequest("turn/start", (msg) => {
        codex.respond(msg.id!, { turn: { id: "turn-thread-start" } });
      });
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.3-codex",
        reasoningEffort: "high"
      });
      await fixture.service.sendMessage({ sessionId: session.id, text: "boot-thread" });

      expect(threadStart).toBeTruthy();
      const threadStartParams = (threadStart as SentMessage | null)?.params as any;
      expect(threadStartParams?.cwd).toBe(fixture.laneWorktreePath);
      expect(threadStartParams?.model).toBe("gpt-5.3-codex");
      expect(threadStartParams?.reasoningEffort).toBe("high");
      expect(threadStartParams?.approvalPolicy).toBe("on-request");
      expect(threadStartParams?.sandbox).toBe("workspace-write");

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
      await fixture.service.sendMessage({ sessionId: session.id, text: "Run checks", reasoningEffort: "xhigh" });

      await waitForEvent(fixture.emitted, (entry) => entry.event.type === "done");

      const eventTypes = fixture.emitted.map((entry) => entry.event.type);
      expect(eventTypes).toContain("text");
      expect(eventTypes).toContain("command");
      expect(eventTypes).toContain("file_change");
      expect(eventTypes).toContain("done");

      const turnStart = codex.sent.find((entry) => entry.method === "turn/start");
      expect(turnStart?.params?.threadId).toBe("thread-1");
      expect(turnStart?.params?.input?.[0]?.type).toBe("text");
      expect(turnStart?.params?.reasoningEffort).toBe("xhigh");

      await fixture.service.disposeAll();
    });

    it("coalesces codex reasoning deltas into one activity and one reasoning event", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => {
        codex.respond(msg.id!, { turn: { id: "turn-reasoning" } });
        codex.notify("item/reasoning/textDelta", {
          turnId: "turn-reasoning",
          itemId: "reason-1",
          delta: "Plan ",
        });
        codex.notify("item/reasoning/textDelta", {
          turnId: "turn-reasoning",
          itemId: "reason-1",
          delta: "the fix",
        });
        codex.notify("turn/completed", {
          turn: {
            id: "turn-reasoning",
            status: "completed",
          }
        });
      });
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "Think it through" });

      const thinkingEvents = fixture.emitted.filter(
        (entry) => entry.event.type === "activity" && entry.event.activity === "thinking",
      );
      const reasoningEvents = fixture.emitted.filter((entry) => entry.event.type === "reasoning");

      expect(thinkingEvents).toHaveLength(1);
      expect(reasoningEvents).toHaveLength(1);
      expect((reasoningEvents[0]?.event as any)?.text).toBe("Plan the fix");

      await fixture.service.disposeAll();
    });

    it("keeps codex reasoning collapsed when the runtime rotates reasoning item ids inside one turn", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => {
        codex.respond(msg.id!, { turn: { id: "turn-rotating-reasoning" } });
        codex.notify("item/reasoning/textDelta", {
          turnId: "turn-rotating-reasoning",
          itemId: "reason-1",
          delta: "Map ",
        });
        codex.notify("item/reasoning/textDelta", {
          turnId: "turn-rotating-reasoning",
          itemId: "reason-2",
          delta: "the runtime",
        });
        codex.notify("turn/completed", {
          turn: {
            id: "turn-rotating-reasoning",
            status: "completed",
          }
        });
      });
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "Think it through" });

      const thinkingEvents = fixture.emitted.filter(
        (entry) => entry.event.type === "activity" && entry.event.activity === "thinking",
      );
      const reasoningEvents = fixture.emitted.filter((entry) => entry.event.type === "reasoning");

      expect(thinkingEvents).toHaveLength(1);
      expect(reasoningEvents).toHaveLength(1);
      expect((reasoningEvents[0]?.event as any)?.text).toBe("Map the runtime");

      await fixture.service.disposeAll();
    });

    it("injects the codex parallel launch directive without changing the visible user message", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      let turnStart: SentMessage | null = null;

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => {
        turnStart = msg;
        codex.respond(msg.id!, { turn: { id: "turn-parallel" } });
      });
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({
        sessionId: session.id,
        text: "Review the repo and fix the failing tests",
        displayText: "Review the repo and fix the failing tests",
        executionMode: "parallel",
      });

      const userMessage = fixture.emitted.find((entry) => entry.event.type === "user_message");
      const turnStartParams = (turnStart as { params?: { input?: Array<{ text?: string }> } } | null)?.params;
      expect(userMessage?.event.type).toBe("user_message");
      expect(userMessage?.event.type === "user_message" ? userMessage.event.text : "").toBe("Review the repo and fix the failing tests");
      expect(turnStartParams?.input?.[0]?.text).toContain("Use Codex parallel delegation");
      expect(turnStartParams?.input?.[0]?.text).toContain("User request:\nReview the repo and fix the failing tests");

      await fixture.service.disposeAll();
    });

    it("emits approval_request and sends accept decision response", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => codex.respond(msg.id!, { turn: { id: "turn-approval" } }));
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "boot-approval" });

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
      codex.onRequest("turn/start", (msg) => codex.respond(msg.id!, { turn: { id: "turn-error" } }));
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "boot-error" });

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
      expect(fixture.sessionService.get(session.id)?.summary).toBe("AB");

      await fixture.service.disposeAll();
    });

    it("coalesces Claude reasoning deltas into one activity and one reasoning event", async () => {
      const fixture = createFixture("claude");

      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([
          { type: "reasoning-delta", text: "Plan " },
          { type: "reasoning-delta", text: "the fix" },
          { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 2 } }
        ])
      }) as any);

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "Think it through" });

      const thinkingEvents = fixture.emitted.filter(
        (entry) => entry.event.type === "activity" && entry.event.activity === "thinking",
      );
      const reasoningEvents = fixture.emitted.filter((entry) => entry.event.type === "reasoning");

      expect(thinkingEvents).toHaveLength(1);
      expect(reasoningEvents).toHaveLength(1);
      expect((reasoningEvents[0]?.event as any)?.text).toBe("Plan the fix");

      await fixture.service.disposeAll();
    });

    it("injects the Claude teams launch directive without changing the visible user message", async () => {
      const fixture = createFixture("claude");

      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([
          { type: "text-delta", textDelta: "Ok" },
          { type: "finish", totalUsage: { inputTokens: 4, outputTokens: 2 } }
        ])
      }) as any);

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await fixture.service.sendMessage({
        sessionId: session.id,
        text: "Map the current architecture and suggest team-owned follow-ups",
        displayText: "Map the current architecture and suggest team-owned follow-ups",
        executionMode: "teams",
      });

      const call = streamTextMock.mock.calls[0]?.[0] as { messages?: Array<{ role?: string; content?: unknown }> } | undefined;
      const lastMessage = call?.messages?.[call.messages.length - 1];
      expect(typeof lastMessage?.content).toBe("string");
      expect(String(lastMessage?.content)).toContain("prefer coordinating through them for specialized work");

      const userMessage = fixture.emitted.find((entry) => entry.event.type === "user_message");
      expect(userMessage?.event.type).toBe("user_message");
      expect(userMessage?.event.type === "user_message" ? userMessage.event.text : "").toBe("Map the current architecture and suggest team-owned follow-ups");

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
      const release = releaseFirstTurn as (() => void) | null;
      if (!release) throw new Error("expected first turn release callback");
      release();
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

      streamTextMock.mockImplementationOnce(((input: any) => {
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
        } as any;
      }) as any);

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const sendPromise = fixture.service.sendMessage({ sessionId: session.id, text: "long-running" });

      await waitForCondition(() => {
        expect(capturedSignal).toBeTruthy();
      });

      await fixture.service.interrupt({ sessionId: session.id });
      await sendPromise;

      expect((capturedSignal as AbortSignal | null)?.aborted).toBe(true);
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

  describe("Model discovery and reasoning effort", () => {
    it("parses codex model/list reasoning efforts", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("model/list", (msg) => {
        codex.respond(msg.id!, {
          data: [
            {
              id: "gpt-5.3-codex",
              displayName: "GPT-5.3 Codex",
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "quick" },
                { reasoningEffort: "high", description: "deep" }
              ]
            }
          ]
        });
      });

      const models = await fixture.service.getAvailableModels({ provider: "codex" });
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]?.id).toBe("gpt-5.3-codex");
      expect(models[0]?.reasoningEfforts?.map((entry) => entry.effort)).toEqual(["low", "high"]);
      expect(models[0]?.displayName).toContain("Codex");

      await fixture.service.disposeAll();
    });

    it("adds descriptions for claude supported models", async () => {
      const fixture = createFixture("claude");

      const models = await fixture.service.getAvailableModels({ provider: "claude" });
      expect(models.length).toBeGreaterThan(0);
      expect(models.find((entry) => entry.id.includes("sonnet"))?.description).toContain("Balanced");

      await fixture.service.disposeAll();
    });

    it("persists reasoning effort in session metadata and listSessions", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);
      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => codex.respond(msg.id!, { turn: { id: "turn-1" } }));
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
        permissionMode: "edit"
      });

      await fixture.service.sendMessage({
        sessionId: session.id,
        text: "run checks",
        reasoningEffort: "xhigh"
      });

      const metadataPath = path.join(fixture.adeDir, "chat-sessions", `${session.id}.json`);
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        reasoningEffort?: string;
        modelId?: string;
        permissionMode?: string;
      };
      expect(metadata.reasoningEffort).toBe("xhigh");
      expect(metadata.modelId).toBe("openai/gpt-5.3-codex");
      expect(metadata.permissionMode).toBe("edit");

      const listed = await fixture.service.listSessions("lane-1");
      const summary = listed.find((entry) => entry.sessionId === session.id);
      expect(summary?.reasoningEffort).toBe("xhigh");
      expect(summary?.modelId).toBe("openai/gpt-5.3-codex");
      expect(summary?.permissionMode).toBe("edit");

      await fixture.service.disposeAll();
    });
  });

  describe("Codex threadResumed bug fix", () => {
    it("sends thread/resume when sendMessage has a persisted threadId but fresh runtime", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-persisted" } }));
      codex.onRequest("turn/start", (msg) => {
        codex.respond(msg.id!, { turn: { id: "turn-1" } });
        codex.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
      });
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      // Create session (sets threadResumed=true via thread/start)
      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "first" });
      await waitForEvent(fixture.emitted, (entry) => entry.event.type === "done");

      // Dispose to clear the runtime
      await fixture.service.dispose({ sessionId: session.id });

      // Now create a new process for the resumed session
      const codex2 = createMockCodexProcess();
      spawnMock.mockReturnValue(codex2.proc as any);

      codex2.onRequest("initialize", (msg) => codex2.respond(msg.id!, {}));
      codex2.onRequest("thread/resume", (msg) => codex2.respond(msg.id!, {}));
      codex2.onRequest("turn/start", (msg) => {
        codex2.respond(msg.id!, { turn: { id: "turn-2" } });
        codex2.notify("turn/completed", { turn: { id: "turn-2", status: "completed" } });
      });
      codex2.onRequest("turn/interrupt", (msg) => codex2.respond(msg.id!, {}));

      // sendMessage on disposed session will reopen it and start a fresh runtime
      await fixture.service.sendMessage({ sessionId: session.id, text: "after restart" });
      await waitForEvent(fixture.emitted, (entry) =>
        entry.event.type === "done" && entry.sessionId === session.id
      );

      // Verify thread/resume was called on the new runtime
      const resumeRequest = codex2.sent.find((entry) => entry.method === "thread/resume");
      expect(resumeRequest).toBeTruthy();
      expect(resumeRequest?.params?.threadId).toBe("thread-persisted");

      await fixture.service.disposeAll();
    });

    it("does not send thread/resume again on second sendMessage (threadResumed flag)", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      let turnCounter = 0;
      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => {
        turnCounter++;
        const turnId = `turn-${turnCounter}`;
        codex.respond(msg.id!, { turn: { id: turnId } });
        // Defer the completion notification so the turn/start response clears first
        setTimeout(() => {
          codex.notify("turn/completed", { turn: { id: turnId, status: "completed" } });
        }, 5);
      });
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });

      // First message
      await fixture.service.sendMessage({ sessionId: session.id, text: "first" });

      // Wait until the first turn's done event is emitted (turn/completed has been processed)
      await waitForEvent(fixture.emitted, (entry) => entry.event.type === "done");

      // Second message on the same runtime — activeTurnId should be cleared
      await fixture.service.sendMessage({ sessionId: session.id, text: "second" });
      await waitForEvent(fixture.emitted, (_entry) => {
        // Wait for the second done
        const dones = fixture.emitted.filter((e) => e.event.type === "done");
        return dones.length >= 2;
      });

      // thread/resume should never appear since threadResumed was set to true by thread/start
      const resumeRequests = codex.sent.filter((entry) => entry.method === "thread/resume");
      expect(resumeRequests.length).toBe(0);

      await fixture.service.disposeAll();
    });
  });

  describe("Claude reasoning effort", () => {
    it("returns reasoningEfforts array from Claude SDK model discovery", async () => {
      const fixture = createFixture("claude");

      const models = await fixture.service.getAvailableModels({ provider: "claude" });
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]?.reasoningEfforts).toBeTruthy();
      expect(models[0]?.reasoningEfforts?.length).toBeGreaterThan(0);
      expect(models[0]?.reasoningEfforts?.map((e) => e.effort)).toEqual(["low", "medium", "high", "max"]);

      await fixture.service.disposeAll();
    });

    it("maps Claude reasoning effort to maxThinkingTokens in streamText call", async () => {
      const fixture = createFixture("claude");

      streamTextMock.mockImplementationOnce((_input: any) => {
        return {
          fullStream: makeFullStream([
            { type: "text-delta", text: "thinking" },
            { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }
          ])
        } as any;
      });

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet", reasoningEffort: "high" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "deep think" });

      expect(streamTextMock).toHaveBeenCalledTimes(1);
      const callArg = streamTextMock.mock.calls[0]?.[0] as any;
      // The model is created via claudeProvider(resolvedModel, claudeOpts)
      // claudeOpts should contain maxThinkingTokens and the Claude Code preset
      const modelOpts = callArg.model?.__options;
      expect(modelOpts?.maxThinkingTokens).toBe(16384); // high = 16384
      expect(modelOpts?.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
      expect(modelOpts?.settingSources).toEqual(["user", "project", "local"]);

      await fixture.service.disposeAll();
    });

    it("falls back to medium for invalid Claude reasoning effort", async () => {
      const fixture = createFixture("claude");

      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([
          { type: "text-delta", text: "ok" },
          { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }
        ])
      }) as any);

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet", reasoningEffort: "invalid_effort" });
      expect(session.reasoningEffort).toBe("medium");

      await fixture.service.sendMessage({ sessionId: session.id, text: "test" });

      const callArg = streamTextMock.mock.calls[0]?.[0] as any;
      const modelOpts = callArg.model?.__options;
      expect(modelOpts?.maxThinkingTokens).toBe(4096); // medium = 4096

      await fixture.service.disposeAll();
    });
  });

  describe("Context packs", () => {
    it("listContextPacks returns live export options and keeps mission picker disabled", async () => {
      const fixture = createFixture("codex");
      const packs = await fixture.service.listContextPacks({ laneId: "lane-1" });

      const scopes = packs.map((p) => p.scope);
      expect(scopes).toContain("project");
      expect(scopes).toContain("lane");
      expect(scopes).toContain("conflict");
      expect(scopes).toContain("plan");
      expect(scopes).toContain("mission");

      expect(packs.find((pack) => pack.scope === "project")?.description).toContain("Live project context export");
      expect(packs.find((pack) => pack.scope === "mission")?.available).toBe(false);

      await fixture.service.disposeAll();
    });

    it("fetchContextPack returns live export content with correct structure", async () => {
      const fixture = createFixture("codex");
      const result = await fixture.service.fetchContextPack({ scope: "project" });

      expect(result.scope).toBe("project");
      expect(result.content).toContain("# Project");
      expect(typeof result.truncated).toBe("boolean");
      expect(fixture.packService.getProjectExport).toHaveBeenCalledWith({ level: "standard" });

      await fixture.service.disposeAll();
    });

    it("fetchContextPack maps renderer levels onto live export levels", async () => {
      const fixture = createFixture("codex");
      await fixture.service.fetchContextPack({ scope: "lane", laneId: "lane-1", level: "brief" });
      await fixture.service.fetchContextPack({ scope: "plan", laneId: "lane-1", level: "detailed" });

      expect(fixture.packService.getLaneExport).toHaveBeenCalledWith({ laneId: "lane-1", level: "lite" });
      expect(fixture.packService.getPlanExport).toHaveBeenCalledWith({ laneId: "lane-1", level: "deep" });

      await fixture.service.disposeAll();
    });
  });

  describe("finishSession cleanup", () => {
    it("kills the Codex process when session is disposed", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-1" } }));
      codex.onRequest("turn/start", (msg) => codex.respond(msg.id!, { turn: { id: "turn-dispose" } }));
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "codex", model: "gpt-5.3-codex" });
      await fixture.service.sendMessage({ sessionId: session.id, text: "boot-dispose" });
      await fixture.service.dispose({ sessionId: session.id });

      expect(codex.proc.kill).toHaveBeenCalled();
    });

    it("aborts the Claude abort controller when session is disposed", async () => {
      const fixture = createFixture("claude");
      let capturedSignal: AbortSignal | null = null;

      streamTextMock.mockImplementationOnce((input: any) => {
        capturedSignal = input.abortSignal;
        return {
          fullStream: {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                if (input.abortSignal.aborted) { resolve(); return; }
                input.abortSignal.addEventListener("abort", () => resolve(), { once: true });
              });
              throw new Error("aborted");
            }
          }
        } as any;
      });

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      const sendPromise = fixture.service.sendMessage({ sessionId: session.id, text: "long task" });

      await waitForCondition(() => {
        expect(capturedSignal).toBeTruthy();
      });

      await fixture.service.dispose({ sessionId: session.id });
      await sendPromise;

      expect((capturedSignal as AbortSignal | null)?.aborted).toBe(true);
    });
  });

  describe("CTO identity sessions", () => {
    it("persists identityKey/capabilityMode and reuses a stable CTO session", async () => {
      const fixture = createFixture("claude");

      const first = await fixture.service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-1"
      });
      const second = await fixture.service.ensureIdentitySession({
        identityKey: "cto",
        laneId: "lane-1"
      });

      expect(second.id).toBe(first.id);
      expect(first.identityKey).toBe("cto");
      expect(first.capabilityMode).toBe("full_mcp");

      const metadataPath = path.join(fixture.adeDir, "chat-sessions", `${first.id}.json`);
      const persisted = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        identityKey?: string;
        capabilityMode?: string;
      };
      expect(persisted.identityKey).toBe("cto");
      expect(persisted.capabilityMode).toBe("full_mcp");

      const listed = await fixture.service.listSessions("lane-1");
      expect(listed.find((entry) => entry.sessionId === first.id)?.identityKey).toBe("cto");
    });

    it("creates stable worker identity sessions keyed by agent id", async () => {
      const fixture = createFixture("claude");

      const first = await fixture.service.ensureIdentitySession({
        identityKey: "agent:worker-1",
        laneId: "lane-1"
      });
      const second = await fixture.service.ensureIdentitySession({
        identityKey: "agent:worker-1",
        laneId: "lane-1"
      });

      expect(second.id).toBe(first.id);
      expect(first.identityKey).toBe("agent:worker-1");
      expect(fixture.workerAgentService.getAgent).toHaveBeenCalledWith("worker-1", { includeDeleted: true });
    });

    it("injects reconstruction context on resumed CTO session startup", async () => {
      const fixture = createFixture("claude");
      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([{ type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }])
      }) as any);

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto"
      });
      await fixture.service.dispose({ sessionId: session.id });

      fixture.ctoStateService.buildReconstructionContext.mockClear();
      await fixture.service.resumeSession({ sessionId: session.id });
      await fixture.service.sendMessage({ sessionId: session.id, text: "status check" });

      expect(fixture.ctoStateService.buildReconstructionContext).toHaveBeenCalled();
      const streamInput = streamTextMock.mock.calls[0]?.[0] as any;
      expect(streamInput.messages[0]?.content).toContain("System context (identity reconstruction");
    });

    it("injects reconstruction context on resumed worker identity session startup", async () => {
      const fixture = createFixture("claude");
      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([{ type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }])
      }) as any);

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "agent:worker-2"
      });
      await fixture.service.dispose({ sessionId: session.id });

      fixture.workerAgentService.buildReconstructionContext.mockClear();
      await fixture.service.resumeSession({ sessionId: session.id });
      await fixture.service.sendMessage({ sessionId: session.id, text: "worker status check" });

      expect(fixture.workerAgentService.buildReconstructionContext).toHaveBeenCalledWith("worker-2", 8);
      const streamInput = streamTextMock.mock.calls[0]?.[0] as any;
      expect(streamInput.messages[0]?.content).toContain("System context (identity reconstruction");
      expect(streamInput.messages[0]?.content).toContain("worker test");
    });

    it("propagates direct worker chat completions into CTO subordinate activity", async () => {
      const fixture = createFixture("claude");
      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([
          { type: "text-delta", text: "I reviewed the mobile bug and the fix should land in the navigation stack." },
          { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }
        ])
      }) as any);

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "agent:mobile-dev"
      });
      await fixture.service.sendMessage({ sessionId: session.id, text: "please inspect the bug" });

      expect(fixture.ctoStateService.appendSubordinateActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "mobile-dev",
          agentName: "Worker Agent",
          activityType: "chat_turn",
          sessionId: session.id,
        })
      );
    });

    it("writes CTO session logs when a CTO session is disposed", async () => {
      const fixture = createFixture("claude");

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto"
      });

      await fixture.service.dispose({ sessionId: session.id });

      expect(fixture.ctoStateService.appendSessionLog).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          capabilityMode: "full_mcp",
          provider: "claude"
        })
      );
    });

    it("writes worker session logs when a worker identity session is disposed", async () => {
      const fixture = createFixture("claude");

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "agent:worker-3"
      });

      await fixture.service.dispose({ sessionId: session.id });

      expect(fixture.workerAgentService.appendSessionLog).toHaveBeenCalledWith(
        "worker-3",
        expect.objectContaining({
          sessionId: session.id,
          capabilityMode: "full_mcp",
          provider: "claude"
        })
      );
    });

    it("injects ADE MCP server config for Codex CTO sessions", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);
      let threadStart: SentMessage | null = null;

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => {
        threadStart = msg;
        codex.respond(msg.id!, { thread: { id: "thread-cto-codex" } });
      });
      codex.onRequest("turn/start", (msg) => codex.respond(msg.id!, { turn: { id: "turn-cto-codex" } }));
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.3-codex",
        identityKey: "cto"
      });
      await fixture.service.sendMessage({ sessionId: session.id, text: "boot" });

      const mcpServers = ((threadStart as any)?.params)?.mcpServers;
      expect(mcpServers?.ade?.command).toBeTruthy();
      expect(mcpServers?.ade?.transport).toBe("stdio");
      expect(mcpServers?.ade?.env?.ADE_PROJECT_ROOT).toBe(fixture.projectRoot);
      expect(mcpServers?.ade?.env?.ADE_DEFAULT_ROLE).toBe("cto");
    });

    it("injects worker owner identity into ADE MCP config for Codex worker sessions", async () => {
      const fixture = createFixture("codex");
      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);
      let threadStart: SentMessage | null = null;

      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => {
        threadStart = msg;
        codex.respond(msg.id!, { thread: { id: "thread-worker-codex" } });
      });
      codex.onRequest("turn/start", (msg) => codex.respond(msg.id!, { turn: { id: "turn-worker-codex" } }));
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.3-codex",
        identityKey: "agent:worker-4"
      });
      await fixture.service.sendMessage({ sessionId: session.id, text: "boot" });

      const mcpServers = ((threadStart as any)?.params)?.mcpServers;
      expect(mcpServers?.ade?.env?.ADE_DEFAULT_ROLE).toBe("agent");
      expect(mcpServers?.ade?.env?.ADE_OWNER_ID).toBe("worker-4");
    });

    it("injects ADE MCP server config for Claude CTO sessions", async () => {
      const fixture = createFixture("claude");
      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([{ type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }])
      }) as any);

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        identityKey: "cto"
      });
      await fixture.service.sendMessage({ sessionId: session.id, text: "boot" });

      const streamInput = streamTextMock.mock.calls[0]?.[0] as any;
      expect(streamInput.model?.__options?.mcpServers?.ade).toBeTruthy();
      expect(streamInput.model?.__options?.mcpServers?.ade?.type).toBe("stdio");
      expect(streamInput.model?.__options?.mcpServers?.ade?.env?.ADE_DEFAULT_ROLE).toBe("cto");
    });

    it("uses fallback tools (including memoryUpdateCore) for unified CTO sessions", async () => {
      const fixture = createFixture("unified");
      const resolveModelSpy = vi.spyOn(providerResolver, "resolveModel").mockResolvedValue({ id: "mock-model" } as any);
      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([{ type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }])
      }) as any);

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "anthropic/claude-sonnet-4-6-api",
        modelId: "anthropic/claude-sonnet-4-6-api",
        identityKey: "cto"
      });
      expect(session.capabilityMode).toBe("fallback");

      await fixture.service.sendMessage({ sessionId: session.id, text: "boot unified" });

      const streamInput = streamTextMock.mock.calls[0]?.[0] as any;
      const toolNames = Object.keys(streamInput.tools ?? {});
      expect(toolNames).toEqual(expect.arrayContaining(["memoryAdd", "memorySearch", "memoryUpdateCore"]));

      const updateResult = await streamInput.tools.memoryUpdateCore.execute({
        projectSummary: "Unified path update"
      });
      expect(fixture.ctoStateService.updateCoreMemory).toHaveBeenCalledWith(
        expect.objectContaining({ projectSummary: "Unified path update" })
      );
      expect(updateResult.updated).toBe(true);
      resolveModelSpy.mockRestore();
    });

    it("routes memoryUpdateCore to worker core memory for unified worker sessions", async () => {
      const fixture = createFixture("unified");
      const resolveModelSpy = vi.spyOn(providerResolver, "resolveModel").mockResolvedValue({ id: "mock-model" } as any);
      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([{ type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }])
      }) as any);

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "anthropic/claude-sonnet-4-6-api",
        modelId: "anthropic/claude-sonnet-4-6-api",
        identityKey: "agent:worker-9"
      });
      expect(session.capabilityMode).toBe("fallback");

      await fixture.service.sendMessage({ sessionId: session.id, text: "boot unified worker" });

      const streamInput = streamTextMock.mock.calls[0]?.[0] as any;
      const updateResult = await streamInput.tools.memoryUpdateCore.execute({
        projectSummary: "Worker unified path update"
      });
      expect(fixture.workerAgentService.updateCoreMemory).toHaveBeenCalledWith(
        "worker-9",
        expect.objectContaining({ projectSummary: "Worker unified path update" })
      );
      expect(updateResult.updated).toBe(true);
      resolveModelSpy.mockRestore();
    });

    it("routes askUser responses through the unified approval queue", async () => {
      const fixture = createFixture("unified");
      const resolveModelSpy = vi.spyOn(providerResolver, "resolveModel").mockResolvedValue({ id: "mock-model" } as any);

      streamTextMock.mockImplementationOnce((input: any) => ({
        fullStream: {
          async *[Symbol.asyncIterator]() {
            const result = await input.tools.askUser.execute({ question: "Which environment should I use?" });
            yield { type: "text-delta", text: `answer:${result.answer}` };
            yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
          }
        }
      }) as any);

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "anthropic/claude-sonnet-4-6-api",
        modelId: "anthropic/claude-sonnet-4-6-api",
      });

      const sendPromise = fixture.service.sendMessage({ sessionId: session.id, text: "Boot unified" });

      const approval = await waitForEvent(
        fixture.emitted,
        (entry) => entry.event.type === "approval_request" && entry.event.description.includes("Which environment should I use?")
      );
      expect(approval?.event.type).toBe("approval_request");

      if (approval?.event.type === "approval_request") {
        await fixture.service.approveToolUse({
          sessionId: session.id,
          itemId: approval.event.itemId,
          decision: "accept",
          responseText: "Use staging.",
        });
      }

      await sendPromise;

      const textEvent = fixture.emitted.find(
        (entry) => entry.event.type === "text" && entry.event.text.includes("answer:Use staging.")
      );
      expect(textEvent).toBeTruthy();
      resolveModelSpy.mockRestore();
    });

    it("routes unified bash approvals through ADE-managed approval flow", async () => {
      const fixture = createFixture("unified");
      const resolveModelSpy = vi.spyOn(providerResolver, "resolveModel").mockResolvedValue({ id: "mock-model" } as any);
      spawnMock.mockImplementation(() => {
        const proc = new EventEmitter() as any;
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.kill = vi.fn(() => true);
        queueMicrotask(() => {
          proc.stdout.write("approved");
          proc.stdout.end();
          proc.stderr.end();
          proc.emit("close", 0);
        });
        return proc;
      });

      streamTextMock.mockImplementation((input: any) => ({
        fullStream: {
          async *[Symbol.asyncIterator]() {
            const result = await input.tools.bash.execute({ command: "printf approved", timeout: 1_000 });
            yield { type: "text-delta", text: `bash:${result.exitCode}:${String(result.stdout ?? "").trim()}` };
            yield { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } };
          }
        }
      }) as any);

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "openai/gpt-5.4",
        modelId: "openai/gpt-5.4",
        permissionMode: "plan",
      });

      const firstSend = fixture.service.sendMessage({ sessionId: session.id, text: "Run a guarded command" });

      const approval = await waitForEvent(
        fixture.emitted,
        (entry) => entry.event.type === "approval_request" && entry.event.description.includes("Run command: printf approved")
      );
      expect(approval?.event.type).toBe("approval_request");

      if (approval?.event.type === "approval_request") {
        await fixture.service.approveToolUse({
          sessionId: session.id,
          itemId: approval.event.itemId,
          decision: "accept_for_session",
        });
      }

      await firstSend;

      const completedTurnsAfterFirstSend = fixture.emitted.filter(
        (entry) => entry.event.type === "done" && entry.event.status === "completed"
      ).length;
      expect(completedTurnsAfterFirstSend).toBeGreaterThan(0);

      const approvalCountAfterFirstSend = fixture.emitted.filter(
        (entry) => entry.event.type === "approval_request" && entry.event.description.includes("Run command: printf approved")
      ).length;
      expect(approvalCountAfterFirstSend).toBe(1);
      resolveModelSpy.mockRestore();
    });

    it("sends native file and image parts for unified streaming input", async () => {
      const fixture = createFixture("unified");
      const resolveModelSpy = vi.spyOn(providerResolver, "resolveModel").mockResolvedValue({ id: "mock-model" } as any);
      const imagePath = path.join(fixture.projectRoot, "diagram.png");
      const filePath = path.join(fixture.projectRoot, "notes.txt");
      fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      fs.writeFileSync(filePath, "project notes");

      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([
          { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }
        ])
      }) as any);

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "openai/gpt-5.4",
        modelId: "openai/gpt-5.4",
      });

      await fixture.service.sendMessage({
        sessionId: session.id,
        text: "Use these attachments",
        attachments: [
          { path: imagePath, type: "image" },
          { path: filePath, type: "file" },
        ],
      });

      const input = streamTextMock.mock.calls[0]?.[0] as any;
      const content = input.messages[0]?.content;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0]?.type).toBe("text");
      expect(content[0]?.text).toContain("Use these attachments");
      expect(content.some((part: any) => part.type === "image" && part.mediaType === "image/png")).toBe(true);
      expect(content.some((part: any) => part.type === "file" && part.filename === "notes.txt")).toBe(true);
      resolveModelSpy.mockRestore();
    });
  });

  describe("Streaming attachments", () => {
    it("sends native image parts for Claude while keeping file attachments visible as text context", async () => {
      const fixture = createFixture("claude");
      const imagePath = path.join(fixture.projectRoot, "diagram.png");
      const filePath = path.join(fixture.projectRoot, "notes.txt");
      fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      fs.writeFileSync(filePath, "project notes");

      streamTextMock.mockImplementationOnce(() => ({
        fullStream: makeFullStream([
          { type: "finish", totalUsage: { inputTokens: 1, outputTokens: 1 } }
        ])
      }) as any);

      const session = await fixture.service.createSession({ laneId: "lane-1", provider: "claude", model: "sonnet" });
      await fixture.service.sendMessage({
        sessionId: session.id,
        text: "Review these assets",
        attachments: [
          { path: imagePath, type: "image" },
          { path: filePath, type: "file" },
        ],
      });

      const input = streamTextMock.mock.calls[0]?.[0] as any;
      const content = input.messages[0]?.content;
      expect(Array.isArray(content)).toBe(true);
      expect(content.some((part: any) => part.type === "image" && part.mediaType === "image/png")).toBe(true);
      expect(content.some((part: any) => part.type === "text" && String(part.text ?? "").includes(`Attached file: ${filePath}`))).toBe(true);
      expect(input.model?.__options?.streamingInput).toBe("always");
    });
  });

  describe("Auto titles", () => {
    it("generates a chat title after the first user message when enabled", async () => {
      const fixture = createFixture("codex");
      fixture.projectConfigService.get.mockReturnValue({
        effective: {
          ai: {
            chat: {
              defaultApprovalPolicy: "approve_mutations",
              codexSandbox: "workspace-write",
              claudePermissionMode: "acceptEdits",
              sessionBudgetUsd: 10,
              sendOnEnter: true,
              autoTitleEnabled: true,
              autoTitleModelId: "openai/codex-mini-latest",
              autoTitleRefreshOnComplete: true,
            },
          },
        },
      });

      detectAllAuthMock.mockResolvedValue([
        { type: "cli-subscription", cli: "codex", key: "subscription" } as any,
      ]);
      const resolveModelSpy = vi.spyOn(providerResolver, "resolveModel").mockResolvedValue({ id: "mock-model" } as any);
      generateTextMock.mockResolvedValue({ text: "Fix chat selection bug" } as any);

      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);
      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-auto-title" } }));
      codex.onRequest("turn/start", (msg) => codex.respond(msg.id!, { turn: { id: "turn-auto-title" } }));

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.3-codex",
      });

      await fixture.service.sendMessage({ sessionId: session.id, text: "Please fix the chat selection bug." });
      await waitForCondition(() => {
        expect(fixture.sessionService.updateMeta).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: session.id,
            title: "Fix chat selection bug",
          }),
        );
      });

      resolveModelSpy.mockRestore();
    });

    it("ignores low-signal completion titles when refreshing the title on dispose", async () => {
      const fixture = createFixture("codex");
      fixture.projectConfigService.get.mockReturnValue({
        effective: {
          ai: {
            chat: {
              defaultApprovalPolicy: "approve_mutations",
              codexSandbox: "workspace-write",
              claudePermissionMode: "acceptEdits",
              sessionBudgetUsd: 10,
              sendOnEnter: true,
              autoTitleEnabled: true,
              autoTitleModelId: "openai/codex-mini-latest",
              autoTitleRefreshOnComplete: true,
            },
          },
        },
      });

      detectAllAuthMock.mockResolvedValue([
        { type: "cli-subscription", cli: "codex", key: "subscription" } as any,
      ]);
      const resolveModelSpy = vi.spyOn(providerResolver, "resolveModel").mockResolvedValue({ id: "mock-model" } as any);
      generateTextMock
        .mockResolvedValueOnce({ text: "Fix chat selection bug" } as any)
        .mockResolvedValueOnce({ text: "Completed: READY." } as any);

      const codex = createMockCodexProcess();
      spawnMock.mockReturnValue(codex.proc as any);
      codex.onRequest("initialize", (msg) => codex.respond(msg.id!, {}));
      codex.onRequest("thread/start", (msg) => codex.respond(msg.id!, { thread: { id: "thread-auto-title-2" } }));
      codex.onRequest("turn/start", (msg) => codex.respond(msg.id!, { turn: { id: "turn-auto-title-2" } }));
      codex.onRequest("turn/interrupt", (msg) => codex.respond(msg.id!, {}));

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.3-codex",
      });

      await fixture.service.sendMessage({ sessionId: session.id, text: "Please fix the chat selection bug." });
      await waitForCondition(() => {
        expect(fixture.sessionService.updateMeta).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: session.id,
            title: "Fix chat selection bug",
          }),
        );
      });

      await fixture.service.dispose({ sessionId: session.id });
      await waitForCondition(() => {
        expect(generateTextMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      });

      const row = fixture.sessionService.__rows.get(session.id);
      expect(row?.title).toBe("Fix chat selection bug");

      resolveModelSpy.mockRestore();
    });
  });

  describe("Session integration", () => {
    it("retargets a dormant session across runtimes before the first send", async () => {
      const fixture = createFixture("codex");

      const session = await fixture.service.createSession({
        laneId: "lane-1",
        provider: "unified",
        model: "openai/gpt-4.1",
        modelId: "openai/gpt-4.1",
      });

      const updated = await fixture.service.updateSession({
        sessionId: session.id,
        modelId: "anthropic/claude-sonnet-4-6",
      });

      expect(updated.provider).toBe("claude");
      expect(updated.modelId).toBe("anthropic/claude-sonnet-4-6");
      expect(updated.model).toBe("sonnet");
      expect(fixture.sessionService.updateMeta).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          title: "Claude Chat",
          toolType: "claude-chat",
          resumeCommand: `chat:claude:${session.id}`,
        }),
      );
    });

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
      await waitForCondition(() => {
        expect(fs.existsSync(row!.transcriptPath)).toBe(true);
      });

      let lines: string[] = [];
      await waitForCondition(() => {
        const transcript = fs.readFileSync(row!.transcriptPath, "utf8");
        lines = transcript.trim().split(/\r?\n/).filter(Boolean);
        expect(lines.length).toBeGreaterThanOrEqual(2);
      });

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
      if (!endArg) throw new Error("expected sessionService.end to be called");
      expect(endArg.sessionId).toBe(session.id);
      expect(endArg.status).toBe("disposed");

      const row = fixture.sessionService.__rows.get(session.id);
      expect(row?.lastOutputPreview).toContain("preview output");
      expect((row?.summary ?? "").toLowerCase()).toContain("session closed");
      expect(row?.headShaEnd).toBe("abc123");
    });
  });
});
