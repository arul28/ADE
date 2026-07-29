import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ATTENTION_PREFERENCES } from "../../../../desktop/src/shared/types/attention";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import type {
  PushDeviceRegistration,
  PushQuietHours,
} from "../../../../desktop/src/shared/types/push";
import {
  createPushRegistrationStore,
  type PushRegistrationStore,
  type StoredAttentionAcknowledgment,
} from "./pushRegistrationStore";
import { createPushRelayClient } from "./pushRelayClient";
import {
  buildAgentRunsContentState,
  countAwaitingAttentionRuns,
  createPushPublisherService,
  isWithinQuietHours,
  parseHhMm,
  shouldDeliverAlertForPrefs,
  type AgentRunState,
  type PushPrNotification,
} from "./pushPublisherService";

function alertDedupeKey(dedupeKey: string, deviceId = "dev-1"): string {
  return `alert-device:${deviceId.length}:${deviceId}:${dedupeKey}`;
}

function run(overrides: Partial<AgentRunState>): AgentRunState {
  return {
    sessionId: "s",
    scopeKey: "scope",
    kind: "chat",
    title: "Run",
    lane: "lane",
    model: "gpt-5",
    agent: "Codex",
    phase: "running",
    detail: null,
    itemId: null,
    startedAt: 0,
    lastActiveAt: 0,
    metaResolved: true,
    ...overrides,
  };
}

describe("quiet hours", () => {
  it("parses HH:MM and rejects malformed input", () => {
    expect(parseHhMm("22:00")).toBe(22 * 60);
    expect(parseHhMm("7:05")).toBe(7 * 60 + 5);
    expect(parseHhMm("24:00")).toBeNull();
    expect(parseHhMm("22:60")).toBeNull();
    expect(parseHhMm("nope")).toBeNull();
  });

  it("evaluates a midnight-spanning window in its own timezone", () => {
    // 02:30 UTC = 22:30 America/New_York (EDT) = 11:30 Asia/Tokyo.
    const nowMs = Date.parse("2026-07-05T02:30:00.000Z");
    const spanning = { start: "22:00", end: "07:00", timezone: "America/New_York" };
    expect(isWithinQuietHours(spanning, nowMs)).toBe(true);
    // Same instant, UTC-evaluated (02:30 is inside 22:00→07:00).
    expect(isWithinQuietHours({ ...spanning, timezone: "UTC" }, nowMs)).toBe(true);
  });

  it("discriminates a non-spanning window by timezone", () => {
    const nowMs = Date.parse("2026-07-05T02:30:00.000Z");
    const window = { start: "22:00", end: "23:00" };
    // 22:30 in New York → inside.
    expect(isWithinQuietHours({ ...window, timezone: "America/New_York" }, nowMs)).toBe(true);
    // 11:30 in Tokyo → outside.
    expect(isWithinQuietHours({ ...window, timezone: "Asia/Tokyo" }, nowMs)).toBe(false);
  });

  it("does not suppress on an unknown timezone or zero-length window", () => {
    const nowMs = Date.parse("2026-07-05T02:30:00.000Z");
    expect(isWithinQuietHours({ start: "22:00", end: "07:00", timezone: "Not/AZone" }, nowMs)).toBe(false);
    expect(isWithinQuietHours({ start: "22:00", end: "22:00", timezone: "UTC" }, nowMs)).toBe(false);
    expect(isWithinQuietHours(null, nowMs)).toBe(false);
  });
});

describe("shouldDeliverAlertForPrefs", () => {
  const nowMs = Date.parse("2026-07-05T12:00:00.000Z");

  it("blocks when the master switch is off", () => {
    expect(shouldDeliverAlertForPrefs({ enabled: false }, "s-1", nowMs)).toBe(false);
  });

  it("blocks a muted session but allows others", () => {
    const prefs = { enabled: true, mutedSessionIds: ["s-1"] };
    expect(shouldDeliverAlertForPrefs(prefs, "s-1", nowMs)).toBe(false);
    expect(shouldDeliverAlertForPrefs(prefs, "s-2", nowMs)).toBe(true);
    expect(shouldDeliverAlertForPrefs(prefs, null, nowMs)).toBe(true);
  });

  it("blocks inside quiet hours", () => {
    const prefs = { enabled: true, quietHours: { start: "00:00", end: "23:59", timezone: "UTC" } };
    expect(shouldDeliverAlertForPrefs(prefs, "s-1", nowMs)).toBe(false);
  });
});

describe("buildAgentRunsContentState", () => {
  it("caps runs at 3, orders by recency, and counts active runs", () => {
    const runs = [
      run({ sessionId: "a", lastActiveAt: 10, phase: "running" }),
      run({ sessionId: "b", lastActiveAt: 40, phase: "waiting_for_approval" }),
      run({ sessionId: "c", lastActiveAt: 30, phase: "completed" }),
      run({ sessionId: "d", lastActiveAt: 20, phase: "running" }),
    ];
    const state = buildAgentRunsContentState(runs, 1_000);
    expect(state.updatedAt).toBe(1);
    // 3 active (a, b, d); c is terminal.
    expect(state.activeCount).toBe(3);
    expect(state.runs.map((r) => r.id)).toEqual(["b", "c", "d"]);
  });

  it("redacts failed detail and caps detail length", () => {
    const long = "x".repeat(300);
    const state = buildAgentRunsContentState(
      [
        run({ sessionId: "f", phase: "failed", detail: "stack trace with secrets", lastActiveAt: 2 }),
        run({ sessionId: "g", phase: "running", detail: long, lastActiveAt: 1 }),
      ],
      0,
    );
    const failed = state.runs.find((r) => r.id === "f");
    const running = state.runs.find((r) => r.id === "g");
    expect(failed?.detail).toBe("Run failed");
    expect(running?.detail).toHaveLength(160);
  });
});

describe("createPushPublisherService flush", () => {
  const device = {
    deviceId: "dev-1",
    apnsToken: "a".repeat(64),
    pushToStartToken: "b".repeat(64),
    bundleId: "com.ade.ios",
    apsEnvironment: "sandbox" as const,
    prefs: { enabled: true, liveActivitiesEnabled: true, mutedSessionIds: [] as string[], quietHours: null as PushQuietHours | null },
    updatedAt: "",
  };

  function makeHarness(
    deviceOverride: typeof device | Array<typeof device> = device,
    now?: () => number,
  ) {
    const publish = vi.fn().mockResolvedValue({ ok: true });
    const publishAttention = vi.fn().mockResolvedValue(null);
    const acknowledgeAttention = vi.fn().mockResolvedValue(null);
    let accountOwnerId: string | null = "owner-a";
    const devices = Array.isArray(deviceOverride) ? [...deviceOverride] : [deviceOverride];
    const attentionAcknowledgments = new Map<string, StoredAttentionAcknowledgment>();
    const attentionAcknowledgmentKey = (
      accountOwnerId: string | null,
      itemId: string,
    ) => `${accountOwnerId ?? ""}\u0000${itemId}`;
    const store = {
      hasRegisteredDevices: () => true,
      getOrCreateIdentity: () => ({ machineKey: "a".repeat(40), machineSecret: "secret" }),
      getStatusSnapshot: () => ({ enabled: true, claimed: true, registeredDeviceCount: devices.length, lastPublishAt: null, lastPublishError: null, lastRelayContactAt: null }),
      listDevices: () => devices,
      getDevice: (deviceId: string) => devices.find((entry) => entry.deviceId === deviceId) ?? null,
      upsertDevice: (registration: PushDeviceRegistration) => {
        const existingIndex = devices.findIndex((entry) => entry.deviceId === registration.deviceId);
        const existing = existingIndex >= 0 ? devices[existingIndex] : null;
        const updated = {
          ...device,
          ...existing,
          ...registration,
          apnsToken: registration.apnsToken ?? existing?.apnsToken ?? null,
          pushToStartToken: registration.clearPushToStartToken
            ? null
            : registration.pushToStartToken ?? existing?.pushToStartToken ?? null,
          prefs: registration.prefs ?? existing?.prefs ?? device.prefs,
          updatedAt: "",
        } as typeof device;
        if (existingIndex >= 0) devices[existingIndex] = updated;
        else devices.push(updated);
        return updated;
      },
      removeDevice: (deviceId: string) => {
        const index = devices.findIndex((entry) => entry.deviceId === deviceId);
        if (index >= 0) devices.splice(index, 1);
      },
      recordPublishResult: vi.fn(),
      recordRelayContact: vi.fn(),
      recordAttentionAcknowledgments: (args: {
        items: Array<{ id: string; revision: number }>;
        accountOwnerId: string | null;
        seenAt: string;
        dismissedAt?: string | null;
        updatedAt: string;
      }) => {
        for (const item of args.items) {
          const key = attentionAcknowledgmentKey(args.accountOwnerId, item.id);
          attentionAcknowledgments.set(key, {
            itemId: item.id,
            accountOwnerId: args.accountOwnerId,
            sourceRevision: item.revision,
            seenAt: args.seenAt,
            dismissedAt:
              typeof args.dismissedAt === "string"
                ? args.dismissedAt
                : attentionAcknowledgments.get(key)?.dismissedAt ?? null,
            updatedAt: args.updatedAt,
            pendingRelaySync: true,
          });
        }
      },
      getAttentionAcknowledgment: (itemId: string, accountOwnerId: string | null) =>
        attentionAcknowledgments.get(
          attentionAcknowledgmentKey(accountOwnerId, itemId),
        ) ?? null,
      listPendingAttentionAcknowledgments: () =>
        [...attentionAcknowledgments.values()].filter((entry) => entry.pendingRelaySync),
      markAttentionAcknowledgmentsSynced: (
        acknowledgments: Array<{
          itemId: string;
          accountOwnerId: string | null;
          updatedAt: string;
        }>,
      ) => {
        for (const acknowledgment of acknowledgments) {
          const key = attentionAcknowledgmentKey(
            acknowledgment.accountOwnerId,
            acknowledgment.itemId,
          );
          const entry = attentionAcknowledgments.get(key);
          if (entry?.updatedAt === acknowledgment.updatedAt) {
            attentionAcknowledgments.set(key, {
            ...entry,
            pendingRelaySync: false,
            });
          }
        }
      },
    };
    const relayClient = {
      publish,
      publishAttention,
      acknowledgeAttention,
      claim: vi.fn().mockResolvedValue(undefined),
      registerDevice: vi.fn().mockResolvedValue(undefined),
      unregisterDevice: vi.fn().mockResolvedValue(undefined),
      health: vi.fn().mockResolvedValue({ ok: true, apnsConfigured: true }),
      baseUrl: "https://relay.test",
    };
    let chatCb: ((env: AgentChatEventEnvelope) => void) | null = null;
    const agentChatService = {
      subscribeToEvents: (cb: (env: AgentChatEventEnvelope) => void) => {
        chatCb = cb;
        return () => {};
      },
      getSessionSummary: vi.fn().mockResolvedValue({
        sessionId: "s-1",
        laneId: "auth-lane",
        title: "Fix login",
        model: "gpt-5",
        provider: "codex",
        status: "active",
        startedAt: "",
        endedAt: null,
        lastActivityAt: "",
        lastOutputPreview: null,
        summary: null,
      }),
    };
    const publisher = createPushPublisherService({
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
      store: store as never,
      relayClient: relayClient as never,
      machineName: "MacBook",
      getAccountMachineIdentity: () => ({
        machineKey: "b".repeat(32),
        deviceId: "desktop-device",
      }),
      getAccountOwnerId: () => accountOwnerId,
      now,
      flushDebounceMs: 2_000,
      promptFlushMs: 150,
    });
    const cliSessions = new Map<string, { title: string | null; toolType?: string | null; chatSessionId?: string | null }>();
    const detach = publisher.attachSources("scope-1", {
      agentChatService: agentChatService as never,
      projectName: "ADE",
      projectRoot: "/projects/ADE",
      resolveLaneName: (laneId: string) => laneId,
      resolveCliSession: (sessionId: string) => cliSessions.get(sessionId) ?? null,
    });
    return {
      publisher,
      publish,
      publishAttention,
      acknowledgeAttention,
      emit: (env: AgentChatEventEnvelope) => chatCb?.(env),
      store,
      relayClient,
      cliSessions,
      detach,
      attentionAcknowledgments,
      getAttentionAcknowledgment: (
        itemId: string,
        ownerId: string | null = accountOwnerId,
      ) => attentionAcknowledgments.get(
        attentionAcknowledgmentKey(ownerId, itemId),
      ) ?? null,
      setAccountOwnerId: (ownerId: string | null) => {
        accountOwnerId = ownerId;
      },
    };
  }

  const approval: AgentChatEventEnvelope = {
    sessionId: "s-1",
    timestamp: "",
    event: { type: "approval_request", itemId: "i-1", kind: "command", description: "Run tests" },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps legacy machine Live Activities ownerless while deduping a repeat", async () => {
    const { publisher, publish, emit } = makeHarness();
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    expect(publish).toHaveBeenCalledTimes(1);
    const payload = publish.mock.calls[0][0];
    expect(payload.notifications).toHaveLength(1);
    expect(payload.notifications[0].title).toBe("Codex needs you");
    expect(payload.notifications[0].body).toBe("auth-lane · Fix login");
    expect(payload.notifications[0].deviceIds).toEqual(["dev-1"]);
    expect(payload.notifications[0].dedupeKey).toBe(alertDedupeKey("alert:s-1:approval"));
    expect(payload.liveActivity).toHaveLength(1);
    expect(payload.liveActivity[0].event).toBe("start");
    expect(payload.liveActivity[0].activityId).toBe("agent-runs");
    expect(payload.liveActivity[0].attributes).toEqual({ machineName: "MacBook" });
    expect(payload.liveActivity[0].attributes.ownershipEpoch).toBeUndefined();
    expect(payload.liveActivity[0].contentState.ownershipEpoch).toBeUndefined();
    expect(payload.liveActivity[0].contentState.activeCount).toBe(1);
    expect(payload.liveActivity[0].contentState.runs[0].id).toBe("s-1");

    // Identical repeat: alert dedupes and the LA contentState is unchanged.
    emit(approval);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish).toHaveBeenCalledTimes(1);

    publisher.dispose();
  });

  it("keeps updating a healthy phone while another phone persistently fails to start", async () => {
    const secondDevice = {
      ...device,
      deviceId: "dev-2",
      apnsToken: "c".repeat(64),
      pushToStartToken: "d".repeat(64),
    };
    const { publisher, publish, emit } = makeHarness([device, secondDevice]);
    publish
      .mockResolvedValueOnce({
        ok: true,
        delivered: 0,
        failed: 1,
        suppressed: 1,
        outcomes: [
          {
            deviceId: "dev-1",
            kind: "liveactivity",
            delivered: false,
            suppressed: true,
            skipped: null,
          },
          {
            deviceId: "dev-2",
            kind: "liveactivity",
            delivered: false,
            suppressed: false,
            skipped: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        delivered: 1,
        failed: 1,
        outcomes: [
          {
            deviceId: "dev-1",
            kind: "liveactivity",
            delivered: true,
            suppressed: false,
            skipped: null,
          },
          {
            deviceId: "dev-2",
            kind: "liveactivity",
            delivered: false,
            suppressed: false,
            skipped: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        delivered: 0,
        failed: 1,
        outcomes: [
          {
            deviceId: "dev-2",
            kind: "liveactivity",
            delivered: false,
            suppressed: false,
            skipped: null,
          },
        ],
      });
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish.mock.calls[0]?.[0].liveActivity?.[0]).toMatchObject({
      event: "start",
      deviceIds: ["dev-1", "dev-2"],
    });

    emit({
      sessionId: "s-1",
      timestamp: "",
      event: { type: "pending_input_resolved", itemId: "i-1", resolution: "accepted" },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0].liveActivity).toEqual([
      expect.objectContaining({
        event: "start",
        deviceIds: ["dev-2"],
      }),
      expect.objectContaining({
        event: "update",
        deviceIds: ["dev-1"],
        contentState: expect.objectContaining({
          runs: [expect.objectContaining({ id: "s-1", phase: "running" })],
        }),
      }),
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[2]?.[0].liveActivity).toEqual([
      expect.objectContaining({
        event: "start",
        deviceIds: ["dev-2"],
      }),
    ]);

    publisher.dispose();
  });

  it("retains a Live Activity hard failure as the latest delivery status", async () => {
    const { publisher, publish, emit, store, cliSessions } = makeHarness();
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish).toHaveBeenCalledTimes(1);

    publish.mockResolvedValueOnce({
      ok: true,
      delivered: 0,
      suppressed: 0,
      failed: 1,
      outcomes: [
        {
          deviceId: "dev-1",
          kind: "liveactivity",
          delivered: false,
          suppressed: false,
          skipped: null,
        },
      ],
    });
    cliSessions.set("cli-1", { title: "Watch logs", toolType: "codex" });
    publisher.handleCliRuntimeSignal("scope-1", {
      laneId: "ops",
      sessionId: "cli-1",
      runtimeState: "running",
    });
    await vi.advanceTimersByTimeAsync(2_500);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0].notifications).toBeUndefined();
    expect(publish.mock.calls[1]?.[0].liveActivity).toEqual([
      expect.objectContaining({
        event: "update",
        deviceIds: ["dev-1"],
      }),
    ]);
    expect(store.recordPublishResult).toHaveBeenLastCalledWith({
      at: expect.any(String),
      error: "relay failed 1 Live Activity target",
    });

    publisher.dispose();
  });

  it("retries only failed alert phones while committing delivered and suppressed phones", async () => {
    const secondDevice = {
      ...device,
      deviceId: "dev-2",
      apnsToken: "c".repeat(64),
      pushToStartToken: "d".repeat(64),
    };
    const thirdDevice = {
      ...device,
      deviceId: "dev-3",
      apnsToken: "e".repeat(64),
      pushToStartToken: "f".repeat(64),
    };
    const { publisher, publish, emit, store } = makeHarness([device, secondDevice, thirdDevice]);
    publish
      .mockResolvedValueOnce({
        ok: true,
        delivered: 1,
        suppressed: 4,
        failed: 1,
        outcomes: [
          {
            deviceId: "dev-1",
            kind: "alert",
            delivered: true,
            suppressed: false,
            skipped: null,
          },
          {
            deviceId: "dev-2",
            kind: "alert",
            delivered: false,
            suppressed: true,
            skipped: null,
          },
          {
            deviceId: "dev-3",
            kind: "alert",
            delivered: false,
            suppressed: false,
            skipped: null,
          },
          {
            deviceId: "dev-1",
            kind: "liveactivity",
            delivered: false,
            suppressed: true,
            skipped: null,
          },
          {
            deviceId: "dev-2",
            kind: "liveactivity",
            delivered: false,
            suppressed: true,
            skipped: null,
          },
          {
            deviceId: "dev-3",
            kind: "liveactivity",
            delivered: false,
            suppressed: true,
            skipped: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        delivered: 1,
        suppressed: 0,
        failed: 0,
        outcomes: [
          {
            deviceId: "dev-3",
            kind: "alert",
            delivered: true,
            suppressed: false,
            skipped: null,
          },
        ],
      });

    await publisher.start();
    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0].notifications).toEqual([
      expect.objectContaining({
        deviceIds: ["dev-1"],
        dedupeKey: alertDedupeKey("alert:s-1:approval", "dev-1"),
      }),
      expect.objectContaining({
        deviceIds: ["dev-2"],
        dedupeKey: alertDedupeKey("alert:s-1:approval", "dev-2"),
      }),
      expect.objectContaining({
        deviceIds: ["dev-3"],
        dedupeKey: alertDedupeKey("alert:s-1:approval", "dev-3"),
      }),
    ]);
    expect(store.recordPublishResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ error: "relay failed 1 alert target" }),
    );

    await vi.advanceTimersByTimeAsync(30_000);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0].notifications).toEqual([
      expect.objectContaining({
        deviceIds: ["dev-3"],
        dedupeKey: alertDedupeKey("alert:s-1:approval", "dev-3"),
      }),
    ]);
    expect(store.recordPublishResult).toHaveBeenLastCalledWith(
      { at: expect.any(String) },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(publish).toHaveBeenCalledTimes(2);

    publisher.dispose();
  });

  it("restarts only the re-enabled device without duplicating other Live Activities", async () => {
    const secondDevice = {
      ...device,
      deviceId: "dev-2",
      apnsToken: "c".repeat(64),
      pushToStartToken: "d".repeat(64),
    };
    const { publisher, publish, emit } = makeHarness([device, secondDevice]);
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish.mock.calls[0]?.[0].liveActivity?.[0]).toMatchObject({
      event: "start",
      deviceIds: ["dev-1", "dev-2"],
    });

    await publisher.handleDeviceRegistered({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      clearPushToStartToken: true,
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish).toHaveBeenCalledTimes(1);

    await publisher.handleDeviceRegistered({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      pushToStartToken: "e".repeat(64),
    });
    await vi.advanceTimersByTimeAsync(2_500);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0].liveActivity).toEqual([
      expect.objectContaining({
        event: "start",
        deviceIds: ["dev-1"],
      }),
    ]);

    publisher.dispose();
  });

  it("retries only the failed re-enabled device after a mixed restart", async () => {
    const secondDevice = {
      ...device,
      deviceId: "dev-2",
      apnsToken: "c".repeat(64),
      pushToStartToken: "d".repeat(64),
    };
    const { publisher, publish, emit } = makeHarness([device, secondDevice]);
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish.mock.calls[0]?.[0].liveActivity?.[0]).toMatchObject({
      event: "start",
      deviceIds: ["dev-1", "dev-2"],
    });

    for (const deviceId of ["dev-1", "dev-2"]) {
      await publisher.handleDeviceRegistered({
        deviceId,
        bundleId: "com.ade.ios",
        apsEnvironment: "sandbox",
        clearPushToStartToken: true,
      });
      await publisher.handleDeviceRegistered({
        deviceId,
        bundleId: "com.ade.ios",
        apsEnvironment: "sandbox",
        pushToStartToken: `${deviceId === "dev-1" ? "e" : "f"}`.repeat(64),
      });
    }
    publish
      .mockResolvedValueOnce({
        ok: true,
        delivered: 1,
        failed: 1,
        outcomes: [
          {
            deviceId: "dev-1",
            kind: "liveactivity",
            delivered: true,
            suppressed: false,
            skipped: null,
          },
          {
            deviceId: "dev-2",
            kind: "liveactivity",
            delivered: false,
            suppressed: false,
            skipped: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        delivered: 1,
        failed: 0,
        outcomes: [
          {
            deviceId: "dev-2",
            kind: "liveactivity",
            delivered: true,
            suppressed: false,
            skipped: null,
          },
        ],
      });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish.mock.calls[1]?.[0].liveActivity?.[0]).toMatchObject({
      event: "start",
      deviceIds: ["dev-1", "dev-2"],
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[2]?.[0].liveActivity?.[0]).toMatchObject({
      event: "start",
      deviceIds: ["dev-2"],
    });

    publisher.dispose();
  });

  it("retries mixed Live Activity updates and ends only for failed phones", async () => {
    const secondDevice = {
      ...device,
      deviceId: "dev-2",
      apnsToken: "c".repeat(64),
      pushToStartToken: "d".repeat(64),
    };
    const { publisher, publish, emit } = makeHarness([device, secondDevice]);
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish.mock.calls[0]?.[0].liveActivity?.[0]).toMatchObject({
      event: "start",
      deviceIds: ["dev-1", "dev-2"],
    });

    publish
      .mockResolvedValueOnce({
        ok: true,
        delivered: 1,
        failed: 1,
        outcomes: [
          {
            deviceId: "dev-1",
            kind: "liveactivity",
            delivered: true,
            suppressed: false,
            skipped: null,
          },
          {
            deviceId: "dev-2",
            kind: "liveactivity",
            delivered: false,
            suppressed: false,
            skipped: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        delivered: 1,
        failed: 0,
        outcomes: [
          {
            deviceId: "dev-2",
            kind: "liveactivity",
            delivered: true,
            suppressed: false,
            skipped: null,
          },
        ],
      });
    emit({
      sessionId: "s-1",
      timestamp: "",
      event: { type: "pending_input_resolved", itemId: "i-1", resolution: "accepted" },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish.mock.calls[1]?.[0].liveActivity).toEqual([
      expect.objectContaining({
        event: "update",
        deviceIds: ["dev-1", "dev-2"],
      }),
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(publish.mock.calls[2]?.[0].liveActivity).toEqual([
      expect.objectContaining({
        event: "update",
        deviceIds: ["dev-2"],
      }),
    ]);

    publish
      .mockResolvedValueOnce({
        ok: true,
        delivered: 1,
        failed: 1,
        outcomes: [
          {
            deviceId: "dev-1",
            kind: "liveactivity",
            delivered: true,
            suppressed: false,
            skipped: null,
          },
          {
            deviceId: "dev-2",
            kind: "liveactivity",
            delivered: false,
            suppressed: false,
            skipped: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        delivered: 1,
        failed: 0,
        outcomes: [
          {
            deviceId: "dev-2",
            kind: "liveactivity",
            delivered: true,
            suppressed: false,
            skipped: null,
          },
        ],
      });
    emit({
      sessionId: "s-1",
      timestamp: "",
      event: { type: "status", turnStatus: "completed" },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish.mock.calls[3]?.[0].liveActivity).toEqual([
      expect.objectContaining({
        event: "end",
        deviceIds: ["dev-1", "dev-2"],
      }),
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(publish.mock.calls[4]?.[0].liveActivity).toEqual([
      expect.objectContaining({
        event: "end",
        deviceIds: ["dev-2"],
      }),
    ]);

    publisher.dispose();
  });

  it("does not restart a running Live Activity when its push-to-start token rotates", async () => {
    const { publisher, publish, emit } = makeHarness();
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish.mock.calls[0]?.[0].liveActivity?.[0]).toMatchObject({
      event: "start",
      deviceIds: ["dev-1"],
    });

    await publisher.handleDeviceRegistered({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      pushToStartToken: "e".repeat(64),
    });
    await vi.advanceTimersByTimeAsync(2_500);

    expect(publish).toHaveBeenCalledTimes(1);
    publisher.dispose();
  });

  it("publishes one account-wide Attention item with exact project and approval actions", async () => {
    const { publisher, publishAttention, emit } = makeHarness();
    publishAttention.mockResolvedValue({ ok: true, revision: 1 });
    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    expect(publishAttention).toHaveBeenCalledTimes(1);
    const payload = publishAttention.mock.calls[0][0];
    expect(payload.fullSnapshot).toBe(true);
    expect(payload.machineName).toBe("MacBook");
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      kind: "agent",
      eventKind: "agent_needs_you",
      phase: "needs_you",
      machine: {
        machineKey: "a".repeat(40),
        accountMachineKey: "b".repeat(32),
        deviceId: "desktop-device",
      },
      project: {
        projectId: "scope-1",
        name: "ADE",
        rootPath: "/projects/ADE",
      },
      destination: {
        kind: "session",
        sessionId: "s-1",
        itemId: "i-1",
      },
    });
    expect(payload.items[0].actions.map((action: { kind: string }) => action.kind))
      .toEqual(["approve", "deny", "open"]);

    publisher.dispose();
  });

  it("keeps machine Attention acknowledgments durable and revision-fenced", async () => {
    const {
      publisher,
      emit,
      publishAttention,
      acknowledgeAttention,
      getAttentionAcknowledgment,
      setAccountOwnerId,
    } = makeHarness();
    emit(approval);

    const first = await publisher.getMachineAttentionSnapshot();
    expect(first.items).toHaveLength(1);
    const item = first.items[0]!;

    await publisher.acknowledgeMachineAttention({
      itemIds: [item.id],
      sourceRevisions: { [item.id]: item.revision },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-05T12:00:01.000Z",
    });
    expect(getAttentionAcknowledgment(item.id, "owner-a")).toMatchObject({
      sourceRevision: item.revision,
      seenAt: "2026-07-05T12:00:01.000Z",
      pendingRelaySync: true,
    });
    expect(acknowledgeAttention).not.toHaveBeenCalled();
    await expect(publisher.getMachineAttentionSnapshot()).resolves.toMatchObject({
      items: [expect.objectContaining({
        id: item.id,
        seenAt: "2026-07-05T12:00:01.000Z",
      })],
    });

    publisher.handleSessionAttentionRequested("scope-1", {
      sessionId: "s-1",
      kind: "chat",
      title: "Fix login",
      message: "A newer question needs an answer.",
      laneId: "auth-lane",
    });
    const updated = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    expect(updated).toMatchObject({
      id: item.id,
      seenAt: null,
    });
    expect(updated.revision).toBeGreaterThan(item.revision);
    await expect(publisher.acknowledgeMachineAttention({
      itemIds: [item.id],
      sourceRevisions: { [item.id]: item.revision },
      expectedAccountOwnerId: "owner-a",
    })).rejects.toThrow(/changed after it loaded/i);

    await expect(publisher.acknowledgeMachineAttention({
      itemIds: ["agent:other-machine:unknown"],
      sourceRevisions: { "agent:other-machine:unknown": 1 },
      expectedAccountOwnerId: "owner-a",
    })).rejects.toThrow(/latest Attention snapshot/i);

    const current = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    setAccountOwnerId("owner-b");
    await expect(publisher.acknowledgeMachineAttention({
      itemIds: [current.id],
      sourceRevisions: { [current.id]: current.revision },
      expectedAccountOwnerId: "owner-a",
    })).rejects.toThrow(/account changed/i);

    publishAttention.mockResolvedValue({ ok: true, revision: 9 });
    publisher.poke();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(acknowledgeAttention).not.toHaveBeenCalled();
    expect(getAttentionAcknowledgment(item.id, "owner-a")?.pendingRelaySync).toBe(true);
    publisher.dispose();
  });

  it("reconciles a durable machine acknowledgment only after publishing its item", async () => {
    const {
      publisher,
      emit,
      publishAttention,
      acknowledgeAttention,
      getAttentionAcknowledgment,
    } = makeHarness();
    publishAttention.mockResolvedValue({ ok: true, revision: 1 });
    acknowledgeAttention.mockResolvedValue({ ok: true, revision: 2 });
    emit(approval);
    const item = (await publisher.getMachineAttentionSnapshot()).items[0]!;

    await publisher.acknowledgeMachineAttention({
      itemIds: [item.id],
      sourceRevisions: { [item.id]: item.revision },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-05T12:00:01.000Z",
    });
    expect(acknowledgeAttention).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(acknowledgeAttention).toHaveBeenCalledWith({
      itemIds: [item.id],
      seenAt: "2026-07-05T12:00:01.000Z",
      expectedAccountOwnerId: "owner-a",
    });
    expect(getAttentionAcknowledgment(item.id, "owner-a")?.pendingRelaySync).toBe(false);
    publisher.dispose();
  });

  it("stops a multi-group acknowledgment reconcile when the account changes mid-flight", async () => {
    const {
      publisher,
      emit,
      publishAttention,
      acknowledgeAttention,
      getAttentionAcknowledgment,
      setAccountOwnerId,
    } = makeHarness();
    publishAttention.mockResolvedValue({ ok: true, revision: 1 });
    emit(approval);
    publisher.handleSessionAttentionRequested("scope-1", {
      sessionId: "s-2",
      kind: "chat",
      title: "Second question",
      message: "Choose a migration path.",
      laneId: "auth-lane",
    });
    const snapshot = await publisher.getMachineAttentionSnapshot();
    const first = snapshot.items.find((entry) => entry.id.includes(":s-1"))!;
    const second = snapshot.items.find((entry) => entry.id.includes(":s-2"))!;
    await publisher.acknowledgeMachineAttention({
      itemIds: [first.id],
      sourceRevisions: { [first.id]: first.revision },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-05T12:00:01.000Z",
    });
    vi.setSystemTime(new Date("2026-07-05T12:00:02.000Z"));
    await publisher.acknowledgeMachineAttention({
      itemIds: [second.id],
      sourceRevisions: { [second.id]: second.revision },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-05T12:00:02.000Z",
    });
    acknowledgeAttention.mockImplementationOnce(async () => {
      setAccountOwnerId("owner-b");
      return { ok: true, revision: 2 };
    });

    await vi.advanceTimersByTimeAsync(200);

    expect(acknowledgeAttention).toHaveBeenCalledTimes(1);
    expect(getAttentionAcknowledgment(first.id, "owner-a")?.pendingRelaySync).toBe(false);
    expect(getAttentionAcknowledgment(second.id, "owner-a")?.pendingRelaySync).toBe(true);
    publisher.dispose();
  });

  it.each([
    { unchanged: true },
    { suppressed: true },
  ])("delivers queued alerts when the Attention result is suppressed or unchanged", async (result) => {
    const { publisher, publish, publishAttention, emit } = makeHarness();
    publishAttention.mockResolvedValue({ ok: true, ...result });

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    expect(publish).toHaveBeenCalledTimes(1);
    const payload = publish.mock.calls[0][0];
    expect(payload.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dedupeKey: alertDedupeKey("alert:s-1:approval") }),
      ]),
    );
    expect(payload.liveActivity).toBeUndefined();

    publisher.dispose();
  });

  it("advances the Attention revision without spamming a duplicate alert", async () => {
    const fixedNow = Date.parse("2026-07-05T12:00:00.000Z");
    const { publisher, publish, publishAttention, emit } = makeHarness(
      device,
      () => fixedNow,
    );
    publishAttention.mockResolvedValue({ ok: true, revision: 1 });

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(
      (publish.mock.calls[0]?.[0].notifications ?? [])
        .filter((item: { title: string }) => item.title),
    ).toEqual([]);
    publish.mockClear();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    expect(publishAttention).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();

    publisher.dispose();
  });

  it("caps Attention full snapshots at 64 items while preserving the canonical priority boundary", async () => {
    const { publisher, publishAttention, cliSessions } = makeHarness();
    publishAttention.mockResolvedValue({ ok: true, revision: 1 });

    publisher.handleSessionAttentionRequested("scope-1", {
      sessionId: "needs-you",
      kind: "chat",
      title: "Release decision",
      message: "Choose the rollout window",
      laneId: "auth-lane",
    });
    // Every lower-priority running item is newer, proving phase priority wins
    // at the truncation boundary instead of recency accidentally displacing it.
    vi.advanceTimersByTime(1);
    for (let index = 0; index < 64; index += 1) {
      const sessionId = `running-${String(index).padStart(2, "0")}`;
      cliSessions.set(sessionId, {
        title: `Background run ${index}`,
        toolType: "codex",
        chatSessionId: null,
      });
      publisher.handleCliRuntimeSignal("scope-1", {
        laneId: "auth-lane",
        sessionId,
        runtimeState: "running",
      });
    }

    await vi.advanceTimersByTimeAsync(200);

    expect(publishAttention).toHaveBeenCalledTimes(1);
    const payload = publishAttention.mock.calls[0][0];
    expect(payload).toMatchObject({
      machineName: "MacBook",
      fullSnapshot: true,
    });
    expect(payload.items).toHaveLength(64);
    expect(payload.items[0]).toMatchObject({
      id: `agent:${"a".repeat(40)}:needs-you`,
      phase: "needs_you",
      destination: {
        kind: "session",
        sessionId: "needs-you",
      },
    });
    expect(payload.items.map((item: { id: string }) => item.id)).not.toContain(
      `agent:${"a".repeat(40)}:running-63`,
    );

    publisher.dispose();
  });

  it("alerts native structured questions with the unified needs-you copy immediately", async () => {
    const { publisher, publish, emit } = makeHarness();
    await publisher.start();

    emit({
      sessionId: "s-structured",
      timestamp: "",
      event: {
        type: "approval_request",
        itemId: "question-1",
        kind: "tool_call",
        description: "Choose a rollout strategy",
        detail: {
          request: {
            kind: "structured_question",
            title: "Rollout strategy",
          },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].notifications[0]).toMatchObject({
      title: "Codex needs you",
      sessionId: "s-structured",
      itemId: "question-1",
      interruptionLevel: "time-sensitive",
    });

    publisher.dispose();
  });

  it("publishes PR lifecycle alerts into the aggregate Live Activity", async () => {
    const { publisher, publish } = makeHarness();
    let firstPrCb: (event: PushPrNotification) => void = () => {
      throw new Error("first PR notification source was not attached");
    };
    let secondPrCb: (event: PushPrNotification) => void = () => {
      throw new Error("second PR notification source was not attached");
    };
    publisher.attachSources("project-a", {
      subscribePrNotifications: (cb) => {
        firstPrCb = cb;
        return () => {};
      },
      resolveLaneName: (laneId: string) => laneId === "lane-42" ? "Mobile PR lane" : laneId,
    });
    const detachProjectB = publisher.attachSources("project-b", {
      subscribePrNotifications: (cb) => {
        secondPrCb = cb;
        return () => {};
      },
      resolveLaneName: (laneId: string) => laneId === "lane-other" ? "Other repo lane" : laneId,
    });
    await publisher.start();

    firstPrCb({
      kind: "merged",
      prNumber: 42,
      prTitle: "Ship mobile PR view",
      laneId: "lane-42",
      repoOwner: "arul28",
      repoName: "ADE",
    });
    await vi.advanceTimersByTimeAsync(2_500);

    const payload = publish.mock.calls[0][0];
    expect(payload.notifications[0]).toMatchObject({
      title: "PR #42 merged",
      body: "Ship mobile PR view",
      deepLink: "ade://pr/arul28/ADE/42",
      threadId: "pr:project-a:repo:arul28:ade:42",
    });
    expect(payload.liveActivity[0].contentState.prs[0]).toMatchObject({
      id: "pr:project-a:repo:arul28:ade:42",
      prNumber: 42,
      title: "Ship mobile PR view",
      phase: "merged",
      lane: "Mobile PR lane",
      repoOwner: "arul28",
      repoName: "ADE",
    });
    expect(payload.liveActivity[0].phase).toBe("running");

    secondPrCb({
      kind: "checks_failing",
      prNumber: 42,
      prTitle: "Same number, other repo",
      laneId: "lane-other",
      repoOwner: "other-org",
      repoName: "other-repo",
    });
    await vi.advanceTimersByTimeAsync(2_500);

    const updatePayload = publish.mock.calls.at(-1)?.[0];
    expect(updatePayload?.liveActivity[0].contentState.prs).toMatchObject([
      {
        id: "pr:project-b:repo:other-org:other-repo:42",
        prNumber: 42,
        title: "Same number, other repo",
        phase: "checks_failing",
        lane: "Other repo lane",
        repoOwner: "other-org",
        repoName: "other-repo",
      },
      {
        id: "pr:project-a:repo:arul28:ade:42",
        prNumber: 42,
        title: "Ship mobile PR view",
        phase: "merged",
        lane: "Mobile PR lane",
        repoOwner: "arul28",
        repoName: "ADE",
      },
    ]);

    detachProjectB();
    await vi.advanceTimersByTimeAsync(2_500);
    const detachPayload = publish.mock.calls.at(-1)?.[0];
    expect(detachPayload?.liveActivity[0].contentState.prs).toHaveLength(1);
    expect(detachPayload?.liveActivity[0].contentState.prs[0]).toMatchObject({
      id: "pr:project-a:repo:arul28:ade:42",
      title: "Ship mobile PR view",
    });

    await vi.advanceTimersByTimeAsync(45 * 60 * 1000 + 1_000);
    const endPayload = publish.mock.calls.at(-1)?.[0];
    expect(endPayload.liveActivity[0]).toMatchObject({
      event: "end",
      phase: "terminal",
    });
    expect(endPayload.liveActivity[0].contentState.prs).toEqual([]);

    publisher.dispose();
  });

  it("separates duplicate PR numbers inside one project scope by repo", async () => {
    const { publisher, publish } = makeHarness();
    let prCb: (event: PushPrNotification) => void = () => {
      throw new Error("PR notification source was not attached");
    };
    publisher.attachSources("project-a", {
      subscribePrNotifications: (cb) => {
        prCb = cb;
        return () => {};
      },
    });
    await publisher.start();

    prCb({
      kind: "opened",
      prNumber: 42,
      prTitle: "API PR",
      laneId: null,
      repoOwner: "Org-A",
      repoName: "api",
    });
    prCb({
      kind: "opened",
      prNumber: 42,
      prTitle: "Web PR",
      laneId: null,
      repoOwner: "Org-B",
      repoName: "web",
    });
    await vi.advanceTimersByTimeAsync(2_500);

    const payload = publish.mock.calls[0][0];
    expect(payload.notifications.map((item: { threadId: string; dedupeKey: string }) => ({
      threadId: item.threadId,
      dedupeKey: item.dedupeKey,
    }))).toEqual([
      {
        threadId: "pr:project-a:repo:org-a:api:42",
        dedupeKey: alertDedupeKey("alert:pr:project-a:repo:org-a:api:42:opened"),
      },
      {
        threadId: "pr:project-a:repo:org-b:web:42",
        dedupeKey: alertDedupeKey("alert:pr:project-a:repo:org-b:web:42:opened"),
      },
    ]);
    expect(payload.liveActivity[0].contentState.prs).toMatchObject([
      { id: "pr:project-a:repo:org-a:api:42", title: "API PR" },
      { id: "pr:project-a:repo:org-b:web:42", title: "Web PR" },
    ]);

    publisher.dispose();
  });

  it("publishes repeated PR transition alerts after an intervening state change", async () => {
    const { publisher, publish } = makeHarness();
    let prCb: (event: PushPrNotification) => void = () => {
      throw new Error("PR notification source was not attached");
    };
    publisher.attachSources("project-a", {
      subscribePrNotifications: (cb) => {
        prCb = cb;
        return () => {};
      },
    });
    await publisher.start();

    const pr = {
      prNumber: 42,
      prTitle: "Repeatable PR lifecycle",
      laneId: null,
      repoOwner: "arul28",
      repoName: "ADE",
    };

    prCb({ ...pr, kind: "closed" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish.mock.calls.at(-1)?.[0].notifications[0]).toMatchObject({
      title: "PR #42 closed",
      body: "Repeatable PR lifecycle",
      dedupeKey: alertDedupeKey("alert:pr:project-a:repo:arul28:ade:42:closed"),
    });

    publish.mockClear();
    prCb({ ...pr, kind: "reopened" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish.mock.calls.at(-1)?.[0].notifications[0]).toMatchObject({
      title: "PR #42 reopened",
      body: "Repeatable PR lifecycle",
    });

    publish.mockClear();
    prCb({ ...pr, kind: "closed" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish.mock.calls.at(-1)?.[0].notifications[0]).toMatchObject({
      title: "PR #42 closed",
      body: "Repeatable PR lifecycle",
      dedupeKey: alertDedupeKey("alert:pr:project-a:repo:arul28:ade:42:closed"),
    });

    publisher.dispose();
  });

  it("uses the uncapped PR count in the aggregate Live Activity start alert", async () => {
    const { publisher, publish } = makeHarness();
    let prCb: (event: PushPrNotification) => void = () => {
      throw new Error("PR notification source was not attached");
    };
    publisher.attachSources("project-prs", {
      subscribePrNotifications: (cb) => {
        prCb = cb;
        return () => {};
      },
    });
    await publisher.start();

    for (const prNumber of [101, 102, 103]) {
      prCb({
        kind: "opened",
        prNumber,
        prTitle: `PR ${prNumber}`,
        laneId: null,
        repoOwner: "arul28",
        repoName: "ADE",
      });
    }
    await vi.advanceTimersByTimeAsync(2_500);

    const liveActivity = publish.mock.calls[0][0].liveActivity[0];
    expect(liveActivity.contentState.prs).toHaveLength(2);
    expect(liveActivity.alert.title).toBe("3 pull requests updated");

    publisher.dispose();
  });

  it("uses the PR title for a PR-only aggregate start when stale CLI rows exist", async () => {
    const { publisher, publish, cliSessions } = makeHarness();
    let prCb: (event: PushPrNotification) => void = () => {
      throw new Error("PR notification source was not attached");
    };
    publisher.attachSources("project-prs", {
      subscribePrNotifications: (cb) => {
        prCb = cb;
        return () => {};
      },
    });
    cliSessions.set("cli-1", { title: "stale CLI title", toolType: "claude", chatSessionId: null });
    await publisher.start();

    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "cli-1", runtimeState: "idle" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish.mock.calls.every(([payload]) => !payload.liveActivity)).toBe(true);
    publish.mockClear();

    prCb({
      kind: "opened",
      prNumber: 42,
      prTitle: "Actual PR title",
      laneId: null,
      repoOwner: "arul28",
      repoName: "ADE",
    });
    await vi.advanceTimersByTimeAsync(2_500);

    const liveActivity = publish.mock.calls[0][0].liveActivity[0];
    expect(liveActivity.event).toBe("start");
    expect(liveActivity.alert.title).toBe("PR #42 updated");
    expect(liveActivity.alert.body).toBe("Actual PR title");

    publisher.dispose();
  });

  it("drops terminal run rows before PR-backed Live Activity updates", async () => {
    const { publisher, publish, emit } = makeHarness();
    let prCb: (event: PushPrNotification) => void = () => {
      throw new Error("PR notification source was not attached");
    };
    publisher.attachSources("project-prs", {
      subscribePrNotifications: (cb) => {
        prCb = cb;
        return () => {};
      },
    });
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish.mock.calls[0][0].liveActivity[0].contentState.runs[0].id).toBe("s-1");
    publish.mockClear();

    emit({ sessionId: "s-1", timestamp: "", event: { type: "status", turnStatus: "completed" } });
    prCb({
      kind: "opened",
      prNumber: 42,
      prTitle: "Actual PR title",
      laneId: null,
      repoOwner: "arul28",
      repoName: "ADE",
    });
    await vi.advanceTimersByTimeAsync(2_500);

    const liveActivity = publish.mock.calls.at(-1)![0].liveActivity[0];
    expect(liveActivity.event).toBe("update");
    expect(liveActivity.contentState.prs[0].prNumber).toBe(42);
    expect(liveActivity.contentState.runs.find((run: { id: string }) => run.id === "s-1")).toBeUndefined();
    expect(publisher._debug.runs.has("s-1")).toBe(false);

    publisher.dispose();
  });

  it("carries actionable fields: category + sessionId/itemId on the alert, itemId on the waiting LA row, badge count", async () => {
    const { publisher, publish, emit } = makeHarness();
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    const payload = publish.mock.calls[0][0];
    expect(payload.notifications[0].category).toBe("ADE_APPROVAL");
    expect(payload.notifications[0].sessionId).toBe("s-1");
    expect(payload.notifications[0].itemId).toBe("i-1");
    expect(payload.notifications[0].badge).toBe(1);
    const laRun = payload.liveActivity[0].contentState.runs[0];
    expect(laRun.phase).toBe("waiting_for_approval");
    expect(laRun.itemId).toBe("i-1");

    // Resolution clears the pending item id from later content states.
    emit({
      sessionId: "s-1",
      timestamp: "",
      event: { type: "pending_input_resolved", itemId: "i-1", resolution: "accepted" },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    const lastPayload = publish.mock.calls.at(-1)?.[0];
    const resolvedRun = lastPayload.liveActivity?.[0]?.contentState.runs[0];
    expect(resolvedRun?.phase).toBe("running");
    expect(resolvedRun?.itemId).toBeUndefined();

    publisher.dispose();
  });

  it("badge-syncs devices whose alert was muted while the alert covers the rest", async () => {
    const deviceB = { ...device, deviceId: "dev-2", prefs: { ...device.prefs, mutedSessionIds: ["s-1"] } };
    const publish = vi.fn().mockResolvedValue({ ok: true });
    const store = {
      hasRegisteredDevices: () => true,
      getStatusSnapshot: () => ({ enabled: true, claimed: true, registeredDeviceCount: 2, lastPublishAt: null, lastPublishError: null, lastRelayContactAt: null }),
      listDevices: () => [device, deviceB],
      getDevice: () => device,
      recordPublishResult: vi.fn(),
      recordRelayContact: vi.fn(),
    };
    const relayClient = { publish, health: vi.fn().mockResolvedValue({ ok: true, apnsConfigured: true }), baseUrl: "https://relay.test" };
    let chatCb: ((env: AgentChatEventEnvelope) => void) | null = null;
    const emit = (env: AgentChatEventEnvelope) => chatCb?.(env);
    const publisher = createPushPublisherService({
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
      store: store as never,
      relayClient: relayClient as never,
      machineName: "MacBook",
      flushDebounceMs: 2_000,
      promptFlushMs: 150,
    });
    publisher.attachSources("scope-1", {
      agentChatService: {
        subscribeToEvents: (cb: (env: AgentChatEventEnvelope) => void) => {
          chatCb = cb;
          return () => {};
        },
        getSessionSummary: vi.fn().mockResolvedValue(null),
      } as never,
    });
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    const payload = publish.mock.calls[0][0];
    const alertItem = payload.notifications.find((item: { title: string }) => item.title.length > 0);
    const badgeItem = payload.notifications.find((item: { title: string; badge?: number | null }) => item.title === "" && item.badge != null);
    // The audible alert reaches only the unmuted device...
    expect(alertItem.deviceIds).toEqual(["dev-1"]);
    expect(alertItem.badge).toBe(1);
    // ...while the muted device still gets the new badge count silently.
    expect(badgeItem.deviceIds).toEqual(["dev-2"]);
    expect(badgeItem.badge).toBe(1);

    publisher.dispose();
  });

  it("suppresses the badge-only item for a device inside quiet hours", async () => {
    // System time is 12:00 UTC (beforeEach); a 00:00→23:59 UTC window is active.
    const quiet = {
      ...device,
      prefs: { ...device.prefs, quietHours: { start: "00:00", end: "23:59", timezone: "UTC" } },
    };
    const { publisher, publish, emit } = makeHarness(quiet);
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    // Alert is quiet-hours-filtered AND no badge-only item may replace it —
    // "mute pushes on a schedule" covers silent badge pushes too. Only the
    // Live Activity (quiet-hours-exempt) goes out.
    expect(publish).toHaveBeenCalledTimes(1);
    const payload = publish.mock.calls[0][0];
    expect(payload.notifications).toBeUndefined();
    expect(payload.liveActivity[0].event).toBe("start");

    publisher.dispose();
  });

  it("sends a silent badge-only item when the awaiting count drops with no alert", async () => {
    const { publisher, publish, emit } = makeHarness();
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish.mock.calls[0][0].notifications[0].badge).toBe(1);

    emit({
      sessionId: "s-1",
      timestamp: "",
      event: { type: "pending_input_resolved", itemId: "i-1", resolution: "accepted" },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    const lastPayload = publish.mock.calls.at(-1)?.[0];
    const badgeItem = (lastPayload.notifications ?? []).find(
      (item: { title: string; badge?: number | null }) => item.title === "" && item.badge != null,
    );
    expect(badgeItem).toMatchObject({ title: "", badge: 0, sound: null });

    publisher.dispose();
  });

  it("publishes a best-effort Live Activity end on shutdown, marking active runs stale", async () => {
    const { publisher, publish, emit } = makeHarness();
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish).toHaveBeenCalledTimes(1);

    await publisher.shutdown();
    const lastPayload = publish.mock.calls.at(-1)?.[0];
    expect(lastPayload.liveActivity[0].event).toBe("end");
    expect(lastPayload.liveActivity[0].dismissalDate).toBe(
      Math.floor(Date.parse("2026-07-05T12:00:00.000Z") / 1000) + 60,
    );
    expect(lastPayload.liveActivity[0].contentState.runs[0].phase).toBe("stale");

    // Disposed: no further flush can fire.
    emit(approval);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publish.mock.calls.at(-1)?.[0]).toBe(lastPayload);
  });

  it("shutdown is a no-op publish when no Live Activity start was committed", async () => {
    const { publisher, publish } = makeHarness();
    await publisher.start();
    await publisher.shutdown();
    expect(publish).not.toHaveBeenCalled();
  });

  it("suppresses a muted alert but still updates the Live Activity and badge", async () => {
    const muted = { ...device, prefs: { ...device.prefs, mutedSessionIds: ["s-1"] } };
    const { publisher, publish, emit } = makeHarness(muted);
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    expect(publish).toHaveBeenCalledTimes(1);
    const payload = publish.mock.calls[0][0];
    // The muted alert itself is suppressed, but a muted session still awaits
    // attention, so a silent badge-only item keeps the app icon honest.
    expect(payload.notifications).toHaveLength(1);
    expect(payload.notifications[0].title).toBe("");
    expect(payload.notifications[0].badge).toBe(1);
    expect(payload.notifications[0].sound).toBeNull();
    // No relay dedupeKey: the suppression hash ignores deviceIds, so a shared
    // key would starve other devices of the same count.
    expect(payload.notifications[0].dedupeKey).toBeUndefined();
    expect(payload.liveActivity[0].event).toBe("start");

    publisher.dispose();
  });

  it("does not publish when there are no registered devices", async () => {
    const { publisher, publish, emit, store } = makeHarness();
    (store as { hasRegisteredDevices: () => boolean }).hasRegisteredDevices = () => false;
    await publisher.start();
    emit(approval);
    await vi.advanceTimersByTimeAsync(500);
    expect(publish).not.toHaveBeenCalled();
    publisher.dispose();
  });

  it("merges runs from two attached project scopes into one aggregate Live Activity", async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true });
    const store = {
      hasRegisteredDevices: () => true,
      getStatusSnapshot: () => ({ enabled: true, claimed: true, registeredDeviceCount: 1, lastPublishAt: null, lastPublishError: null, lastRelayContactAt: null }),
      listDevices: () => [device],
      getDevice: () => device,
      recordPublishResult: vi.fn(),
      recordRelayContact: vi.fn(),
    };
    const relayClient = { publish, health: vi.fn().mockResolvedValue({ ok: true, apnsConfigured: true }), baseUrl: "https://relay.test" };
    const makeChat = (sessionId: string) => {
      let cb: ((env: AgentChatEventEnvelope) => void) | null = null;
      return {
        service: {
          subscribeToEvents: (fn: (env: AgentChatEventEnvelope) => void) => { cb = fn; return () => {}; },
          getSessionSummary: vi.fn().mockResolvedValue({
            sessionId, laneId: "lane", title: "T", model: "gpt-5", provider: "codex",
            status: "active", startedAt: "", endedAt: null, lastActivityAt: "", lastOutputPreview: null, summary: null,
          }),
        },
        emit: (env: AgentChatEventEnvelope) => cb?.(env),
      };
    };
    const projectA = makeChat("s-a");
    const projectB = makeChat("s-b");
    const publisher = createPushPublisherService({
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
      store: store as never,
      relayClient: relayClient as never,
      machineName: "MacBook",
      flushDebounceMs: 2_000,
      promptFlushMs: 150,
    });
    publisher.attachSources("project-a", { agentChatService: projectA.service as never });
    publisher.attachSources("project-b", { agentChatService: projectB.service as never });
    await publisher.start();

    projectA.emit({ sessionId: "s-a", timestamp: "", event: { type: "approval_request", itemId: "i", kind: "command", description: "x" } });
    projectB.emit({ sessionId: "s-b", timestamp: "", event: { type: "approval_request", itemId: "i", kind: "command", description: "y" } });
    await vi.advanceTimersByTimeAsync(2_500);

    const laPayloads = publish.mock.calls.map((c) => c[0]).filter((p) => p.liveActivity);
    const lastLa = laPayloads[laPayloads.length - 1].liveActivity[0];
    expect(lastLa.contentState.activeCount).toBe(2);
    expect(lastLa.contentState.runs.map((r: { id: string }) => r.id).sort()).toEqual(["s-a", "s-b"]);

    publisher.dispose();
  });

  it("surfaces CLI runtime signals in the Live Activity without alert pushes", async () => {
    const { publisher, publish, cliSessions } = makeHarness();
    cliSessions.set("cli-1", { title: "claude in auth", toolType: "claude", chatSessionId: null });
    await publisher.start();

    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "cli-1", runtimeState: "running" });
    await vi.advanceTimersByTimeAsync(2_500);

    expect(publish).toHaveBeenCalledTimes(1);
    const first = publish.mock.calls[0][0];
    // Live Activity only — a CLI agent hits its prompt after every turn, so
    // waiting-input must never generate user-facing alert pushes. (A silent
    // badge-only item — no title — may ride along for icon-count sync.)
    expect((first.notifications ?? []).filter((n: { title: string }) => n.title)).toHaveLength(0);
    expect(first.liveActivity).toHaveLength(1);
    const startRun = first.liveActivity[0].contentState.runs.find((r: { id: string }) => r.id === "cli-1");
    expect(startRun.phase).toBe("running");
    expect(startRun.title).toBe("claude in auth");

    // Heartbeat re-fires of the same state must not churn LA updates.
    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "cli-1", runtimeState: "running" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish).toHaveBeenCalledTimes(1);

    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "cli-1", runtimeState: "waiting-input" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish).toHaveBeenCalledTimes(2);
    const second = publish.mock.calls[1][0];
    expect((second.notifications ?? []).filter((n: { title: string }) => n.title)).toHaveLength(0);
    // A CLI at its prompt is its resting state — it must not badge the icon.
    // Assert on the counting function directly (a badge-only item is only
    // emitted on count *changes*, so payload inspection here would be vacuous).
    expect(countAwaitingAttentionRuns([
      run({ sessionId: "cli-1", kind: "cli", phase: "waiting_for_input" }),
    ])).toBe(0);
    expect(countAwaitingAttentionRuns([
      run({ sessionId: "s-1", kind: "chat", phase: "waiting_for_input" }),
    ])).toBe(1);
    const waitingRun = second.liveActivity[0].contentState.runs.find((r: { id: string }) => r.id === "cli-1");
    expect(waitingRun.phase).toBe("stale");

    publisher.dispose();
  });

  it("publishes explicit CLI attention requests through the gated question path", async () => {
    const { publisher, publish } = makeHarness();
    await publisher.start();

    publisher.handleSessionAttentionRequested("scope-1", {
      sessionId: "cli-ask-1",
      kind: "cli",
      title: "Fix auth race",
      message: "Which account should the e2e test use?",
      laneId: "auth-lane",
    });
    await vi.advanceTimersByTimeAsync(200);

    const payload = publish.mock.calls[0][0];
    expect(payload.notifications[0]).toMatchObject({
      title: "Fix auth race needs you",
      body: "Which account should the e2e test use?",
      deepLink: "ade://session/cli-ask-1",
      sessionId: "cli-ask-1",
      dedupeKey: alertDedupeKey("alert:cli-ask-1:question"),
    });
    expect(payload.liveActivity[0].contentState.runs[0]).toMatchObject({
      id: "cli-ask-1",
      phase: "waiting_for_input",
      detail: "Which account should the e2e test use?",
    });

    publisher.handleCliRuntimeSignal("scope-1", {
      laneId: "auth-lane",
      sessionId: "cli-ask-1",
      runtimeState: "idle",
    });
    await vi.advanceTimersByTimeAsync(200);
    const heartbeatPayload = publish.mock.calls.at(-1)?.[0];
    expect(heartbeatPayload.liveActivity[0].contentState.runs[0]).toMatchObject({
      id: "cli-ask-1",
      phase: "waiting_for_input",
    });

    publisher.handleSessionAttentionResolved("scope-1", "cli-ask-1");
    await vi.advanceTimersByTimeAsync(200);
    const resolvedPayload = publish.mock.calls.at(-1)?.[0];
    expect(resolvedPayload.liveActivity[0].contentState.runs[0]).toMatchObject({
      id: "cli-ask-1",
      phase: "running",
    });

    publisher.dispose();
  });

  it("supersedes a pending approval when an explicit ask arrives for the same session", async () => {
    const { publisher, publish, emit } = makeHarness();
    await publisher.start();

    emit({
      sessionId: "s-ask-2",
      timestamp: "",
      event: { type: "approval_request", itemId: "approval-item-1", kind: "command", description: "Run tests" },
    });
    publisher.handleSessionAttentionRequested("scope-1", {
      sessionId: "s-ask-2",
      kind: "chat",
      title: "Migrate kvDb",
      message: "jwt or session auth?",
      laneId: "auth-lane",
    });
    await vi.advanceTimersByTimeAsync(200);

    const payload = publish.mock.calls.at(-1)?.[0];
    const alerts = (payload.notifications ?? []).filter(
      (n: { sessionId: string }) => n.sessionId === "s-ask-2",
    );
    // The stale approval alert must not ride along with the new question, and
    // the run must carry the question phase without the obsolete approval item.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      dedupeKey: alertDedupeKey("alert:s-ask-2:question"),
      body: "jwt or session auth?",
    });
    const askRun = payload.liveActivity[0].contentState.runs.find(
      (r: { id: string }) => r.id === "s-ask-2",
    );
    expect(askRun).toMatchObject({ phase: "waiting_for_input" });
    expect(askRun.itemId).toBeUndefined();

    publisher.dispose();
  });

  it("drops chat-owned shells and unknown sessions from CLI run tracking", async () => {
    const { publisher, publish, emit, cliSessions } = makeHarness();
    cliSessions.set("shell-1", { title: "attached shell", toolType: "shell", chatSessionId: "s-1" });
    await publisher.start();

    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "shell-1", runtimeState: "running" });
    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "ghost-1", runtimeState: "running" });
    await vi.advanceTimersByTimeAsync(2_500);

    // Both rows resolve to nothing user-facing → no alerts, no Live Activity
    // (the initial silent badge sync is the only thing allowed through).
    for (const call of publish.mock.calls) {
      expect((call[0].notifications ?? []).filter((n: { title: string }) => n.title)).toHaveLength(0);
      expect(call[0].liveActivity ?? []).toHaveLength(0);
    }

    // With a real chat run present, the publish payload must still exclude them.
    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "shell-1", runtimeState: "running" });
    emit(approval);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish).toHaveBeenCalled();
    const runs = publish.mock.calls.at(-1)![0].liveActivity[0].contentState.runs;
    expect(runs.map((r: { id: string }) => r.id)).toEqual(["s-1"]);

    publisher.dispose();
  });

  it("prunes a stale CLI row at the running TTL despite idle heartbeats", async () => {
    // Regression (Greptile P1): idle heartbeats used to refresh lastActiveAt,
    // so a quiet CLI's stale row never aged past the 2h TTL and pinned the
    // Live Activity open forever.
    const { publisher, publish, cliSessions } = makeHarness();
    cliSessions.set("cli-1", { title: "claude in auth", toolType: "claude", chatSessionId: null });
    await publisher.start();

    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "cli-1", runtimeState: "running" });
    await vi.advanceTimersByTimeAsync(2_500);
    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "cli-1", runtimeState: "idle" });
    await vi.advanceTimersByTimeAsync(2_500);

    // Re-fire idle heartbeats across 2h+; the frozen stale timestamp must let
    // the row age out, ending the (now-empty) aggregate.
    for (let i = 0; i < 5; i += 1) {
      publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "cli-1", runtimeState: "idle" });
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    }
    publisher.poke();
    await vi.advanceTimersByTimeAsync(2_500);

    const last = publish.mock.calls.at(-1)![0];
    const lastLa = last.liveActivity?.[0];
    expect(lastLa?.event).toBe("end");

    publisher.dispose();
  });

  it("publishes a quiet CLI as stale without ending the Live Activity", async () => {
    const { publisher, publish, cliSessions } = makeHarness();
    cliSessions.set("cli-1", { title: "claude in auth", toolType: "claude", chatSessionId: null });
    await publisher.start();

    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "cli-1", runtimeState: "running" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].liveActivity[0].event).toBe("start");

    // 12s-quiet idle → the row goes stale (not active) but the activity stays
    // open: ending on a quiet spell would churn end→push-to-start cycles.
    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "cli-1", runtimeState: "idle" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish).toHaveBeenCalledTimes(2);
    const idleItem = publish.mock.calls[1][0].liveActivity[0];
    expect(idleItem.event).toBe("update");
    expect(idleItem.contentState.activeCount).toBe(0);
    expect(idleItem.contentState.runs[0].phase).toBe("stale");

    // Output resumes → back to an active running row on the same activity.
    publisher.handleCliRuntimeSignal("scope-1", { laneId: "auth-lane", sessionId: "cli-1", runtimeState: "running" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish).toHaveBeenCalledTimes(3);
    const resumed = publish.mock.calls[2][0].liveActivity[0];
    expect(resumed.event).toBe("update");
    expect(resumed.contentState.runs[0].phase).toBe("running");

    publisher.dispose();
  });

  it("publishes an empty full Attention snapshot when the last contributing scope detaches", async () => {
    const { publisher, publishAttention, emit, detach } = makeHarness();
    publishAttention.mockResolvedValue({ ok: true, revision: 1 });
    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    expect(publishAttention.mock.calls[0]?.[0].items).toHaveLength(1);

    publishAttention.mockClear();
    detach();
    await vi.runAllTicks();
    await Promise.resolve();

    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(publishAttention).toHaveBeenCalledWith({
      machineName: "MacBook",
      fullSnapshot: true,
      items: [],
    });
    expect(vi.getTimerCount()).toBe(0);

    publisher.dispose();
  });

  it("removes terminal recent runs before the last scope's empty Attention snapshot", async () => {
    const { publisher, publishAttention, emit, detach } = makeHarness();
    publishAttention.mockResolvedValue({ ok: true, revision: 1 });
    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    emit({
      sessionId: "s-1",
      timestamp: "",
      event: { type: "status", turnStatus: "completed" },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publishAttention.mock.calls.at(-1)?.[0].items[0]).toMatchObject({
      phase: "completed",
    });

    publishAttention.mockClear();
    detach();
    await vi.runAllTicks();
    await Promise.resolve();

    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(publishAttention.mock.calls[0][0].items).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    publisher.dispose();
  });
});

describe("createPushRegistrationStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-store-"));
    filePath = path.join(dir, "secrets", "push-relay.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mints a stable 32-hex machineKey + 48-char secret on first access", () => {
    const store = createPushRegistrationStore({ filePath });
    const identity = store.getOrCreateIdentity();
    expect(identity.machineKey).toMatch(/^[0-9a-f]{32}$/);
    expect(identity.machineSecret).toHaveLength(48);
    // Stable across calls and reloads.
    expect(store.getOrCreateIdentity()).toEqual(identity);
    const reopened = createPushRegistrationStore({ filePath });
    expect(reopened.getOrCreateIdentity()).toEqual(identity);
  });

  it("does not count a device as registered until it has a deliverable token", () => {
    const store = createPushRegistrationStore({ filePath });
    store.upsertDevice({ deviceId: "dev-1", bundleId: "com.ade.ios", apsEnvironment: "sandbox" });
    expect(store.hasRegisteredDevices()).toBe(false);
    store.upsertDevice({ deviceId: "dev-1", bundleId: "com.ade.ios", apsEnvironment: "sandbox", apnsToken: "a".repeat(64) });
    expect(store.hasRegisteredDevices()).toBe(true);
  });

  it("preserves a previously reported token when only the other token re-registers", () => {
    const store = createPushRegistrationStore({ filePath });
    store.upsertDevice({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      apnsToken: "a".repeat(64),
    });
    store.upsertDevice({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      pushToStartToken: "b".repeat(64),
    });
    const device = store.getDevice("dev-1");
    expect(device?.apnsToken).toBe("a".repeat(64));
    expect(device?.pushToStartToken).toBe("b".repeat(64));

    store.upsertDevice({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
    });
    expect(store.getDevice("dev-1")?.pushToStartToken).toBe("b".repeat(64));

    store.upsertDevice({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      clearPushToStartToken: true,
    });
    expect(store.getDevice("dev-1")?.pushToStartToken).toBeNull();
    expect(store.getDevice("dev-1")?.apnsToken).toBe("a".repeat(64));
    expect(() => store.upsertDevice({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      pushToStartToken: "c".repeat(64),
      clearPushToStartToken: true,
    })).toThrow("Cannot set and clear pushToStartToken together.");
  });

  it("stores prefs and applies defaults", () => {
    const store = createPushRegistrationStore({ filePath });
    store.upsertDevice({ deviceId: "dev-1", bundleId: "com.ade.ios", apsEnvironment: "sandbox", apnsToken: "a".repeat(64) });
    expect(store.getDevice("dev-1")?.prefs).toEqual({
      enabled: true,
      liveActivitiesEnabled: true,
      mutedSessionIds: [],
      quietHours: null,
    });
    const updated = store.setPrefs("dev-1", {
      enabled: false,
      liveActivitiesEnabled: false,
      mutedSessionIds: ["s-1"],
      quietHours: { start: "22:00", end: "07:00", timezone: "America/New_York" },
    });
    expect(updated?.prefs.enabled).toBe(false);
    expect(updated?.prefs.mutedSessionIds).toEqual(["s-1"]);
    expect(store.setPrefs("missing", { enabled: true })).toBeNull();
  });

  it("removes devices and records publish results in the status snapshot", () => {
    const store = createPushRegistrationStore({ filePath });
    store.upsertDevice({ deviceId: "dev-1", bundleId: "com.ade.ios", apsEnvironment: "sandbox", apnsToken: "a".repeat(64) });
    store.setEnabled(false);
    store.recordPublishResult({ at: "2026-07-05T00:00:00.000Z", error: "boom" });
    let snapshot = store.getStatusSnapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.registeredDeviceCount).toBe(1);
    expect(snapshot.lastPublishError).toBe("boom");
    expect(snapshot.lastRelayContactAt).toBe("2026-07-05T00:00:00.000Z");

    store.recordPublishResult({ at: "2026-07-05T01:00:00.000Z" });
    snapshot = store.getStatusSnapshot();
    expect(snapshot.lastPublishError).toBeNull();

    store.removeDevice("dev-1");
    expect(store.getStatusSnapshot().registeredDeviceCount).toBe(0);
    expect(store.hasRegisteredDevices()).toBe(false);
  });

  it("tracks claim state idempotently", () => {
    const store = createPushRegistrationStore({ filePath });
    expect(store.isClaimed()).toBe(false);
    store.markClaimed();
    expect(store.isClaimed()).toBe(true);
    expect(createPushRegistrationStore({ filePath }).isClaimed()).toBe(true);
  });

  it("persists revision-fenced machine Attention acknowledgments across reloads", () => {
    const store = createPushRegistrationStore({ filePath });
    store.getOrCreateIdentity();
    store.recordAttentionAcknowledgments({
      items: [{ id: "agent:machine:session-1", revision: 7 }],
      accountOwnerId: "owner-a",
      seenAt: "2026-07-05T01:00:00.000Z",
      dismissedAt: "2026-07-05T01:01:00.000Z",
      updatedAt: "2026-07-05T01:01:00.000Z",
    });

    const reopened = createPushRegistrationStore({ filePath });
    expect(reopened.getAttentionAcknowledgment(
      "agent:machine:session-1",
      "owner-a",
    )).toMatchObject({
      sourceRevision: 7,
      accountOwnerId: "owner-a",
      seenAt: "2026-07-05T01:00:00.000Z",
      dismissedAt: "2026-07-05T01:01:00.000Z",
      pendingRelaySync: true,
    });
    expect(reopened.listPendingAttentionAcknowledgments()).toHaveLength(1);

    reopened.recordAttentionAcknowledgments({
      items: [{ id: "agent:machine:session-1", revision: 7 }],
      accountOwnerId: "owner-a",
      seenAt: "2026-07-05T01:02:00.000Z",
      updatedAt: "2026-07-05T01:02:00.000Z",
    });
    reopened.markAttentionAcknowledgmentsSynced([{
      itemId: "agent:machine:session-1",
      accountOwnerId: "owner-a",
      updatedAt: "2026-07-05T01:01:00.000Z",
    }]);
    expect(reopened.listPendingAttentionAcknowledgments()).toHaveLength(1);
    reopened.markAttentionAcknowledgmentsSynced([{
      itemId: "agent:machine:session-1",
      accountOwnerId: "owner-a",
      updatedAt: "2026-07-05T01:02:00.000Z",
    }]);
    expect(createPushRegistrationStore({ filePath }).listPendingAttentionAcknowledgments())
      .toEqual([]);
  });

  it("partitions durable Attention acknowledgments by account owner", () => {
    const store = createPushRegistrationStore({ filePath });
    store.getOrCreateIdentity();
    const item = { id: "agent:machine:shared-session", revision: 4 };
    store.recordAttentionAcknowledgments({
      items: [item],
      accountOwnerId: "owner-a",
      seenAt: "2026-07-05T01:00:00.000Z",
      updatedAt: "2026-07-05T01:00:00.000Z",
    });
    store.recordAttentionAcknowledgments({
      items: [item],
      accountOwnerId: "owner-b",
      seenAt: "2026-07-05T02:00:00.000Z",
      dismissedAt: "2026-07-05T02:00:00.000Z",
      updatedAt: "2026-07-05T02:00:00.000Z",
    });

    const reopened = createPushRegistrationStore({ filePath });
    expect(reopened.getAttentionAcknowledgment(item.id, "owner-a")).toMatchObject({
      seenAt: "2026-07-05T01:00:00.000Z",
      dismissedAt: null,
    });
    expect(reopened.getAttentionAcknowledgment(item.id, "owner-b")).toMatchObject({
      seenAt: "2026-07-05T02:00:00.000Z",
      dismissedAt: "2026-07-05T02:00:00.000Z",
    });
    expect(reopened.listPendingAttentionAcknowledgments()).toHaveLength(2);
  });
});

const MACHINE_KEY = "0123456789abcdef0123456789abcdef"; // gitleaks:allow — test fixture
const MACHINE_SECRET = "test-secret-abcdefghijklmnopqrstuvwxyz012345"; // gitleaks:allow — test fixture

/**
 * Independent re-implementation of the worker's canonical signing string
 * (apps/push-relay/src/relay.ts `buildSignatureBase` / `signPushRelayRequest`)
 * — the client's header must equal this for the relay to accept the call.
 */
function expectedSignature(secret: string, timestamp: string, method: string, pathname: string, body: string): string {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const base = `${timestamp}.${method.toUpperCase()}.${pathname}.${bodyHash}`;
  return `sha256=${createHmac("sha256", secret).update(base, "utf8").digest("hex")}`;
}

function makeStore(overrides: Partial<PushRegistrationStore> = {}): PushRegistrationStore {
  let claimed = false;
  return {
    getOrCreateIdentity: () => ({ machineKey: MACHINE_KEY, machineSecret: MACHINE_SECRET }),
    isClaimed: () => claimed,
    markClaimed: () => {
      claimed = true;
    },
    ...overrides,
  } as unknown as PushRegistrationStore;
}

const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never;

describe("createPushRelayClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("signs publish with the exact canonical string the relay verifies", async () => {
    const client = createPushRelayClient({ store: makeStore(), logger, baseUrl: "https://relay.test" });
    await client.publish({ notifications: [{ title: "hi", phase: "waiting" }] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://relay.test/machines/${MACHINE_KEY}/publish`);
    expect(init.method).toBe("POST");
    const timestamp = init.headers["x-ade-push-timestamp"];
    expect(timestamp).toBe(String(Math.floor(Date.parse("2026-07-05T00:00:00.000Z") / 1000)));
    const pathname = new URL(url).pathname;
    expect(init.headers["x-ade-push-signature"]).toBe(
      expectedSignature(MACHINE_SECRET, timestamp, "POST", pathname, init.body),
    );
  });

  it("signs the percent-encoded device path so it matches the wire pathname", async () => {
    const client = createPushRelayClient({ store: makeStore(), logger, baseUrl: "https://relay.test" });
    await client.registerDevice({ deviceId: "dev:99", bundleId: "com.ade.ios", apsEnvironment: "sandbox", apnsToken: "a".repeat(64) });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/devices/dev%3A99");
    const pathname = new URL(url).pathname;
    expect(init.headers["x-ade-push-signature"]).toBe(
      expectedSignature(MACHINE_SECRET, init.headers["x-ade-push-timestamp"], "PUT", pathname, init.body),
    );
  });

  it("forwards explicit push-to-start clears and rejects conflicting registration", async () => {
    const client = createPushRelayClient({ store: makeStore(), logger, baseUrl: "https://relay.test" });
    await client.registerDevice({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      clearPushToStartToken: true,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
    expect(body.clearPushToStartToken).toBe(true);
    expect(body.pushToStartToken).toBeUndefined();
    await expect(client.registerDevice({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      pushToStartToken: "b".repeat(64),
      clearPushToStartToken: true,
    })).rejects.toThrow("Cannot set and clear pushToStartToken together.");
  });

  it("claims idempotently and never signs the claim call", async () => {
    const store = makeStore();
    const client = createPushRelayClient({ store, logger, baseUrl: "https://relay.test" });
    await client.claim();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["x-ade-push-signature"]).toBeUndefined();
    expect(store.isClaimed()).toBe(true);

    // Second claim is a no-op once the store records it as claimed.
    await client.claim();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws with the relay error message on a non-2xx publish", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ ok: false, error: "APNs signing key is not configured on the relay" }),
    });
    const client = createPushRelayClient({ store: makeStore(), logger, baseUrl: "https://relay.test" });
    await expect(client.publish({ notifications: [{ title: "x", phase: "waiting" }] })).rejects.toThrow(
      /APNs signing key is not configured/,
    );
  });

  it("reports relay health without signing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, apnsConfigured: true }) });
    const client = createPushRelayClient({ store: makeStore(), logger, baseUrl: "https://relay.test" });
    const health = await client.health();
    expect(health).toEqual({ ok: true, apnsConfigured: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://relay.test/health");
    expect(init.headers["x-ade-push-signature"]).toBeUndefined();
  });

  it("matches the cross-app golden signature vector (must equal apps/push-relay's)", () => {
    // Pinned in BOTH apps (see apps/push-relay/test/relay.test.ts). If either
    // side's canonical string drifts, exactly one of the two tests breaks.
    const signature = expectedSignature(
      "ade-parity-secret-0123456789abcdef0123456789", // gitleaks:allow — golden test vector
      "1751712000",
      "POST",
      "/machines/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/publish",
      '{"notifications":[{"title":"parity","phase":"waiting"}]}',
    );
    expect(signature).toBe("sha256=5c5c3a3081a0c6bec96c4191a88ab17b59382b902c6071672ea6d8daa30764f3"); // gitleaks:allow
  });

  it("claims a fresh machine before publishing Attention with both authorizations", async () => {
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-access-token",
      getAccountUserId: () => "account-a",
    });
    await client.publishAttention({
      machineName: "MacBook",
      fullSnapshot: true,
      items: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [claimUrl, claimInit] = fetchMock.mock.calls[0];
    expect(claimUrl).toBe(`https://relay.test/machines/${MACHINE_KEY}/claim`);
    expect(claimInit.headers.authorization).toBeUndefined();
    expect(claimInit.headers["x-ade-push-signature"]).toBeUndefined();
    expect(JSON.parse(claimInit.body)).toEqual({ secret: MACHINE_SECRET });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`https://relay.test/machines/${MACHINE_KEY}/attention`);
    expect(init.headers.authorization).toBe("Bearer account-access-token");
    expect(init.headers["x-ade-push-signature"]).toBe(
      expectedSignature(
        MACHINE_SECRET,
        init.headers["x-ade-push-timestamp"],
        "POST",
        new URL(url).pathname,
        init.body,
      ),
    );
  });

  it("binds incremental snapshot cursors to the authenticated stream", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: 1,
        streamId: "account-a",
        revision: 12,
        generatedAt: "2026-07-05T00:00:00.000Z",
        items: [],
        tombstones: [],
        machines: [],
      }),
    });
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-access-token",
      getAccountUserId: () => "account-a",
    });
    await client.getAttentionSnapshot(12, "account-a");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://relay.test/attention/account/snapshot?since=12&streamId=account-a",
    );
    expect(init.headers.authorization).toBe("Bearer account-access-token");
  });

  it("retries one unauthorized account read with a forced fresh token", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error: "unauthorized" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          contractVersion: 1,
          streamId: "account-a",
          revision: 0,
          generatedAt: "2026-07-29T00:00:00.000Z",
          items: [],
          tombstones: [],
        }),
      });
    const getAccountAccessToken = vi.fn(
      async (options?: { forceRefresh?: boolean }) =>
        options?.forceRefresh ? "fresh-access-token" : "cached-access-token",
    );
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken,
      getAccountUserId: () => "account-a",
    });

    await expect(client.getAttentionSnapshot()).resolves.toMatchObject({
      streamId: "account-a",
    });

    expect(getAccountAccessToken).toHaveBeenNthCalledWith(1, undefined);
    expect(getAccountAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer cached-access-token");
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer fresh-access-token");
  });

  it("rejects an account snapshot response that resolves after the account changes", async () => {
    let currentAccountUserId: string | null = "account-a";
    let resolveResponse: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-a-access-token",
      getAccountUserId: () => currentAccountUserId,
    });

    const snapshot = client.getAttentionSnapshot();
    await Promise.resolve();
    currentAccountUserId = "account-b";
    resolveResponse(Response.json({
      contractVersion: 1,
      streamId: "account-a",
      revision: 1,
      generatedAt: "2026-07-29T00:00:00.000Z",
      items: [],
      tombstones: [],
    }));

    await expect(snapshot).rejects.toThrow(/account changed/i);
  });

  it("rejects a malformed successful Attention snapshot instead of trusting it", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, contractVersion: 1, items: "not-an-array" }),
    });
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-access-token",
      getAccountUserId: () => "account-a",
    });

    await expect(client.getAttentionSnapshot()).rejects.toThrow(
      /invalid Attention snapshot/i,
    );
  });

  it("does not retry an unauthorized account request after the account owner changes", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: "unauthorized" }),
    });
    let currentAccountUserId: string | null = "account-a";
    const getAccountAccessToken = vi.fn(
      async (options?: { forceRefresh?: boolean }) => {
        if (options?.forceRefresh) currentAccountUserId = "account-b";
        return options?.forceRefresh ? "account-b-access-token" : "account-a-access-token";
      },
    );
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken,
      getAccountUserId: () => currentAccountUserId,
    });

    await expect(
      client.getAttentionPreferences("account-a"),
    ).rejects.toThrow(/account changed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not authorize an account-A preference write with account B's refreshed token", async () => {
    let currentAccountUserId: string | null = "account-a";
    let resolveToken: (token: string | null) => void = () => {};
    const tokenPromise = new Promise<string | null>((resolve) => {
      resolveToken = resolve;
    });
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: () => tokenPromise,
      getAccountUserId: () => currentAccountUserId,
    });

    const write = client.putAttentionPreferences(
      "account-a",
      DEFAULT_ATTENTION_PREFERENCES,
    );
    await Promise.resolve();
    currentAccountUserId = "account-b";
    resolveToken("account-b-access-token");

    await expect(write).rejects.toThrow(/account changed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not publish account-A work with account B's token after an account switch", async () => {
    let currentAccountUserId: string | null = "account-a";
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => {
        currentAccountUserId = "account-b";
        return "account-b-access-token";
      },
      getAccountUserId: () => currentAccountUserId,
    });

    await expect(client.publishAttention({
      machineName: "MacBook",
      fullSnapshot: true,
      items: [],
    })).rejects.toThrow(/account changed/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://relay.test/machines/${MACHINE_KEY}/claim`,
    );
  });
});
