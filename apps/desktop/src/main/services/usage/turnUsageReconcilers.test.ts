import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdeTurnUsageRecord } from "../../../shared/types";
import {
  CURSOR_DASHBOARD_RECONCILE_DELAYS_MS,
  type CursorDashboardFetchResult,
  type CursorDashboardUsageEvent,
} from "./cursorDashboardUsage";
import { _testing, scheduleCursorDashboardReconcile, scheduleFactoryCreditsReconcile } from "./turnUsageReconcilers";
import { resetDynamicTokenPricingForTest, setDynamicTokenPricingForTest, tokenPrice } from "./usagePricing";

const AGENT_ID = "agent-11111111-2222-4333-8444-555555555555";
const OTHER_AGENT_ID = "agent-99999999-2222-4333-8444-555555555555";
const START = Date.UTC(2026, 8, 23, 10);
const END = START + 120_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Lets a scheduled attempt's awaited fetch settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function scheduler() {
  const calls: Array<{ run: () => void; delayMs: number }> = [];
  const schedule = (run: () => void, delayMs: number) => {
    calls.push({ run, delayMs });
  };
  const runAt = async (index: number) => {
    calls[index]!.run();
    await flush();
  };
  return { calls, schedule, runAt };
}

function record(overrides: Partial<AdeTurnUsageRecord> = {}): AdeTurnUsageRecord {
  return {
    v: 1,
    key: "s1:t1",
    sessionId: "s1",
    turnId: "t1",
    at: iso(END),
    startedAt: iso(START),
    projectRoot: null,
    laneId: null,
    surface: null,
    parentSessionId: null,
    provider: "cursor",
    status: "completed",
    requestedModel: null,
    servedModel: null,
    reasoningEffort: null,
    account: null,
    accountKey: "cursor:local",
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

function cursorEvent(overrides: Partial<CursorDashboardUsageEvent> = {}): CursorDashboardUsageEvent {
  return {
    timestampMs: START + 10_000,
    conversationId: AGENT_ID,
    model: "composer-2.5-fast",
    kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO_PLUS",
    requestsCosts: 0.5,
    chargedCents: 2,
    totalCents: 2,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 1_000,
    cacheWriteTokens: 0,
    isChargeable: true,
    isHeadless: false,
    subscriptionProductId: "pro-plus",
    ...overrides,
  };
}

const e1 = cursorEvent();
/** Lands after the turn's `done`, inside the grace period. */
const e2 = cursorEvent({
  timestampMs: END + 30_000,
  model: "grok-4.7-high",
  requestsCosts: 2,
  chargedCents: 48,
  totalCents: 48,
  inputTokens: 300,
  outputTokens: 20,
  cacheReadTokens: 2_000,
  cacheWriteTokens: 50,
});
/** Events that are not this turn's: they would dominate every sum if counted. */
const noise = [
  cursorEvent({ timestampMs: START + 15_000, conversationId: OTHER_AGENT_ID, model: "other-agent", chargedCents: 999, inputTokens: 1_000_000 }),
  // The same agent's previous turn, just before this one started.
  cursorEvent({ timestampMs: START - 10_001, model: "too-early", chargedCents: 999, inputTokens: 1_000_000 }),
  cursorEvent({ timestampMs: END + 60_001, model: "too-late", chargedCents: 999, inputTokens: 1_000_000 }),
];
const nothingYet: CursorDashboardFetchResult = { ok: true, events: noise };

beforeEach(() => {
  _testing.resetReconcilerState();
  // $2 input, $10 output, $0.20 cache read, $2.50 cache write per million tokens.
  setDynamicTokenPricingForTest({
    "grok-4.7-high": tokenPrice(2, 10, 0.2, 2.5),
    "gpt-6-sol": tokenPrice(2, 10, 0.2, 2.5),
    "cursor-requested-model": tokenPrice(4, 20, 0.4, 5),
  });
});

afterEach(() => {
  resetDynamicTokenPricingForTest({ disableDiskCache: true });
});

describe("scheduleCursorDashboardReconcile", () => {
  it("amends the row from this agent's events at the first attempt that finds them", async () => {
    const { calls, schedule, runAt } = scheduler();
    const amend = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const found: CursorDashboardFetchResult = { ok: true, events: [e2, ...noise, e1] };
    const fetchEvents = vi.fn().mockResolvedValueOnce(nothingYet).mockResolvedValueOnce(found);
    let clock = END + 1_000;

    scheduleCursorDashboardReconcile({
      ledger: { amend },
      record: record({ planUsage: [{ unit: "nano_aiu", amount: 2 }, { unit: "cursor_request", amount: 99 }] }),
      agentId: AGENT_ID,
      logger,
      fetchEvents,
      schedule,
      delaysMs: [1_000, 5_000, 12_000],
      nowMs: () => clock,
    });
    expect(calls.map((c) => c.delayMs)).toEqual([1_000]);

    clock = END + 2_000;
    await runAt(0);
    expect(fetchEvents).toHaveBeenLastCalledWith({ startMs: START - 10_000, endMs: END + 2_000 });
    expect(amend).not.toHaveBeenCalled();
    expect(calls.map((c) => c.delayMs)).toEqual([1_000, 4_000]);

    clock = END + 6_000;
    await runAt(1);
    expect(amend).toHaveBeenCalledTimes(1);
    expect(amend).toHaveBeenCalledWith("s1:t1", "cursor_dashboard", {
      usageConfidence: "measured",
      inputTokens: 400,
      outputTokens: 30,
      cacheReadTokens: 3_000,
      cacheWriteTokens: 50,
      // The dashboard's tokens at the served model's list price:
      // 400 * $2 + 30 * $10 + 3,000 * $0.20 + 50 * $2.50 per million.
      apiEquivalentUsd: 0.001825,
      servedModel: "grok-4.7-high",
      costUsd: 0.5,
      costSource: "provider",
      planUsage: [{ unit: "nano_aiu", amount: 2 }, { unit: "cursor_request", amount: 2.5 }],
    });
    expect(calls).toHaveLength(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("uses each dashboard event for one turn only", async () => {
    const { schedule, runAt } = scheduler();
    const amend = vi.fn();
    const e3 = cursorEvent({
      timestampMs: END + 100_000,
      model: "gpt-6-sol",
      requestsCosts: 1,
      chargedCents: 10,
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
    });
    const fetchEvents = vi.fn().mockResolvedValue({ ok: true, events: [e1, e2, e3] } satisfies CursorDashboardFetchResult);
    const common = { ledger: { amend }, agentId: AGENT_ID, fetchEvents, schedule, nowMs: () => END + 200_000 };

    scheduleCursorDashboardReconcile({ ...common, record: record() });
    await runAt(0);
    expect(amend.mock.calls[0]?.[2]).toMatchObject({ inputTokens: 400, servedModel: "grok-4.7-high" });

    // The same agent's next turn: e2 is still inside its window, but turn one used it.
    scheduleCursorDashboardReconcile({
      ...common,
      record: record({ key: "s1:t2", turnId: "t2", startedAt: iso(END + 10_000), at: iso(END + 150_000) }),
    });
    await runAt(1);
    expect(amend).toHaveBeenCalledTimes(2);
    expect(amend.mock.calls[1]).toEqual(["s1:t2", "cursor_dashboard", {
      usageConfidence: "measured",
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      apiEquivalentUsd: 0.000044,
      servedModel: "gpt-6-sol",
      costUsd: 0.1,
      costSource: "provider",
      planUsage: [{ unit: "cursor_request", amount: 1 }],
    }]);
  });

  it("prices the amendment at the requested model when no event names one, and leaves an unpriced model null", async () => {
    const { schedule, runAt } = scheduler();
    const amend = vi.fn();
    const unnamed = cursorEvent({ model: null, inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const common = {
      ledger: { amend },
      agentId: AGENT_ID,
      fetchEvents: vi.fn().mockResolvedValue({ ok: true, events: [unnamed] } satisfies CursorDashboardFetchResult),
      schedule,
      nowMs: () => END + 200_000,
    };

    scheduleCursorDashboardReconcile({ ...common, record: record({ requestedModel: "cursor-requested-model" }) });
    await runAt(0);
    // 1,000 * $4 + 100 * $20 per million.
    expect(amend.mock.calls[0]?.[2]).toMatchObject({ apiEquivalentUsd: 0.006 });
    expect(amend.mock.calls[0]?.[2]).not.toHaveProperty("servedModel");

    _testing.resetReconcilerState();
    scheduleCursorDashboardReconcile({ ...common, record: record({ requestedModel: "unlisted-model-zz9" }) });
    await runAt(1);
    expect(amend.mock.calls[1]?.[2]).toMatchObject({ apiEquivalentUsd: null });
  });

  it("stops quietly when this machine has no Cursor login", async () => {
    const { calls, schedule, runAt } = scheduler();
    const amend = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const fetchEvents = vi.fn().mockResolvedValue({ ok: false, reason: "no_token" } satisfies CursorDashboardFetchResult);
    scheduleCursorDashboardReconcile({ ledger: { amend }, record: record(), agentId: AGENT_ID, logger, fetchEvents, schedule });
    await runAt(0);
    expect(calls).toHaveLength(1);
    expect(amend).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs an HTTP failure and stops", async () => {
    const { calls, schedule, runAt } = scheduler();
    const amend = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const fetchEvents = vi.fn().mockResolvedValue({ ok: false, reason: "http_error", status: 401 } satisfies CursorDashboardFetchResult);
    scheduleCursorDashboardReconcile({ ledger: { amend }, record: record(), agentId: AGENT_ID, logger, fetchEvents, schedule });
    await runAt(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("usage.cursor_dashboard_reconcile_failed", {
      reason: "http_error",
      status: 401,
      attempt: 1,
    });
    expect(calls).toHaveLength(1);
    expect(amend).not.toHaveBeenCalled();
  });

  it("logs a thrown fetch instead of letting it escape", async () => {
    const { schedule, runAt } = scheduler();
    const amend = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const fetchEvents = vi.fn().mockRejectedValue(new Error("boom"));
    scheduleCursorDashboardReconcile({ ledger: { amend }, record: record(), agentId: AGENT_ID, logger, fetchEvents, schedule });
    await runAt(0);
    expect(logger.warn).toHaveBeenCalledWith("usage.cursor_dashboard_reconcile_failed", { reason: "exception", error: "boom", attempt: 1 });
    expect(amend).not.toHaveBeenCalled();
  });

  it("logs a thrown fetch on a retry attempt too", async () => {
    const { schedule, runAt } = scheduler();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const fetchEvents = vi.fn()
      .mockResolvedValueOnce(nothingYet)
      .mockRejectedValueOnce(new Error("retry boom"))
      .mockRejectedValueOnce("plain failure");
    scheduleCursorDashboardReconcile({ ledger: { amend: vi.fn() }, record: record(), agentId: AGENT_ID, logger, fetchEvents, schedule });
    await runAt(0);
    await runAt(1);
    expect(logger.warn).toHaveBeenCalledWith("usage.cursor_dashboard_reconcile_failed", { reason: "exception", error: "retry boom", attempt: 2 });
  });

  it("keeps the next turn's events out of a turn that ended just before it", async () => {
    const { schedule, runAt } = scheduler();
    const amend = vi.fn();
    const ledger = { amend };
    // The same agent runs turn 2 twenty seconds after turn 1's done, inside turn 1's grace period.
    const nextStart = END + 20_000;
    const mine = cursorEvent({ timestampMs: END - 5_000, model: "turn-one", chargedCents: 3 });
    const next = cursorEvent({ timestampMs: nextStart + 5_000, model: "turn-two", chargedCents: 50, inputTokens: 9_999 });
    const fetchEvents = vi.fn().mockResolvedValue({ ok: true, events: [mine, next] } satisfies CursorDashboardFetchResult);
    let nextTurnStart: number | null = null;
    const nextTurnStartAfter = vi.fn((afterMs: number) => (nextTurnStart != null && nextTurnStart > afterMs ? nextTurnStart : null));

    scheduleCursorDashboardReconcile({ ledger, record: record(), agentId: AGENT_ID, nextTurnStartAfter, fetchEvents, schedule });
    // Turn 2 starts after turn 1 settled; the bound is read when the attempt runs.
    nextTurnStart = nextStart;
    await runAt(0);
    expect(nextTurnStartAfter).toHaveBeenCalledWith(START);
    expect(amend.mock.calls[0]?.[2]).toMatchObject({ servedModel: "turn-one", costUsd: 0.03, inputTokens: 100 });

    // Turn 2 then claims its own event.
    scheduleCursorDashboardReconcile({
      ledger,
      record: record({ key: "s1:t2", turnId: "t2", startedAt: iso(nextStart), at: iso(nextStart + 30_000) }),
      agentId: AGENT_ID,
      nextTurnStartAfter: () => null,
      fetchEvents,
      schedule,
    });
    await runAt(1);
    expect(amend.mock.calls[1]?.[0]).toBe("s1:t2");
    expect(amend.mock.calls[1]?.[2]).toMatchObject({ servedModel: "turn-two", costUsd: 0.5 });
  });

  it("gives up without an amendment when no attempt finds the turn", async () => {
    const { calls, schedule, runAt } = scheduler();
    const amend = vi.fn();
    const fetchEvents = vi.fn().mockResolvedValue(nothingYet);
    scheduleCursorDashboardReconcile({ ledger: { amend }, record: record(), agentId: AGENT_ID, fetchEvents, schedule });
    for (let index = 0; index < CURSOR_DASHBOARD_RECONCILE_DELAYS_MS.length; index += 1) await runAt(index);

    const delays = CURSOR_DASHBOARD_RECONCILE_DELAYS_MS;
    expect(calls.map((c) => c.delayMs)).toEqual(delays.map((delay, index) => (index === 0 ? delay : delay - delays[index - 1]!)));
    expect(fetchEvents).toHaveBeenCalledTimes(delays.length);
    expect(amend).not.toHaveBeenCalled();
  });

  it("schedules nothing without an agent id", () => {
    const { calls, schedule } = scheduler();
    const fetchEvents = vi.fn();
    scheduleCursorDashboardReconcile({ ledger: { amend: vi.fn() }, record: record(), agentId: "   ", fetchEvents, schedule });
    expect(calls).toHaveLength(0);
    expect(fetchEvents).not.toHaveBeenCalled();
  });
});

describe("scheduleFactoryCreditsReconcile", () => {
  it("writes the session total on the first read and each later turn's credit delta", async () => {
    const { calls, schedule, runAt } = scheduler();
    const amend = vi.fn();
    const fetchCredits = vi.fn()
      .mockResolvedValueOnce(12.5)
      .mockResolvedValueOnce(20.25)
      .mockResolvedValueOnce(3);
    const ledger = { amend };
    const droid = (overrides: Partial<AdeTurnUsageRecord>, droidSessionId = "droid-1") =>
      scheduleFactoryCreditsReconcile({ ledger, record: record({ provider: "droid", ...overrides }), droidSessionId, fetchCredits, schedule, delayMs: 5 });

    droid({ key: "s1:t1", turnId: "t1" });
    expect(calls[0]?.delayMs).toBe(5);
    await runAt(0);
    expect(fetchCredits).toHaveBeenLastCalledWith("droid-1");
    expect(amend).toHaveBeenLastCalledWith("s1:t1", "factory_sessions", { factoryCreditsSessionTotal: 12.5 });

    droid({ key: "s1:t2", turnId: "t2", planUsage: [{ unit: "factory_credit", amount: 999 }, { unit: "nano_aiu", amount: 1 }] });
    await runAt(1);
    expect(amend).toHaveBeenLastCalledWith("s1:t2", "factory_sessions", {
      factoryCreditsSessionTotal: 20.25,
      planUsage: [{ unit: "nano_aiu", amount: 1 }, { unit: "factory_credit", amount: 7.75 }],
    });

    // Another Droid session starts from its own first read.
    droid({ key: "s2:t1", sessionId: "s2", turnId: "t1" }, "droid-2");
    await runAt(2);
    expect(amend).toHaveBeenLastCalledWith("s2:t1", "factory_sessions", { factoryCreditsSessionTotal: 3 });
  });

  it("applies one session's reads in order, so a slow earlier read cannot replace a newer total", async () => {
    const { schedule, runAt } = scheduler();
    const amend = vi.fn();
    const ledger = { amend };
    let releaseFirst: (value: number) => void = () => {};
    const fetchCredits = vi.fn()
      .mockImplementationOnce(() => new Promise<number>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(20);
    const droid = (turnId: string) => scheduleFactoryCreditsReconcile({
      ledger,
      record: record({ provider: "droid", key: `s1:${turnId}`, turnId }),
      droidSessionId: "droid-1",
      fetchCredits,
      schedule,
    });

    droid("t1");
    droid("t2");
    await runAt(0);
    await runAt(1);
    // The second read waits for the first.
    expect(fetchCredits).toHaveBeenCalledTimes(1);
    releaseFirst(12);
    await flush();
    expect(fetchCredits).toHaveBeenCalledTimes(2);
    expect(amend.mock.calls).toEqual([
      ["s1:t1", "factory_sessions", { factoryCreditsSessionTotal: 12 }],
      ["s1:t2", "factory_sessions", { factoryCreditsSessionTotal: 20, planUsage: [{ unit: "factory_credit", amount: 8 }] }],
    ]);
  });

  it("keeps each ledger's session totals apart", async () => {
    const { schedule, runAt } = scheduler();
    const first = { amend: vi.fn() };
    const second = { amend: vi.fn() };
    const fetchCredits = vi.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(9);
    scheduleFactoryCreditsReconcile({ ledger: first, record: record(), droidSessionId: "droid-1", fetchCredits, schedule });
    scheduleFactoryCreditsReconcile({ ledger: second, record: record(), droidSessionId: "droid-1", fetchCredits, schedule });
    await runAt(0);
    await runAt(1);
    // The second ledger never saw the first total, so its read is a first read.
    expect(second.amend).toHaveBeenCalledWith("s1:t1", "factory_sessions", { factoryCreditsSessionTotal: 9 });
  });

  it("writes nothing when the read comes back empty", async () => {
    const { schedule, runAt } = scheduler();
    const amend = vi.fn();
    const fetchCredits = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(8);
    const args = { ledger: { amend }, record: record({ provider: "droid" }), droidSessionId: "droid-1", fetchCredits, schedule };
    scheduleFactoryCreditsReconcile(args);
    await runAt(0);
    expect(amend).not.toHaveBeenCalled();

    // The empty read left no baseline behind: the next read is a first read.
    scheduleFactoryCreditsReconcile(args);
    await runAt(1);
    expect(amend).toHaveBeenCalledWith("s1:t1", "factory_sessions", { factoryCreditsSessionTotal: 8 });
  });

  it("schedules nothing for a blank Droid session id", () => {
    const { calls, schedule } = scheduler();
    const fetchCredits = vi.fn();
    scheduleFactoryCreditsReconcile({ ledger: { amend: vi.fn() }, record: record(), droidSessionId: "  ", fetchCredits, schedule });
    expect(calls).toHaveLength(0);
    expect(fetchCredits).not.toHaveBeenCalled();
  });

  it("logs a failed read", async () => {
    const { schedule, runAt } = scheduler();
    const amend = vi.fn();
    const logger = { warn: vi.fn() };
    const fetchCredits = vi.fn().mockRejectedValue(new Error("offline"));
    scheduleFactoryCreditsReconcile({ ledger: { amend }, record: record(), droidSessionId: "droid-1", logger, fetchCredits, schedule });
    await runAt(0);
    expect(logger.warn).toHaveBeenCalledWith("usage.factory_credits_reconcile_failed", { error: "offline" });
    expect(amend).not.toHaveBeenCalled();
  });
});
