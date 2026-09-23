import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURSOR_TURN_START_SKEW_MS,
  cursorDashboardEventKey,
  cursorDashboardUsageEnabled,
  fetchCursorDashboardUsageEvents,
  parseCursorDashboardUsageEvents,
  readCursorDashboardAccessToken,
  selectCursorTurnEvents,
  summarizeCursorTurnEvents,
  type CursorDashboardUsageEvent,
} from "./cursorDashboardUsage";
import { cursorSessionCookie } from "./extraProviderQuota";

const AGENT_ID = "agent-11111111-2222-4333-8444-555555555555";
const OTHER_AGENT_ID = "agent-99999999-2222-4333-8444-555555555555";
const TURN_START_MS = 1_790_156_400_000;

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

const FAKE_TOKEN = jwt({ sub: "github|12345678", exp: 4_102_444_800 });

/** Shaped exactly like the live grok event (ids redacted). */
function grokRawEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "1790156539649",
    model: "grok-4.7-high",
    kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO_PLUS",
    requestsCosts: 36,
    usageBasedCosts: "-",
    isTokenBasedCall: true,
    tokenUsage: { inputTokens: 313474, outputTokens: 15058, cacheReadTokens: 1446912, totalCents: 144.0751953125 },
    cursorTokenFee: 0,
    isChargeable: true,
    isHeadless: false,
    chargedCents: 144.0751953125,
    conversationId: AGENT_ID,
    subscriptionProductId: "pro-plus",
    ...overrides,
  };
}

/** Shaped exactly like the live composer event. */
function composerRawEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "1790156500000",
    model: "composer-2.5-fast",
    kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO_PLUS",
    requestsCosts: 0.4000000059604645,
    usageBasedCosts: "-",
    isTokenBasedCall: true,
    tokenUsage: { inputTokens: 533, outputTokens: 347, cacheReadTokens: 18144, totalCents: 1.5875999927520752 },
    cursorTokenFee: 0,
    isChargeable: true,
    isHeadless: false,
    chargedCents: 1.5875999927520752,
    conversationId: AGENT_ID,
    subscriptionProductId: "pro-plus",
    ...overrides,
  };
}

function event(overrides: Partial<CursorDashboardUsageEvent> = {}): CursorDashboardUsageEvent {
  return {
    timestampMs: TURN_START_MS + 10_000,
    conversationId: AGENT_ID,
    model: "composer-2.5-fast",
    kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO_PLUS",
    requestsCosts: 1,
    chargedCents: 10,
    totalCents: 10,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1000,
    cacheWriteTokens: 0,
    isChargeable: true,
    isHeadless: false,
    subscriptionProductId: "pro-plus",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function page(events: unknown[], total = events.length): Record<string, unknown> {
  return { totalUsageEventsCount: total, usageEventsDisplay: events };
}

describe("parseCursorDashboardUsageEvents", () => {
  it("reads the verified live event shape", () => {
    const [grok] = parseCursorDashboardUsageEvents(page([grokRawEvent()]));
    expect(grok).toEqual({
      timestampMs: 1790156539649,
      conversationId: AGENT_ID,
      model: "grok-4.7-high",
      kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO_PLUS",
      requestsCosts: 36,
      chargedCents: 144.0751953125,
      totalCents: 144.0751953125,
      inputTokens: 313474,
      outputTokens: 15058,
      cacheReadTokens: 1446912,
      cacheWriteTokens: 0,
      isChargeable: true,
      isHeadless: false,
      subscriptionProductId: "pro-plus",
    });
  });

  it("accepts numeric strings and numbers alike, and reads an optional cacheWriteTokens", () => {
    const [parsed] = parseCursorDashboardUsageEvents(page([composerRawEvent({
      timestamp: 1790156500000,
      requestsCosts: "0.4",
      chargedCents: "1.5",
      tokenUsage: { inputTokens: "533", outputTokens: 347, cacheReadTokens: "18144", cacheWriteTokens: "64", totalCents: "1.5" },
    })]));
    expect(parsed).toMatchObject({
      timestampMs: 1790156500000,
      requestsCosts: 0.4,
      chargedCents: 1.5,
      totalCents: 1.5,
      inputTokens: 533,
      outputTokens: 347,
      cacheReadTokens: 18144,
      cacheWriteTokens: 64,
    });
  });

  it("tolerates a missing tokenUsage, a null conversationId, and garbage fields", () => {
    const [parsed] = parseCursorDashboardUsageEvents(page([{
      timestamp: "1790156539649",
      conversationId: null,
      model: 42,
      requestsCosts: "-",
      chargedCents: "n/a",
      isChargeable: "maybe",
    }]));
    expect(parsed).toMatchObject({
      conversationId: null,
      model: null,
      kind: null,
      requestsCosts: null,
      chargedCents: null,
      totalCents: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      isChargeable: null,
      isHeadless: null,
      subscriptionProductId: null,
    });
  });

  it("skips entries that are not objects or have no usable timestamp", () => {
    const events = parseCursorDashboardUsageEvents(page([
      null,
      42,
      "event",
      [],
      {},
      grokRawEvent({ timestamp: "not-a-number" }),
      grokRawEvent({ timestamp: "0" }),
      grokRawEvent({ timestamp: "" }),
      composerRawEvent(),
    ]));
    expect(events.map((entry) => entry.model)).toEqual(["composer-2.5-fast"]);
  });

  it("returns [] for any body that is not the verified shape", () => {
    for (const body of [null, undefined, "text", 7, [], [grokRawEvent()], {}, { usageEventsDisplay: "nope" }]) {
      expect(parseCursorDashboardUsageEvents(body)).toEqual([]);
    }
  });
});

describe("fetchCursorDashboardUsageEvents", () => {
  it("POSTs the verified request with the session cookie and returns parsed events", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(page([grokRawEvent()])));
    const result = await fetchCursorDashboardUsageEvents({
      startMs: TURN_START_MS,
      endMs: TURN_START_MS + 600_000,
      pageSize: 50,
      readAccessToken: () => FAKE_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.events.map((entry) => entry.model)).toEqual(["grok-4.7-high"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cursor.com/api/dashboard/get-filtered-usage-events");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://cursor.com",
      Referer: "https://cursor.com/dashboard",
    });
    expect(headers.Cookie.startsWith("WorkosCursorSessionToken=")).toBe(true);
    expect(headers.Cookie === `WorkosCursorSessionToken=${encodeURIComponent(cursorSessionCookie(FAKE_TOKEN))}`).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({
      startDate: String(TURN_START_MS),
      endDate: String(TURN_START_MS + 600_000),
      page: 1,
      pageSize: 50,
    });
    expect(JSON.stringify(result).includes(FAKE_TOKEN)).toBe(false);
  });

  it("accepts an async token reader", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(page([])));
    const result = await fetchCursorDashboardUsageEvents({
      startMs: 0,
      endMs: 1,
      readAccessToken: async () => FAKE_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, events: [] });
  });

  it("answers no_token without a request when there is no usable token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(page([])));
    const readers = [() => null, async () => null, () => "   ", () => {
      throw new Error("locked");
    }];
    for (const readAccessToken of readers) {
      const result = await fetchCursorDashboardUsageEvents({
        startMs: 0,
        endMs: 1,
        readAccessToken,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result).toEqual({ ok: false, reason: "no_token" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers http_error with the status on 401", async () => {
    const result = await fetchCursorDashboardUsageEvents({
      startMs: 0,
      endMs: 1,
      readAccessToken: () => FAKE_TOKEN,
      fetchImpl: (async () => jsonResponse({ error: "unauthorized" }, 401)) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "http_error", status: 401 });
  });

  it("answers bad_body for non-JSON and for JSON without the event list", async () => {
    for (const response of [
      () => new Response("<html>login</html>", { status: 200 }),
      () => jsonResponse({ totalUsageEventsCount: 3 }),
    ]) {
      const result = await fetchCursorDashboardUsageEvents({
        startMs: 0,
        endMs: 1,
        readAccessToken: () => FAKE_TOKEN,
        fetchImpl: (async () => response()) as unknown as typeof fetch,
      });
      expect(result).toEqual({ ok: false, reason: "bad_body" });
    }
  });

  it("answers network_error when the request throws, without leaking the token", async () => {
    const result = await fetchCursorDashboardUsageEvents({
      startMs: 0,
      endMs: 1,
      readAccessToken: () => FAKE_TOKEN,
      fetchImpl: (async () => {
        throw new TypeError(`fetch failed for ${FAKE_TOKEN}`);
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "network_error" });
    expect(JSON.stringify(result).includes(FAKE_TOKEN)).toBe(false);
  });

  it("pages until a short page, dropping the repeat a live list shifts onto the next page", async () => {
    const first = [grokRawEvent({ timestamp: "1790156600000" }), grokRawEvent({ timestamp: "1790156590000" })];
    const second = [grokRawEvent({ timestamp: "1790156590000" })];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(page(first, 3)))
      .mockResolvedValueOnce(jsonResponse(page(second, 3)));
    const result = await fetchCursorDashboardUsageEvents({
      startMs: TURN_START_MS,
      endMs: TURN_START_MS + 600_000,
      pageSize: 2,
      readAccessToken: () => FAKE_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body)).page).toBe(2);
    expect(result.ok && result.events.map((entry) => entry.timestampMs)).toEqual([1790156600000, 1790156590000]);
  });

  it("stops once a full page reaches past startMs", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(page([
      grokRawEvent({ timestamp: String(TURN_START_MS + 5_000) }),
      grokRawEvent({ timestamp: String(TURN_START_MS - 5_000) }),
    ], 50)));
    await fetchCursorDashboardUsageEvents({
      startMs: TURN_START_MS,
      endMs: TURN_START_MS + 600_000,
      pageSize: 2,
      readAccessToken: () => FAKE_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops at maxPages and fails the whole fetch when a later page fails", async () => {
    let next = TURN_START_MS + 500_000;
    const fullPage = () => jsonResponse(page([
      grokRawEvent({ timestamp: String(next--) }),
      grokRawEvent({ timestamp: String(next--) }),
    ], 50));
    const capped = vi.fn(async () => fullPage());
    const result = await fetchCursorDashboardUsageEvents({
      startMs: TURN_START_MS,
      endMs: TURN_START_MS + 600_000,
      pageSize: 2,
      maxPages: 3,
      readAccessToken: () => FAKE_TOKEN,
      fetchImpl: capped as unknown as typeof fetch,
    });
    expect(capped).toHaveBeenCalledTimes(3);
    expect(result.ok && result.events).toHaveLength(6);

    const failing = vi.fn()
      .mockResolvedValueOnce(fullPage())
      .mockResolvedValueOnce(jsonResponse({}, 502));
    const failed = await fetchCursorDashboardUsageEvents({
      startMs: TURN_START_MS,
      endMs: TURN_START_MS + 600_000,
      pageSize: 2,
      readAccessToken: () => FAKE_TOKEN,
      fetchImpl: failing as unknown as typeof fetch,
    });
    expect(failed).toEqual({ ok: false, reason: "http_error", status: 502 });
  });
});

describe("selectCursorTurnEvents", () => {
  it("keeps only this agent's events inside the skew window, oldest first", () => {
    expect(CURSOR_TURN_START_SKEW_MS).toBe(10_000);
    const events = [
      event({ timestampMs: TURN_START_MS + 30_000 }),
      event({ timestampMs: TURN_START_MS + 20_000, conversationId: OTHER_AGENT_ID }),
      event({ timestampMs: TURN_START_MS + 20_000, conversationId: null }),
      event({ timestampMs: TURN_START_MS - 10_000 }),
      // The previous turn of the same agent ended just before this one began.
      event({ timestampMs: TURN_START_MS - 10_001 }),
      event({ timestampMs: TURN_START_MS - 90_000 }),
    ];
    const selected = selectCursorTurnEvents(events, { agentId: AGENT_ID, turnStartedAtMs: TURN_START_MS });
    expect(selected.map((entry) => entry.timestampMs)).toEqual([TURN_START_MS - 10_000, TURN_START_MS + 30_000]);

    const tight = selectCursorTurnEvents(events, { agentId: AGENT_ID, turnStartedAtMs: TURN_START_MS, skewMs: 0 });
    expect(tight.map((entry) => entry.timestampMs)).toEqual([TURN_START_MS + 30_000]);
  });

  it("drops events already reconciled and duplicate keys", () => {
    const done = event({ timestampMs: TURN_START_MS + 1_000 });
    const fresh = event({ timestampMs: TURN_START_MS + 2_000 });
    const selected = selectCursorTurnEvents([fresh, done, fresh], {
      agentId: AGENT_ID,
      turnStartedAtMs: TURN_START_MS,
      seenKeys: new Set([cursorDashboardEventKey(done)]),
    });
    expect(selected).toEqual([fresh]);
  });

  it("matches nothing for an empty agent id", () => {
    expect(selectCursorTurnEvents([event()], { agentId: " ", turnStartedAtMs: TURN_START_MS })).toEqual([]);
  });
});

describe("summarizeCursorTurnEvents", () => {
  it("returns null for no events", () => {
    expect(summarizeCursorTurnEvents([])).toBeNull();
  });

  it("names the model that billed the most and sums cost, requests, and tokens", () => {
    const [grok, composer] = parseCursorDashboardUsageEvents(page([grokRawEvent(), composerRawEvent()]));
    const summary = summarizeCursorTurnEvents([composer, grok]);
    expect(summary).toEqual({
      servedModel: "grok-4.7-high",
      costUsd: 1.456628,
      requests: 36.4,
      inputTokens: 313474 + 533,
      outputTokens: 15058 + 347,
      cacheReadTokens: 1446912 + 18144,
      cacheWriteTokens: 0,
      eventKeys: [cursorDashboardEventKey(composer), cursorDashboardEventKey(grok)],
      chargeable: true,
    });
  });

  it("breaks a cost tie toward the latest event and skips events without a model", () => {
    const summary = summarizeCursorTurnEvents([
      event({ timestampMs: TURN_START_MS + 2_000, model: "late", chargedCents: 5 }),
      event({ timestampMs: TURN_START_MS + 1_000, model: "early", chargedCents: 5 }),
      event({ timestampMs: TURN_START_MS + 3_000, model: null, chargedCents: 50 }),
    ]);
    expect(summary?.servedModel).toBe("late");
  });

  it("keeps cost and requests null when no event reported them", () => {
    const summary = summarizeCursorTurnEvents([
      event({ chargedCents: null, requestsCosts: null, isChargeable: false, model: "auto-pick" }),
    ]);
    expect(summary).toMatchObject({ servedModel: "auto-pick", costUsd: null, requests: null, chargeable: false });
  });
});

describe("cursorDashboardUsageEnabled", () => {
  it("is on by default and off only for the shared kill-switch spellings", () => {
    expect(cursorDashboardUsageEnabled({})).toBe(true);
    for (const value of ["1", "true", "on", "", "yes"]) {
      expect(cursorDashboardUsageEnabled({ ADE_CURSOR_DASHBOARD_USAGE: value })).toBe(true);
    }
    for (const value of ["0", "false", "off", " OFF ", "False", "no"]) {
      expect(cursorDashboardUsageEnabled({ ADE_CURSOR_DASHBOARD_USAGE: value })).toBe(false);
    }
  });
});

describe("readCursorDashboardAccessToken", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-dashboard-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function stateDb(name: string, token: string): string {
    // A runtime require: the test bundler rewrites a static `node:sqlite` import.
    const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
    const dbPath = path.join(dir, name);
    const db = new DatabaseSync(dbPath);
    db.exec("create table ItemTable (key text unique on conflict replace, value blob)");
    db.prepare("insert into ItemTable (key, value) values (?, ?)").run("cursorAuth/accessToken", Buffer.from(` ${token}\0`));
    db.close();
    return dbPath;
  }

  it("reads the token from Cursor's state database and answers null on any failure", async () => {
    const dbPath = stateDb("state.vscdb", FAKE_TOKEN);
    expect(await readCursorDashboardAccessToken(dbPath, TURN_START_MS) === FAKE_TOKEN).toBe(true);
    expect(await readCursorDashboardAccessToken(path.join(dir, "missing.vscdb"), TURN_START_MS)).toBeNull();

    const garbagePath = path.join(dir, "garbage.vscdb");
    fs.writeFileSync(garbagePath, "not a database");
    expect(await readCursorDashboardAccessToken(garbagePath, TURN_START_MS)).toBeNull();
  });

  it("does not hand out an expired token, so no request is sent with it", async () => {
    const expired = jwt({ sub: "github|12345678", exp: Math.floor(TURN_START_MS / 1000) - 60 });
    const dbPath = stateDb("expired.vscdb", expired);
    expect(await readCursorDashboardAccessToken(dbPath, TURN_START_MS)).toBeNull();

    const fetchImpl = vi.fn(async () => jsonResponse(page([])));
    const result = await fetchCursorDashboardUsageEvents({
      startMs: 0,
      endMs: 1,
      readAccessToken: () => readCursorDashboardAccessToken(dbPath, TURN_START_MS),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "no_token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
