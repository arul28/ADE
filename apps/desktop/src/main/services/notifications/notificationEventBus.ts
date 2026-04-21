/**
 * Routes ADE domain events → APNs pushes OR in-app WebSocket notifications,
 * per-device + per-user prefs. This is the sole entry point callers use.
 *
 * Design notes:
 *   - The bus knows nothing about ADE domain state directly; it asks the
 *     device registry for tokens + prefs at send time so that a pref toggle
 *     takes effect immediately (no cache-invalidation races).
 *   - If a device is currently connected over WebSocket AND prefs say the
 *     category should NOT generate an alert, we still deliver an in-app
 *     notification via the supplied WS sender. This is what lets us e.g.
 *     turn off "chat completed" alerts while still updating foreground UI.
 *   - Every send() is fire-and-forget so that callers on hot paths (chat
 *     streaming, PR polling) don't block.
 */

import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import type { PrNotificationKind, PrSummary } from "../../../shared/types/prs";
import type { NotificationPreferences } from "../../../shared/types/sync";
import type { Logger } from "../logging/logger";
import {
  buildApnsPayload,
  isAllowedByPrefs,
  mapChatEvent,
  mapMissionEvent,
  mapPrEvent,
  mapSystemEvent,
  type MappedNotification,
  type MissionPhaseEvent,
  type SystemEvent,
} from "./notificationMapper";
import type { ApnsEnvelope, ApnsService } from "./apnsService";

const APPLE_REFERENCE_DATE_MS = Date.UTC(2001, 0, 1);

function activityDateValue(ms: number): number {
  return Math.floor((ms - APPLE_REFERENCE_DATE_MS) / 1000);
}

function numberMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function attentionForLiveActivity(mapped: MappedNotification): Record<string, unknown> | null {
  const metadata = mapped.metadata ?? {};
  switch (mapped.category) {
    case "CHAT_AWAITING_INPUT":
      return {
        kind: "awaitingInput",
        title: mapped.title,
        subtitle: mapped.body,
        sessionId: stringMetadata(metadata.sessionId),
        itemId: stringMetadata(metadata.itemId),
      };
    case "CHAT_FAILED":
      return {
        kind: "failed",
        title: mapped.title,
        subtitle: mapped.body,
        sessionId: stringMetadata(metadata.sessionId),
      };
    case "PR_CI_FAILING":
      return {
        kind: "ciFailing",
        title: mapped.title,
        subtitle: mapped.body,
        prId: stringMetadata(metadata.prId),
        prNumber: numberMetadata(metadata.prNumber),
      };
    case "PR_REVIEW_REQUESTED":
      return {
        kind: "reviewRequested",
        title: mapped.title,
        subtitle: mapped.body,
        prId: stringMetadata(metadata.prId),
        prNumber: numberMetadata(metadata.prNumber),
      };
    case "PR_CHANGES_REQUESTED":
      return {
        kind: "reviewRequested",
        title: mapped.title,
        subtitle: mapped.body,
        prId: stringMetadata(metadata.prId),
        prNumber: numberMetadata(metadata.prNumber),
      };
    case "PR_MERGE_READY":
      return {
        kind: "mergeReady",
        title: mapped.title,
        subtitle: mapped.body,
        prId: stringMetadata(metadata.prId),
        prNumber: numberMetadata(metadata.prNumber),
      };
    default:
      return null;
  }
}

function buildLiveActivityUpdatePayload(mapped: MappedNotification, nowMs: number): Record<string, unknown> | null {
  const attention = attentionForLiveActivity(mapped);
  if (!attention) return null;
  return {
    aps: {
      timestamp: Math.floor(nowMs / 1000),
      event: "update",
      "content-state": {
        sessions: [],
        attention,
        failingCheckCount: mapped.category === "PR_CI_FAILING" ? 1 : 0,
        awaitingReviewCount: mapped.category === "PR_REVIEW_REQUESTED" || mapped.category === "PR_CHANGES_REQUESTED" ? 1 : 0,
        mergeReadyCount: mapped.category === "PR_MERGE_READY" ? 1 : 0,
        generatedAt: activityDateValue(nowMs),
      },
    },
  };
}

function matchingActivityUpdateTokens(
  mapped: MappedNotification,
  updateTokens: Record<string, string> | null | undefined,
): string[] {
  if (!updateTokens) return [];
  const metadata = mapped.metadata ?? {};
  const activityIds = new Set<string>();
  const sessionId = stringMetadata(metadata.sessionId);
  const prId = stringMetadata(metadata.prId);
  if (sessionId) activityIds.add(sessionId);
  if (prId) activityIds.add(prId);
  if (activityIds.size === 0) return [];
  return [...activityIds]
    .map((activityId) => updateTokens[activityId])
    .filter((token): token is string => typeof token === "string" && token.trim().length > 0);
}

export type DevicePushTarget = {
  deviceId: string;
  bundleId: string;
  env: "sandbox" | "production";
  alertToken: string | null;
  activityStartToken: string | null;
  /** Currently active live-activity update tokens keyed by activity id. */
  activityUpdateTokens: Record<string, string> | null;
};

export type NotificationEventBusArgs = {
  logger: Logger;
  apnsService: ApnsService | null;
  /**
   * Returns the list of iOS devices we should consider routing to.
   * The bus filters further based on prefs + token availability.
   */
  listPushTargets: () => DevicePushTarget[];
  /** Returns the prefs for a specific device, falling back to defaults when none are stored. */
  getPrefsForDevice: (deviceId: string) => NotificationPreferences | null;
  /** Send an in-app notification over an already-connected WebSocket. */
  sendInAppNotification: (
    deviceId: string,
    payload: {
      category: MappedNotification["family"];
      title: string;
      body: string;
      collapseId?: string;
      deepLink?: string;
      metadata?: Record<string, string | number | boolean | null>;
    },
  ) => void;
  /** Whether the device is currently connected via WS. */
  isDeviceConnected: (deviceId: string) => boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
};

export type NotificationEventBus = ReturnType<typeof createNotificationEventBus>;

export function createNotificationEventBus(args: NotificationEventBusArgs) {
  const now = args.now ?? (() => Date.now());

  async function deliver(mapped: MappedNotification): Promise<void> {
    const targets = args.listPushTargets();
    if (targets.length === 0) return;
    for (const target of targets) {
      const prefs = args.getPrefsForDevice(target.deviceId);
      const nowMs = now();
      const prefsAllowed = isAllowedByPrefs(mapped, prefs, nowMs);

      const connectedInApp = args.isDeviceConnected(target.deviceId);
      if (connectedInApp) {
        args.sendInAppNotification(target.deviceId, {
          category: mapped.family,
          title: mapped.title,
          body: mapped.body,
          collapseId: mapped.collapseId,
          deepLink: mapped.deepLink,
          metadata: mapped.metadata,
        });
      }

      if (!prefsAllowed) continue;
      if (!args.apnsService || !args.apnsService.isConfigured()) continue;

      // `apns-expiration` drops the push if it can't be delivered within the
      // window. For priority-5 / passive pushes (turn completed, mission phase,
      // sub-agent started) we don't want APNs queueing a stale banner if the
      // device is offline for hours — 10 minutes is plenty for them to still
      // feel "live". For priority-10 attention pushes (awaiting input, CI
      // failing) we give APNs 1 hour so it can deliver on the next reconnect.
      const nowSeconds = Math.floor(nowMs / 1000);
      const expirationEpochSeconds =
        mapped.priority === 10 ? nowSeconds + 60 * 60 : nowSeconds + 10 * 60;

      if (target.alertToken) {
        const envelope: ApnsEnvelope = {
          deviceToken: target.alertToken,
          env: target.env,
          pushType: mapped.pushType,
          topic: target.bundleId,
          priority: mapped.priority,
          payload: buildApnsPayload(mapped),
          collapseId: mapped.collapseId,
          expirationEpochSeconds,
        };
        try {
          await args.apnsService.send(envelope);
        } catch (error) {
          args.logger.warn("notification_bus.apns_send_failed", {
            deviceId: target.deviceId,
            category: mapped.category,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const livePayload = buildLiveActivityUpdatePayload(mapped, nowMs);
      const updateTokens = matchingActivityUpdateTokens(mapped, target.activityUpdateTokens);
      if (livePayload && updateTokens.length > 0) {
        for (const token of updateTokens) {
          const liveEnvelope: ApnsEnvelope = {
            deviceToken: token,
            env: target.env,
            pushType: "liveactivity",
            topic: `${target.bundleId}.push-type.liveactivity`,
            priority: 10,
            payload: livePayload,
            collapseId: mapped.collapseId ? `${mapped.collapseId}:activity` : undefined,
            expirationEpochSeconds,
          };
          try {
            await args.apnsService.send(liveEnvelope);
          } catch (error) {
            args.logger.warn("notification_bus.live_activity_send_failed", {
              deviceId: target.deviceId,
              category: mapped.category,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  }

  function fanOut(mappedList: MappedNotification[]): void {
    for (const mapped of mappedList) {
      // fire-and-forget; callers shouldn't wait on push.
      void deliver(mapped).catch((error) => {
        args.logger.warn("notification_bus.deliver_failed", {
          category: mapped.category,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  return {
    publishChatEvent(envelope: AgentChatEventEnvelope): void {
      const mapped = mapChatEvent(envelope);
      if (mapped.length > 0) fanOut(mapped);
    },
    publishPrEvent(event: { kind: PrNotificationKind; pr: PrSummary; titleOverride?: string; messageOverride?: string }): void {
      const mapped = mapPrEvent(event);
      if (mapped.length > 0) fanOut(mapped);
    },
    publishMissionEvent(event: MissionPhaseEvent): void {
      const mapped = mapMissionEvent(event);
      if (mapped.length > 0) fanOut(mapped);
    },
    publishSystemEvent(event: SystemEvent): void {
      const mapped = mapSystemEvent(event);
      if (mapped.length > 0) fanOut(mapped);
    },
    /**
     * Fire a canned test push to a specific device, used by the Send Test
     * Push button in the mobile settings panel.
     */
    async sendTestPush(deviceId: string, kind: "alert" | "activity" = "alert"): Promise<{ ok: boolean; reason?: string }> {
      const target = args.listPushTargets().find((t) => t.deviceId === deviceId);
      if (!target) return { ok: false, reason: "device_not_registered" };
      const activityUpdateToken = target.activityUpdateTokens ? Object.values(target.activityUpdateTokens)[0] : null;
      const token = kind === "alert" ? target.alertToken : activityUpdateToken ?? target.activityStartToken;
      if (!token) return { ok: false, reason: "no_token" };
      if (!args.apnsService || !args.apnsService.isConfigured()) return { ok: false, reason: "apns_not_configured" };

      const topic = kind === "activity" ? `${target.bundleId}.push-type.liveactivity` : target.bundleId;
      const activityEvent = activityUpdateToken ? "update" : "start";
      const liveContentState = {
        sessions: [],
        attention: {
          kind: "awaitingInput",
          title: "ADE test push",
          subtitle: "Live Activity delivery is wired.",
        },
        failingCheckCount: 0,
        awaitingReviewCount: 0,
        mergeReadyCount: 0,
        generatedAt: activityDateValue(now()),
      };
      const envelope: ApnsEnvelope = {
        deviceToken: token,
        env: target.env,
        pushType: kind === "activity" ? "liveactivity" : "alert",
        topic,
        priority: 10,
        payload:
          kind === "activity"
            ? {
                aps: {
                  event: activityEvent,
                  timestamp: Math.floor(now() / 1000),
                  ...(activityEvent === "start"
                    ? {
                        "attributes-type": "ADESessionAttributes",
                        attributes: { workspaceId: "default", workspaceName: "ADE" },
                      }
                    : {}),
                  "content-state": liveContentState,
                },
              }
            : buildApnsPayload({
                category: "CHAT_AWAITING_INPUT",
                family: "chat",
                title: "ADE test push",
                body: "If you see this, mobile push is wired correctly.",
                pushType: "alert",
                priority: 10,
                interruptionLevel: "active",
                collapseId: "ade:test",
              }),
      };
      try {
        const result = await args.apnsService.send(envelope);
        return { ok: result.ok, reason: result.reason };
      } catch (error) {
        args.logger.warn("notification_bus.test_push_failed", {
          deviceId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, reason: "send_failed" };
      }
    },
  };
}
