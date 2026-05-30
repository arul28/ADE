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
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
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
import type { SqlValue } from "../state/kvDb";
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

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 2 * 60_000; // 2 min
const MIN_POLL_INTERVAL_MS = 60_000;          // 1 min
const MAX_POLL_INTERVAL_MS = 15 * 60_000;     // 15 min
const COST_CACHE_TTL_MS = 10 * 60_000;        // 10 min
const CODEX_CLI_RPC_TIMEOUT_MS = 10_000;
const LOCAL_COST_SCAN_MAX_FILES = 5_000;
const LOCAL_COST_SCAN_MAX_FILE_BYTES = 768 * 1024 * 1024;
const LOCAL_COST_SCAN_MAX_ENTRIES = 1_000_000;
const LOCAL_COST_SCAN_ALL_DAYS = 3650;
const LOCAL_SQLITE_SCAN_MAX_ROWS = 250_000;
const LOCAL_CURSOR_SQLITE_RECENT_ROWS = 250_000;
const CURSOR_CHARS_PER_TOKEN = 4;
const FORCE_REFRESH_RESPONSE_TIMEOUT_MS = 60_000;
const USAGE_SNAPSHOT_CACHE_VERSION = 2;
const USAGE_SNAPSHOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const USAGE_SNAPSHOT_CACHE_PATH = path.join(os.homedir(), ".ade", "cache", "usage-snapshot.json");
const GITHUB_STATS_CACHE_TTL_MS = 10 * 60_000;
const GITHUB_STATS_COMMAND_TIMEOUT_MS = 60_000;
const GITHUB_STATS_FAST_RESPONSE_TIMEOUT_MS = 2_500;
const GITHUB_STATS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type UsageSqliteStatement = {
  all: (...params: SqlValue[]) => Record<string, unknown>[];
};
type UsageSqliteDatabase = {
  prepare: (sql: string) => UsageSqliteStatement;
  exec?: (sql: string) => void;
  close: () => void;
};
type UsageSqliteConstructor = new (dbPath: string, options?: { readOnly?: boolean }) => UsageSqliteDatabase;

const requireForUsageSqlite = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
let usageSqliteConstructor: UsageSqliteConstructor | null | undefined;

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

interface TokenEntry {
  messageId: string;
  model: string;
  originator?: string;
  inputTokens: number;
  billableInputTokens?: number;
  outputTokens: number;
  billableOutputTokens?: number;
  cachedTokens: number;
  billableCachedTokens?: number;
  cacheWriteTokens?: number;
  oneHourCacheWriteTokens?: number;
  webSearchRequests?: number;
  costOverrideUsd?: number;
  timestamp: number;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberFromRecord(record: Record<string, unknown> | undefined, ...keys: string[]): number {
  if (!record) return 0;
  for (const key of keys) {
    const value = optionalNumber(record[key]);
    if (value != null) return value;
  }
  return 0;
}

function timestampMsFromValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

function timestampMsFromUnixish(value: unknown): number {
  const numeric = optionalNumber(value);
  if (numeric != null) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  return timestampMsFromValue(value);
}

function estimateTokensFromText(value: string): number {
  if (!value) return 0;
  return Math.ceil(value.length / CURSOR_CHARS_PER_TOKEN);
}

function textFromSqliteValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (value == null) return "";
  return String(value);
}

function loadUsageSqliteConstructor(): UsageSqliteConstructor | null {
  if (usageSqliteConstructor !== undefined) return usageSqliteConstructor;
  try {
    const sqlite = requireForUsageSqlite("node:sqlite") as { DatabaseSync?: UsageSqliteConstructor };
    usageSqliteConstructor = sqlite.DatabaseSync ?? null;
  } catch {
    usageSqliteConstructor = null;
  }
  return usageSqliteConstructor;
}

function openReadonlyUsageDatabase(dbPath: string): UsageSqliteDatabase | null {
  if (!fs.existsSync(dbPath)) return null;
  const DatabaseSync = loadUsageSqliteConstructor();
  if (!DatabaseSync) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec?.("PRAGMA busy_timeout = 1000");
    } catch {
      // Best-effort only; read-only scans should still work without it.
    }
    return db;
  } catch {
    return null;
  }
}

function usageSqliteAll<T extends Record<string, unknown>>(
  db: UsageSqliteDatabase,
  sql: string,
  params: SqlValue[] = [],
): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function claudeCacheCreationTokens(usage: Record<string, unknown>): { total: number; oneHour: number } {
  const legacyTotal = numberFromRecord(usage, "cache_creation_input_tokens");
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const fiveMinute = numberFromRecord(cacheCreation, "ephemeral_5m_input_tokens");
  const oneHour = numberFromRecord(cacheCreation, "ephemeral_1h_input_tokens");
  const splitTotal = fiveMinute + oneHour;
  if (splitTotal === 0) return { total: legacyTotal, oneHour: 0 };
  const total = Math.max(legacyTotal, splitTotal);
  return { total, oneHour: Math.min(oneHour, total) };
}

function expandUsageHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function dedupeResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawPath of paths) {
    const resolved = path.resolve(expandUsageHome(rawPath));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function getClaudeConfigDirs(): string[] {
  const multi = process.env.CLAUDE_CONFIG_DIRS;
  if (multi?.trim()) {
    const dirs = multi
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (dirs.length > 0) return dedupeResolvedPaths(dirs);
  }

  const single = process.env.CLAUDE_CONFIG_DIR;
  if (single?.trim()) return dedupeResolvedPaths([single]);

  return [path.join(os.homedir(), ".claude")];
}

function getClaudeDesktopSessionsDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions");
  }
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "Claude", "local-agent-mode-sessions");
  }
  return path.join(os.homedir(), ".config", "Claude", "local-agent-mode-sessions");
}

async function addClaudeProjectsFromProjectsDir(projectsDir: string, seen: Set<string>, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, entry.name);
    const resolved = path.resolve(projectDir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(projectDir);
  }
}

async function findClaudeDesktopProjectDirs(base: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") return;
      const fullPath = path.join(dir, entry.name);
      if (entry.name === "projects") {
        await addClaudeProjectsFromProjectsDir(fullPath, new Set(results.map((value) => path.resolve(value))), results);
        return;
      }
      await walk(fullPath, depth + 1);
    }));
  }

  await walk(base, 0);
  return dedupeResolvedPaths(results);
}

async function discoverClaudeProjectDirs(): Promise<string[]> {
  const seen = new Set<string>();
  const projectDirs: string[] = [];

  for (const claudeDir of getClaudeConfigDirs()) {
    await addClaudeProjectsFromProjectsDir(path.join(claudeDir, "projects"), seen, projectDirs);
  }

  for (const desktopProjectDir of await findClaudeDesktopProjectDirs(getClaudeDesktopSessionsDir())) {
    const resolved = path.resolve(desktopProjectDir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    projectDirs.push(desktopProjectDir);
  }

  return projectDirs;
}

async function scanClaudeLogs(projectDirsOverride?: string[]): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seenMessageIds = new Set<string>();
  const projectDirs = projectDirsOverride ?? await discoverClaudeProjectDirs();
  if (projectDirs.length === 0) return [];

  const jsonlFiles = await findClaudeJsonlFilesInProjectDirs(projectDirs, LOCAL_COST_SCAN_ALL_DAYS);

  for (const filePath of jsonlFiles) {
    try {
      const firstTimestampByMessageId = new Map<string, number>();
      const lastEntryByMessageId = new Map<string, TokenEntry>();
      const messageOrder: string[] = [];

      for await (const line of readJsonlLines(filePath)) {
        if (!line.trim()) continue;
        const record = safeJsonParse<Record<string, unknown>>(line, {});
        if (record.type !== "assistant") continue;

        const message = record.message as Record<string, unknown> | undefined;
        if (!message) continue;

        const usage = message.usage as Record<string, unknown> | undefined;
        if (!usage) continue;

        const messageId = typeof message.id === "string" ? message.id : "";
        const requestId = typeof record.requestId === "string" ? record.requestId : "";
        const dedupeKey = messageId || `claude:${record.timestamp ?? ""}:${requestId}`;
        const timestamp = typeof record.timestamp === "number" ? record.timestamp :
          typeof record.timestamp === "string" ? new Date(record.timestamp).getTime() : Date.now();

        const model = typeof message.model === "string" ? message.model :
                      typeof record.model === "string" ? record.model : "unknown";
        const cacheCreation = claudeCacheCreationTokens(usage);
        const webSearchRequests = isRecord(usage.server_tool_use)
          ? numberFromRecord(usage.server_tool_use, "web_search_requests")
          : 0;

        if (!firstTimestampByMessageId.has(dedupeKey)) {
          firstTimestampByMessageId.set(dedupeKey, timestamp);
          messageOrder.push(dedupeKey);
        }

        lastEntryByMessageId.set(dedupeKey, {
          messageId: dedupeKey,
          model,
          inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
          cachedTokens: typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : typeof usage.cached_tokens === "number" ? usage.cached_tokens : 0,
          cacheWriteTokens: cacheCreation.total,
          oneHourCacheWriteTokens: cacheCreation.oneHour,
          webSearchRequests,
          timestamp,
        });
      }

      for (const dedupeKey of messageOrder) {
        if (seenMessageIds.has(dedupeKey)) continue;
        const entry = lastEntryByMessageId.get(dedupeKey);
        if (!entry) continue;
        seenMessageIds.add(dedupeKey);
        entry.timestamp = firstTimestampByMessageId.get(dedupeKey) ?? entry.timestamp;
        entries.push(entry);
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable files
    }
  }

  return entries;
}

async function scanCodexLogs(): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sessionsDir = path.join(codexHome, "sessions");

  try {
    await fs.promises.access(sessionsDir);
  } catch {
    return entries;
  }

  const jsonlFiles = await findJsonlFiles(sessionsDir, LOCAL_COST_SCAN_ALL_DAYS);

  for (const filePath of jsonlFiles) {
    try {
      if (!await isSupportedCodexUsageSession(filePath)) continue;
      let sessionId = path.basename(filePath, ".jsonl");
      let sessionModel = "codex";
      let sessionOriginator = "";
      let previousTotals: { input: number; cached: number; output: number; reasoning: number; total: number } | null = null;

      for await (const line of readJsonlLines(filePath)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const mayContainUsage =
          trimmed.includes("\"token_count\"") ||
          trimmed.includes("\"session_meta\"") ||
          trimmed.includes("\"turn_context\"") ||
          trimmed.includes("\"input_tokens\"") ||
          trimmed.includes("\"prompt_tokens\"") ||
          trimmed.includes("\"token_count\"");
        if (!mayContainUsage) continue;
        const record = safeJsonParse<Record<string, unknown>>(trimmed, {});

        const payload = isRecord(record.payload) ? record.payload : undefined;
        if (record.type === "session_meta" && payload) {
          const payloadSessionId = typeof payload.id === "string"
            ? payload.id
            : typeof payload.session_id === "string"
              ? payload.session_id
              : null;
          if (payloadSessionId) sessionId = payloadSessionId;
          if (typeof payload.model === "string" && payload.model.trim()) sessionModel = payload.model;
          if (typeof payload.originator === "string" && payload.originator.trim()) sessionOriginator = payload.originator;
          continue;
        }

        if (record.type === "turn_context" && payload) {
          if (typeof payload.model === "string" && payload.model.trim()) sessionModel = payload.model;
          continue;
        }

        if (record.type === "event_msg" && payload?.type === "token_count") {
          const info = isRecord(payload.info) ? payload.info : undefined;
          if (!info) continue;

          const totalUsage = isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
          const lastUsage = isRecord(info.last_token_usage) ? info.last_token_usage : undefined;
          const cumulativeTotal = numberFromRecord(totalUsage, "total_tokens");
          if (previousTotals && cumulativeTotal > 0 && cumulativeTotal === previousTotals.total) continue;

          let rawInputTokens = 0;
          let cachedTokens = 0;
          let outputTokens = 0;
          let reasoningTokens = 0;

          if (lastUsage) {
            rawInputTokens = numberFromRecord(lastUsage, "input_tokens");
            cachedTokens = numberFromRecord(lastUsage, "cached_input_tokens", "cache_read_input_tokens");
            outputTokens = numberFromRecord(lastUsage, "output_tokens");
            reasoningTokens = numberFromRecord(lastUsage, "reasoning_output_tokens");
          } else if (totalUsage) {
            rawInputTokens = numberFromRecord(totalUsage, "input_tokens") - (previousTotals?.input ?? 0);
            cachedTokens = numberFromRecord(totalUsage, "cached_input_tokens", "cache_read_input_tokens") - (previousTotals?.cached ?? 0);
            outputTokens = numberFromRecord(totalUsage, "output_tokens") - (previousTotals?.output ?? 0);
            reasoningTokens = numberFromRecord(totalUsage, "reasoning_output_tokens") - (previousTotals?.reasoning ?? 0);
          }

          if (totalUsage) {
            previousTotals = {
              input: numberFromRecord(totalUsage, "input_tokens"),
              cached: numberFromRecord(totalUsage, "cached_input_tokens", "cache_read_input_tokens"),
              output: numberFromRecord(totalUsage, "output_tokens"),
              reasoning: numberFromRecord(totalUsage, "reasoning_output_tokens"),
              total: cumulativeTotal,
            };
          }

          rawInputTokens = Math.max(0, rawInputTokens);
          cachedTokens = Math.max(0, cachedTokens);
          outputTokens = Math.max(0, outputTokens) + Math.max(0, reasoningTokens);
          const billableInputTokens = Math.max(0, rawInputTokens - cachedTokens);
          const inputTokens = Math.max(0, rawInputTokens);
          if (inputTokens + outputTokens + cachedTokens === 0) continue;

          const timestamp = timestampMsFromValue(record.timestamp);
          const model = typeof payload.model === "string" && payload.model.trim()
            ? payload.model
            : sessionModel;
          const dedupeKey = `${sessionId}:${record.timestamp ?? timestamp}:${cumulativeTotal || entries.length}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          entries.push({
            messageId: dedupeKey,
            model,
            originator: sessionOriginator,
            inputTokens,
            billableInputTokens,
            outputTokens,
            cachedTokens,
            billableCachedTokens: cachedTokens,
            cacheWriteTokens: 0,
            timestamp,
          });
          if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
          continue;
        }

        // Codex uses event_msg format
        const eventType = typeof record.type === "string" ? record.type :
                          typeof record.event_type === "string" ? record.event_type : "";

        if (!eventType.includes("token") && !eventType.includes("usage") && !eventType.includes("msg")) {
          // Also check for direct usage fields
          if (typeof record.input_tokens !== "number" && typeof record.token_count !== "number") continue;
        }

        const requestId = typeof record.requestId === "string" ? record.requestId :
                          typeof record.request_id === "string" ? record.request_id :
                          typeof record.id === "string" ? record.id : "";
        const messageId = typeof record.message_id === "string" ? record.message_id : "";
        const dedupeKey = `${messageId}:${requestId}`;
        if (dedupeKey !== ":" && seen.has(dedupeKey)) continue;
        if (dedupeKey !== ":") seen.add(dedupeKey);

        const model = typeof record.model === "string" ? record.model : "codex";

        const inputTokens = typeof record.input_tokens === "number" ? record.input_tokens :
                            typeof record.prompt_tokens === "number" ? record.prompt_tokens : 0;
        const outputTokens = typeof record.output_tokens === "number" ? record.output_tokens :
                             typeof record.completion_tokens === "number" ? record.completion_tokens : 0;
        const tokenCount = typeof record.token_count === "number" ? record.token_count : 0;

        if (inputTokens === 0 && outputTokens === 0 && tokenCount === 0) continue;

        entries.push({
          messageId: dedupeKey,
          model,
          originator: sessionOriginator,
          inputTokens: inputTokens || Math.floor(tokenCount * 0.4),
          outputTokens: outputTokens || Math.ceil(tokenCount * 0.6),
          cachedTokens: typeof record.cached_tokens === "number" ? record.cached_tokens : 0,
          billableCachedTokens: typeof record.cached_tokens === "number" ? record.cached_tokens : 0,
          cacheWriteTokens: 0,
          timestamp: typeof record.timestamp === "number" ? record.timestamp :
                     typeof record.timestamp === "string" ? new Date(record.timestamp).getTime() : Date.now(),
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable files
    }
  }

  return entries;
}

function defaultOpenClawAgentRoots(): string[] {
  return [
    path.join(os.homedir(), ".openclaw", "agents"),
    path.join(os.homedir(), ".clawdbot", "agents"),
    path.join(os.homedir(), ".moltbot", "agents"),
    path.join(os.homedir(), ".moldbot", "agents"),
  ];
}

async function scanOpenClawLogs(agentRoots = defaultOpenClawAgentRoots()): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();

  const jsonlFiles: string[] = [];
  for (const root of agentRoots) {
    jsonlFiles.push(...await findJsonlFiles(root, LOCAL_COST_SCAN_ALL_DAYS));
  }

  for (const filePath of jsonlFiles.slice(0, LOCAL_COST_SCAN_MAX_FILES)) {
    try {
      let sessionId = path.basename(filePath, ".jsonl");
      let currentModel = "openclaw-auto";
      let sessionTimestamp = "";

      for await (const line of readJsonlLines(filePath)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = safeJsonParse<Record<string, unknown>>(trimmed, {});
        const type = normalizeUsageLabel(record.type, "");

        if (type === "session") {
          if (typeof record.id === "string" && record.id.trim()) sessionId = record.id;
          if (typeof record.timestamp === "string") sessionTimestamp = record.timestamp;
          continue;
        }

        if (type === "model_change") {
          if (typeof record.modelId === "string" && record.modelId.trim()) currentModel = record.modelId;
          continue;
        }

        if (type === "custom" && record.customType === "model-snapshot" && isRecord(record.data)) {
          if (typeof record.data.modelId === "string" && record.data.modelId.trim()) {
            currentModel = record.data.modelId;
          }
          continue;
        }

        if (type !== "message" || !isRecord(record.message)) continue;
        const message = record.message;
        if (message.role !== "assistant" || !isRecord(message.usage)) continue;

        const usage = message.usage;
        const inputTokens = numberFromRecord(usage, "input");
        const outputTokens = numberFromRecord(usage, "output");
        const cachedTokens = numberFromRecord(usage, "cacheRead");
        const cacheWriteTokens = numberFromRecord(usage, "cacheWrite");
        if (inputTokens + outputTokens + cachedTokens + cacheWriteTokens === 0) continue;

        const timestamp = timestampMsFromValue(record.timestamp ?? sessionTimestamp);
        const cost = isRecord(usage.cost) ? optionalNumber(usage.cost.total) : null;
        const model = typeof message.model === "string" && message.model.trim()
          ? message.model
          : currentModel;
        const dedupeKey = `openclaw:${sessionId}:${typeof record.id === "string" && record.id ? record.id : `${record.timestamp ?? timestamp}:${entries.length}`}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        entries.push({
          messageId: dedupeKey,
          model,
          inputTokens,
          outputTokens,
          cachedTokens,
          billableCachedTokens: cachedTokens,
          cacheWriteTokens,
          costOverrideUsd: cost != null && cost > 0 ? cost : undefined,
          timestamp,
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable or malformed session files.
    }
  }

  return entries;
}

function defaultDroidSessionsDir(): string {
  return path.join(process.env.FACTORY_DIR ?? path.join(os.homedir(), ".factory"), "sessions");
}

function stripDroidModelPrefix(raw: string): string {
  return raw
    .replace(/^custom:/, "")
    .replace(/\[.*?\]/g, "")
    .replace(/-\d+$/, "")
    .replace(/-+$/, "")
    .replace(/^-/, "");
}

async function scanDroidLogs(sessionsDir = defaultDroidSessionsDir()): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const jsonlFiles = await findJsonlFiles(sessionsDir, LOCAL_COST_SCAN_ALL_DAYS);

  for (const filePath of jsonlFiles) {
    try {
      const settings = safeJsonParse<Record<string, unknown>>(
        await fs.promises.readFile(filePath.replace(/\.jsonl$/, ".settings.json"), "utf8").catch(() => "{}"),
        {},
      );
      const tokenUsage = isRecord(settings.tokenUsage) ? settings.tokenUsage : null;
      if (!tokenUsage) continue;

      let sessionId = path.basename(filePath, ".jsonl");
      const model = typeof settings.model === "string" && settings.model.trim()
        ? stripDroidModelPrefix(settings.model)
        : "droid-auto";
      const assistantCalls: Array<{ id: string; timestamp: number }> = [];

      for await (const line of readJsonlLines(filePath)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = safeJsonParse<Record<string, unknown>>(trimmed, {});
        if (record.type === "session_start" && typeof record.id === "string" && record.id.trim()) {
          sessionId = record.id;
          continue;
        }
        if (record.type !== "message" || !isRecord(record.message)) continue;
        const message = record.message;
        if (message.role !== "assistant") continue;
        const content = Array.isArray(message.content) ? message.content : [];
        const hasAssistantActivity = content.some((block) => (
          isRecord(block) &&
          ((block.type === "text" && typeof block.text === "string" && block.text.trim()) || block.type === "tool_use")
        ));
        if (!hasAssistantActivity) continue;
        assistantCalls.push({
          id: typeof record.id === "string" && record.id ? record.id : `msg-${assistantCalls.length}`,
          timestamp: timestampMsFromValue(record.timestamp),
        });
      }

      if (assistantCalls.length === 0) continue;
      const totalInput = numberFromRecord(tokenUsage, "inputTokens");
      const totalOutput = numberFromRecord(tokenUsage, "outputTokens");
      const totalCacheWrite = numberFromRecord(tokenUsage, "cacheCreationTokens");
      const totalCacheRead = numberFromRecord(tokenUsage, "cacheReadTokens");
      const totalThinking = numberFromRecord(tokenUsage, "thinkingTokens");
      if (totalInput + totalOutput + totalCacheWrite + totalCacheRead + totalThinking === 0) continue;

      const inputPerCall = Math.floor(totalInput / assistantCalls.length);
      const outputPerCall = Math.floor(totalOutput / assistantCalls.length);
      const cacheWritePerCall = Math.floor(totalCacheWrite / assistantCalls.length);
      const cacheReadPerCall = Math.floor(totalCacheRead / assistantCalls.length);
      const thinkingPerCall = Math.floor(totalThinking / assistantCalls.length);

      for (let i = 0; i < assistantCalls.length; i++) {
        const call = assistantCalls[i]!;
        const isLast = i === assistantCalls.length - 1;
        const dedupeKey = `droid:${sessionId}:${call.id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        entries.push({
          messageId: dedupeKey,
          model,
          inputTokens: isLast ? totalInput - inputPerCall * i : inputPerCall,
          outputTokens: (isLast ? totalOutput - outputPerCall * i : outputPerCall) +
            (isLast ? totalThinking - thinkingPerCall * i : thinkingPerCall),
          cachedTokens: isLast ? totalCacheRead - cacheReadPerCall * i : cacheReadPerCall,
          billableCachedTokens: isLast ? totalCacheRead - cacheReadPerCall * i : cacheReadPerCall,
          cacheWriteTokens: isLast ? totalCacheWrite - cacheWritePerCall * i : cacheWritePerCall,
          timestamp: call.timestamp,
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable or malformed Droid sessions.
    }
  }

  return entries;
}

function defaultCopilotSessionStateDir(): string {
  return path.join(os.homedir(), ".copilot", "session-state");
}

function defaultVSCodeWorkspaceStorageDirs(): string[] {
  if (process.platform === "darwin") {
    return [
      path.join(os.homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage"),
      path.join(os.homedir(), "Library", "Application Support", "Code - Insiders", "User", "workspaceStorage"),
    ];
  }
  if (process.platform === "win32") {
    return [
      path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "workspaceStorage"),
      path.join(os.homedir(), "AppData", "Roaming", "Code - Insiders", "User", "workspaceStorage"),
    ];
  }
  return [
    path.join(os.homedir(), ".config", "Code", "User", "workspaceStorage"),
    path.join(os.homedir(), ".config", "Code - Insiders", "User", "workspaceStorage"),
    path.join(os.homedir(), ".vscode-server", "data", "User", "workspaceStorage"),
  ];
}

function inferCopilotModelFromToolCalls(events: Record<string, unknown>[]): string {
  const modelCounts = new Map<string, number>();
  const bump = (model: string, weight: number) => {
    if (!model.trim()) return;
    modelCounts.set(model, (modelCounts.get(model) ?? 0) + weight);
  };

  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    if (typeof data.model === "string" && data.model.trim()) bump(data.model, 100);
    if (event.type !== "assistant.message") continue;
    const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
    for (const tool of toolRequests) {
      if (!isRecord(tool) || typeof tool.toolCallId !== "string") continue;
      const toolCallId = tool.toolCallId;
      if (toolCallId.startsWith("call_")) bump("copilot-openai-auto", 1);
      if (toolCallId.startsWith("toolu_") || toolCallId.startsWith("tooluse_")) bump("copilot-anthropic-auto", 1);
    }
  }

  return [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "copilot-auto";
}

function parseCopilotEvents(raw: string, sourcePath: string): TokenEntry[] {
  const entries: TokenEntry[] = [];
  const records = raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => safeJsonParse<Record<string, unknown>>(line, {}))
    .filter((record) => isRecord(record));
  const first = records[0];
  const isTranscript = first?.type === "session.start" && isRecord(first.data) && first.data.producer === "copilot-agent";
  const sessionId = path.basename(sourcePath, ".jsonl").length === 36
    ? path.basename(sourcePath, ".jsonl")
    : path.basename(path.dirname(sourcePath));
  let currentModel = "";
  let pendingUserMessage = "";

  if (isTranscript) {
    const inferredModel = inferCopilotModelFromToolCalls(records);
    for (const record of records) {
      const data = isRecord(record.data) ? record.data : {};
      if (record.type === "user.message") {
        pendingUserMessage = typeof data.content === "string" ? data.content.slice(0, 500) : "";
        continue;
      }
      if (record.type !== "assistant.message") continue;
      const messageId = typeof data.messageId === "string" && data.messageId ? data.messageId : `${record.timestamp ?? entries.length}`;
      const content = typeof data.content === "string" ? data.content : "";
      const reasoning = typeof data.reasoningText === "string" ? data.reasoningText : "";
      const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      if (!content && !reasoning && toolRequests.length === 0) continue;
      let outputTokens = numberFromRecord(data, "outputTokens");
      let reasoningTokens = 0;
      if (outputTokens === 0) {
        outputTokens = estimateTokensFromText(content);
        reasoningTokens = estimateTokensFromText(reasoning);
      }
      entries.push({
        messageId: `copilot:${sessionId}:${messageId}`,
        model: typeof data.model === "string" && data.model.trim() ? data.model : inferredModel,
        inputTokens: estimateTokensFromText(pendingUserMessage),
        outputTokens,
        billableOutputTokens: outputTokens + reasoningTokens,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        timestamp: timestampMsFromValue(record.timestamp),
      });
      pendingUserMessage = "";
    }
    return entries;
  }

  for (const record of records) {
    const data = isRecord(record.data) ? record.data : {};
    if (typeof data.model === "string" && data.model.trim()) currentModel = data.model;
    if (record.type === "session.model_change") {
      if (typeof data.newModel === "string" && data.newModel.trim()) currentModel = data.newModel;
      continue;
    }
    if (record.type === "user.message") {
      pendingUserMessage = typeof data.content === "string" ? data.content : "";
      continue;
    }
    if (record.type !== "assistant.message") continue;
    const outputTokens = numberFromRecord(data, "outputTokens");
    if (outputTokens === 0 || !currentModel) continue;
    const messageId = typeof data.messageId === "string" && data.messageId ? data.messageId : `${record.timestamp ?? entries.length}`;
    entries.push({
      messageId: `copilot:${sessionId}:${messageId}`,
      model: currentModel,
      inputTokens: estimateTokensFromText(pendingUserMessage),
      outputTokens,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      timestamp: timestampMsFromValue(record.timestamp),
    });
    pendingUserMessage = "";
  }

  return entries;
}

async function discoverCopilotTranscriptFiles(
  sessionStateDir = defaultCopilotSessionStateDir(),
  workspaceStorageDirs = defaultVSCodeWorkspaceStorageDirs(),
): Promise<string[]> {
  const files: string[] = [];
  try {
    const sessionDirs = await fs.promises.readdir(sessionStateDir);
    await Promise.all(sessionDirs.map(async (sessionId) => {
      const eventsPath = path.join(sessionStateDir, sessionId, "events.jsonl");
      const stat = await fs.promises.stat(eventsPath).catch(() => null);
      if (stat?.isFile() && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) files.push(eventsPath);
    }));
  } catch {
    // Missing Copilot legacy state is expected for users who never used it.
  }

  await Promise.all(workspaceStorageDirs.map(async (workspaceStorageDir) => {
    let workspaceDirs: string[];
    try {
      workspaceDirs = await fs.promises.readdir(workspaceStorageDir);
    } catch {
      return;
    }
    await Promise.all(workspaceDirs.map(async (workspaceDir) => {
      const transcriptsDir = path.join(workspaceStorageDir, workspaceDir, "GitHub.copilot-chat", "transcripts");
      let transcriptFiles: string[];
      try {
        transcriptFiles = await fs.promises.readdir(transcriptsDir);
      } catch {
        return;
      }
      await Promise.all(transcriptFiles
        .filter((file) => file.endsWith(".jsonl"))
        .map(async (file) => {
          const filePath = path.join(transcriptsDir, file);
          const stat = await fs.promises.stat(filePath).catch(() => null);
          if (stat?.isFile() && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) files.push(filePath);
        }));
    }));
  }));

  return files.slice(0, LOCAL_COST_SCAN_MAX_FILES);
}

async function scanCopilotLogs(
  sessionStateDir = defaultCopilotSessionStateDir(),
  workspaceStorageDirs = defaultVSCodeWorkspaceStorageDirs(),
): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const files = await discoverCopilotTranscriptFiles(sessionStateDir, workspaceStorageDirs);
  for (const filePath of files) {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      for (const entry of parseCopilotEvents(raw, filePath)) {
        if (entry.inputTokens + entry.outputTokens + entry.cachedTokens + toNonNegativeInt(entry.cacheWriteTokens) === 0) continue;
        if (seen.has(entry.messageId)) continue;
        seen.add(entry.messageId);
        entries.push(entry);
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable Copilot logs.
    }
  }
  return entries;
}

function defaultGeminiTmpDir(): string {
  return path.join(os.homedir(), ".gemini", "tmp");
}

function parseGeminiSession(raw: string): { sessionId: string; startTime: string; messages: Record<string, unknown>[] } | null {
  const parsed = safeJsonParse<Record<string, unknown>>(raw, {});
  if (isRecord(parsed) && typeof parsed.sessionId === "string" && Array.isArray(parsed.messages)) {
    return {
      sessionId: parsed.sessionId,
      startTime: typeof parsed.startTime === "string" ? parsed.startTime : "",
      messages: parsed.messages.filter((message): message is Record<string, unknown> => isRecord(message)),
    };
  }

  let sessionId = "";
  let startTime = "";
  const messages: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = safeJsonParse<Record<string, unknown>>(line, {});
    if (record.$set !== undefined) continue;
    if (!sessionId && typeof record.sessionId === "string" && typeof record.startTime === "string") {
      sessionId = record.sessionId;
      startTime = record.startTime;
      continue;
    }
    if (typeof record.id === "string" && typeof record.type === "string") {
      messages.push(record);
    }
  }
  return sessionId ? { sessionId, startTime, messages } : null;
}

function parseGeminiEntries(raw: string, sourcePath: string): TokenEntry[] {
  const session = parseGeminiSession(raw);
  if (!session) return [];
  const entries: TokenEntry[] = [];
  let ordinal = 0;

  for (const message of session.messages) {
    if (message.type === "user") continue;
    if (message.type !== "gemini" || !isRecord(message.tokens)) continue;
    const model = typeof message.model === "string" && message.model.trim() ? message.model : "gemini-auto";
    const tokens = message.tokens;
    const totalInput = numberFromRecord(tokens, "input");
    const totalOutput = numberFromRecord(tokens, "output");
    const totalCached = numberFromRecord(tokens, "cached");
    const totalThoughts = numberFromRecord(tokens, "thoughts");
    if (totalInput + totalOutput + totalCached + totalThoughts === 0) continue;
    const freshInput = Math.max(0, totalInput - totalCached);
    const timestamp = timestampMsFromValue(message.timestamp ?? session.startTime);
    if (timestamp < 1_000_000_000_000) continue;
    const messageId = typeof message.id === "string" && message.id ? message.id : `${path.basename(sourcePath)}:${ordinal}`;
    ordinal += 1;
    entries.push({
      messageId: `gemini:${session.sessionId}:${messageId}`,
      model,
      inputTokens: freshInput,
      outputTokens: totalOutput + totalThoughts,
      cachedTokens: totalCached,
      billableCachedTokens: totalCached,
      cacheWriteTokens: 0,
      timestamp,
    });
  }
  return entries;
}

async function discoverGeminiSessionFiles(tmpDir = defaultGeminiTmpDir()): Promise<string[]> {
  const files: string[] = [];
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = await fs.promises.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return files;
  }

  await Promise.all(projectDirs
    .filter((entry) => entry.isDirectory())
    .map(async (projectDir) => {
      const chatsDir = path.join(tmpDir, projectDir.name, "chats");
      let chatFiles: string[];
      try {
        chatFiles = await fs.promises.readdir(chatsDir);
      } catch {
        return;
      }
      await Promise.all(chatFiles
        .filter((file) => file.startsWith("session-") && (file.endsWith(".json") || file.endsWith(".jsonl")))
        .map(async (file) => {
          const filePath = path.join(chatsDir, file);
          const stat = await fs.promises.stat(filePath).catch(() => null);
          if (stat?.isFile() && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) files.push(filePath);
        }));
    }));

  return files.slice(0, LOCAL_COST_SCAN_MAX_FILES);
}

async function scanGeminiLogs(tmpDir = defaultGeminiTmpDir()): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const files = await discoverGeminiSessionFiles(tmpDir);
  for (const filePath of files) {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      for (const entry of parseGeminiEntries(raw, filePath)) {
        if (seen.has(entry.messageId)) continue;
        seen.add(entry.messageId);
        entries.push(entry);
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable Gemini logs.
    }
  }
  return entries;
}

function defaultOpenCodeDataDir(): string {
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode");
}

async function scanOpenCodeLogs(dataDir = defaultOpenCodeDataDir()): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  let dbFiles: string[] = [];
  try {
    dbFiles = (await fs.promises.readdir(dataDir))
      .filter((name) => name.startsWith("opencode") && name.endsWith(".db"))
      .map((name) => path.join(dataDir, name));
  } catch {
    return entries;
  }

  const sinceMs = 0;
  for (const dbPath of dbFiles) {
    const db = openReadonlyUsageDatabase(dbPath);
    if (!db) continue;
    try {
      const rows = usageSqliteAll<{ id: string; sessionId: string; timeCreated: number; data: string }>(
        db,
        `
          select id, session_id as sessionId, time_created as timeCreated, cast(data as blob) as data
          from message
          where time_created >= ?
          order by time_created desc, id desc
          limit ?
        `,
        [sinceMs, LOCAL_SQLITE_SCAN_MAX_ROWS],
      );
      for (const row of rows) {
        const data = safeJsonParse<Record<string, unknown>>(textFromSqliteValue(row.data), {});
        if (data.role !== "assistant") continue;
        const tokens = isRecord(data.tokens) ? data.tokens : {};
        const cache = isRecord(tokens.cache) ? tokens.cache : {};
        const inputTokens = numberFromRecord(tokens, "input");
        const outputTokens = numberFromRecord(tokens, "output") + numberFromRecord(tokens, "reasoning");
        const cachedTokens = numberFromRecord(cache, "read");
        const cacheWriteTokens = numberFromRecord(cache, "write");
        const cost = optionalNumber(data.cost);
        if (inputTokens + outputTokens + cachedTokens + cacheWriteTokens === 0 && !(cost && cost > 0)) continue;

        const sessionId = typeof row.sessionId === "string" && row.sessionId ? row.sessionId : "unknown";
        const dedupeKey = `opencode:${sessionId}:${row.id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        entries.push({
          messageId: dedupeKey,
          model: typeof data.modelID === "string" && data.modelID.trim() ? data.modelID : "opencode-auto",
          inputTokens,
          outputTokens,
          cachedTokens,
          billableCachedTokens: cachedTokens,
          cacheWriteTokens,
          costOverrideUsd: cost != null && cost > 0 ? cost : undefined,
          timestamp: timestampMsFromUnixish(row.timeCreated),
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unrecognized OpenCode DB schemas.
    } finally {
      db.close();
    }
  }

  return entries;
}

function defaultCursorDbPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(os.homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

async function scanCursorLogs(dbPath = defaultCursorDbPath()): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const db = openReadonlyUsageDatabase(dbPath);
  if (!db) return entries;

  try {
    const cursorRows = usageSqliteAll<{
      key: string;
      value: string | Uint8Array | null;
    }>(
      db,
      `
        select
          key,
          cast(value as blob) as value
        from cursorDiskKV
        order by rowid desc
        limit ?
      `,
      [LOCAL_CURSOR_SQLITE_RECENT_ROWS],
    );

    for (const row of cursorRows) {
      if (!row.key.startsWith("bubbleId:")) continue;
      const value = safeJsonParse<Record<string, unknown>>(textFromSqliteValue(row.value), {});
      const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
      if (!createdAt) continue;
      const tokenCount = isRecord(value.tokenCount) ? value.tokenCount : {};
      let inputTokens = numberFromRecord(tokenCount, "inputTokens");
      let outputTokens = numberFromRecord(tokenCount, "outputTokens");
      if (inputTokens + outputTokens === 0) {
        const estimated = typeof value.text === "string" ? estimateTokensFromText(value.text) : 0;
        if (value.type === 1) inputTokens = estimated;
        else outputTokens = estimated;
      }
      if (inputTokens + outputTokens === 0) continue;
      const dedupeKey = `cursor:bubble:${row.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const modelInfo = isRecord(value.modelInfo) ? value.modelInfo : {};
      const rawModel = typeof modelInfo.modelName === "string" ? modelInfo.modelName.trim() : "";
      const model = rawModel && rawModel !== "default"
        ? rawModel
        : "cursor-auto";
      entries.push({
        messageId: dedupeKey,
        model,
        inputTokens,
        outputTokens,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        timestamp: timestampMsFromValue(createdAt),
      });
      if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
    }

    // Cursor's bubble rows contain the real token counts surfaced by Cursor's
    // UI. The agentKv rows are text blobs that require estimation and have
    // proven noisy in parity checks, so ADE leaves them out and relies on the
    // separate Cursor Agent transcript scanner for cursor-agent sessions.
  } catch {
    return entries;
  } finally {
    db.close();
  }

  return entries;
}

function extractCursorAgentUserQuery(text: string): string {
  const matches = Array.from(text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g))
    .map((match) => (match[1] ?? "").trim())
    .filter(Boolean);
  return (matches.length > 0 ? matches.join(" ") : text).replace(/\s+/g, " ").trim().slice(0, 500);
}

function parseCursorAgentJsonlTranscript(raw: string): Array<{ inputText: string; outputText: string; reasoningText: string }> {
  const turns: Array<{ inputText: string; outputText: string; reasoningText: string }> = [];
  let currentUser = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = safeJsonParse<Record<string, unknown>>(line, {});
    if (record.role === "user" && isRecord(record.message)) {
      const content = Array.isArray(record.message.content) ? record.message.content : [];
      const text = content
        .map((block) => isRecord(block) && typeof block.text === "string" ? block.text : "")
        .filter(Boolean)
        .join(" ");
      currentUser = extractCursorAgentUserQuery(text);
      continue;
    }
    if (record.role === "assistant" && currentUser && isRecord(record.message)) {
      const content = Array.isArray(record.message.content) ? record.message.content : [];
      const outputText = content
        .map((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "")
        .filter(Boolean)
        .join("\n");
      turns.push({ inputText: currentUser, outputText, reasoningText: "" });
      currentUser = "";
    }
  }
  return turns;
}

function parseCursorAgentTextTranscript(raw: string): Array<{ inputText: string; outputText: string; reasoningText: string }> {
  const turns: Array<{ inputText: string; outputText: string; reasoningText: string }> = [];
  const pendingUsers: string[] = [];
  let active: "none" | "user" | "assistant" = "none";
  let userLines: string[] = [];
  let assistantLines: string[] = [];

  const flushUser = () => {
    if (userLines.length === 0) return;
    const inputText = extractCursorAgentUserQuery(userLines.join("\n"));
    if (inputText) pendingUsers.push(inputText);
    userLines = [];
  };

  const flushAssistant = () => {
    if (assistantLines.length === 0) return;
    let outputText = "";
    let reasoningText = "";
    for (const line of assistantLines) {
      if (/^\s*\[Tool result\]\b/i.test(line)) continue;
      const thinkingMatch = line.match(/^\s*\[Thinking\]\s*/);
      if (thinkingMatch) {
        const body = line.replace(/^\s*\[Thinking\]\s*/, "").trim();
        if (body) reasoningText += `${body}\n`;
        continue;
      }
      if (/^\s*\[Tool call\]\s*(.+?)\s*$/i.test(line)) continue;
      outputText += `${line}\n`;
    }
    if (pendingUsers.length > 0) {
      turns.push({
        inputText: pendingUsers.shift()!,
        outputText: outputText.trim(),
        reasoningText: reasoningText.trim(),
      });
    }
    assistantLines = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*user:\s*/i.test(line)) {
      if (active === "user") flushUser();
      if (active === "assistant") flushAssistant();
      active = "user";
      userLines = [line.replace(/^\s*user:\s*/i, "")];
      continue;
    }
    if (/^\s*A:\s*/.test(line)) {
      if (active === "user") flushUser();
      if (active === "assistant") flushAssistant();
      active = "assistant";
      assistantLines = [line.replace(/^\s*A:\s*/, "")];
      continue;
    }
    if (active === "user") userLines.push(line);
    if (active === "assistant") assistantLines.push(line);
  }
  if (active === "user") flushUser();
  if (active === "assistant") flushAssistant();
  return turns;
}

function cursorAgentConversationId(filePath: string): string {
  return createHash("sha1").update(filePath).digest("hex").slice(0, 16);
}

async function scanCursorAgentLogs(projectsDir = path.join(os.homedir(), ".cursor", "projects")): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const files = await findRecentFiles(projectsDir, LOCAL_COST_SCAN_ALL_DAYS, [".jsonl", ".txt"]);

  for (const filePath of files) {
    if (!filePath.includes(`${path.sep}agent-transcripts${path.sep}`)) continue;
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const turns = filePath.endsWith(".jsonl")
        ? parseCursorAgentJsonlTranscript(raw)
        : parseCursorAgentTextTranscript(raw);
      if (turns.length === 0) continue;
      const stat = await fs.promises.stat(filePath);
      const sessionId = cursorAgentConversationId(filePath);
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]!;
        const inputTokens = estimateTokensFromText(turn.inputText);
        const outputTokens = estimateTokensFromText(turn.outputText);
        const reasoningTokens = estimateTokensFromText(turn.reasoningText);
        if (inputTokens + outputTokens === 0) continue;
        const dedupeKey = `cursor-agent:${sessionId}:${i}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        entries.push({
          messageId: dedupeKey,
          model: "cursor-agent-auto",
          inputTokens,
          outputTokens,
          billableOutputTokens: outputTokens + reasoningTokens,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          timestamp: stat.mtimeMs,
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable Cursor Agent transcripts.
    }
  }

  return entries;
}

async function isSupportedCodexUsageSession(filePath: string): Promise<boolean> {
  let file: fs.promises.FileHandle | null = null;
  try {
    file = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) return false;
    const entry = safeJsonParse<Record<string, unknown>>(firstLine, {});
    if (entry.type !== "session_meta" || !isRecord(entry.payload)) return false;
    const originator = normalizeUsageLabel(entry.payload.originator, "").toLowerCase();
    return !originator.startsWith("ade");
  } catch {
    return false;
  } finally {
    await file?.close().catch(() => {});
  }
}

async function findRecentFiles(dir: string, maxAgeDays: number, suffixes: string[]): Promise<string[]> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const files: Array<{ path: string; mtimeMs: number }> = [];

  async function walk(current: string, depth: number) {
    if (depth > 6) return; // Prevent deep traversal
    try {
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      const dirPromises: Promise<void>[] = [];
      const fileStatPromises: Promise<void>[] = [];
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          dirPromises.push(walk(fullPath, depth + 1));
        } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
          fileStatPromises.push(
            fs.promises.stat(fullPath).then((stat) => {
              if (stat.mtimeMs >= cutoff && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) {
                files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
              }
            }).catch(() => {
              // Skip files we can't stat
            })
          );
        }
      }
      await Promise.all([...dirPromises, ...fileStatPromises]);
    } catch {
      // Skip directories we can't read
    }
  }

  await walk(dir, 0);
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, LOCAL_COST_SCAN_MAX_FILES)
    .map((file) => file.path);
}

async function findJsonlFiles(dir: string, maxAgeDays: number): Promise<string[]> {
  return findRecentFiles(dir, maxAgeDays, [".jsonl"]);
}

async function findClaudeJsonlFilesInProjectDirs(projectDirs: string[], maxAgeDays: number): Promise<string[]> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const files = new Map<string, { path: string; mtimeMs: number }>();

  async function addJsonlFilesInDir(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.mtimeMs >= cutoff && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) {
            files.set(filePath, { path: filePath, mtimeMs: stat.mtimeMs });
          }
        } catch {
          // Skip files we can't stat
        }
      }));
  }

  for (const projectDir of projectDirs) {
    const projectPath = projectDir;
    await addJsonlFilesInDir(projectPath);
    await addJsonlFilesInDir(path.join(projectPath, "subagents"));

    let childEntries: fs.Dirent[];
    try {
      childEntries = await fs.promises.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    await Promise.all(childEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => addJsonlFilesInDir(path.join(projectPath, entry.name, "subagents"))));
  }

  return Array.from(files.values())
    .slice(0, LOCAL_COST_SCAN_MAX_FILES)
    .map((file) => file.path);
}

async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      yield line;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

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
  const now = Date.now();
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
  let costCacheTimestamp = 0;
  let cachedCosts: CostSnapshot[] = [];
  let cachedAdeCosts: CostSnapshot[] = [];
  let cachedDaily7d: Partial<Record<UsageProvider, number[]>> = {};
  const githubStatsCache = new Map<string, { fetchedAtMs: number; stats: GitHubActivityStats }>();
  const githubStatsInFlight = new Map<string, Promise<GitHubActivityStats>>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let inFlightPoll: Promise<UsageSnapshot> | null = null;
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

  async function pollCosts(): Promise<{ costs: CostSnapshot[]; adeCosts: CostSnapshot[] }> {
    const now = Date.now();
    if (now - costCacheTimestamp < COST_CACHE_TTL_MS && cachedCosts.length > 0) {
      return { costs: cachedCosts, adeCosts: cachedAdeCosts };
    }

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
    return { costs, adeCosts: [] };
  }

  async function poll(): Promise<UsageSnapshot> {
    if (inFlightPoll) {
      return await inFlightPoll;
    }

    inFlightPoll = (async () => {
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
          pollCosts(),
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
        inFlightPoll = null;
      }
    })();

    return await inFlightPoll;
  }

  function start() {
    if (pollTimer) return;
    // Fire immediately, then on interval
    void poll().catch(() => {});
    pollTimer = setInterval(() => {
      void poll().catch(() => {});
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
      return await Promise.race([poll(), timeoutSnapshot]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function getAdeUsageStats(args: GetAdeUsageStatsArgs = {}): Promise<AdeUsageStats> {
    let snapshot = lastSnapshot;
    if (inFlightPoll) {
      snapshot = await inFlightPoll.catch(() => lastSnapshot ?? emptySnapshot());
    }
    const lastPolledMs = snapshot ? Date.parse(snapshot.lastPolledAt) : Number.NaN;
    const staleSnapshot = snapshot
      ? !Number.isFinite(lastPolledMs) || Date.now() - lastPolledMs > COST_CACHE_TTL_MS
      : false;
    if (!snapshot || snapshot.costs.length === 0 || staleSnapshot) {
      snapshot = await poll().catch(() => lastSnapshot ?? emptySnapshot());
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
