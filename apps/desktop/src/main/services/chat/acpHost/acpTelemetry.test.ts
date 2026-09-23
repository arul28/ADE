/**
 * ACP telemetry: usage totals, context occupancy, served model, cost, plan
 * units, account, subagent usage, and compaction (reported and inferred).
 *
 * The Grok and Copilot cases replay real one-turn sessions captured on
 * 2026-09-23 (Grok CLI 1.0.40, Copilot CLI 1.0.88): every frame the agent sent,
 * re-emitted in order by the mock agent. The Copilot ledger row is the one
 * Copilot wrote to `session-store.db` for that same turn. Kimi is covered by
 * fixtures shaped after its 0.39.1 binary; it is not live-verified.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEvent, AgentChatSession } from "../../../../shared/types";
import { createCompactionEmitterState, mapLegacyCompactionEvent } from "../contextCompactionEmitter";
import {
  COPILOT_SERVED_MODEL_NOTE,
  copilotDialect,
  grokDialect,
  kimiDialect,
  qwenDialect,
} from "./acpDialects";
import { KIMI_CODE_GLOBAL_BASE_URL, kimiCodeOAuthKey } from "../../shared/kimiCodeLogin";
import { readGrokAccount, readKimiAccount, readQwenAccount } from "./acpDialects/acpAccounts";
import {
  createCopilotUsageLedger,
  readCopilotUsageRow,
  summarizeCopilotUsageRows,
  type CopilotLedgerIo,
} from "./acpDialects/copilotUsageLedger";
import {
  readGrokModelUsage,
  readGrokModelUsageRow,
  readGrokModelsUpdate,
  readGrokSessionNotification,
} from "./acpDialects/grokTelemetry";
import { qwenModelIdFromAgent, readQwenModelUpdate } from "./acpDialects/qwen";
import {
  createQwenUsageLedger,
  QWEN_USAGE_FILE_NAME_PATTERN,
  qwenLocalMonth,
  qwenUsageFile,
  qwenUsageFileName,
  readQwenUsageRow,
  summarizeQwenUsageRows,
} from "./acpDialects/qwenUsageLedger";
import { capability, type AcpDialect } from "./acpHostTypes";
import { ACP_METHOD, type AcpContentBlock } from "./acpProtocolTypes";
import { createAcpEventTranslator } from "./acpEventTranslator";
import { readAcpCompactionUpdate, readFiniteNumber, readTrimmedText } from "./acpTelemetryReaders";
import { createAcpSessionPool } from "./acpSessionPool";
import { openAcpSession, textPromptBlock } from "./acpSession";
import { createAcpTurnTelemetry } from "./acpTurnTelemetry";
import { createMockAcpAgent, respondWithSession, type MockAcpAgent } from "./mockAcpAgent";

const DEADLINE_MS = 3_000;
const fixturesDir = path.join(__dirname, "fixtures");

type CapturedFrame = { t: number; msg: Record<string, unknown> };

function loadCapture(name: string): CapturedFrame[] {
  return readFileSync(path.join(fixturesDir, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length)
    .map((line) => JSON.parse(line) as CapturedFrame);
}

async function withDeadline<T>(label: string, promise: Promise<T>, ms = DEADLINE_MS): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `ade-acp-${label}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openHarness(args: {
  dialect: AcpDialect;
  sessionId: string;
  configHome?: string;
  sessionNewExtra?: Record<string, unknown>;
  settledUsageWaitMs?: number;
  requestedModelId?: string;
  logger?: Parameters<typeof openAcpSession>[0]["logger"];
}): { agent: MockAcpAgent; events: AgentChatEvent[]; open: () => ReturnType<typeof openAcpSession> } {
  const agent = createMockAcpAgent();
  agent.on(ACP_METHOD.sessionNew, respondWithSession(args.sessionId, args.sessionNewExtra ?? {}));
  const events: AgentChatEvent[] = [];
  const pool = createAcpSessionPool();
  cleanups.push(() => pool.disposeAll("test teardown"));
  return {
    agent,
    events,
    open: () =>
      openAcpSession({
        dialect: args.dialect,
        cwd: "/lane/worktree",
        spawnPlan: args.dialect.buildSpawnPlan({
          binaryPath: `/usr/local/bin/${args.dialect.binaryNames[0]}`,
          cwd: "/lane/worktree",
          baseEnv: {},
          ...(args.configHome ? { configHome: args.configHome } : {}),
        }),
        sessionToken: "chat-1",
        pool,
        spawnOverride: () => agent.child,
        settledUsageWaitMs: args.settledUsageWaitMs ?? 20,
        ...(args.requestedModelId ? { requestedModelId: args.requestedModelId } : {}),
        ...(args.logger ? { logger: args.logger } : {}),
        callbacks: {
          onEvents: (batch) => events.push(...batch),
          onPermissionRequested: () => undefined,
          onPermissionSettled: () => undefined,
        },
      }),
  };
}

type SessionLogger = NonNullable<Parameters<typeof openAcpSession>[0]["logger"]>;

function testLogger(): SessionLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as SessionLogger & {
    warn: ReturnType<typeof vi.fn>;
  };
}

/**
 * The payloads of every ACP-specific served-model mismatch warning. There must
 * be none: the chat service logs the one warning, from `done.servedModel`.
 */
function acpMismatchWarnings(logger: { warn: ReturnType<typeof vi.fn> }): unknown[] {
  return logger.warn.mock.calls
    .filter(([key]) => key === "agent_chat.acp_served_model_mismatch")
    .map(([, payload]) => payload);
}

function prompt(session: Awaited<ReturnType<typeof openAcpSession>>, turnId = "turn-1") {
  return withDeadline(
    `turn ${turnId}`,
    session.prompt({ turnId, blocks: [textPromptBlock("go")] as AcpContentBlock[] }),
  );
}

/**
 * Replay a capture: every notification before the prompt result is re-sent
 * in order, then the captured result answers the prompt. Frames after the
 * result are sent on the next tick, where the real agent sent them.
 */
function replayPromptTurn(agent: MockAcpAgent, frames: CapturedFrame[], resultId: number, beforeResult?: () => void) {
  const resultIndex = frames.findIndex((frame) => frame.msg.id === resultId);
  const before = frames.slice(0, resultIndex).filter((frame) => typeof frame.msg.method === "string");
  const after = frames.slice(resultIndex + 1).filter((frame) => typeof frame.msg.method === "string");
  agent.on(ACP_METHOD.sessionPrompt, () => {
    for (const frame of before) agent.writeRaw(`${JSON.stringify(frame.msg)}\n`);
    beforeResult?.();
    setImmediate(() => {
      for (const frame of after) agent.writeRaw(`${JSON.stringify(frame.msg)}\n`);
    });
    return { result: frames[resultIndex].msg.result };
  });
}

type DatabaseSyncConstructor = new (dbPath: string) => DatabaseSyncType;
const requireFromCwd = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
const { DatabaseSync } = requireFromCwd("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

type LedgerRow = Record<string, string | number | null>;

const COPILOT_LEDGER_COLUMNS = [
  "id", "session_id", "turn_index", "agent_id", "parent_tool_call_id", "model", "input_tokens",
  "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_nano_aiu",
  "request_multiplier", "initiator", "created_at",
] as const;

/** A Copilot `session-store.db` with the real table's columns (the subset ADE reads). */
function createCopilotStore(copilotHome: string): { insert(row: LedgerRow): void } {
  mkdirSync(copilotHome, { recursive: true });
  const db = new DatabaseSync(path.join(copilotHome, "session-store.db"));
  db.exec(`create table assistant_usage_events (
    id integer primary key autoincrement, session_id text not null, turn_index integer,
    agent_id text, parent_tool_call_id text, model text not null, input_tokens integer,
    output_tokens integer, cache_read_tokens integer, cache_write_tokens integer,
    reasoning_tokens integer, total_nano_aiu integer, request_multiplier real, initiator text,
    created_at text)`);
  cleanups.push(() => db.close());
  return {
    insert: (row) => {
      const columns = COPILOT_LEDGER_COLUMNS.filter((column) => column in row);
      db.prepare(`insert into assistant_usage_events (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((column) => row[column] ?? null));
    },
  };
}

/** A stand-in store connection that answers every query with `rows`. */
function fakeStore(rows: LedgerRow[], exec: (sql: string) => void = () => undefined): ReturnType<CopilotLedgerIo["openDatabase"]> {
  return {
    exec,
    close: () => undefined,
    prepare: () => ({ all: () => rows, get: () => undefined, run: () => ({ changes: 0, lastInsertRowid: 0 }) }),
  } as unknown as ReturnType<CopilotLedgerIo["openDatabase"]>;
}

const GROK_CAPTURE_SESSION = "01a0cd33-eb83-7073-81fd-8b9df695ecd9";
const COPILOT_CAPTURE_SESSION = "74a58a1f-afd3-4310-9e75-888aeda92d62";

// ─────────────────────────────────────────────────────────────────────────────
// Grok
// ─────────────────────────────────────────────────────────────────────────────

describe("grok telemetry (live capture, CLI 1.0.40)", () => {
  it("replays a real turn into per-response context, turn totals, cost, served model, and account", async () => {
    const grokHome = tempDir("grok-home");
    // Shape of a `grok login` entry. Only `auth_mode` is ever read.
    writeFileSync(path.join(grokHome, "auth.json"), JSON.stringify({
      "https://auth.x.ai::client": { key: "not-a-real-token", auth_mode: "oidc", refresh_token: "not-real" },
    }));
    const harness = openHarness({ dialect: grokDialect, sessionId: GROK_CAPTURE_SESSION, configHome: grokHome });
    replayPromptTurn(harness.agent, loadCapture("grok.live-turn.jsonl"), 3);
    const session = await withDeadline("open", harness.open());
    const outcome = await prompt(session);

    // One `response_completed` → one live context sample: its input side,
    // against grok-4.5's 500k window from `_x.ai/models/update`.
    const contextEvents = harness.events.filter((event) => event.type === "context_usage");
    expect(contextEvents).toHaveLength(1);
    expect(contextEvents[0]).toMatchObject({
      type: "context_usage",
      origin: "live",
      turnId: "turn-1",
      usage: {
        totalTokens: 18_962 + 3_456,
        maxTokens: 500_000,
        // Two decimals, the shared live-context builder's rounding.
        percentage: 4.48,
        inputTokens: 18_962,
        outputTokens: 24,
        cacheReadTokens: 3_456,
        cacheCreationTokens: 0,
      },
    });

    expect(outcome.done).toEqual({
      usage: {
        // `turn_completed.inputTokens` is 22418 with the 3456 cache inside it.
        inputTokens: 18_962,
        outputTokens: 24,
        cacheReadTokens: 3_456,
        cacheCreationTokens: 0,
        reasoningTokens: 23,
        contextWindow: 500_000,
        contextTokens: 22_418,
        requestCount: 1,
      },
      costUsd: 132_956_320 / 1_000_000_000,
      costSource: "provider",
      // Asked for grok-4.5, served by grok-4.5-build.
      servedModel: "grok-4.5-build",
      account: { provider: "grok", kind: "subscription" },
    });
    expect(JSON.stringify(outcome.done)).not.toContain("not-a-real-token");
    // The exact per-response sample owns the meter; no tokens fallback row.
    expect(outcome.events).toEqual([]);
  });

  it("maps real subagent_spawned / subagent_finished payloads to subagent events with usage", async () => {
    const frames = readFileSync(path.join(fixturesDir, "grok.subagent-updates.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: { sessionId: string } });
    const sessionId = frames[0].params.sessionId;
    const harness = openHarness({ dialect: grokDialect, sessionId, configHome: tempDir("grok-empty") });
    harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
      for (const frame of frames) agent.emitNotification(frame.method, frame.params);
      return { result: { stopReason: "end_turn" } };
    });
    const session = await withDeadline("open", harness.open());
    await prompt(session);

    expect(harness.events.find((event) => event.type === "subagent_started")).toMatchObject({
      taskId: "01a06e72-55d5-7a10-a60d-970ff59cc161",
      agentType: "general-purpose",
      model: "grok-4.6",
      description: "Quality Track B review",
      turnId: "turn-1",
    });
    expect(harness.events.find((event) => event.type === "subagent_result")).toMatchObject({
      taskId: "01a06e72-55d5-7a10-a60d-970ff59cc161",
      status: "completed",
      summary: expect.stringContaining("Track B"),
      usage: { totalTokens: 86_854, toolUses: 39, durationMs: 312_327 },
      turnId: "turn-1",
    });
  });

  it("maps Grok's own auto-compaction onto one provider compaction with a shared id", () => {
    const telemetry = createAcpTurnTelemetry({
      providerId: "grok",
      inferCompaction: false,
      readAccount: () => ({ provider: "grok", kind: "unknown" }),
    });
    telemetry.beginTurn("turn-1");
    const read = (update: Record<string, unknown>) =>
      readGrokSessionNotification({ sessionId: "s", update }).signals.flatMap((signal) => telemetry.noteSignal(signal));
    const started = read({ sessionUpdate: "auto_compact_started", tokens_used: 410_000, context_window: 500_000 });
    const completed = read({ sessionUpdate: "auto_compact_completed", tokens_before: 410_000, tokens_after: 38_000 });
    expect(started[0]).toMatchObject({ type: "context_compact", state: "started", provider: "grok", detection: "provider", preTokens: 410_000 });
    expect(completed[0]).toMatchObject({
      type: "context_compact",
      state: "completed",
      detection: "provider",
      preTokens: 410_000,
      postTokens: 38_000,
      tokensRemoved: 372_000,
    });
    expect((completed[0] as { compactionId?: string }).compactionId)
      .toBe((started[0] as { compactionId?: string }).compactionId);
    // The post-compaction figure is the turn's context now.
    expect(telemetry.finishTurn({ promptUsage: null, local: null }).done.usage?.contextTokens).toBe(38_000);
  });

  it("ignores the spinner hint and other session-notification kinds", () => {
    expect(readGrokSessionNotification({ pending_interaction: { kind: "permission" } }).signals).toEqual([]);
    expect(readGrokSessionNotification({
      sessionId: "s",
      update: { sessionUpdate: "last_turn_summary", summary: "OK" },
    }).signals).toEqual([]);
  });

  it("reads the model catalog's windows and the requested model", () => {
    const [frame] = loadCapture("grok.live-turn.jsonl").filter((entry) => entry.msg.method === "_x.ai/models/update");
    expect(readGrokModelsUpdate(frame.msg.params)).toEqual({
      sessionId: null,
      signals: [{
        kind: "model_catalog",
        currentModelId: "grok-4.5",
        contextWindows: {
          "grok-4.7": 500_000,
          "grok-4.7-build-fast": 500_000,
          "grok-4.6": 500_000,
          "grok-4.5": 500_000,
        },
      }],
    });
  });

  it("reads one modelUsage entry per model, in either spelling, and folds them", () => {
    // `updates.jsonl` and the live notification share this shape; `input`
    // keeps the cache inside, as Grok wrote it.
    expect(readGrokModelUsageRow({
      inputTokens: 22_418, outputTokens: 24, reasoningTokens: 23, cachedReadTokens: 3_456,
      cacheCreationTokens: 0, totalTokens: 22_442, modelCalls: 1, costUsdTicks: 132_956_320,
    })).toEqual({
      input: 22_418, output: 24, reasoning: 23, cacheRead: 3_456, cacheWrite: 0, total: 22_442, calls: 1, costTicks: 132_956_320,
    });
    expect(readGrokModelUsageRow({ promptTokens: 100, completionTokens: 7, thoughtTokens: 5 }))
      .toEqual({ input: 100, output: 7, reasoning: 5 });
    expect(readGrokModelUsageRow({ modelCalls: 1 })).toBeNull();
    expect(readGrokModelUsageRow("not a row")).toBeNull();
    expect(readGrokModelUsage({
      "grok-4.5-build": { inputTokens: 900, outputTokens: 30 },
      "grok-4.5-mini": { promptTokens: 100, completionTokens: 5 },
    })).toEqual({ input: 1_000, output: 35, dominantModel: "grok-4.5-build" });
  });

  it("drops a payload that names another session on a pooled process", async () => {
    const harness = openHarness({ dialect: grokDialect, sessionId: "mine", configHome: tempDir("grok-empty") });
    harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
      agent.emitNotification("_x.ai/session_notification", {
        sessionId: "someone-else",
        update: { sessionUpdate: "response_completed", usage: { input_tokens: 10, output_tokens: 1 } },
      });
      return { result: { stopReason: "end_turn" } };
    });
    const session = await withDeadline("open", harness.open());
    const outcome = await prompt(session);
    expect(outcome.done.usage).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Copilot
// ─────────────────────────────────────────────────────────────────────────────

describe("copilot telemetry (live capture, CLI 1.0.88)", () => {
  const liveRows = (JSON.parse(readFileSync(path.join(fixturesDir, "copilot.usage-events.json"), "utf8")) as {
    rows: LedgerRow[];
  }).rows;

  it("replays a real turn and reads the turn's ledger row: served model, plan units, account", async () => {
    const copilotHome = tempDir("copilot-home");
    const store = createCopilotStore(copilotHome);
    // An earlier turn of the same session, written before this turn started,
    // must not be counted again. The column default's shape is accepted too.
    const earlier = new Date(Date.now() - 60_000).toISOString();
    store.insert({ ...liveRows[0], id: 30, created_at: earlier, total_nano_aiu: 999, request_multiplier: 3 });
    store.insert({ ...liveRows[0], id: 31, created_at: earlier.replace("T", " ").slice(0, 19), total_nano_aiu: 999 });
    const harness = openHarness({ dialect: copilotDialect, sessionId: COPILOT_CAPTURE_SESSION, configHome: copilotHome });
    replayPromptTurn(harness.agent, loadCapture("copilot.usage-turn.jsonl"), 3, () => {
      // Copilot writes the row as the request completes, before the result,
      // stamped with its own clock.
      store.insert({ ...liveRows[0], created_at: new Date().toISOString() });
      // Another chat's session in the same store.
      store.insert({ ...liveRows[0], id: 34, session_id: "another-session", created_at: new Date().toISOString() });
    });
    const session = await withDeadline("open", harness.open());
    const outcome = await prompt(session);

    expect(harness.events.find((event) => event.type === "context_usage")).toMatchObject({
      usage: { totalTokens: 15_329, maxTokens: 128_000 },
      turnId: "turn-1",
    });
    expect(outcome.done).toEqual({
      usage: {
        // The prompt result's 14160 input includes the 1152 cache read; the
        // row's own token_details_json bills 13008 as input.
        inputTokens: 13_008,
        outputTokens: 5,
        cacheReadTokens: 1_152,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        contextWindow: 128_000,
        contextTokens: 15_329,
        requestCount: 1,
      },
      // The session had no model set; Copilot picked this one.
      servedModel: "mai-code-1.1-flash",
      account: { provider: "copilot", kind: "subscription" },
      planUsage: [
        { unit: "premium_request", amount: 1 },
        { unit: "nano_aiu", amount: 236_757_600 },
      ],
      // The totals are the ledger's row, read back after the turn.
      usageConfidence: "derived",
    });
    expect(outcome.events).toEqual([]);
  });

  it("tells the user once, and hands the chat service the served model, when Copilot's Auto answers instead", async () => {
    // Live on 1.0.88 with a plan that includes only Auto: `--model` and
    // `session/set_model` asked for claude-haiku-4.5, and gpt-5.6-luna answered.
    const copilotHome = tempDir("copilot-auto");
    const store = createCopilotStore(copilotHome);
    const { id: _liveId, ...liveRow } = liveRows[0];
    const logger = testLogger();
    const harness = openHarness({
      dialect: copilotDialect,
      sessionId: "copilot-auto",
      configHome: copilotHome,
      requestedModelId: "claude-haiku-4.5",
      logger,
    });
    harness.agent.on(ACP_METHOD.sessionPrompt, () => {
      store.insert({ ...liveRow, session_id: "copilot-auto", model: "gpt-5.6-luna", created_at: new Date().toISOString() });
      return { result: { stopReason: "end_turn" } };
    });
    const session = await withDeadline("open", harness.open());
    const first = await prompt(session, "turn-1");
    const second = await prompt(session, "turn-2");

    expect(first.done.servedModel).toBe("gpt-5.6-luna");
    expect(second.done.servedModel).toBe("gpt-5.6-luna");
    expect(first.events.filter((event) => event.type === "system_notice")).toEqual([{
      type: "system_notice",
      noticeKind: "warning",
      severity: "warning",
      message: "GitHub Copilot answered with gpt-5.6-luna, not claude-haiku-4.5.",
      detail: COPILOT_SERVED_MODEL_NOTE,
      turnId: "turn-1",
    }]);
    expect(second.events.filter((event) => event.type === "system_notice")).toEqual([]);
    // One warning per turn, and it is the chat service's, not a second ACP one.
    expect(acpMismatchWarnings(logger)).toEqual([]);
  });

  it("stays silent when the chat asked Copilot for Auto, and speaks for another model", () => {
    const notices = (requestedModelId: string, served: string) => {
      const telemetry = createAcpTurnTelemetry({
        providerId: "copilot",
        inferCompaction: true,
        requestedModelId,
        providerLabel: "GitHub Copilot",
        readAccount: () => ({ provider: "copilot", kind: "subscription" }),
      });
      telemetry.beginTurn("turn");
      const { events } = telemetry.finishTurn({
        promptUsage: null,
        local: summarizeCopilotUsageRows([{ model: served, input_tokens: 10, output_tokens: 1 }]),
      });
      return events.filter((event) => event.type === "system_notice");
    };
    expect(notices("auto", "gpt-5.6-luna")).toEqual([]);
    expect(notices("gpt-5.4", "gpt-5.4")).toEqual([]);
    expect(notices("gpt-5.4", "gpt-5.6-luna")).toHaveLength(1);
  });

  it("reports a /compact turn from the ledger: the compaction row, and totals the stale prompt result would have repeated", () => {
    // Live, 1.0.88: `/compact` answered with the previous turn's usage verbatim
    // and sent no ACP compaction update; the ledger held one
    // `initiator = "compaction"` row for the summary request.
    const telemetry = createAcpTurnTelemetry({
      providerId: "copilot",
      inferCompaction: true,
      readAccount: () => ({ provider: "copilot", kind: "subscription" }),
    });
    telemetry.beginTurn("turn-2");
    const stalePromptUsage = { inputTokens: 3, outputTokens: 5, cacheWriteTokens: 15_159, totalTokens: 15_167 };
    const { done, events } = telemetry.finishTurn({
      promptUsage: stalePromptUsage,
      local: summarizeCopilotUsageRows([
        { model: "gpt-5.6-luna", input_tokens: 16_235, output_tokens: 444, cache_read_tokens: 15_087, cache_write_tokens: 1_073, initiator: "compaction" },
      ]),
    });
    expect(done.usage).toMatchObject({ inputTokens: 75, outputTokens: 444, cacheReadTokens: 15_087, cacheCreationTokens: 1_073 });
    expect(done.usageConfidence).toBe("derived");
    expect(events).toEqual([expect.objectContaining({
      type: "context_compact",
      state: "completed",
      detection: "provider",
      provider: "copilot",
      preTokens: 16_235,
      turnId: "turn-2",
    })]);
    // The 444 output tokens are the summary, not the context that follows.
    expect(events[0]).not.toHaveProperty("postTokens");
    expect(events[0]).not.toHaveProperty("tokensRemoved");
  });

  it("counts a /compact once when the context drop already published an inferred compaction", () => {
    const telemetry = createAcpTurnTelemetry({
      providerId: "copilot",
      inferCompaction: true,
      hasLocalUsage: true,
      readAccount: () => ({ provider: "copilot", kind: "subscription" }),
    });
    const emitter = createCompactionEmitterState();
    const session = { provider: "copilot" } as AgentChatSession;
    const compactions = (events: AgentChatEvent[]) => events
      .map((event) => mapLegacyCompactionEvent(emitter, session, event))
      .filter((event): event is NonNullable<typeof event> => event !== null);

    telemetry.beginTurn("turn-1");
    telemetry.noteContextSample({ used: 150_000, size: 200_000 });
    telemetry.endTurn();

    // The `/compact` turn: Copilot's own usage_update shows the drop mid-turn,
    // and the ledger holds the summary request's `initiator = "compaction"` row.
    telemetry.beginTurn("turn-2");
    const live = compactions(telemetry.noteContextSample({ used: 30_000, size: 200_000 }));
    const end = telemetry.finishTurn({
      promptUsage: null,
      local: summarizeCopilotUsageRows([
        { model: "gpt-5.6-luna", input_tokens: 150_200, output_tokens: 900, initiator: "compaction" },
      ]),
    });
    const atEnd = compactions(end.events);
    expect(live).toEqual([expect.objectContaining({ detection: "inferred", state: "completed", turnId: "turn-2" })]);
    expect(atEnd).toEqual([]);
    expect(emitter.sessionCompactionCount).toBe(1);

    // A later turn whose compaction the drop did not reveal still reports it.
    telemetry.endTurn();
    telemetry.beginTurn("turn-3");
    const later = compactions(telemetry.finishTurn({
      promptUsage: null,
      local: summarizeCopilotUsageRows([{ model: "gpt-5.6-luna", input_tokens: 90_000, output_tokens: 700, initiator: "compaction" }]),
    }).events);
    expect(later).toEqual([expect.objectContaining({ detection: "provider", preTokens: 90_000, turnId: "turn-3" })]);
    expect(emitter.sessionCompactionCount).toBe(2);
  });

  it("folds rows: uncached input, agent follow-ups are not premium requests, subagents grouped", () => {
    const summary = summarizeCopilotUsageRows([
      { model: "claude-haiku-4.5", input_tokens: 18_530, output_tokens: 48, cache_read_tokens: 9_066, cache_write_tokens: 9_454, total_nano_aiu: 1_167_669_000, request_multiplier: 0.33, initiator: "user" },
      { model: "claude-haiku-4.5", input_tokens: 19_000, output_tokens: 20, cache_read_tokens: 18_500, cache_write_tokens: 0, total_nano_aiu: 30_000_000, request_multiplier: 0.33, initiator: "agent" },
      { model: "gpt-5.6-luna", agent_id: "agent-7", parent_tool_call_id: "call-1", input_tokens: 5_000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, total_nano_aiu: 10_000_000, request_multiplier: 1, initiator: "agent" },
      { model: "gpt-5.6-luna", agent_id: "agent-7", input_tokens: 6_000, output_tokens: 50, cache_read_tokens: 4_000, cache_write_tokens: 0, total_nano_aiu: 5_000_000, request_multiplier: 1, initiator: "agent" },
    ]);
    expect(summary).toMatchObject({
      usage: {
        inputTokens: 10 + 500,
        cacheReadTokens: 9_066 + 18_500,
        cacheWriteTokens: 9_454,
        outputTokens: 68,
      },
      requestCount: 2,
      servedModel: "claude-haiku-4.5",
      planUsage: [
        { unit: "premium_request", amount: 0.33 },
        { unit: "nano_aiu", amount: 1_167_669_000 + 30_000_000 + 10_000_000 + 5_000_000 },
      ],
      subagents: [{
        agentId: "agent-7",
        parentToolCallId: "call-1",
        model: "gpt-5.6-luna",
        usage: { inputTokens: 5_000 + 2_000, cacheReadTokens: 4_000, outputTokens: 150 },
      }],
    });
    expect(summarizeCopilotUsageRows([])).toBeNull();
  });

  it("reads one ledger row into its token split, for the usage history scanner too", () => {
    expect(readCopilotUsageRow({
      model: "claude-haiku-4.5", input_tokens: 18_530, output_tokens: 48, cache_read_tokens: 9_066,
      cache_write_tokens: 9_454, reasoning_tokens: 12,
    })).toEqual({
      inputTokens: 10,
      outputTokens: 48,
      cacheReadTokens: 9_066,
      cacheWriteTokens: 9_454,
      reasoningTokens: 12,
      totalTokens: 18_578,
    });
    // SQLite hands back a bigint for a large integer column.
    expect(readCopilotUsageRow({ input_tokens: BigInt(5), output_tokens: null })).toEqual({ inputTokens: 5, totalTokens: 5 });
    expect(readCopilotUsageRow({ model: "gpt-5.6-luna" })).toEqual({});
  });

  it("puts ledger subagent usage on done, never on a subagent event that would draw a card", () => {
    const telemetry = createAcpTurnTelemetry({
      providerId: "copilot",
      inferCompaction: true,
      hasLocalUsage: true,
      readAccount: () => ({ provider: "copilot", kind: "subscription" }),
    });
    telemetry.beginTurn("turn-9");
    const { done, events } = telemetry.finishTurn({
      promptUsage: null,
      local: summarizeCopilotUsageRows([
        { model: "gpt-5.6-luna", agent_id: "agent-7", parent_tool_call_id: "call-1", input_tokens: 5_000, output_tokens: 100, cache_read_tokens: 1_000, request_multiplier: 1, initiator: "agent" },
      ]),
    });
    expect(events).toEqual([]);
    expect(done.subagentUsage).toEqual([{
      agentId: "agent-7",
      model: "gpt-5.6-luna",
      parentToolUseId: "call-1",
      inputTokens: 4_000,
      outputTokens: 100,
      cacheReadTokens: 1_000,
      usageConfidence: "derived",
    }]);
  });

  it("reads nothing before the prompt, and never in the caller's synchronous path", async () => {
    let opens = 0;
    const ledger = createCopilotUsageLedger({
      sessionId: COPILOT_CAPTURE_SESSION,
      env: { COPILOT_HOME: "/nowhere" },
      io: {
        openDatabase: () => {
          opens += 1;
          return fakeStore(liveRows);
        },
      },
    });
    ledger.beginTurn();
    expect(opens).toBe(0);
    const pending = ledger.finishTurn();
    expect(opens).toBe(0);
    await expect(pending).resolves.toMatchObject({ servedModel: "mai-code-1.1-flash" });
    expect(opens).toBe(1);
  });

  it("asks SQLite never to wait on a lock, and retries a busy store on a timer, a bounded number of times", async () => {
    const pragmas: string[] = [];
    const delays: number[] = [];
    let opens = 0;
    const busy = Object.assign(new Error("database is locked"), { errcode: 5 });
    const busyTwiceThenOpen = createCopilotUsageLedger({
      sessionId: COPILOT_CAPTURE_SESSION,
      env: { COPILOT_HOME: "/nowhere" },
      io: {
        openDatabase: () => {
          opens += 1;
          if (opens <= 2) throw busy;
          return fakeStore(liveRows, (sql) => void pragmas.push(sql));
        },
        delay: async (ms) => void delays.push(ms),
      },
    });
    busyTwiceThenOpen.beginTurn();
    await expect(busyTwiceThenOpen.finishTurn()).resolves.toMatchObject({ servedModel: "mai-code-1.1-flash" });
    expect(delays).toEqual([0, 40, 40]);
    expect(pragmas).toEqual(["PRAGMA busy_timeout = 0"]);

    let alwaysBusyOpens = 0;
    const alwaysBusy = createCopilotUsageLedger({
      sessionId: COPILOT_CAPTURE_SESSION,
      env: { COPILOT_HOME: "/nowhere" },
      io: {
        openDatabase: () => {
          alwaysBusyOpens += 1;
          throw busy;
        },
        delay: async () => undefined,
      },
    });
    alwaysBusy.beginTurn();
    await expect(alwaysBusy.finishTurn()).resolves.toBeNull();
    expect(alwaysBusyOpens).toBe(3);

    // Anything but a lock will not change on a retry.
    let brokenOpens = 0;
    const broken = createCopilotUsageLedger({
      sessionId: COPILOT_CAPTURE_SESSION,
      env: { COPILOT_HOME: "/nowhere" },
      io: {
        openDatabase: () => {
          brokenOpens += 1;
          throw new Error("no such column: created_at");
        },
        delay: async () => undefined,
      },
    });
    broken.beginTurn();
    await expect(broken.finishTurn()).resolves.toBeNull();
    expect(brokenOpens).toBe(1);
  });

  it("marks a prompt-result fallback estimated when the ledger could not be read", async () => {
    // `/compact` answers with the previous turn's usage verbatim, so a prompt
    // result the ledger cannot vouch for is a guess.
    const harness = openHarness({ dialect: copilotDialect, sessionId: "s", configHome: tempDir("copilot-none") });
    harness.agent.on(ACP_METHOD.sessionPrompt, () => ({
      result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } },
    }));
    const session = await withDeadline("open", harness.open());
    const outcome = await prompt(session);
    expect(outcome.done.usage).toMatchObject({ inputTokens: 3, outputTokens: 5 });
    expect(outcome.done.usageConfidence).toBe("estimated");

    // A dialect with no ledger reports its prompt result as measured.
    const kimi = createAcpTurnTelemetry({ providerId: "kimi", inferCompaction: true, readAccount: () => ({ provider: "kimi", kind: "unknown" }) });
    kimi.beginTurn("turn-1");
    expect(kimi.finishTurn({ promptUsage: { inputTokens: 3, outputTokens: 5 }, local: null }).done.usageConfidence).toBeUndefined();
  });

  it("ends the turn with a plain done when telemetry throws, and logs it once", () => {
    const warn = vi.fn();
    const telemetry = createAcpTurnTelemetry({
      providerId: "copilot",
      inferCompaction: true,
      hasLocalUsage: true,
      readAccount: () => ({ provider: "copilot", kind: "subscription" }),
      logger: { warn },
    });
    const poisoned = {
      get usage(): never {
        throw new Error("ledger row shape changed");
      },
      subagents: [],
    };
    for (const turnId of ["turn-1", "turn-2"]) {
      telemetry.beginTurn(turnId);
      expect(telemetry.finishTurn({ promptUsage: { inputTokens: 1 }, local: poisoned })).toEqual({ done: {}, events: [] });
      telemetry.endTurn();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("agent_chat.acp_turn_telemetry_failed", expect.objectContaining({
      provider: "copilot",
      error: "ledger row shape changed",
    }));
  });

  it("resolves null when Copilot has no store yet", async () => {
    const ledger = createCopilotUsageLedger({ sessionId: "s", env: { COPILOT_HOME: tempDir("copilot-none") } });
    ledger.beginTurn();
    await expect(ledger.finishTurn()).resolves.toBeNull();
  });

  it("never holds the turn end hostage to a ledger that does not answer", async () => {
    const stuckDialect = {
      ...copilotDialect,
      localUsage: capability(() => ({ beginTurn: () => undefined, finishTurn: () => new Promise<never>(() => undefined) })),
    } as AcpDialect;
    const harness = openHarness({ dialect: stuckDialect, sessionId: "s" });
    harness.agent.on(ACP_METHOD.sessionPrompt, () => ({ result: { stopReason: "end_turn" } }));
    const session = await withDeadline("open", harness.open());
    const outcome = await prompt(session);
    expect(outcome.done.planUsage).toBeUndefined();
    expect(outcome.stopReason).toBe("end_turn");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Qwen
// ─────────────────────────────────────────────────────────────────────────────

describe("qwen telemetry", () => {
  const row = (overrides: Record<string, unknown>) => ({
    schemaVersion: 1,
    id: "row",
    timestamp: "2026-09-23T08:00:00.000Z",
    localDate: "2026-09-23",
    localMonth: "2026-09",
    sessionId: "qwen-session",
    model: "gpt-5.5",
    authType: "openai",
    source: "main",
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    apiDurationMs: 1_000,
    ...overrides,
  });

  it("reads the turn's ledger rows into derived totals, helper usage, and a local account", async () => {
    const qwenHome = tempDir("qwen-home");
    writeFileSync(path.join(qwenHome, "settings.json"), JSON.stringify({
      model: { name: "gpt-5.5", baseUrl: "http://localhost:8317/v1" },
      security: { auth: { selectedType: "openai" } },
    }));
    const usageFile = qwenUsageFile(path.join(qwenHome, "usage"), qwenLocalMonth(new Date()));
    mkdirSync(path.dirname(usageFile), { recursive: true });
    // An earlier turn of the same session: already counted, must not be again.
    writeFileSync(usageFile, `${JSON.stringify(row({ inputTokens: 99_999, outputTokens: 9 }))}\n`);

    const harness = openHarness({ dialect: qwenDialect, sessionId: "qwen-session", configHome: qwenHome });
    harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
      const append = (entry: Record<string, unknown>) => appendFileSync(usageFile, `${JSON.stringify(entry)}\n`);
      append(row({ inputTokens: 26_272, cachedTokens: 13_824, outputTokens: 5, totalTokens: 26_277 }));
      agent.emitUpdate("qwen-session", { sessionUpdate: "usage_update", used: 26_272, size: 272_000 });
      append(row({ inputTokens: 26_400, cachedTokens: 26_112, outputTokens: 40, thoughtsTokens: 12, totalTokens: 26_440 }));
      agent.emitUpdate("qwen-session", { sessionUpdate: "usage_update", used: 26_400, size: 272_000 });
      append(row({ source: "managed-auto-memory-extractor", inputTokens: 3_000, cachedTokens: 0, outputTokens: 200, totalTokens: 3_200 }));
      append(row({ sessionId: "another-session", inputTokens: 1_000, outputTokens: 1, totalTokens: 1_001 }));
      return { result: { stopReason: "end_turn" } };
    });
    const session = await withDeadline("open", harness.open());
    const outcome = await prompt(session);

    expect(outcome.done).toEqual({
      usage: {
        inputTokens: (26_272 - 13_824) + (26_400 - 26_112),
        outputTokens: 45,
        cacheReadTokens: 13_824 + 26_112,
        reasoningTokens: 12,
        contextWindow: 272_000,
        contextTokens: 26_400,
        requestCount: 2,
      },
      servedModel: "gpt-5.5",
      // A loopback base URL is a server on this machine: a local account,
      // reported by its origin only.
      account: { provider: "qwen", kind: "local", upstream: "openai", endpoint: "http://localhost:8317" },
      subagentUsage: [{
        agentId: "managed-auto-memory-extractor",
        label: "managed-auto-memory-extractor",
        model: "gpt-5.5",
        inputTokens: 3_000,
        outputTokens: 200,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        usageConfidence: "derived",
      }],
      usageConfidence: "derived",
    });
    // Helper usage is not a card in the transcript.
    expect(outcome.events).toEqual([]);
  });

  it("reads both month files when a turn crosses a month boundary", async () => {
    const qwenHome = tempDir("qwen-month");
    const dir = path.join(qwenHome, "usage");
    mkdirSync(dir, { recursive: true });
    let now = new Date(2026, 7, 31, 23, 59, 50);
    const ledger = createQwenUsageLedger({ sessionId: "qwen-session", env: { QWEN_HOME: qwenHome }, now: () => now });
    writeFileSync(qwenUsageFile(dir, "2026-08"), `${JSON.stringify(row({ inputTokens: 5, totalTokens: 5 }))}\n`);
    ledger.beginTurn();
    appendFileSync(qwenUsageFile(dir, "2026-08"), `${JSON.stringify(row({ inputTokens: 100, outputTokens: 1, totalTokens: 101 }))}\n`);
    now = new Date(2026, 8, 1, 0, 0, 10);
    writeFileSync(qwenUsageFile(dir, "2026-09"), `${JSON.stringify(row({ inputTokens: 200, outputTokens: 2, totalTokens: 202, model: "qwen3-coder-plus" }))}\n`);
    const summary = await ledger.finishTurn();
    expect(summary).toMatchObject({
      usage: { inputTokens: 300, outputTokens: 3 },
      requestCount: 2,
      servedModel: "qwen3-coder-plus",
    });
  });

  it("names the model from the model-update notification and strips the auth-type suffix", () => {
    expect(qwenModelIdFromAgent("gpt-5.5(openai)")).toBe("gpt-5.5");
    expect(qwenModelIdFromAgent("qwen3-coder-plus")).toBe("qwen3-coder-plus");
    expect(readQwenModelUpdate({ v: 1, sessionId: "s", currentModelId: "gpt-5.5(openai)" })).toEqual({
      sessionId: "s",
      signals: [{ kind: "current_model", modelId: "gpt-5.5" }],
    });
    expect(qwenDialect.extensionNotifications).toHaveProperty(["qwen/notify/session/model-update"]);
    expect(qwenDialect.extensionNotifications).toHaveProperty(["_qwen/notify/session/model-update"]);
  });

  it("summarizes nothing for no rows", () => {
    expect(summarizeQwenUsageRows([], () => ({ provider: "qwen", kind: "unknown" }))).toBeNull();
  });

  it("reads one ledger row into its token split, and names month files one way", () => {
    expect(readQwenUsageRow(row({ inputTokens: 26_400, cachedTokens: 26_112, outputTokens: 40, thoughtsTokens: 12, totalTokens: 26_440 })))
      .toEqual({ inputTokens: 288, cacheReadTokens: 26_112, outputTokens: 40, reasoningTokens: 12, totalTokens: 26_440 });
    expect(readQwenUsageRow({ outputTokens: 3 })).toEqual({ outputTokens: 3 });
    expect(qwenUsageFileName("2026-09")).toBe("token-usage-2026-09.jsonl");
    expect(qwenUsageFile("/q/usage", "2026-09")).toBe(path.join("/q/usage", "token-usage-2026-09.jsonl"));
    expect(QWEN_USAGE_FILE_NAME_PATTERN.test(qwenUsageFileName(qwenLocalMonth(new Date())))).toBe(true);
    expect(QWEN_USAGE_FILE_NAME_PATTERN.test("usage_record.jsonl")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Kimi (fixture-shaped after the 0.39.1 binary; not live-verified)
// ─────────────────────────────────────────────────────────────────────────────

describe("kimi telemetry", () => {
  const modelOption = (currentValue: string) => ({
    type: "select",
    id: "model",
    name: "Model",
    currentValue,
    options: [{ value: "kimi-k2-turbo-preview", name: "K2 Turbo" }, { value: "kimi-k2-thinking", name: "K2 Thinking" }],
  });

  it("reports the model from the model config option, including a mid-session change", async () => {
    const harness = openHarness({
      dialect: kimiDialect,
      sessionId: "01KIMI",
      configHome: tempDir("kimi-home"),
      sessionNewExtra: { configOptions: [modelOption("kimi-k2-turbo-preview")] },
    });
    harness.agent.on(ACP_METHOD.sessionPrompt, () => ({ result: { stopReason: "end_turn" } }));
    const session = await withDeadline("open", harness.open());
    expect((await prompt(session, "turn-1")).done.servedModel).toBe("kimi-k2-turbo-preview");

    harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
      agent.emitUpdate("01KIMI", {
        sessionUpdate: "config_option_update",
        configOptions: [modelOption("kimi-k2-thinking")] as never,
      });
      return { result: { stopReason: "end_turn" } };
    });
    const second = await prompt(session, "turn-2");
    expect(second.done.servedModel).toBe("kimi-k2-thinking");
    expect(second.done.account).toEqual({ provider: "kimi", kind: "unknown" });
  });

  it("stops waiting for a post-turn usage_update after one never came, and resumes once one does", async () => {
    const harness = openHarness({ dialect: kimiDialect, sessionId: "01KIMI", configHome: tempDir("kimi-wait") });
    let sendUsage = false;
    let late: Promise<void> = Promise.resolve();
    harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
      if (sendUsage) {
        late = new Promise((resolve) => setImmediate(() => {
          agent.emitUpdate("01KIMI", { sessionUpdate: "usage_update", used: 9_000, size: 256_000 });
          resolve();
        }));
      }
      return { result: { stopReason: "end_turn" } };
    });
    const session = await withDeadline("open", harness.open());
    // Turn 1: the wait times out; Kimi skipped the update.
    expect((await prompt(session, "turn-1")).done.usage).toBeUndefined();
    // Turn 2: no wait, so the late update misses this turn's `done`...
    sendUsage = true;
    expect((await prompt(session, "turn-2")).done.usage).toBeUndefined();
    await late;
    // ...but it proves Kimi sends them again, so turn 3 waits and gets it.
    expect((await prompt(session, "turn-3")).done.usage).toMatchObject({ contextTokens: 9_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Compaction
// ─────────────────────────────────────────────────────────────────────────────

describe("compaction", () => {
  const tracker = (inferCompaction = true) => {
    const telemetry = createAcpTurnTelemetry({
      providerId: "qwen",
      inferCompaction,
      readAccount: () => ({ provider: "qwen", kind: "unknown" }),
    });
    telemetry.beginTurn("turn-1");
    return telemetry;
  };

  it("infers one compaction when the context falls by more than 40% and more than 20k", () => {
    const telemetry = tracker();
    expect(telemetry.noteContextSample({ used: 100_000, size: 200_000 })).toEqual([]);
    expect(telemetry.noteContextSample({ used: 55_000, size: 200_000 })).toEqual([{
      type: "context_compact",
      trigger: "auto",
      state: "completed",
      detection: "inferred",
      provider: "qwen",
      preTokens: 100_000,
      postTokens: 55_000,
      tokensRemoved: 45_000,
      compactionId: "qwen-inferred-1",
      turnId: "turn-1",
    }]);
    // The new figure is the new baseline: a small further drop is nothing.
    expect(telemetry.noteContextSample({ used: 50_000, size: 200_000 })).toEqual([]);
  });

  it("stays quiet below either threshold", () => {
    const ratioTooSmall = tracker();
    ratioTooSmall.noteContextSample({ used: 100_000, size: 200_000 });
    // 35% and 35k: tokens pass, ratio does not.
    expect(ratioTooSmall.noteContextSample({ used: 65_000, size: 200_000 })).toEqual([]);

    const tokensTooFew = tracker();
    tokensTooFew.noteContextSample({ used: 30_000, size: 200_000 });
    // 60% but only 18k.
    expect(tokensTooFew.noteContextSample({ used: 12_000, size: 200_000 })).toEqual([]);
  });

  it("never infers across a model switch, a window change, or for a dialect that reports compactions", () => {
    const modelSwitch = tracker();
    modelSwitch.noteSignal({ kind: "current_model", modelId: "qwen3-coder-plus" });
    modelSwitch.noteContextSample({ used: 150_000, size: 200_000 });
    modelSwitch.noteSignal({ kind: "current_model", modelId: "gpt-5.5" });
    expect(modelSwitch.noteContextSample({ used: 20_000, size: 200_000 })).toEqual([]);

    const windowChange = tracker();
    windowChange.noteContextSample({ used: 150_000, size: 200_000 });
    expect(windowChange.noteContextSample({ used: 20_000, size: 1_000_000 })).toEqual([]);

    const grokLike = tracker(false);
    grokLike.noteContextSample({ used: 150_000, size: 200_000 });
    expect(grokLike.noteContextSample({ used: 20_000, size: 200_000 })).toEqual([]);
  });

  it("does not infer the drop that follows a compaction the provider reported", () => {
    const telemetry = tracker();
    telemetry.noteContextSample({ used: 150_000, size: 200_000 });
    telemetry.noteSignal({ kind: "compaction", state: "completed", compactionId: "cmp_001" });
    expect(telemetry.noteContextSample({ used: 20_000, size: 200_000 })).toEqual([]);
  });

  it("publishes an inferred compaction across turns on the session path, before the new sample", async () => {
    const harness = openHarness({ dialect: copilotDialect, sessionId: "s", configHome: tempDir("copilot-none") });
    let used = 150_000;
    harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
      agent.emitUpdate("s", { sessionUpdate: "usage_update", used, size: 200_000 });
      return { result: { stopReason: "end_turn" } };
    });
    const session = await withDeadline("open", harness.open());
    await prompt(session, "turn-1");
    used = 60_000;
    await prompt(session, "turn-2");
    const tail = harness.events.slice(-2);
    expect(tail[0]).toMatchObject({ type: "context_compact", detection: "inferred", preTokens: 150_000, postTokens: 60_000, turnId: "turn-2" });
    expect(tail[1]).toMatchObject({ type: "context_usage", usage: { totalTokens: 60_000 } });
  });

  it("maps the session-compaction RFD updates and ignores an unknown status and summary chunks", () => {
    expect(readAcpCompactionUpdate({ compactionId: "cmp_001", status: "in_progress" }))
      .toEqual({ kind: "compaction", state: "started", compactionId: "cmp_001" });
    expect(readAcpCompactionUpdate({ compactionId: "cmp_001", status: "cancelled" }))
      .toEqual({ kind: "compaction", state: "failed", failReason: "interrupted", compactionId: "cmp_001" });
    expect(readAcpCompactionUpdate({ compactionId: "cmp_001", status: "_vendor_state" })).toBeNull();

    const telemetry = tracker();
    const translator = createAcpEventTranslator({ callbacks: { onTelemetry: (signal) => telemetry.noteSignal(signal) } });
    translator.beginTurn("turn-1");
    expect(translator.translate({ sessionUpdate: "compaction_update", compactionId: "cmp_001", status: "in_progress" }))
      .toEqual([expect.objectContaining({ type: "context_compact", state: "started", compactionId: "cmp_001", detection: "provider", provider: "qwen" })]);
    expect(translator.translate({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "cmp_001",
      content: { type: "text", text: "## Retained context" },
    })).toEqual([]);
    expect(translator.translate({ sessionUpdate: "compaction_update", compactionId: "cmp_001", status: "completed" }))
      .toEqual([expect.objectContaining({ type: "context_compact", state: "completed", compactionId: "cmp_001" })]);
  });

  const initializeCapabilities = async (dialect: AcpDialect) => {
    const harness = openHarness({ dialect, sessionId: "s" });
    await withDeadline("open", harness.open());
    const initialize = harness.agent.received.find((entry) => entry.method === ACP_METHOD.initialize);
    return (initialize?.params as { clientCapabilities?: Record<string, unknown> }).clientCapabilities;
  };

  it.each([
    ["qwen", qwenDialect],
    ["kimi", kimiDialect],
    ["grok", grokDialect],
    ["copilot", copilotDialect],
  ] as const)("%s's handshake does not claim the compaction capability: telemetry leaves the agent's behavior alone", async (_id, dialect) => {
    // The handshake from before telemetry: no fs, no terminal, no session.
    expect(await initializeCapabilities(dialect)).toEqual({});
  });

  it("does not infer a compaction from a drop seen while the provider's own compaction is open", () => {
    const telemetry = tracker();
    telemetry.noteContextSample({ used: 150_000, size: 200_000 });
    telemetry.noteSignal({ kind: "compaction", state: "started", compactionId: "cmp_001" });
    expect(telemetry.noteContextSample({ used: 20_000, size: 200_000 })).toEqual([]);
    // The provider's report is the one compaction.
    expect(telemetry.noteSignal({ kind: "compaction", state: "completed", compactionId: "cmp_001" }))
      .toEqual([expect.objectContaining({ state: "completed", detection: "provider", compactionId: "cmp_001" })]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requested model and turn boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe("requested model", () => {
  it("reports servedModel only when the model that answered is not the one the session opened with", () => {
    const telemetry = createAcpTurnTelemetry({
      providerId: "copilot",
      inferCompaction: true,
      hasLocalUsage: true,
      requestedModelId: "claude-haiku-4.5",
      readAccount: () => ({ provider: "copilot", kind: "subscription" }),
    });
    const servedBy = (model: string) => {
      telemetry.beginTurn("turn");
      const { done } = telemetry.finishTurn({
        promptUsage: null,
        local: summarizeCopilotUsageRows([{ model, input_tokens: 10, output_tokens: 1 }]),
      });
      telemetry.endTurn();
      return done.servedModel;
    };
    expect(servedBy("claude-haiku-4.5")).toBeUndefined();
    expect(servedBy("mai-code-1.1-flash")).toBe("mai-code-1.1-flash");
  });

  it("seeds the session's requested model from the launch token, in the agent's own naming", async () => {
    const modelOption = (currentValue: string) => ({
      type: "select",
      id: "model",
      name: "Model",
      currentValue,
      options: [{ value: "gpt-5.5(openai)", name: "GPT-5.5" }, { value: "qwen3-coder-plus(openai)", name: "Qwen3 Coder Plus" }],
    });
    const harness = openHarness({
      dialect: qwenDialect,
      sessionId: "qwen-session",
      configHome: tempDir("qwen-requested"),
      // Qwen suffixes its ids with the auth type; the ledger and the model
      // option name the plain model.
      requestedModelId: "gpt-5.5(openai)",
      sessionNewExtra: { configOptions: [modelOption("gpt-5.5(openai)")] },
    });
    harness.agent.on(ACP_METHOD.sessionPrompt, () => ({ result: { stopReason: "end_turn" } }));
    const session = await withDeadline("open", harness.open());
    expect((await prompt(session, "turn-1")).done.servedModel).toBeUndefined();

    harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
      agent.emitUpdate("qwen-session", {
        sessionUpdate: "config_option_update",
        configOptions: [modelOption("qwen3-coder-plus(openai)")] as never,
      });
      return { result: { stopReason: "end_turn" } };
    });
    expect((await prompt(session, "turn-2")).done.servedModel).toBe("qwen3-coder-plus");
  });

  it("names the model that answered when Grok swapped it, and stays silent for its build name", async () => {
    // Live 1.0.40: grok-4.7 answers as grok-4.7-build. The shared
    // `isServedModelMismatch` reads a build name as the same model.
    const turnServedBy = (model: string) => ({
      result: { stopReason: "end_turn", _meta: { modelUsage: { [model]: { inputTokens: 10, outputTokens: 2 } } } },
    });
    const logger = testLogger();
    const swapped = openHarness({
      dialect: grokDialect,
      sessionId: "grok-swapped",
      requestedModelId: "grok-4.6",
      logger,
    });
    swapped.agent.on(ACP_METHOD.sessionPrompt, () => turnServedBy("grok-4.7-build"));
    const swappedSession = await withDeadline("open swapped", swapped.open());
    const turn = async (turnId: string, session: Awaited<ReturnType<typeof openAcpSession>>) => {
      const outcome = await prompt(session, turnId);
      return { notices: outcome.events.filter((event) => event.type === "system_notice"), done: outcome.done };
    };
    const first = await turn("turn-1", swappedSession);
    expect(first.notices).toEqual([
      expect.objectContaining({ message: "Grok answered with grok-4.7-build, not grok-4.6.", turnId: "turn-1" }),
    ]);
    // The chat service logs the one mismatch warning from `done.servedModel`.
    expect(first.done.servedModel).toBe("grok-4.7-build");
    // Once per served model, not once per turn.
    expect((await turn("turn-2", swappedSession)).notices).toEqual([]);
    expect(acpMismatchWarnings(logger)).toEqual([]);

    const honored = openHarness({ dialect: grokDialect, sessionId: "grok-honored", requestedModelId: "grok-4.7" });
    honored.agent.on(ACP_METHOD.sessionPrompt, () => turnServedBy("grok-4.7-build"));
    expect((await turn("turn-1", await withDeadline("open honored", honored.open()))).notices).toEqual([]);
  });

  it("puts a model the agent's catalog named on done, so the chat service sees the mismatch", () => {
    // Grok's `models/update` moves the requested model to the agent's own
    // current one. A turn served by exactly that model still differs from
    // what ADE asked for, so `done.servedModel` must carry it.
    const telemetry = createAcpTurnTelemetry({
      providerId: "grok",
      inferCompaction: false,
      requestedModelId: "grok-4.7",
      readAccount: () => ({ provider: "grok", kind: "subscription" }),
    });
    telemetry.noteSignal({ kind: "model_catalog", contextWindows: {}, currentModelId: "grok-4.6" });
    telemetry.beginTurn("turn");
    const { done, events } = telemetry.finishTurn({ promptUsage: { servedModel: "grok-4.6", inputTokens: 1 }, local: null });
    expect(done.servedModel).toBe("grok-4.6");
    expect(events.filter((event) => event.type === "system_notice")).toHaveLength(1);
  });

  it("falls back to the model ADE put on the session, not the one the entry call reported", async () => {
    // Kimi answers `session/set_config_option` without its option set, and
    // Copilot's `session/set_model` answers `{}`. The coordinator records the
    // model it set; a turn that names no served model must not report the
    // entry call's model as a swap.
    const logger = testLogger();
    const modelOption = {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "kimi-k2-turbo-preview",
      options: [{ value: "kimi-k2-turbo-preview", name: "K2 Turbo" }, { value: "kimi-k2-thinking", name: "K2 Thinking" }],
    };
    const harness = openHarness({
      dialect: kimiDialect,
      sessionId: "01KIMI",
      configHome: tempDir("kimi-applied"),
      requestedModelId: "kimi-k2-thinking",
      sessionNewExtra: { configOptions: [modelOption] },
      logger,
    });
    harness.agent.on(ACP_METHOD.sessionPrompt, () => ({ result: { stopReason: "end_turn" } }));
    const session = await withDeadline("open", harness.open());
    session.noteCurrentModel("kimi-k2-thinking");
    const outcome = await prompt(session, "turn-1");
    expect(outcome.done.servedModel).toBeUndefined();
    expect(outcome.events.filter((event) => event.type === "system_notice")).toEqual([]);
  });

  it("says nothing about the served model when the chat asked for none", async () => {
    const harness = openHarness({ dialect: grokDialect, sessionId: "grok-default" });
    harness.agent.on(ACP_METHOD.sessionPrompt, () => ({
      result: { stopReason: "end_turn", _meta: { modelUsage: { "grok-4.7-build": { inputTokens: 1, outputTokens: 1 } } } },
    }));
    const outcome = await prompt(await withDeadline("open", harness.open()));
    expect(outcome.done.servedModel).toBe("grok-4.7-build");
    expect(outcome.events.filter((event) => event.type === "system_notice")).toEqual([]);
  });
});

describe("telemetry readers", () => {
  it("reads finite numbers, SQLite bigints included, and trimmed non-empty text", () => {
    expect(readFiniteNumber(42)).toBe(42);
    expect(readFiniteNumber(BigInt(7))).toBe(7);
    expect(readFiniteNumber(Number.NaN)).toBeUndefined();
    expect(readFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(readFiniteNumber("42")).toBeUndefined();
    expect(readFiniteNumber(null)).toBeUndefined();
    expect(readTrimmedText("  grok-4  ")).toBe("grok-4");
    expect(readTrimmedText("   ")).toBeUndefined();
    expect(readTrimmedText(3)).toBeUndefined();
  });

  it("grok trims the ids and names its notifications carry", () => {
    expect(readGrokSessionNotification({
      sessionId: "s",
      update: { sessionUpdate: "subagent_spawned", subagent_id: " sub-1 ", model: " grok-4 ", description: "  " },
    }).signals).toEqual([{ kind: "subagent_started", agentId: "sub-1", model: "grok-4" }]);
  });
});

describe("turn boundaries", () => {
  it("ends the turn when the prompt fails, so later updates carry no dead turn's id", async () => {
    const harness = openHarness({ dialect: copilotDialect, sessionId: "s", configHome: tempDir("copilot-fail") });
    harness.agent.on(ACP_METHOD.sessionPrompt, (_params, agent) => {
      agent.emitUpdate("s", { sessionUpdate: "usage_update", used: 150_000, size: 200_000 });
      return { result: { stopReason: "end_turn" } };
    });
    const session = await withDeadline("open", harness.open());
    await prompt(session, "turn-1");

    harness.agent.on(ACP_METHOD.sessionPrompt, () => ({ error: { code: -32000, message: "model overloaded" } }));
    await expect(prompt(session, "turn-2")).rejects.toThrow("model overloaded");
    const before = harness.events.length;
    // A late sample after the failure: its drop is an inferred compaction.
    harness.agent.emitUpdate("s", { sessionUpdate: "usage_update", used: 60_000, size: 200_000 });
    await vi.waitFor(() => expect(harness.events.slice(before).map((event) => event.type)).toEqual(["context_compact", "context_usage"]));
    for (const event of harness.events.slice(before)) expect(event).not.toHaveProperty("turnId");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Accounts
// ─────────────────────────────────────────────────────────────────────────────

describe("accounts from local config", () => {
  it("grok: a login beats the API key, the key alone is api_key, neither is unknown", () => {
    const loggedIn = tempDir("grok-login");
    writeFileSync(path.join(loggedIn, "auth.json"), JSON.stringify({ "https://auth.x.ai::c": { key: "secret", auth_mode: "oidc" } }));
    const account = readGrokAccount({ env: { GROK_HOME: loggedIn, XAI_API_KEY: "xai-secret" } });
    expect(account).toEqual({ provider: "grok", kind: "subscription" });
    expect(JSON.stringify(account)).not.toMatch(/secret/);
    const empty = tempDir("grok-none");
    expect(readGrokAccount({ env: { GROK_HOME: empty, XAI_API_KEY: "xai-secret" } })).toEqual({ provider: "grok", kind: "api_key" });
    expect(readGrokAccount({ env: { GROK_HOME: empty } })).toEqual({ provider: "grok", kind: "unknown" });
  });

  it("kimi: the login credentials file means the Kimi Code plan", () => {
    const home = tempDir("kimi-login");
    mkdirSync(path.join(home, "credentials"));
    writeFileSync(path.join(home, "credentials", "kimi-code.json"), "{}");
    expect(readKimiAccount({ env: { KIMI_CODE_HOME: home } })).toEqual({ provider: "kimi", kind: "subscription" });
    expect(readKimiAccount({ env: { KIMI_CODE_HOME: tempDir("kimi-none"), MOONSHOT_API_KEY: "k" } }))
      .toEqual({ provider: "kimi", kind: "api_key" });
  });

  it("kimi: a `--region global` login, kept in its own credentials slot, is the plan too", () => {
    const home = tempDir("kimi-global");
    const oauthHost = "https://auth.kimi.ai";
    const baseUrl = KIMI_CODE_GLOBAL_BASE_URL;
    const key = kimiCodeOAuthKey({ oauthHost, baseUrl });
    writeFileSync(path.join(home, "config.toml"), [
      '[providers."managed:kimi-code"]',
      'type = "kimi"',
      `base_url = "${baseUrl}"`,
      `oauth = { storage = "file", key = "${key}", oauth_host = "${oauthHost}" }`,
      "",
    ].join("\n"));
    const env = { KIMI_CODE_HOME: home };
    // Configured but not signed in yet: no token file in the slot.
    expect(readKimiAccount({ env })).toEqual({ provider: "kimi", kind: "unknown" });
    mkdirSync(path.join(home, "credentials"));
    writeFileSync(path.join(home, "credentials", `${key.slice("oauth/".length)}.json`), "{}");
    expect(readKimiAccount({ env })).toEqual({ provider: "kimi", kind: "subscription" });
  });

  it("qwen: auth type is the upstream; qwen-oauth is a plan; a vendor base URL is an API key", () => {
    const home = tempDir("qwen-account");
    writeFileSync(path.join(home, "settings.json"), `// comment line\n${JSON.stringify({
      model: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      security: { auth: { selectedType: "qwen-oauth" } },
    })}`);
    expect(readQwenAccount({ env: { QWEN_HOME: home } })).toEqual({ provider: "qwen", kind: "subscription", upstream: "qwen-oauth" });
    expect(readQwenAccount({ env: { QWEN_HOME: home }, authType: "anthropic" }))
      .toEqual({ provider: "qwen", kind: "api_key", upstream: "anthropic" });
    expect(readQwenAccount({ env: { QWEN_HOME: tempDir("qwen-none") } })).toEqual({ provider: "qwen", kind: "unknown" });
  });

  it("qwen: a loopback base URL is a local account, and only its origin leaves the reader", () => {
    const home = tempDir("qwen-local");
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({
      model: { baseUrl: "http://user:sk-userinfo-secret@127.0.0.1:11434/v1/chat?key=sk-query-secret" },
      security: { auth: { selectedType: "openai" } },
    }));
    const account = readQwenAccount({ env: { QWEN_HOME: home } });
    expect(account).toEqual({ provider: "qwen", kind: "local", upstream: "openai", endpoint: "http://127.0.0.1:11434" });
    expect(JSON.stringify(account)).not.toMatch(/secret|user|\/v1|key=/);

    // `OPENAI_BASE_URL` is read the same way when the settings name none.
    const envOnly = readQwenAccount({
      env: { QWEN_HOME: tempDir("qwen-env"), OPENAI_BASE_URL: "http://localhost:8317/v1?api_key=sk-env-secret" },
      authType: "openai",
    });
    expect(envOnly).toEqual({ provider: "qwen", kind: "local", upstream: "openai", endpoint: "http://localhost:8317" });
  });

  it("qwen: reads a JSONC settings file with block and trailing comments", () => {
    const home = tempDir("qwen-jsonc");
    writeFileSync(path.join(home, "settings.json"), [
      "/* written by hand */",
      "{",
      '  "model": { "baseUrl": "http://[::1]:8080/v1" }, // the local proxy',
      '  "security": { "auth": { "selectedType": "openai" } }',
      "}",
    ].join("\n"));
    expect(readQwenAccount({ env: { QWEN_HOME: home } }))
      .toEqual({ provider: "qwen", kind: "local", upstream: "openai", endpoint: "http://[::1]:8080" });
  });
});
