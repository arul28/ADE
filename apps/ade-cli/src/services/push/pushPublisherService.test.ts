import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ATTENTION_PREFERENCES } from "../../../../desktop/src/shared/types/attention";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import type { SyncRosterProject } from "../../../../desktop/src/shared/types/sync";
import type {
  PushDeviceRegistration,
  PushQuietHours,
} from "../../../../desktop/src/shared/types/push";
import {
  createPushRegistrationStore,
  type PushRegistrationStore,
  type StoredAttentionAcknowledgment,
  type StoredRemoteAttentionAcknowledgment,
} from "./pushRegistrationStore";
import {
  createPushRelayClient,
  PushRelayMachineRevokedError,
} from "./pushRelayClient";
import {
  activityAlertFingerprint,
  activityContentFingerprint,
} from "./activityFingerprint";
import { deriveProjectId } from "../projects/projectRegistry";
import {
  buildAgentRunsContentState,
  countAwaitingAttentionRuns,
  createPushPublisherService,
  isWithinQuietHours,
  parseHhMm,
  shouldDeliverAlertForPrefs,
} from "./pushPublisherService";
import type { AgentRunState, PushPrNotification } from "./attentionItemBuilder";

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
    statusSinceAt: 0,
    metaResolved: true,
    backgroundTaskIds: new Set<string>(),
    deferredTerminalPhase: null,
    chatActivityMode: null,
    chatActivityModeCheckedAt: 0,
    ...overrides,
  };
}

function rosterProject(count: number, lastActivityAt = "2026-08-01T12:00:00.000Z"): SyncRosterProject {
  return {
    projectId: "roster-project",
    rootPath: "/projects/roster",
    displayName: "Roster project",
    booted: false,
    runningCount: 0,
    attentionCount: 0,
    lanes: [{ id: "lane-roster", name: "Roster lane" }],
    chats: Array.from({ length: count }, (_, index) => ({
      id: `disk-session-${String(index).padStart(3, "0")}`,
      laneId: "lane-roster",
      title: `Disk session ${index}`,
      provider: "codex",
      model: "gpt-5",
      toolType: "codex-chat",
      status: "idle" as const,
      lastActivityAt,
      preview: `Processed ${index} files in 12s`,
    })),
  };
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
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
    options: {
      activityProtocol?: number | null;
      activityRosterProvider?: { buildSnapshot(): Promise<SyncRosterProject[]> } | null;
      lastPublishedRevisionById?: Record<string, number>;
      remoteAttentionAcknowledgments?: StoredRemoteAttentionAcknowledgment[];
      machineRevokedAt?: string | null;
    } = {},
  ) {
    const publish = vi.fn().mockResolvedValue({ ok: true });
    const publishAttention = vi.fn().mockResolvedValue(null);
    const acknowledgeAttention = vi.fn().mockResolvedValue(null);
    let accountOwnerId: string | null = "owner-a";
    const devices = Array.isArray(deviceOverride) ? [...deviceOverride] : [deviceOverride];
    const attentionAcknowledgments = new Map<string, StoredAttentionAcknowledgment>();
    const remoteAttentionAcknowledgments = new Map<string, StoredRemoteAttentionAcknowledgment>();
    for (const acknowledgment of options.remoteAttentionAcknowledgments ?? []) {
      remoteAttentionAcknowledgments.set(
        `${acknowledgment.accountOwnerId ?? ""}\u0000${acknowledgment.itemId}`,
        acknowledgment,
      );
    }
    let activityProtocol = options.activityProtocol ?? null;
    let activityRosterEpoch = 0;
    let lastPublishedActivityRevisions = {
      accountOwnerId: "owner-a" as string | null,
      revisions: { ...(options.lastPublishedRevisionById ?? {}) },
    };
    const attentionAcknowledgmentKey = (
      accountOwnerId: string | null,
      itemId: string,
    ) => `${accountOwnerId ?? ""}\u0000${itemId}`;
    let machineRevokedAt: string | null = options.machineRevokedAt ?? null;
    const store = {
      hasRegisteredDevices: () => true,
      getOrCreateIdentity: () => ({ machineKey: "a".repeat(40), machineSecret: "secret" }),
      getStatusSnapshot: () => ({
        enabled: true,
        claimed: true,
        registeredDeviceCount: devices.length,
        lastPublishAt: null,
        lastPublishError: null,
        lastRelayContactAt: null,
        identityRecoveryError: null,
        previousMachineKeys: [] as string[],
        machineRevokedAt,
      }),
      isMachineRevoked: () => machineRevokedAt != null,
      recordMachineRevoked: (revokedAt?: string | null) => {
        if (machineRevokedAt) return;
        machineRevokedAt = revokedAt ?? new Date().toISOString();
      },
      clearMachineRevoked: () => {
        machineRevokedAt = null;
      },
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
      recordRemoteAttentionAcknowledgments: (args: {
        accountOwnerId: string | null;
        acknowledgments: Array<{
          itemId: string;
          sourceRevision: number;
          seenAt: string | null;
          dismissedAt: string | null;
        }>;
        updatedAt: string;
      }) => {
        for (const acknowledgment of args.acknowledgments) {
          const key = attentionAcknowledgmentKey(args.accountOwnerId, acknowledgment.itemId);
          remoteAttentionAcknowledgments.set(key, {
            ...acknowledgment,
            accountOwnerId: args.accountOwnerId,
            updatedAt: args.updatedAt,
          });
        }
      },
      listRemoteAttentionAcknowledgments: (ownerId?: string | null) =>
        [...remoteAttentionAcknowledgments.values()].filter((acknowledgment) =>
          ownerId === undefined || acknowledgment.accountOwnerId === ownerId),
      getActivityProtocol: () => activityProtocol,
      setActivityProtocol: (protocol: number | null) => {
        activityProtocol = protocol;
      },
      nextActivityRosterEpoch: vi.fn(() => {
        activityRosterEpoch += 1;
        return activityRosterEpoch;
      }),
      getLastPublishedActivityRevisions: () => ({
        accountOwnerId: lastPublishedActivityRevisions.accountOwnerId,
        revisions: { ...lastPublishedActivityRevisions.revisions },
      }),
      setLastPublishedActivityRevisions: (value: {
        accountOwnerId: string | null;
        revisions: Record<string, number>;
      }) => {
        lastPublishedActivityRevisions = {
          accountOwnerId: value.accountOwnerId,
          revisions: { ...value.revisions },
        };
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
    const publisherLogger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    const publisher = createPushPublisherService({
      logger: publisherLogger as never,
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
      activityRosterProvider: options.activityRosterProvider,
    });
    const cliSessions = new Map<string, {
      title: string | null;
      toolType?: string | null;
      chatSessionId?: string | null;
      status?: string | null;
      runtimeState?: string | null;
      settledAt?: string | null;
      settleOverride?: "settled" | "active" | null;
    }>();
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
      agentChatService,
      attentionAcknowledgments,
      remoteAttentionAcknowledgments,
      publisherLogger,
      getLastPublishedActivityRevisions: () => ({
        accountOwnerId: lastPublishedActivityRevisions.accountOwnerId,
        revisions: { ...lastPublishedActivityRevisions.revisions },
      }),
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

  it("keeps machine Attention acknowledgments durable and owner-fenced", async () => {
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
    // A stale source revision no longer rejects: seen/dismissed are monotonic
    // and idempotent, so the fence only ever manufactured failures on live
    // items (the row a running agent republishes every couple of seconds).
    await expect(publisher.acknowledgeMachineAttention({
      itemIds: [item.id],
      sourceRevisions: { [item.id]: item.revision },
      expectedAccountOwnerId: "owner-a",
    })).resolves.toEqual({ acknowledged: [item.id], skipped: [] });
    // The durable record still moves forward to the newest revision seen.
    expect(getAttentionAcknowledgment(item.id, "owner-a")?.sourceRevision)
      .toBe(updated.revision);

    // An id outside this machine's snapshot is skipped, not fatal — one unknown
    // id in a bulk "Clear all" must not reject the whole batch.
    await expect(publisher.acknowledgeMachineAttention({
      itemIds: ["agent:other-machine:unknown"],
      sourceRevisions: { "agent:other-machine:unknown": 1 },
      expectedAccountOwnerId: "owner-a",
    })).resolves.toEqual({ acknowledged: [], skipped: ["agent:other-machine:unknown"] });

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
    emit(approval);
    const item = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    acknowledgeAttention.mockResolvedValue({ applied: [item.id], stale: [] });

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
      sourceRevisions: { [item.id]: item.revision },
      seenAt: "2026-07-05T12:00:01.000Z",
      expectedAccountOwnerId: "owner-a",
    });
    expect(getAttentionAcknowledgment(item.id, "owner-a")?.pendingRelaySync).toBe(false);
    publisher.dispose();
  });

  it("keeps relay-stale machine acknowledgments pending with their source fence", async () => {
    const {
      publisher,
      emit,
      publishAttention,
      acknowledgeAttention,
      getAttentionAcknowledgment,
    } = makeHarness(device, undefined, { activityProtocol: 2 });
    emit(approval);
    const item = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    const refreshedRevision = item.revision + 1;
    publishAttention.mockResolvedValue({
      ok: true,
      protocol: 2,
      revision: 1,
      acks: [{
        itemId: item.id,
        sourceRevision: refreshedRevision,
        seenAt: null,
        dismissedAt: null,
      }],
    });
    acknowledgeAttention
      .mockResolvedValueOnce({ applied: [], stale: [item.id] })
      .mockResolvedValueOnce({ applied: [item.id], stale: [] });

    await publisher.acknowledgeMachineAttention({
      itemIds: [item.id],
      sourceRevisions: { [item.id]: item.revision },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-05T12:00:01.000Z",
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(acknowledgeAttention).toHaveBeenCalledWith(expect.objectContaining({
      itemIds: [item.id],
      sourceRevisions: { [item.id]: item.revision },
    }));
    expect(getAttentionAcknowledgment(item.id, "owner-a")?.pendingRelaySync).toBe(true);
    expect(publishAttention).toHaveBeenCalledTimes(1);

    publisher.poke();
    await vi.advanceTimersByTimeAsync(200);

    expect(acknowledgeAttention).toHaveBeenCalledTimes(2);
    expect(acknowledgeAttention.mock.calls[1]?.[0].sourceRevisions)
      .toEqual({ [item.id]: refreshedRevision });
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
      return { applied: [first.id], stale: [] };
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

  it("does not republish when only the source revision advances", async () => {
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

    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);

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

  it("coalesces 50 running-agent events into exactly one protocol-2 publish", async () => {
    const { publisher, publishAttention, emit } = makeHarness(
      device,
      undefined,
      { activityProtocol: 2 },
    );
    publishAttention.mockResolvedValue({ ok: true, protocol: 2, revision: 1, acks: [] });

    for (let index = 0; index < 50; index += 1) {
      emit({
        sessionId: "s-running",
        timestamp: new Date().toISOString(),
        event: { type: "text", text: `stream chunk ${index}` },
      });
    }
    await vi.advanceTimersByTimeAsync(2_500);

    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(publishAttention.mock.calls[0][0]).toMatchObject({
      mode: "reconcile",
      page: 0,
      final: true,
      items: [expect.objectContaining({ phase: "running", activityTier: "ambient" })],
    });
    publisher.dispose();
  });

  it("publishes changed items and dropped ids as an explicit delta", async () => {
    const { publisher, publishAttention, emit } = makeHarness(
      device,
      undefined,
      { activityProtocol: 2 },
    );
    publishAttention.mockResolvedValue({ ok: true, protocol: 2, revision: 1, acks: [] });
    emit({
      sessionId: "s-running",
      timestamp: "",
      event: { type: "text", text: "working" },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    publishAttention.mockClear();

    publisher._debug.onPtyExit("scope-1", {
      ptyId: "pty-s-running",
      sessionId: "s-running",
      laneId: "auth-lane",
      exitCode: 130,
    });
    await vi.advanceTimersByTimeAsync(2_500);

    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(publishAttention.mock.calls[0][0]).toMatchObject({
      mode: "delta",
      items: [],
      tombstones: [expect.objectContaining({
        id: `agent:${"a".repeat(40)}:s-running`,
        deletedAt: expect.any(String),
      })],
    });
    publisher.dispose();
  });

  it("pages a 200-session roster reconcile under the item and body caps", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([rosterProject(200)]);
    const { publisher, publishAttention } = makeHarness(
      device,
      undefined,
      {
        activityProtocol: 2,
        activityRosterProvider: { buildSnapshot },
      },
    );
    publishAttention.mockResolvedValue({ ok: true, protocol: 2, revision: 1, acks: [] });

    await publisher.start();
    await vi.advanceTimersByTimeAsync(200);

    expect(buildSnapshot).toHaveBeenCalledTimes(1);
    expect(publishAttention).toHaveBeenCalledTimes(5);
    const payloads = publishAttention.mock.calls.map(([payload]) => payload);
    expect(payloads.every((payload) => payload.mode === "reconcile")).toBe(true);
    expect(payloads.every((payload) => payload.items.length <= 48)).toBe(true);
    expect(payloads.every((payload) => payload.tombstones.length <= 48)).toBe(true);
    expect(payloads.slice(0, -1).every((payload) => payload.final === false)).toBe(true);
    expect(payloads.at(-1)?.final).toBe(true);
    expect(payloads.flatMap((payload) => payload.items)).toHaveLength(200);
    expect(
      payloads.every((payload) => Buffer.byteLength(JSON.stringify(payload), "utf8") < 256 * 1024),
    ).toBe(true);
    publisher.dispose();
  });

  it("shrinks the roster cap by ten percent when the relay truncates items", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([rosterProject(300)]);
    const { publisher, publishAttention } = makeHarness(
      device,
      undefined,
      {
        activityProtocol: 2,
        activityRosterProvider: { buildSnapshot },
      },
    );
    publishAttention.mockImplementation(async () => ({
      ok: true,
      protocol: 2,
      revision: 1,
      acks: [],
      itemsTruncated: publishAttention.mock.calls.length === 1,
    }));

    await publisher.start();
    await vi.advanceTimersByTimeAsync(200);
    const snapshot = await publisher.getMachineAttentionSnapshot();

    expect(snapshot.items).toHaveLength(270);
    publisher.dispose();
  });

  it("never ratchets the roster cap below 100 and resets it for a new publisher", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([rosterProject(300)]);
    const first = makeHarness(device, undefined, {
      activityProtocol: 2,
      activityRosterProvider: { buildSnapshot },
    });
    first.publishAttention.mockResolvedValue({
      ok: true,
      protocol: 2,
      revision: 1,
      acks: [],
      itemsTruncated: true,
    });
    await first.publisher.start();
    for (let index = 0; index < 15; index += 1) {
      await vi.advanceTimersByTimeAsync(200);
      first.publisher.poke();
    }
    await vi.advanceTimersByTimeAsync(200);
    expect((await first.publisher.getMachineAttentionSnapshot()).items).toHaveLength(100);
    first.publisher.dispose();

    const restarted = makeHarness(device, undefined, {
      activityProtocol: 2,
      activityRosterProvider: { buildSnapshot },
    });
    expect((await restarted.publisher.getMachineAttentionSnapshot()).items).toHaveLength(300);
    restarted.publisher.dispose();
  });

  it("explicitly tombstones roster overflow", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([rosterProject(301)]);
    const { publisher, publishAttention } = makeHarness(
      device,
      undefined,
      {
        activityProtocol: 2,
        activityRosterProvider: { buildSnapshot },
      },
    );
    publishAttention.mockResolvedValue({ ok: true, protocol: 2, revision: 1, acks: [] });

    await publisher.start();
    await vi.advanceTimersByTimeAsync(200);

    const payloads = publishAttention.mock.calls.map(([payload]) => payload);
    expect(payloads.flatMap((payload) => payload.items)).toHaveLength(300);
    expect(payloads.flatMap((payload) => payload.tombstones)).toEqual([
      expect.objectContaining({
        id: `agent:${"a".repeat(40)}:disk-session-300`,
        deletedAt: expect.any(String),
      }),
    ]);
    publisher.dispose();
  });

  it("publishes an empty presence heartbeat without rebuilding the roster", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([rosterProject(1)]);
    const { publisher, publishAttention, emit } = makeHarness(
      device,
      undefined,
      {
        activityProtocol: 2,
        activityRosterProvider: { buildSnapshot },
      },
    );
    publishAttention.mockResolvedValue({ ok: true, protocol: 2, revision: 1, acks: [] });
    emit({
      sessionId: "s-running",
      timestamp: "",
      event: { type: "text", text: "working" },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(buildSnapshot).toHaveBeenCalledTimes(1);
    publishAttention.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(publishAttention).toHaveBeenCalledWith({
      machineName: "MacBook",
      mode: "presence",
      rosterEpoch: 1,
      items: [],
      tombstones: [],
    });
    expect(buildSnapshot).toHaveBeenCalledTimes(1);
    publisher.dispose();
  });

  it("skips roster rebuilds and durable epochs while signed out", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([rosterProject(1)]);
    const {
      publisher,
      publishAttention,
      setAccountOwnerId,
      store,
    } = makeHarness(device, undefined, {
      activityProtocol: 2,
      activityRosterProvider: { buildSnapshot },
    });
    setAccountOwnerId(null);

    await publisher.start();
    await vi.advanceTimersByTimeAsync(90_000);

    expect(publishAttention).not.toHaveBeenCalled();
    expect(buildSnapshot).not.toHaveBeenCalled();
    expect(store.nextActivityRosterEpoch).not.toHaveBeenCalled();
    publisher.dispose();
  });

  it("treats a null Activity publish response as unavailable", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([rosterProject(1)]);
    const {
      publisher,
      publishAttention,
      publisherLogger,
      store,
    } = makeHarness(device, undefined, {
      activityProtocol: 2,
      activityRosterProvider: { buildSnapshot },
    });
    publishAttention.mockResolvedValue(null);

    await publisher.start();
    await vi.advanceTimersByTimeAsync(200);

    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(store.nextActivityRosterEpoch).toHaveBeenCalledTimes(1);
    expect(publisherLogger.warn).not.toHaveBeenCalledWith(
      "attention.publish_failed",
      expect.anything(),
    );
    publisher.dispose();
  });

  it("persists remote dismissal acknowledgments and downgrades signal items", async () => {
    const { publisher, publishAttention, emit } = makeHarness(
      device,
      undefined,
      { activityProtocol: 2 },
    );
    publishAttention.mockImplementation(async (payload) => ({
      ok: true,
      protocol: 2,
      revision: 1,
      acks: payload.items.map((item: { id: string; revision: number }) => ({
        itemId: item.id,
        seenAt: "2026-07-05T12:00:01.000Z",
        dismissedAt: "2026-07-05T12:00:02.000Z",
        sourceRevision: item.revision,
      })),
    }));

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);
    const item = (await publisher.getMachineAttentionSnapshot()).items[0]!;

    expect(item).toMatchObject({
      phase: "needs_you",
      activityTier: "ambient",
      seenAt: "2026-07-05T12:00:01.000Z",
      dismissedAt: "2026-07-05T12:00:02.000Z",
    });
    publishAttention.mockClear();
    publisher.poke();
    await vi.advanceTimersByTimeAsync(200);
    expect(publishAttention.mock.calls[0][0]).toMatchObject({
      mode: "delta",
      items: [expect.objectContaining({
        id: item.id,
        activityTier: "ambient",
        dismissedAt: "2026-07-05T12:00:02.000Z",
      })],
    });
    publisher.dispose();
  });

  it("falls back to a live-only full snapshot when protocol is absent", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([rosterProject(3)]);
    const { publisher, publishAttention, emit } = makeHarness(
      device,
      undefined,
      { activityRosterProvider: { buildSnapshot } },
    );
    publishAttention.mockResolvedValue({ ok: true, revision: 1 });
    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(publishAttention.mock.calls[0][0]).toMatchObject({
      machineName: "MacBook",
      fullSnapshot: true,
      items: [expect.objectContaining({ id: `agent:${"a".repeat(40)}:s-1` })],
    });
    expect(publishAttention.mock.calls[0][0].mode).toBeUndefined();
    expect(buildSnapshot).not.toHaveBeenCalled();
    publisher.dispose();
  });

  it("keeps idle roster revisions stable across uncached rebuilds", async () => {
    let clock = Date.parse("2026-08-01T12:00:00.000Z");
    const buildSnapshot = vi.fn().mockResolvedValue([
      rosterProject(1, "2026-07-01T09:30:00.000Z"),
    ]);
    const { publisher } = makeHarness(
      device,
      () => clock,
      {
        activityProtocol: 2,
        activityRosterProvider: { buildSnapshot },
      },
    );

    const first = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    clock += 11_000;
    const second = (await publisher.getMachineAttentionSnapshot()).items[0]!;

    expect(buildSnapshot).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({
      activityTier: "idle",
      phase: "stale",
      // Long but finite: an idle row whose machine never comes back must still
      // age out of the account feed on its own.
      expiresAt: "2026-07-08T09:30:00.000Z",
      statusSince: "2026-07-01T09:30:00.000Z",
    });
    expect(second.revision).toBe(first.revision);
    expect(second.revision).toBe(Date.parse("2026-07-01T09:30:00.000Z"));
    publisher.dispose();
  });

  it("keeps roster alert identity stable when activity advances within one status", async () => {
    let clock = Date.parse("2026-08-01T12:00:00.000Z");
    const roster = rosterProject(1, "2026-08-01T11:59:00.000Z");
    roster.chats[0]!.status = "awaiting";
    const buildSnapshot = vi.fn(async () => [roster]);
    const { publisher } = makeHarness(device, () => clock, {
      activityProtocol: 2,
      activityRosterProvider: { buildSnapshot },
    });

    const first = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    roster.chats[0]!.lastActivityAt = "2026-08-01T12:00:05.000Z";
    clock += 11_000;
    const second = (await publisher.getMachineAttentionSnapshot()).items[0]!;

    expect(buildSnapshot).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ phase: "needs_you", activityTier: "signal" });
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(second.statusSince).toBe(first.statusSince);
    expect(second.alertFingerprint).toBe(first.alertFingerprint);
    publisher.dispose();
  });

  it("changes roster statusSince whenever a chat re-enters a status", async () => {
    let clock = Date.parse("2026-08-01T12:00:00.000Z");
    const roster = rosterProject(1, "2026-08-01T11:59:00.000Z");
    roster.chats[0]!.status = "awaiting";
    const buildSnapshot = vi.fn(async () => [roster]);
    const { publisher } = makeHarness(device, () => clock, {
      activityProtocol: 2,
      activityRosterProvider: { buildSnapshot },
    });

    const awaiting = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    roster.chats[0]!.status = "running";
    clock += 11_000;
    const running = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    roster.chats[0]!.status = "awaiting";
    clock += 11_000;
    const awaitingAgain = (await publisher.getMachineAttentionSnapshot()).items[0]!;

    expect([awaiting.phase, running.phase, awaitingAgain.phase])
      .toEqual(["needs_you", "running", "needs_you"]);
    expect(Date.parse(running.statusSince!)).toBeGreaterThan(Date.parse(awaiting.statusSince!));
    expect(Date.parse(awaitingAgain.statusSince!)).toBeGreaterThan(Date.parse(running.statusSince!));
    expect(awaitingAgain.alertFingerprint).not.toBe(awaiting.alertFingerprint);
    publisher.dispose();
  });

  it("anchors invalid roster activity dates once across uncached rebuilds", async () => {
    let rebuildAt = Date.parse("2026-08-01T12:00:00.000Z");
    const buildSnapshot = vi.fn().mockResolvedValue([
      rosterProject(2, "not-an-iso-date"),
    ]);
    const { publisher } = makeHarness(
      device,
      () => rebuildAt,
      {
        activityProtocol: 2,
        activityRosterProvider: { buildSnapshot },
      },
    );

    const first = (await publisher.getMachineAttentionSnapshot()).items;
    rebuildAt += 11_000;
    const second = (await publisher.getMachineAttentionSnapshot()).items;

    expect(first).toHaveLength(2);
    expect(first.map((entry) => entry.revision))
      .toEqual([rebuildAt - 11_000, rebuildAt - 11_000]);
    expect(first.map((entry) => entry.updatedAt))
      .toEqual(["2026-08-01T12:00:00.000Z", "2026-08-01T12:00:00.000Z"]);
    expect(second.map((entry) => entry.revision)).toEqual([rebuildAt, rebuildAt]);
    expect(second.map((entry) => entry.statusSince))
      .toEqual(first.map((entry) => entry.statusSince));
    expect(second.map((entry) => entry.alertFingerprint))
      .toEqual(first.map((entry) => entry.alertFingerprint));
    publisher.dispose();
  });

  it("keeps live-to-roster source revisions monotonic", async () => {
    const roster = rosterProject(1, "2026-07-01T09:30:00.000Z");
    roster.chats[0]!.id = "live-to-roster";
    const { publisher, publishAttention, cliSessions } = makeHarness(
      device,
      undefined,
      {
        activityProtocol: 2,
        activityRosterProvider: { buildSnapshot: async () => [roster] },
      },
    );
    publishAttention.mockResolvedValue({
      ok: true,
      protocol: 2,
      revision: 1,
      acks: [],
    });
    cliSessions.set("live-to-roster", {
      title: "Live session",
      toolType: "codex",
      chatSessionId: null,
    });
    publisher.handleCliRuntimeSignal("scope-1", {
      laneId: "lane-roster",
      sessionId: "live-to-roster",
      runtimeState: "running",
    });
    await vi.advanceTimersByTimeAsync(2_500);
    const live = publishAttention.mock.calls[0][0].items[0];
    publishAttention.mockClear();

    publisher._debug.onPtyExit("scope-1", {
      ptyId: "pty-live-to-roster",
      sessionId: "live-to-roster",
      laneId: "lane-roster",
      exitCode: 130,
    });
    await vi.advanceTimersByTimeAsync(2_500);

    const rosterPayload = publishAttention.mock.calls[0][0];
    expect(rosterPayload.tombstones).toEqual([]);
    expect(rosterPayload.items[0]).toMatchObject({
      id: live.id,
      phase: "stale",
      revision: live.revision,
    });
    expect(rosterPayload.items[0].revision)
      .toBeGreaterThan(Date.parse("2026-07-01T09:30:00.000Z"));
    publisher.dispose();
  });

  it("clamps rebuilt roster rows to persisted and remote source revisions", async () => {
    const itemId = `agent:${"a".repeat(40)}:disk-session-000`;
    const persistedFloor = Date.parse("2026-07-06T00:00:00.000Z");
    const remoteFloor = persistedFloor + 1;
    const { publisher } = makeHarness(device, undefined, {
      activityProtocol: 2,
      activityRosterProvider: {
        buildSnapshot: async () => [rosterProject(1, "2026-07-01T00:00:00.000Z")],
      },
      lastPublishedRevisionById: { [itemId]: persistedFloor },
      remoteAttentionAcknowledgments: [{
        itemId,
        accountOwnerId: "owner-a",
        sourceRevision: remoteFloor,
        seenAt: null,
        dismissedAt: null,
        updatedAt: "2026-07-06T00:00:01.000Z",
      }],
    });

    const item = (await publisher.getMachineAttentionSnapshot()).items[0]!;

    expect(item.id).toBe(itemId);
    expect(item.revision).toBe(remoteFloor);
    expect(item.updatedAt).toBe("2026-07-01T00:00:00.000Z");
    publisher.dispose();
  });

  it("keeps live statusSince immutable while the phase is unchanged", async () => {
    const { publisher, emit } = makeHarness(
      device,
      undefined,
      { activityProtocol: 2 },
    );
    emit({
      sessionId: "s-running",
      timestamp: "",
      event: { type: "text", text: "first" },
    });
    const first = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    vi.setSystemTime(new Date("2026-07-05T12:00:05.000Z"));
    emit({
      sessionId: "s-running",
      timestamp: "",
      event: { type: "text", text: "second" },
    });
    const second = (await publisher.getMachineAttentionSnapshot()).items[0]!;

    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.statusSince).toBe(first.statusSince);
    publisher.dispose();
  });

  it("publishes a second item-less question after needs-you phase re-entry", async () => {
    const { publisher, publishAttention } = makeHarness(
      device,
      undefined,
      { activityProtocol: 2 },
    );
    publishAttention.mockResolvedValue({
      ok: true,
      protocol: 2,
      revision: 1,
      acks: [],
    });

    publisher.handleSessionAttentionRequested("scope-1", {
      sessionId: "question-reentry",
      kind: "chat",
      title: "Choose rollout",
      message: "Which rollout should I use?",
      laneId: "auth-lane",
    });
    await vi.advanceTimersByTimeAsync(200);
    publisher.handleSessionAttentionResolved("scope-1", "question-reentry");
    await vi.advanceTimersByTimeAsync(200);
    publisher.handleSessionAttentionRequested("scope-1", {
      sessionId: "question-reentry",
      kind: "chat",
      title: "Choose rollout",
      message: "Which rollout should I use?",
      laneId: "auth-lane",
    });
    await vi.advanceTimersByTimeAsync(200);

    const needsYouItems = publishAttention.mock.calls
      .flatMap(([payload]) => payload.items)
      .filter((entry: { phase: string }) => entry.phase === "needs_you");
    expect(needsYouItems).toHaveLength(2);
    expect(needsYouItems.map((entry) => entry.destination.itemId)).toEqual([null, null]);
    expect(needsYouItems[1].statusSince).not.toBe(needsYouItems[0].statusSince);
    expect(needsYouItems[1].alertFingerprint).not.toBe(needsYouItems[0].alertFingerprint);
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

  it("retires a user-stopped CLI run without publishing a failure", async () => {
    const { publisher, publish, cliSessions } = makeHarness();
    cliSessions.set("cli-stopped", {
      title: "codex in work",
      toolType: "codex",
      chatSessionId: null,
    });
    await publisher.start();

    publisher.handleCliRuntimeSignal("scope-1", {
      laneId: "work",
      sessionId: "cli-stopped",
      runtimeState: "running",
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publisher._debug.runs.get("cli-stopped")?.phase).toBe("running");

    publisher._debug.onPtyExit("scope-1", {
      sessionId: "cli-stopped",
      ptyId: "pty-stopped",
      laneId: "work",
      exitCode: 143,
    });
    await vi.advanceTimersByTimeAsync(2_500);

    expect(publisher._debug.runs.has("cli-stopped")).toBe(false);
    const lastPayload = publish.mock.calls.at(-1)?.[0];
    expect(lastPayload.liveActivity?.[0]?.contentState?.runs ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cli-stopped", phase: "failed" }),
      ]),
    );
    expect((lastPayload.notifications ?? []).filter(
      (item: { title?: string }) => item.title === "CLI session ended",
    )).toHaveLength(0);

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
    expect(publisher._debug.getPendingAlerts()).toEqual([]);
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

  it("terminates a waiting CLI run when dismiss-and-settle resolves attention", async () => {
    const { publisher, cliSessions } = makeHarness();
    await publisher.start();

    publisher.handleSessionAttentionRequested("scope-1", {
      sessionId: "cli-settle-1",
      kind: "cli",
      title: "Fix auth race",
      message: "Choose an account",
      laneId: "auth-lane",
    });
    publisher.handleSessionSettled("scope-1", "cli-settle-1");

    expect(publisher._debug.getPendingAlerts()).toEqual([]);
    expect(publisher._debug.runs.has("cli-settle-1")).toBe(false);

    cliSessions.set("cli-settle-1", {
      title: "Fix auth race",
      toolType: "codex",
      status: "running",
      settledAt: "2026-07-29T22:00:00.000Z",
    });
    publisher.handleCliRuntimeSignal("scope-1", {
      laneId: "auth-lane",
      sessionId: "cli-settle-1",
      runtimeState: "running",
    });
    expect(publisher._debug.runs.get("cli-settle-1")?.phase).toBe("running");

    publisher.handleCliRuntimeSignal("scope-1", {
      laneId: "auth-lane",
      sessionId: "cli-settle-1",
      runtimeState: "idle",
    });
    expect(publisher._debug.runs.has("cli-settle-1")).toBe(false);

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
    await settleMicrotasks();

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
    await settleMicrotasks();

    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(publishAttention.mock.calls[0][0].items).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    publisher.dispose();
  });

  function backgroundTask(
    sessionId: string,
    taskId: string,
    status: "running" | "completed",
  ): AgentChatEventEnvelope {
    return {
      sessionId,
      timestamp: "",
      event: {
        type: "scheduled_work_update",
        id: `background:${taskId}`,
        kind: "background_task",
        status,
        origin: "background_task",
        sourceTaskId: taskId,
        title: "Background work",
      },
    };
  }

  const turnCompleted: AgentChatEventEnvelope = {
    sessionId: "s-bg",
    timestamp: "",
    event: { type: "status", turnStatus: "completed" },
  };

  it("publishes a completed turn with live background tasks as working", async () => {
    const { publisher, emit } = makeHarness(device, undefined, { activityProtocol: 2 });

    emit({ sessionId: "s-bg", timestamp: "", event: { type: "text", text: "working" } });
    emit(backgroundTask("s-bg", "task-1", "running"));
    emit(turnCompleted);
    await vi.advanceTimersByTimeAsync(2_500);

    const working = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    expect(working).toMatchObject({
      phase: "running",
      eventKind: "agent_running",
      activityTier: "ambient",
    });
    expect(working.title).toContain("is working");

    // Draining the last background task is what finally settles the run.
    emit(backgroundTask("s-bg", "task-1", "completed"));
    await vi.advanceTimersByTimeAsync(2_500);

    const done = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    expect(done).toMatchObject({ phase: "completed", eventKind: "agent_completed" });
    expect(done.title).toContain("is done");
    publisher.dispose();
  });

  it("returns an already-completed run to working when a background task starts", async () => {
    const { publisher, emit } = makeHarness(device, undefined, { activityProtocol: 2 });

    emit({ sessionId: "s-bg", timestamp: "", event: { type: "text", text: "working" } });
    emit(turnCompleted);
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await publisher.getMachineAttentionSnapshot()).items[0]!.phase).toBe("completed");

    emit(backgroundTask("s-bg", "task-late", "running"));
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await publisher.getMachineAttentionSnapshot()).items[0]!.phase).toBe("running");

    emit(backgroundTask("s-bg", "task-late", "completed"));
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await publisher.getMachineAttentionSnapshot()).items[0]!.phase).toBe("completed");
    publisher.dispose();
  });

  it("does not settle a needs-you run when its background task drains", async () => {
    const { publisher, emit } = makeHarness(device, undefined, { activityProtocol: 2 });

    emit(backgroundTask("s-bg", "task-1", "running"));
    emit(turnCompleted);
    emit({
      sessionId: "s-bg",
      timestamp: "",
      event: { type: "approval_request", itemId: "i-9", kind: "command", description: "Deploy" },
    });
    emit(backgroundTask("s-bg", "task-1", "completed"));
    await vi.advanceTimersByTimeAsync(2_500);

    expect((await publisher.getMachineAttentionSnapshot()).items[0]!.phase).toBe("needs_you");
    publisher.dispose();
  });

  it("does not let a scheduled wakeup hold a finished run open", async () => {
    const { publisher, emit } = makeHarness(device, undefined, { activityProtocol: 2 });

    emit({ sessionId: "s-bg", timestamp: "", event: { type: "text", text: "working" } });
    emit(turnCompleted);
    emit({
      sessionId: "s-bg",
      timestamp: "",
      event: {
        type: "scheduled_work_update",
        id: "wake-1",
        kind: "wakeup",
        status: "scheduled",
      },
    });
    await vi.advanceTimersByTimeAsync(2_500);

    expect((await publisher.getMachineAttentionSnapshot()).items[0]!.phase).toBe("completed");
    publisher.dispose();
  });

  it("resumes a completed run that keeps emitting past the grace window", async () => {
    let clock = Date.parse("2026-07-05T12:00:00.000Z");
    const { publisher, emit } = makeHarness(device, () => clock, { activityProtocol: 2 });

    emit({ sessionId: "s-tail", timestamp: "", event: { type: "text", text: "working" } });
    emit({ sessionId: "s-tail", timestamp: "", event: { type: "status", turnStatus: "completed" } });
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await publisher.getMachineAttentionSnapshot()).items[0]!.phase).toBe("completed");

    // Trailing output inside the grace window must not flap the row.
    clock += 1_000;
    emit({ sessionId: "s-tail", timestamp: "", event: { type: "text", text: "tail" } });
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await publisher.getMachineAttentionSnapshot()).items[0]!.phase).toBe("completed");

    clock += 30_000;
    emit({ sessionId: "s-tail", timestamp: "", event: { type: "text", text: "still going" } });
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await publisher.getMachineAttentionSnapshot()).items[0]!.phase).toBe("running");
    publisher.dispose();
  });

  it("keeps a failed run failed when late output arrives", async () => {
    let clock = Date.parse("2026-07-05T12:00:00.000Z");
    const { publisher, emit } = makeHarness(device, () => clock, { activityProtocol: 2 });

    emit({ sessionId: "s-fail", timestamp: "", event: { type: "status", turnStatus: "failed" } });
    await vi.advanceTimersByTimeAsync(2_500);
    clock += 60_000;
    emit({ sessionId: "s-fail", timestamp: "", event: { type: "text", text: "stack trace" } });
    await vi.advanceTimersByTimeAsync(2_500);

    expect((await publisher.getMachineAttentionSnapshot()).items[0]!.phase).toBe("failed");
    publisher.dispose();
  });

  it("folds chat-owned shell rows into their parent chat item", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([{
      ...rosterProject(0),
      chats: [
        {
          id: "chat-parent",
          laneId: "lane-roster",
          title: "Parent chat",
          toolType: "claude-chat",
          status: "idle" as const,
          lastActivityAt: "2026-08-01T11:00:00.000Z",
        },
        {
          id: "shell-child",
          laneId: "lane-roster",
          chatSessionId: "chat-parent",
          title: "Attached shell",
          toolType: "shell",
          status: "idle" as const,
          lastActivityAt: "2026-08-01T11:00:00.000Z",
        },
        {
          id: "cli-standalone",
          laneId: "lane-roster",
          chatSessionId: null,
          title: "Standalone CLI",
          toolType: "shell",
          status: "idle" as const,
          lastActivityAt: "2026-08-01T11:00:00.000Z",
        },
      ],
    }]);
    const { publisher } = makeHarness(device, undefined, {
      activityProtocol: 2,
      activityRosterProvider: { buildSnapshot },
    });

    const items = (await publisher.getMachineAttentionSnapshot()).items;
    expect(items.map((item) => item.destination.kind === "session" && item.destination.sessionId))
      .toEqual(["chat-parent", "cli-standalone"]);
    publisher.dispose();
  });

  it("excludes CTO/identity chats from the feed while the roster still carries them", async () => {
    const roster = {
      ...rosterProject(0),
      chats: [
        {
          id: "chat-work",
          laneId: "lane-roster",
          title: "Work chat",
          toolType: "claude-chat",
          status: "idle" as const,
          lastActivityAt: "2026-08-01T11:00:00.000Z",
        },
        {
          id: "chat-cto",
          laneId: "lane-roster",
          title: "CTO",
          toolType: "claude-chat",
          status: "idle" as const,
          identityKey: "cto",
          lastActivityAt: "2026-08-01T11:00:00.000Z",
        },
      ],
    };
    const buildSnapshot = vi.fn().mockResolvedValue([roster]);
    const { publisher } = makeHarness(device, undefined, {
      activityProtocol: 2,
      activityRosterProvider: { buildSnapshot },
    });

    const items = (await publisher.getMachineAttentionSnapshot()).items;
    expect(items.map((item) => item.destination.kind === "session" && item.destination.sessionId))
      .toEqual(["chat-work"]);
    // The roster the mobile hub reads is untouched — only the feed filters.
    expect(roster.chats.map((chat) => chat.id)).toEqual(["chat-work", "chat-cto"]);
    publisher.dispose();
  });

  it("keeps a roster row that reports running over a stale terminal live run", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([{
      ...rosterProject(0),
      chats: [{
        id: "s-live",
        laneId: "lane-roster",
        title: "Live chat",
        toolType: "claude-chat",
        status: "running" as const,
        lastActivityAt: "2026-08-01T11:59:00.000Z",
      }],
    }]);
    const { publisher, emit } = makeHarness(device, undefined, {
      activityProtocol: 2,
      activityRosterProvider: { buildSnapshot },
    });

    emit({ sessionId: "s-live", timestamp: "", event: { type: "status", turnStatus: "completed" } });
    await vi.advanceTimersByTimeAsync(2_500);

    const items = (await publisher.getMachineAttentionSnapshot()).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.phase).toBe("running");
    publisher.dispose();
  });

  it("tombstones a deleted session immediately instead of waiting for a reconcile", async () => {
    const { publisher, publishAttention, emit } = makeHarness(device, undefined, {
      activityProtocol: 2,
    });
    publishAttention.mockResolvedValue({ ok: true, protocol: 2, revision: 1, acks: [] });

    emit({ sessionId: "s-doomed", timestamp: "", event: { type: "text", text: "working" } });
    await vi.advanceTimersByTimeAsync(2_500);
    publishAttention.mockClear();

    publisher._debug.onSessionRemoved("scope-1", "s-doomed");
    await vi.advanceTimersByTimeAsync(2_500);

    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(publishAttention.mock.calls[0][0]).toMatchObject({
      mode: "delta",
      items: [],
      tombstones: [expect.objectContaining({ id: `agent:${"a".repeat(40)}:s-doomed` })],
    });
    publisher.dispose();
  });

  it("stamps the canonical cross-machine project id on agent and PR items", async () => {
    const { publisher, emit } = makeHarness(device, undefined, { activityProtocol: 2 });
    // The harness attaches scope-1 at projectRoot "/projects/ADE".
    const expected = deriveProjectId("/projects/ADE");
    expect(expected).toMatch(/^project_[0-9a-f]{24}$/);

    emit(approval);
    publisher._debug.onPrNotification("scope-1", {
      kind: "opened",
      prId: "pr-node-1",
      prNumber: 11,
      prTitle: "Add widget",
      laneId: null,
      repoOwner: "acme",
      repoName: "app",
    });
    await vi.advanceTimersByTimeAsync(2_500);

    const items = (await publisher.getMachineAttentionSnapshot()).items;
    const agentItem = items.find((item) => item.kind === "agent")!;
    const prItem = items.find((item) => item.kind === "pull_request")!;
    for (const item of [agentItem, prItem]) {
      // projectId stays the machine-local uuid; canonicalId is additive.
      expect(item.project.projectId).toBe("scope-1");
      expect(item.project.canonicalId).toBe(expected);
      expect(item.project.rootPath).toBe("/projects/ADE");
    }
    publisher.dispose();
  });

  it("omits canonicalId rather than inventing one when no root path is known", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([{
      ...rosterProject(1),
      rootPath: null,
    }]);
    const { publisher } = makeHarness(device, undefined, {
      activityProtocol: 2,
      activityRosterProvider: { buildSnapshot },
    });

    const item = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    expect(item.project.rootPath).toBeNull();
    expect(item.project.canonicalId).toBeUndefined();
    publisher.dispose();
  });

  it("keeps the alert fingerprint unchanged when canonicalId is added", () => {
    // canonicalId is identity metadata, not phase state. If it entered the
    // alert fingerprint, the first publish after upgrade would re-alert every
    // item in the account — the #1001 notification-spam bug, restaged.
    const base = {
      contractVersion: 1 as const,
      id: "agent:m:s-1",
      revision: 1,
      fingerprint: "",
      kind: "agent" as const,
      eventKind: "agent_running" as const,
      phase: "running" as const,
      machine: {
        machineKey: "m",
        accountMachineKey: null,
        deviceId: null,
        name: "MacBook",
        online: true,
        lastSeenAt: "2026-07-05T12:00:00.000Z",
      },
      project: { projectId: "scope-1", name: "ADE", rootPath: "/projects/ADE" },
      title: "Claude is working",
      preview: "working",
      privacyPreview: "An ADE agent is working.",
      detail: null,
      recentActivity: [],
      planProgress: null,
      destination: { kind: "session" as const, sessionId: "s-1", itemId: null },
      actions: [{ id: "open", kind: "open" as const, label: "Open" }],
      occurredAt: "2026-07-05T12:00:00.000Z",
      updatedAt: "2026-07-05T12:00:00.000Z",
      statusSince: "2026-07-05T12:00:00.000Z",
      seenAt: null,
      dismissedAt: null,
      expiresAt: null,
    };
    const withCanonical = {
      ...base,
      project: { ...base.project, canonicalId: deriveProjectId("/projects/ADE") },
    };
    expect(activityAlertFingerprint(withCanonical)).toBe(activityAlertFingerprint(base));
    // It is not part of the row's look either, so no delta wave on upgrade —
    // the reconcile that runs at publisher start propagates it instead.
    expect(activityContentFingerprint(withCanonical)).toBe(activityContentFingerprint(base));
  });

  it("publishes chatActivityMode planning for a chat in plan mode", async () => {
    const { publisher, emit, agentChatService } = makeHarness(device, undefined, {
      activityProtocol: 2,
    });
    agentChatService.getSessionSummary.mockResolvedValue({
      sessionId: "s-1",
      laneId: "auth-lane",
      title: "Fix login",
      model: "gpt-5",
      provider: "codex",
      status: "active",
      interactionMode: "plan",
      startedAt: "",
      endedAt: null,
      lastActivityAt: "",
      lastOutputPreview: null,
      summary: null,
    });

    emit({ sessionId: "s-1", timestamp: "", event: { type: "text", text: "planning" } });
    await vi.advanceTimersByTimeAsync(2_500);

    const item = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    expect(item.phase).toBe("running");
    expect(item.chatActivityMode).toBe("planning");
    publisher.dispose();
  });

  it("omits chatActivityMode entirely for a chat that is not planning", async () => {
    const { publisher, emit } = makeHarness(device, undefined, { activityProtocol: 2 });
    // The harness summary has no interactionMode at all.
    emit({ sessionId: "s-1", timestamp: "", event: { type: "text", text: "working" } });
    await vi.advanceTimersByTimeAsync(2_500);

    const item = (await publisher.getMachineAttentionSnapshot()).items[0]!;
    expect(item.phase).toBe("running");
    expect(item.chatActivityMode).toBeUndefined();
    publisher.dispose();
  });

  it("keeps planning out of the alert fingerprint but inside the row's look", async () => {
    // planning↔working flips several times a turn. It must change the row (so a
    // delta republishes the new glyph) without ever reading as a new phase
    // entry, which is what would notify.
    const { publisher, emit, agentChatService } = makeHarness(device, undefined, {
      activityProtocol: 2,
    });
    emit({ sessionId: "s-1", timestamp: "", event: { type: "text", text: "working" } });
    await vi.advanceTimersByTimeAsync(2_500);
    const before = (await publisher.getMachineAttentionSnapshot()).items[0]!;

    agentChatService.getSessionSummary.mockResolvedValue({
      sessionId: "s-1",
      laneId: "auth-lane",
      title: "Fix login",
      model: "gpt-5",
      provider: "codex",
      status: "active",
      interactionMode: "plan",
      startedAt: "",
      endedAt: null,
      lastActivityAt: "",
      lastOutputPreview: null,
      summary: null,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const after = (await publisher.getMachineAttentionSnapshot()).items[0]!;

    expect(after.chatActivityMode).toBe("planning");
    expect(after.alertFingerprint).toBe(before.alertFingerprint);
    expect(after.contentFingerprint).not.toBe(before.contentFingerprint);
    publisher.dispose();
  });

  it("stops publishing for good once the relay reports the machine was revoked", async () => {
    const { publisher, publishAttention, emit, store, publisherLogger } = makeHarness(
      device,
      undefined,
      { activityProtocol: 2 },
    );
    publishAttention.mockRejectedValue(
      new PushRelayMachineRevokedError("publishAttention", "2026-07-05T11:00:00.000Z"),
    );

    emit({ sessionId: "s-1", timestamp: "", event: { type: "text", text: "working" } });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publishAttention).toHaveBeenCalledTimes(1);
    expect(publisherLogger.error).toHaveBeenCalledWith(
      "attention.machine_revoked",
      { revokedAt: "2026-07-05T11:00:00.000Z" },
    );
    expect(publisher.getMachineRevocation()).toEqual({
      revoked: true,
      revokedAt: "2026-07-05T11:00:00.000Z",
    });
    expect(store.getStatusSnapshot().machineRevokedAt).toBe("2026-07-05T11:00:00.000Z");

    // Terminal: no retry timer, and later events never resume the loop.
    publishAttention.mockClear();
    emit({ sessionId: "s-2", timestamp: "", event: { type: "text", text: "more" } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publishAttention).not.toHaveBeenCalled();
    publisher.dispose();
  });

  it("does not publish at all when the store already knows the machine is revoked", async () => {
    const { publisher, publishAttention, publish, emit } = makeHarness(device, undefined, {
      activityProtocol: 2,
      machineRevokedAt: "2026-07-01T00:00:00.000Z",
    });

    await publisher.start();
    emit({ sessionId: "s-1", timestamp: "", event: { type: "text", text: "working" } });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(publishAttention).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    publisher.dispose();
  });

  it("stops the legacy publish loop when the relay revokes the machine there", async () => {
    const { publisher, publish, store, publisherLogger, emit } = makeHarness(device, undefined, {
      // No protocol-2 Activity: alerts and Live Activities go out on the legacy
      // machine-signed publish route, which the relay now gates server-side too.
      activityProtocol: null,
    });
    publish.mockRejectedValue(
      new PushRelayMachineRevokedError("publish", "2026-07-05T11:00:00.000Z"),
    );

    emit({ sessionId: "s-1", timestamp: "", event: { type: "text", text: "working" } });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish).toHaveBeenCalledTimes(1);

    expect(publisher.getMachineRevocation()).toEqual({
      revoked: true,
      revokedAt: "2026-07-05T11:00:00.000Z",
    });
    expect(store.getStatusSnapshot().machineRevokedAt).toBe("2026-07-05T11:00:00.000Z");
    expect(publisherLogger.error).toHaveBeenCalledWith(
      "attention.machine_revoked",
      { revokedAt: "2026-07-05T11:00:00.000Z" },
    );

    // Terminal, not transient: no retry timer, and later events never resume it.
    publish.mockClear();
    emit({ sessionId: "s-2", timestamp: "", event: { type: "text", text: "more" } });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(publish).not.toHaveBeenCalled();

    // And a re-pair un-gates the legacy route too, without a restart.
    publish.mockResolvedValue({ ok: true });
    publisher.clearMachineRevocation();
    emit({ sessionId: "s-3", timestamp: "", event: { type: "text", text: "back" } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publish).toHaveBeenCalled();
    publisher.dispose();
  });

  it("resumes publishing without a restart once a re-pair clears the revocation", async () => {
    const { publisher, publishAttention, store, emit } = makeHarness(device, undefined, {
      activityProtocol: 2,
      machineRevokedAt: "2026-07-01T00:00:00.000Z",
    });

    await publisher.start();
    emit({ sessionId: "s-1", timestamp: "", event: { type: "text", text: "working" } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(publishAttention).not.toHaveBeenCalled();

    // Both halves lift together: the durable flag a restart would re-read AND
    // the live gate this process holds. Clearing only the durable one would
    // leave the machine on the account roster but mute until a restart.
    publisher.clearMachineRevocation();
    expect(publisher.getMachineRevocation()).toEqual({ revoked: false, revokedAt: null });
    expect(store.isMachineRevoked()).toBe(false);
    expect(store.getStatusSnapshot().machineRevokedAt).toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(publishAttention).toHaveBeenCalled();
    // The run that happened while the machine was gated is published, not lost.
    const items = (await publisher.getMachineAttentionSnapshot()).items;
    expect(items.map((item) => item.destination)).toContainEqual(
      expect.objectContaining({ sessionId: "s-1" }),
    );
    publisher.dispose();
  });

  it("restarts the attention heartbeat after a re-pair, not just one flush", async () => {
    const { publisher, publishAttention, emit } = makeHarness(device, undefined, {
      activityProtocol: 2,
    });

    await publisher.start();
    // Latch through the relay so the revocation tears down all three timers —
    // the flush timer, the PR-expiry timer AND the heartbeat interval. A store
    // that merely starts revoked never runs that teardown.
    publishAttention.mockRejectedValue(
      new PushRelayMachineRevokedError("publishAttention", "2026-07-05T11:00:00.000Z"),
    );
    emit({ sessionId: "s-1", timestamp: "", event: { type: "text", text: "working" } });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publisher.getMachineRevocation().revoked).toBe(true);

    publishAttention.mockReset();
    publishAttention.mockResolvedValue({ ok: true, protocol: 2, revision: 1, acks: [] });
    publisher.clearMachineRevocation();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publishAttention).toHaveBeenCalled();

    // The one immediate flush is not the contract. The periodic liveness
    // republish keeps staleness fresh, and it is only ever created inside
    // `attachSources` — so if the re-pair does not restart it, this machine
    // goes quiet again until a new scope attaches or the brain restarts.
    publishAttention.mockClear();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(publishAttention).toHaveBeenCalled();
    expect(publishAttention.mock.calls.some(
      ([payload]) => (payload as { mode?: string } | undefined)?.mode === "presence",
    )).toBe(true);
    publisher.dispose();
  });

  it("commits a bulk clear as one batch instead of N revision-fenced races", async () => {
    const buildSnapshot = vi.fn().mockResolvedValue([rosterProject(3)]);
    const { publisher, store } = makeHarness(device, undefined, {
      activityProtocol: 2,
      activityRosterProvider: { buildSnapshot },
    });

    const items = (await publisher.getMachineAttentionSnapshot()).items;
    expect(items).toHaveLength(3);
    const result = await publisher.acknowledgeMachineAttention({
      itemIds: [...items.map((item) => item.id), "agent:elsewhere:gone"],
      // Deliberately stale everywhere — a live feed always is.
      sourceRevisions: Object.fromEntries(items.map((item) => [item.id, 1])),
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-05T12:00:01.000Z",
      dismissedAt: "2026-07-05T12:00:01.000Z",
    });

    expect(result.acknowledged).toEqual(items.map((item) => item.id));
    expect(result.skipped).toEqual(["agent:elsewhere:gone"]);
    for (const item of items) {
      expect(store.getAttentionAcknowledgment(item.id, "owner-a")).toMatchObject({
        dismissedAt: "2026-07-05T12:00:01.000Z",
        sourceRevision: item.revision,
      });
    }
    publisher.dispose();
  });

  it("does not mint a second PR item when repo metadata is missing", async () => {
    const { publisher } = makeHarness(device, undefined, { activityProtocol: 2 });
    const base: PushPrNotification = {
      kind: "opened",
      prId: "pr-node-1",
      prNumber: 42,
      prTitle: "Add widget",
      laneId: null,
      repoOwner: "acme",
      repoName: "app",
    };
    publisher._debug.onPrNotification("scope-1", base);
    publisher._debug.onPrNotification("scope-1", {
      ...base,
      kind: "merge_ready",
      repoOwner: null,
      repoName: null,
    });
    await vi.advanceTimersByTimeAsync(2_500);

    const prItems = (await publisher.getMachineAttentionSnapshot()).items
      .filter((item) => item.kind === "pull_request");
    expect(prItems).toHaveLength(1);
    expect(prItems[0]!.phase).toBe("merge_ready");
    // The repo coordinates the first event resolved must survive the update.
    expect(prItems[0]!.destination).toMatchObject({ repoOwner: "acme", repoName: "app" });
    publisher.dispose();
  });

  it("drops a metadata-less PR notification that matches no existing item", async () => {
    const { publisher, publisherLogger } = makeHarness(device, undefined, { activityProtocol: 2 });
    publisher._debug.onPrNotification("scope-1", {
      kind: "opened",
      prNumber: 7,
      prTitle: "Orphan",
      laneId: null,
      repoOwner: null,
      repoName: null,
    });
    await vi.advanceTimersByTimeAsync(2_500);

    expect((await publisher.getMachineAttentionSnapshot()).items).toHaveLength(0);
    expect(publisherLogger.warn).toHaveBeenCalledWith(
      "attention.pr_activity_id_unresolved",
      expect.anything(),
    );
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

  it("repairs a schema-invalid file without rotating the machine key", () => {
    const original = createPushRegistrationStore({ filePath }).getOrCreateIdentity();
    // Same identity, wrecked body — the historical behaviour here was to mint a
    // brand-new machineKey, which permanently duplicates the account feed.
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        machineKey: original.machineKey,
        machineSecret: original.machineSecret,
        devices: "not-an-object",
      }),
    );
    const logger = { warn: vi.fn(), error: vi.fn() };
    const store = createPushRegistrationStore({ filePath, logger });

    expect(store.getOrCreateIdentity()).toEqual(original);
    expect(logger.warn).toHaveBeenCalledWith(
      "push.registration_file_repaired",
      expect.objectContaining({ filePath }),
    );
    expect(store.getStatusSnapshot().identityRecoveryError).toContain("repaired");
    expect(store.listPreviousMachineKeys()).toEqual([]);
  });

  it("quarantines an unsalvageable file and keeps the old key for a relay sweep", () => {
    const original = createPushRegistrationStore({ filePath }).getOrCreateIdentity();
    // The key survives but the signing secret does not: the identity cannot be
    // used, yet its relay rows still exist under the old key.
    fs.writeFileSync(
      filePath,
      JSON.stringify({ machineKey: original.machineKey, machineSecret: "too-short" }),
    );
    const logger = { warn: vi.fn(), error: vi.fn() };
    const store = createPushRegistrationStore({ filePath, logger });

    const replacement = store.getOrCreateIdentity();
    expect(replacement.machineKey).not.toBe(original.machineKey);
    expect(store.listPreviousMachineKeys()).toEqual([original.machineKey]);
    expect(logger.error).toHaveBeenCalledWith(
      "push.registration_identity_lost",
      expect.objectContaining({ salvagedMachineKeyCount: 1 }),
    );
    expect(store.getStatusSnapshot().identityRecoveryError).toContain("re-minted");
    // The damaged bytes are preserved, never silently clobbered.
    expect(fs.readdirSync(path.dirname(filePath)).some((name) => name.includes(".corrupt-")))
      .toBe(true);

    // Superseded keys are durable across reloads until the sweep clears them.
    const reopened = createPushRegistrationStore({ filePath });
    expect(reopened.listPreviousMachineKeys()).toEqual([original.machineKey]);
    reopened.clearPreviousMachineKeys([original.machineKey]);
    expect(reopened.listPreviousMachineKeys()).toEqual([]);
    expect(reopened.getStatusSnapshot().identityRecoveryError).toBeNull();
  });

  it("mints cleanly when no registration file exists at all", () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const store = createPushRegistrationStore({ filePath, logger });
    expect(store.getOrCreateIdentity().machineKey).toMatch(/^[0-9a-f]{32}$/);
    expect(store.getStatusSnapshot().identityRecoveryError).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
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

  it("persists protocol, roster epochs, remote acknowledgments, and revision floors", () => {
    const store = createPushRegistrationStore({ filePath });
    store.getOrCreateIdentity();
    store.setActivityProtocol(2);
    expect(store.nextActivityRosterEpoch()).toBe(1);
    expect(store.nextActivityRosterEpoch()).toBe(2);
    store.recordRemoteAttentionAcknowledgments({
      accountOwnerId: "owner-a",
      acknowledgments: [{
        itemId: "agent:machine:session-1",
        sourceRevision: 9,
        seenAt: "2026-07-05T01:00:00.000Z",
        dismissedAt: "2026-07-05T01:01:00.000Z",
      }],
      updatedAt: "2026-07-05T01:01:00.000Z",
    });
    store.setLastPublishedActivityRevisions({
      accountOwnerId: "owner-a",
      revisions: { "agent:machine:session-1": 11 },
    });

    const reopened = createPushRegistrationStore({ filePath });
    expect(reopened.getActivityProtocol()).toBe(2);
    expect(reopened.nextActivityRosterEpoch()).toBe(3);
    expect(reopened.listRemoteAttentionAcknowledgments("owner-a")).toEqual([
      expect.objectContaining({
        itemId: "agent:machine:session-1",
        accountOwnerId: "owner-a",
        sourceRevision: 9,
        dismissedAt: "2026-07-05T01:01:00.000Z",
      }),
    ]);
    expect(reopened.listRemoteAttentionAcknowledgments("owner-b")).toEqual([]);
    expect(reopened.getLastPublishedActivityRevisions()).toEqual({
      accountOwnerId: "owner-a",
      revisions: { "agent:machine:session-1": 11 },
    });
  });

  it("records machine revocation durably and only a re-pair clears it", () => {
    const store = createPushRegistrationStore({ filePath });
    expect(store.isMachineRevoked()).toBe(false);
    expect(store.getStatusSnapshot().machineRevokedAt).toBeNull();

    store.recordMachineRevoked("2026-07-05T11:00:00.000Z");
    // First writer wins: a retry storm must not keep moving the instant.
    store.recordMachineRevoked("2026-07-05T12:00:00.000Z");
    expect(store.getStatusSnapshot().machineRevokedAt).toBe("2026-07-05T11:00:00.000Z");

    // Durable — a brain restart must not resume publishing at a removed machine.
    const reopened = createPushRegistrationStore({ filePath });
    expect(reopened.isMachineRevoked()).toBe(true);
    reopened.clearMachineRevoked();
    expect(reopened.isMachineRevoked()).toBe(false);
    expect(createPushRegistrationStore({ filePath }).isMachineRevoked()).toBe(false);
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

  it("decodes the typed Activity publish result at the relay boundary", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        protocol: 2,
        revision: 19,
        acks: [{
          itemId: "agent:machine:session-1",
          sourceRevision: 7,
          seenAt: "2026-07-05T00:01:00.000Z",
          dismissedAt: null,
        }],
        upserted: 1,
        removed: 0,
        itemsTruncated: true,
      }),
    });
    const client = createPushRelayClient({
      store: makeStore({ isClaimed: () => true }),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-access-token",
      getAccountUserId: () => "account-a",
    });

    const result = await client.publishAttention({
      machineName: "MacBook",
      mode: "delta",
      rosterEpoch: 1,
      items: [],
      tombstones: [],
    });

    expect(result?.protocol).toBe(2);
    expect(result?.acks).toEqual([expect.objectContaining({
      itemId: "agent:machine:session-1",
      sourceRevision: 7,
    })]);
    expect(result?.itemsTruncated).toBe(true);
  });

  it("rejects malformed Activity publish results", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        protocol: "2",
        acks: [{ itemId: "session-1", sourceRevision: "stale" }],
      }),
    });
    const client = createPushRelayClient({
      store: makeStore({ isClaimed: () => true }),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-access-token",
      getAccountUserId: () => "account-a",
    });

    await expect(client.publishAttention({
      machineName: "MacBook",
      mode: "delta",
      rosterEpoch: 1,
      items: [],
      tombstones: [],
    })).rejects.toThrow(/invalid Activity publish result/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/attention");
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

  it("passes through the additive Activity snapshot fields", async () => {
    const activityItem = {
      id: "agent:machine-a:session-1",
      revision: 17,
      activityTier: "idle",
      contentFingerprint: "content-17",
      alertFingerprint: "alert-17",
      statusSince: "2026-07-05T00:00:00.000Z",
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: 1,
        streamId: "account-a",
        revision: 17,
        generatedAt: "2026-07-05T00:00:00.000Z",
        items: [activityItem],
        itemsTruncated: true,
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

    const result = await client.getAttentionSnapshot();

    expect(result?.itemsTruncated).toBe(true);
    expect(result?.items[0]).toMatchObject(activityItem);
    expect(result?.streamId).toBe("account-a");
  });

  it("sends revision and owner fences and parses stale acknowledgments", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        revision: 19,
        applied: ["item-applied"],
        stale: ["item-stale"],
      }),
    });
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-access-token",
      getAccountUserId: () => "account-a",
    });

    await expect(client.acknowledgeAttention({
      itemIds: ["item-applied", "item-stale"],
      sourceRevisions: { "item-applied": 4, "item-stale": 7 },
      expectedAccountOwnerId: "account-a",
      seenAt: "2026-07-05T00:01:00.000Z",
    })).resolves.toEqual({
      applied: ["item-applied"],
      stale: ["item-stale"],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://relay.test/attention/account/ack");
    expect(JSON.parse(init.body)).toEqual({
      itemIds: ["item-applied", "item-stale"],
      sourceRevisions: { "item-applied": 4, "item-stale": 7 },
      expectedAccountOwnerId: "account-a",
      seenAt: "2026-07-05T00:01:00.000Z",
    });
  });

  it("omits machine and device overrides from full preference writes", async () => {
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-access-token",
      getAccountUserId: () => "account-a",
    });

    await client.putAttentionPreferences("account-a", {
      ...DEFAULT_ATTENTION_PREFERENCES,
      devices: { "phone-1": { hideDetails: true } },
      machines: { "machine-a": { notificationsEnabled: false } },
    });

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(url).toBe("https://relay.test/attention/account/preferences");
    expect(body.devices).toBeUndefined();
    expect(body.machines).toBeUndefined();
    expect(body.account).toEqual(DEFAULT_ATTENTION_PREFERENCES.account);
  });

  it("patches one encoded Activity machine preference scope", async () => {
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-access-token",
      getAccountUserId: () => "account-a",
    });

    await client.putActivityMachinePreferences(
      "account-a",
      "machine/a",
      { notificationsEnabled: false },
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://relay.test/attention/account/preferences/machines/machine%2Fa",
    );
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ notificationsEnabled: false });
  });

  it("purges one account machine's Activity through the encoded delete route", async () => {
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-access-token",
      getAccountUserId: () => "account-a",
    });

    await client.purgeAccountMachineActivity("account-a", "machine/a");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://relay.test/attention/account/machines/machine%2Fa");
    expect(init.method).toBe("DELETE");
    expect(init.headers.authorization).toBe("Bearer account-access-token");
    // Account-scoped route: never machine-signed.
    expect(init.headers["x-ade-push-signature"]).toBeUndefined();
  });

  it("treats an already-purged machine as done but propagates real purge failures", async () => {
    const client = createPushRelayClient({
      store: makeStore(),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-access-token",
      getAccountUserId: () => "account-a",
    });

    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    await expect(client.purgeAccountMachineActivity("account-a", "gone")).resolves.toBeUndefined();

    // A failed purge must reach the user: the roster row is gone but the feed
    // still lists that machine's agents.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "purge failed" }),
    });
    await expect(client.purgeAccountMachineActivity("account-a", "machine-a"))
      .rejects.toThrow(/purge failed/);

    await expect(client.purgeAccountMachineActivity("account-a", "  "))
      .rejects.toThrow(/machine key is required/);
  });

  it("raises a revoked machine as a terminal error, not a publish failure", async () => {
    const client = createPushRelayClient({
      // Already claimed: the claim call would otherwise consume the mock.
      store: makeStore({ isClaimed: () => true }),
      logger,
      baseUrl: "https://relay.test",
      getAccountAccessToken: async () => "account-access-token",
      getAccountUserId: () => "account-a",
    });

    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ code: "machine_revoked", revokedAt: "2026-07-05T11:00:00.000Z" }),
    });
    await expect(client.publishAttention({
      machineName: "MacBook",
      mode: "presence",
      rosterEpoch: 1,
      items: [],
      tombstones: [],
    })).rejects.toBeInstanceOf(PushRelayMachineRevokedError);

    // A bare 403 (proxy, WAF) is NOT a revocation — it stays a normal failure.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden" }),
    });
    await expect(client.publishAttention({
      machineName: "MacBook",
      mode: "presence",
      rosterEpoch: 1,
      items: [],
      tombstones: [],
    })).rejects.not.toBeInstanceOf(PushRelayMachineRevokedError);
  });

  it("raises a revoked machine on the legacy machine-signed routes too", async () => {
    const client = createPushRelayClient({
      store: makeStore({ isClaimed: () => true }),
      logger,
      baseUrl: "https://relay.test",
    });

    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ code: "machine_revoked", revokedAt: "2026-07-05T11:00:00.000Z" }),
    });
    // The legacy publish and live-activity-token routes are machine-signed, so
    // a removed machine still authenticates and the relay gates them by roster.
    // A generic request error here would be retried on every flush, forever.
    await expect(client.publish({ notifications: [] }))
      .rejects.toBeInstanceOf(PushRelayMachineRevokedError);
    await expect(client.reportLiveActivityToken({
      deviceId: "dev-1",
      activityId: "agent-runs",
      token: "t".repeat(64),
    })).rejects.toBeInstanceOf(PushRelayMachineRevokedError);
    await expect(client.publish({ notifications: [] }))
      .rejects.toMatchObject({ revokedAt: "2026-07-05T11:00:00.000Z" });

    // A bare 403 stays an ordinary, retryable failure on these routes as well.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden" }),
    });
    await expect(client.publish({ notifications: [] }))
      .rejects.not.toBeInstanceOf(PushRelayMachineRevokedError);
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
    resolveResponse({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: 1,
        streamId: "account-a",
        revision: 1,
        generatedAt: "2026-07-29T00:00:00.000Z",
        items: [],
        tombstones: [],
      }),
    } as Response);

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
      /invalid Activity snapshot/i,
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
