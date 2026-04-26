/**
 * usageTrackingService.ts
 *
 * Polls live usage data from Claude and Codex providers.
 * Scans local JSONL logs for cost/token aggregation.
 * Computes pacing relative to weekly reset windows.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { Logger } from "../logging/logger";
import type {
  UsageProvider,
  UsageWindow,
  UsagePacing,
  CostSnapshot,
  ExtraUsage,
  UsageSnapshot,
} from "../../../shared/types";
import { isRecord, nowIso, getErrorMessage, safeJsonParse } from "../shared/utils";
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

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 2 * 60_000; // 2 min
const MIN_POLL_INTERVAL_MS = 60_000;          // 1 min
const MAX_POLL_INTERVAL_MS = 15 * 60_000;     // 15 min
const COST_CACHE_TTL_MS = 60_000;             // 60s
const CODEX_TOKEN_REFRESH_DAYS = 8;
const CODEX_CLI_RPC_TIMEOUT_MS = 10_000;

function isBenignStdinCloseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

// Per-million token prices for cost estimation
const TOKEN_PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus":   { input: 5 / 1_000_000, output: 25 / 1_000_000 },
  "claude-sonnet": { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  "claude-haiku":  { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  "codex":         { input: 2 / 1_000_000, output: 8 / 1_000_000 },
  "codex-mini":    { input: 0.3 / 1_000_000, output: 1.2 / 1_000_000 },
  "default":       { input: 3 / 1_000_000, output: 15 / 1_000_000 },
};

// ── HTTP Helper ──────────────────────────────────────────────────

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15_000
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers,
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

  if (isCodexTokenStale(creds)) {
    errors.push("codex: token is stale (older than 8 days)");
    return { windows, errors };
  }

  // Try HTTP API first
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
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  timestamp: number;
}

function resolveTokenPrice(model: string): { input: number; output: number } {
  const lower = (model ?? "").toLowerCase();
  if (lower.includes("opus")) return TOKEN_PRICES["claude-opus"]!;
  if (lower.includes("sonnet")) return TOKEN_PRICES["claude-sonnet"]!;
  if (lower.includes("haiku")) return TOKEN_PRICES["claude-haiku"]!;
  if (lower.includes("codex") && lower.includes("mini")) return TOKEN_PRICES["codex-mini"]!;
  if (lower.includes("codex") || lower.includes("gpt") || lower.includes("o3") || lower.includes("o4"))
    return TOKEN_PRICES["codex"]!;
  return TOKEN_PRICES["default"]!;
}

async function scanClaudeLogs(): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const claudeDir = path.join(os.homedir(), ".claude", "projects");

  try {
    await fs.promises.access(claudeDir);
  } catch {
    return entries;
  }

  const jsonlFiles = await findJsonlFiles(claudeDir, 30);

  for (const filePath of jsonlFiles) {
    try {
      const content = await fs.promises.readFile(filePath, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        const record = safeJsonParse<Record<string, unknown>>(line, {});
        if (record.type !== "assistant") continue;

        const message = record.message as Record<string, unknown> | undefined;
        if (!message) continue;

        const usage = message.usage as Record<string, unknown> | undefined;
        if (!usage) continue;

        const messageId = typeof message.id === "string" ? message.id : "";
        const requestId = typeof record.requestId === "string" ? record.requestId : "";
        const dedupeKey = `${messageId}:${requestId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const model = typeof message.model === "string" ? message.model :
                      typeof record.model === "string" ? record.model : "unknown";

        entries.push({
          messageId: dedupeKey,
          model,
          inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
          cachedTokens: typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : typeof usage.cached_tokens === "number" ? usage.cached_tokens : 0,
          timestamp: typeof record.timestamp === "number" ? record.timestamp :
                     typeof record.timestamp === "string" ? new Date(record.timestamp).getTime() : Date.now(),
        });
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

  const jsonlFiles = await findJsonlFiles(sessionsDir, 30);

  for (const filePath of jsonlFiles) {
    try {
      const content = await fs.promises.readFile(filePath, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        const record = safeJsonParse<Record<string, unknown>>(line, {});

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
          inputTokens: inputTokens || Math.floor(tokenCount * 0.4),
          outputTokens: outputTokens || Math.ceil(tokenCount * 0.6),
          cachedTokens: typeof record.cached_tokens === "number" ? record.cached_tokens : 0,
          timestamp: typeof record.timestamp === "number" ? record.timestamp :
                     typeof record.timestamp === "string" ? new Date(record.timestamp).getTime() : Date.now(),
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return entries;
}

async function findJsonlFiles(dir: string, maxAgeDays: number): Promise<string[]> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const files: string[] = [];

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
        } else if (entry.name.endsWith(".jsonl")) {
          fileStatPromises.push(
            fs.promises.stat(fullPath).then((stat) => {
              if (stat.mtimeMs >= cutoff) {
                files.push(fullPath);
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
  return files;
}

function aggregateCosts(
  entries: TokenEntry[],
  provider: UsageProvider
): CostSnapshot {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  let last30dCostUsd = 0;
  let todayCostUsd = 0;
  const breakdown: Record<string, { input: number; output: number; cached: number }> = {};

  for (const entry of entries) {
    if (entry.timestamp < thirtyDaysAgo) continue;

    const price = resolveTokenPrice(entry.model);
    const cost = entry.inputTokens * price.input + entry.outputTokens * price.output;
    last30dCostUsd += cost;

    if (entry.timestamp >= todayStartMs) {
      todayCostUsd += cost;
    }

    const modelKey = entry.model || "unknown";
    if (!breakdown[modelKey]) {
      breakdown[modelKey] = { input: 0, output: 0, cached: 0 };
    }
    breakdown[modelKey].input += entry.inputTokens;
    breakdown[modelKey].output += entry.outputTokens;
    breakdown[modelKey].cached += entry.cachedTokens;
  }

  return {
    provider,
    last30dCostUsd: Math.round(last30dCostUsd * 100) / 100,
    todayCostUsd: Math.round(todayCostUsd * 100) / 100,
    tokenBreakdown: breakdown,
  };
}

// ── Pacing Calculation ───────────────────────────────────────────

function calculatePacing(windows: UsageWindow[]): UsagePacing {
  const empty: UsagePacing = {
    status: "on-track",
    projectedWeeklyPercent: 0,
    weekElapsedPercent: 0,
    expectedPercent: 0,
    deltaPercent: 0,
    etaHours: null,
    willLastToReset: true,
    resetsInHours: 0,
  };

  // Find the weekly window (prefer Claude, then Codex)
  const weeklyWindow =
    windows.find((w) => w.windowType === "weekly" && w.provider === "claude") ??
    windows.find((w) => w.windowType === "weekly");

  if (!weeklyWindow) return empty;

  const totalWindowMs = 7 * 24 * 60 * 60 * 1000;
  const elapsedMs = totalWindowMs - weeklyWindow.resetsInMs;
  const weekElapsedPercent = Math.min(100, Math.max(0, (elapsedMs / totalWindowMs) * 100));
  const resetsInHours = weeklyWindow.resetsInMs / 3_600_000;

  // Expected usage if consumption were perfectly linear over the week
  const expectedPercent = weekElapsedPercent; // 100% budget / 100% time = linear

  // Delta: positive = consuming faster than pace, negative = under pace
  const deltaPercent = weeklyWindow.percentUsed - expectedPercent;

  // Project usage to end of week
  let projectedWeeklyPercent: number;
  let etaHours: number | null = null;
  let willLastToReset = true;

  if (weekElapsedPercent < 1) {
    projectedWeeklyPercent = weeklyWindow.percentUsed;
  } else {
    const ratePerMs = weeklyWindow.percentUsed / elapsedMs;
    projectedWeeklyPercent = Math.min(300, ratePerMs * totalWindowMs);

    // ETA to 100% at current rate
    if (ratePerMs > 0) {
      const remainingPercent = 100 - weeklyWindow.percentUsed;
      if (remainingPercent <= 0) {
        etaHours = 0; // Already exhausted
        willLastToReset = false;
      } else {
        const msTo100 = remainingPercent / ratePerMs;
        etaHours = Math.round((msTo100 / 3_600_000) * 10) / 10;
        willLastToReset = msTo100 >= weeklyWindow.resetsInMs;
      }
    }
  }

  // Status with more granularity (based on delta)
  let status: UsagePacing["status"];
  if (deltaPercent <= -20) {
    status = "far-behind";
  } else if (deltaPercent <= -10) {
    status = "behind";
  } else if (deltaPercent <= -4) {
    status = "slightly-behind";
  } else if (deltaPercent <= 4) {
    status = "on-track";
  } else if (deltaPercent <= 10) {
    status = "slightly-ahead";
  } else if (deltaPercent <= 20) {
    status = "ahead";
  } else {
    status = "far-ahead";
  }

  return {
    status,
    projectedWeeklyPercent: Math.round(projectedWeeklyPercent * 10) / 10,
    weekElapsedPercent: Math.round(weekElapsedPercent * 10) / 10,
    expectedPercent: Math.round(expectedPercent * 10) / 10,
    deltaPercent: Math.round(deltaPercent * 10) / 10,
    etaHours,
    willLastToReset,
    resetsInHours: Math.round(resetsInHours * 10) / 10,
  };
}

// ── Service Factory ──────────────────────────────────────────────

export type UsageTrackingService = ReturnType<typeof createUsageTrackingService>;

type UsageTrackingDependencies = {
  pollClaudeUsage?: () => Promise<{ windows: UsageWindow[]; extraUsage: ExtraUsage | null; errors: string[] }>;
  pollCodexUsage?: () => Promise<{ windows: UsageWindow[]; errors: string[] }>;
  scanClaudeLogs?: () => Promise<TokenEntry[]>;
  scanCodexLogs?: () => Promise<TokenEntry[]>;
};

export function createUsageTrackingService({
  logger,
  pollIntervalMs: configuredInterval,
  onUpdate,
  dependencies,
}: {
  logger: Logger;
  pollIntervalMs?: number;
  onUpdate?: (snapshot: UsageSnapshot) => void;
  dependencies?: UsageTrackingDependencies;
}) {
  const pollIntervalMs = Math.max(
    MIN_POLL_INTERVAL_MS,
    Math.min(MAX_POLL_INTERVAL_MS, configuredInterval ?? DEFAULT_POLL_INTERVAL_MS)
  );

  let lastSnapshot: UsageSnapshot | null = null;
  let costCacheTimestamp = 0;
  let cachedCosts: CostSnapshot[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let inFlightPoll: Promise<UsageSnapshot> | null = null;
  const runClaudeUsagePoll = dependencies?.pollClaudeUsage ?? (() => pollClaudeUsage(logger));
  const runCodexUsagePoll = dependencies?.pollCodexUsage ?? (() => pollCodexUsage(logger));
  const scanClaudeCostLogs = dependencies?.scanClaudeLogs ?? scanClaudeLogs;
  const scanCodexCostLogs = dependencies?.scanCodexLogs ?? scanCodexLogs;

  const emptySnapshot = (): UsageSnapshot => ({
    windows: [],
    pacing: { status: "on-track", projectedWeeklyPercent: 0, weekElapsedPercent: 0, expectedPercent: 0, deltaPercent: 0, etaHours: null, willLastToReset: true, resetsInHours: 0 },
    costs: [],
    extraUsage: [],
    lastPolledAt: nowIso(),
    errors: [],
  });

  async function pollCosts(): Promise<CostSnapshot[]> {
    const now = Date.now();
    if (now - costCacheTimestamp < COST_CACHE_TTL_MS && cachedCosts.length > 0) {
      return cachedCosts;
    }

    const [claudeEntries, codexEntries] = await Promise.all([
      scanClaudeCostLogs().catch((err) => {
        logger.warn("usage.cost_scan.claude_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
      scanCodexCostLogs().catch((err) => {
        logger.warn("usage.cost_scan.codex_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
    ]);

    const costs: CostSnapshot[] = [];
    if (claudeEntries.length > 0) costs.push(aggregateCosts(claudeEntries, "claude"));
    if (codexEntries.length > 0) costs.push(aggregateCosts(codexEntries, "codex"));

    cachedCosts = costs;
    costCacheTimestamp = now;
    return costs;
  }

  async function poll(): Promise<UsageSnapshot> {
    if (inFlightPoll) {
      return await inFlightPoll;
    }

    inFlightPoll = (async () => {
      const errors: string[] = [];
      let allWindows: UsageWindow[] = [];

      try {
        const [claudeResult, codexResult, costs] = await Promise.all([
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
        const extraUsage: ExtraUsage[] = [];
        if (claudeResult.extraUsage) extraUsage.push(claudeResult.extraUsage);

        const snapshot: UsageSnapshot = {
          windows: allWindows,
          pacing,
          costs,
          extraUsage,
          lastPolledAt: nowIso(),
          errors,
        };

        lastSnapshot = snapshot;

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
    return await poll();
  }

  return {
    start,
    stop,
    getUsageSnapshot,
    forceRefresh,
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
  scanClaudeLogs,
  scanCodexLogs,
  aggregateCosts,
  calculatePacing,
  fetchJson,
  findJsonlFiles,
  resolveTokenPrice,
  pollCodexViaCliRpc,
};
