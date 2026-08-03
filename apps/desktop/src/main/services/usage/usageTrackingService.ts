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
import type { AdeDb } from "../state/kvDb";
import type {
  AdeUsageDailyPoint,
  AdeUsageEstimationKind,
  AdeUsageModelSummary,
  AdeUsageProviderSummary,
  AdeUsageRangePreset,
  AdeUsageScope,
  AdeUsageStats,
  GetAdeUsageStatsArgs,
  UsageProvider,
  UsageWindow,
  UsagePacing,
  UsageProviderErrorKind,
  UsageProviderSource,
  UsageProviderStatus,
  UsageProviderStatusMap,
  CostSnapshot,
  CostTokenBreakdown,
  ExtraUsage,
  UsageSnapshot,
} from "../../../shared/types";
import { ADE_USAGE_RANGE_PRESETS, isAdeUsageRangePreset, isAdeUsageScope } from "../../../shared/types";
import { isRecord, nowIso, getErrorMessage, safeJsonParse } from "../shared/utils";
import {
  decodeOpenCodeRegistryId,
  getModelById,
  parseLocalProviderFromModelId,
  resolveModelAlias,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import {
  cacheClaudeCredentials,
  invalidateCachedClaudeCredentials,
  isClaudeTokenExpiredOrExpiring,
  isCodexTokenStale,
  readClaudeCredentialsWithRefresh,
  readCodexCredentials,
  refreshClaudeCredentials,
} from "../ai/providerCredentialSources";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "../ai/codexExecutable";
import { resolveCliSpawnInvocation, terminateProcessTree } from "../shared/processExecution";
import { stripAnsi } from "../../utils/ansiStrip";
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
  sanitizeClaudeProjectPath,
} from "./ledgers/localUsageLedgers";
import {
  collectAdeDatabaseUsageStats,
  type AdeDatabaseUsageStats,
} from "./usageStatsStore";
import {
  scanUsageLedgersInWorker,
  type UsageLedgerScanResult,
} from "./usageLedgerWorkerClient";
import type {
  FreshUsageProviderPollResult,
  UsageProviderPollContext,
  UsageProviderPollResult,
  UsageProviderStrategy,
  UsageRefreshReason,
} from "./usageProviderStrategies";
import { localDayKey, localDayOffset, localDayStart } from "./localDay";
import {
  computeResetsInMs,
  parseClaudeWindows,
  parseCodexRateLimitSnapshot,
  parseCodexRateLimitWindows,
  type ClaudeUsageResponse,
} from "./providerQuotaParsers";

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 2 * 60_000; // 2 min
const MIN_POLL_INTERVAL_MS = 60_000;          // 1 min
const MAX_POLL_INTERVAL_MS = 15 * 60_000;     // 15 min
const ACTIVE_POLL_INTERVAL_MS = 60_000;
const IDLE_POLL_INTERVAL_MS = 5 * 60_000;
const IDLE_AFTER_MS = 15 * 60_000;
const QUOTA_DEMAND_LEASE_MS = 90_000;
const COST_CACHE_TTL_MS = 60 * 60_000;        // 1 hour; history scans are intentionally low priority
const COST_REFRESH_RETRY_BASE_MS = 60_000;
const COST_REFRESH_RETRY_MAX_MS = 15 * 60_000;
const CODEX_CLI_RPC_TIMEOUT_MS = 10_000;
const CLAUDE_CLI_USAGE_TIMEOUT_MS = 16_000;
const QUOTA_REFRESH_RESPONSE_TIMEOUT_MS = 20_000;
const USAGE_SNAPSHOT_CACHE_VERSION = 3;
const USAGE_SNAPSHOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const USAGE_SNAPSHOT_CACHE_PATH = path.join(os.homedir(), ".ade", "cache", "usage-snapshot.json");
const GITHUB_STATS_CACHE_TTL_MS = 10 * 60_000;
const GITHUB_STATS_COMMAND_TIMEOUT_MS = 60_000;
const GITHUB_STATS_FAST_RESPONSE_TIMEOUT_MS = 2_500;
const GITHUB_STATS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
let usageSnapshotCacheWriteTail: Promise<void> = Promise.resolve();
let usageSnapshotCacheWriteSequence = 0;

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
    && (value.spendControlReached === undefined || typeof value.spendControlReached === "boolean")
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
  const sequence = ++usageSnapshotCacheWriteSequence;
  const tempPath = `${USAGE_SNAPSHOT_CACHE_PATH}.${process.pid}.${sequence}.tmp`;
  const write = usageSnapshotCacheWriteTail.then(async () => {
    try {
      await fs.promises.mkdir(path.dirname(USAGE_SNAPSHOT_CACHE_PATH), { recursive: true });
      await fs.promises.writeFile(
        tempPath,
        JSON.stringify({ version: USAGE_SNAPSHOT_CACHE_VERSION, snapshot }),
      );
      await fs.promises.rename(tempPath, USAGE_SNAPSHOT_CACHE_PATH);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      logger.debug("usage.snapshot_cache_write_failed", { error: getErrorMessage(error) });
    }
  });
  usageSnapshotCacheWriteTail = write;
  await write;
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

// ── HTTP Helper ──────────────────────────────────────────────────

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15_000,
  init?: { method?: string; body?: string },
): Promise<{ ok: boolean; status: number; data: unknown; retryAfterMs?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: init?.method ?? "GET",
      headers,
      ...(init?.body != null ? { body: init.body } : {}),
      signal: controller.signal,
    });
    let data: unknown = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    const retryAfterHeader = resp.headers?.get?.("retry-after")?.trim();
    let retryAfterMs: number | undefined;
    if (retryAfterHeader) {
      const seconds = Number(retryAfterHeader);
      if (Number.isFinite(seconds) && seconds >= 0) {
        retryAfterMs = Math.round(seconds * 1000);
      } else {
        const retryAt = Date.parse(retryAfterHeader);
        if (Number.isFinite(retryAt)) retryAfterMs = Math.max(0, retryAt - Date.now());
      }
    }
    return {
      ok: resp.ok,
      status: resp.status,
      data,
      ...(retryAfterMs != null ? { retryAfterMs } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Only genuine *server*/transport faults are retried. We deliberately do NOT
// retry any 4xx — a 429 means "back off, you're rate-limited", so retrying it
// amplifies load and sustains the throttle (CodexBar and the pre-retry code
// issue one request per poll and stay under the limit). 401 keeps its dedicated
// token-refresh path; 409/429/etc. return immediately and rely on carry-forward.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

type RetryOptions = {
  attempts?: number;
  perAttemptTimeoutMs?: number;
  /** Base backoff; attempt N waits backoffMs * 3^(N-1). Set 0 to disable (tests). */
  backoffMs?: number;
  init?: { method?: string; body?: string };
};

/**
 * fetchJson with a single bounded retry for transient server / network faults
 * (5xx, plus network/timeout aborts). Any 4xx — including 429 (rate-limit) and
 * 409 — returns on the first try so we never hammer a throttled endpoint; a
 * thrown error on the final attempt propagates to the caller.
 */
async function fetchJsonWithRetry(
  url: string,
  headers: Record<string, string>,
  opts: RetryOptions = {},
): Promise<{ ok: boolean; status: number; data: unknown; retryAfterMs?: number }> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  const timeoutMs = opts.perAttemptTimeoutMs ?? 8_000;
  const backoffMs = opts.backoffMs ?? 400;
  let last: { ok: boolean; status: number; data: unknown; retryAfterMs?: number } | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && backoffMs > 0) {
      await delay(backoffMs * 3 ** (attempt - 1));
    }
    try {
      const result = await fetchJson(url, headers, timeoutMs, opts.init);
      last = result;
      if (result.ok || !RETRYABLE_STATUS.has(result.status)) return result;
    } catch (err) {
      if (attempt === attempts - 1) throw err;
    }
  }
  return last ?? { ok: false, status: 0, data: null };
}

function errorKindForHttpStatus(status: number): UsageProviderErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 0) return "network";
  return "unknown";
}

function errorKindForThrown(error: unknown): UsageProviderErrorKind {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("abort") || message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }
  return "network";
}

async function measureUsagePhase<T>(
  logger: Logger,
  args: {
    provider?: UsageProvider;
    phase: string;
    reason: UsageRefreshReason;
  },
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const value = await work();
    logger.debug("usage.refresh.phase", {
      ...args,
      durationMs: Date.now() - startedAt,
      outcome: "ok",
    });
    return value;
  } catch (error) {
    logger.debug("usage.refresh.phase", {
      ...args,
      durationMs: Date.now() - startedAt,
      outcome: "error",
      errorKind: errorKindForThrown(error),
    });
    throw error;
  }
}

function parseClaudeCliReset(raw: string | null, fallbackDurationMs: number, nowMs = Date.now()): string {
  if (!raw) return new Date(nowMs + fallbackDurationMs).toISOString();
  const cleaned = raw
    .replace(/^\s*resets?\s*(?:at\s*)?/i, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\bat\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const timeOnly = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (timeOnly) {
    let hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2] ?? 0);
    const suffix = timeOnly[3]?.toLowerCase();
    if (suffix === "pm" && hour < 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
    const next = new Date(nowMs);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  const hasYear = /\b\d{4}\b/.test(cleaned);
  const candidateText = hasYear ? cleaned : `${cleaned} ${new Date(nowMs).getFullYear()}`;
  let parsed = Date.parse(candidateText);
  if (Number.isFinite(parsed)) {
    if (!hasYear && parsed < nowMs - 86_400_000) {
      parsed = Date.parse(`${cleaned} ${new Date(nowMs).getFullYear() + 1}`);
    }
    if (Number.isFinite(parsed) && parsed > nowMs - 86_400_000) return new Date(parsed).toISOString();
  }
  return new Date(nowMs + fallbackDurationMs).toISOString();
}

function parseClaudeCliWindow(
  text: string,
  label: RegExp,
  windowType: UsageWindow["windowType"],
  durationMs: number,
): UsageWindow | null {
  const match = label.exec(text);
  if (!match || match.index == null) return null;
  const tail = text.slice(match.index, match.index + 1_400);
  const boundary = tail.slice(1).search(/current\s+(?:session|week)/i);
  const block = boundary >= 0 ? tail.slice(0, boundary + 1) : tail;
  const percentMatch = block.match(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%\s*(used|spent|consumed|left|remaining|available)?/i);
  if (!percentMatch) return null;
  const rawPercent = Math.max(0, Math.min(100, Number(percentMatch[1])));
  if (!Number.isFinite(rawPercent)) return null;
  const qualifier = percentMatch[2]?.toLowerCase();
  const percentUsed = qualifier === "used" || qualifier === "spent" || qualifier === "consumed"
    ? rawPercent
    : 100 - rawPercent;
  const resetMatch = block.match(/resets?\s*(?:at\s*)?([^\n\r]+)/i);
  const resetsAt = parseClaudeCliReset(resetMatch?.[0] ?? null, durationMs);
  return {
    provider: "claude",
    windowType,
    percentUsed,
    resetsAt,
    resetsInMs: computeResetsInMs(resetsAt),
    windowDurationMs: durationMs,
  };
}

function parseClaudeCliUsage(text: string): UsageWindow[] {
  const clean = stripAnsi(text);
  const panelStart = clean.toLowerCase().lastIndexOf("settings:");
  const panel = panelStart >= 0 ? clean.slice(panelStart) : clean;
  return [
    parseClaudeCliWindow(panel, /current\s+session/i, "five_hour", 5 * 60 * 60_000),
    parseClaudeCliWindow(panel, /current\s+week\s*\(all\s+models\)/i, "weekly", 7 * 24 * 60 * 60_000),
  ].filter((window): window is UsageWindow => window != null);
}

async function captureClaudeCliUsage(logger: Logger): Promise<string> {
  const module = await import("node-pty");
  const nodePty = ((module as unknown as { default?: typeof module }).default ?? module);
  const resolved = resolveClaudeCodeExecutable();
  const env = { ...process.env, TERM: "xterm-256color" };
  const invocation = resolveCliSpawnInvocation(resolved.path, [], env);
  const cwd = path.join(os.homedir(), ".ade", "cache", "claude-usage-probe");
  await fs.promises.mkdir(cwd, { recursive: true });

  return await new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const answeredPrompts = new Set<string>();
    const terminal = nodePty.spawn(invocation.command, invocation.args, {
      name: "xterm-256color",
      cols: 100,
      rows: 40,
      cwd,
      env,
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(enterTimer);
      if (settleTimer) clearTimeout(settleTimer);
      try {
        terminal.kill();
      } catch {
        // already exited
      }
      if (error) reject(error);
      else resolve(output);
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Claude CLI /usage timed out after ${CLAUDE_CLI_USAGE_TIMEOUT_MS}ms`));
    }, CLAUDE_CLI_USAGE_TIMEOUT_MS);
    timeout.unref?.();
    const enterTimer = setInterval(() => {
      try {
        terminal.write("\r");
      } catch {
        // process is exiting
      }
    }, 800);
    enterTimer.unref?.();

    terminal.onData((chunk) => {
      if (output.length < 120_000) output += chunk.slice(0, 120_000 - output.length);
      const clean = stripAnsi(output);
      const lower = clean.toLowerCase();
      const promptResponses = [
        ["do you trust the files in this folder?", "y\r"],
        ["quick safety check:", "\r"],
        ["yes, i trust this folder", "\r"],
        ["ready to code here?", "\r"],
        ["press enter to continue", "\r"],
      ] as const;
      for (const [prompt, response] of promptResponses) {
        if (lower.includes(prompt) && !answeredPrompts.has(prompt)) {
          answeredPrompts.add(prompt);
          terminal.write(response);
        }
      }
      if (lower.includes("login") && (lower.includes("not signed in") || lower.includes("authentication required"))) {
        finish(new Error("Claude CLI sign-in is required."));
        return;
      }
      if (parseClaudeCliUsage(clean).length > 0 && !settleTimer) {
        settleTimer = setTimeout(() => finish(), 700);
      }
    });
    terminal.onExit(({ exitCode }) => {
      if (parseClaudeCliUsage(output).length > 0) finish();
      else finish(new Error(`Claude CLI exited before returning usage (${exitCode}).`));
    });

    setTimeout(() => {
      if (settled) return;
      try {
        terminal.write("/usage\r");
      } catch (error) {
        logger.debug("usage.refresh.phase", {
          provider: "claude",
          phase: "cli_write",
          outcome: "error",
          errorKind: errorKindForThrown(error),
        });
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }, 500).unref?.();
  });
}

async function pollClaudeViaCli(logger: Logger): Promise<FreshUsageProviderPollResult> {
  try {
    const output = await captureClaudeCliUsage(logger);
    const windows = parseClaudeCliUsage(output);
    if (windows.length === 0) {
      return {
        windows: [],
        source: "cli",
        errors: ["claude: CLI usage response contained no recognized windows"],
        errorKind: "invalid_response",
      };
    }
    return { windows, source: "cli", errors: [] };
  } catch (error) {
    return {
      windows: [],
      source: "cli",
      errors: [`claude: CLI fallback failed: ${getErrorMessage(error)}`],
      errorKind: errorKindForThrown(error) === "timeout" ? "timeout" : "unavailable",
    };
  }
}

// Cursor usage polling was removed in 2026-05 — Cursor only exposes
// team-admin endpoints (/teams/spend, /teams/filtered-usage-events,
// /teams/daily-usage-data) with no personal-user surface, so the per-user
// drawer state could never be meaningful for the typical ADE user.

async function pollClaudeUsage(
  logger: Logger,
  context: UsageProviderPollContext = { reason: "user" },
): Promise<UsageProviderPollResult> {
  const allowInteractiveSources = context.reason === "user";
  const creds = await measureUsagePhase(
    logger,
    { provider: "claude", phase: "credentials", reason: context.reason },
    () => readClaudeCredentialsWithRefresh(logger, { allowKeychain: allowInteractiveSources }),
  );
  if (!creds) {
    if (allowInteractiveSources) {
      return await measureUsagePhase(
        logger,
        { provider: "claude", phase: "cli_fallback", reason: context.reason },
        () => pollClaudeViaCli(logger),
      );
    }
    return {
      disposition: "preserve_previous",
      windows: [],
      errors: [],
      source: "oauth",
    };
  }

  try {
    const result = await measureUsagePhase(
      logger,
      { provider: "claude", phase: "oauth_http", reason: context.reason },
      () => fetchJsonWithRetry(CLAUDE_USAGE_URL, {
        Authorization: `Bearer ${creds.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      }),
    );

    if (!result.ok) {
      if (result.status === 401 && creds.refreshToken) {
        logger.info("usage.token_refresh.401_retry");
        invalidateCachedClaudeCredentials();
        const refreshed = await measureUsagePhase(
          logger,
          { provider: "claude", phase: "token_refresh", reason: context.reason },
          () => refreshClaudeCredentials(creds.refreshToken!),
        );
        if (refreshed) {
          cacheClaudeCredentials(refreshed);
          const retry = await measureUsagePhase(
            logger,
            { provider: "claude", phase: "oauth_http_retry", reason: context.reason },
            () => fetchJsonWithRetry(CLAUDE_USAGE_URL, {
              Authorization: `Bearer ${refreshed.accessToken}`,
              "anthropic-beta": "oauth-2025-04-20",
            }),
          );
          if (retry.ok) {
            const parsed = parseClaudeWindows(retry.data as ClaudeUsageResponse);
            if (parsed.windows.length > 0) {
              return { windows: parsed.windows, source: "oauth", extraUsage: parsed.extraUsage, errors: [] };
            }
          }
        }
      }

      if (allowInteractiveSources) {
        const fallback = await measureUsagePhase(
          logger,
          { provider: "claude", phase: "cli_fallback", reason: context.reason },
          () => pollClaudeViaCli(logger),
        );
        if (fallback.windows.length > 0) return fallback;
      }
      return {
        windows: [],
        source: "oauth",
        extraUsage: null,
        errors: [`claude: API returned ${result.status}`],
        errorKind: errorKindForHttpStatus(result.status),
        ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
      };
    }

    const parsed = parseClaudeWindows(result.data as ClaudeUsageResponse);
    if (parsed.windows.length === 0) {
      logger.warn("usage.poll.claude_unrecognized_shape", {
        keys: isRecord(result.data) ? Object.keys(result.data).slice(0, 12) : [],
      });
      if (allowInteractiveSources) {
        const fallback = await measureUsagePhase(
          logger,
          { provider: "claude", phase: "cli_fallback", reason: context.reason },
          () => pollClaudeViaCli(logger),
        );
        if (fallback.windows.length > 0) return fallback;
      }
      return {
        windows: [],
        source: "oauth",
        extraUsage: null,
        errors: ["claude: usage response contained no recognized windows"],
        errorKind: "invalid_response",
      };
    }
    return { windows: parsed.windows, source: "oauth", extraUsage: parsed.extraUsage, errors: [] };
  } catch (error) {
    if (allowInteractiveSources) {
      const fallback = await measureUsagePhase(
        logger,
        { provider: "claude", phase: "cli_fallback", reason: context.reason },
        () => pollClaudeViaCli(logger),
      );
      if (fallback.windows.length > 0) return fallback;
    }
    return {
      windows: [],
      source: "oauth",
      extraUsage: null,
      errors: [`claude: ${getErrorMessage(error)}`],
      errorKind: errorKindForThrown(error),
    };
  }
}

// ── Codex Usage Polling ──────────────────────────────────────────

async function pollCodexUsage(
  logger: Logger,
  context: UsageProviderPollContext = { reason: "user" },
): Promise<FreshUsageProviderPollResult> {
  const creds = await measureUsagePhase(
    logger,
    { provider: "codex", phase: "credentials", reason: context.reason },
    () => readCodexCredentials(),
  );
  if (!creds) {
    return {
      windows: [],
      source: "http",
      errors: ["codex: no credentials found"],
      errorKind: "auth",
    };
  }

  try {
    const result = await measureUsagePhase(
      logger,
      { provider: "codex", phase: "quota_http", reason: context.reason },
      () => fetchJsonWithRetry(CODEX_USAGE_URL, {
        Authorization: `Bearer ${creds.accessToken}`,
      }),
    );

    if (result.ok && isRecord(result.data)) {
      const snapshot = parseCodexRateLimitSnapshot(result.data);
      if (snapshot.windows.length > 0) {
        return { ...snapshot, source: "http", errors: [] };
      }
      const fallback = await measureUsagePhase(
        logger,
        { provider: "codex", phase: "cli_rpc_fallback", reason: context.reason },
        () => pollCodexViaCliRpc(logger),
      );
      return fallback.windows.length > 0
        ? { ...fallback, source: "cli", errors: [] }
        : {
            ...fallback,
            source: "cli",
            errorKind: fallback.errorKind ?? "invalid_response",
          };
    }

    if (!result.ok && (result.status === 401 || RETRYABLE_STATUS.has(result.status))) {
      const fallback = await measureUsagePhase(
        logger,
        { provider: "codex", phase: "cli_rpc_fallback", reason: context.reason },
        () => pollCodexViaCliRpc(logger),
      );
      if (fallback.windows.length > 0) return { ...fallback, source: "cli", errors: [] };
      return {
        ...fallback,
        source: "cli",
        errors: [`codex: API returned ${result.status}`, ...fallback.errors],
        errorKind: fallback.errorKind ?? errorKindForHttpStatus(result.status),
        ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
      };
    }

    return {
      windows: [],
      source: "http",
      errors: [`codex: API returned ${result.status}`],
      errorKind: errorKindForHttpStatus(result.status),
      ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
    };
  } catch (error) {
    return {
      windows: [],
      source: "http",
      errors: [`codex: ${getErrorMessage(error)}`],
      errorKind: errorKindForThrown(error),
    };
  }
}

async function pollCodexViaCliRpc(logger: Logger): Promise<FreshUsageProviderPollResult> {
  const windows: UsageWindow[] = [];
  const errors: string[] = [];
  let spendControlReached: boolean | undefined;

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
          windowsHide: true,
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
      const id = typeof parsed.id === "number" ? parsed.id : null;

      if (id === 1) {
        const snapshot = parseCodexRateLimitSnapshot(res);
        if (snapshot.windows.length > 0) {
          windows.push(...snapshot.windows);
        }
        if (typeof snapshot.spendControlReached === "boolean") {
          spendControlReached = snapshot.spendControlReached;
        }
      }
    }
  } catch (err) {
    errors.push(`codex: CLI RPC error: ${getErrorMessage(err)}`);
    return {
      windows,
      source: "cli",
      errors,
      errorKind: errorKindForThrown(err) === "timeout" ? "timeout" : "unavailable",
    };
  }

  if (windows.length === 0 && errors.length === 0) {
    errors.push("codex: CLI RPC returned no recognized rate limits");
  }
  return {
    windows,
    ...(typeof spendControlReached === "boolean" ? { spendControlReached } : {}),
    source: "cli",
    errors,
    ...(windows.length === 0 ? { errorKind: "invalid_response" as const } : {}),
  };
}

// ── Local Cost Scanning ──────────────────────────────────────────

export function bucketDaily7d(entries: TokenEntry[], nowMs: number): number[] {
  const buckets = new Array<number>(7).fill(0);
  const today = new Date(nowMs);
  const bucketByDay = new Map<string, number>();
  for (let index = 0; index < 7; index += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6 + index);
    bucketByDay.set(localDayKey(day), index);
  }
  for (const entry of entries) {
    if (entry.lifetimeOnly) continue;
    if (entry.timestamp > nowMs) continue;
    const bucketIndex = bucketByDay.get(localDayKey(entry.timestamp));
    if (bucketIndex == null) continue;
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
  const date = localDayKey(entry.timestamp);
  if (!date) return;
  const tokens = entry.inputTokens + entry.outputTokens + entry.cachedTokens + toNonNegativeInt(entry.cacheWriteTokens);
  breakdown[date] = (breakdown[date] ?? 0) + tokens;
}

function addDailyModelTokenEntry(breakdown: DailyModelTokenBreakdown, entry: TokenEntry): void {
  const date = localDayKey(entry.timestamp);
  if (!date) return;
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
  options: {
    estimation?: AdeUsageEstimationKind;
    scopeSupported?: boolean;
  } = {},
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
  const yearStart = new Date(todayStart);
  yearStart.setDate(yearStart.getDate() - 364);
  const yearAgo = yearStart.getTime();

  const starts: Record<AdeUsageRangePreset, number | null> = {
    today: todayStartMs,
    "7d": sevenDaysAgo,
    "30d": thirtyDaysAgo,
    year: yearAgo,
    all: null,
  };
  const accumulators = Object.fromEntries(ADE_USAGE_RANGE_PRESETS.map((preset) => [preset, {
    costUsd: 0,
    tokenBreakdown: {} as TokenBreakdown,
    dailyTokens: {} as DailyTokenBreakdown,
    dailyModelTokens: {} as DailyModelTokenBreakdown,
    adeOriginatedTokens: 0,
    adeOriginatedDailyTokens: {} as DailyTokenBreakdown,
  }])) as Record<AdeUsageRangePreset, {
    costUsd: number;
    tokenBreakdown: TokenBreakdown;
    dailyTokens: DailyTokenBreakdown;
    dailyModelTokens: DailyModelTokenBreakdown;
    adeOriginatedTokens: number;
    adeOriginatedDailyTokens: DailyTokenBreakdown;
  }>;

  for (const entry of entries) {
    const cost = calculateTokenEntryCost(entry);
    if (entry.lifetimeOnly) {
      const allTime = accumulators.all;
      allTime.costUsd += cost;
      addTokenBreakdownEntry(allTime.tokenBreakdown, entry);
      continue;
    }
    for (const preset of ADE_USAGE_RANGE_PRESETS) {
      const startMs = starts[preset];
      if (startMs != null && entry.timestamp < startMs) continue;
      const accumulator = accumulators[preset];
      accumulator.costUsd += cost;
      addTokenBreakdownEntry(accumulator.tokenBreakdown, entry);
      addDailyTokenEntry(accumulator.dailyTokens, entry);
      addDailyModelTokenEntry(accumulator.dailyModelTokens, entry);
      if (entry.adeOriginated || entry.originator?.trim().toLowerCase().startsWith("ade")) {
        const adeOriginatedTokens = entry.inputTokens
          + entry.outputTokens
          + entry.cachedTokens
          + toNonNegativeInt(entry.cacheWriteTokens);
        accumulator.adeOriginatedTokens += adeOriginatedTokens;
        const date = localDayKey(entry.timestamp);
        if (date) {
          accumulator.adeOriginatedDailyTokens[date] = (accumulator.adeOriginatedDailyTokens[date] ?? 0)
            + adeOriginatedTokens;
        }
      }
    }
  }

  const roundedCost = (preset: AdeUsageRangePreset) => Math.round(accumulators[preset].costUsd * 100) / 100;

  const entryEstimations = new Set<AdeUsageEstimationKind>(
    entries.flatMap((entry) => entry.estimation ? [entry.estimation] : []),
  );
  const estimation = options.estimation
    ?? (entryEstimations.size === 1 ? [...entryEstimations][0] : entryEstimations.size > 1 ? "mixed" : undefined);

  return {
    provider,
    last30dCostUsd: roundedCost("30d"),
    todayCostUsd: roundedCost("today"),
    costUsdByPreset: Object.fromEntries(ADE_USAGE_RANGE_PRESETS.map((preset) => [preset, roundedCost(preset)])),
    tokenBreakdown: accumulators["30d"].tokenBreakdown,
    tokenBreakdownByPreset: Object.fromEntries(ADE_USAGE_RANGE_PRESETS.map((preset) => [preset, accumulators[preset].tokenBreakdown])),
    dailyTokenBreakdownByPreset: Object.fromEntries(ADE_USAGE_RANGE_PRESETS.map((preset) => [preset, accumulators[preset].dailyModelTokens])),
    dailyTokensByPreset: Object.fromEntries(ADE_USAGE_RANGE_PRESETS.map((preset) => [preset, accumulators[preset].dailyTokens])),
    ...(estimation ? { estimation } : {}),
    ...(options.scopeSupported != null ? { scopeSupported: options.scopeSupported } : {}),
    adeOriginatedTokensByPreset: Object.fromEntries(
      ADE_USAGE_RANGE_PRESETS.map((preset) => [preset, accumulators[preset].adeOriginatedTokens]),
    ),
    adeOriginatedDailyTokensByPreset: Object.fromEntries(
      ADE_USAGE_RANGE_PRESETS.map((preset) => [preset, accumulators[preset].adeOriginatedDailyTokens]),
    ),
  };
}

const PROVIDER_SCOPE_SUPPORT: Readonly<Record<string, boolean>> = {
  claude: true,
  codex: true,
  cursor: false,
  "cursor-agent": false,
  openclaw: false,
  opencode: false,
  droid: false,
  copilot: false,
  gemini: false,
};

const PROVIDER_ESTIMATION: Readonly<Partial<Record<string, AdeUsageEstimationKind>>> = {
  cursor: "mixed",
  "cursor-agent": "chars",
  droid: "distribution",
};

export type ProviderTokenEntries = Map<string, TokenEntry[]>;

function canonicalProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const normalized = resolved.replace(/\\/g, "/");
  const worktreeMarker = "/.ade/worktrees/";
  const markerIndex = normalized.indexOf(worktreeMarker);
  return markerIndex >= 0 ? path.resolve(normalized.slice(0, markerIndex)) : resolved;
}

function tokenEntryMatchesProject(entry: TokenEntry, projectRoot: string | null | undefined): boolean {
  if (!projectRoot) return false;
  const root = canonicalProjectRoot(projectRoot);
  if (entry.projectPath) {
    const candidate = path.resolve(entry.projectPath);
    if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) return true;
  }
  if (entry.projectKey) {
    const rootKey = sanitizeClaudeProjectPath(root);
    if (entry.projectKey === rootKey || entry.projectKey.startsWith(`${rootKey}--ade-worktrees-`)) return true;
  }
  return false;
}

export function buildCostSnapshots(
  entriesByProvider: ProviderTokenEntries,
  scope: AdeUsageScope,
  projectRoot: string | null | undefined,
): CostSnapshot[] {
  const costs: CostSnapshot[] = [];
  for (const [provider, machineEntries] of entriesByProvider) {
    const scopeSupported = PROVIDER_SCOPE_SUPPORT[provider] === true;
    const entries = scope === "project"
      ? scopeSupported ? machineEntries.filter((entry) => tokenEntryMatchesProject(entry, projectRoot)) : []
      : machineEntries;
    if (entries.length === 0) {
      if (scope === "project" && !scopeSupported && machineEntries.length > 0) {
        costs.push(aggregateCosts([], provider, {
          estimation: PROVIDER_ESTIMATION[provider],
          scopeSupported,
        }));
      }
      continue;
    }
    costs.push(aggregateCosts(entries, provider, {
      estimation: PROVIDER_ESTIMATION[provider],
      scopeSupported,
    }));
  }
  return costs;
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
  return localDayOffset(nowMs, 0)?.toISOString() ?? new Date(nowMs).toISOString();
}

function startOfLocalDayOffsetIso(nowMs: number, daysBack: number): string {
  return localDayOffset(nowMs, -Math.max(0, daysBack))?.toISOString() ?? new Date(nowMs).toISOString();
}

function widenRangeToLocalDays(range: ResolvedAdeUsageRange): ResolvedAdeUsageRange {
  const since = range.since
    ? localDayOffset(range.since, 0)?.toISOString() ?? range.since
    : null;
  const nextDay = localDayOffset(range.until, 1);
  const until = nextDay
    ? new Date(nextDay.getTime() - 1).toISOString()
    : range.until;
  return { ...range, since, until };
}

function normalizePreset(value: unknown): AdeUsageRangePreset {
  return isAdeUsageRangePreset(value) ? value : "7d";
}

function normalizeScope(value: unknown): AdeUsageScope {
  return isAdeUsageScope(value) ? value : "machine";
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
  let range: ResolvedAdeUsageRange;
  if (explicitSince) {
    range = {
      preset,
      since: Date.parse(explicitSince) > untilMs ? until : explicitSince,
      until,
    };
  } else {
    switch (preset) {
      case "today":
        range = { preset, since: startOfLocalDayIso(untilMs), until };
        break;
      case "30d":
        range = { preset, since: startOfLocalDayOffsetIso(untilMs, 29), until };
        break;
      case "year":
        range = { preset, since: startOfLocalDayOffsetIso(untilMs, 364), until };
        break;
      case "all":
        range = { preset, since: null, until };
        break;
      case "7d":
      default:
        range = { preset: "7d", since: startOfLocalDayOffsetIso(untilMs, 6), until };
        break;
    }
  }

  // Provider snapshots are calendar-day buckets. Widen custom timestamps here
  // so provider, database, and GitHub sources all use the same local-day range.
  return args?.since || args?.until ? widenRangeToLocalDays(range) : range;
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
    let providerSummary = aggregation.providers.get(cost.provider);
    if (!providerSummary) {
      providerSummary = {
        provider: cost.provider,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        rangeCostUsd: 0,
        todayCostUsd: 0,
        last30dCostUsd: 0,
      };
      aggregation.providers.set(cost.provider, providerSummary);
    }
    if (cost.estimation) providerSummary.estimation = cost.estimation;
    if (cost.scopeSupported != null) providerSummary.scopeSupported = cost.scopeSupported;
    const adeOriginatedTokens = exactRange
      ? adeOriginatedTokensForExactRange(cost, range)
      : toNonNegativeInt(cost.adeOriginatedTokensByPreset?.[range.preset]);
    if (adeOriginatedTokens != null) {
      const narrowedAdeOriginatedTokens = Math.min(providerTotalTokens, adeOriginatedTokens);
      providerSummary.adeOriginatedTokens = toNonNegativeInt(providerSummary.adeOriginatedTokens) + narrowedAdeOriginatedTokens;
      providerSummary.externalTokens = toNonNegativeInt(providerSummary.externalTokens)
        + providerTotalTokens
        - narrowedAdeOriginatedTokens;
    }
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

function adeOriginatedTokensForExactRange(cost: CostSnapshot, range: ResolvedAdeUsageRange): number | null {
  const dailyTokens = cost.adeOriginatedDailyTokensByPreset?.all;
  if (!dailyTokens) return null;
  return Object.entries(dailyTokens).reduce((sum, [date, tokens]) => (
    dateIntersectsRange(date, range) ? sum + toNonNegativeInt(tokens) : sum
  ), 0);
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
  const start = localDayStart(date);
  if (!start) return false;
  const dayStart = start.getTime();
  const dayEnd = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime() - 1;
  if (range.since && dayEnd < Date.parse(range.since)) return false;
  return dayStart <= Date.parse(range.until);
}

function emptyDailyPoint(date: string): AdeUsageDailyPoint {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    commits: 0,
    prs: 0,
    insertions: 0,
    deletions: 0,
    filesChanged: 0,
    sessions: 0,
    githubCommits: 0,
    githubPrs: 0,
    githubAdditions: 0,
    githubDeletions: 0,
  };
}

function ensureDailyPoint(points: AdeUsageDailyPoint[], byDate: Map<string, AdeUsageDailyPoint>, date: string): AdeUsageDailyPoint {
  const existing = byDate.get(date);
  if (existing) return existing;
  const point = emptyDailyPoint(date);
  points.push(point);
  byDate.set(date, point);
  return point;
}

function makeDailySkeleton(range: ResolvedAdeUsageRange, nowMs: number): AdeUsageDailyPoint[] {
  const until = new Date(range.until);
  const untilMs = Number.isFinite(until.getTime()) ? until.getTime() : nowMs;
  const maxDays =
    range.preset === "today" ? 1 :
    range.preset === "7d" ? 7 :
    range.preset === "year" || range.preset === "all" ? 365 :
    30;
  const untilDay = localDayOffset(untilMs, 0) ?? localDayOffset(nowMs, 0)!;
  const windowStart = new Date(
    untilDay.getFullYear(),
    untilDay.getMonth(),
    untilDay.getDate() - (maxDays - 1),
  );
  const sinceDay = range.since ? localDayOffset(range.since, 0) : null;
  const start = sinceDay && sinceDay.getTime() > windowStart.getTime() ? sinceDay : windowStart;

  const points: AdeUsageDailyPoint[] = [];
  for (let index = 0; index < maxDays; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    if (date.getTime() > untilDay.getTime()) break;
    points.push(emptyDailyPoint(localDayKey(date)));
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
    const dailyBreakdown = exactRange
      ? cost.dailyTokenBreakdownByPreset?.all
      : cost.dailyTokenBreakdownByPreset?.[range.preset];
    if (dailyBreakdown) {
      for (const [date, models] of Object.entries(dailyBreakdown)) {
        if (exactRange && !dateIntersectsRange(date, range)) continue;
        const point = ensureDailyPoint(points, byDate, date);
        for (const tokens of Object.values(models)) {
          const input = toNonNegativeInt(tokens.input);
          const output = toNonNegativeInt(tokens.output);
          const cached = toNonNegativeInt(tokens.cached) + toNonNegativeInt(tokens.cacheWrite);
          point.inputTokens += input;
          point.outputTokens += output;
          point.cachedTokens = toNonNegativeInt(point.cachedTokens) + cached;
          point.totalTokens += input + output + cached;
        }
      }
      continue;
    }

    const legacyDailyTokens = exactRange
      ? cost.dailyTokensByPreset?.all ?? {}
      : cost.dailyTokensByPreset?.[range.preset] ?? {};
    for (const [date, value] of Object.entries(legacyDailyTokens)) {
      if (exactRange && !dateIntersectsRange(date, range)) continue;
      const point = ensureDailyPoint(points, byDate, date);
      const tokens = toNonNegativeInt(value);
      point.totalTokens += tokens;
    }
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
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
  updatedAt?: string | null;
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
    "    pullRequests(first: 100, after: $endCursor, orderBy: { field: UPDATED_AT, direction: DESC }) {",
    "      pageInfo { hasNextPage endCursor }",
    "      nodes {",
    "        number state createdAt updatedAt closedAt mergedAt additions deletions changedFiles",
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
  return localDayKey(timestamp) || null;
}

type GithubCommandRunner = typeof runBufferedCommand;

async function scanGithubPullRequestPages({
  projectRoot,
  repoParts,
  viewer,
  range,
  runCommand = runBufferedCommand,
}: {
  projectRoot: string;
  repoParts: { owner: string; name: string };
  viewer: string;
  range: ResolvedAdeUsageRange;
  runCommand?: GithubCommandRunner;
}): Promise<GitHubPullRequestRow[]> {
  const rows: GitHubPullRequestRow[] = [];
  let endCursor: string | null = null;
  do {
    const raw = await runCommand(
      "gh",
      [
        "api",
        "graphql",
        "-F",
        `owner=${repoParts.owner}`,
        "-F",
        `name=${repoParts.name}`,
        ...(endCursor ? ["-F", `endCursor=${endCursor}`] : []),
        "-f",
        `query=${githubPullRequestGraphqlQuery()}`,
        "--jq",
        ".data.repository.pullRequests",
      ],
      { cwd: projectRoot },
    );
    const page = safeJsonParse<unknown>(raw.trim(), null);
    if (!isRecord(page)) break;
    const nodes = Array.isArray(page.nodes)
      ? page.nodes.filter(isRecord) as GitHubPullRequestRow[]
      : [];
    rows.push(...nodes.filter((row) => isRecord(row.author) && row.author.login === viewer));

    const oldestUpdatedAt = nodes
      .map((row) => typeof row.updatedAt === "string" ? Date.parse(row.updatedAt) : Number.NaN)
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (range.since && oldestUpdatedAt != null && oldestUpdatedAt < Date.parse(range.since)) break;

    const pageInfo = isRecord(page.pageInfo) ? page.pageInfo : null;
    const hasNextPage = pageInfo?.hasNextPage === true;
    endCursor = hasNextPage && typeof pageInfo?.endCursor === "string" && pageInfo.endCursor
      ? pageInfo.endCursor
      : null;
  } while (endCursor);
  return rows;
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

    const [prs, commitRaw] = await Promise.all([
      scanGithubPullRequestPages({ projectRoot, repoParts, viewer, range }),
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
    const point = ensureDailyPoint(points, byDate, row.date);
    point.githubCommits = toNonNegativeInt(point.githubCommits) + toNonNegativeInt(row.commits);
    point.githubPrs = toNonNegativeInt(point.githubPrs) + toNonNegativeInt(row.prs);
    point.githubAdditions = toNonNegativeInt(point.githubAdditions) + toNonNegativeInt(row.insertions);
    point.githubDeletions = toNonNegativeInt(point.githubDeletions) + toNonNegativeInt(row.deletions);
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
}

function mergeDatabaseDaily(points: AdeUsageDailyPoint[], databaseStats: AdeDatabaseUsageStats | null | undefined): void {
  if (!databaseStats) return;
  const byDate = new Map(points.map((point) => [point.date, point]));
  for (const row of databaseStats.daily) {
    const point = ensureDailyPoint(points, byDate, row.date);
    // Provider ledgers are the authoritative token source when present. The
    // ADE DB log is a subset of those calls, so use it only as a gap-filler.
    if (point.totalTokens === 0 && toNonNegativeInt(row.totalTokens) > 0) {
      point.inputTokens = toNonNegativeInt(row.inputTokens);
      point.outputTokens = toNonNegativeInt(row.outputTokens);
      point.totalTokens = toNonNegativeInt(row.totalTokens);
    }
    point.sessions += toNonNegativeInt(row.sessions);
    point.durationMs = toNonNegativeInt(point.durationMs) + toNonNegativeInt(row.durationMs);
    point.interactions = toNonNegativeInt(point.interactions) + toNonNegativeInt(row.interactions);
    point.clients = { ...(point.clients ?? {}), ...(row.clients ?? {}) };
    point.commits += toNonNegativeInt(row.commits);
    point.prs += toNonNegativeInt(row.prs);
    point.insertions += toNonNegativeInt(row.insertions);
    point.deletions += toNonNegativeInt(row.deletions);
    point.filesChanged += toNonNegativeInt(row.filesChanged);
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
}

function collectAdeUsageStats({
  snapshot,
  githubStats,
  databaseStats,
  args,
  nowMs = Date.now(),
}: {
  snapshot: UsageSnapshot;
  githubStats?: GitHubActivityStats | null;
  databaseStats?: AdeDatabaseUsageStats | null;
  args?: GetAdeUsageStatsArgs;
  nowMs?: number;
}): AdeUsageStats {
  const range = resolveAdeUsageRange(args, nowMs);
  const scope = normalizeScope(args?.scope);
  const exactProviderRange = Boolean(args?.since || args?.until);
  const providerModelAggregation = createProviderModelAggregation();
  addSnapshotProviderUsage(providerModelAggregation, snapshot, range, exactProviderRange);
  const { providers, models } = sortedProviderModelSummaries(providerModelAggregation);
  const fallbackObserved = summarizeObservedProviderUsage(providers);
  const runtimeDaily = makeDailySkeleton(range, nowMs);
  mergeSnapshotDailyTokens(runtimeDaily, snapshot.costs, range, exactProviderRange);
  const resolvedGithubStats = githubStats ?? EMPTY_GITHUB_STATS;
  mergeGithubDaily(runtimeDaily, resolvedGithubStats);
  mergeDatabaseDaily(runtimeDaily, databaseStats);
  const dbSummary = databaseStats?.summary;
  const trackedAdeTokens = toNonNegativeInt(dbSummary?.trackedAdeTokens);
  const totalTokens = fallbackObserved.totalTokens > 0 ? fallbackObserved.totalTokens : trackedAdeTokens;
  const fallback: AdeUsageStats = {
    generatedAt: new Date(nowMs).toISOString(),
    scope,
    range,
    summary: {
      totalTokens,
      tokenTotalSource: fallbackObserved.totalTokens > 0 ? "provider_logs" : "ade_db",
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
      trackedAdeTokens,
      trackedAdeInputTokens: toNonNegativeInt(dbSummary?.trackedAdeInputTokens),
      trackedAdeOutputTokens: toNonNegativeInt(dbSummary?.trackedAdeOutputTokens),
      trackedAdeCalls: toNonNegativeInt(dbSummary?.trackedAdeCalls),
      trackedAdeDurationMs: toNonNegativeInt(dbSummary?.trackedAdeDurationMs),
      workerTokens: 0,
      workerCostUsd: 0,
      chatSessions: toNonNegativeInt(dbSummary?.chatSessions),
      terminalSessions: toNonNegativeInt(dbSummary?.terminalSessions),
      activeLanes: toNonNegativeInt(dbSummary?.activeLanes),
      lanesCreated: toNonNegativeInt(dbSummary?.lanesCreated),
      lanesArchived: toNonNegativeInt(dbSummary?.lanesArchived),
      lanesDeleted: 0,
      // Legacy code-movement fields are local ADE DB values only. GitHub
      // activity is exposed through githubActivity and the github* daily fields.
      commitsCreated: toNonNegativeInt(dbSummary?.commitsCreated),
      pushOperations: toNonNegativeInt(dbSummary?.pushOperations),
      prLandings: toNonNegativeInt(dbSummary?.prLandings),
      prsTracked: resolvedGithubStats.prsTracked,
      prsOpen: resolvedGithubStats.prsOpen,
      prsMerged: resolvedGithubStats.prsMerged,
      prsClosed: resolvedGithubStats.prsClosed,
      prAdditions: resolvedGithubStats.prAdditions,
      prDeletions: resolvedGithubStats.prDeletions,
      filesChanged: toNonNegativeInt(dbSummary?.filesChanged),
      insertions: toNonNegativeInt(dbSummary?.insertions),
      deletions: toNonNegativeInt(dbSummary?.deletions),
      artifactsCaptured: toNonNegativeInt(dbSummary?.artifactsCaptured),
      automationRuns: toNonNegativeInt(dbSummary?.automationRuns),
      workerRuns: toNonNegativeInt(dbSummary?.workerRuns),
      totalInteractions: toNonNegativeInt(dbSummary?.totalInteractions),
      activeDays: toNonNegativeInt(dbSummary?.activeDays),
      currentStreakDays: toNonNegativeInt(dbSummary?.currentStreakDays),
      longestStreakDays: toNonNegativeInt(dbSummary?.longestStreakDays),
      longestSessionMs: toNonNegativeInt(dbSummary?.longestSessionMs),
    },
    githubActivity: {
      commits: resolvedGithubStats.commitsCreated,
      prsTracked: resolvedGithubStats.prsTracked,
      prsOpen: resolvedGithubStats.prsOpen,
      prsMerged: resolvedGithubStats.prsMerged,
      prsClosed: resolvedGithubStats.prsClosed,
      prAdditions: resolvedGithubStats.prAdditions,
      prDeletions: resolvedGithubStats.prDeletions,
    },
    localActivity: {
      commits: toNonNegativeInt(dbSummary?.commitsCreated),
      pushOperations: toNonNegativeInt(dbSummary?.pushOperations),
      prLandings: toNonNegativeInt(dbSummary?.prLandings),
      filesChanged: toNonNegativeInt(dbSummary?.filesChanged),
      insertions: toNonNegativeInt(dbSummary?.insertions),
      deletions: toNonNegativeInt(dbSummary?.deletions),
    },
    providers,
    models,
    adeProviders: databaseStats?.providers ?? [],
    adeModels: databaseStats?.models ?? [],
    agentProviders: databaseStats?.agentProviders ?? [],
    agentModels: databaseStats?.agentModels ?? [],
    features: databaseStats?.features ?? [],
    lanes: databaseStats?.lanes ?? [],
    activities: databaseStats?.activities ?? [],
    clients: databaseStats?.clients ?? [],
    daily: runtimeDaily,
    github: {
      repo: resolvedGithubStats.repo,
      available: resolvedGithubStats.available,
      lastFetchedAt: resolvedGithubStats.fetchedAt,
      error: resolvedGithubStats.error,
    },
    sourceNotes: [
      "Provider totals are deduplicated from local provider ledgers.",
      "ADE sessions, code movement, and client activity come from the project database.",
      ...(resolvedGithubStats.available ? ["GitHub commit and pull request activity is cached separately."] : []),
    ],
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

const PROVIDER_DISPLAY_NAME: Record<UsageProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

function filterUnexpiredCarriedWindows(prevWindows: UsageWindow[], polledAt: string): UsageWindow[] {
  const nowMs = Date.parse(polledAt);
  if (!Number.isFinite(nowMs)) return prevWindows;
  return prevWindows
    .filter((window) => {
      const resetMs = Date.parse(window.resetsAt);
      return !Number.isFinite(resetMs) || resetMs > nowMs;
    })
    .map((window) => {
      const resetMs = Date.parse(window.resetsAt);
      if (!Number.isFinite(resetMs)) return window;
      const resetsInMs = Math.max(0, resetMs - nowMs);
      return resetsInMs === window.resetsInMs ? window : { ...window, resetsInMs };
    });
}

/**
 * Reconcile a provider's freshly-polled windows against the last snapshot so a
 * transient failure never blanks good data. When the poll yields nothing, we
 * carry forward the previous windows and mark the provider `stale` (or
 * `unauthed`/`error` when there is no fallback). Returns the windows to render
 * plus the per-provider status and the timestamp of the last real success.
 */
function buildProviderWindows(
  provider: UsageProvider,
  freshWindows: UsageWindow[],
  errors: string[],
  prevWindows: UsageWindow[],
  prevStatus: UsageProviderStatus | string | null,
  polledAt: string,
  source?: UsageProviderSource,
  errorKind?: UsageProviderErrorKind,
  nextRetryAt?: string | null,
): { windows: UsageWindow[]; status: UsageProviderStatus; lastSuccessAt: string | null } {
  const normalizedPrevStatus: UsageProviderStatus | null = typeof prevStatus === "string"
    ? { state: "stale", lastSuccessAt: prevStatus, updatedAt: prevStatus }
    : prevStatus;
  const prevLastSuccessAt = normalizedPrevStatus?.lastSuccessAt ?? null;
  const resolvedSource = source ?? normalizedPrevStatus?.source;
  if (freshWindows.length > 0) {
    return {
      windows: freshWindows,
      status: {
        state: "ok",
        lastSuccessAt: polledAt,
        updatedAt: polledAt,
        lastAttemptAt: polledAt,
        ...(resolvedSource ? { source: resolvedSource } : {}),
      },
      lastSuccessAt: polledAt,
    };
  }

  const name = PROVIDER_DISPLAY_NAME[provider] ?? provider;
  const unauthed = errorKind === "auth" || errors.some((entry) => /no .*credentials/i.test(entry));
  // A 401/403 means we reached the API but auth was rejected (expired token,
  // failed refresh) — that's "reconnect", not "couldn't reach".
  const authExpired = errors.some((entry) => /\b(401|403)\b|authentication|invalid.*credential/i.test(entry));

  const carriedWindows = filterUnexpiredCarriedWindows(prevWindows, polledAt);
  if (unauthed || authExpired) {
    return {
      windows: carriedWindows,
      status: {
        state: "unauthed",
        lastSuccessAt: prevLastSuccessAt,
        updatedAt: normalizedPrevStatus?.updatedAt ?? prevLastSuccessAt,
        lastAttemptAt: polledAt,
        errorKind: errorKind ?? "auth",
        ...(resolvedSource ? { source: resolvedSource } : {}),
        ...(nextRetryAt ? { nextRetryAt } : {}),
        message: `${name} sign-in required — reconnect to refresh`,
      },
      lastSuccessAt: prevLastSuccessAt,
    };
  }

  if (carriedWindows.length > 0) {
    return {
      windows: carriedWindows,
      status: {
        state: "stale",
        lastSuccessAt: prevLastSuccessAt,
        updatedAt: normalizedPrevStatus?.updatedAt ?? prevLastSuccessAt,
        lastAttemptAt: polledAt,
        ...(resolvedSource ? { source: resolvedSource } : {}),
        ...(errorKind ? { errorKind } : {}),
        ...(nextRetryAt ? { nextRetryAt } : {}),
        message: `Couldn't refresh ${name} — showing last reading`,
      },
      lastSuccessAt: prevLastSuccessAt,
    };
  }

  return {
    windows: [],
    status: {
      state: "error",
      lastSuccessAt: prevLastSuccessAt,
      updatedAt: normalizedPrevStatus?.updatedAt ?? prevLastSuccessAt,
      lastAttemptAt: polledAt,
      ...(resolvedSource ? { source: resolvedSource } : {}),
      ...(errorKind ? { errorKind } : {}),
      ...(nextRetryAt ? { nextRetryAt } : {}),
      message: prevWindows.length > 0
        ? `Couldn't refresh ${name} — last reading expired`
        : errorKind === "rate_limited"
          ? `${name} is rate-limiting usage checks — waiting to retry`
          : `Couldn't reach ${name} — retrying`,
    },
    lastSuccessAt: prevLastSuccessAt,
  };
}

// ── Service Factory ──────────────────────────────────────────────

export type UsageTrackingService = ReturnType<typeof createUsageTrackingService>;

type UsageTrackingDependencies = {
  pollClaudeUsage?: (context?: UsageProviderPollContext) => Promise<UsageProviderPollResult>;
  pollCodexUsage?: (context?: UsageProviderPollContext) => Promise<UsageProviderPollResult>;
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
  collectDatabaseStats?: (range: ResolvedAdeUsageRange) => AdeDatabaseUsageStats | null;
  scanUsageLedgers?: (projectRoot: string | null | undefined, signal: AbortSignal) => Promise<UsageLedgerScanResult>;
};

type PollOptions = {
  reason?: UsageRefreshReason;
};

function providerBackoffMs(result: UsageProviderPollResult, failureCount: number): number {
  const exponential = Math.min(
    MAX_POLL_INTERVAL_MS,
    60_000 * 2 ** Math.min(4, failureCount - 1),
  );
  if (result.errorKind === "rate_limited") return Math.max(result.retryAfterMs ?? 0, exponential);
  if (result.errorKind === "forbidden") return MAX_POLL_INTERVAL_MS;
  return exponential;
}

function costRefreshBackoffMs(failureCount: number): number {
  return Math.min(
    COST_REFRESH_RETRY_MAX_MS,
    COST_REFRESH_RETRY_BASE_MS * 2 ** Math.min(4, Math.max(0, failureCount - 1)),
  );
}

export function createUsageTrackingService({
  logger,
  pollIntervalMs: configuredInterval,
  onUpdate,
  dependencies,
  projectRoot,
  db,
}: {
  logger: Logger;
  pollIntervalMs?: number;
  onUpdate?: (snapshot: UsageSnapshot) => void;
  dependencies?: UsageTrackingDependencies;
  projectRoot?: string | null;
  db?: AdeDb | null;
}) {
  const pollIntervalMs = Math.max(
    MIN_POLL_INTERVAL_MS,
    Math.min(MAX_POLL_INTERVAL_MS, configuredInterval ?? DEFAULT_POLL_INTERVAL_MS)
  );

  let lastSnapshot: UsageSnapshot | null = readCachedUsageSnapshot(logger);
  let cachedCosts: CostSnapshot[] = lastSnapshot?.costs ?? [];
  let cachedAdeCosts: CostSnapshot[] = lastSnapshot?.adeCosts ?? [];
  let cachedProjectCosts: CostSnapshot[] = [];
  let projectCostsReady = false;
  const cachedCostTimestampIso = lastSnapshot?.costsLastPolledAt
    ?? (cachedCosts.length > 0 || cachedAdeCosts.length > 0 ? lastSnapshot?.lastPolledAt : null);
  const cachedCostTimestampMs = cachedCostTimestampIso ? Date.parse(cachedCostTimestampIso) : Number.NaN;
  let costCacheTimestamp = Number.isFinite(cachedCostTimestampMs) ? cachedCostTimestampMs : 0;
  let costRefreshFailureCount = 0;
  let costRefreshNextRetryAtMs = 0;
  let cachedDaily7d: Partial<Record<UsageProvider, number[]>> = lastSnapshot?.dailyUsage7d ?? {};
  // Track the last poll that returned real windows per provider so carried-forward
  // (stale) data can still report when it was genuinely fresh.
  const providerLastSuccess: Partial<Record<UsageProvider, string>> = {};
  for (const provider of ["claude", "codex"] as const) {
    const cachedStatus = lastSnapshot?.providerStatus?.[provider];
    if (cachedStatus?.lastSuccessAt) {
      providerLastSuccess[provider] = cachedStatus.lastSuccessAt;
    } else if (lastSnapshot && lastSnapshot.windows.some((w) => w.provider === provider)) {
      providerLastSuccess[provider] = lastSnapshot.lastPolledAt;
    }
  }
  const githubStatsCache = new Map<string, { fetchedAtMs: number; stats: GitHubActivityStats }>();
  const githubStatsInFlight = new Map<string, Promise<GitHubActivityStats>>();
  const statsRefreshInFlight = new Map<string, Promise<void>>();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollingEnabled = false;
  let inFlightPoll: Promise<UsageSnapshot> | null = null;
  let inFlightPollReason: UsageRefreshReason | null = null;
  let inFlightHistoryRefresh: Promise<UsageSnapshot> | null = null;
  let demandLeaseUntilMs = 0;
  let lastDemandAtMs = Date.now();
  const providerFailureCount: Partial<Record<UsageProvider, number>> = {};
  const providerNextRetryAtMs: Partial<Record<UsageProvider, number>> = {};
  const runClaudeUsagePoll = dependencies?.pollClaudeUsage ?? ((context) => pollClaudeUsage(logger, context));
  const runCodexUsagePoll = dependencies?.pollCodexUsage ?? ((context) => pollCodexUsage(logger, context));
  const providerStrategies: UsageProviderStrategy[] = [
    { provider: "claude", poll: (context) => runClaudeUsagePoll(context) },
    { provider: "codex", poll: (context) => runCodexUsagePoll(context) },
  ];
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
  const collectDatabaseStatsForRange = dependencies?.collectDatabaseStats
    ?? ((range: ResolvedAdeUsageRange) => collectAdeDatabaseUsageStats(db, range, logger));
  const hasInjectedLedgerScanners = Boolean(
    dependencies?.scanClaudeLogs
    || dependencies?.scanCodexLogs
    || dependencies?.scanCursorLogs
    || dependencies?.scanCursorAgentLogs
    || dependencies?.scanOpenClawLogs
    || dependencies?.scanOpenCodeLogs
    || dependencies?.scanDroidLogs
    || dependencies?.scanCopilotLogs
    || dependencies?.scanGeminiLogs,
  );
  const ledgerAbortController = new AbortController();
  let disposed = false;

  const emptySnapshot = (): UsageSnapshot => ({
    windows: [],
    pacing: emptyPacing(),
    pacingByProvider: {},
    providerStatus: {},
    costs: [],
    adeCosts: [],
    extraUsage: [],
    lastPolledAt: nowIso(),
    errors: [],
  });

  function emitUpdate(snapshot: UsageSnapshot): void {
    if (disposed) return;
    try {
      onUpdate?.(snapshot);
    } catch {
      // Never crash on callback error
    }
  }

  function cachedCostResult(): { costs: CostSnapshot[]; adeCosts: CostSnapshot[] } {
    return { costs: cachedCosts, adeCosts: cachedAdeCosts };
  }

  async function pollCosts(
    options: { force?: boolean } = {},
  ): Promise<{ costs: CostSnapshot[]; adeCosts: CostSnapshot[] }> {
    const now = Date.now();
    if (!options.force
      && costCacheTimestamp > 0
      && now - costCacheTimestamp < COST_CACHE_TTL_MS
      && projectCostsReady) {
      return cachedCostResult();
    }

    const startedAt = Date.now();
    if (process.env.VITEST !== "true") {
      await refreshDynamicTokenPricing(logger).catch((error) => {
        logger.debug("usage.pricing_refresh_failed", { error: getErrorMessage(error) });
        return 0;
      });
    }

    let scanResult: UsageLedgerScanResult;
    if (!hasInjectedLedgerScanners) {
      scanResult = await (dependencies?.scanUsageLedgers ?? ((root, signal) => (
        scanUsageLedgersInWorker(root, { signal })
      )))(projectRoot, ledgerAbortController.signal);
    } else {
      const scanInjected = async (provider: string, work: () => Promise<TokenEntry[]>): Promise<TokenEntry[]> => {
        try {
          return await work();
        } catch (error) {
          logger.warn(`usage.cost_scan.${provider}_failed`, { error: getErrorMessage(error) });
          return [];
        }
      };
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
        scanInjected("claude", scanClaudeCostLogs),
        scanInjected("codex", scanCodexCostLogs),
        scanInjected("cursor", scanCursorCostLogs),
        scanInjected("cursor_agent", scanCursorAgentCostLogs),
        scanInjected("openclaw", scanOpenClawCostLogs),
        scanInjected("opencode", scanOpenCodeCostLogs),
        scanInjected("droid", scanDroidCostLogs),
        scanInjected("copilot", scanCopilotCostLogs),
        scanInjected("gemini", scanGeminiCostLogs),
      ]);
      const providerEntries: ProviderTokenEntries = new Map([
        ["claude", claudeEntries],
        ["codex", codexEntries],
        ["cursor", cursorEntries],
        ["cursor-agent", cursorAgentEntries],
        ["openclaw", openClawEntries],
        ["opencode", openCodeEntries],
        ["droid", droidEntries],
        ["copilot", copilotEntries],
        ["gemini", geminiEntries],
      ]);
      scanResult = {
        costs: buildCostSnapshots(providerEntries, "machine", projectRoot),
        projectCosts: buildCostSnapshots(providerEntries, "project", projectRoot),
        daily7d: {
          ...(claudeEntries.length > 0 ? { claude: bucketDaily7d(claudeEntries, now) } : {}),
          ...(codexEntries.length > 0 ? { codex: bucketDaily7d(codexEntries, now) } : {}),
        },
        entryCounts: Object.fromEntries(
          Array.from(providerEntries, ([provider, entries]) => [provider, entries.length]),
        ),
        providerErrors: {},
      };
    }
    if (disposed) throw new Error("Usage tracking service disposed during ledger scan");
    for (const [provider, error] of Object.entries(scanResult.providerErrors)) {
      logger.warn(`usage.cost_scan.${provider}_failed`, { error });
    }

    cachedCosts = scanResult.costs;
    cachedAdeCosts = [];
    cachedProjectCosts = scanResult.projectCosts;
    projectCostsReady = true;
    cachedDaily7d = scanResult.daily7d;
    costCacheTimestamp = now;
    const durationMs = Date.now() - startedAt;
    if (durationMs > 500) {
      logger.warn("usage.cost_scan_slow", {
        durationMs,
        isolated: !hasInjectedLedgerScanners,
        providerCount: scanResult.costs.length,
        entryCounts: scanResult.entryCounts,
      });
    }
    return { costs: scanResult.costs, adeCosts: [] };
  }

  async function poll(options: PollOptions = {}): Promise<UsageSnapshot> {
    const reason = options.reason ?? "automatic";
    while (inFlightPoll) {
      if (reason === "automatic" || inFlightPollReason === "user") {
        return await inFlightPoll;
      }
      await inFlightPoll.catch(() => null);
    }

    let currentPoll!: Promise<UsageSnapshot>;
    inFlightPollReason = reason;
    currentPoll = Promise.resolve().then(async () => {
      const errors: string[] = [];
      let allWindows: UsageWindow[] = [];
      const refreshStartedAt = Date.now();

      try {
        const providerTasks = providerStrategies.map(async (strategy) => {
          const previousStatus = lastSnapshot?.providerStatus?.[strategy.provider] ?? null;
          const nextRetryMs = providerNextRetryAtMs[strategy.provider] ?? 0;
          const shouldHonorBackoff = reason === "automatic" || previousStatus?.errorKind === "rate_limited";
          if (shouldHonorBackoff && nextRetryMs > Date.now()) {
            return {
              provider: strategy.provider,
              skipped: true as const,
              result: {
                windows: [],
                source: previousStatus?.source,
                errors: [],
                errorKind: previousStatus?.errorKind,
              } satisfies UsageProviderPollResult,
            };
          }
          try {
            const result = await strategy.poll({ reason });
            if (result.disposition === "preserve_previous") {
              return {
                provider: strategy.provider,
                skipped: true as const,
                result,
              };
            }
            if (result.windows.length > 0) {
              providerFailureCount[strategy.provider] = 0;
              providerNextRetryAtMs[strategy.provider] = 0;
            } else {
              const failureCount = (providerFailureCount[strategy.provider] ?? 0) + 1;
              providerFailureCount[strategy.provider] = failureCount;
              providerNextRetryAtMs[strategy.provider] = Date.now() + providerBackoffMs(result, failureCount);
            }
            return { provider: strategy.provider, skipped: false as const, result };
          } catch (error) {
            const message = `${strategy.provider}: poll failed: ${getErrorMessage(error)}`;
            logger.warn(`usage.poll.${strategy.provider}_failed`, { error: message });
            const failureCount = (providerFailureCount[strategy.provider] ?? 0) + 1;
            providerFailureCount[strategy.provider] = failureCount;
            providerNextRetryAtMs[strategy.provider] = Date.now()
              + Math.min(MAX_POLL_INTERVAL_MS, 60_000 * 2 ** Math.min(4, failureCount - 1));
            return {
              provider: strategy.provider,
              skipped: false as const,
              result: {
                windows: [],
                errors: [message],
                errorKind: errorKindForThrown(error),
              } satisfies UsageProviderPollResult,
            };
          }
        });
        const providerResults = await Promise.all(providerTasks);
        const resultsByProvider = new Map(providerResults.map((entry) => [entry.provider, entry]));
        const emptyPollResult: FreshUsageProviderPollResult = { windows: [], errors: [] };
        const claudePollEntry = resultsByProvider.get("claude");
        const codexPollEntry = resultsByProvider.get("codex");
        const claudeResult = claudePollEntry && !claudePollEntry.skipped
          ? claudePollEntry.result
          : emptyPollResult;
        const codexResult = codexPollEntry && !codexPollEntry.skipped
          ? codexPollEntry.result
          : emptyPollResult;
        for (const entry of providerResults) {
          if (!entry.skipped) errors.push(...entry.result.errors);
        }

        // Reconcile each provider against the last snapshot so a transient
        // failure (409/timeout) carries forward good data instead of wiping it.
        const polledAt = nowIso();
        const prevWindows = lastSnapshot?.windows ?? [];
        const providerStatus: UsageProviderStatusMap = {};
        const mergedRaw: UsageWindow[] = [];
        for (const entry of providerResults) {
          const { provider, result, skipped } = entry;
          const previousStatus = lastSnapshot?.providerStatus?.[provider] ?? null;
          if (skipped) {
            const carriedWindows = filterUnexpiredCarriedWindows(
              prevWindows.filter((window) => window.provider === provider),
              polledAt,
            );
            mergedRaw.push(...carriedWindows);
            const hasLegacyNonInteractiveCredentialError = provider === "claude"
              && lastSnapshot?.errors.includes("claude: no non-interactive credentials found") === true;
            if (
              previousStatus
              && !hasLegacyNonInteractiveCredentialError
              && (previousStatus.state !== "ok" || carriedWindows.length > 0)
            ) {
              providerStatus[provider] = previousStatus;
            } else if (previousStatus?.lastSuccessAt) {
              providerStatus[provider] = {
                state: "stale",
                lastSuccessAt: previousStatus.lastSuccessAt,
                updatedAt: previousStatus.updatedAt ?? previousStatus.lastSuccessAt,
                ...(previousStatus.source ? { source: previousStatus.source } : {}),
                ...(carriedWindows.length === 0
                  ? { message: `${PROVIDER_DISPLAY_NAME[provider]} usage window expired` }
                  : {}),
              };
            }
            continue;
          }
          const nextRetryMs = providerNextRetryAtMs[provider] ?? 0;
          const merged = buildProviderWindows(
            provider,
            result.windows,
            result.errors,
            prevWindows.filter((w) => w.provider === provider),
            previousStatus ?? (providerLastSuccess[provider]
              ? { state: "stale", lastSuccessAt: providerLastSuccess[provider]! }
              : null),
            polledAt,
            result.source,
            result.errorKind,
            nextRetryMs > Date.now() ? new Date(nextRetryMs).toISOString() : null,
          );
          if (merged.lastSuccessAt) providerLastSuccess[provider] = merged.lastSuccessAt;
          providerStatus[provider] = merged.status;
          mergedRaw.push(...merged.windows);
        }

        // Refresh countdowns on carried-forward windows and attach per-window
        // pacing so both the 5-hour and weekly bars can show ahead/behind.
        allWindows = mergedRaw.map((window) => {
          const withReset: UsageWindow = { ...window, resetsInMs: computeResetsInMs(window.resetsAt) };
          return { ...withReset, pacing: calculatePacingForWindow(withReset) };
        });

        const pacing = calculatePacing(allWindows);
        const pacingByProvider = calculatePacingByProvider(allWindows);
        const extraUsage: ExtraUsage[] = [];
        if (claudeResult.extraUsage) extraUsage.push(claudeResult.extraUsage);
        else if (claudePollEntry?.skipped || providerStatus.claude?.state === "stale" || providerStatus.claude?.state === "unauthed") {
          const previousClaudeExtra = lastSnapshot?.extraUsage.find((extra) => extra.provider === "claude");
          if (previousClaudeExtra) extraUsage.push(previousClaudeExtra);
        }
        const costsLastPolledAt = lastSnapshot?.costsLastPolledAt;
        const dailyUsage7d: Partial<Record<UsageProvider, number[]>> = { ...cachedDaily7d };
        if (codexResult.dailyUsage7d?.some((value) => value > 0)) {
          dailyUsage7d.codex = codexResult.dailyUsage7d;
          cachedDaily7d = dailyUsage7d;
        }
        const providerMessages = [
          ...(lastSnapshot?.providerMessages ?? []).filter((message) => message.provider !== "codex"),
          ...(codexResult.providerMessages ?? []),
        ];
        let spendControlReached = codexResult.spendControlReached;
        if (typeof spendControlReached !== "boolean" && (codexPollEntry?.skipped || codexResult.windows.length === 0)) {
          // Codex wasn't polled this round — retain the last known spend-control state.
          spendControlReached = lastSnapshot?.spendControlReached;
        }
        const costResult = cachedCostResult();

        const snapshot: UsageSnapshot = {
          windows: allWindows,
          ...(typeof spendControlReached === "boolean" ? { spendControlReached } : {}),
          pacing,
          pacingByProvider,
          providerStatus,
          ...(providerMessages.length ? { providerMessages } : {}),
          costs: costResult.costs,
          adeCosts: costResult.adeCosts,
          extraUsage,
          dailyUsage7d,
          ...(costsLastPolledAt ? { costsLastPolledAt } : {}),
          lastPolledAt: polledAt,
          errors,
        };

        lastSnapshot = snapshot;
        void writeCachedUsageSnapshot(snapshot, logger);

        emitUpdate(snapshot);

        logger.debug("usage.poll.complete", {
          reason,
          durationMs: Date.now() - refreshStartedAt,
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
          inFlightPollReason = null;
        }
      }
    });
    inFlightPoll = currentPoll;

    return await currentPoll;
  }

  function nextPollDelayMs(nowMs = Date.now()): number {
    if (demandLeaseUntilMs > nowMs) return ACTIVE_POLL_INTERVAL_MS;
    if (nowMs - lastDemandAtMs >= IDLE_AFTER_MS) return IDLE_POLL_INTERVAL_MS;
    return pollIntervalMs;
  }

  function scheduleNextPoll(): void {
    if (!pollingEnabled) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void poll({ reason: "automatic" })
        .catch(() => {})
        .finally(() => {
          if (pollingEnabled) scheduleNextPoll();
        });
    }, nextPollDelayMs());
    pollTimer.unref?.();
  }

  function start() {
    if (pollingEnabled) return;
    pollingEnabled = true;
    scheduleNextPoll();
    void poll({ reason: "automatic" })
      .catch(() => {})
      .finally(() => {
        if (pollingEnabled) scheduleNextPoll();
      });
  }

  function stop() {
    pollingEnabled = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function getUsageSnapshot(): UsageSnapshot {
    return lastSnapshot ?? emptySnapshot();
  }

  function noteQuotaDemand(): UsageSnapshot {
    const nowMs = Date.now();
    lastDemandAtMs = nowMs;
    demandLeaseUntilMs = nowMs + QUOTA_DEMAND_LEASE_MS;
    if (pollTimer) scheduleNextPoll();
    const snapshot = getUsageSnapshot();
    if (nowMs - Date.parse(snapshot.lastPolledAt) > ACTIVE_POLL_INTERVAL_MS) {
      void poll({ reason: "automatic" }).catch(() => {});
    }
    return snapshot;
  }

  async function forceRefresh(
    options: { allowInteractiveAuth?: boolean } = {},
  ): Promise<UsageSnapshot> {
    lastDemandAtMs = Date.now();
    const reason: UsageRefreshReason = options.allowInteractiveAuth === false ? "remote" : "user";
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutSnapshot = new Promise<UsageSnapshot>((resolve) => {
      timeout = setTimeout(() => {
        logger.warn("usage.force_refresh_returning_cached_snapshot", {
          timeoutMs: QUOTA_REFRESH_RESPONSE_TIMEOUT_MS,
        });
        resolve(lastSnapshot ?? emptySnapshot());
      }, QUOTA_REFRESH_RESPONSE_TIMEOUT_MS).unref?.();
    });
    try {
      return await Promise.race([poll({ reason }), timeoutSnapshot]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function refreshHistory(
    options: { reason?: UsageRefreshReason } = {},
  ): Promise<UsageSnapshot> {
    if (inFlightHistoryRefresh) return await inFlightHistoryRefresh;
    const reason = options.reason ?? "user";
    if (reason === "automatic" && Date.now() < costRefreshNextRetryAtMs) {
      return lastSnapshot ?? emptySnapshot();
    }
    githubStatsCache.clear();
    githubStatsInFlight.clear();
    const startedAt = Date.now();
    let current!: Promise<UsageSnapshot>;
    current = measureUsagePhase(
      logger,
      { phase: "history", reason },
      () => pollCosts({ force: true }),
    )
      .then((costResult) => {
        costRefreshFailureCount = 0;
        costRefreshNextRetryAtMs = 0;
        const refreshedAt = nowIso();
        const snapshot: UsageSnapshot = {
          ...(lastSnapshot ?? emptySnapshot()),
          costs: costResult.costs,
          adeCosts: costResult.adeCosts,
          dailyUsage7d: { ...cachedDaily7d },
          costsLastPolledAt: refreshedAt,
        };
        lastSnapshot = snapshot;
        void writeCachedUsageSnapshot(snapshot, logger);
        try {
          onUpdate?.(snapshot);
        } catch {
          // Never crash on callback error.
        }
        logger.debug("usage.refresh.history_complete", {
          durationMs: Date.now() - startedAt,
          providerCount: costResult.costs.length,
        });
        return snapshot;
      })
      .catch((error) => {
        costRefreshFailureCount += 1;
        const retryDelayMs = costRefreshBackoffMs(costRefreshFailureCount);
        costRefreshNextRetryAtMs = Date.now() + retryDelayMs;
        logger.warn("usage.refresh.history_failed", {
          reason,
          failureCount: costRefreshFailureCount,
          retryDelayMs,
          error: getErrorMessage(error),
        });
        throw error;
      })
      .finally(() => {
        if (inFlightHistoryRefresh === current) inFlightHistoryRefresh = null;
      });
    inFlightHistoryRefresh = current;
    return await current;
  }

  async function getAdeUsageStats(args: GetAdeUsageStatsArgs = {}): Promise<AdeUsageStats> {
    const nowMs = Date.now();
    const scope = normalizeScope(args.scope);
    const range = resolveAdeUsageRange(args, nowMs);
    const exactRange = Boolean(args.since || args.until);
    const cacheKey = githubStatsCacheKey(range, exactRange);
    const githubCached = githubStatsCache.get(cacheKey)?.stats ?? null;
    const machineSnapshot = lastSnapshot ?? emptySnapshot();
    const snapshot = scope === "project"
      ? { ...machineSnapshot, costs: cachedProjectCosts }
      : machineSnapshot;
    const providerHistoryMissing = costCacheTimestamp === 0;
    const projectHistoryMissing = scope === "project" && !projectCostsReady;
    const providerHistoryIncomplete = providerHistoryMissing || projectHistoryMissing;
    const providerHistoryStale = providerHistoryIncomplete
      || nowMs - costCacheTimestamp > COST_CACHE_TTL_MS;
    // Reading the compact Activity card must never start a multi-gigabyte
    // transcript walk merely because a cached history snapshot aged out. A
    // first-run install still populates history in the isolated worker, while
    // established installs keep serving aged history until an explicit refresh.
    // Project scope is the exception because project costs are not persisted.
    const providerNeedsRefresh = providerHistoryIncomplete
      && nowMs >= costRefreshNextRetryAtMs;
    const githubNeedsRefresh = !githubCached || nowMs - (githubStatsCache.get(cacheKey)?.fetchedAtMs ?? 0) > GITHUB_STATS_CACHE_TTL_MS;
    if (providerNeedsRefresh || githubNeedsRefresh) {
      refreshStatsInBackground(range, { provider: providerNeedsRefresh, github: githubNeedsRefresh }, exactRange);
    }
    const stats = collectAdeUsageStats({
      snapshot,
      githubStats: githubCached,
      databaseStats: collectDatabaseStatsForRange(range),
      args,
      nowMs,
    });
    stats.freshness = {
      state: providerNeedsRefresh || githubNeedsRefresh
        ? "refreshing"
        : providerHistoryStale ? "stale" : "fresh",
      providerUpdatedAt: machineSnapshot.costsLastPolledAt ?? null,
      githubUpdatedAt: githubCached?.fetchedAt ?? null,
    };
    return stats;
  }

  function refreshStatsInBackground(
    range: ResolvedAdeUsageRange,
    requested: { provider: boolean; github: boolean },
    exactRange = false,
  ): void {
    const key = `${githubStatsCacheKey(range, exactRange)}:${requested.provider ? "provider" : ""}:${requested.github ? "github" : ""}`;
    if (statsRefreshInFlight.has(key)) return;
    const task = (async () => {
      const work: Promise<unknown>[] = [];
      if (requested.provider) work.push(refreshHistory({ reason: "automatic" }));
      if (requested.github) work.push(getGithubStatsForRange(range, exactRange, true));
      await Promise.allSettled(work);
      // History refresh emits when its ledger scan settles. GitHub can finish
      // later, so always emit again after its cache is populated.
      if (requested.github) emitUpdate(lastSnapshot ?? emptySnapshot());
    })().finally(() => {
      statsRefreshInFlight.delete(key);
    });
    statsRefreshInFlight.set(key, task);
  }

  function githubStatsCacheKey(range: ResolvedAdeUsageRange, exactRange = false): string {
    // Preset ranges move by milliseconds on every request. Keying on `until`
    // made the old cache miss forever, so every Stats render launched `gh`.
    // Calendar-day buckets preserve exact-range semantics while making normal
    // day/week/month/year requests stable for the full cache TTL.
    if (exactRange) {
      return `${range.preset}:${range.since ?? "all"}:${range.until}`;
    }
    const untilDay = localDayKey(range.until);
    const sinceDay = range.since ? localDayKey(range.since) : "all";
    return `${range.preset}:${sinceDay || "all"}:${untilDay}`;
  }

  async function getGithubStatsForRange(
    range: ResolvedAdeUsageRange,
    exactRange = false,
    waitForComplete = false,
  ): Promise<GitHubActivityStats> {
    const cacheKey = githubStatsCacheKey(range, exactRange);
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

    if (waitForComplete) return await inFlight;

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
    noteQuotaDemand,
    forceRefresh,
    refreshHistory,
    getAdeUsageStats,
    poll,
    dispose: () => {
      disposed = true;
      ledgerAbortController.abort();
      stop();
    },
  };
}

// ── Exported for testing ─────────────────────────────────────────
export const _testing = {
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  readCodexCredentials,
  isCodexTokenStale,
  isTokenExpiredOrExpiring: isClaudeTokenExpiredOrExpiring,
  isClaudeTokenExpiredOrExpiring,
  refreshClaudeCredentials,
  parseClaudeWindows,
  parseClaudeCliUsage,
  parseCodexRateLimitSnapshot,
  parseCodexRateLimitWindows,
  isUsageSnapshot,
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
  localDayKey,
  makeDailySkeleton,
  dateIntersectsRange,
  buildCostSnapshots,
  scanGithubPullRequestPages,
  collectAdeUsageStats,
  calculatePacing,
  calculatePacingByProvider,
  calculatePacingForWindow,
  buildProviderWindows,
  fetchJson,
  fetchJsonWithRetry,
  findRecentFiles,
  findJsonlFiles,
  resolveTokenPrice,
  refreshDynamicTokenPricing,
  resetDynamicTokenPricingForTest,
  setDynamicTokenPricingForTest,
  pollCodexViaCliRpc,
};
