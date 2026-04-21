import { describe, expect, it, vi } from "vitest";
import { createNotificationEventBus, type DevicePushTarget } from "./notificationEventBus";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from "../../../shared/types/sync";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import type { PrSummary } from "../../../shared/types/prs";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function deferredFlush() {
  // Fire-and-forget sends are queued via `void deliver(…)`; nextTick+microtask
  // flush before we assert.
  return new Promise<void>((resolve) => setImmediate(resolve));
}

type ApnsSendCall = {
  deviceToken: string;
  env?: "sandbox" | "production";
  topic: string;
  priority: number;
  pushType: string;
  payload: Record<string, unknown>;
};

function makeApnsService() {
  const calls: ApnsSendCall[] = [];
  const service = {
    isConfigured: () => true,
    send: vi.fn(async (envelope: any) => {
      calls.push({
        deviceToken: envelope.deviceToken,
        env: envelope.env,
        topic: envelope.topic,
        priority: envelope.priority,
        pushType: envelope.pushType,
        payload: envelope.payload,
      });
      return { ok: true, status: 200 };
    }),
  };
  return { service, calls };
}

function makeTarget(overrides: Partial<DevicePushTarget> = {}): DevicePushTarget {
  return {
    deviceId: "device-A",
    bundleId: "com.ade.ios",
    env: "sandbox",
    alertToken: "alert-token-A",
    activityStartToken: null,
    activityUpdateTokens: null,
    ...overrides,
  };
}

const prefsOn: NotificationPreferences = {
  ...DEFAULT_NOTIFICATION_PREFERENCES,
  chat: {
    awaitingInput: true,
    chatFailed: true,
    turnCompleted: true,
  },
};

describe("notificationEventBus", () => {
  const sampleEnvelope: AgentChatEventEnvelope = {
    sessionId: "session-1",
    timestamp: "2026-04-20T10:00:00.000Z",
    event: {
      type: "approval_request",
      itemId: "item-1",
      kind: "command",
      description: "Run `git push`?",
    },
  };

  it("fires an APNs push when category is enabled and a token is present", async () => {
    const { service, calls } = makeApnsService();
    const inAppSpy = vi.fn();
    const bus = createNotificationEventBus({
      logger: createLogger(),
      apnsService: service as any,
      listPushTargets: () => [makeTarget()],
      getPrefsForDevice: () => prefsOn,
      sendInAppNotification: inAppSpy,
      isDeviceConnected: () => false,
    });
    bus.publishChatEvent(sampleEnvelope);
    await deferredFlush();
    expect(calls).toHaveLength(1);
    expect(calls[0].deviceToken).toBe("alert-token-A");
    expect(calls[0].topic).toBe("com.ade.ios");
    expect(calls[0].priority).toBe(10);
    expect(inAppSpy).not.toHaveBeenCalled();
  });

  it("delivers in-app when device is connected, in addition to APNs", async () => {
    const { service } = makeApnsService();
    const inAppSpy = vi.fn();
    const bus = createNotificationEventBus({
      logger: createLogger(),
      apnsService: service as any,
      listPushTargets: () => [makeTarget()],
      getPrefsForDevice: () => prefsOn,
      sendInAppNotification: inAppSpy,
      isDeviceConnected: () => true,
    });
    bus.publishChatEvent(sampleEnvelope);
    await deferredFlush();
    expect(inAppSpy).toHaveBeenCalledTimes(1);
    expect(service.send).toHaveBeenCalledTimes(1);
  });

  it("skips APNs when the category is disabled in prefs, but still sends in-app", async () => {
    const { service } = makeApnsService();
    const inAppSpy = vi.fn();
    const deniedPrefs = { ...prefsOn, chat: { ...prefsOn.chat, awaitingInput: false } };
    const bus = createNotificationEventBus({
      logger: createLogger(),
      apnsService: service as any,
      listPushTargets: () => [makeTarget()],
      getPrefsForDevice: () => deniedPrefs,
      sendInAppNotification: inAppSpy,
      isDeviceConnected: () => true,
    });
    bus.publishChatEvent(sampleEnvelope);
    await deferredFlush();
    expect(service.send).not.toHaveBeenCalled();
    expect(inAppSpy).toHaveBeenCalledTimes(1);
  });

  it("fans out to multiple devices independently", async () => {
    const { service, calls } = makeApnsService();
    const inAppSpy = vi.fn();
    const bus = createNotificationEventBus({
      logger: createLogger(),
      apnsService: service as any,
      listPushTargets: () => [
        makeTarget({ deviceId: "A", alertToken: "t1" }),
        makeTarget({ deviceId: "B", alertToken: "t2" }),
      ],
      getPrefsForDevice: () => prefsOn,
      sendInAppNotification: inAppSpy,
      isDeviceConnected: () => false,
    });
    bus.publishChatEvent(sampleEnvelope);
    await deferredFlush();
    expect(calls.map((c) => c.deviceToken).sort()).toEqual(["t1", "t2"]);
  });

  it("never calls APNs when apnsService is null", async () => {
    const inAppSpy = vi.fn();
    const bus = createNotificationEventBus({
      logger: createLogger(),
      apnsService: null,
      listPushTargets: () => [makeTarget()],
      getPrefsForDevice: () => prefsOn,
      sendInAppNotification: inAppSpy,
      isDeviceConnected: () => true,
    });
    bus.publishChatEvent(sampleEnvelope);
    await deferredFlush();
    expect(inAppSpy).toHaveBeenCalledTimes(1);
  });

  it("publishPrEvent targets the correct device token and deep-link", async () => {
    const { service, calls } = makeApnsService();
    const bus = createNotificationEventBus({
      logger: createLogger(),
      apnsService: service as any,
      listPushTargets: () => [makeTarget()],
      getPrefsForDevice: () => prefsOn,
      sendInAppNotification: vi.fn(),
      isDeviceConnected: () => false,
    });
    const pr: PrSummary = {
      id: "pr-1",
      laneId: "lane-1",
      projectId: "proj-1",
      repoOwner: "arul28",
      repoName: "ADE",
      githubPrNumber: 412,
      githubUrl: "https://github.com/arul28/ADE/pull/412",
      githubNodeId: null,
      title: "Refactor",
      state: "open",
      baseBranch: "main",
      headBranch: "feat",
      checksStatus: "failing",
      reviewStatus: "requested",
      additions: 1,
      deletions: 1,
      lastSyncedAt: null,
      createdAt: "2026-04-20T00:00:00Z",
      updatedAt: "2026-04-20T00:00:00Z",
    };
    bus.publishPrEvent({ kind: "checks_failing", pr });
    await deferredFlush();
    expect(calls).toHaveLength(1);
    expect(calls[0].priority).toBe(10);
    expect((calls[0].payload as any).deepLink).toBe("ade://pr/412");
  });

  it("sendTestPush fails cleanly when no token is stored", async () => {
    const bus = createNotificationEventBus({
      logger: createLogger(),
      apnsService: makeApnsService().service as any,
      listPushTargets: () => [makeTarget({ alertToken: null })],
      getPrefsForDevice: () => prefsOn,
      sendInAppNotification: vi.fn(),
      isDeviceConnected: () => false,
    });
    const result = await bus.sendTestPush("device-A", "alert");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_token");
  });

  it("sendTestPush uses `bundle.push-type.liveactivity` topic when kind=activity", async () => {
    const { service, calls } = makeApnsService();
    const bus = createNotificationEventBus({
      logger: createLogger(),
      apnsService: service as any,
      listPushTargets: () => [makeTarget({ activityStartToken: "act-token" })],
      getPrefsForDevice: () => prefsOn,
      sendInAppNotification: vi.fn(),
      isDeviceConnected: () => false,
    });
    const result = await bus.sendTestPush("device-A", "activity");
    expect(result.ok).toBe(true);
    expect(calls[0].topic).toBe("com.ade.ios.push-type.liveactivity");
    expect(calls[0].pushType).toBe("liveactivity");
  });

  it("passes each device APNs environment through to alert and Live Activity sends", async () => {
    const { service, calls } = makeApnsService();
    const bus = createNotificationEventBus({
      logger: createLogger(),
      apnsService: service as any,
      listPushTargets: () => [
        makeTarget({
          env: "production",
          alertToken: "alert-prod",
          activityUpdateTokens: { "session-1": "live-prod" },
        }),
      ],
      getPrefsForDevice: () => prefsOn,
      sendInAppNotification: vi.fn(),
      isDeviceConnected: () => false,
      now: () => 1_777_777_777_000,
    });

    bus.publishChatEvent(sampleEnvelope);
    await deferredFlush();

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.env)).toEqual(["production", "production"]);
    expect(calls.map((call) => call.pushType)).toEqual(["alert", "liveactivity"]);
    expect(calls[1].topic).toBe("com.ade.ios.push-type.liveactivity");
  });

  it("sends Live Activity updates only to the matching activity id", async () => {
    const { service, calls } = makeApnsService();
    const bus = createNotificationEventBus({
      logger: createLogger(),
      apnsService: service as any,
      listPushTargets: () => [
        makeTarget({
          activityUpdateTokens: {
            "session-1": "live-session-1",
            "session-2": "live-session-2",
          },
        }),
      ],
      getPrefsForDevice: () => prefsOn,
      sendInAppNotification: vi.fn(),
      isDeviceConnected: () => false,
    });

    bus.publishChatEvent(sampleEnvelope);
    await deferredFlush();

    expect(calls.map((call) => call.deviceToken)).toEqual(["alert-token-A", "live-session-1"]);
  });
});
