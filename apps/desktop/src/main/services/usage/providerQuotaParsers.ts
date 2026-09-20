import type { ExtraUsage, UsageWindow } from "../../../shared/types";
import { isRecord } from "../shared/utils";

export interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageBucket;
  fiveHour?: ClaudeUsageBucket;
  seven_day?: ClaudeUsageBucket;
  sevenDay?: ClaudeUsageBucket;
  seven_day_sonnet?: ClaudeUsageBucket;
  sevenDaySonnet?: ClaudeUsageBucket;
  seven_day_opus?: ClaudeUsageBucket | null;
  sevenDayOpus?: ClaudeUsageBucket | null;
  seven_day_oauth_apps?: ClaudeUsageBucket | null;
  sevenDayOAuthApps?: ClaudeUsageBucket | null;
  seven_day_cowork?: ClaudeUsageBucket | null;
  sevenDayCowork?: ClaudeUsageBucket | null;
  extra_usage?: ClaudeExtraUsage | null;
  extraUsage?: ClaudeExtraUsage | null;
  rate_limit_tier?: string;
}

type ClaudeUsageBucket = {
  percent_used?: number;
  used_percent?: number;
  percentUsed?: number;
  usedPercent?: number;
  utilization?: number;
  resets_at?: string;
  resetsAt?: string;
};

type ClaudeExtraUsage = {
  is_enabled?: boolean;
  isEnabled?: boolean;
  monthly_limit?: number;
  monthlyLimit?: number;
  used_credits?: number;
  usedCredits?: number;
  utilization?: number | null;
  currency?: string;
};

export function computeResetsInMs(resetsAt: string): number {
  if (!resetsAt) return 0;
  const target = new Date(resetsAt).getTime();
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, target - Date.now());
}

function usagePercent(bucket: Record<string, unknown> | null | undefined): number {
  if (!bucket) return 0;
  if (typeof bucket.percent_used === "number") return bucket.percent_used;
  if (typeof bucket.used_percent === "number") return bucket.used_percent;
  if (typeof bucket.percentUsed === "number") return bucket.percentUsed;
  if (typeof bucket.usedPercent === "number") return bucket.usedPercent;
  if (typeof bucket.utilization === "number") return bucket.utilization;
  return 0;
}

function codexResetAt(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1_000;
    return new Date(ms).toISOString();
  }
  return "";
}

export function parseClaudeWindows(data: ClaudeUsageResponse): { windows: UsageWindow[]; extraUsage: ExtraUsage | null } {
  const windows: UsageWindow[] = [];
  const fiveHour = data.five_hour ?? data.fiveHour;
  const sevenDay = data.seven_day ?? data.sevenDay;
  const sevenDaySonnet = data.seven_day_sonnet ?? data.sevenDaySonnet;
  const sevenDayOpus = data.seven_day_opus ?? data.sevenDayOpus;
  const sevenDayOAuthApps = data.seven_day_oauth_apps ?? data.sevenDayOAuthApps;
  const sevenDayCowork = data.seven_day_cowork ?? data.sevenDayCowork;

  if (fiveHour) {
    const resetsAt = fiveHour.resets_at ?? fiveHour.resetsAt ?? "";
    windows.push({
      provider: "claude",
      windowType: "five_hour",
      percentUsed: usagePercent(fiveHour),
      resetsAt,
      resetsInMs: computeResetsInMs(resetsAt),
    });
  }

  if (sevenDay) {
    const resetsAt = sevenDay.resets_at ?? sevenDay.resetsAt ?? "";
    const modelBreakdown: Record<string, number> = {};
    if (sevenDaySonnet) modelBreakdown.sonnet = usagePercent(sevenDaySonnet);
    if (sevenDayOpus) modelBreakdown.opus = usagePercent(sevenDayOpus);
    windows.push({
      provider: "claude",
      windowType: "weekly",
      percentUsed: usagePercent(sevenDay),
      resetsAt,
      resetsInMs: computeResetsInMs(resetsAt),
      modelBreakdown: Object.keys(modelBreakdown).length > 0 ? modelBreakdown : undefined,
    });
  }

  if (sevenDayOAuthApps) {
    const resetsAt = sevenDayOAuthApps.resets_at ?? sevenDayOAuthApps.resetsAt ?? "";
    windows.push({
      provider: "claude",
      windowType: "weekly_oauth_apps",
      percentUsed: usagePercent(sevenDayOAuthApps),
      resetsAt,
      resetsInMs: computeResetsInMs(resetsAt),
    });
  }

  if (sevenDayCowork) {
    const resetsAt = sevenDayCowork.resets_at ?? sevenDayCowork.resetsAt ?? "";
    windows.push({
      provider: "claude",
      windowType: "weekly_cowork",
      percentUsed: usagePercent(sevenDayCowork),
      resetsAt,
      resetsInMs: computeResetsInMs(resetsAt),
    });
  }

  const extra = data.extra_usage ?? data.extraUsage;
  let extraUsage: ExtraUsage | null = null;
  if (extra) {
    const isEnabled = extra.is_enabled ?? extra.isEnabled ?? false;
    const usedCents = extra.used_credits ?? extra.usedCredits ?? 0;
    const limitCents = extra.monthly_limit ?? extra.monthlyLimit ?? 0;
    extraUsage = {
      provider: "claude",
      isEnabled,
      usedCreditsUsd: usedCents / 100,
      monthlyLimitUsd: limitCents / 100,
      utilization: typeof extra.utilization === "number" ? extra.utilization : null,
      currency: extra.currency ?? "usd",
    };
  }

  return { windows, extraUsage };
}

export type CodexRateLimitSnapshot = {
  windows: UsageWindow[];
  spendControlReached?: boolean;
};

export function parseCodexRateLimitSnapshot(data: Record<string, unknown>): CodexRateLimitSnapshot {
  const windows: UsageWindow[] = [];
  const snakeRateLimit = isRecord(data.rate_limit) ? data.rate_limit : null;
  const camelRateLimits = isRecord(data.rateLimits) ? data.rateLimits : null;
  const seen = new Set<string>();

  const addWindow = (
    bucket: Record<string, unknown> | null,
    fallbackWindowType: UsageWindow["windowType"],
    limitId?: string | null,
  ): void => {
    if (!bucket) return;
    const resetsAt = codexResetAt(bucket.reset_at ?? bucket.resets_at ?? bucket.resetsAt);
    const windowDurationMins = codexWindowDurationMins(bucket);
    const windowDurationMs = codexWindowDurationMs(windowDurationMins);
    const windowType = codexWindowTypeFromDuration(windowDurationMins) ?? fallbackWindowType;
    const key = `${windowType}:${resetsAt}:${limitId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    windows.push({
      provider: "codex",
      windowType,
      percentUsed: usagePercent(bucket),
      resetsAt,
      resetsInMs: computeResetsInMs(resetsAt),
      ...(windowDurationMs ? { windowDurationMs } : {}),
    });
  };

  for (const [key, windowType] of [["primary", "five_hour"], ["secondary", "weekly"]] as const) {
    const snakeKey = key === "primary" ? "primary_window" : "secondary_window";
    const snakeBucket = snakeRateLimit && isRecord(snakeRateLimit[snakeKey]) ? snakeRateLimit[snakeKey] : null;
    const camelBucket = camelRateLimits && isRecord(camelRateLimits[key]) ? camelRateLimits[key] : null;
    const directBucket = isRecord(data[snakeKey]) ? data[snakeKey] : isRecord(data[key]) ? data[key] : null;
    addWindow(snakeBucket ?? camelBucket ?? directBucket, windowType);
  }

  const limitSnapshots = [
    isRecord(data.rateLimits) ? data.rateLimits : null,
    isRecord(data.rate_limits) ? data.rate_limits : null,
    isRecord(data.rateLimitsByLimitId) ? data.rateLimitsByLimitId : null,
    isRecord(data.rate_limits_by_limit_id) ? data.rate_limits_by_limit_id : null,
  ].filter((entry): entry is Record<string, unknown> => entry != null);

  for (const snapshots of limitSnapshots) {
    for (const [limitId, rawSnapshot] of Object.entries(snapshots)) {
      if (!isRecord(rawSnapshot)) continue;
      for (const [field, fallbackType] of [["primary", "five_hour"], ["secondary", "weekly"]] as const) {
        const bucket = isRecord(rawSnapshot[field]) ? rawSnapshot[field] : null;
        if (bucket) addWindow(bucket, fallbackType, limitId);
      }
    }
  }

  const spendControlReached = [
    data,
    camelRateLimits,
    isRecord(data.rate_limits) ? data.rate_limits : null,
    snakeRateLimit,
  ].flatMap((snapshot) => {
    if (!snapshot) return [];
    const value = snapshot.spendControlReached ?? snapshot.spend_control_reached;
    return typeof value === "boolean" ? [value] : [];
  })[0];

  return {
    windows,
    ...(typeof spendControlReached === "boolean" ? { spendControlReached } : {}),
  };
}

export function parseCodexRateLimitWindows(data: Record<string, unknown>): UsageWindow[] {
  return parseCodexRateLimitSnapshot(data).windows;
}

/** Plus/Team 5-hour window used percent from the live `account/rateLimits` payload. */
export function codexFiveHourUsedPercent(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const window = parseCodexRateLimitSnapshot(payload).windows
    .find((entry) => entry.windowType === "five_hour");
  return typeof window?.percentUsed === "number" ? window.percentUsed : null;
}

/**
 * Banked Codex reset credits, from an `account/rateLimits/read` response.
 *
 * NOT `CreditsSnapshot` — that is the account's billing balance, a dollar
 * figure, and reading it as "you have credits to reset with" would offer a
 * reset the API refuses. The reset credits live under `rateLimitResetCredits`
 * and each one is a single-use token that clears the account's windows.
 *
 * Only `status: "available"` counts. A credit mid-redemption or already spent
 * is visible in the same array, and counting those makes the button offer a
 * reset that comes back `alreadyRedeemed`.
 */
export type CodexResetCredits = {
  availableCount: number;
  nextExpiresAt?: string;
};

export function parseCodexResetCredits(payload: unknown): CodexResetCredits | null {
  if (!isRecord(payload)) return null;
  const container = payload.rateLimitResetCredits ?? payload.rate_limit_reset_credits;
  if (!isRecord(container)) return null;
  const credits = Array.isArray(container.credits) ? container.credits : [];
  let availableCount = 0;
  let nextExpiresAt: string | null = null;
  for (const entry of credits) {
    if (!isRecord(entry)) continue;
    if (entry.status !== "available") continue;
    availableCount += 1;
    const expiresAt = typeof entry.expiresAt === "string"
      ? entry.expiresAt
      : typeof entry.expires_at === "string" ? entry.expires_at : null;
    if (!expiresAt) continue;
    const parsed = Date.parse(expiresAt);
    if (!Number.isFinite(parsed)) continue;
    if (nextExpiresAt == null || parsed < Date.parse(nextExpiresAt)) nextExpiresAt = expiresAt;
  }
  // `availableCount` on the container is the server's own tally. Trusted when
  // the array is absent (the server may omit it), but the array wins when both
  // are present — it is the one that can be filtered by status.
  const reported = typeof container.availableCount === "number"
    ? Math.max(0, Math.floor(container.availableCount))
    : typeof container.available_count === "number"
      ? Math.max(0, Math.floor(container.available_count))
      : null;
  const resolvedCount = credits.length ? availableCount : reported ?? 0;
  return {
    availableCount: resolvedCount,
    ...(nextExpiresAt ? { nextExpiresAt } : {}),
  };
}

export const CODEX_PLAN_LIMIT_NOTICE_PERCENT = 50;

export function shouldEmitCodexApproachingPlanLimit(percentUsed: number | null | undefined): boolean {
  return typeof percentUsed === "number" && percentUsed >= CODEX_PLAN_LIMIT_NOTICE_PERCENT;
}

/**
 * Should the "approaching Codex plan limit" notice fire now, and does the
 * session stay armed?
 *
 * The notice is once per WINDOW, not once per session. A chat left open across
 * a five-hour rollover used to warn for the first window and then stay silent
 * forever, because the flag that suppresses the repeat inside one window was
 * only ever set, never cleared — the longer a session ran, the less the notice
 * was worth. Codex reports the fresh window at a low percent, so a reading back
 * under the threshold IS the rollover signal, and re-arming on it is what makes
 * the second window warn like the first.
 *
 * A reading of `null` (no five-hour window in the payload) changes nothing: it
 * is an absent measurement, not a low one, and treating it as a rollover would
 * re-arm on every unrelated payload and warn twice inside one window.
 */
export function codexPlanLimitNoticeState(args: {
  alreadyEmitted: boolean;
  percentUsed: number | null | undefined;
}): { emit: boolean; emitted: boolean } {
  const { alreadyEmitted, percentUsed } = args;
  if (typeof percentUsed !== "number") return { emit: false, emitted: alreadyEmitted };
  if (percentUsed < CODEX_PLAN_LIMIT_NOTICE_PERCENT) return { emit: false, emitted: false };
  return { emit: !alreadyEmitted, emitted: true };
}

function codexWindowTypeFromDuration(value: number | null): UsageWindow["windowType"] | null {
  if (value == null) return null;
  if (value <= 360) return "five_hour";
  if (value <= 10_080) return "weekly";
  return "monthly";
}

function codexWindowDurationMins(bucket: Record<string, unknown>): number | null {
  const minutes = bucket.windowDurationMins ?? bucket.window_duration_mins;
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) return minutes;

  const seconds = bucket.limitWindowSeconds
    ?? bucket.limit_window_seconds
    ?? bucket.windowDurationSeconds
    ?? bucket.window_duration_seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) return seconds / 60;
  return null;
}

function codexWindowDurationMs(value: number | null): number | null {
  return value == null ? null : Math.round(value * 60_000);
}
