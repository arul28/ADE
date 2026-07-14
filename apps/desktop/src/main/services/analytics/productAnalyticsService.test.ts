import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatTurnSettledEvent } from "../chat/agentChatService";
import { openKvDb } from "../state/kvDb";
import { localDayKey, localDayOffset } from "../usage/localDay";
import { recordUsageInteraction } from "../usage/usageStatsStore";
import type { AdeUsageStats } from "../../../shared/types";
import {
  parseProductAnalyticsCapture,
  type ProductAnalyticsCapture,
} from "../../../shared/types/productAnalytics";
import { captureAgentTurnSettledAnalytics } from "./agentTurnProductAnalytics";
import {
  captureDailyUsageAnalytics,
  completedDailyUsageAnalyticsTarget,
} from "./dailyUsageAnalytics";
import {
  createProductAnalyticsService,
  type ProductAnalyticsClient,
  type ProductAnalyticsService,
} from "./productAnalyticsService";
import { createUsageProductAnalyticsExporter } from "./usageProductAnalyticsExporter";

function makeHarness(options: {
  token?: string;
  dailyBudget?: number;
  now?: () => number;
  root?: string;
  messages?: Array<Record<string, unknown>>;
  appVersion?: string;
} = {}) {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "ade-product-analytics-"));
  const messages = options.messages ?? [];
  let flushes = 0;
  let shutdowns = 0;
  const shutdownArgs: Array<[number | undefined, { flush?: boolean } | undefined]> = [];
  const client: ProductAnalyticsClient = {
    capture: (message) => messages.push(message),
    flush: async () => { flushes += 1; },
    shutdown: async (timeoutMs, shutdownOptions) => {
      shutdowns += 1;
      shutdownArgs.push([timeoutMs, shutdownOptions]);
    },
  };
  const service = createProductAnalyticsService({
    stateFilePath: path.join(root, "analytics.json"),
    logger: { debug: vi.fn(), warn: vi.fn() } as never,
    appVersion: options.appVersion ?? "1.2.3",
    runtimeMode: "test_harness",
    projectToken: options.token ?? "phc_test_project_token",
    dailyBudget: options.dailyBudget,
    now: options.now,
    makeClient: () => client,
  });
  return {
    root,
    service,
    messages,
    get flushes() { return flushes; },
    get shutdowns() { return shutdowns; },
    shutdownArgs,
  };
}

describe("productAnalyticsService", () => {
  beforeEach(() => {
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADE_DISABLE_PRODUCT_ANALYTICS", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sanitizes properties and hashes operational identifiers", () => {
    expect(parseProductAnalyticsCapture(null, "desktop")).toEqual({ ok: false, reason: "invalid_event" });
    expect(parseProductAnalyticsCapture({ event: "unknown" }, "desktop")).toEqual({
      ok: false,
      reason: "invalid_event",
    });
    expect(parseProductAnalyticsCapture({ event: "ade_app_opened", surface: "unknown" })).toEqual({
      ok: false,
      reason: "invalid_surface",
    });
    const harness = makeHarness();
    const result = harness.service.capture({
      event: "ade_feature_used",
      surface: "desktop",
      projectId: "/Users/alice/secret-project",
      sessionId: "chat-private-id",
      clientEventId: "11111111-1111-4111-8111-111111111111",
      properties: {
        feature: "Work",
        action: "chat.send",
        outcome: "success",
        prompt: "never send this",
        path: "/Users/alice/secret.ts",
      },
    });

    expect(result).toEqual({ accepted: true, reason: "accepted" });
    expect(harness.messages).toHaveLength(1);
    const message = harness.messages[0] as { distinctId: string; uuid: string; properties: Record<string, unknown> };
    expect(message.distinctId).toMatch(/^ade_[0-9a-f]{32}$/);
    expect(message.uuid).toBe("11111111-1111-4111-8111-111111111111");
    expect(message.properties).toMatchObject({
      surface: "desktop",
      feature: "work",
      action: "chat.send",
      outcome: "success",
      app_version: "1.2.3",
      runtime_mode: "test_harness",
      $process_person_profile: false,
      $geoip_disable: true,
    });
    expect(message.properties.project_id).toMatch(/^[0-9a-f]{24}$/);
    expect(message.properties.session_id).toMatch(/^[0-9a-f]{24}$/);
    expect(message.properties).not.toHaveProperty("prompt");
    expect(message.properties).not.toHaveProperty("path");
    expect(JSON.stringify(message)).not.toContain("secret-project");
    expect(fs.readFileSync(path.join(harness.root, "analytics.json"), "utf8")).not.toContain("secret-project");
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it("does not forward arbitrary build-controlled version text", () => {
    const harness = makeHarness({ appVersion: "../../private/project\nsecret" });
    expect(harness.service.capture({
      event: "ade_app_opened",
      surface: "api",
    })).toEqual({ accepted: true, reason: "accepted" });
    const message = harness.messages[0] as { properties: Record<string, unknown> };
    expect(message.properties.app_version).toBe("unknown");
    expect(JSON.stringify(message)).not.toContain("private/project");
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it("rejects oversized action and error text before normalization", () => {
    const harness = makeHarness();
    const oversized = "timeout".repeat(50_000);
    expect(harness.service.capture({
      event: "ade_error",
      surface: "api",
      properties: {
        feature: "work",
        action: oversized,
        error_kind: oversized,
      },
    })).toEqual({ accepted: true, reason: "accepted" });
    const message = harness.messages[0] as { properties: Record<string, unknown> };
    expect(message.properties).not.toHaveProperty("action");
    expect(message.properties).not.toHaveProperty("error_kind");
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it("keeps marketing traffic structurally outside canonical product events", () => {
    const harness = makeHarness();
    expect(harness.service.capture({
      event: "ade_screen_viewed",
      surface: "web",
      properties: { screen: "work", route_kind: "marketing" },
    })).toEqual({ accepted: true, reason: "accepted" });
    const message = harness.messages[0] as { properties: Record<string, unknown> };
    expect(message.properties).not.toHaveProperty("route_kind");
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it("shares restart-safe quotas and dedupe state across processes", () => {
    let nowMs = Date.parse("2026-07-13T12:00:00.000Z");
    const first = makeHarness({ dailyBudget: 25, now: () => nowMs });
    const second = makeHarness({
      root: first.root,
      messages: first.messages,
      dailyBudget: 25,
      now: () => nowMs,
    });
    const event = {
      event: "ade_feature_used" as const,
      surface: "api" as const,
      properties: { feature: "work", action: "chat.create" },
    };

    expect(first.service.capture({ ...event, dedupeKey: "shared-secret-key" }).accepted).toBe(true);
    expect(second.service.capture({ ...event, dedupeKey: "shared-secret-key" })).toEqual({
      accepted: false,
      reason: "duplicate",
    });
    for (let index = 0; index < 24; index += 1) {
      nowMs += 61_000;
      const service = index % 2 === 0 ? first.service : second.service;
      expect(service.capture({ ...event, dedupeKey: `event:${index}` }).accepted).toBe(true);
    }
    nowMs += 61_000;
    expect(second.service.capture({ ...event, dedupeKey: "over-budget" })).toEqual({
      accepted: false,
      reason: "daily_budget",
    });
    expect(first.messages).toHaveLength(25);
    expect(fs.readFileSync(path.join(first.root, "analytics.json"), "utf8")).not.toContain("shared-secret-key");
    fs.rmSync(first.root, { recursive: true, force: true });
  });

  it("deduplicates noisy UI events and enforces a hard daily ceiling", () => {
    let nowMs = Date.parse("2026-07-13T12:00:00.000Z");
    const harness = makeHarness({ dailyBudget: 25, now: () => nowMs });
    const input = {
      event: "ade_screen_viewed" as const,
      surface: "tui" as const,
      dedupeKey: "tui:details_help",
      minimumIntervalMs: 60_000,
      properties: { screen: "details_help" },
    };

    expect(harness.service.capture(input).accepted).toBe(true);
    expect(harness.service.capture(input)).toEqual({ accepted: false, reason: "duplicate" });
    nowMs += 61_000;
    expect(harness.service.capture(input).accepted).toBe(true);

    for (let index = 0; index < 23; index += 1) {
      nowMs += 61_000;
      expect(harness.service.capture({ ...input, dedupeKey: `screen:${index}` }).accepted).toBe(true);
    }
    nowMs += 61_000;
    expect(harness.service.capture({ ...input, dedupeKey: "over-budget" })).toEqual({
      accepted: false,
      reason: "daily_budget",
    });
    expect(harness.messages).toHaveLength(25);
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it("is inert without configuration and honors the persisted opt-out", () => {
    const unconfigured = makeHarness({ token: "" });
    expect(unconfigured.service.capture({ event: "ade_app_opened", surface: "desktop" })).toEqual({
      accepted: false,
      reason: "not_configured",
    });
    expect(unconfigured.messages).toHaveLength(0);
    expect(fs.existsSync(path.join(unconfigured.root, "analytics.json"))).toBe(false);

    const configured = makeHarness();
    expect(configured.service.setEnabled(false).effective).toBe(false);
    expect(configured.service.capture({ event: "ade_app_opened", surface: "desktop" })).toEqual({
      accepted: false,
      reason: "disabled",
    });
    expect(configured.messages).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(path.join(configured.root, "analytics.json"), "utf8"))).toMatchObject({
      version: 1,
      enabled: false,
    });
    const unconfiguredRestart = makeHarness({ root: configured.root, token: "" });
    expect(unconfiguredRestart.service.getStatus()).toMatchObject({
      configured: false,
      enabled: false,
      effective: false,
    });
    fs.rmSync(unconfigured.root, { recursive: true, force: true });
    fs.rmSync(configured.root, { recursive: true, force: true });
  });

  it("drops queued transport work immediately when the user opts out", () => {
    const harness = makeHarness();
    expect(harness.service.capture({ event: "ade_app_opened", surface: "desktop" }).accepted).toBe(true);

    expect(harness.service.setEnabled(false).effective).toBe(false);
    expect(harness.shutdownArgs).toEqual([[1_500, { flush: false }]]);
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it("keeps withdrawal immediate and restart-safe while the state lock is contended", () => {
    let nowMs = Date.parse("2026-07-13T12:00:00.000Z");
    const harness = makeHarness({ now: () => nowMs });
    expect(harness.service.capture({ event: "ade_app_opened", surface: "desktop" }).accepted).toBe(true);
    const preWithdrawalOccurredAt = new Date(nowMs).toISOString();
    const lockPath = path.join(harness.root, "analytics.json.lock");
    fs.mkdirSync(lockPath);

    nowMs += 60_000;
    expect(harness.service.setEnabled(false)).toMatchObject({
      enabled: false,
      effective: false,
    });
    expect(harness.shutdownArgs).toEqual([[1_500, { flush: false }]]);
    expect(fs.existsSync(path.join(harness.root, "analytics.json.disabled"))).toBe(true);
    fs.rmdirSync(lockPath);

    expect(harness.service.getStatus()).toMatchObject({ enabled: false, effective: false });
    expect(harness.service.capture({ event: "ade_app_opened", surface: "desktop" })).toEqual({
      accepted: false,
      reason: "disabled",
    });

    const restarted = makeHarness({ root: harness.root, now: () => nowMs });
    expect(restarted.service.getStatus()).toMatchObject({ enabled: false, effective: false });
    nowMs += 60_000;
    expect(restarted.service.setEnabled(true)).toMatchObject({ enabled: true, effective: true });
    const consentSince = restarted.service.getExportConsentSince();
    expect(consentSince).toBe(new Date(nowMs).toISOString());
    expect(Date.parse(preWithdrawalOccurredAt)).toBeLessThan(Date.parse(consentSince!));
    expect(fs.existsSync(path.join(harness.root, "analytics.json.disabled"))).toBe(false);
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it("cancels another process's queued client when the shared opt-out marker appears", async () => {
    const first = makeHarness();
    expect(first.service.capture({ event: "ade_app_opened", surface: "desktop" }).accepted).toBe(true);

    const second = makeHarness({ root: first.root });
    expect(second.service.setEnabled(false)).toMatchObject({ enabled: false, effective: false });
    await vi.waitFor(() => {
      expect(first.shutdownArgs).toEqual([[1_500, { flush: false }]]);
    }, { timeout: 1_000, interval: 20 });
    await expect(first.service.flush()).resolves.toBe(true);

    await first.service.shutdown();
    await second.service.shutdown();
    fs.rmSync(first.root, { recursive: true, force: true });
  });

  it("honors another process's explicit opt-in after a shared opt-out", async () => {
    const first = makeHarness();
    expect(first.service.capture({ event: "ade_app_opened", surface: "desktop" }).accepted).toBe(true);

    const second = makeHarness({ root: first.root });
    expect(second.service.setEnabled(false)).toMatchObject({ enabled: false, effective: false });
    await vi.waitFor(() => {
      expect(first.shutdownArgs).toEqual([[1_500, { flush: false }]]);
    }, { timeout: 1_000, interval: 20 });

    expect(second.service.setEnabled(true)).toMatchObject({ enabled: true, effective: true });
    await vi.waitFor(() => {
      expect(first.service.getStatus()).toMatchObject({ enabled: true, effective: true });
    }, { timeout: 1_000, interval: 20 });
    expect(first.service.capture({ event: "ade_screen_viewed", surface: "desktop" })).toEqual({
      accepted: true,
      reason: "accepted",
    });

    await first.service.shutdown();
    await second.service.shutdown();
    fs.rmSync(first.root, { recursive: true, force: true });
  });

  it("fails closed when an existing consent/quota state file is malformed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-product-analytics-invalid-state-"));
    const stateFile = path.join(root, "analytics.json");
    fs.writeFileSync(stateFile, "{truncated", { mode: 0o600 });
    const harness = makeHarness({ root });

    expect(harness.service.getStatus()).toMatchObject({ enabled: false, effective: false });
    expect(harness.service.capture({ event: "ade_app_opened", surface: "desktop" })).toEqual({
      accepted: false,
      reason: "disabled",
    });
    expect(fs.readFileSync(stateFile, "utf8")).toBe("{truncated");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reserves aggregate and lifecycle events for trusted internal producers", () => {
    const harness = makeHarness();
    const input = {
      event: "ade_daily_usage_summary" as const,
      surface: "api" as const,
      properties: { summary_kind: "overall", interaction_count: 9 },
    };

    expect(harness.service.capture(input)).toEqual({ accepted: false, reason: "invalid_event" });
    expect(harness.service.captureInternal(input)).toEqual({ accepted: true, reason: "accepted" });
    expect(harness.messages).toHaveLength(1);
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it("rejects personal keys and invalid explicit ingestion hosts", () => {
    const personalKey = makeHarness({ token: "phx_personal_admin_key" });
    expect(personalKey.service.capture({ event: "ade_app_opened", surface: "desktop" })).toEqual({
      accepted: false,
      reason: "not_configured",
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-product-analytics-host-"));
    const service = createProductAnalyticsService({
      stateFilePath: path.join(root, "analytics.json"),
      logger: { debug: vi.fn(), warn: vi.fn() } as never,
      runtimeMode: "test_harness",
      projectToken: "phc_test_project_token",
      host: "http://not-local.example.com",
    });
    expect(service.capture({ event: "ade_app_opened", surface: "desktop" })).toEqual({
      accepted: false,
      reason: "not_configured",
    });
    fs.rmSync(personalKey.root, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports the prior day's budget within the next day's hard cap", async () => {
    let nowMs = Date.parse("2026-07-13T12:00:00.000Z");
    const harness = makeHarness({ now: () => nowMs });
    harness.service.capture({ event: "ade_app_opened", surface: "desktop" });
    await harness.service.shutdown();

    expect(harness.shutdowns).toBe(1);
    expect(harness.messages).toHaveLength(1);
    nowMs += 24 * 60 * 60 * 1_000;
    expect(harness.service.capture({ event: "ade_feature_used", surface: "desktop" }).accepted).toBe(true);
    expect(harness.messages[1]).toMatchObject({
      event: "ade_analytics_budget",
      properties: {
        sent_count: 1,
        dropped_count: 0,
        $process_person_profile: false,
      },
    });
    expect(harness.service.getStatus().acceptedToday).toBe(2);
    fs.rmSync(harness.root, { recursive: true, force: true });
  });
});

function analyticsLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function settledAnalytics(captures: ProductAnalyticsCapture[]) {
  return {
    captureInternal(input: ProductAnalyticsCapture) {
      captures.push(input);
      return { accepted: true, reason: "accepted" as const };
    },
  } satisfies Pick<ProductAnalyticsService, "captureInternal">;
}

function settledEvent(overrides: Partial<AgentChatTurnSettledEvent> = {}): AgentChatTurnSettledEvent {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    status: "completed",
    provider: "codex",
    sessionSurface: "work",
    ...overrides,
  };
}

describe("product analytics producers", () => {
  it("maps automation completion and failed chat turns into canonical bounded outcomes", () => {
    const captures: ProductAnalyticsCapture[] = [];
    const analytics = settledAnalytics(captures);

    captureAgentTurnSettledAnalytics({
      analytics,
      projectId: "project-1",
      event: settledEvent({ sessionSurface: "automation" }),
    });
    captureAgentTurnSettledAnalytics({
      analytics,
      projectId: "project-1",
      event: settledEvent({ status: "failed", sessionId: "session-2" }),
    });

    expect(captures).toHaveLength(3);
    expect(captures[0]).toEqual({
      event: "ade_work_session_completed",
      surface: "api",
      projectId: "project-1",
      sessionId: "session-1",
      dedupeKey: "session-first-turn-settled:session-1",
      minimumIntervalMs: 31 * 24 * 60 * 60_000,
      properties: {
        feature: "automations",
        outcome: "completed",
        provider: "codex",
        source: "runtime",
      },
    });
    expect(captures[1]).toMatchObject({
      event: "ade_work_session_completed",
      properties: { feature: "chat", outcome: "failure" },
    });
    expect(captures[2]).toMatchObject({
      event: "ade_error",
      sessionId: "session-2",
      properties: { feature: "chat", error_kind: "other", recoverable: true },
    });
  });

  it("emits bounded daily aggregates without operational identifiers", () => {
    const captured: Array<Parameters<ProductAnalyticsService["captureInternal"]>[0]> = [];
    const captureInternal = vi.fn((input: Parameters<ProductAnalyticsService["captureInternal"]>[0]) => {
      captured.push(input);
      return { accepted: true, reason: "accepted" as const };
    });
    const analytics = { captureInternal } as unknown as ProductAnalyticsService;
    const stats = {
      generatedAt: "2026-07-13T12:00:00.000Z",
      summary: {
        totalInteractions: 12,
        chatSessions: 3,
        terminalSessions: 2,
        activeLanes: 4,
        commitsCreated: 5,
        pushOperations: 2,
        prLandings: 1,
        filesChanged: 18,
        trackedAdeTokens: 42_000,
        trackedAdeCalls: 8,
        trackedAdeDurationMs: 60_000,
      },
      clients: [{ client: "desktop", interactions: 9, sessions: 3, activeDays: 1 }],
      providers: [{ provider: "OpenAI", totalTokens: 42_000, inputTokens: 30_000, outputTokens: 12_000 }],
      models: [{
        provider: "OpenAI",
        model: "GPT 5",
        totalTokens: 42_000,
        inputTokens: 30_000,
        outputTokens: 12_000,
        calls: 8,
      }],
    } as unknown as AdeUsageStats;

    expect(captureDailyUsageAnalytics({
      analytics,
      stats,
      projectId: "/private/project/path",
    })).toBe(3);
    expect(captureInternal).toHaveBeenCalledTimes(3);
    expect(captureInternal).toHaveBeenCalledWith(expect.objectContaining({
      event: "ade_daily_usage_summary",
      surface: "api",
      properties: expect.objectContaining({ summary_kind: "provider", provider: "openai" }),
    }));
    expect(captureInternal).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({ summary_kind: "model", model_family: "gpt_5" }),
    }));
    expect(JSON.stringify(captured.map((input) => input.properties))).not.toContain("/private/project/path");
  });

  it("attributes only a completed non-empty local day", () => {
    const now = new Date(2026, 2, 9, 8, 30, 0, 0);
    const target = completedDailyUsageAnalyticsTarget(now);
    const completedDayStart = localDayOffset(now, -1);
    expect(target?.day).toBe(localDayKey(completedDayStart!));
    expect(localDayKey(target!.occurredAt)).toBe(target?.day);

    const captureInternal = vi.fn(() => ({ accepted: true, reason: "accepted" as const }));
    const analytics = { captureInternal } as unknown as ProductAnalyticsService;
    const nonEmpty = {
      generatedAt: now.toISOString(),
      summary: { totalInteractions: 7 },
      providers: [{ provider: "Claude", totalTokens: 9_000, inputTokens: 6_000, outputTokens: 3_000 }],
      models: [{
        provider: "Claude",
        model: "Claude Sonnet",
        totalTokens: 9_000,
        inputTokens: 6_000,
        outputTokens: 3_000,
        calls: 2,
      }],
    } as unknown as AdeUsageStats;

    expect(captureDailyUsageAnalytics({
      analytics,
      stats: nonEmpty,
      projectId: "project-1",
      reportDay: target!.day,
      occurredAt: target!.occurredAt,
    })).toBe(3);
    expect(captureInternal).toHaveBeenCalledWith(expect.objectContaining({
      occurredAt: target!.occurredAt,
      dedupeKey: `daily-usage:project-1:${target!.day}:provider:claude`,
    }));

    captureInternal.mockClear();
    expect(captureDailyUsageAnalytics({
      analytics,
      stats: {
        generatedAt: now.toISOString(),
        summary: { totalInteractions: 0, activeLanes: 4 },
        providers: [],
        models: [],
      } as unknown as AdeUsageStats,
      projectId: "project-1",
      reportDay: target!.day,
      occurredAt: target!.occurredAt,
    })).toBe(0);
    expect(captureInternal).not.toHaveBeenCalled();
  });
});

describe("usage product analytics exporter", () => {
  async function withUsageDb(
    name: string,
    run: (db: Awaited<ReturnType<typeof openKvDb>>) => Promise<void>,
  ): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
    const db = await openKvDb(path.join(root, "ade.db"), analyticsLogger() as never);
    try {
      await run(db);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it("exports persisted actions once and derives a bounded work-session start", async () => {
    await withUsageDb("ade-analytics-export-", async (db) => {
      recordUsageInteraction(db, {
        projectId: "project-private",
        client: "desktop",
        action: "chat.send",
        sessionId: "session-private",
        occurredAt: "2026-07-13T12:00:00.000Z",
      });
      recordUsageInteraction(db, {
        projectId: "project-private",
        client: "tui",
        action: "work.startCliSession",
        sessionId: "session-cli",
        occurredAt: "2026-07-13T12:01:00.000Z",
      });
      const captures: Array<Record<string, unknown>> = [];
      const analytics = {
        getExportConsentSince: () => "2026-07-13T00:00:00.000Z",
        capture: (event: Record<string, unknown>) => {
          captures.push(event);
          return event.event === "ade_feature_used" && event.sessionId === "session-cli"
            ? { accepted: false, reason: "daily_budget" }
            : { accepted: true, reason: "accepted" };
        },
        captureInternal: (event: Record<string, unknown>) => {
          captures.push(event);
          return { accepted: true, reason: "accepted" };
        },
        flush: vi.fn(async () => true),
      } as unknown as ProductAnalyticsService;
      const exporter = createUsageProductAnalyticsExporter({
        db,
        analytics,
        logger: analyticsLogger() as never,
        now: () => Date.parse("2026-07-13T12:02:00.000Z"),
      });

      await expect(exporter.runOnce()).resolves.toBe(2);
      expect(captures).toHaveLength(3);
      expect(captures[0]).toMatchObject({
        event: "ade_feature_used",
        surface: "desktop",
        projectId: "project-private",
        properties: { feature: "chat", action: "chat.send", outcome: "success", source: "mutation" },
      });
      expect(captures[2]).toMatchObject({
        event: "ade_work_session_started",
        surface: "tui",
        properties: { feature: "cli", outcome: "started" },
      });
      expect(analytics.flush).toHaveBeenCalledTimes(1);
      expect(db.get<{ count: number }>(
        "select count(*) as count from usage_events where analytics_exported_at is not null",
      )?.count).toBe(2);
    });
  });

  it("does not re-spend quota after a transport flush failure", async () => {
    await withUsageDb("ade-analytics-retry-", async (db) => {
      recordUsageInteraction(db, {
        projectId: "project",
        client: "tui",
        action: "git.commit",
        occurredAt: "2026-07-13T12:00:00.000Z",
      });
      const capture = vi.fn(() => ({ accepted: true, reason: "accepted" }));
      const analytics = {
        getExportConsentSince: () => "2026-07-13T00:00:00.000Z",
        capture,
        flush: vi.fn().mockRejectedValueOnce(new Error("network unavailable")),
      } as unknown as ProductAnalyticsService;
      const exporter = createUsageProductAnalyticsExporter({
        db,
        analytics,
        logger: analyticsLogger() as never,
        now: () => Date.parse("2026-07-13T12:02:00.000Z"),
      });

      await expect(exporter.runOnce()).resolves.toBe(0);
      await expect(exporter.runOnce()).resolves.toBe(0);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(db.get<{ count: number }>(
        "select count(*) as count from usage_events where analytics_exported_at is null",
      )?.count).toBe(0);
    });
  });

  it("does not derive successful session completion from cleanup actions", async () => {
    await withUsageDb("ade-analytics-cleanup-", async (db) => {
      for (const [index, action] of ["chat.archive", "chat.delete", "work.stopRuntime"].entries()) {
        recordUsageInteraction(db, {
          projectId: "project",
          client: "desktop",
          action,
          sessionId: `session-${index}`,
          occurredAt: `2026-07-13T12:0${index}:00.000Z`,
        });
      }
      const captures: Array<Record<string, unknown>> = [];
      const analytics = {
        getExportConsentSince: () => "2026-07-13T00:00:00.000Z",
        capture: (event: Record<string, unknown>) => {
          captures.push(event);
          return { accepted: true, reason: "accepted" };
        },
        flush: vi.fn(async () => undefined),
      } as unknown as ProductAnalyticsService;
      const exporter = createUsageProductAnalyticsExporter({
        db,
        analytics,
        logger: analyticsLogger() as never,
        now: () => Date.parse("2026-07-13T12:05:00.000Z"),
      });

      await expect(exporter.runOnce()).resolves.toBe(3);
      expect(captures).toHaveLength(3);
      expect(captures.every((event) => event.event === "ade_feature_used")).toBe(true);
    });
  });

  it("finalizes rows suppressed by consent or the hard budget", async () => {
    await withUsageDb("ade-analytics-suppressed-", async (db) => {
      recordUsageInteraction(db, {
        projectId: "project",
        client: "desktop",
        action: "chat.send",
        occurredAt: "2026-07-13T10:00:00.000Z",
      });
      recordUsageInteraction(db, {
        projectId: "project",
        client: "desktop",
        action: "lanes.create",
        occurredAt: "2026-07-13T12:01:00.000Z",
      });
      const capture = vi.fn(() => ({ accepted: false, reason: "daily_budget" }));
      const analytics = {
        getExportConsentSince: () => "2026-07-13T12:00:00.000Z",
        capture,
        flush: vi.fn(async () => true),
      } as unknown as ProductAnalyticsService;
      const exporter = createUsageProductAnalyticsExporter({
        db,
        analytics,
        logger: analyticsLogger() as never,
        now: () => Date.parse("2026-07-13T12:05:00.000Z"),
      });

      await expect(exporter.runOnce()).resolves.toBe(0);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(analytics.flush).not.toHaveBeenCalled();
      expect(db.all<{ value: string }>(
        "select analytics_exported_at as value from usage_events order by occurred_at",
      ).map((row) => row.value)).toEqual(["suppressed:opt_out", "suppressed:daily_budget"]);
    });
  });
});
