import type { ExtraUsage, UsageProvider, UsageWindow, UsageWindowType } from "../../../shared/types";
import { asRecord, finiteNumberFromNumeric, finiteNumberOrNull, isRecord, toOptionalString } from "../shared/utils";
import { usageAccountId } from "./usageAccountId";

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
  const seconds = finiteNumberOrNull(value);
  if (seconds == null) return "";
  return new Date(seconds > 1_000_000_000_000 ? seconds : seconds * 1_000).toISOString();
}

/** The first of `keys` holding a non-blank string, trimmed. */
export function stringField(record: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = toOptionalString(record[key]);
    if (value) return value;
  }
  return null;
}

/**
 * Kimi's window units as its API spells them, in ms. Kimi Code's own client
 * (`packages/oauth/src/managed-usage.ts`) reads exactly these four and treats
 * any other unit as no window.
 */
const KIMI_TIME_UNIT_MS: ReadonlyMap<string, number> = new Map([
  ["TIME_UNIT_MINUTE", 60_000],
  ["TIME_UNIT_HOUR", 3_600_000],
  ["TIME_UNIT_DAY", 86_400_000],
  ["TIME_UNIT_WEEK", 7 * 86_400_000],
]);

/** The top-level `usage` block carries no window; Kimi's client reads it as one week. */
const KIMI_SUMMARY_WINDOW_MS = 7 * 86_400_000;

function kimiWindowDurationMs(window: unknown): number | null {
  const record = asRecord(window);
  // Protobuf JSON sends int64 as text, so counts may be numeric strings.
  const duration = finiteNumberFromNumeric(record?.duration);
  const unitMs = typeof record?.timeUnit === "string" ? KIMI_TIME_UNIT_MS.get(record.timeUnit) : undefined;
  return duration != null && duration > 0 && unitMs != null ? duration * unitMs : null;
}

/** By length when Kimi states one; a row with no readable window falls back to its name. */
function kimiWindowType(durationMs: number | null, name: string): UsageWindowType {
  if (durationMs != null) {
    if (durationMs <= 8 * 3_600_000) return "five_hour";
    if (durationMs <= 10 * 86_400_000) return "weekly";
    return "monthly";
  }
  const lower = name.toLowerCase();
  if (/5[\s_-]*hour|five[\s_-]*hour|\b5h\b/.test(lower)) return "five_hour";
  if (/week|7[\s_-]*day/.test(lower)) return "weekly";
  return "monthly";
}

function kimiResetAt(value: unknown): string {
  const reset = codexResetAt(value);
  return reset && Number.isFinite(Date.parse(reset)) ? reset : "";
}

/**
 * Used percent of a Kimi `{ used, limit }` pair. Protobuf JSON omits a zero
 * `used`, so a missing `used` beside a real limit is 0%, as Kimi's client reads
 * it. A missing or zero limit is no window.
 */
function kimiUsedPercent(detail: Record<string, unknown> | null): number | null {
  const limit = finiteNumberFromNumeric(detail?.limit);
  if (!detail || limit == null || limit <= 0) return null;
  const percent = ((finiteNumberFromNumeric(detail.used) ?? 0) / limit) * 100;
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

/**
 * Kimi Code's managed `/usages` response, read the way Kimi Code's own client
 * reads it: `{ usage: { used, limit, resetTime }, limits: [{ name?, window:
 * { duration, timeUnit }, detail: { used, limit, resetTime } }] }`. The
 * top-level `usage` is the weekly quota; each `limits[]` row is typed by its
 * length, not its position. Only the first window of each type is kept, since
 * the burn-rate history keys on provider, account, and window type.
 */
export function parseKimiUsage(
  payload: unknown,
  nowMs: number,
  email?: string | null,
): UsageWindow[] {
  const root = asRecord(payload);
  if (!root) return [];
  const accountId = usageAccountId({ provider: "kimi", email });
  const rows: Array<{ detail: Record<string, unknown> | null; durationMs: number | null; name: string }> = [
    { detail: asRecord(root.usage), durationMs: KIMI_SUMMARY_WINDOW_MS, name: "" },
  ];
  for (const raw of Array.isArray(root.limits) ? root.limits : []) {
    const row = asRecord(raw);
    if (!row) continue;
    rows.push({
      detail: asRecord(row.detail),
      durationMs: kimiWindowDurationMs(row.window),
      name: stringField(row, "name") ?? "",
    });
  }
  const windows: UsageWindow[] = [];
  for (const row of rows) {
    const percentUsed = kimiUsedPercent(row.detail);
    if (percentUsed == null) continue;
    const windowType = kimiWindowType(row.durationMs, row.name);
    if (windows.some((window) => window.windowType === windowType)) continue;
    const resetsAt = kimiResetAt(row.detail?.resetTime);
    const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
    windows.push({
      provider: "kimi",
      windowType,
      percentUsed,
      resetsAt,
      resetsInMs: Number.isFinite(resetMs) ? Math.max(0, resetMs - nowMs) : 0,
      accountId,
      ...(row.durationMs ? { windowDurationMs: row.durationMs } : {}),
    });
  }
  return windows;
}

export type KimiIdentity = {
  email: string | null;
  name: string | null;
};

/** Kimi's `/me`: `email` and `nickname` at the top level (Kimi's client reads them there). */
export function parseKimiIdentity(payload: unknown): KimiIdentity {
  const root = asRecord(payload);
  const nested = asRecord(root?.user);
  return {
    email: stringField(root, "email", "email_address") ?? stringField(nested, "email", "email_address"),
    name: stringField(root, "nickname", "name", "display_name", "full_name")
      ?? stringField(nested, "nickname", "name", "display_name", "full_name"),
  };
}

export type CopilotIdentity = {
  login: string | null;
  email: string | null;
};

export function parseCopilotIdentity(payload: unknown): CopilotIdentity {
  const root = asRecord(payload);
  return {
    login: stringField(root, "login"),
    email: stringField(root, "email"),
  };
}

export function parseFactorySessionCredits(payload: unknown): number | null {
  const root = asRecord(payload);
  const candidates = [root, asRecord(root?.data), asRecord(root?.tokenUsage), asRecord(root?.token_usage)];
  for (const candidate of candidates) {
    const credits = finiteNumberFromNumeric(candidate?.factoryCredits ?? candidate?.factory_credits);
    if (credits != null && credits >= 0) return credits;
  }
  return null;
}

/** Whole-number percents. 1 means 1%, never 100%. */
export function wholePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

function ratioPercent(used: unknown, limit: unknown): number | null {
  const usedValue = finiteNumberOrNull(used);
  const limitValue = finiteNumberOrNull(limit);
  if (usedValue == null || limitValue == null || limitValue <= 0) return null;
  return wholePercent((usedValue / limitValue) * 100);
}

function isoField(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

function quotaWindow(input: {
  provider: UsageProvider;
  windowType: UsageWindowType;
  percentUsed: number;
  resetsAt: string | null;
  nowMs: number;
  email?: string | null;
  windowDurationMs?: number;
}): UsageWindow {
  const resetsAt = input.resetsAt ?? "";
  const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return {
    provider: input.provider,
    windowType: input.windowType,
    accountId: usageAccountId({ provider: input.provider, email: input.email }),
    percentUsed: input.percentUsed,
    resetsAt,
    resetsInMs: Number.isFinite(resetMs) ? Math.max(0, resetMs - input.nowMs) : 0,
    ...(input.windowDurationMs && input.windowDurationMs > 0 ? { windowDurationMs: input.windowDurationMs } : {}),
  };
}

function resetFromSeconds(seconds: unknown, nowMs: number): string | null {
  const value = finiteNumberOrNull(seconds);
  if (value == null || value < 0) return null;
  return new Date(nowMs + value * 1000).toISOString();
}

function windowFromUsageNode(
  provider: UsageProvider,
  windowType: UsageWindowType,
  node: Record<string, unknown> | null,
  nowMs: number,
  windowDurationMs?: number,
): UsageWindow | null {
  if (!node) return null;
  const percent = wholePercent(node.percent)
    ?? wholePercent(node.usagePercent)
    ?? wholePercent(node.percentUsed);
  if (percent == null) return null;
  const resetsAt = isoField(node, "resetsAt", "resets_at")
    ?? resetFromSeconds(node.resetInSec ?? node.reset_in_sec, nowMs);
  return quotaWindow({ provider, windowType, percentUsed: percent, resetsAt, nowMs, windowDurationMs });
}

export function parseCursorUsageSummary(payload: unknown, nowMs: number): {
  windows: UsageWindow[];
  plan: string | null;
  email: string | null;
} {
  const root = asRecord(payload);
  const individual = asRecord(root?.individualUsage) ?? asRecord(root?.individual_usage);
  const planNode = asRecord(individual?.plan) ?? asRecord(root?.plan);
  const percent = wholePercent(planNode?.totalPercentUsed)
    ?? wholePercent(planNode?.total_percent_used)
    ?? ratioPercent(planNode?.used, planNode?.limit);
  if (!root || percent == null) return { windows: [], plan: null, email: null };
  const email = stringField(root, "email");
  const plan = stringField(root, "membershipType", "membership_type");
  const resetsAt = isoField(root, "billingCycleEnd", "billing_cycle_end");
  return {
    windows: [quotaWindow({
      provider: "cursor",
      windowType: "monthly",
      percentUsed: percent,
      resetsAt,
      nowMs,
      email,
    })],
    plan,
    email,
  };
}

export function parseCopilotQuota(payload: unknown, nowMs: number, email?: string | null): {
  windows: UsageWindow[];
  plan: string | null;
} {
  const root = asRecord(payload);
  const snapshots = asRecord(root?.quotaSnapshots) ?? asRecord(root?.quota_snapshots);
  const premium = asRecord(snapshots?.premiumInteractions) ?? asRecord(snapshots?.premium_interactions);
  const remaining = wholePercent(premium?.percentRemaining) ?? wholePercent(premium?.percent_remaining);
  const percent = remaining == null ? null : wholePercent(100 - remaining);
  if (percent == null) return { windows: [], plan: null };
  const plan = stringField(root, "copilotPlan", "copilot_plan");
  const resetsAt = isoField(premium, "resetAt", "reset_at")
    ?? isoField(root,
      "quotaResetAt",
      "quota_reset_at",
      "quotaResetDateUtc",
      "quota_reset_date_utc",
      "quotaResetDate",
      "quota_reset_date",
    );
  return {
    windows: [quotaWindow({
      provider: "copilot",
      windowType: "monthly",
      percentUsed: percent,
      resetsAt,
      nowMs,
      email,
    })],
    plan,
  };
}

function grokWindowType(startIso: string | null, endIso: string | null): {
  windowType: UsageWindowType;
  windowDurationMs?: number;
} {
  if (!startIso || !endIso) return { windowType: "monthly" };
  const duration = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(duration) || duration <= 0) return { windowType: "monthly" };
  const days = duration / 86_400_000;
  if (days >= 5 && days <= 9) return { windowType: "weekly", windowDurationMs: duration };
  return { windowType: "monthly", windowDurationMs: duration };
}

export function parseGrokCredits(payload: unknown, nowMs: number, email?: string | null): {
  windows: UsageWindow[];
  plan: string | null;
} {
  const root = asRecord(payload);
  const config = asRecord(root?.config) ?? root;
  if (!config) return { windows: [], plan: null };
  const onDemandUsed = asRecord(config.onDemandUsed) ?? asRecord(config.on_demand_used);
  const onDemandCap = asRecord(config.onDemandCap) ?? asRecord(config.on_demand_cap);
  const percent = wholePercent(config.creditUsagePercent)
    ?? wholePercent(config.credit_usage_percent)
    ?? ratioPercent(onDemandUsed?.val, onDemandCap?.val);
  if (percent == null) return { windows: [], plan: null };
  const period = asRecord(config.currentPeriod) ?? asRecord(config.current_period);
  const start = isoField(period, "start") ?? isoField(config, "billingPeriodStart", "billing_period_start");
  const end = isoField(period, "end")
    ?? isoField(config, "billingPeriodEnd", "billing_period_end");
  const cycle = grokWindowType(start, end);
  const plan = stringField(config, "subscriptionTier", "subscription_tier_display", "subscription_tier");
  return {
    windows: [quotaWindow({
      provider: "grok",
      windowType: cycle.windowType,
      percentUsed: percent,
      resetsAt: end,
      nowMs,
      email,
      ...(cycle.windowDurationMs ? { windowDurationMs: cycle.windowDurationMs } : {}),
    })],
    plan,
  };
}

export function parseOpenCodeGoUsage(payload: unknown, nowMs: number): UsageWindow[] {
  const root = asRecord(payload);
  const usage = asRecord(root?.usage) ?? root;
  if (!usage) return [];
  const rolling = asRecord(usage.rolling) ?? asRecord(usage.rollingUsage);
  const weekly = asRecord(usage.weekly) ?? asRecord(usage.weeklyUsage);
  const monthly = asRecord(usage.monthly) ?? asRecord(usage.monthlyUsage);
  return [
    windowFromUsageNode("opencode", "five_hour", rolling, nowMs, 5 * 3_600_000),
    windowFromUsageNode("opencode", "weekly", weekly, nowMs),
    windowFromUsageNode("opencode", "monthly", monthly, nowMs),
  ].filter((window): window is UsageWindow => window != null);
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
  const minutes = finiteNumberOrNull(bucket.windowDurationMins ?? bucket.window_duration_mins);
  if (minutes != null && minutes > 0) return minutes;

  const seconds = finiteNumberOrNull(bucket.limitWindowSeconds
    ?? bucket.limit_window_seconds
    ?? bucket.windowDurationSeconds
    ?? bucket.window_duration_seconds);
  if (seconds != null && seconds > 0) return seconds / 60;
  return null;
}

function codexWindowDurationMs(value: number | null): number | null {
  return value == null ? null : Math.round(value * 60_000);
}
