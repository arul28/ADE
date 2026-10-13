/**
 * Live quota for Muse Code.
 *
 * Muse has no quota endpoint ADE can poll on its own: the subscription window
 * reaches ADE over MSP, on `usage/read` (when a chat's host starts) and on the
 * host's `usage/changed` notification. The chat runtime records the latest
 * reading in a store the process creates once; the usage tracker's `muse`
 * strategy publishes it, so the header meter shows Muse beside Claude and Codex.
 *
 * In-process only: the reading is Muse's own "as of" observation
 * (`observedAtMs`), never refreshed by ADE, and a fresh app start shows nothing
 * until a Muse chat runs again.
 */
import type { UsageWindow } from "../../../shared/types";
import type { SubscriptionUsage } from "@muse-code/sdk/dist/src/msp.js";
import { isRecord } from "../shared/utils";
import { localUsageAccountId } from "./usageAccountId";
import type { UsageProviderPollResult } from "./usageProviderStrategies";

const WEEK_MS = 7 * 24 * 60 * 60_000;

function isSubscriptionUsage(value: unknown): value is SubscriptionUsage {
  if (!isRecord(value)) return false;
  const window = isRecord(value.window) ? value.window : null;
  const weekly = isRecord(value.weekly) ? value.weekly : null;
  return typeof value.observedAtMs === "number"
    && typeof window?.usedPercent === "number"
    && typeof window?.resetsAtMs === "number"
    && typeof weekly?.usedPercent === "number"
    && typeof weekly?.resetsAtMs === "number";
}

export function museSubscriptionUsageToWindows(usage: SubscriptionUsage, nowMs: number): UsageWindow[] {
  const accountId = localUsageAccountId("muse");
  const windowDurationMs = usage.window.windowDurationMins > 0 ? usage.window.windowDurationMins * 60_000 : undefined;
  return [
    {
      provider: "muse",
      windowType: "five_hour",
      percentUsed: usage.window.usedPercent,
      resetsAt: new Date(usage.window.resetsAtMs).toISOString(),
      resetsInMs: Math.max(0, usage.window.resetsAtMs - nowMs),
      accountId,
      ...(windowDurationMs ? { windowDurationMs } : {}),
    },
    {
      provider: "muse",
      windowType: "weekly",
      percentUsed: usage.weekly.usedPercent,
      resetsAt: new Date(usage.weekly.resetsAtMs).toISOString(),
      resetsInMs: Math.max(0, usage.weekly.resetsAtMs - nowMs),
      accountId,
      windowDurationMs: WEEK_MS,
    },
  ];
}

/** The newest Muse subscription reading one process holds. */
export type MuseQuotaStore = {
  /**
   * Keep a reading. Takes the raw MSP payload (`usage/read`'s `usage` member or
   * the `usage/changed` params); anything else is ignored. An older observation
   * never replaces a newer one, since two chats' hosts can report out of order.
   * Returns whether the reading was kept.
   */
  record(value: unknown): boolean;
  /** The usage tracker's `muse` poll: the held reading as windows, or no row at all. */
  poll(nowMs?: number): Promise<UsageProviderPollResult>;
};

/** A store the composition root builds once and passes to the chat service and the usage tracker. */
export function createMuseQuotaStore(): MuseQuotaStore {
  let latest: SubscriptionUsage | null = null;
  return {
    record(value) {
      if (!isSubscriptionUsage(value)) return false;
      if (latest && latest.observedAtMs > value.observedAtMs) return false;
      latest = value;
      return true;
    },
    async poll(nowMs = Date.now()) {
      const reading = latest;
      if (!reading) return { disposition: "not_signed_in", windows: [], errors: [] };
      // A window whose reset has passed no longer describes the account; Muse
      // has not reported the new window yet, so show nothing rather than the
      // previous window's percentage as current.
      const windows = museSubscriptionUsageToWindows(reading, nowMs)
        .filter((window) => Date.parse(window.resetsAt) > nowMs);
      if (windows.length === 0) return { disposition: "not_signed_in", windows: [], errors: [] };
      return {
        windows,
        freshWindowCount: windows.length,
        ...(reading.tier ? { accountPlan: reading.tier } : {}),
        errors: [],
      };
    },
  };
}
