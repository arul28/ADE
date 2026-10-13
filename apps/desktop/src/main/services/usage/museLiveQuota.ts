/**
 * Live quota for Muse Code.
 *
 * Muse has no quota endpoint ADE can poll on its own: the subscription window
 * reaches ADE over MSP, on `usage/read` (when a chat's host starts) and on the
 * host's `usage/changed` notification. The chat runtime records the latest
 * reading here and the usage tracker's `muse` strategy publishes it, so the
 * header meter shows Muse beside Claude and Codex.
 *
 * In-process only: the reading is Muse's own "as of" observation
 * (`observedAtMs`), never refreshed by ADE, and a fresh app start shows nothing
 * until a Muse chat runs again.
 */
import type { UsageWindow } from "../../../shared/types";
import type { SubscriptionUsage } from "@muse-code/sdk/dist/src/msp.js";
import { localUsageAccountId } from "./usageAccountId";
import type { UsageProviderPollResult } from "./usageProviderStrategies";

const WEEK_MS = 7 * 24 * 60 * 60_000;

let latest: SubscriptionUsage | null = null;

function isSubscriptionUsage(value: unknown): value is SubscriptionUsage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const window = record.window as Record<string, unknown> | undefined;
  const weekly = record.weekly as Record<string, unknown> | undefined;
  return typeof record.observedAtMs === "number"
    && typeof window?.usedPercent === "number"
    && typeof window?.resetsAtMs === "number"
    && typeof weekly?.usedPercent === "number"
    && typeof weekly?.resetsAtMs === "number";
}

/**
 * Keep the newest reading. Takes the raw MSP payload (`usage/read`'s `usage`
 * member or the `usage/changed` params); anything else is ignored. An older
 * observation never replaces a newer one, since two chats' hosts can report
 * out of order.
 */
export function recordMuseSubscriptionUsage(value: unknown): boolean {
  if (!isSubscriptionUsage(value)) return false;
  if (latest && latest.observedAtMs > value.observedAtMs) return false;
  latest = value;
  return true;
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

/** The usage tracker's `muse` poll: the last reading a Muse host reported, or no row at all. */
export async function pollMuseQuota(nowMs = Date.now()): Promise<UsageProviderPollResult> {
  if (!latest) return { disposition: "not_signed_in", windows: [], errors: [] };
  const windows = museSubscriptionUsageToWindows(latest, nowMs);
  return {
    windows,
    freshWindowCount: windows.length,
    ...(latest.tier ? { accountPlan: latest.tier } : {}),
    errors: [],
  };
}
