import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdeQuotaSample, AdeTurnUsageRecord } from "../../../shared/types";
import { DEFAULT_ADE_ACCOUNT_DIRECTORY_URL } from "../../../shared/accountDirectory";
import { USAGE_RESEARCH_INSTALL_ID_PATTERN, type UsageResearchDailyBody } from "../../../shared/usageResearch";
import { createTurnUsageLedgerStore, type TurnUsageRead } from "./turnUsageLedger";
import { resetDynamicTokenPricingForTest } from "./usagePricing";
import { usageResearchInstallId } from "./usageResearchReport";
import {
  attachSharedUsageResearchUploader,
  createUsageResearchUploader,
  readUsageResearchState,
  usageResearchStateFilePath,
  type UsageResearchAnalytics,
  type UsageResearchUploader,
  type UsageResearchUploaderDeps,
} from "./usageResearchUploader";

/** 10:00 local on 2026-09-23; every day below is a local day. */
const NOW = new Date(2026, 8, 23, 10, 0).getTime();
const localAt = (day: number, hour = 12) => new Date(2026, 8, day, hour, 0).toISOString();
const dayKey = (day: number) => `2026-09-${String(day).padStart(2, "0")}`;

let tmpRoot: string;
let clock: number;
let seq = 0;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-usage-research-test-"));
  clock = NOW;
  seq = 0;
  resetDynamicTokenPricingForTest({ disableDiskCache: true });
});

afterEach(() => {
  resetDynamicTokenPricingForTest({ disableDiskCache: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function row(atIso: string, overrides: Partial<AdeTurnUsageRecord> = {}): AdeTurnUsageRecord {
  seq += 1;
  return {
    v: 1,
    key: `s${seq}:t${seq}`,
    at: atIso,
    startedAt: null,
    sessionId: `s${seq}`,
    turnId: `t${seq}`,
    projectRoot: "/Users/someone/project",
    laneId: "lane-1",
    surface: "work",
    parentSessionId: null,
    provider: "claude",
    status: "completed",
    requestedModel: "claude-opus-5-5",
    servedModel: null,
    reasoningEffort: "high",
    account: { provider: "claude", kind: "subscription", email: "someone@example.com" },
    accountKey: "claude:someone@example.com",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    cacheWrite1hTokens: null,
    reasoningTokens: null,
    contextTokens: 1_000,
    contextWindow: 200_000,
    requestCount: 1,
    subagentTokens: null,
    costUsd: null,
    costSource: null,
    apiEquivalentUsd: 0.25,
    planUsage: null,
    factoryCreditsSessionTotal: null,
    usageConfidence: "measured",
    durationMs: 1_000,
    compactions: 0,
    ...overrides,
  };
}

function fakeStore(turns: AdeTurnUsageRecord[], samples: AdeQuotaSample[] = []) {
  const readTurnsChecked = vi.fn(async ({ sinceMs = 0 }: { sinceMs?: number } = {}): Promise<TurnUsageRead> => ({
    ok: true,
    rows: turns.filter((r) => Date.parse(r.at) >= sinceMs),
  }));
  const readQuotaSamples = vi.fn(async ({ sinceMs = 0 }: { sinceMs?: number } = {}) => samples.filter((s) => Date.parse(s.at) >= sinceMs));
  return { readTurnsChecked, readQuotaSamples };
}

function analytics(overrides: Partial<{ effective: boolean | (() => boolean); consentSince: string | null }> = {}): UsageResearchAnalytics {
  const effective = () => (typeof overrides.effective === "function" ? overrides.effective() : overrides.effective ?? true);
  return {
    getStatus: () => ({ effective: effective() }),
    getExportConsentSince: () => (effective() ? (overrides.consentSince === undefined ? "2026-01-01T00:00:00.000Z" : overrides.consentSince) : null),
  };
}

type FetchCall = { url: string; init: RequestInit; body: UsageResearchDailyBody };

type Reply = number | Error | { status: number; body: string; headers?: Record<string, string> };

function fetchReplying(...statuses: Reply[]) {
  const calls: FetchCall[] = [];
  let index = 0;
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) as UsageResearchDailyBody });
    const next = statuses[Math.min(index, statuses.length - 1)]!;
    index += 1;
    if (next instanceof Error) throw next;
    const { status, body, headers } = typeof next === "number" ? { status: next, body: "{}", headers: undefined } : next;
    return new Response(body, { status, headers });
  });
  return { impl: impl as unknown as typeof fetch, calls, mock: impl };
}

function uploader(overrides: Partial<UsageResearchUploaderDeps> & Pick<UsageResearchUploaderDeps, "store">): UsageResearchUploader {
  return createUsageResearchUploader({
    adeDir: tmpRoot,
    analytics: analytics(),
    appVersion: "1.2.78",
    logger: { warn: vi.fn(), debug: vi.fn() },
    env: {},
    now: () => clock,
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  });
}

const statePath = () => usageResearchStateFilePath(tmpRoot);

describe("consent", () => {
  it("sends nothing while product analytics is off", async () => {
    const http = fetchReplying(200);
    const store = fakeStore([row(localAt(22))]);
    const result = await uploader({ store, analytics: analytics({ effective: false }), fetchImpl: http.impl }).runOnce();
    expect(result).toEqual({ status: "no_consent" });
    expect(http.mock).not.toHaveBeenCalled();
    expect(store.readTurnsChecked).not.toHaveBeenCalled();
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it("sends nothing when ADE_USAGE_RESEARCH is off", async () => {
    for (const value of ["0", "false", "OFF", " no "]) {
      const http = fetchReplying(200);
      const result = await uploader({ store: fakeStore([row(localAt(22))]), env: { ADE_USAGE_RESEARCH: value }, fetchImpl: http.impl }).runOnce();
      expect(result).toEqual({ status: "disabled" });
      expect(http.mock).not.toHaveBeenCalled();
    }
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it("stops a run part way when analytics is turned off or the flag goes off", async () => {
    let effective = true;
    const http = fetchReplying(200);
    http.mock.mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
      http.calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) as UsageResearchDailyBody });
      effective = false;
      return new Response("{}", { status: 201 });
    });
    const store = fakeStore([row(localAt(20)), row(localAt(21)), row(localAt(22))]);
    const result = await uploader({ store, analytics: analytics({ effective: () => effective }), fetchImpl: http.impl }).runOnce();
    expect(result).toEqual({ status: "no_consent" });
    expect(http.calls.map((call) => call.body.day)).toEqual([dayKey(20)]);
    expect(readUsageResearchState(statePath())!.days).toEqual({ [dayKey(20)]: "sent" });

    const env: NodeJS.ProcessEnv = {};
    const flagged = fetchReplying(200);
    flagged.mock.mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
      flagged.calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) as UsageResearchDailyBody });
      env.ADE_USAGE_RESEARCH = "off";
      return new Response("{}", { status: 201 });
    });
    const again = await uploader({ store, env, fetchImpl: flagged.impl }).runOnce();
    expect(again).toEqual({ status: "disabled" });
    expect(flagged.calls.map((call) => call.body.day)).toEqual([dayKey(21)]);
  });

  it("aborts the request in flight when the uploader stops, and sends nothing after", async () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    let signal: AbortSignal | undefined;
    let reached: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => { reached = resolve; });
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      reached();
    }));
    const upload = uploader({
      store: fakeStore([row(localAt(21)), row(localAt(22))]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
    });
    const run = upload.runOnce();
    await inFlight;
    upload.stop();
    expect(await run).toEqual({ status: "stopped" });
    expect(signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // A stop is not a network failure.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(readUsageResearchState(statePath())!.days).toEqual({});
    expect(await upload.runOnce()).toEqual({ status: "stopped" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("leaves out every turn from before the user last turned analytics on", async () => {
    const http = fetchReplying(200);
    const store = fakeStore([row(localAt(20)), row(localAt(21, 8)), row(localAt(21, 16))]);
    const result = await uploader({
      store,
      analytics: analytics({ consentSince: localAt(21, 12) }),
      fetchImpl: http.impl,
    }).runOnce();
    expect(result).toMatchObject({ status: "ran", sent: [dayKey(21)] });
    expect(http.calls.map((call) => call.body.report.totals.turns)).toEqual([1]);
  });
});

describe("sending", () => {
  it("posts one report for each unsent finished day, oldest first, and never today", async () => {
    const http = fetchReplying(201);
    const store = fakeStore([
      row(localAt(19)),
      row(localAt(21, 9)),
      row(localAt(21, 18)),
      row(localAt(22)),
      row(localAt(23, 9)),
    ]);
    const result = await uploader({ store, fetchImpl: http.impl }).runOnce();

    expect(result).toEqual({ status: "ran", sent: [dayKey(19), dayKey(21), dayKey(22)], rejected: [], retryLater: null });
    expect(http.calls.map((call) => call.body.day)).toEqual([dayKey(19), dayKey(21), dayKey(22)]);
    const [first] = http.calls;
    expect(first!.url).toBe(`${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/usage-research/daily`);
    expect(first!.init.method).toBe("POST");
    expect(first!.init.headers).toEqual({ "content-type": "application/json" });
    const state = readUsageResearchState(statePath());
    expect(first!.body).toMatchObject({
      schemaVersion: 1,
      installId: usageResearchInstallId(state!.salt),
      appVersion: "1.2.78",
      platform: "darwin",
      arch: "arm64",
      utcOffsetMinutes: -new Date(2026, 8, 19, 12).getTimezoneOffset(),
    });
    expect(first!.body.installId).toMatch(USAGE_RESEARCH_INSTALL_ID_PATTERN);
    expect(http.calls[1]!.body.report.totals.turns).toBe(2);
    for (const call of http.calls) {
      const text = String(call.init.body);
      for (const secret of [state!.salt, "someone", "/Users/", "lane-1", "s1:t1"]) expect(text).not.toContain(secret);
    }
    expect(state!.days).toEqual({ [dayKey(19)]: "sent", [dayKey(21)]: "sent", [dayKey(22)]: "sent" });
    expect(state!.salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does not send a day again once it is recorded, even from a new process", async () => {
    const turns = [row(localAt(22))];
    const first = fetchReplying(200);
    await uploader({ store: fakeStore(turns), fetchImpl: first.impl }).runOnce();
    expect(first.calls).toHaveLength(1);
    const refs = first.calls[0]!.body.report.groups.map((group) => group.accountRef);

    const again = fetchReplying(200);
    const same = uploader({ store: fakeStore(turns), fetchImpl: again.impl });
    // A new process re-reads the ledger for the empty days, which are never recorded, and sends nothing.
    expect(await same.runOnce()).toEqual({ status: "ran", sent: [], rejected: [], retryLater: null });
    expect(await same.runOnce()).toEqual({ status: "nothing_to_send" });
    expect(again.mock).not.toHaveBeenCalled();

    // A new day on the same install keeps the same salt, so its refs join the old ones.
    clock = new Date(2026, 8, 24, 10).getTime();
    const later = fetchReplying(200);
    await uploader({ store: fakeStore([...turns, row(localAt(23))]), fetchImpl: later.impl }).runOnce();
    expect(later.calls.map((call) => call.body.day)).toEqual([dayKey(23)]);
    expect(later.calls[0]!.body.report.groups.map((group) => group.accountRef)).toEqual(refs);
  });

  it("sends only the last 7 finished days", async () => {
    const http = fetchReplying(200);
    await uploader({ store: fakeStore([row(localAt(15)), row(localAt(16)), row(localAt(22))]), fetchImpl: http.impl }).runOnce();
    expect(http.calls.map((call) => call.body.day)).toEqual([dayKey(16), dayKey(22)]);
  });

  it("skips a day with no turns without recording it, and reads the ledger only while a day is pending", async () => {
    const http = fetchReplying(200);
    const store = fakeStore([row(localAt(22))]);
    const upload = uploader({ store, fetchImpl: http.impl });
    await upload.runOnce();
    expect(Object.keys(readUsageResearchState(statePath())!.days)).toEqual([dayKey(22)]);
    expect(store.readTurnsChecked).toHaveBeenCalledTimes(1);
    // The empty days are remembered in this process, so the next hour reads nothing.
    expect(await upload.runOnce()).toEqual({ status: "nothing_to_send" });
    expect(store.readTurnsChecked).toHaveBeenCalledTimes(1);
  });

  it("does not take a failed ledger read for empty days", async () => {
    const http = fetchReplying(200);
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const store = fakeStore([row(localAt(22))]);
    store.readTurnsChecked.mockResolvedValueOnce({ ok: false });
    const upload = uploader({ store, fetchImpl: http.impl, logger });

    expect(await upload.runOnce()).toEqual({ status: "failed" });
    expect(http.mock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("usage_research.upload_failed", { kind: "ledger_read" });
    expect(readUsageResearchState(statePath())!.days).toEqual({});

    // The next hour reads again and finds the day's turns.
    expect(await upload.runOnce()).toMatchObject({ status: "ran", sent: [dayKey(22)] });
    expect(store.readTurnsChecked).toHaveBeenCalledTimes(2);
  });

  it("derives the install id from the research salt alone", async () => {
    const http = fetchReplying(200);
    await uploader({ store: fakeStore([row(localAt(22))]), fetchImpl: http.impl }).runOnce();
    const { salt } = readUsageResearchState(statePath())!;
    const [call] = http.calls;
    expect(call!.body.installId).toBe(usageResearchInstallId(salt));
    expect(call!.body.installId).toMatch(USAGE_RESEARCH_INSTALL_ID_PATTERN);
    // A new salt (a new install) is a new id.
    expect(usageResearchInstallId("c".repeat(32))).not.toBe(call!.body.installId);
  });

  it("reads burn rates as of the end of each day from a real ledger store", async () => {
    const store = createTurnUsageLedgerStore({ dir: path.join(tmpRoot, "usage"), nowMs: () => clock });
    const sample = (hour: number, percentUsed: number): AdeQuotaSample => ({
      v: 1, at: localAt(22, hour), provider: "claude", accountId: "claude:someone@example.com", windowType: "weekly", percentUsed, resetsAt: "2026-09-27T00:00:00.000Z",
    });
    store.appendQuotaSample(sample(9, 10));
    store.appendTurn(row(localAt(22, 10), { apiEquivalentUsd: 4 }));
    store.appendQuotaSample(sample(11, 12));
    // The next day moves the window again; the 22nd's report must not see it.
    store.appendTurn(row(localAt(23, 8), { apiEquivalentUsd: 100 }));
    store.appendQuotaSample({ ...sample(9, 50), at: localAt(23, 9) });
    const http = fetchReplying(200);
    await uploader({ store, fetchImpl: http.impl }).runOnce();

    const [call] = http.calls;
    expect(call!.body.day).toBe(dayKey(22));
    expect(call!.body.report.quota).toEqual([expect.objectContaining({ windowType: "weekly", minPercent: 10, maxPercent: 12, samples: 2 })]);
    expect(call!.body.report.burnRates).toEqual([expect.objectContaining({
      windowType: "weekly",
      usdPerPercent: 2,
      observedPercent: 2,
      observedTurns: 1,
      accountRef: call!.body.report.groups[0]!.accountRef,
    })]);
  });
});

describe("failures", () => {
  it("stops the run on any other 429 and tries again next hour", async () => {
    // `constructor` and `__proto__` are keys of every object, not limit codes.
    for (const error of ["slow_down", "constructor", "__proto__", "toString"]) {
      fs.rmSync(statePath(), { force: true });
      const http = fetchReplying({ status: 429, body: JSON.stringify({ error }) });
      const store = fakeStore([row(localAt(21)), row(localAt(22))]);
      const upload = uploader({ store, fetchImpl: http.impl });
      expect(await upload.runOnce()).toEqual({ status: "ran", sent: [], rejected: [], retryLater: "rate_limited" });
      expect(http.calls).toHaveLength(1);
      expect(readUsageResearchState(statePath())!.days).toEqual({});
      clock += 60 * 60 * 1000;
      expect(await upload.runOnce()).toMatchObject({ status: "ran", retryLater: "rate_limited" });
      expect(http.calls).toHaveLength(2);
    }
  });

  it("keeps the timeout armed while it reads the response body", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      // Headers arrive at once; the body never does, until the request is aborted.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 429 });
    });
    const upload = uploader({
      store: fakeStore([row(localAt(22))]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    });
    // Without the timer the body read would never settle and this run would hang.
    expect(await upload.runOnce()).toEqual({ status: "ran", sent: [], rejected: [], retryLater: "rate_limited" });
  });

  for (const [code, reason] of [
    ["usage_research_identity_limit", "identity_limit"],
    ["usage_research_daily_limit", "fleet_limit"],
    ["usage_research_storage_full", "storage_full"],
  ] as const) {
    it(`stops on a 429 ${code} and waits its retry-after before sending again`, async () => {
      const http = fetchReplying(
        { status: 429, body: JSON.stringify({ error: code }), headers: { "retry-after": "7200" } },
        200,
      );
      const store = fakeStore([row(localAt(21)), row(localAt(22))]);
      const upload = uploader({ store, fetchImpl: http.impl });
      expect(await upload.runOnce()).toEqual({ status: "ran", sent: [], rejected: [], retryLater: reason });
      expect(readUsageResearchState(statePath())!.days).toEqual({});

      clock += 60 * 60 * 1000;
      expect(await upload.runOnce()).toEqual({ status: "paused" });
      expect(http.calls).toHaveLength(1);

      clock += 60 * 60 * 1000;
      expect(await upload.runOnce()).toMatchObject({ status: "ran", sent: [dayKey(21), dayKey(22)] });
      expect(http.calls.map((call) => call.body.day)).toEqual([dayKey(21), dayKey(21), dayKey(22)]);
    });
  }

  it("waits for the next UTC midnight after a named 429 with no readable retry-after", async () => {
    const http = fetchReplying({ status: 429, body: JSON.stringify({ error: "usage_research_daily_limit" }), headers: { "retry-after": "soon" } }, 200);
    const upload = uploader({ store: fakeStore([row(localAt(22))]), fetchImpl: http.impl });
    await upload.runOnce();
    const midnight = new Date(clock);
    const nextUtcMidnight = Date.UTC(midnight.getUTCFullYear(), midnight.getUTCMonth(), midnight.getUTCDate() + 1);
    clock = nextUtcMidnight - 1;
    expect(await upload.runOnce()).toEqual({ status: "paused" });
    clock = nextUtcMidnight;
    expect(await upload.runOnce()).toMatchObject({ status: "ran", sent: [dayKey(22)] });
  });

  it("records a 400, 413, or 415 as rejected and moves on to the next day", async () => {
    const http = fetchReplying(400, 413, 415, 200);
    const result = await uploader({ store: fakeStore([row(localAt(19)), row(localAt(20)), row(localAt(21)), row(localAt(22))]), fetchImpl: http.impl }).runOnce();
    expect(result).toEqual({ status: "ran", sent: [dayKey(22)], rejected: [dayKey(19), dayKey(20), dayKey(21)], retryLater: null });
    expect(readUsageResearchState(statePath())!.days).toEqual({
      [dayKey(19)]: "rejected", [dayKey(20)]: "rejected", [dayKey(21)]: "rejected", [dayKey(22)]: "sent",
    });
  });

  it("retries later after a network error, a 5xx, or a 503, and warns once for each kind", async () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const store = fakeStore([row(localAt(22))]);
    const http = fetchReplying(new TypeError("fetch failed"), new TypeError("fetch failed"), 502, 503, 200);
    const upload = uploader({ store, fetchImpl: http.impl, logger });
    const results = [];
    for (let run = 0; run < 5; run += 1) results.push(await upload.runOnce());
    expect(results.map((result) => ("retryLater" in result ? result.retryLater : result.status))).toEqual([
      "network", "network", "server_error", "unavailable", null,
    ]);
    expect(logger.warn.mock.calls.map(([, meta]) => (meta as { kind: string }).kind)).toEqual(["network", "server_error", "unavailable"]);
    expect(readUsageResearchState(statePath())!.days).toEqual({ [dayKey(22)]: "sent" });
  });

  it("records a day that cannot fit the byte cap as rejected without sending it", async () => {
    // 40 accounts x 6 models x 3 efforts: far more groups than 32 KB holds, with a long label on each.
    const turns: AdeTurnUsageRecord[] = [];
    for (let account = 0; account < 40; account += 1) {
      for (let model = 0; model < 6; model += 1) {
        for (const effort of ["low", "medium", "high"]) {
          turns.push(row(localAt(22), { accountKey: `claude:acct-${account}`, requestedModel: `model-${model}-${"x".repeat(100)}`, reasoningEffort: effort }));
        }
      }
    }
    const http = fetchReplying(200);
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const quotaSamples: AdeQuotaSample[] = Array.from({ length: 400 }, (_, index) => ({
      v: 1, at: localAt(22, 12), provider: `p${index}`, accountId: `p${index}:acct`, windowType: `window-${"w".repeat(40)}`, percentUsed: 1, resetsAt: localAt(23),
    }));
    const result = await uploader({ store: fakeStore(turns, quotaSamples), fetchImpl: http.impl, logger }).runOnce();
    expect(result).toEqual({ status: "ran", sent: [], rejected: [dayKey(22)], retryLater: null });
    expect(http.mock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("usage_research.upload_failed", expect.objectContaining({ kind: "too_large" }));
  });
});

describe("state file", () => {
  it("prunes days older than 30 days and drops malformed entries", async () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({
      salt: "b".repeat(32),
      days: { "2026-08-01": "sent", "2026-08-24": "sent", "2026-09-10": "rejected", "junk": "sent", "2026-09-11": "maybe" },
    }));
    const http = fetchReplying(200);
    await uploader({ store: fakeStore([row(localAt(22))]), fetchImpl: http.impl }).runOnce();
    expect(readUsageResearchState(statePath())).toEqual({
      salt: "b".repeat(32),
      days: { "2026-08-24": "sent", "2026-09-10": "rejected", [dayKey(22)]: "sent" },
    });
  });

  it("sends nothing while the salt cannot be saved, and sends once it can", async () => {
    // `<adeHome>/usage` is a file, so the state file cannot be written.
    fs.writeFileSync(path.join(tmpRoot, "usage"), "not a directory");
    const http = fetchReplying(200);
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const store = fakeStore([row(localAt(22))]);
    const upload = uploader({ store, fetchImpl: http.impl, logger });
    expect(await upload.runOnce()).toEqual({ status: "failed" });
    expect(await upload.runOnce()).toEqual({ status: "failed" });
    expect(http.mock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("usage_research.upload_failed", expect.objectContaining({ kind: "state_write" }));

    fs.rmSync(path.join(tmpRoot, "usage"));
    expect(await upload.runOnce()).toMatchObject({ status: "ran", sent: [dayKey(22)] });
    const { salt } = readUsageResearchState(statePath())!;
    expect(http.calls[0]!.body.installId).toBe(usageResearchInstallId(salt));
  });

  it("starts over with a new salt when the file is unreadable", async () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), "{not json");
    expect(readUsageResearchState(statePath())).toBeNull();
    const http = fetchReplying(200);
    await uploader({ store: fakeStore([row(localAt(22))]), fetchImpl: http.impl }).runOnce();
    expect(readUsageResearchState(statePath())!.salt).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("attachSharedUsageResearchUploader", () => {
  it("starts one uploader per ADE home and stops it when the last scope detaches", () => {
    const made: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    const make = () => {
      const fake = { start: vi.fn(), stop: vi.fn(), runOnce: vi.fn() };
      made.push(fake);
      return fake as unknown as UsageResearchUploader;
    };
    const key = path.join(tmpRoot, "home");
    const detachA = attachSharedUsageResearchUploader(key, make);
    const detachB = attachSharedUsageResearchUploader(key, make);
    expect(made).toHaveLength(1);
    expect(made[0]!.start).toHaveBeenCalledTimes(1);
    detachA();
    detachA();
    expect(made[0]!.stop).not.toHaveBeenCalled();
    detachB();
    expect(made[0]!.stop).toHaveBeenCalledTimes(1);
    const detachC = attachSharedUsageResearchUploader(key, make);
    expect(made).toHaveLength(2);
    detachC();
  });
});
