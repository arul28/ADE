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
  /** Returns the prefs for a specific device, or null if none stored. */
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
      if (!isAllowedByPrefs(mapped, prefs, now())) continue;

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

      if (!target.alertToken || !args.apnsService || !args.apnsService.isConfigured()) continue;

      // `apns-expiration` drops the push if it can't be delivered within the
      // window. For priority-5 / passive pushes (turn completed, mission phase,
      // sub-agent started) we don't want APNs queueing a stale banner if the
      // device is offline for hours — 10 minutes is plenty for them to still
      // feel "live". For priority-10 attention pushes (awaiting input, CI
      // failing) we give APNs 1 hour so it can deliver on the next reconnect.
      const nowSeconds = Math.floor(now() / 1000);
      const expirationEpochSeconds =
        mapped.priority === 10 ? nowSeconds + 60 * 60 : nowSeconds + 10 * 60;

      const envelope: ApnsEnvelope = {
        deviceToken: target.alertToken,
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
      const token = kind === "alert" ? target.alertToken : target.activityStartToken;
      if (!token) return { ok: false, reason: "no_token" };
      if (!args.apnsService || !args.apnsService.isConfigured()) return { ok: false, reason: "apns_not_configured" };

      const topic = kind === "activity" ? `${target.bundleId}.push-type.liveactivity` : target.bundleId;
      const envelope: ApnsEnvelope = {
        deviceToken: token,
        pushType: kind === "activity" ? "liveactivity" : "alert",
        topic,
        priority: 10,
        payload:
          kind === "activity"
            ? {
                aps: {
                  event: "update",
                  "content-state": { kind: "running", title: "Test push", statusLine: "verified", startedAt: new Date(now()).toISOString() },
                  timestamp: Math.floor(now() / 1000),
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
