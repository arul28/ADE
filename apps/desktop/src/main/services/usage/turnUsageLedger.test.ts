import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdeQuotaSample, AdeTurnUsageRecord, AgentChatEvent, UsageWindow } from "../../../shared/types";
import {
  apiEquivalentTurnUsd,
  buildTurnUsageLedgerSummary,
  buildTurnUsageRecord,
  createTurnUsageLedger,
  createTurnUsageLedgerStore,
  getSharedTurnUsageLedger,
  mergeTurnUsageLines,
  observeTurnEvent,
  quotaSampleChanged,
  quotaSamplesFromSnapshot,
  readTurnUsageDay,
  summarizeTurnUsage,
  type TurnUsageObservation,
  type TurnUsageSessionFacts,
} from "./turnUsageLedger";
import {
  ONE_HOUR_CACHE_WRITE_MULTIPLIER,
  resetDynamicTokenPricingForTest,
  setDynamicTokenPricingForTest,
  tokenPrice,
} from "./usagePricing";

type DoneEvent = Extract<AgentChatEvent, { type: "done" }>;

const T0 = Date.UTC(2026, 8, 23, 12, 0, 0);
const RESET_A = "2026-09-23T17:00:00.000Z";
const RESET_B = "2026-09-23T22:00:00.000Z";

let tmpRoot: string;
let dir: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-turn-ledger-test-"));
  dir = path.join(tmpRoot, "usage");
  clock = T0;
  resetDynamicTokenPricingForTest({ disableDiskCache: true });
});

afterEach(() => {
  resetDynamicTokenPricingForTest({ disableDiskCache: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function session(overrides: Partial<TurnUsageSessionFacts> = {}): TurnUsageSessionFacts {
  return { id: "s1", laneId: "lane-1", provider: "claude", model: "opus", ...overrides };
}

function done(overrides: Partial<DoneEvent> = {}): DoneEvent {
  return { type: "done", turnId: "t1", status: "completed", ...overrides };
}

function row(overrides: Partial<AdeTurnUsageRecord> = {}): AdeTurnUsageRecord {
  const sessionId = overrides.sessionId ?? "s1";
  const turnId = overrides.turnId ?? "t1";
  return {
    v: 1,
    key: `${sessionId}:${turnId}`,
    at: new Date(T0).toISOString(),
    startedAt: null,
    sessionId,
    turnId,
    projectRoot: null,
    laneId: null,
    surface: null,
    parentSessionId: null,
    provider: "claude",
    status: "completed",
    requestedModel: null,
    servedModel: null,
    reasoningEffort: null,
    account: null,
    accountKey: "claude:local",
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheWrite1hTokens: null,
    reasoningTokens: null,
    contextTokens: null,
    contextWindow: null,
    requestCount: null,
    subagentTokens: null,
    costUsd: null,
    costSource: null,
    apiEquivalentUsd: null,
    planUsage: null,
    factoryCreditsSessionTotal: null,
    usageConfidence: null,
    durationMs: null,
    compactions: 0,
    ...overrides,
  };
}

function quotaSample(overrides: Partial<AdeQuotaSample> = {}): AdeQuotaSample {
  return {
    v: 1,
    at: new Date(T0).toISOString(),
    provider: "claude",
    accountId: "claude:local",
    windowType: "five_hour",
    percentUsed: 10,
    resetsAt: RESET_A,
    ...overrides,
  };
}

function usageWindow(
  fields: Pick<UsageWindow, "provider" | "windowType" | "percentUsed" | "resetsAt"> & Partial<UsageWindow>,
): UsageWindow {
  return { resetsInMs: 0, ...fields };
}

function newLedger() {
  const store = createTurnUsageLedgerStore({ dir, nowMs: now });
  return { store, ledger: createTurnUsageLedger({ store, nowMs: now }) };
}

describe("settling a turn", () => {
  it("writes one row for a Claude turn, timed from the first event that named the turn", async () => {
    const { store, ledger } = newLedger();
    clock = T0 - 10_000;
    // No turn id: it cannot start a turn.
    ledger.observe("s1", { type: "activity", activity: "thinking" });
    clock = T0;
    ledger.observe("s1", { type: "activity", activity: "thinking", turnId: "t1" });
    clock = T0 + 3_000;
    ledger.observe("s1", { type: "activity", activity: "editing_file", turnId: "t1" });
    clock = T0 + 5_000;

    const record = ledger.settle({
      session: session({ reasoningEffort: "high" }),
      projectRoot: "/repo",
      event: done({
        model: "claude-opus-5-5",
        usage: {
          inputTokens: 120,
          outputTokens: 80,
          cacheReadTokens: 4_000,
          cacheCreationTokens: 600,
          contextTokens: 4_720,
          contextWindow: 200_000,
          requestCount: 3,
        },
        costUsd: 0.42,
        account: { provider: "claude", kind: "subscription", instanceId: "work", email: "Me@Example.com" },
      }),
    });

    expect(record).toMatchObject({
      key: "s1:t1",
      sessionId: "s1",
      turnId: "t1",
      at: new Date(T0 + 5_000).toISOString(),
      startedAt: new Date(T0).toISOString(),
      durationMs: 5_000,
      projectRoot: "/repo",
      laneId: "lane-1",
      provider: "claude",
      status: "completed",
      requestedModel: "opus",
      reasoningEffort: "high",
      accountKey: "claude:work",
      inputTokens: 120,
      outputTokens: 80,
      cacheReadTokens: 4_000,
      cacheWriteTokens: 600,
      reasoningTokens: null,
      contextTokens: 4_720,
      contextWindow: 200_000,
      requestCount: 3,
      subagentTokens: null,
      costUsd: 0.42,
      // Claude's done carries the SDK's list-price figure with no source: not a bill.
      costSource: "list_price",
      planUsage: null,
      usageConfidence: "measured",
    });
    expect(await store.readTurns()).toEqual([record]);

    clock += 1_000;
    expect(ledger.settle({ session: session(), event: done({ usage: { inputTokens: 1 } }) })).toBeNull();
    expect(await store.readTurns()).toEqual([record]);
  });

  it("keys the account by instance id, then lower-cased email, then the provider alone", () => {
    const accountKey = (provider: string, account: DoneEvent["account"]) =>
      buildTurnUsageRecord({ session: session({ provider }), event: done({ account }), observation: null, nowMs: T0 }).accountKey;
    expect(accountKey("claude", { provider: "claude", kind: "subscription", instanceId: " work ", email: "a@b.c" })).toBe("claude:work");
    expect(accountKey("codex", { provider: "codex", kind: "subscription", email: " Dev@Example.COM " })).toBe("codex:dev@example.com");
    expect(accountKey("opencode", { provider: "opencode", kind: "api_key", email: "  " })).toBe("opencode:local");
    // The account's own provider wins over the session's.
    expect(accountKey("opencode", { provider: "anthropic", kind: "subscription", email: "me@example.com" })).toBe("anthropic:me@example.com");
    expect(accountKey("grok", undefined)).toBe("grok:local");
  });

  it("records the model the turn started on, not one the chat switched to mid-turn", () => {
    const { ledger } = newLedger();
    ledger.observe("s1", { type: "activity", activity: "thinking", turnId: "t1" }, "anthropic/claude-opus-5-5");
    // The user switches models while the turn runs; later events see the new model.
    ledger.observe("s1", { type: "activity", activity: "working", turnId: "t1" }, "anthropic/claude-sonnet-5");
    const record = ledger.settle({
      session: session({ modelId: "anthropic/claude-sonnet-5" }),
      event: done({ usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    expect(record?.requestedModel).toBe("anthropic/claude-opus-5-5");
  });

  it("takes the context size from the turn's latest measured sample when done carries none", () => {
    const { ledger } = newLedger();
    const sample = (totalTokens: number, state?: "measured" | "compacting") => ({
      type: "context_usage" as const,
      origin: "live" as const,
      ...(state ? { state } : {}),
      usage: { categories: [], totalTokens, maxTokens: 200_000, percentage: 0 },
      turnId: "t1",
    });
    ledger.observe("s1", sample(40_000));
    ledger.observe("s1", sample(90_000));
    ledger.observe("s1", sample(5, "compacting"));
    const record = ledger.settle({
      session: session({ provider: "droid" }),
      event: done({ usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    expect(record).toMatchObject({ contextTokens: 90_000, contextWindow: 200_000 });
  });

  it("adds the helper-agent usage a provider reported on done to the subagent tokens", () => {
    const { ledger } = newLedger();
    ledger.observe("s1", {
      type: "subagent_result",
      taskId: "task-a",
      status: "completed",
      summary: "done",
      usage: { totalTokens: 100 },
      turnId: "t1",
    });
    const record = ledger.settle({
      session: session({ provider: "copilot" }),
      event: done({
        usage: { inputTokens: 10, outputTokens: 5 },
        subagentUsage: [
          { agentId: "explore", inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 3_000, cacheWriteTokens: 50, reasoningTokens: 40 },
          { agentId: "managed-auto-memory-extractor", outputTokens: 7 },
        ],
      }),
    });
    // Reasoning is inside output, so it is not added again.
    expect(record).toMatchObject({ subagentTokens: 100 + 4_250 + 7, inputTokens: 10, outputTokens: 5 });
  });

  it("counts a cost as a provider bill only when the event says so", () => {
    const build = (event: DoneEvent) => buildTurnUsageRecord({ session: session(), event, observation: null, nowMs: T0 });
    const billed = build(done({ costUsd: 0.3, costSource: "provider", usage: { inputTokens: 10 } }));
    const unsourced = build(done({ costUsd: 0.1, usage: { inputTokens: 10 } }));
    const listPriced = build(done({ costUsd: 0.2, costSource: "list_price", usage: { inputTokens: 10 } }));
    const noCost = build(done({ usage: { inputTokens: 10 } }));

    expect(billed).toMatchObject({ costUsd: 0.3, costSource: "provider" });
    expect(unsourced).toMatchObject({ costUsd: 0.1, costSource: "list_price" });
    expect(listPriced).toMatchObject({ costUsd: 0.2, costSource: "list_price" });
    expect(noCost).toMatchObject({ costUsd: null, costSource: null, startedAt: null, durationMs: null });
    expect(summarizeTurnUsage([billed, unsourced, listPriced, noCost], "provider")[0]?.providerCostUsd).toBe(0.3);
  });
});

describe("API-equivalent price", () => {
  const split = {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 400_000,
    // A subset of output: never priced on its own.
    reasoningTokens: 50_000,
  };

  beforeEach(() => {
    setDynamicTokenPricingForTest({
      "ledger-test-model": tokenPrice(2, 10, 0.2, 2.5),
      "ledger-served-model": tokenPrice(4, 20, 0.4, 5),
    });
  });

  it("prices uncached input, output, cache reads, and 5-minute and 1-hour cache writes", () => {
    const oneHourWrites = 100_000;
    const expected = 1_000_000 * 2e-6
      + 100_000 * 10e-6
      + 1_000_000 * 0.2e-6
      + (400_000 - oneHourWrites) * 2.5e-6
      + oneHourWrites * 2.5e-6 * ONE_HOUR_CACHE_WRITE_MULTIPLIER;
    expect(apiEquivalentTurnUsd("ledger-test-model", split, { cacheWrite1hTokens: oneHourWrites, timestampMs: T0 }))
      .toBeCloseTo(expected, 6);
    expect(expected).toBeCloseTo(4.35, 6);

    // A 1-hour count above the whole cache write is capped at the cache write.
    expect(apiEquivalentTurnUsd("ledger-test-model", split, { cacheWrite1hTokens: 5_000_000, timestampMs: T0 }))
      .toBeCloseTo(2 + 1 + 0.2 + 400_000 * 2.5e-6 * ONE_HOUR_CACHE_WRITE_MULTIPLIER, 6);
  });

  it("prices the served model when the runtime reports one", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    const served = buildTurnUsageRecord({
      session: session({ modelId: "ledger-test-model" }),
      event: done({ model: "ledger-test-model", servedModel: "ledger-served-model", usage }),
      observation: null,
      nowMs: T0,
    });
    expect(served).toMatchObject({ requestedModel: "ledger-test-model", servedModel: "ledger-served-model", apiEquivalentUsd: 4 });

    const requested = buildTurnUsageRecord({
      session: session({ modelId: "ledger-test-model" }),
      event: done({ model: "ledger-test-model", usage }),
      observation: null,
      nowMs: T0,
    });
    expect(requested).toMatchObject({ servedModel: null, apiEquivalentUsd: 2 });
  });

  it("prices reasoning on its own only for a provider whose output leaves it out", () => {
    const outputOnly = { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 50_000 };
    // OpenCode reports output without reasoning: both bill at the output rate.
    expect(apiEquivalentTurnUsd("ledger-test-model", outputOnly, { timestampMs: T0, provider: "opencode" })).toBeCloseTo(1.5, 6);
    // Codex, Claude, and the rest count reasoning inside output.
    for (const provider of ["codex", "claude", "droid", "pi", "grok", "copilot", undefined]) {
      expect(apiEquivalentTurnUsd("ledger-test-model", outputOnly, { timestampMs: T0, provider })).toBeCloseTo(1, 6);
    }
    const record = buildTurnUsageRecord({
      session: session({ provider: "opencode", model: "ledger-test-model" }),
      event: done({ usage: { outputTokens: 100_000, reasoningTokens: 50_000 } }),
      observation: null,
      nowMs: T0,
    });
    expect(record.apiEquivalentUsd).toBeCloseTo(1.5, 6);
  });

  it("is null for a model with no list price, and for a turn with no usage", () => {
    expect(apiEquivalentTurnUsd("zz-unpriced-ledger-model", split, { timestampMs: T0 })).toBeNull();
    expect(apiEquivalentTurnUsd("ledger-test-model", null, { timestampMs: T0 })).toBeNull();
    expect(apiEquivalentTurnUsd(null, split, { timestampMs: T0 })).toBeNull();

    const record = buildTurnUsageRecord({
      session: session({ model: "zz-unpriced-ledger-model" }),
      event: done({ usage: { inputTokens: 1_000, outputTokens: 10 } }),
      observation: null,
      nowMs: T0,
    });
    expect(record.apiEquivalentUsd).toBeNull();
  });
});

describe("Codex turns", () => {
  const before = { inputTokens: 10_000, cacheReadTokens: 6_000, outputTokens: 2_000, reasoningTokens: 500 };
  const last1 = { inputTokens: 3_000, cacheReadTokens: 2_000, outputTokens: 400, reasoningTokens: 100 };
  const total1 = { inputTokens: 13_000, cacheReadTokens: 8_000, outputTokens: 2_400, reasoningTokens: 600 };
  const last2 = { inputTokens: 4_000, cacheReadTokens: 3_500, outputTokens: 600, reasoningTokens: 200 };
  const total2 = { inputTokens: 17_000, cacheReadTokens: 11_500, outputTokens: 3_000, reasoningTokens: 800 };

  it("takes the turn's tokens from the change in the thread totals, with cached input taken out", async () => {
    expect(total1.inputTokens).toBe(before.inputTokens + last1.inputTokens);
    const { store, ledger } = newLedger();
    const usageEvent = (total: typeof total1, last: typeof last1): AgentChatEvent => ({
      type: "codex_token_usage",
      turnId: "t1",
      usage: { threadId: "thread-1", turnId: "t1", total, last, modelContextWindow: 272_000 },
    });
    ledger.observe("s1", usageEvent(total1, last1));
    // Codex repeats an update now and then.
    ledger.observe("s1", usageEvent(total1, last1));
    ledger.observe("s1", usageEvent(total2, last2));

    const record = ledger.settle({
      session: session({ provider: "codex", model: "gpt-6-sol" }),
      // Codex's `done` counts are not the turn's split; the thread totals win.
      event: done({ usage: { inputTokens: 999_999, outputTokens: 999_999 }, account: { provider: "codex", kind: "subscription", email: "Dev@Example.com" } }),
    });

    // Turn = total2 - before: input 7,000 of which 5,500 cached.
    expect(record).toMatchObject({
      provider: "codex",
      accountKey: "codex:dev@example.com",
      inputTokens: 1_500,
      cacheReadTokens: 5_500,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
      reasoningTokens: 300,
      contextTokens: last2.inputTokens,
      contextWindow: 272_000,
      usageConfidence: "derived",
    });
    expect(await store.readTurns()).toHaveLength(1);
  });

  it("takes cached input out of the done usage when no usage update arrived", () => {
    const { ledger } = newLedger();
    ledger.observe("s1", { type: "activity", activity: "working", turnId: "t1" });
    const record = ledger.settle({
      session: session({ provider: "codex", model: "gpt-6-sol" }),
      event: done({ usage: { inputTokens: 5_000, cacheReadTokens: 3_000, outputTokens: 200 } }),
    });
    expect(record).toMatchObject({
      inputTokens: 2_000,
      cacheReadTokens: 3_000,
      outputTokens: 200,
      usageConfidence: "measured",
    });

    // A cache read larger than the input means the input is already uncached
    // (the history scanners' rule), so it is kept, not floored to zero.
    const exclusive = ledger.settle({
      session: session({ provider: "codex", model: "gpt-6-sol" }),
      event: done({ turnId: "t2", usage: { inputTokens: 400, cacheReadTokens: 3_000, outputTokens: 20 } }),
    });
    expect(exclusive).toMatchObject({ inputTokens: 400, cacheReadTokens: 3_000 });
  });
});

describe("other token sources", () => {
  it("falls back to the latest tokens event when a non-Codex done carries no usage", () => {
    const { ledger } = newLedger();
    ledger.observe("s1", { type: "tokens", turnId: "t1", inputTokens: 10, outputTokens: 5 });
    ledger.observe("s1", {
      type: "tokens",
      turnId: "t1",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
      reasoningTokens: 7,
      contextWindow: 128_000,
    });
    const record = ledger.settle({ session: session({ provider: "opencode" }), event: done() });
    expect(record).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
      reasoningTokens: 7,
      contextWindow: 128_000,
      usageConfidence: "derived",
    });
  });

  it("prefers the done usage over a tokens event", () => {
    const { ledger } = newLedger();
    ledger.observe("s1", { type: "tokens", turnId: "t1", inputTokens: 100, outputTokens: 50 });
    const record = ledger.settle({ session: session({ provider: "opencode" }), event: done({ usage: { inputTokens: 7, outputTokens: 3 } }) });
    expect(record).toMatchObject({ inputTokens: 7, outputTokens: 3, usageConfidence: "measured" });
  });

  it("counts each subagent's highest cumulative report once and keeps it out of the main tokens", () => {
    const { ledger } = newLedger();
    const progress = (taskId: string, usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number }): AgentChatEvent => ({
      type: "subagent_progress",
      taskId,
      summary: "working",
      usage,
      turnId: "t1",
    });
    ledger.observe("s1", progress("task-a", { totalTokens: 100 }));
    ledger.observe("s1", progress("task-a", { totalTokens: 250 }));
    ledger.observe("s1", progress("task-a", { totalTokens: 250 }));
    ledger.observe("s1", progress("task-b", { inputTokens: 30, outputTokens: 20 }));
    ledger.observe("s1", { type: "subagent_result", taskId: "task-b", status: "completed", summary: "done", usage: { totalTokens: 40 }, turnId: "t1" });

    const record = ledger.settle({ session: session(), event: done({ usage: { inputTokens: 10, outputTokens: 5 } }) });
    expect(record).toMatchObject({ subagentTokens: 300, inputTokens: 10, outputTokens: 5 });
  });

  it("counts each finished compaction once, and none that only started", () => {
    const { ledger } = newLedger();
    const compact = (state: "started" | "completed" | "failed" | undefined, compactionId?: string): AgentChatEvent => ({
      type: "context_compact",
      trigger: "auto",
      turnId: "t1",
      ...(state ? { state } : {}),
      ...(compactionId ? { compactionId } : {}),
    });
    ledger.observe("s1", compact("started", "c1"));
    ledger.observe("s1", compact("completed", "c1"));
    // A repeated end of the same compaction.
    ledger.observe("s1", compact("completed", "c1"));
    // A completion-only source sends no state and no id; a failed attempt still counts.
    ledger.observe("s1", compact(undefined));
    ledger.observe("s1", compact("failed", "c2"));
    ledger.observe("s1", { type: "codex_context_compaction", turnId: "t1", state: "started", trigger: "auto", compactionId: "c3" });
    ledger.observe("s1", { type: "codex_context_compaction", turnId: "t1", state: "failed", trigger: "auto", compactionId: "c4" });
    ledger.observe("s1", { type: "codex_context_compaction", turnId: "t1", state: "completed", trigger: "auto", compactionId: "c3" });
    // Another turn's compaction stays on that turn.
    ledger.observe("s1", { ...compact("completed", "c5"), turnId: "t2" } as AgentChatEvent);

    expect(ledger.settle({ session: session(), event: done() })).toMatchObject({ compactions: 4 });
    expect(ledger.settle({ session: session(), event: done({ turnId: "t2" }) })).toMatchObject({ compactions: 1 });
    expect(ledger.settle({ session: session(), event: done({ turnId: "t3" }) })).toMatchObject({ compactions: 0 });
  });
});

describe("ledger store", () => {
  it("merges amendments onto their row in time order, not file order", async () => {
    const store = createTurnUsageLedgerStore({ dir, nowMs: now });
    store.appendTurn(row({ servedModel: null, costUsd: null }));
    clock = T0 + 2_000;
    store.amendTurn("s1:t1", "cursor_dashboard", { servedModel: "late-model" });
    clock = T0 + 1_000;
    store.amendTurn("s1:t1", "cursor_dashboard", { servedModel: "early-model", costUsd: 1.25, costSource: "provider" });
    store.amendTurn("s9:t9", "factory_sessions", { factoryCreditsSessionTotal: 3 });

    expect(await store.readTurns()).toEqual([
      row({ servedModel: "late-model", costUsd: 1.25, costSource: "provider" }),
    ]);
  });

  it("reads a row written before compactions existed as 0 compactions", () => {
    const { compactions: _dropped, ...legacy } = row();
    expect(mergeTurnUsageLines([legacy])).toEqual([row({ compactions: 0 })]);
  });

  it("reads one machine-local day's rows by the local day each turn finished", async () => {
    const store = createTurnUsageLedgerStore({ dir, nowMs: now });
    const at = (day: number, hour: number) => new Date(2026, 8, day, hour, 30).toISOString();
    store.appendTurn(row({ turnId: "before", at: at(21, 23) }));
    store.appendTurn(row({ turnId: "early", at: at(22, 0) }));
    store.appendTurn(row({ turnId: "late", at: at(22, 23) }));
    store.appendTurn(row({ turnId: "after", at: at(23, 0) }));

    expect((await readTurnUsageDay(store, "2026-09-22"))!.map((r) => r.turnId)).toEqual(["early", "late"]);
    expect(await readTurnUsageDay(store, "2026-02-30")).toEqual([]);
    expect(await readTurnUsageDay(store, "2026-09-20")).toEqual([]);
  });

  it("tells a failed read from a ledger with no turns", async () => {
    // No ledger directory yet: nothing to read, which is a day with no turns.
    const empty = createTurnUsageLedgerStore({ dir: path.join(tmpRoot, "missing"), nowMs: now });
    expect(await empty.readTurnsChecked()).toEqual({ ok: true, rows: [] });
    expect(await readTurnUsageDay(empty, "2026-09-22")).toEqual([]);

    // A month "file" that cannot be read: the checked read fails, the plain read logs and gives [].
    const warn = vi.fn();
    const store = createTurnUsageLedgerStore({ dir, nowMs: now, logger: { warn } });
    fs.mkdirSync(path.join(dir, "turns-2026-09.jsonl"), { recursive: true });
    expect(await store.readTurnsChecked()).toEqual({ ok: false });
    expect(await readTurnUsageDay(store, "2026-09-22")).toBeNull();
    expect(await store.readTurns()).toEqual([]);
    expect(warn).toHaveBeenCalledWith("usage.turn_ledger_io_failed", expect.objectContaining({ kind: "read_turns" }));
  });

  it("skips a torn or garbage line and keeps the rest of the file", async () => {
    const store = createTurnUsageLedgerStore({ dir, nowMs: now });
    store.appendTurn(row({ turnId: "t1" }));
    const file = path.join(dir, "turns-2026-09.jsonl");
    fs.appendFileSync(file, "not json at all\n{\"v\":1,\"key\":\"s1:t2\",\"at\":\n");
    store.appendTurn(row({ turnId: "t3" }));
    expect((await store.readTurns()).map((r) => r.key)).toEqual(["s1:t1", "s1:t3"]);
    expect(mergeTurnUsageLines([null, 42, "text", { v: 2, key: "x", at: "y", provider: "z" }])).toEqual([]);
  });

  it("filters rows older than sinceMs", async () => {
    const store = createTurnUsageLedgerStore({ dir, nowMs: now });
    store.appendTurn(row({ turnId: "old", at: new Date(T0 - 60_000).toISOString() }));
    store.appendTurn(row({ turnId: "new", at: new Date(T0).toISOString() }));
    store.appendQuotaSample(quotaSample({ at: new Date(T0 - 60_000).toISOString(), percentUsed: 1 }));
    store.appendQuotaSample(quotaSample({ at: new Date(T0).toISOString(), percentUsed: 2 }));

    expect((await store.readTurns({ sinceMs: T0 - 1_000 })).map((r) => r.turnId)).toEqual(["new"]);
    expect((await store.readTurns()).map((r) => r.turnId)).toEqual(["old", "new"]);
    expect((await store.readQuotaSamples({ sinceMs: T0 - 1_000 })).map((s) => s.percentUsed)).toEqual([2]);
  });

  it("reads the month files off the event loop, line by line", async () => {
    const store = createTurnUsageLedgerStore({ dir, nowMs: now });
    for (let i = 0; i < 500; i += 1) store.appendTurn(row({ turnId: `t${i}` }));
    // A CRLF line from an editor still parses.
    fs.appendFileSync(path.join(dir, "turns-2026-09.jsonl"), `${JSON.stringify(row({ turnId: "crlf" }))}\r\n`);
    let loopTurned = false;
    setImmediate(() => { loopTurned = true; });
    const pending = store.readTurns();
    expect(loopTurned).toBe(false);
    const rows = await pending;
    // A synchronous read would resolve before the event loop turns once.
    expect(loopTurned).toBe(true);
    expect(rows).toHaveLength(501);
    expect(rows.at(-1)?.turnId).toBe("crlf");
  });

  it("names month files turns-YYYY-MM.jsonl and quota-YYYY-MM.jsonl", () => {
    const store = createTurnUsageLedgerStore({ dir, nowMs: now });
    store.appendTurn(row());
    store.appendQuotaSample(quotaSample());
    // Month files go by UTC.
    clock = Date.UTC(2026, 11, 31, 23, 59, 59);
    store.appendTurn(row({ turnId: "t2" }));
    expect(fs.readdirSync(dir).sort()).toEqual(["quota-2026-09.jsonl", "turns-2026-09.jsonl", "turns-2026-12.jsonl"]);
  });

  it("prunes month files past the retention on the first write of each month", () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ["turns-2026-05.jsonl", "quota-2026-06.jsonl", "turns-2026-07.jsonl", "quota-2026-08.jsonl", "notes.txt", "turns-latest.jsonl"]) {
      fs.writeFileSync(path.join(dir, name), "");
    }
    clock = Date.UTC(2026, 8, 5);
    const store = createTurnUsageLedgerStore({ dir, nowMs: now, retentionMonths: 2 });
    store.appendTurn(row());
    expect(fs.readdirSync(dir).sort()).toEqual([
      "notes.txt",
      "quota-2026-08.jsonl",
      "turns-2026-07.jsonl",
      "turns-2026-09.jsonl",
      "turns-latest.jsonl",
    ]);

    // Later writes in the same month do not prune again.
    fs.writeFileSync(path.join(dir, "turns-2026-01.jsonl"), "");
    clock = Date.UTC(2026, 8, 20);
    store.appendQuotaSample(quotaSample());
    expect(fs.existsSync(path.join(dir, "turns-2026-01.jsonl"))).toBe(true);

    clock = Date.UTC(2026, 9, 2);
    store.appendTurn(row({ turnId: "t2" }));
    expect(fs.readdirSync(dir).sort()).toEqual([
      "notes.txt",
      "quota-2026-08.jsonl",
      "quota-2026-09.jsonl",
      "turns-2026-09.jsonl",
      "turns-2026-10.jsonl",
      "turns-latest.jsonl",
    ]);
  });

  it("skips a month file over the read limit and warns once for that file", async () => {
    const warn = vi.fn();
    const store = createTurnUsageLedgerStore({ dir, logger: { warn }, nowMs: now });
    store.appendTurn(row({ turnId: "kept" }));
    // A sparse file: its size is over the limit, but no bytes are written.
    const oversized = path.join(dir, "turns-2026-08.jsonl");
    fs.writeFileSync(oversized, "");
    fs.truncateSync(oversized, 64 * 1024 * 1024 + 1);
    const sinceAugust = Date.UTC(2026, 7, 1);

    expect((await store.readTurns({ sinceMs: sinceAugust })).map((r) => r.turnId)).toEqual(["kept"]);
    await store.readTurns({ sinceMs: sinceAugust });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("usage.turn_ledger_io_failed", {
      kind: "file_too_large:turns-2026-08.jsonl",
      error: expect.stringContaining("turns-2026-08.jsonl"),
    });
  });

  it("never throws when its directory is a file, and warns once", async () => {
    const filePath = path.join(tmpRoot, "not-a-dir");
    fs.writeFileSync(filePath, "x");
    const warn = vi.fn();
    const store = createTurnUsageLedgerStore({ dir: filePath, logger: { warn }, nowMs: now });
    expect(() => {
      store.appendTurn(row());
      store.amendTurn("s1:t1", "cursor_dashboard", { costUsd: 1 });
      store.appendQuotaSample(quotaSample());
    }).not.toThrow();
    expect(await store.readTurns()).toEqual([]);
    expect(await store.readQuotaSamples()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("usage.turn_ledger_io_failed", { kind: "append", error: expect.any(String) });
    expect(fs.readFileSync(filePath, "utf8")).toBe("x");
  });
});

describe("quota samples", () => {
  it("skips windows without a percent or a reset time and defaults the account", () => {
    const samples = quotaSamplesFromSnapshot({
      windows: [
        usageWindow({ provider: "claude", windowType: "five_hour", percentUsed: 12.5, resetsAt: RESET_A }),
        usageWindow({ provider: "claude", windowType: "weekly", percentUsed: 40, resetsAt: RESET_B, accountId: "claude:work" }),
        usageWindow({ provider: "codex", windowType: "five_hour", percentUsed: Number.NaN, resetsAt: RESET_A }),
        usageWindow({ provider: "codex", windowType: "weekly", percentUsed: 5, resetsAt: "   " }),
      ],
    }, T0);
    const at = new Date(T0).toISOString();
    expect(samples).toEqual([
      { v: 1, at, provider: "claude", accountId: "claude:local", windowType: "five_hour", percentUsed: 12.5, resetsAt: RESET_A },
      { v: 1, at, provider: "claude", accountId: "claude:work", windowType: "weekly", percentUsed: 40, resetsAt: RESET_B },
    ]);
  });

  it("treats a first reading, a new reset time, or a half-point move as a change", () => {
    const base = quotaSample({ percentUsed: 20 });
    expect(quotaSampleChanged(undefined, base)).toBe(true);
    expect(quotaSampleChanged(base, quotaSample({ percentUsed: 20.4 }))).toBe(false);
    expect(quotaSampleChanged(base, quotaSample({ percentUsed: 20.5 }))).toBe(true);
    expect(quotaSampleChanged(base, quotaSample({ percentUsed: 19.5 }))).toBe(true);
    expect(quotaSampleChanged(base, quotaSample({ percentUsed: 20, resetsAt: RESET_B }))).toBe(true);
  });

  it("writes one row for a window whose reset time only jitters by microseconds", async () => {
    const { store, ledger } = newLedger();
    // Claude's `resets_at` moves by microseconds on every poll.
    for (const resetsAt of ["2026-09-23T17:00:00.104823+00:00", "2026-09-23T17:00:00.517002+00:00", "2026-09-23T16:59:59.998871+00:00"]) {
      ledger.observeQuotaSnapshot({ windows: [usageWindow({ provider: "claude", windowType: "five_hour", percentUsed: 20, resetsAt })] });
      clock += 60_000;
    }
    expect(await store.readQuotaSamples()).toHaveLength(1);
  });

  it("writes only changed readings, and remembers the last one across a restart", async () => {
    const { store, ledger } = newLedger();
    const snapshot = (percentUsed: number, resetsAt = RESET_A) => ({
      windows: [usageWindow({ provider: "claude", windowType: "five_hour", percentUsed, resetsAt })],
    });
    const tick = () => { clock += 60_000; };
    ledger.observeQuotaSnapshot(snapshot(20));
    tick();
    ledger.observeQuotaSnapshot(snapshot(20.3));
    tick();
    ledger.observeQuotaSnapshot(snapshot(20.5));
    tick();
    ledger.observeQuotaSnapshot(snapshot(20.5));
    tick();
    ledger.observeQuotaSnapshot(snapshot(20.5, RESET_B));
    const written = async () => (await store.readQuotaSamples()).map((s) => [s.percentUsed, s.resetsAt]);
    expect(await written()).toEqual([[20, RESET_A], [20.5, RESET_A], [20.5, RESET_B]]);

    const restarted = createTurnUsageLedger({ store: createTurnUsageLedgerStore({ dir, nowMs: now }), nowMs: now });
    tick();
    restarted.observeQuotaSnapshot(snapshot(20.5, RESET_B));
    expect(await written()).toHaveLength(3);
    tick();
    restarted.observeQuotaSnapshot(snapshot(21, RESET_B));
    expect(await written()).toEqual([[20, RESET_A], [20.5, RESET_A], [20.5, RESET_B], [21, RESET_B]]);
  });
});

describe("summarizeTurnUsage", () => {
  const groupingRows = [
    row({ turnId: "a1", accountKey: "claude:a", requestedModel: "m1", apiEquivalentUsd: 1 }),
    row({ turnId: "a2", accountKey: "claude:b", requestedModel: "m1", apiEquivalentUsd: 2 }),
    row({ turnId: "a3", accountKey: "claude:a", requestedModel: "m2", apiEquivalentUsd: 4 }),
    row({ turnId: "a4", provider: "codex", accountKey: "codex:local", requestedModel: "m3", apiEquivalentUsd: 0.5 }),
  ];
  const keys = (rows: ReturnType<typeof summarizeTurnUsage>) =>
    rows.map((r) => [r.provider, r.accountKey, r.model, r.turns, r.apiEquivalentUsd]);

  it("groups by provider, provider and model, or provider, account, and model", () => {
    expect(keys(summarizeTurnUsage(groupingRows, "provider"))).toEqual([
      ["claude", null, null, 3, 7],
      ["codex", null, null, 1, 0.5],
    ]);
    expect(keys(summarizeTurnUsage(groupingRows, "provider_model"))).toEqual([
      ["claude", null, "m2", 1, 4],
      ["claude", null, "m1", 2, 3],
      ["codex", null, "m3", 1, 0.5],
    ]);
    expect(keys(summarizeTurnUsage(groupingRows, "provider_account_model"))).toEqual([
      ["claude", "claude:a", "m2", 1, 4],
      ["claude", "claude:b", "m1", 1, 2],
      ["claude", "claude:a", "m1", 1, 1],
      ["codex", "codex:local", "m3", 1, 0.5],
    ]);
    expect(summarizeTurnUsage(groupingRows)).toEqual(summarizeTurnUsage(groupingRows, "provider_account_model"));
  });

  it("sums tokens, provider cost, plan usage, and context over a group", () => {
    const [summary] = summarizeTurnUsage([
      row({
        turnId: "c1",
        inputTokens: 100,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
        outputTokens: 50,
        reasoningTokens: 5,
        apiEquivalentUsd: 1,
        costUsd: 0.5,
        costSource: "provider",
        contextTokens: 1_000,
        planUsage: [{ unit: "premium_request", amount: 1 }],
      }),
      row({
        turnId: "c2",
        inputTokens: 1_000,
        outputTokens: 20,
        apiEquivalentUsd: 2,
        costUsd: 3,
        costSource: "list_price",
        contextTokens: 3_000,
        planUsage: [{ unit: "premium_request", amount: 0.33 }, { unit: "nano_aiu", amount: 5 }],
      }),
      row({ turnId: "c3", apiEquivalentUsd: null, costUsd: 0.25, costSource: "provider", contextTokens: 2_001 }),
      row({ turnId: "c4", contextTokens: 0, planUsage: [{ unit: "premium_request", amount: 1 }] }),
    ], "provider");

    expect(summary).toMatchObject({
      turns: 4,
      inputTokens: 1_100,
      outputTokens: 70,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      reasoningTokens: 5,
      cacheHitRatio: 0.4,
      apiEquivalentUsd: 3,
      pricedTurns: 2,
      providerCostUsd: 0.75,
      medianContextTokens: 2_001,
      maxContextTokens: 3_000,
    });
    expect(summary?.planUsage).toEqual([
      { unit: "premium_request", amount: 2.33 },
      { unit: "nano_aiu", amount: 5 },
    ]);
  });

  it("rounds an even-count median and leaves ratios empty without an input side", () => {
    const [summary] = summarizeTurnUsage([
      row({ turnId: "e1", contextTokens: 1_000, outputTokens: 5 }),
      row({ turnId: "e2", contextTokens: 2_001, outputTokens: 5 }),
    ]);
    expect(summary).toMatchObject({ medianContextTokens: 1_501, cacheHitRatio: null, pricedTurns: 0, providerCostUsd: 0 });
  });

  it("counts a served-model mismatch only when the served model is another model", () => {
    const [summary] = summarizeTurnUsage([
      row({ turnId: "m1", requestedModel: "claude-opus-5-5", servedModel: "anthropic/claude-opus-5-5" }),
      row({ turnId: "m2", requestedModel: "claude-opus-5-5", servedModel: "Claude-Opus-5-5" }),
      row({ turnId: "m3", requestedModel: "claude-opus-5-5", servedModel: "claude-sonnet-5" }),
      row({ turnId: "m4", requestedModel: "claude-opus-5-5", servedModel: null }),
      // The chat mismatch warning's rule: a dated snapshot and a context tier are the same model.
      row({ turnId: "m5", requestedModel: "claude-opus-5-5", servedModel: "claude-opus-5-5[1m]" }),
      row({ turnId: "m6", requestedModel: "claude-haiku-4-5", servedModel: "claude-haiku-4-5-20251001" }),
    ], "provider");
    expect(summary?.servedModelMismatches).toBe(1);

    // A Grok harness prefix and a build variant name one model.
    const [grok] = summarizeTurnUsage([
      row({ turnId: "g1", provider: "grok", requestedModel: "xai/grok-4-5", servedModel: "grok-4.5-build" }),
    ], "provider");
    expect(grok?.servedModelMismatches).toBe(0);
  });

  it("sorts groups by API-equivalent cost, then by turn count", () => {
    const rows = summarizeTurnUsage([
      row({ turnId: "s1", requestedModel: "cheap", apiEquivalentUsd: 0.1 }),
      row({ turnId: "s2", requestedModel: "pricey", apiEquivalentUsd: 9 }),
      row({ turnId: "s3", requestedModel: "free-once" }),
      row({ turnId: "s4", requestedModel: "free-twice" }),
      row({ turnId: "s5", requestedModel: "free-twice" }),
    ]);
    expect(rows.map((r) => r.model)).toEqual(["pricey", "cheap", "free-twice", "free-once"]);
  });
});

describe("buildTurnUsageLedgerSummary", () => {
  it("keeps totals machine-wide but returns only the calling project's recent rows", async () => {
    const store = createTurnUsageLedgerStore({ dir, nowMs: now });
    store.appendTurn(row({ turnId: "a1", projectRoot: "/repo-a", requestedModel: "m1", accountKey: "claude:local" }));
    store.appendTurn(row({ turnId: "b1", projectRoot: "/repo-b", requestedModel: "m1", accountKey: "claude:local" }));
    store.appendTurn(row({ turnId: "a2", projectRoot: "/repo-a/", requestedModel: "m1", accountKey: "claude:local" }));
    const ledger = createTurnUsageLedger({ store, nowMs: now });

    const scoped = await buildTurnUsageLedgerSummary(ledger, { recent: 10 }, T0 + 1_000, { projectRoot: "/repo-a" });
    expect(scoped).toMatchObject({ available: true, turns: 3, groupBy: "provider_account_model" });
    expect(scoped.rows).toEqual([expect.objectContaining({ accountKey: "claude:local", model: "m1", turns: 3 })]);
    expect(scoped.recent?.map((r) => r.turnId)).toEqual(["a1", "a2"]);

    const machine = await buildTurnUsageLedgerSummary(ledger, { recent: 2 }, T0 + 1_000);
    expect(machine.recent?.map((r) => r.turnId)).toEqual(["b1", "a2"]);
  });

  it("reads the turn files once for both the summary span and the longer burn-rate span", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const resetsAt = new Date(T0 + DAY).toISOString();
    const store = createTurnUsageLedgerStore({ dir, nowMs: now });
    store.appendQuotaSample(quotaSample({ at: new Date(T0 - 10 * DAY).toISOString(), percentUsed: 10, resetsAt }));
    store.appendQuotaSample(quotaSample({ at: new Date(T0 - DAY).toISOString(), percentUsed: 30, resetsAt }));
    // Inside the 14-day burn span, outside the 3-day summary span.
    store.appendTurn(row({ turnId: "old", at: new Date(T0 - 5 * DAY).toISOString(), apiEquivalentUsd: 20 }));
    store.appendTurn(row({ turnId: "new", at: new Date(T0 - 1_000).toISOString(), apiEquivalentUsd: 1 }));
    const readTurns = vi.spyOn(store, "readTurns");
    const ledger = createTurnUsageLedger({ store, nowMs: now });

    const summary = await buildTurnUsageLedgerSummary(ledger, { days: 3, recent: 5 }, T0);
    expect(readTurns).toHaveBeenCalledTimes(1);
    expect(readTurns).toHaveBeenCalledWith({ sinceMs: T0 - 14 * DAY });
    expect(summary.turns).toBe(1);
    expect(summary.recent?.map((r) => r.turnId)).toEqual(["new"]);
    expect(summary.burnRates).toEqual([expect.objectContaining({ observedTurns: 1, observedUsd: 20, usdPerPercent: 1 })]);
  });

  it("clamps days and recent, falls back to the default grouping, and answers unavailable without a ledger", async () => {
    const summary = await buildTurnUsageLedgerSummary(null, { days: 500, recent: 9_999, groupBy: "lane" as never }, T0);
    expect(summary).toMatchObject({ available: false, turns: 0, rows: [], burnRates: [], groupBy: "provider_account_model" });
    expect(Date.parse(summary.until) - Date.parse(summary.since)).toBe(90 * 24 * 60 * 60 * 1000);
    expect(summary.recent).toBeUndefined();
  });
});

describe("open turns and turn starts", () => {
  it("evicts the least recently touched open turn, not the oldest one", () => {
    const turns = new Map<string, TurnUsageObservation>();
    const touch = (turnId: string) => observeTurnEvent(turns, "s1", { type: "activity", activity: "thinking", turnId }, T0);
    touch("long");
    for (let index = 0; index < 511; index += 1) touch(`short-${index}`);
    // The long turn is still running; a later event keeps it alive.
    touch("long");
    touch("one-more");
    expect(turns.has("s1:long")).toBe(true);
    expect(turns.has("s1:short-0")).toBe(false);
    expect(turns.size).toBe(512);
  });

  it("answers when the session's next turn started, from open and settled turns", () => {
    const { ledger } = newLedger();
    ledger.observe("s1", { type: "activity", activity: "thinking", turnId: "t1" });
    clock = T0 + 60_000;
    ledger.settle({ session: session(), event: done({ usage: { inputTokens: 1 } }) });
    clock = T0 + 90_000;
    // A turn that sent nothing before done starts, at the latest, when it settles.
    ledger.settle({ session: session(), event: done({ turnId: "t2", usage: { inputTokens: 1 } }) });
    clock = T0 + 120_000;
    ledger.observe("s1", { type: "activity", activity: "thinking", turnId: "t3" });
    ledger.observe("s2", { type: "activity", activity: "thinking", turnId: "other" });

    expect(ledger.nextTurnStartAfter("s1", T0)).toBe(T0 + 90_000);
    expect(ledger.nextTurnStartAfter("s1", T0 + 90_000)).toBe(T0 + 120_000);
    expect(ledger.nextTurnStartAfter("s1", T0 + 120_000)).toBeNull();
    expect(ledger.nextTurnStartAfter("missing", 0)).toBeNull();
  });
});

describe("getSharedTurnUsageLedger", () => {
  it("returns one ledger per ADE directory", () => {
    const first = getSharedTurnUsageLedger(tmpRoot);
    expect(getSharedTurnUsageLedger(`${tmpRoot}${path.sep}`)).toBe(first);
    expect(first.store.dir).toBe(path.join(path.resolve(tmpRoot), "usage"));
    expect(getSharedTurnUsageLedger(path.join(tmpRoot, "other"))).not.toBe(first);
  });
});
