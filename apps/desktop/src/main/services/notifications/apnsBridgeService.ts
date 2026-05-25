import type {
  ApnsBridgeSaveConfigArgs,
  ApnsBridgeSendTestPushArgs,
  ApnsBridgeSendTestPushResult,
  ApnsBridgeStatus,
  ApnsBridgeUploadKeyArgs,
  ApnsTestPushKind,
} from "../../../shared/types/sync";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { DeviceRegistryService } from "../sync/deviceRegistryService";
import type { ApnsService, ApnsKeyStore } from "./apnsService";

type ApnsBridgeServiceArgs = {
  projectConfigService: ReturnType<typeof createProjectConfigService> | null | undefined;
  apnsService: ApnsService | null | undefined;
  apnsKeyStore: ApnsKeyStore | null | undefined;
  getDeviceRegistryService?: () => DeviceRegistryService | null | undefined;
};

export function createApnsBridgeService(args: ApnsBridgeServiceArgs) {
  const readStatus = (): ApnsBridgeStatus => {
    const effective = args.projectConfigService?.get?.()?.effective;
    const apnsConfig = effective?.notifications?.apns ?? null;
    return {
      enabled: apnsConfig?.enabled === true,
      configured: args.apnsService?.isConfigured?.() === true,
      keyStored: args.apnsKeyStore?.has?.() === true,
      keyId: apnsConfig?.keyId ?? null,
      teamId: apnsConfig?.teamId ?? null,
      bundleId: apnsConfig?.bundleId ?? null,
      env: apnsConfig?.env === "production" ? "production" : "sandbox",
    };
  };

  const saveConfigToProject = (next: ApnsBridgeSaveConfigArgs): void => {
    if (!args.projectConfigService) return;
    const snapshot = args.projectConfigService.get();
    const shared = snapshot.shared ?? {};
    const sharedRecord = shared as Record<string, unknown>;
    const sharedNotifications =
      sharedRecord.notifications && typeof sharedRecord.notifications === "object"
        ? (sharedRecord.notifications as Record<string, unknown>)
        : {};
    args.projectConfigService.save({
      shared: {
        ...shared,
        notifications: {
          ...sharedNotifications,
          apns: {
            enabled: next.enabled,
            keyId: next.keyId,
            teamId: next.teamId,
            bundleId: next.bundleId,
            env: next.env,
          },
        },
      },
      local: snapshot.local ?? {},
    });
  };

  return {
    async getStatus(): Promise<ApnsBridgeStatus> {
      return readStatus();
    },

    async saveConfig(next: ApnsBridgeSaveConfigArgs): Promise<ApnsBridgeStatus> {
      if (!next.enabled) {
        saveConfigToProject(next);
        await args.apnsService?.reset?.();
        return readStatus();
      }
      if (args.apnsService && args.apnsKeyStore?.has()) {
        const pem = args.apnsKeyStore.load();
        if (pem) {
          try {
            args.apnsService.configure({
              keyP8Pem: pem,
              keyId: next.keyId,
              teamId: next.teamId,
              bundleId: next.bundleId,
              env: next.env,
            });
          } catch (error) {
            throw new Error(
              `APNs configure failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } else {
        await args.apnsService?.reset?.();
      }
      saveConfigToProject(next);
      return readStatus();
    },

    async uploadKey(next: ApnsBridgeUploadKeyArgs): Promise<ApnsBridgeStatus> {
      if (!args.apnsKeyStore) throw new Error("ApnsKeyStore unavailable.");
      const trimmed = (next.p8Pem ?? "").trim();
      if (!trimmed) throw new Error("Empty .p8 payload.");
      const effective = args.projectConfigService?.get?.()?.effective;
      const apnsConfig = effective?.notifications?.apns ?? null;
      if (
        apnsConfig?.enabled &&
        apnsConfig.keyId &&
        apnsConfig.teamId &&
        apnsConfig.bundleId &&
        args.apnsService
      ) {
        try {
          args.apnsService.configure({
            keyP8Pem: trimmed,
            keyId: apnsConfig.keyId,
            teamId: apnsConfig.teamId,
            bundleId: apnsConfig.bundleId,
            env: apnsConfig.env === "production" ? "production" : "sandbox",
          });
        } catch (error) {
          throw new Error(
            `APNs configure failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      args.apnsKeyStore.save(trimmed);
      return readStatus();
    },

    async clearKey(): Promise<ApnsBridgeStatus> {
      args.apnsKeyStore?.clear?.();
      await args.apnsService?.reset?.();
      return readStatus();
    },

    async sendTestPush(next: ApnsBridgeSendTestPushArgs): Promise<ApnsBridgeSendTestPushResult> {
      if (!args.apnsService || !args.apnsService.isConfigured?.()) {
        return { ok: false, reason: "APNs not configured. Upload a .p8 and save the config." };
      }
      const registry = args.getDeviceRegistryService?.() ?? null;
      if (!registry) return { ok: false, reason: "Device registry unavailable." };
      const effective = args.projectConfigService?.get?.()?.effective;
      const apnsConfig = effective?.notifications?.apns ?? null;
      const configuredBundleId = apnsConfig?.bundleId?.trim() ?? "";
      const devices = registry
        .listDevices()
        .filter((device) => device.platform === "iOS" && device.deviceType === "phone");
      const kind = next.kind ?? "generic";
      const target = next.deviceId
        ? devices.find((device) => device.deviceId === next.deviceId) ?? null
        : devices[0] ?? null;
      if (!target) return { ok: false, reason: "No paired iOS device in the registry." };
      const meta = target.metadata ?? {};
      const deviceBundleId =
        typeof meta.apnsBundleId === "string" && meta.apnsBundleId.trim().length > 0
          ? meta.apnsBundleId.trim()
          : configuredBundleId;
      if (!deviceBundleId) return { ok: false, reason: "No APNs bundle id found for this device or project." };
      let deviceEnv: "production" | "sandbox";
      if (meta.apnsEnv === "production") {
        deviceEnv = "production";
      } else if (meta.apnsEnv === "sandbox") {
        deviceEnv = "sandbox";
      } else {
        deviceEnv = apnsConfig?.env === "production" ? "production" : "sandbox";
      }

      let deviceToken: string | null;
      let topic: string;
      let pushType: "alert" | "liveactivity";
      let payload: Record<string, unknown>;
      if (kind === "la_start") {
        deviceToken = typeof meta.apnsActivityStartToken === "string" ? meta.apnsActivityStartToken : null;
        if (!deviceToken) {
          return { ok: false, reason: "Device has no Live Activity push-to-start token yet (iOS 17.2+ registers this shortly after launch)." };
        }
        topic = `${deviceBundleId}.push-type.liveactivity`;
        pushType = "liveactivity";
        payload = buildLiveActivityStartPayload();
      } else if (kind === "la_update_running" || kind === "la_update_attention" || kind === "la_update_multi") {
        const tokens = Object.values((meta.apnsActivityUpdateTokens ?? {}) as Record<string, unknown>)
          .filter((token): token is string => typeof token === "string" && token.length > 0);
        deviceToken = tokens[0] ?? null;
        if (!deviceToken) return { ok: false, reason: "No active Live Activity on device to update. Start one first (or fire 'Live Activity - start')." };
        topic = `${deviceBundleId}.push-type.liveactivity`;
        pushType = "liveactivity";
        payload = buildLiveActivityUpdatePayload(kind);
      } else if (kind === "la_end") {
        const tokens = Object.values((meta.apnsActivityUpdateTokens ?? {}) as Record<string, unknown>)
          .filter((token): token is string => typeof token === "string" && token.length > 0);
        deviceToken = tokens[0] ?? null;
        if (!deviceToken) return { ok: false, reason: "No active Live Activity on device to end." };
        topic = `${deviceBundleId}.push-type.liveactivity`;
        pushType = "liveactivity";
        payload = buildLiveActivityEndPayload();
      } else {
        deviceToken = typeof meta.apnsAlertToken === "string" ? meta.apnsAlertToken : null;
        if (!deviceToken) {
          return { ok: false, reason: "Device has no APNs alert token yet. Make sure you accepted the notification permission prompt on the iOS app (Settings -> Notifications -> ADE -> Allow)." };
        }
        topic = deviceBundleId;
        pushType = "alert";
        payload = buildTestPushPayload(kind);
      }

      try {
        const result = await args.apnsService.send({
          deviceToken,
          env: deviceEnv,
          pushType,
          topic,
          priority: 10,
          payload,
        });
        if (result.ok) return { ok: true };
        return { ok: false, reason: result.reason ?? "APNs rejected the push." };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "Unknown send error." };
      }
    },
  };
}

const NSDATE_REFERENCE_OFFSET_SECONDS = 978_307_200;
function toNSDateSeconds(unixSeconds: number): number {
  return unixSeconds - NSDATE_REFERENCE_OFFSET_SECONDS;
}

function buildContentState(variant: "running" | "attention" | "multi"): Record<string, unknown> {
  const nowRef = toNSDateSeconds(Math.floor(Date.now() / 1000));
  const sessionRunning = {
    id: "test-la-claude",
    providerSlug: "claude",
    title: "Push test - Claude",
    isAwaitingInput: false,
    isFailed: false,
    startedAt: nowRef - 60,
    toolCalls: 4,
    preview: "Reading src/auth/oauth.ts",
    progress: 0.32,
  };
  const sessionAwaiting = {
    ...sessionRunning,
    isAwaitingInput: true,
    startedAt: nowRef - 120,
    toolCalls: 7,
    preview: "Approve 3 file writes to continue",
  };
  const sessionCodex = {
    id: "test-la-codex",
    providerSlug: "codex",
    title: "tests-fix",
    isAwaitingInput: false,
    isFailed: false,
    startedAt: nowRef - 30,
    toolCalls: 2,
  };
  const sessionCto = {
    id: "test-la-cto",
    providerSlug: "cto",
    title: "daily-review",
    isAwaitingInput: false,
    isFailed: false,
    startedAt: nowRef - 240,
    toolCalls: 11,
  };
  if (variant === "attention") {
    return {
      sessions: [sessionAwaiting],
      attention: {
        kind: "awaitingInput",
        title: "Claude - Push test",
        subtitle: "3 file writes need approval",
        providerSlug: "claude",
        sessionId: sessionAwaiting.id,
        itemId: "test-item-1",
      },
      failingCheckCount: 0,
      awaitingReviewCount: 0,
      mergeReadyCount: 0,
      generatedAt: nowRef,
    };
  }
  if (variant === "multi") {
    return {
      sessions: [sessionRunning, sessionCodex, sessionCto],
      attention: null,
      failingCheckCount: 1,
      awaitingReviewCount: 2,
      mergeReadyCount: 1,
      generatedAt: nowRef,
    };
  }
  return {
    sessions: [sessionRunning],
    attention: null,
    failingCheckCount: 0,
    awaitingReviewCount: 0,
    mergeReadyCount: 0,
    generatedAt: nowRef,
  };
}

function buildLiveActivityStartPayload(): Record<string, unknown> {
  const nowUnix = Math.floor(Date.now() / 1000);
  return {
    aps: {
      timestamp: nowUnix,
      event: "start",
      "attributes-type": "ADESessionAttributes",
      attributes: { workspaceId: "default", workspaceName: "Test Workspace" },
      "content-state": buildContentState("running"),
      "stale-date": nowUnix + 300,
      "relevance-score": 100,
      alert: { title: "ADE - Live Activity started", body: "Tap to open." },
    },
  };
}

function buildLiveActivityUpdatePayload(kind: "la_update_running" | "la_update_attention" | "la_update_multi"): Record<string, unknown> {
  const nowUnix = Math.floor(Date.now() / 1000);
  let variant: "running" | "attention" | "multi";
  let relevanceScore: number;
  let alert: { title: string; body: string };
  if (kind === "la_update_attention") {
    variant = "attention";
    relevanceScore = 100;
    alert = { title: "Claude - Push test", body: "Approval needed - tap Approve/Deny in the island." };
  } else if (kind === "la_update_multi") {
    variant = "multi";
    relevanceScore = 60;
    alert = { title: "ADE", body: "3 chats running - 1 CI failing - 2 reviews pending" };
  } else {
    variant = "running";
    relevanceScore = 40;
    alert = { title: "Claude - Push test", body: "Reading src/auth/oauth.ts" };
  }
  return {
    aps: {
      timestamp: nowUnix,
      event: "update",
      "content-state": buildContentState(variant),
      "stale-date": nowUnix + 300,
      "relevance-score": relevanceScore,
      alert,
    },
  };
}

function buildLiveActivityEndPayload(): Record<string, unknown> {
  const nowUnix = Math.floor(Date.now() / 1000);
  return {
    aps: {
      timestamp: nowUnix,
      event: "end",
      "content-state": buildContentState("running"),
      "dismissal-date": nowUnix + 30,
      alert: { title: "ADE", body: "Live Activity ended." },
    },
  };
}

function buildTestPushPayload(kind: ApnsTestPushKind): Record<string, unknown> {
  const payloads: Record<Exclude<ApnsTestPushKind, "la_update_running" | "la_update_attention" | "la_update_multi" | "la_start" | "la_end">, Record<string, unknown>> = {
    awaiting_input: {
      aps: {
        alert: { title: "Claude - ADE mobile", body: "3 file writes need approval before I continue." },
        sound: "default",
        "mutable-content": 1,
        "interruption-level": "time-sensitive",
        "relevance-score": 1.0,
        "thread-id": "chat:test-approval-session:approval",
        category: "CHAT_AWAITING_INPUT",
      },
      providerSlug: "claude",
      sessionId: "test-approval-session",
      itemId: "test-item-001",
      kind: "approval",
    },
    chat_failed: {
      aps: {
        alert: { title: "Codex - tests-fix", body: "Session failed: rate limit exceeded after 24 tool calls." },
        sound: "default",
        "mutable-content": 1,
        "interruption-level": "active",
        "relevance-score": 0.7,
        "thread-id": "chat:test-failed-session",
        category: "CHAT_FAILED",
      },
      providerSlug: "codex",
      sessionId: "test-failed-session",
    },
    chat_turn_completed: {
      aps: {
        alert: { title: "Claude - auth-refactor", body: "Finished replying. 14 file edits, 3 new tests added." },
        sound: "default",
        "mutable-content": 1,
        "interruption-level": "active",
        "relevance-score": 0.4,
        "thread-id": "chat:test-completed-session",
        category: "CHAT_TURN_COMPLETED",
      },
      providerSlug: "claude",
      sessionId: "test-completed-session",
    },
    ci_failing: {
      aps: {
        alert: { title: "PR #412 - auth-refactor", body: "3 checks failing: lint, tsc, integration-tests." },
        sound: "default",
        "mutable-content": 1,
        "interruption-level": "active",
        "relevance-score": 0.8,
        "thread-id": "pr:412",
        category: "PR_CI_FAILING",
      },
      prId: "test-pr-412",
      prNumber: 412,
    },
    review_requested: {
      aps: {
        alert: { title: "PR #408 - new-widget", body: "alice requested your review." },
        sound: "default",
        "mutable-content": 1,
        "interruption-level": "active",
        "relevance-score": 0.7,
        "thread-id": "pr:408",
        category: "PR_REVIEW_REQUESTED",
      },
      prId: "test-pr-408",
      prNumber: 408,
    },
    merge_ready: {
      aps: {
        alert: { title: "PR #401 - refactor-auth", body: "All checks passed and approved. Ready to merge." },
        sound: "default",
        "mutable-content": 1,
        "interruption-level": "active",
        "relevance-score": 0.6,
        "thread-id": "pr:401",
        category: "PR_MERGE_READY",
      },
      prId: "test-pr-401",
      prNumber: 401,
    },
    cto_subagent_finished: {
      aps: {
        alert: { title: "CTO - daily-review", body: "Sub-agent 'Lint cleanup' finished (3 PRs opened)." },
        sound: "default",
        "mutable-content": 1,
        "interruption-level": "active",
        "relevance-score": 0.5,
        "thread-id": "cto:test-subagent",
        category: "CTO_SUBAGENT_FINISHED",
      },
      providerSlug: "cto",
    },
    generic: {
      aps: {
        alert: { title: "ADE", body: "Mobile push is working. Tap to open ADE." },
        sound: "default",
        "mutable-content": 1,
        "interruption-level": "active",
        "relevance-score": 0.5,
        category: "SYSTEM_ALERT",
      },
      providerSlug: "ade",
      testPush: true,
    },
  };
  if (kind in payloads) return payloads[kind as keyof typeof payloads];
  return payloads.generic;
}
