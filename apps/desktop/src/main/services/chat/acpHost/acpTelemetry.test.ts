/**
 * ACP telemetry: usage totals, context occupancy, served model, cost, plan
 * units, account, subagent usage, and compaction (reported and inferred).
 *
 * The Grok cases replay real one-turn sessions captured on 2026-09-23. Kimi is
 * covered by fixtures shaped after its 0.39.1 binary; it is not live-verified.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEvent, AgentChatSession } from "../../../../shared/types";
import { createCompactionEmitterState, mapLegacyCompactionEvent } from "../contextCompactionEmitter";
import {
  grokDialect,
  kimiDialect,
  qwenDialect,
} from "./acpDialects";
import { KIMI_CODE_GLOBAL_BASE_URL, kimiCodeOAuthKey } from "../../shared/kimiCodeLogin";
import { readGrokAccount, readKimiAccount, readQwenAccount } from "./acpDialects/acpAccounts";
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

const GROK_CAPTURE_SESSION = "01a0cd33-eb83-7073-81fd-8b9df695ecd9";

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
