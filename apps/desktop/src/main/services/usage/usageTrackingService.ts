/**
 * usageTrackingService.ts
 *
 * Polls live usage data from Claude and Codex providers.
 * Scans local provider ledgers for ADE-supported runtime cost/token aggregation.
 * Computes pacing relative to provider reset windows.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { Logger } from "../logging/logger";
import type {
  AdeUsageDailyPoint,
  AdeUsageModelSummary,
  AdeUsageProviderSummary,
  AdeUsageRangePreset,
  AdeUsageStats,
  GetAdeUsageStatsArgs,
  UsageProvider,
  UsageWindow,
  UsagePacing,
  CostSnapshot,
  CostTokenBreakdown,
  ExtraUsage,
  UsageSnapshot,
} from "../../../shared/types";
import { isRecord, nowIso, getErrorMessage, safeJsonParse } from "../shared/utils";
import {
  decodeOpenCodeRegistryId,
  getModelById,
  parseLocalProviderFromModelId,
  resolveModelAlias,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import {
  clearClaudeCredentialCache,
  isClaudeTokenExpiredOrExpiring,
  isCodexTokenStale,
  readClaudeCredentials,
  readClaudeCredentialsWithRefresh,
  readCodexCredentials,
  refreshClaudeCredentials,
} from "../ai/providerCredentialSources";
import { resolveCodexExecutable } from "../ai/codexExecutable";
import { resolveCliSpawnInvocation, terminateProcessTree } from "../shared/processExecution";
import {
  ONE_HOUR_CACHE_WRITE_MULTIPLIER,
  refreshDynamicTokenPricing,
  resetDynamicTokenPricingForTest,
  resolveTokenPrice,
  setDynamicTokenPricingForTest,
  WEB_SEARCH_COST_USD,
} from "./usagePricing";
import {
  type TokenEntry,
  discoverClaudeProjectDirs,
  findJsonlFiles,
  findRecentFiles,
  optionalNumber,
  parseCopilotEvents,
  parseGeminiEntries,
  scanClaudeLogs,
  scanCodexLogs,
  scanCopilotLogs,
  scanCursorAgentLogs,
  scanCursorLogs,
  scanDroidLogs,
  scanGeminiLogs,
  scanOpenClawLogs,
  scanOpenCodeLogs,
} from "./ledgers/localUsageLedgers";

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 2 * 60_000; // 2 min
const MIN_POLL_INTERVAL_MS = 60_000;          // 1 min
const MAX_POLL_INTERVAL_MS = 15 * 60_000;     // 15 min
const COST_CACHE_TTL_MS = 10 * 60_000;        // 10 min
const CODEX_CLI_RPC_TIMEOUT_MS = 10_000;
const FORCE_REFRESH_RESPONSE_TIMEOUT_MS = 60_000;
const USAGE_SNAPSHOT_CACHE_VERSION = 2;
const USAGE_SNAPSHOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const USAGE_SNAPSHOT_CACHE_PATH = path.join(os.homedir(), ".ade", "cache", "usage-snapshot.json");
const GITHUB_STATS_CACHE_TTL_MS = 10 * 60_000;
const GITHUB_STATS_COMMAND_TIMEOUT_MS = 60_000;
const GITHUB_STATS_FAST_RESPONSE_TIMEOUT_MS = 2_500;
const GITHUB_STATS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function isBenignStdinCloseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function shouldUseSnapshotCache(): boolean {
  return process.env.VITEST !== "true" && process.env.NODE_ENV !== "test";
}

function isCostSnapshotArray(value: unknown): value is CostSnapshot[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.provider === "string");
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  return isRecord(value)
    && Array.isArray(value.windows)
    && isCostSnapshotArray(value.costs)
    && isCostSnapshotArray(value.adeCosts)
    && typeof value.lastPolledAt === "string"
    && Array.isArray(value.errors);
}

function readCachedUsageSnapshot(logger: Logger): UsageSnapshot | null {
  if (!shouldUseSnapshotCache()) return null;
  try {
    const raw = fs.readFileSync(USAGE_SNAPSHOT_CACHE_PATH, "utf8");
    const parsed = safeJsonParse<unknown>(raw, null);
    if (!isRecord(parsed) || parsed.version !== USAGE_SNAPSHOT_CACHE_VERSION || !isUsageSnapshot(parsed.snapshot)) return null;
    const generatedAt = Date.parse(parsed.snapshot.lastPolledAt);
    if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > USAGE_SNAPSHOT_CACHE_TTL_MS) return null;
    return parsed.snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.debug("usage.snapshot_cache_read_failed", { error: getErrorMessage(error) });
    }
    return null;
  }
}

async function writeCachedUsageSnapshot(snapshot: UsageSnapshot, logger: Logger): Promise<void> {
  if (!shouldUseSnapshotCache()) return;
  try {
    await fs.promises.mkdir(path.dirname(USAGE_SNAPSHOT_CACHE_PATH), { recursive: true });
    await fs.promises.writeFile(
      USAGE_SNAPSHOT_CACHE_PATH,
      JSON.stringify({ version: USAGE_SNAPSHOT_CACHE_VERSION, snapshot }),
    );
  } catch (error) {
    logger.debug("usage.snapshot_cache_write_failed", { error: getErrorMessage(error) });
  }
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

// ── HTTP Helper ──────────────────────────────────────────────────

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15_000,
  init?: { method?: string; body?: string },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: init?.method ?? "GET",
      headers,
      ...(init?.body != null ? { body: init.body } : {}),
      signal: controller.signal,
    });
    const data = await resp.json();
    return { ok: resp.ok, status: resp.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ── Window Helpers ───────────────────────────────────────────────

function computeResetsInMs(resetsAt: string): number {
  if (!resetsAt) return 0;
  return Math.max(0, new Date(resetsAt).getTime() - Date.now());
}

// ── Claude Usage Polling ─────────────────────────────────────────

interface ClaudeUsageResponse {
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

function parseClaudeWindows(data: ClaudeUsageResponse): { windows: UsageWindow[]; extraUsage: ExtraUsage | null } {
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

  // Parse extra usage (monthly spend vs limit) — values come in cents from the API
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

function parseCodexRateLimitWindows(data: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const snakeRateLimit = isRecord(data.rate_limit) ? data.rate_limit : null;
  const camelRateLimits = isRecord(data.rateLimits) ? data.rateLimits : null;

  for (const [key, windowType] of [["primary", "five_hour"], ["secondary", "weekly"]] as const) {
    const snakeKey = key === "primary" ? "primary_window" : "secondary_window";
    const snakeBucket = snakeRateLimit && isRecord(snakeRateLimit[snakeKey]) ? snakeRateLimit[snakeKey] : null;
    const camelBucket = camelRateLimits && isRecord(camelRateLimits[key]) ? camelRateLimits[key] : null;
    const directBucket = isRecord(data[snakeKey]) ? data[snakeKey] : isRecord(data[key]) ? data[key] : null;
    const bucket = snakeBucket ?? camelBucket ?? directBucket;
    if (!bucket) continue;
    const resetsAt = codexResetAt(bucket.reset_at ?? bucket.resets_at ?? bucket.resetsAt);
    windows.push({
      provider: "codex",
      windowType,
      percentUsed: usagePercent(bucket),
      resetsAt,
      resetsInMs: computeResetsInMs(resetsAt),
    });
  }

  return windows;
}

// Cursor usage polling was removed in 2026-05 — Cursor only exposes
// team-admin endpoints (/teams/spend, /teams/filtered-usage-events,
// /teams/daily-usage-data) with no personal-user surface, so the per-user
// drawer state could never be meaningful for the typical ADE user.

async function pollClaudeUsage(logger: Logger): Promise<{ windows: UsageWindow[]; extraUsage: ExtraUsage | null; errors: string[] }> {
  const windows: UsageWindow[] = [];
  const errors: string[] = [];

  const creds = await readClaudeCredentialsWithRefresh(logger);
  if (!creds) {
    errors.push("claude: no credentials found");
    return { windows, extraUsage: null, errors };
  }

  try {
    const result = await fetchJson(CLAUDE_USAGE_URL, {
      Authorization: `Bearer ${creds.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    });

    if (!result.ok) {
      // On 401, try one refresh cycle and retry
      if (result.status === 401 && creds.refreshToken) {
        logger.info("usage.token_refresh.401_retry");
        clearClaudeCredentialCache();
        const refreshed = await refreshClaudeCredentials(creds.refreshToken);
        if (refreshed) {
          const retry = await fetchJson(CLAUDE_USAGE_URL, {
            Authorization: `Bearer ${refreshed.accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
          });
          if (retry.ok) {
            const parsed = parseClaudeWindows(retry.data as ClaudeUsageResponse);
            return { windows: parsed.windows, extraUsage: parsed.extraUsage, errors };
          }
        }
      }
      errors.push(`claude: API returned ${result.status}`);
      return { windows, extraUsage: null, errors };
    }

    const parsed = parseClaudeWindows(result.data as ClaudeUsageResponse);
    windows.push(...parsed.windows);
    if (parsed.windows.length === 0) {
      errors.push("claude: usage response contained no recognized windows");
      logger.warn("usage.poll.claude_unrecognized_shape", {
        keys: isRecord(result.data) ? Object.keys(result.data).slice(0, 12) : [],
      });
    }
    return { windows, extraUsage: parsed.extraUsage, errors };
  } catch (err) {
    errors.push(`claude: ${getErrorMessage(err)}`);
  }

  return { windows, extraUsage: null, errors };
}

// ── Codex Usage Polling ──────────────────────────────────────────

async function pollCodexUsage(logger: Logger): Promise<{ windows: UsageWindow[]; errors: string[] }> {
  const windows: UsageWindow[] = [];
  const errors: string[] = [];

  const creds = await readCodexCredentials();
  if (!creds) {
    errors.push("codex: no credentials found");
    return { windows, errors };
  }

  // Try HTTP API first — skip the stale-token gate; the API will 401 if
  // the token is truly dead, and tokens often remain valid well past the
  // local last_refresh timestamp.
  try {
    const result = await fetchJson(CODEX_USAGE_URL, {
      Authorization: `Bearer ${creds.accessToken}`,
    });

    if (result.ok && result.data && typeof result.data === "object") {
      windows.push(...parseCodexRateLimitWindows(result.data as Record<string, unknown>));
      if (windows.length > 0) return { windows, errors };
    }
  } catch {
    // Fall through to CLI RPC
  }

  // Fallback: Codex CLI JSON-RPC
  try {
    const rpcResult = await pollCodexViaCliRpc(logger);
    windows.push(...rpcResult.windows);
    if (rpcResult.errors.length > 0) errors.push(...rpcResult.errors);
  } catch (err) {
    errors.push(`codex: CLI RPC failed: ${getErrorMessage(err)}`);
  }

  if (windows.length === 0 && errors.length === 0) {
    errors.push("codex: usage response contained no recognized windows");
  }

  return { windows, errors };
}

async function pollCodexViaCliRpc(logger: Logger): Promise<{ windows: UsageWindow[]; errors: string[] }> {
  const windows: UsageWindow[] = [];
  const errors: string[] = [];

  try {
    const initPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
        clientInfo: {
          name: "ade-codex-rpc-client",
          title: "Codex",
          version: "0.47.0",
        },
      },
    });

    const initializedPayload = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    const rateLimitsPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "account/rateLimits/read",
      params: {},
    });

    const combined = `${initPayload}\n${initializedPayload}\n${rateLimitsPayload}\n`;

    const codexPath = resolveCodexExecutable().path;
    const env = { ...process.env };
    const invocation = resolveCliSpawnInvocation(
      codexPath,
      ["-s", "read-only", "-a", "untrusted", "app-server"],
      env,
    );

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          callback();
        };
        const child = spawn(invocation.command, invocation.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });

        let stdout = "";
        let stderr = "";
        const maxStdout = 50_000;
        const maxStderr = 10_000;
        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdout.length >= maxStdout) return;
          const s = chunk.toString("utf8");
          stdout += s.slice(0, maxStdout - stdout.length);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length >= maxStderr) return;
          const s = chunk.toString("utf8");
          stderr += s.slice(0, maxStderr - stderr.length);
        });

        timer = setTimeout(() => {
          terminateProcessTree(child, "SIGKILL", (detail) => {
            logger.warn("usage.poll.codex_cli_rpc_taskkill_failed", {
              ...detail,
              error: detail.error ? getErrorMessage(detail.error) : null,
            });
          });
          logger.warn("usage.poll.codex_cli_rpc_timeout", {
            timeoutMs: CODEX_CLI_RPC_TIMEOUT_MS,
          });
          finish(() => reject(new Error(`codex CLI RPC timed out after ${CODEX_CLI_RPC_TIMEOUT_MS}ms`)));
        }, CODEX_CLI_RPC_TIMEOUT_MS);

        child.on("error", (error) => {
          logger.warn("usage.poll.codex_cli_rpc_spawn_failed", {
            error: getErrorMessage(error),
          });
          finish(() => reject(error));
        });
        child.on("close", (code) => {
          finish(() => resolve({ stdout, stderr, exitCode: code }));
        });
        child.stdin?.on("error", (error) => {
          if (isBenignStdinCloseError(error)) return;
          logger.warn("usage.poll.codex_cli_rpc_stdin_failed", {
            error: getErrorMessage(error),
          });
          finish(() => reject(error));
        });

        try {
          child.stdin?.write(combined);
          child.stdin?.end();
        } catch (err) {
          if (isBenignStdinCloseError(err)) return;
          logger.warn("usage.poll.codex_cli_rpc_stdin_failed", {
            error: getErrorMessage(err),
          });
          finish(() => reject(err));
        }
      },
    );

    if (result.exitCode !== 0) {
      logger.warn("usage.poll.codex_cli_rpc_non_zero_exit", {
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
      errors.push("codex: CLI RPC exited with non-zero code");
      return { windows, errors };
    }

    // Parse JSONL responses
    const lines = result.stdout.split("\n").filter((line: string) => line.trim());
    for (const line of lines) {
      const parsed = safeJsonParse<Record<string, unknown>>(line, {});
      if (!parsed.result || typeof parsed.result !== "object") continue;
      const res = parsed.result as Record<string, unknown>;

      const parsedWindows = parseCodexRateLimitWindows(res);
      if (parsedWindows.length > 0) {
        windows.push(...parsedWindows);
      }
    }
  } catch (err) {
    errors.push(`codex: CLI RPC error: ${getErrorMessage(err)}`);
  }

  return { windows, errors };
}

// ── Local Cost Scanning ──────────────────────────────────────────

function bucketDaily7d(entries: TokenEntry[], nowMs: number): number[] {
  const buckets = new Array<number>(7).fill(0);
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const oldestStart = todayStartMs - 6 * 86_400_000;
  for (const entry of entries) {
    if (entry.timestamp < oldestStart) continue;
    if (entry.timestamp > nowMs) continue;
    const dayIndex = Math.floor((entry.timestamp - oldestStart) / 86_400_000);
    const bucketIndex = Math.min(6, Math.max(0, dayIndex));
    buckets[bucketIndex] += entry.inputTokens + entry.outputTokens + entry.cachedTokens + toNonNegativeInt(entry.cacheWriteTokens);
  }
  return buckets;
}

type TokenBreakdown = Record<string, CostTokenBreakdown & { cacheWrite: number; costUsd: number }>;
type DailyTokenBreakdown = Record<string, number>;
type DailyModelTokenBreakdown = Record<string, TokenBreakdown>;

function addTokenBreakdownEntry(breakdown: TokenBreakdown, entry: TokenEntry): void {
  const modelKey = entry.model || "unknown";
  if (!breakdown[modelKey]) {
    breakdown[modelKey] = { input: 0, output: 0, cached: 0, cacheWrite: 0, costUsd: 0 };
  }
  breakdown[modelKey].input += entry.inputTokens;
  breakdown[modelKey].output += entry.outputTokens;
  breakdown[modelKey].cached += entry.cachedTokens;
  breakdown[modelKey].cacheWrite += toNonNegativeInt(entry.cacheWriteTokens);
  breakdown[modelKey].costUsd += calculateTokenEntryCost(entry);
}

function addDailyTokenEntry(breakdown: DailyTokenBreakdown, entry: TokenEntry): void {
  const date = new Date(entry.timestamp).toISOString().slice(0, 10);
  const tokens = entry.inputTokens + entry.outputTokens + entry.cachedTokens + toNonNegativeInt(entry.cacheWriteTokens);
  breakdown[date] = (breakdown[date] ?? 0) + tokens;
}

function addDailyModelTokenEntry(breakdown: DailyModelTokenBreakdown, entry: TokenEntry): void {
  const date = new Date(entry.timestamp).toISOString().slice(0, 10);
  if (!breakdown[date]) breakdown[date] = {};
  addTokenBreakdownEntry(breakdown[date]!, entry);
}

function calculateTokenEntryCost(entry: TokenEntry): number {
  const override = optionalNumber(entry.costOverrideUsd);
  if (override != null && override >= 0) return override;
  const price = resolveTokenPrice(entry.model);
  const billableInputTokens = toNonNegativeInt(entry.billableInputTokens ?? entry.inputTokens);
  const cacheWriteTokens = toNonNegativeInt(entry.cacheWriteTokens);
  const oneHourCacheWriteTokens = Math.min(toNonNegativeInt(entry.oneHourCacheWriteTokens), cacheWriteTokens);
  const fiveMinuteCacheWriteTokens = Math.max(0, cacheWriteTokens - oneHourCacheWriteTokens);
  const billableOutputTokens = toNonNegativeInt(entry.billableOutputTokens ?? entry.outputTokens);
  const billableCachedTokens = toNonNegativeInt(entry.billableCachedTokens ?? entry.cachedTokens);
  const webSearchRequests = toNonNegativeInt(entry.webSearchRequests);
  return (
    billableInputTokens * price.input +
    billableOutputTokens * price.output +
    fiveMinuteCacheWriteTokens * price.cacheWrite +
    oneHourCacheWriteTokens * price.cacheWrite * ONE_HOUR_CACHE_WRITE_MULTIPLIER +
    billableCachedTokens * price.cacheRead +
    webSearchRequests * WEB_SEARCH_COST_USD
  );
}

function aggregateCosts(
  entries: TokenEntry[],
  provider: string,
): CostSnapshot {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const sevenDayStart = new Date(todayStart);
  sevenDayStart.setDate(sevenDayStart.getDate() - 6);
  const sevenDaysAgo = sevenDayStart.getTime();
  const thirtyDayStart = new Date(todayStart);
  thirtyDayStart.setDate(thirtyDayStart.getDate() - 29);
  const thirtyDaysAgo = thirtyDayStart.getTime();

  let last30dCostUsd = 0;
  let todayCostUsd = 0;
  let sevenDayCostUsd = 0;
  let allCostUsd = 0;
  const allBreakdown: TokenBreakdown = {};
  const thirtyDayBreakdown: TokenBreakdown = {};
  const todayBreakdown: TokenBreakdown = {};
  const sevenDayBreakdown: TokenBreakdown = {};
  const allDailyTokens: DailyTokenBreakdown = {};
  const thirtyDayDailyTokens: DailyTokenBreakdown = {};
  const todayDailyTokens: DailyTokenBreakdown = {};
  const sevenDayDailyTokens: DailyTokenBreakdown = {};
  const allDailyModelTokens: DailyModelTokenBreakdown = {};
  const thirtyDayDailyModelTokens: DailyModelTokenBreakdown = {};
  const todayDailyModelTokens: DailyModelTokenBreakdown = {};
  const sevenDayDailyModelTokens: DailyModelTokenBreakdown = {};

  for (const entry of entries) {
    const cost = calculateTokenEntryCost(entry);
    allCostUsd += cost;
    addTokenBreakdownEntry(allBreakdown, entry);
    addDailyTokenEntry(allDailyTokens, entry);
    addDailyModelTokenEntry(allDailyModelTokens, entry);

    if (entry.timestamp >= thirtyDaysAgo) {
      last30dCostUsd += cost;
      addTokenBreakdownEntry(thirtyDayBreakdown, entry);
      addDailyTokenEntry(thirtyDayDailyTokens, entry);
      addDailyModelTokenEntry(thirtyDayDailyModelTokens, entry);
    }
    if (entry.timestamp >= todayStartMs) {
      todayCostUsd += cost;
      addTokenBreakdownEntry(todayBreakdown, entry);
      addDailyTokenEntry(todayDailyTokens, entry);
      addDailyModelTokenEntry(todayDailyModelTokens, entry);
    }

    if (entry.timestamp >= sevenDaysAgo) {
      sevenDayCostUsd += cost;
      addTokenBreakdownEntry(sevenDayBreakdown, entry);
      addDailyTokenEntry(sevenDayDailyTokens, entry);
      addDailyModelTokenEntry(sevenDayDailyModelTokens, entry);
    }
  }

  return {
    provider,
    last30dCostUsd: Math.round(last30dCostUsd * 100) / 100,
    todayCostUsd: Math.round(todayCostUsd * 100) / 100,
    costUsdByPreset: {
      today: Math.round(todayCostUsd * 100) / 100,
      "7d": Math.round(sevenDayCostUsd * 100) / 100,
      "30d": Math.round(last30dCostUsd * 100) / 100,
      all: Math.round(allCostUsd * 100) / 100,
    },
    tokenBreakdown: thirtyDayBreakdown,
    tokenBreakdownByPreset: {
      today: todayBreakdown,
      "7d": sevenDayBreakdown,
      "30d": thirtyDayBreakdown,
      all: allBreakdown,
    },
    dailyTokenBreakdownByPreset: {
      today: todayDailyModelTokens,
      "7d": sevenDayDailyModelTokens,
      "30d": thirtyDayDailyModelTokens,
      all: allDailyModelTokens,
    },
    dailyTokensByPreset: {
      today: todayDailyTokens,
      "7d": sevenDayDailyTokens,
      "30d": thirtyDayDailyTokens,
      all: allDailyTokens,
    },
  };
}

// ── Stats Aggregation ────────────────────────────────────────────

type ResolvedAdeUsageRange = {
  preset: AdeUsageRangePreset;
  since: string | null;
  until: string;
};

function toFiniteNumber(value: unknown): number {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toNonNegativeInt(value: unknown): number {
  return Math.max(0, Math.floor(toFiniteNumber(value)));
}

function startOfLocalDayIso(nowMs: number): string {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function startOfLocalDayOffsetIso(nowMs: number, daysBack: number): string {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - Math.max(0, daysBack));
  return date.toISOString();
}

function normalizePreset(value: unknown): AdeUsageRangePreset {
  if (value === "today" || value === "7d" || value === "30d" || value === "all") {
    return value;
  }
  return "7d";
}

function validIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function resolveAdeUsageRange(args: GetAdeUsageStatsArgs | undefined, nowMs: number): ResolvedAdeUsageRange {
  const preset = normalizePreset(args?.preset);
  const until = validIsoOrNull(args?.until ?? null) ?? new Date(nowMs).toISOString();
  const untilMs = Date.parse(until);
  const explicitSince = validIsoOrNull(args?.since ?? null);
  if (explicitSince) {
    return {
      preset,
      since: Date.parse(explicitSince) > untilMs ? until : explicitSince,
      until,
    };
  }

  switch (preset) {
    case "today":
      return { preset, since: startOfLocalDayIso(untilMs), until };
    case "30d":
      return { preset, since: startOfLocalDayOffsetIso(untilMs, 29), until };
    case "all":
      return { preset, since: null, until };
    case "7d":
    default:
      return { preset: "7d", since: startOfLocalDayOffsetIso(untilMs, 6), until };
  }
}

type ProviderModelAggregation = {
  providers: Map<string, AdeUsageProviderSummary>;
  models: Map<string, AdeUsageModelSummary>;
};

function normalizeUsageLabel(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : fallback;
}

function resolveUsageModelDescriptor(model: unknown): ModelDescriptor | null {
  const text = normalizeUsageLabel(model, "");
  if (!text) return null;
  return getModelById(text) ?? resolveModelAlias(text) ?? null;
}

function displayModelName(model: unknown): string {
  const modelText = normalizeUsageLabel(model, "unknown");
  const descriptor = resolveUsageModelDescriptor(modelText);
  if (descriptor) return descriptor.displayName || descriptor.providerModelId || descriptor.id;

  const decodedOpenCode = decodeOpenCodeRegistryId(modelText);
  if (decodedOpenCode) return decodedOpenCode.openCodeModelId;

  const localProvider = parseLocalProviderFromModelId(modelText);
  if (localProvider) return modelText.slice(localProvider.length + 1) || modelText;

  return modelText;
}

function createProviderModelAggregation(): ProviderModelAggregation {
  return { providers: new Map(), models: new Map() };
}

function addProviderModelUsage(
  aggregation: ProviderModelAggregation,
  args: {
    provider: string;
    model?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    calls?: number;
    costUsd?: number;
    rangeCostUsd?: number;
    todayCostUsd?: number;
    last30dCostUsd?: number;
  },
): void {
  const provider = normalizeUsageLabel(args.provider, "unknown");
  const inputTokens = toNonNegativeInt(args.inputTokens);
  const outputTokens = toNonNegativeInt(args.outputTokens);
  const cachedTokens = toNonNegativeInt(args.cachedTokens);
  const totalTokens = inputTokens + outputTokens + cachedTokens;
  const costUsd = Math.max(0, toFiniteNumber(args.costUsd));
  const rangeCostUsd = Math.max(0, toFiniteNumber(args.rangeCostUsd ?? args.costUsd));
  const todayCostUsd = Math.max(0, toFiniteNumber(args.todayCostUsd));
  const last30dCostUsd = Math.max(0, toFiniteNumber(args.last30dCostUsd));
  if (inputTokens + outputTokens + cachedTokens === 0 && costUsd + rangeCostUsd + todayCostUsd + last30dCostUsd === 0) {
    return;
  }

  let providerSummary = aggregation.providers.get(provider);
  if (!providerSummary) {
    providerSummary = {
      provider,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      rangeCostUsd: 0,
      todayCostUsd: 0,
      last30dCostUsd: 0,
    };
    aggregation.providers.set(provider, providerSummary);
  }
  providerSummary.inputTokens += inputTokens;
  providerSummary.outputTokens += outputTokens;
  providerSummary.cachedTokens += cachedTokens;
  providerSummary.totalTokens += totalTokens;
  providerSummary.rangeCostUsd = Math.round((providerSummary.rangeCostUsd + rangeCostUsd) * 100) / 100;
  providerSummary.todayCostUsd = Math.round((providerSummary.todayCostUsd + todayCostUsd) * 100) / 100;
  providerSummary.last30dCostUsd = Math.round((providerSummary.last30dCostUsd + last30dCostUsd + costUsd) * 100) / 100;

  const model = normalizeUsageLabel(args.model, "");
  if (!model) return;

  const modelKey = `${provider}\u0000${model}`;
  let modelSummary = aggregation.models.get(modelKey);
  if (!modelSummary) {
    modelSummary = {
      provider,
      model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    aggregation.models.set(modelKey, modelSummary);
  }
  modelSummary.calls += toNonNegativeInt(args.calls);
  modelSummary.inputTokens += inputTokens;
  modelSummary.outputTokens += outputTokens;
  modelSummary.cachedTokens += cachedTokens;
  modelSummary.totalTokens += totalTokens;
  modelSummary.costUsd = Math.round((modelSummary.costUsd + rangeCostUsd) * 100) / 100;
}

function sortedProviderModelSummaries(aggregation: ProviderModelAggregation): {
  providers: AdeUsageProviderSummary[];
  models: AdeUsageModelSummary[];
} {
  const providers = Array.from(aggregation.providers.values())
    .sort((a, b) => (b.totalTokens - a.totalTokens) || (b.last30dCostUsd - a.last30dCostUsd) || a.provider.localeCompare(b.provider));
  const models = Array.from(aggregation.models.values())
    .sort((a, b) => (b.totalTokens - a.totalTokens) || (b.costUsd - a.costUsd) || a.model.localeCompare(b.model));
  return { providers, models };
}

function addSnapshotProviderUsage(
  aggregation: ProviderModelAggregation,
  snapshot: UsageSnapshot,
  range: ResolvedAdeUsageRange,
  exactRange: boolean,
): void {
  addCostSnapshotsProviderUsage(aggregation, snapshot.costs, range, exactRange);
}

function addCostSnapshotsProviderUsage(
  aggregation: ProviderModelAggregation,
  costs: CostSnapshot[],
  range: ResolvedAdeUsageRange,
  exactRange: boolean,
): void {
  for (const cost of costs) {
    const tokenBreakdown = exactRange
      ? tokenBreakdownForExactRange(cost, range)
      : cost.tokenBreakdownByPreset?.[range.preset] ?? cost.tokenBreakdown;
    const providerTotalTokens = Object.values(tokenBreakdown).reduce((sum, entry) => (
      sum + toNonNegativeInt(entry.input) + toNonNegativeInt(entry.output) + toNonNegativeInt(entry.cached) + toNonNegativeInt(entry.cacheWrite)
    ), 0);
    const rangeCostUsd = Math.max(0, toFiniteNumber(
      exactRange
        ? sumTokenBreakdownCost(tokenBreakdown)
        : cost.costUsdByPreset?.[range.preset] ??
          (range.preset === "today" ? cost.todayCostUsd : cost.last30dCostUsd),
    ));
    for (const [model, tokens] of Object.entries(tokenBreakdown)) {
      const modelInput = toNonNegativeInt(tokens.input);
      const modelOutput = toNonNegativeInt(tokens.output);
      const modelCached = toNonNegativeInt(tokens.cached) + toNonNegativeInt(tokens.cacheWrite);
      const share = providerTotalTokens > 0 ? (modelInput + modelOutput + modelCached) / providerTotalTokens : 0;
      const modelCostUsd = Math.max(0, toFiniteNumber(tokens.costUsd ?? rangeCostUsd * share));
      addProviderModelUsage(aggregation, {
        provider: cost.provider,
        model: displayModelName(model),
        inputTokens: modelInput,
        outputTokens: modelOutput,
        cachedTokens: modelCached,
        rangeCostUsd: modelCostUsd,
        todayCostUsd: cost.todayCostUsd * share,
        last30dCostUsd: cost.last30dCostUsd * share,
      });
    }
  }
}

function tokenBreakdownForExactRange(cost: CostSnapshot, range: ResolvedAdeUsageRange): Record<string, CostTokenBreakdown> {
  const dailyBreakdown = cost.dailyTokenBreakdownByPreset?.all;
  if (!dailyBreakdown) return {};
  const selected: TokenBreakdown = {};
  for (const [date, breakdown] of Object.entries(dailyBreakdown)) {
    if (!dateIntersectsRange(date, range)) continue;
    for (const [model, entry] of Object.entries(breakdown)) {
      if (!selected[model]) selected[model] = { input: 0, output: 0, cached: 0, cacheWrite: 0, costUsd: 0 };
      selected[model].input += toNonNegativeInt(entry.input);
      selected[model].output += toNonNegativeInt(entry.output);
      selected[model].cached += toNonNegativeInt(entry.cached);
      selected[model].cacheWrite += toNonNegativeInt(entry.cacheWrite);
      selected[model].costUsd += Math.max(0, toFiniteNumber(entry.costUsd));
    }
  }
  return selected;
}

function sumTokenBreakdownCost(breakdown: Record<string, CostTokenBreakdown>): number {
  return Math.round(Object.values(breakdown).reduce((sum, entry) => sum + Math.max(0, toFiniteNumber(entry.costUsd)), 0) * 100) / 100;
}

function dateIntersectsRange(date: string, range: ResolvedAdeUsageRange): boolean {
  const dayStart = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(dayStart)) return false;
  const dayEnd = dayStart + 86_400_000 - 1;
  if (range.since && dayEnd < Date.parse(range.since)) return false;
  return dayStart <= Date.parse(range.until);
}

function makeDailySkeleton(range: ResolvedAdeUsageRange, nowMs: number): AdeUsageDailyPoint[] {
  const until = new Date(range.until);
  const untilMs = Number.isFinite(until.getTime()) ? until.getTime() : nowMs;
  const maxDays =
    range.preset === "today" ? 1 :
    range.preset === "7d" ? 7 :
    range.preset === "all" ? 90 :
    30;
  const startMs = range.since
    ? Math.max(Date.parse(range.since), untilMs - (maxDays - 1) * 86_400_000)
    : untilMs - (maxDays - 1) * 86_400_000;
  const start = new Date(startMs);
  start.setHours(0, 0, 0, 0);

  const points: AdeUsageDailyPoint[] = [];
  for (let index = 0; index < maxDays; index += 1) {
    const date = new Date(start.getTime() + index * 86_400_000);
    if (date.getTime() > untilMs + 86_400_000) break;
    points.push({
      date: date.toISOString().slice(0, 10),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      commits: 0,
      prs: 0,
      insertions: 0,
      deletions: 0,
      filesChanged: 0,
      sessions: 0,
    });
  }
  return points;
}

function mergeSnapshotDailyTokens(
  points: AdeUsageDailyPoint[],
  costs: CostSnapshot[],
  range: ResolvedAdeUsageRange,
  exactRange: boolean,
): void {
  const byDate = new Map(points.map((point) => [point.date, point]));
  for (const cost of costs) {
    const dailyTokens = exactRange
      ? cost.dailyTokensByPreset?.all ?? {}
      : cost.dailyTokensByPreset?.[range.preset] ?? {};
    for (const [date, value] of Object.entries(dailyTokens)) {
      if (exactRange && !dateIntersectsRange(date, range)) continue;
      const point = byDate.get(date);
      if (!point) continue;
      const tokens = toNonNegativeInt(value);
      point.inputTokens += tokens;
      point.totalTokens += tokens;
    }
  }
}

function summarizeObservedProviderUsage(providers: AdeUsageProviderSummary[]): {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costRangeUsd: number;
  cost30dUsd: number;
  costTodayUsd: number;
} {
  const inputTokens = providers.reduce((sum, provider) => sum + provider.inputTokens, 0);
  const outputTokens = providers.reduce((sum, provider) => sum + provider.outputTokens, 0);
  const cachedTokens = providers.reduce((sum, provider) => sum + provider.cachedTokens, 0);
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens + cachedTokens,
    costRangeUsd: Math.round(providers.reduce((sum, provider) => sum + provider.rangeCostUsd, 0) * 100) / 100,
    cost30dUsd: Math.round(providers.reduce((sum, provider) => sum + provider.last30dCostUsd, 0) * 100) / 100,
    costTodayUsd: Math.round(providers.reduce((sum, provider) => sum + provider.todayCostUsd, 0) * 100) / 100,
  };
}

type GitHubDailyPoint = {
  date: string;
  commits: number;
  prs: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
};

type GitHubActivityStats = {
  repo: string | null;
  available: boolean;
  fetchedAt: string | null;
  error: string | null;
  commitsCreated: number;
  prsTracked: number;
  prsOpen: number;
  prsMerged: number;
  prsClosed: number;
  prAdditions: number;
  prDeletions: number;
  filesChanged: number;
  daily: GitHubDailyPoint[];
};

type GitHubPullRequestRow = {
  number?: number;
  state?: string | null;
  createdAt?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  author?: { login?: string | null } | null;
};

const EMPTY_GITHUB_STATS: GitHubActivityStats = {
  repo: null,
  available: false,
  fetchedAt: null,
  error: null,
  commitsCreated: 0,
  prsTracked: 0,
  prsOpen: 0,
  prsMerged: 0,
  prsClosed: 0,
  prAdditions: 0,
  prDeletions: 0,
  filesChanged: 0,
  daily: [],
};

function makeEmptyGithubStats(error: string | null = null, repo: string | null = null): GitHubActivityStats {
  return {
    ...EMPTY_GITHUB_STATS,
    repo,
    error,
  };
}

function runBufferedCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const maxOutputBytes = options.maxOutputBytes ?? GITHUB_STATS_MAX_OUTPUT_BYTES;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`${command} timed out`)));
    }, options.timeoutMs ?? GITHUB_STATS_COMMAND_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) {
        child.kill("SIGTERM");
        finish(() => reject(new Error(`${command} produced too much output`)));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
      });
    });
  });
}

function parseGithubRepoJson(raw: string): string | null {
  const parsed = safeJsonParse<unknown>(raw.trim(), null);
  if (!isRecord(parsed)) return null;
  const owner = isRecord(parsed.owner) ? parsed.owner.login : parsed.owner;
  const name = parsed.name;
  if (typeof owner !== "string" || typeof name !== "string" || !owner || !name) return null;
  return `${owner}/${name}`;
}

function parseGithubViewerLogin(raw: string): string | null {
  const parsed = safeJsonParse<unknown>(raw.trim(), null);
  if (!isRecord(parsed) || typeof parsed.login !== "string" || !parsed.login.trim()) return null;
  return parsed.login.trim();
}

function parseGithubPullRequestRows(raw: string, viewer: string): GitHubPullRequestRow[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => safeJsonParse<unknown>(line, null))
    .filter(isRecord)
    .filter((row) => isRecord(row.author) && row.author.login === viewer) as GitHubPullRequestRow[];
}

function parseGithubCommitDates(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t")[1] ?? "")
    .filter((date) => Number.isFinite(Date.parse(date)));
}

function timestampInRange(value: string | null | undefined, range: ResolvedAdeUsageRange): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  if (range.since && timestamp < Date.parse(range.since)) return false;
  return timestamp <= Date.parse(range.until);
}

function githubCommitDateArgs(range: ResolvedAdeUsageRange): string[] {
  const args: string[] = [];
  if (range.since) args.push("-F", `since=${range.since}`);
  args.push("-F", `until=${range.until}`);
  return args;
}

function githubRepoParts(repo: string): { owner: string; name: string } | null {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) return null;
  return { owner, name };
}

function githubPullRequestGraphqlQuery(): string {
  return [
    "query($owner: String!, $name: String!, $endCursor: String) {",
    "  repository(owner: $owner, name: $name) {",
    "    pullRequests(first: 100, after: $endCursor, orderBy: { field: CREATED_AT, direction: DESC }) {",
    "      pageInfo { hasNextPage endCursor }",
    "      nodes {",
    "        number state createdAt closedAt mergedAt additions deletions changedFiles",
    "        author { login }",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");
}

function dateKeyFromIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function addGithubDaily(
  byDate: Map<string, GitHubDailyPoint>,
  date: string | null,
  patch: Partial<Omit<GitHubDailyPoint, "date">>,
): void {
  if (!date) return;
  const point = byDate.get(date) ?? {
    date,
    commits: 0,
    prs: 0,
    insertions: 0,
    deletions: 0,
    filesChanged: 0,
  };
  point.commits += toNonNegativeInt(patch.commits);
  point.prs += toNonNegativeInt(patch.prs);
  point.insertions += toNonNegativeInt(patch.insertions);
  point.deletions += toNonNegativeInt(patch.deletions);
  point.filesChanged += toNonNegativeInt(patch.filesChanged);
  byDate.set(date, point);
}

async function scanGithubActivityStats(projectRoot: string | null | undefined, range: ResolvedAdeUsageRange): Promise<GitHubActivityStats> {
  if (!projectRoot) return makeEmptyGithubStats("No project root is available.");
  try {
    const repoRaw = await runBufferedCommand("gh", ["repo", "view", "--json", "owner,name"], {
      cwd: projectRoot,
      timeoutMs: 10_000,
    });
    const repo = parseGithubRepoJson(repoRaw);
    if (!repo) return makeEmptyGithubStats("Unable to resolve the GitHub repository.", null);

	    const viewerRaw = await runBufferedCommand("gh", ["api", "user", "--cache", "10m"], {
	      cwd: projectRoot,
	      timeoutMs: 10_000,
	    });
	    const viewer = parseGithubViewerLogin(viewerRaw);
	    if (!viewer) return makeEmptyGithubStats("Unable to resolve the GitHub user.", repo);
	    const repoParts = githubRepoParts(repo);
	    if (!repoParts) return makeEmptyGithubStats("Unable to resolve the GitHub repository.", repo);

	    const [prRaw, commitRaw] = await Promise.all([
	      runBufferedCommand(
	        "gh",
	        [
	          "api",
	          "graphql",
	          "--paginate",
	          "-F",
	          `owner=${repoParts.owner}`,
	          "-F",
	          `name=${repoParts.name}`,
	          "-f",
	          `query=${githubPullRequestGraphqlQuery()}`,
	          "--jq",
	          ".data.repository.pullRequests.nodes[] | @json",
	        ],
	        { cwd: projectRoot },
	      ),
	      runBufferedCommand(
	        "gh",
	        [
	          "api",
	          `repos/${repo}/commits`,
	          "--method",
	          "GET",
	          "--cache",
	          "10m",
	          "-F",
	          `author=${viewer}`,
	          ...githubCommitDateArgs(range),
	          "--paginate",
	          "--jq",
	          ".[] | [.sha, .commit.author.date] | @tsv",
	        ],
	        { cwd: projectRoot },
	      ),
	    ]);

	    const dailyByDate = new Map<string, GitHubDailyPoint>();
	    const prs = parseGithubPullRequestRows(prRaw, viewer);
	    const mergedPrs = prs.filter((pr) => timestampInRange(pr.mergedAt, range));
	    const closedPrs = prs.filter((pr) => timestampInRange(pr.closedAt, range));
	    const prsCreatedInRange = prs.filter((pr) => timestampInRange(pr.createdAt, range));
    const commitsInRange = parseGithubCommitDates(commitRaw).filter((date) => timestampInRange(date, range));
    for (const date of commitsInRange) {
      addGithubDaily(dailyByDate, dateKeyFromIso(date), { commits: 1 });
    }

    for (const pr of prsCreatedInRange) {
      addGithubDaily(dailyByDate, dateKeyFromIso(pr.createdAt), {
        prs: 1,
      });
    }

    for (const pr of mergedPrs) {
      addGithubDaily(dailyByDate, dateKeyFromIso(pr.mergedAt), {
        insertions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        filesChanged: pr.changedFiles ?? 0,
      });
    }

    const prsMerged = mergedPrs.length;
    const prsClosed = closedPrs.filter((pr) => String(pr.state ?? "").toUpperCase() === "CLOSED").length;
    return {
      repo,
      available: true,
      fetchedAt: nowIso(),
      error: null,
      commitsCreated: commitsInRange.length,
      prsTracked: prsCreatedInRange.length,
      prsOpen: prsCreatedInRange.filter((pr) => String(pr.state ?? "").toUpperCase() === "OPEN").length,
      prsMerged,
      prsClosed,
      prAdditions: mergedPrs.reduce((sum, pr) => sum + toNonNegativeInt(pr.additions), 0),
      prDeletions: mergedPrs.reduce((sum, pr) => sum + toNonNegativeInt(pr.deletions), 0),
      filesChanged: mergedPrs.reduce((sum, pr) => sum + toNonNegativeInt(pr.changedFiles), 0),
      daily: Array.from(dailyByDate.values()).sort((a, b) => a.date.localeCompare(b.date)),
    };
  } catch (error) {
    return makeEmptyGithubStats(getErrorMessage(error), null);
  }
}

function mergeGithubDaily(points: AdeUsageDailyPoint[], githubStats: GitHubActivityStats | null | undefined): void {
  if (!githubStats) return;
  const byDate = new Map(points.map((point) => [point.date, point]));
  for (const row of githubStats.daily) {
    const point = byDate.get(row.date);
    if (!point) continue;
    point.commits += toNonNegativeInt(row.commits);
    point.prs += toNonNegativeInt(row.prs);
    point.insertions += toNonNegativeInt(row.insertions);
    point.deletions += toNonNegativeInt(row.deletions);
    point.filesChanged += toNonNegativeInt(row.filesChanged);
  }
}

function collectAdeUsageStats({
  snapshot,
  githubStats,
  args,
  nowMs = Date.now(),
}: {
  snapshot: UsageSnapshot;
  githubStats?: GitHubActivityStats | null;
  args?: GetAdeUsageStatsArgs;
  nowMs?: number;
}): AdeUsageStats {
  const range = resolveAdeUsageRange(args, nowMs);
  const exactProviderRange = Boolean(args?.since || args?.until);
  const providerModelAggregation = createProviderModelAggregation();
  addSnapshotProviderUsage(providerModelAggregation, snapshot, range, exactProviderRange);
  const { providers, models } = sortedProviderModelSummaries(providerModelAggregation);
  const fallbackObserved = summarizeObservedProviderUsage(providers);
  const runtimeDaily = makeDailySkeleton(range, nowMs);
  mergeSnapshotDailyTokens(runtimeDaily, snapshot.costs, range, exactProviderRange);
  const resolvedGithubStats = githubStats ?? EMPTY_GITHUB_STATS;
  mergeGithubDaily(runtimeDaily, resolvedGithubStats);

  const fallback: AdeUsageStats = {
    generatedAt: new Date(nowMs).toISOString(),
    range,
    summary: {
      totalTokens: fallbackObserved.totalTokens,
      tokenTotalSource: "provider_logs",
      observedProviderTokens: fallbackObserved.totalTokens,
      observedProviderInputTokens: fallbackObserved.inputTokens,
      observedProviderOutputTokens: fallbackObserved.outputTokens,
      observedProviderCachedTokens: fallbackObserved.cachedTokens,
      observedProviderCostRangeUsd: fallbackObserved.costRangeUsd,
      observedProviderCost30dUsd: fallbackObserved.cost30dUsd,
      observedProviderCostTodayUsd: fallbackObserved.costTodayUsd,
      adeRuntimeTokens: 0,
      adeRuntimeInputTokens: 0,
      adeRuntimeOutputTokens: 0,
      adeRuntimeCachedTokens: 0,
      adeRuntimeCostRangeUsd: 0,
      adeRuntimeCost30dUsd: 0,
      adeRuntimeCostTodayUsd: 0,
      adeTotalTokens: 0,
      adeTotalCostRangeUsd: 0,
      trackedAdeTokens: 0,
      trackedAdeInputTokens: 0,
      trackedAdeOutputTokens: 0,
      trackedAdeCalls: 0,
      trackedAdeDurationMs: 0,
      workerTokens: 0,
      workerCostUsd: 0,
      chatSessions: 0,
      terminalSessions: 0,
      activeLanes: 0,
      lanesCreated: 0,
      lanesArchived: 0,
      lanesDeleted: 0,
      commitsCreated: resolvedGithubStats.commitsCreated,
      pushOperations: 0,
      prLandings: resolvedGithubStats.prsMerged,
      prsTracked: resolvedGithubStats.prsTracked,
      prsOpen: resolvedGithubStats.prsOpen,
      prsMerged: resolvedGithubStats.prsMerged,
      prsClosed: resolvedGithubStats.prsClosed,
      prAdditions: resolvedGithubStats.prAdditions,
      prDeletions: resolvedGithubStats.prDeletions,
      filesChanged: resolvedGithubStats.filesChanged,
      insertions: resolvedGithubStats.prAdditions,
      deletions: resolvedGithubStats.prDeletions,
      artifactsCaptured: 0,
      automationRuns: 0,
      workerRuns: 0,
    },
    providers,
    models,
    adeProviders: [],
    adeModels: [],
    agentProviders: [],
    agentModels: [],
    features: [],
    lanes: [],
    activities: [],
    daily: runtimeDaily,
    github: {
      repo: resolvedGithubStats.repo,
      available: resolvedGithubStats.available,
      lastFetchedAt: resolvedGithubStats.fetchedAt,
      error: resolvedGithubStats.error,
    },
    sourceNotes: [],
  };

  return fallback;
}

// ── Pacing Calculation ───────────────────────────────────────────

function emptyPacing(): UsagePacing {
  return {
    status: "on-track",
    projectedWeeklyPercent: 0,
    weekElapsedPercent: 0,
    expectedPercent: 0,
    deltaPercent: 0,
    etaHours: null,
    willLastToReset: true,
    resetsInHours: 0,
  };
}

function defaultWindowDurationMs(windowType: UsageWindow["windowType"]): number {
  switch (windowType) {
    case "five_hour":
      return 5 * 60 * 60 * 1000;
    case "monthly":
      return 30 * 24 * 60 * 60 * 1000;
    case "weekly":
    case "weekly_oauth_apps":
    case "weekly_cowork":
    default:
      return 7 * 24 * 60 * 60 * 1000;
  }
}

function selectPacingWindow(windows: UsageWindow[]): UsageWindow | null {
  return (
    windows.find((w) => w.windowType === "weekly") ??
    windows.find((w) => w.windowType === "monthly") ??
    windows.find((w) => w.windowType === "five_hour") ??
    windows.find((w) => w.resetsInMs > 0) ??
    null
  );
}

function stageForDelta(deltaPercent: number): UsagePacing["status"] {
  const absDelta = Math.abs(deltaPercent);
  if (absDelta <= 2) return "on-track";
  if (absDelta <= 6) return deltaPercent >= 0 ? "slightly-ahead" : "slightly-behind";
  if (absDelta <= 12) return deltaPercent >= 0 ? "ahead" : "behind";
  return deltaPercent >= 0 ? "far-ahead" : "far-behind";
}

function calculatePacingForWindow(window: UsageWindow): UsagePacing {
  if (!window.resetsAt || window.resetsInMs <= 0) return emptyPacing();

  const totalWindowMs = window.windowDurationMs && window.windowDurationMs > 0
    ? window.windowDurationMs
    : defaultWindowDurationMs(window.windowType);
  const elapsedMs = totalWindowMs - window.resetsInMs;
  const weekElapsedPercent = Math.min(100, Math.max(0, (elapsedMs / totalWindowMs) * 100));
  const resetsInHours = window.resetsInMs / 3_600_000;

  const expectedPercent = weekElapsedPercent;
  const deltaPercent = window.percentUsed - expectedPercent;

  // Project usage to the end of the tracked quota window.
  let projectedWeeklyPercent: number;
  let etaHours: number | null = null;
  let willLastToReset = true;

  if (weekElapsedPercent < 1) {
    projectedWeeklyPercent = window.percentUsed;
  } else {
    const ratePerMs = window.percentUsed / elapsedMs;
    projectedWeeklyPercent = Math.min(300, ratePerMs * totalWindowMs);

    // ETA to 100% at current rate.
    if (ratePerMs > 0) {
      const remainingPercent = 100 - window.percentUsed;
      if (remainingPercent <= 0) {
        etaHours = 0; // Already exhausted
        willLastToReset = false;
      } else {
        const msTo100 = remainingPercent / ratePerMs;
        etaHours = Math.round((msTo100 / 3_600_000) * 10) / 10;
        willLastToReset = msTo100 >= window.resetsInMs;
      }
    }
  }

  return {
    status: stageForDelta(deltaPercent),
    projectedWeeklyPercent: Math.round(projectedWeeklyPercent * 10) / 10,
    weekElapsedPercent: Math.round(weekElapsedPercent * 10) / 10,
    expectedPercent: Math.round(expectedPercent * 10) / 10,
    deltaPercent: Math.round(deltaPercent * 10) / 10,
    etaHours,
    willLastToReset,
    resetsInHours: Math.round(resetsInHours * 10) / 10,
  };
}

function calculatePacing(windows: UsageWindow[]): UsagePacing {
  // Preserve the legacy aggregate preference for consumers that still expect a
  // single app-level badge, then expose per-provider pacing separately below.
  const legacyWindow =
    windows.find((w) => w.windowType === "weekly" && w.provider === "claude") ??
    windows.find((w) => w.windowType === "weekly") ??
    windows.find((w) => w.windowType === "monthly") ??
    windows.find((w) => w.windowType === "five_hour") ??
    null;
  return legacyWindow ? calculatePacingForWindow(legacyWindow) : emptyPacing();
}

function calculatePacingByProvider(windows: UsageWindow[]): UsageSnapshot["pacingByProvider"] {
  const providers = Array.from(new Set(windows.map((window) => window.provider)));
  const out: UsageSnapshot["pacingByProvider"] = {};
  for (const provider of providers) {
    const selected = selectPacingWindow(windows.filter((window) => window.provider === provider));
    if (selected) out[provider] = calculatePacingForWindow(selected);
  }
  return out;
}

// ── Service Factory ──────────────────────────────────────────────

export type UsageTrackingService = ReturnType<typeof createUsageTrackingService>;

type UsageTrackingDependencies = {
  pollClaudeUsage?: () => Promise<{ windows: UsageWindow[]; extraUsage: ExtraUsage | null; errors: string[] }>;
  pollCodexUsage?: () => Promise<{ windows: UsageWindow[]; errors: string[] }>;
  scanClaudeLogs?: () => Promise<TokenEntry[]>;
  scanCodexLogs?: () => Promise<TokenEntry[]>;
  scanCursorLogs?: () => Promise<TokenEntry[]>;
  scanCursorAgentLogs?: () => Promise<TokenEntry[]>;
  scanOpenClawLogs?: () => Promise<TokenEntry[]>;
  scanOpenCodeLogs?: () => Promise<TokenEntry[]>;
  scanDroidLogs?: () => Promise<TokenEntry[]>;
  scanCopilotLogs?: () => Promise<TokenEntry[]>;
  scanGeminiLogs?: () => Promise<TokenEntry[]>;
  scanGitHubStats?: (range: ResolvedAdeUsageRange) => Promise<GitHubActivityStats>;
};

type PollOptions = {
  includeCosts?: boolean;
};

export function createUsageTrackingService({
  logger,
  pollIntervalMs: configuredInterval,
  onUpdate,
  dependencies,
  projectRoot,
}: {
  logger: Logger;
  pollIntervalMs?: number;
  onUpdate?: (snapshot: UsageSnapshot) => void;
  dependencies?: UsageTrackingDependencies;
  projectRoot?: string | null;
}) {
  const pollIntervalMs = Math.max(
    MIN_POLL_INTERVAL_MS,
    Math.min(MAX_POLL_INTERVAL_MS, configuredInterval ?? DEFAULT_POLL_INTERVAL_MS)
  );

  let lastSnapshot: UsageSnapshot | null = readCachedUsageSnapshot(logger);
  const cachedSnapshotMs = lastSnapshot ? Date.parse(lastSnapshot.lastPolledAt) : Number.NaN;
  let costCacheTimestamp = Number.isFinite(cachedSnapshotMs) ? cachedSnapshotMs : 0;
  let cachedCosts: CostSnapshot[] = lastSnapshot?.costs ?? [];
  let cachedAdeCosts: CostSnapshot[] = lastSnapshot?.adeCosts ?? [];
  let cachedDaily7d: Partial<Record<UsageProvider, number[]>> = lastSnapshot?.dailyUsage7d ?? {};
  const githubStatsCache = new Map<string, { fetchedAtMs: number; stats: GitHubActivityStats }>();
  const githubStatsInFlight = new Map<string, Promise<GitHubActivityStats>>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let inFlightPoll: Promise<UsageSnapshot> | null = null;
  let inFlightPollIncludesCosts = false;
  const runClaudeUsagePoll = dependencies?.pollClaudeUsage ?? (() => pollClaudeUsage(logger));
  const runCodexUsagePoll = dependencies?.pollCodexUsage ?? (() => pollCodexUsage(logger));
  const scanClaudeCostLogs = dependencies?.scanClaudeLogs ?? scanClaudeLogs;
  const scanCodexCostLogs = dependencies?.scanCodexLogs ?? scanCodexLogs;
  const scanCursorCostLogs = dependencies?.scanCursorLogs ?? scanCursorLogs;
  const scanCursorAgentCostLogs = dependencies?.scanCursorAgentLogs ?? scanCursorAgentLogs;
  const scanOpenClawCostLogs = dependencies?.scanOpenClawLogs ?? scanOpenClawLogs;
  const scanOpenCodeCostLogs = dependencies?.scanOpenCodeLogs ?? scanOpenCodeLogs;
  const scanDroidCostLogs = dependencies?.scanDroidLogs ?? scanDroidLogs;
  const scanCopilotCostLogs = dependencies?.scanCopilotLogs ?? scanCopilotLogs;
  const scanGeminiCostLogs = dependencies?.scanGeminiLogs ?? scanGeminiLogs;
  const scanGitHubStatsForRange = dependencies?.scanGitHubStats
    ?? ((range: ResolvedAdeUsageRange) => scanGithubActivityStats(projectRoot, range));

  const emptySnapshot = (): UsageSnapshot => ({
    windows: [],
    pacing: emptyPacing(),
    pacingByProvider: {},
    costs: [],
    adeCosts: [],
    extraUsage: [],
    lastPolledAt: nowIso(),
    errors: [],
  });

  function cachedCostResult(): { costs: CostSnapshot[]; adeCosts: CostSnapshot[] } {
    return { costs: cachedCosts, adeCosts: cachedAdeCosts };
  }

  async function pollCosts(): Promise<{ costs: CostSnapshot[]; adeCosts: CostSnapshot[] }> {
    const now = Date.now();
    if (now - costCacheTimestamp < COST_CACHE_TTL_MS && cachedCosts.length > 0) {
      return cachedCostResult();
    }

    const startedAt = Date.now();
    if (process.env.VITEST !== "true") {
      await refreshDynamicTokenPricing(logger).catch((error) => {
        logger.debug("usage.pricing_refresh_failed", { error: getErrorMessage(error) });
        return 0;
      });
    }

    const [
      claudeEntries,
      codexEntries,
      cursorEntries,
      cursorAgentEntries,
      openClawEntries,
      openCodeEntries,
      droidEntries,
      copilotEntries,
      geminiEntries,
    ] = await Promise.all([
      scanClaudeCostLogs().catch((err) => {
        logger.warn("usage.cost_scan.claude_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
      scanCodexCostLogs().catch((err) => {
        logger.warn("usage.cost_scan.codex_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
      scanCursorCostLogs().catch((err) => {
        logger.warn("usage.cost_scan.cursor_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
      scanCursorAgentCostLogs().catch((err) => {
        logger.warn("usage.cost_scan.cursor_agent_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
      scanOpenClawCostLogs().catch((err) => {
        logger.warn("usage.cost_scan.openclaw_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
      scanOpenCodeCostLogs().catch((err) => {
        logger.warn("usage.cost_scan.opencode_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
      scanDroidCostLogs().catch((err) => {
        logger.warn("usage.cost_scan.droid_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
      scanCopilotCostLogs().catch((err) => {
        logger.warn("usage.cost_scan.copilot_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
      scanGeminiCostLogs().catch((err) => {
        logger.warn("usage.cost_scan.gemini_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
    ]);

    const costs: CostSnapshot[] = [];
    if (claudeEntries.length > 0) costs.push(aggregateCosts(claudeEntries, "claude"));
    if (codexEntries.length > 0) costs.push(aggregateCosts(codexEntries, "codex"));
    if (cursorEntries.length > 0) costs.push(aggregateCosts(cursorEntries, "cursor"));
    if (cursorAgentEntries.length > 0) costs.push(aggregateCosts(cursorAgentEntries, "cursor-agent"));
    if (openClawEntries.length > 0) costs.push(aggregateCosts(openClawEntries, "openclaw"));
    if (openCodeEntries.length > 0) costs.push(aggregateCosts(openCodeEntries, "opencode"));
    if (droidEntries.length > 0) costs.push(aggregateCosts(droidEntries, "droid"));
    if (copilotEntries.length > 0) costs.push(aggregateCosts(copilotEntries, "copilot"));
    if (geminiEntries.length > 0) costs.push(aggregateCosts(geminiEntries, "gemini"));

    const daily7d: Partial<Record<UsageProvider, number[]>> = {};
    if (claudeEntries.length > 0) daily7d.claude = bucketDaily7d(claudeEntries, now);
    if (codexEntries.length > 0) daily7d.codex = bucketDaily7d(codexEntries, now);

    cachedCosts = costs;
    cachedAdeCosts = [];
    cachedDaily7d = daily7d;
    costCacheTimestamp = now;
    const durationMs = Date.now() - startedAt;
    if (durationMs > 500) {
      logger.warn("usage.cost_scan_slow", {
        durationMs,
        providerCount: costs.length,
        claudeEntries: claudeEntries.length,
        codexEntries: codexEntries.length,
        cursorEntries: cursorEntries.length,
        cursorAgentEntries: cursorAgentEntries.length,
        openClawEntries: openClawEntries.length,
        openCodeEntries: openCodeEntries.length,
        droidEntries: droidEntries.length,
        copilotEntries: copilotEntries.length,
        geminiEntries: geminiEntries.length,
      });
    }
    return { costs, adeCosts: [] };
  }

  async function poll(options: PollOptions = {}): Promise<UsageSnapshot> {
    const includeCosts = options.includeCosts !== false;
    while (inFlightPoll) {
      if (!includeCosts || inFlightPollIncludesCosts) {
        return await inFlightPoll;
      }
      await inFlightPoll.catch(() => null);
    }

    let currentPoll!: Promise<UsageSnapshot>;
    inFlightPollIncludesCosts = includeCosts;
    currentPoll = Promise.resolve().then(async () => {
      const errors: string[] = [];
      let allWindows: UsageWindow[] = [];

      try {
        const [claudeResult, codexResult, costResult] = await Promise.all([
          runClaudeUsagePoll().catch((err) => {
            const msg = `claude: poll failed: ${getErrorMessage(err)}`;
            logger.warn("usage.poll.claude_failed", { error: msg });
            return { windows: [] as UsageWindow[], extraUsage: null as ExtraUsage | null, errors: [msg] };
          }),
          runCodexUsagePoll().catch((err) => {
            const msg = `codex: poll failed: ${getErrorMessage(err)}`;
            logger.warn("usage.poll.codex_failed", { error: msg });
            return { windows: [] as UsageWindow[], errors: [msg] };
          }),
          includeCosts ? pollCosts() : Promise.resolve(cachedCostResult()),
        ]);

        allWindows = [...claudeResult.windows, ...codexResult.windows];
        errors.push(...claudeResult.errors, ...codexResult.errors);

        const pacing = calculatePacing(allWindows);
        const pacingByProvider = calculatePacingByProvider(allWindows);
        const extraUsage: ExtraUsage[] = [];
        if (claudeResult.extraUsage) extraUsage.push(claudeResult.extraUsage);

        const snapshot: UsageSnapshot = {
          windows: allWindows,
          pacing,
          pacingByProvider,
          costs: costResult.costs,
          adeCosts: costResult.adeCosts,
          extraUsage,
          dailyUsage7d: { ...cachedDaily7d },
          lastPolledAt: nowIso(),
          errors,
        };

        lastSnapshot = snapshot;
        void writeCachedUsageSnapshot(snapshot, logger);

        try {
          onUpdate?.(snapshot);
        } catch {
          // Never crash on callback error
        }

        logger.debug("usage.poll.complete", {
          windowCount: allWindows.length,
          errorCount: errors.length,
          pacing: pacing.status,
        });

        return snapshot;
      } catch (err) {
        const msg = getErrorMessage(err);
        logger.error("usage.poll.unexpected_error", { error: msg });
        errors.push(`unexpected: ${msg}`);

        if (lastSnapshot) {
          return { ...lastSnapshot, errors, lastPolledAt: nowIso() };
        }

        return { ...emptySnapshot(), errors };
      } finally {
        if (inFlightPoll === currentPoll) {
          inFlightPoll = null;
          inFlightPollIncludesCosts = false;
        }
      }
    });
    inFlightPoll = currentPoll;

    return await currentPoll;
  }

  function start() {
    if (pollTimer) return;
    // Automatic provider polling should not walk local agent ledgers. On
    // machines with multi-GB Codex/Claude logs that scan can block project open
    // and the runtime action queue; explicit refresh still performs it.
    void poll({ includeCosts: false }).catch(() => {});
    pollTimer = setInterval(() => {
      void poll({ includeCosts: false }).catch(() => {});
    }, pollIntervalMs);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function getUsageSnapshot(): UsageSnapshot {
    return lastSnapshot ?? emptySnapshot();
  }

  async function forceRefresh(): Promise<UsageSnapshot> {
    costCacheTimestamp = 0; // Invalidate cost cache
    githubStatsCache.clear();
    githubStatsInFlight.clear();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutSnapshot = new Promise<UsageSnapshot>((resolve) => {
      timeout = setTimeout(() => {
        logger.warn("usage.force_refresh_returning_cached_snapshot", {
          timeoutMs: FORCE_REFRESH_RESPONSE_TIMEOUT_MS,
        });
        resolve(lastSnapshot ?? emptySnapshot());
      }, FORCE_REFRESH_RESPONSE_TIMEOUT_MS).unref?.();
    });
    try {
      return await Promise.race([poll({ includeCosts: true }), timeoutSnapshot]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function getAdeUsageStats(args: GetAdeUsageStatsArgs = {}): Promise<AdeUsageStats> {
    let snapshot = lastSnapshot;
    if (inFlightPoll) {
      snapshot = await inFlightPoll.catch(() => lastSnapshot ?? emptySnapshot());
    }
    const staleCosts =
      costCacheTimestamp === 0 ||
      Date.now() - costCacheTimestamp > COST_CACHE_TTL_MS;
    if (!snapshot || snapshot.costs.length === 0 || staleCosts) {
      snapshot = await poll({ includeCosts: true }).catch(() => lastSnapshot ?? emptySnapshot());
    }
    const range = resolveAdeUsageRange(args, Date.now());
    const githubStats = await getGithubStatsForRange(range);
    return collectAdeUsageStats({
      snapshot,
      githubStats,
      args,
    });
  }

  async function getGithubStatsForRange(range: ResolvedAdeUsageRange): Promise<GitHubActivityStats> {
    const cacheKey = `${range.preset}:${range.since ?? "all"}:${range.until}`;
    const cached = githubStatsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAtMs < GITHUB_STATS_CACHE_TTL_MS) {
      return cached.stats;
    }
    let inFlight = githubStatsInFlight.get(cacheKey);
    if (!inFlight) {
      inFlight = scanGitHubStatsForRange(range)
        .catch((error) => makeEmptyGithubStats(getErrorMessage(error)))
        .then((statsForRange) => {
          githubStatsCache.set(cacheKey, { fetchedAtMs: Date.now(), stats: statsForRange });
          return statsForRange;
        })
        .finally(() => {
          githubStatsInFlight.delete(cacheKey);
        });
      githubStatsInFlight.set(cacheKey, inFlight);
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const loadingFallback = new Promise<GitHubActivityStats>((resolve) => {
      timeout = setTimeout(() => {
        resolve(makeEmptyGithubStats("GitHub activity is still loading."));
      }, GITHUB_STATS_FAST_RESPONSE_TIMEOUT_MS);
      timeout.unref?.();
    });
    try {
      return await Promise.race([inFlight, loadingFallback]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  return {
    start,
    stop,
    getUsageSnapshot,
    forceRefresh,
    getAdeUsageStats,
    poll,
    dispose: stop,
  };
}

// ── Exported for testing ─────────────────────────────────────────
export const _testing = {
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  readClaudeCredentials,
  readCodexCredentials,
  isCodexTokenStale,
  isTokenExpiredOrExpiring: isClaudeTokenExpiredOrExpiring,
  isClaudeTokenExpiredOrExpiring,
  refreshClaudeCredentials,
  parseClaudeWindows,
  parseCodexRateLimitWindows,
  pollClaudeUsage,
  pollCodexUsage,
  discoverClaudeProjectDirs,
  scanClaudeLogs,
  scanCodexLogs,
  scanCursorLogs,
  scanCursorAgentLogs,
  scanOpenClawLogs,
  scanOpenCodeLogs,
  scanDroidLogs,
  scanCopilotLogs,
  scanGeminiLogs,
  parseCopilotEvents,
  parseGeminiEntries,
  aggregateCosts,
  bucketDaily7d,
  collectAdeUsageStats,
  calculatePacing,
  calculatePacingByProvider,
  calculatePacingForWindow,
  fetchJson,
  findRecentFiles,
  findJsonlFiles,
  resolveTokenPrice,
  refreshDynamicTokenPricing,
  resetDynamicTokenPricingForTest,
  setDynamicTokenPricingForTest,
  pollCodexViaCliRpc,
};
