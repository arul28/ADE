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
  runtimeMode?: string;
  captureClientMessage?: ProductAnalyticsClient["capture"];
} = {}) {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "ade-product-analytics-"));
  const messages = options.messages ?? [];
  let flushes = 0;
  let shutdowns = 0;
  const shutdownArgs: Array<[number | undefined, { flush?: boolean } | undefined]> = [];
  const client: ProductAnalyticsClient = {
    capture: options.captureClientMessage ?? ((message) => messages.push(message)),
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
    runtimeMode: options.runtimeMode ?? "test_harness",
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
    vi.stubEnv("ADE_ENABLE_PRODUCT_ANALYTICS_IN_DEVELOPMENT", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enforces privacy boundaries for properties, identifiers, actions, and insert ids", () => {
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
        action: "work.startCliSession",
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
      action: "work.startCliSession",
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

    expect(harness.service.capture({
      event: "ade_feature_used",
      surface: "api",
      clientEventId: "11111111-2222-1333-8444-555555555555",
      properties: { feature: "chat", action: "chat.send", outcome: "success" },
    })).toEqual({ accepted: true, reason: "accepted" });
    const regenerated = harness.messages[1] as { uuid: string };
    expect(regenerated.uuid).not.toBe("11111111-2222-1333-8444-555555555555");
    expect(regenerated.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(harness.service.capture({
      event: "ade_feature_used",
      surface: "desktop",
      properties: {
        feature: "attention",
        action: "header_opened",
        outcome: "opened",
        source: "renderer_route",
        machine_name: "Private MacBook",
      },
    })).toEqual({ accepted: true, reason: "accepted" });
    expect(harness.messages[2]?.properties).toMatchObject({
      feature: "attention",
      action: "header_opened",
      outcome: "opened",
      source: "renderer_route",
    });
    expect(harness.messages[2]?.properties).not.toHaveProperty("machine_name");
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it("accepts only coarse transactional update telemetry properties", () => {
    const harness = makeHarness();

    expect(harness.service.captureInternal({
      event: "ade_update_install_aborted",
      surface: "desktop",
      properties: { reason: "prepare_failed", error: "private runtime message" },
    })).toEqual({ accepted: true, reason: "accepted" });
    expect(harness.service.captureInternal({
      event: "ade_update_quit_escalated",
      surface: "desktop",
      properties: { blocked_ms: 10_000, blocked_phase: "private phase detail" },
    })).toEqual({ accepted: true, reason: "accepted" });
    expect(harness.service.captureInternal({
      event: "ade_update_auto_applied",
      surface: "desktop",
    })).toEqual({ accepted: true, reason: "accepted" });
    expect(harness.service.captureInternal({
      event: "ade_update_auto_apply_cancelled",
      surface: "desktop",
    })).toEqual({ accepted: true, reason: "accepted" });
    expect(harness.service.captureInternal({
      event: "ade_feature_used",
      surface: "desktop",
      properties: {
        feature: "updates",
        action: "preferences_changed",
        mode: "automatic",
        outcome: "idle_only",
        preference_payload: "private detail",
      },
    })).toEqual({ accepted: true, reason: "accepted" });

    expect(harness.messages.map((message) => message.event)).toEqual([
      "ade_update_install_aborted",
      "ade_update_quit_escalated",
      "ade_update_auto_applied",
      "ade_update_auto_apply_cancelled",
      "ade_feature_used",
    ]);
    expect(harness.messages[0]?.properties).toMatchObject({ reason: "prepare_failed" });
    expect(harness.messages[1]?.properties).toMatchObject({ blocked_ms: 10_000 });
    expect(harness.messages[4]?.properties).toMatchObject({
      feature: "updates",
      action: "preferences_changed",
      mode: "automatic",
      outcome: "idle_only",
    });
    expect(JSON.stringify(harness.messages)).not.toContain("private");
  });

  it("accepts the storage-doctor maintenance event with numeric aggregates and coarse outcome", () => {
    const harness = makeHarness();
    const result = harness.service.capture({
      event: "ade_feature_used",
      surface: "desktop",
      properties: {
        feature: "storage_doctor",
        action: "maintenance_run",
        outcome: "partial",
        bytes_freed: 481_000_000,
        files_compressed: 62,
        secret_path: "/Users/alice/secret-project/.ade",
      },
    });

    expect(result).toEqual({ accepted: true, reason: "accepted" });
    const message = harness.messages[0] as { properties: Record<string, unknown> };
    expect(message.properties).toMatchObject({
      feature: "storage_doctor",
      action: "maintenance_run",
      outcome: "partial",
      bytes_freed: 481_000_000,
      files_compressed: 62,
    });
    // Non-allowlisted keys never cross the sanitizer.
    expect(message.properties).not.toHaveProperty("secret_path");
    expect(JSON.stringify(message)).not.toContain("secret-project");
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it("accepts only coarse reliability telemetry properties", () => {
    const harness = makeHarness();

    expect(harness.service.captureInternal({
      event: "ade_brain_recovered",
      surface: "api",
      properties: {
        blocked_ms: 125_000,
        last_command: "sync.refresh",
        payload: "/Users/alice/private-project",
      },
    })).toEqual({ accepted: true, reason: "accepted" });
    expect(harness.service.captureInternal({
      event: "ade_publish_failing",
      surface: "api",
      properties: {
        failing_minutes: 3,
        leg: "token",
        code: "token_timeout",
        endpoint: "https://private.example.test",
      },
    })).toEqual({ accepted: true, reason: "accepted" });

    expect(harness.messages).toHaveLength(2);
    expect(harness.messages[0]?.properties).toMatchObject({
      blocked_ms: 125_000,
      last_command: "sync.refresh",
    });
    expect(harness.messages[1]?.properties).toMatchObject({
      failing_minutes: 3,
      leg: "token",
      code: "token_timeout",
    });
    expect(JSON.stringify(harness.messages)).not.toContain("private");
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

  it("rolls back quota, minute, and dedupe reservations after a synchronous transport failure", () => {
    const harness = makeHarness({
      captureClientMessage: () => {
        throw new Error("PostHog analytics queue is full");
      },
    });
    expect(harness.service.capture({
      event: "ade_feature_used",
      surface: "api",
      dedupeKey: "retry-after-transport-failure",
      properties: { feature: "work", action: "work.startCliSession", outcome: "started" },
    })).toEqual({ accepted: false, reason: "transport_error" });

    expect(harness.service.getStatus()).toMatchObject({ acceptedToday: 0, droppedToday: 1 });
    const state = JSON.parse(fs.readFileSync(path.join(harness.root, "analytics.json"), "utf8")) as {
      quota: {
        acceptedByEvent: Record<string, number>;
        minuteWindows: Record<string, number[]>;
        dedupe: Record<string, number>;
      };
    };
    expect(state.quota.acceptedByEvent).not.toHaveProperty("ade_feature_used");
    expect(state.quota.minuteWindows).not.toHaveProperty("ade_feature_used");
    expect(state.quota.dedupe).toEqual({});
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
      version: 2,
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

  it("is inert in development unless analytics is explicitly enabled", () => {
    vi.stubEnv("ADE_ENABLE_PRODUCT_ANALYTICS_IN_DEVELOPMENT", "0");
    const harness = makeHarness();
    expect(harness.service.captureInternal({
      event: "ade_app_installed",
      surface: "desktop",
      properties: { install_source: "development" },
    })).toEqual({ accepted: false, reason: "disabled" });
    expect(harness.messages).toHaveLength(0);
    expect(fs.existsSync(path.join(harness.root, "analytics.json"))).toBe(false);
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it("recognizes the unpackaged desktop runtime as development when NODE_ENV is unset", () => {
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("ADE_ENABLE_PRODUCT_ANALYTICS_IN_DEVELOPMENT", "0");
    const harness = makeHarness({ runtimeMode: "desktop_development" });

    expect(harness.service.capture({ event: "ade_app_opened", surface: "desktop" })).toEqual({
      accepted: false,
      reason: "disabled",
    });
    expect(harness.messages).toHaveLength(0);
    expect(fs.existsSync(path.join(harness.root, "analytics.json"))).toBe(false);
    fs.rmSync(harness.root, { recursive: true, force: true });
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

  it("captures install and activation milestones only once across restarts", () => {
    let nowMs = Date.parse("2026-07-13T12:00:00.000Z");
    const first = makeHarness({ now: () => nowMs });

    expect(first.service.captureInternal({
      event: "ade_app_installed",
      surface: "desktop",
      properties: { install_source: "direct_download" },
    })).toEqual({ accepted: true, reason: "accepted" });
    nowMs += 91_000;
    expect(first.service.captureInternal({
      event: "ade_activated",
      surface: "api",
      properties: { trigger: "work_session_completed", time_since_install_seconds: 999_999 },
    })).toEqual({ accepted: true, reason: "accepted" });

    const activation = first.messages[1] as { properties: Record<string, unknown> };
    expect(activation.properties.time_since_install_seconds).toBe(91);

    const restarted = makeHarness({ root: first.root, messages: first.messages, now: () => nowMs });
    expect(restarted.service.captureInternal({
      event: "ade_app_installed",
      surface: "desktop",
      properties: { install_source: "homebrew" },
    })).toEqual({ accepted: false, reason: "duplicate" });
    expect(restarted.service.captureInternal({
      event: "ade_activated",
      surface: "api",
      properties: { trigger: "work_session_completed" },
    })).toEqual({ accepted: false, reason: "duplicate" });
    expect(first.messages).toHaveLength(2);
    expect(restarted.service.getStatus().droppedToday).toBe(0);
    fs.rmSync(first.root, { recursive: true, force: true });
  });

  it("migrates legacy analytics state without backfilling false install or activation events", () => {
    const first = makeHarness();
    first.service.capture({ event: "ade_app_opened", surface: "desktop" });
    const statePath = path.join(first.root, "analytics.json");
    const legacy = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    legacy.version = 1;
    delete legacy.anonymousId;
    delete legacy.identifiedUserHash;
    delete legacy.installedAtMs;
    delete legacy.installCapturedAtMs;
    delete legacy.activatedAtMs;
    fs.writeFileSync(statePath, `${JSON.stringify(legacy)}\n`);

    const restarted = makeHarness({ root: first.root, messages: first.messages });
    expect(restarted.service.captureInternal({
      event: "ade_app_installed",
      surface: "desktop",
      properties: { install_source: "direct_download" },
    })).toEqual({ accepted: false, reason: "duplicate" });
    expect(restarted.service.captureInternal({
      event: "ade_activated",
      surface: "api",
      properties: { trigger: "work_session_completed" },
    })).toEqual({ accepted: false, reason: "duplicate" });
    fs.rmSync(first.root, { recursive: true, force: true });
  });

  it("identifies a known account pseudonymously and rotates identity on sign-out", () => {
    const harness = makeHarness();
    harness.service.capture({ event: "ade_app_opened", surface: "desktop" });
    const anonymousId = harness.messages[0]?.distinctId;

    expect(harness.service.identifyAccount("clerk_user_private_123")).toEqual({
      accepted: true,
      reason: "accepted",
    });
    const identify = harness.messages[1] as {
      distinctId: string;
      event: string;
      properties: Record<string, unknown>;
    };
    expect(identify.event).toBe("$identify");
    expect(identify.distinctId).toMatch(/^ade_user_[0-9a-f]{32}$/);
    expect(identify.properties).toMatchObject({
      $anon_distinct_id: anonymousId,
      $set: { plan: "free", platform: process.platform, app_version: "1.2.3" },
      $geoip_disable: true,
    });
    expect(JSON.stringify(identify)).not.toContain("clerk_user_private_123");
    expect(harness.service.identifyAccount("clerk_user_private_123")).toEqual({
      accepted: false,
      reason: "duplicate",
    });

    harness.service.capture({ event: "ade_screen_viewed", surface: "desktop" });
    expect(harness.messages[2]?.distinctId).toBe(identify.distinctId);
    expect(harness.service.resetAccountIdentity()).toBe(true);
    harness.service.capture({ event: "ade_project_opened", surface: "desktop" });
    expect(harness.messages[3]?.distinctId).toMatch(/^ade_[0-9a-f]{32}$/);
    expect(harness.messages[3]?.distinctId).not.toBe(anonymousId);
    expect(harness.messages[3]?.distinctId).not.toBe(identify.distinctId);
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it.each([
    { quota: "daily", expectedReason: "daily_budget" },
    { quota: "minute", expectedReason: "rate_limited" },
  ] as const)("clears the prior account when a switched identify hits the $quota quota", ({
    quota,
    expectedReason,
  }) => {
    const nowMs = Date.parse("2026-07-13T12:00:00.000Z");
    const first = makeHarness({ now: () => nowMs });
    expect(first.service.identifyAccount("account_one").accepted).toBe(true);
    const priorIdentity = first.messages[0]?.distinctId;
    const statePath = path.join(first.root, "analytics.json");
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      identifiedUserHash: string | null;
      quota: {
        identifyAccepted: number;
        identifyMinuteWindow: number[];
      };
    };
    if (quota === "daily") {
      persisted.quota.identifyAccepted = 3;
      persisted.quota.identifyMinuteWindow = [];
    } else {
      persisted.quota.identifyAccepted = 1;
      persisted.quota.identifyMinuteWindow = [nowMs - 1_000, nowMs];
    }
    fs.writeFileSync(statePath, `${JSON.stringify(persisted)}\n`);

    const restarted = makeHarness({
      root: first.root,
      messages: first.messages,
      now: () => nowMs,
    });
    expect(restarted.service.identifyAccount("account_two")).toEqual({
      accepted: false,
      reason: expectedReason,
    });
    expect(restarted.service.identifiedUserHashForTesting()).toBeNull();
    expect(restarted.service.capture({
      event: "ade_screen_viewed",
      surface: "desktop",
      properties: { screen: "work" },
    }).accepted).toBe(true);
    expect(first.messages.at(-1)?.distinctId).toMatch(/^ade_[0-9a-f]{32}$/);
    expect(first.messages.at(-1)?.distinctId).not.toBe(priorIdentity);
    fs.rmSync(first.root, { recursive: true, force: true });
  });

  it("attributes a rolled quota summary to the prior account before switching identities", () => {
    let nowMs = Date.parse("2026-07-13T23:59:00.000Z");
    const first = makeHarness({ now: () => nowMs });
    expect(first.service.identifyAccount("account_one").accepted).toBe(true);
    const priorIdentity = first.messages[0]?.distinctId;
    const statePath = path.join(first.root, "analytics.json");
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      quota: { accepted: number; dropped: number };
    };
    persisted.quota.accepted = 5;
    persisted.quota.dropped = 2;
    fs.writeFileSync(statePath, `${JSON.stringify(persisted)}\n`);

    nowMs = Date.parse("2026-07-14T00:01:00.000Z");
    const restarted = makeHarness({
      root: first.root,
      messages: first.messages,
      now: () => nowMs,
    });
    expect(restarted.service.identifyAccount("account_two")).toEqual({
      accepted: true,
      reason: "accepted",
    });

    expect(first.messages[1]).toMatchObject({
      event: "ade_analytics_budget",
      distinctId: priorIdentity,
      properties: {
        sent_count: 5,
        dropped_count: 2,
      },
    });
    expect(first.messages[2]).toMatchObject({
      event: "$identify",
    });
    expect(first.messages[2]?.distinctId).not.toBe(priorIdentity);
    fs.rmSync(first.root, { recursive: true, force: true });
  });

  it("normalizes persisted identify quotas and rejects timestamps outside the active minute", () => {
    const nowMs = Date.parse("2026-07-13T12:00:00.000Z");
    const first = makeHarness({ now: () => nowMs });
    first.service.capture({ event: "ade_app_opened", surface: "desktop" });
    const statePath = path.join(first.root, "analytics.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      quota: {
        identifyAccepted: number;
        identifyMinuteWindow: number[];
      };
    };
    state.quota.identifyAccepted = 1;
    state.quota.identifyMinuteWindow = [
      nowMs - 60_001,
      nowMs - 30_000,
      nowMs,
      nowMs + 60_001,
      Number.POSITIVE_INFINITY,
    ];
    fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);

    const minuteLimited = makeHarness({ root: first.root, now: () => nowMs });
    expect(minuteLimited.service.identifyAccount("user_minute_limited")).toEqual({
      accepted: false,
      reason: "rate_limited",
    });
    const minuteState = JSON.parse(fs.readFileSync(statePath, "utf8")) as typeof state;
    expect(minuteState.quota.identifyMinuteWindow).toEqual([nowMs - 30_000, nowMs]);

    minuteState.quota.identifyAccepted = 999;
    minuteState.quota.identifyMinuteWindow = [];
    fs.writeFileSync(statePath, `${JSON.stringify(minuteState)}\n`);
    const dailyLimited = makeHarness({ root: first.root, now: () => nowMs });
    expect(dailyLimited.service.identifyAccount("user_daily_limited")).toEqual({
      accepted: false,
      reason: "daily_budget",
    });
    const dailyState = JSON.parse(fs.readFileSync(statePath, "utf8")) as typeof state;
    expect(dailyState.quota.identifyAccepted).toBe(3);
    fs.rmSync(first.root, { recursive: true, force: true });
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

    expect(captures).toHaveLength(5);
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
    expect(captures[1]).toEqual({
      event: "ade_app_installed",
      surface: "api",
      properties: { install_source: "unknown" },
    });
    expect(captures[2]).toMatchObject({
      event: "ade_activated",
      properties: { trigger: "work_session_completed" },
    });
    expect(captures[3]).toMatchObject({
      event: "ade_work_session_completed",
      properties: { feature: "chat", outcome: "failure" },
    });
    expect(captures[4]).toMatchObject({
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
      adeProviders: [
        { provider: "OpenAI", totalTokens: 40_000, inputTokens: 29_000, outputTokens: 11_000 },
        { provider: "Claude", totalTokens: 2_000, inputTokens: 1_000, outputTokens: 1_000 },
      ],
      models: [{
        provider: "OpenAI",
        model: "GPT 5",
        totalTokens: 42_000,
        inputTokens: 30_000,
        outputTokens: 12_000,
        calls: 8,
      }],
      adeModels: [{
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
      properties: expect.objectContaining({ summary_kind: "overall", provider_count: 2, model_count: 1 }),
    }));
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
