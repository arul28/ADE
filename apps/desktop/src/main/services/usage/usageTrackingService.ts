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
  UsageSnapshot,
} from "../../../shared/types";
import { nowIso, getErrorMessage, safeJsonParse } from "../shared/utils";

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 2 * 60_000; // 2 min
const MIN_POLL_INTERVAL_MS = 60_000;          // 1 min
const MAX_POLL_INTERVAL_MS = 15 * 60_000;     // 15 min
const COST_CACHE_TTL_MS = 60_000;             // 60s
const CODEX_TOKEN_REFRESH_DAYS = 8;

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

// ── Credential Helpers ───────────────────────────────────────────

type ClaudeCredentials = {
  accessToken: string;
  plan?: string;
};

type CodexCredentials = {
  accessToken: string;
  lastRefresh?: number;
};

async function readClaudeCredentials(): Promise<ClaudeCredentials | null> {
  // Try Keychain first (macOS)
  if (process.platform === "darwin") {
    try {
      const result = await runShellCommand(
        "security find-generic-password -s 'Claude Code-credentials' -w",
        5_000
      );
      if (result.exitCode === 0 && result.stdout.trim()) {
        const parsed = safeJsonParse<Record<string, unknown>>(result.stdout.trim(), {});
        const token = typeof parsed.accessToken === "string" ? parsed.accessToken :
                      typeof parsed.access_token === "string" ? parsed.access_token : null;
        if (token) {
          return {
            accessToken: token,
            plan: typeof parsed.plan === "string" ? parsed.plan :
                  typeof parsed.rate_limit_tier === "string" ? parsed.rate_limit_tier : undefined,
          };
        }
      }
    } catch {
      // fall through to file
    }
  }

  // File fallback
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    const raw = await fs.promises.readFile(credPath, "utf8");
    const parsed = safeJsonParse<Record<string, unknown>>(raw, {});
    const token = typeof parsed.accessToken === "string" ? parsed.accessToken :
                  typeof parsed.access_token === "string" ? parsed.access_token : null;
    if (!token) return null;
    return {
      accessToken: token,
      plan: typeof parsed.plan === "string" ? parsed.plan :
            typeof parsed.rate_limit_tier === "string" ? parsed.rate_limit_tier : undefined,
    };
  } catch {
    return null;
  }
}

async function readCodexCredentials(): Promise<CodexCredentials | null> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const authPath = path.join(codexHome, "auth.json");
  try {
    const raw = await fs.promises.readFile(authPath, "utf8");
    const parsed = safeJsonParse<Record<string, unknown>>(raw, {});
    const token = typeof parsed.access_token === "string" ? parsed.access_token :
                  typeof parsed.accessToken === "string" ? parsed.accessToken : null;
    if (!token) return null;
    return {
      accessToken: token,
      lastRefresh: typeof parsed.last_refresh === "number" ? parsed.last_refresh :
                   typeof parsed.lastRefresh === "number" ? parsed.lastRefresh : undefined,
    };
  } catch {
    return null;
  }
}

function isCodexTokenStale(creds: CodexCredentials): boolean {
  if (!creds.lastRefresh) return false;
  const ageMs = Date.now() - creds.lastRefresh;
  return ageMs > CODEX_TOKEN_REFRESH_DAYS * 24 * 60 * 60 * 1000;
}

// ── Shell Helper ─────────────────────────────────────────────────

function runShellCommand(
  command: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8").slice(0, 50_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 10_000);
    });

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error(`Shell command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

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

// ── Claude Usage Polling ─────────────────────────────────────────

interface ClaudeUsageResponse {
  five_hour?: { percent_used?: number; resets_at?: string };
  seven_day?: { percent_used?: number; resets_at?: string };
  seven_day_sonnet?: { percent_used?: number; resets_at?: string };
  seven_day_opus?: { percent_used?: number; resets_at?: string };
  rate_limit_tier?: string;
}

async function pollClaudeUsage(logger: Logger): Promise<{ windows: UsageWindow[]; errors: string[] }> {
  const windows: UsageWindow[] = [];
  const errors: string[] = [];

  const creds = await readClaudeCredentials();
  if (!creds) {
    errors.push("claude: no credentials found");
    return { windows, errors };
  }

  try {
    const result = await fetchJson(CLAUDE_USAGE_URL, {
      Authorization: `Bearer ${creds.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    });

    if (!result.ok) {
      errors.push(`claude: API returned ${result.status}`);
      return { windows, errors };
    }

    const data = result.data as ClaudeUsageResponse;

    if (data.five_hour) {
      const resetsAt = data.five_hour.resets_at ?? "";
      windows.push({
        provider: "claude",
        windowType: "five_hour",
        percentUsed: data.five_hour.percent_used ?? 0,
        resetsAt,
        resetsInMs: resetsAt ? Math.max(0, new Date(resetsAt).getTime() - Date.now()) : 0,
      });
    }

    if (data.seven_day) {
      const resetsAt = data.seven_day.resets_at ?? "";
      const modelBreakdown: Record<string, number> = {};
      if (data.seven_day_sonnet?.percent_used != null) {
        modelBreakdown.sonnet = data.seven_day_sonnet.percent_used;
      }
      if (data.seven_day_opus?.percent_used != null) {
        modelBreakdown.opus = data.seven_day_opus.percent_used;
      }
      windows.push({
        provider: "claude",
        windowType: "weekly",
        percentUsed: data.seven_day.percent_used ?? 0,
        resetsAt,
        resetsInMs: resetsAt ? Math.max(0, new Date(resetsAt).getTime() - Date.now()) : 0,
        modelBreakdown: Object.keys(modelBreakdown).length > 0 ? modelBreakdown : undefined,
      });
    }
  } catch (err) {
    errors.push(`claude: ${getErrorMessage(err)}`);
  }

  return { windows, errors };
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
      const data = result.data as Record<string, unknown>;
      const usage = (data.usage ?? data) as Record<string, unknown>;

      // Parse primary window
      const primary = usage.primary as Record<string, unknown> | undefined;
      if (primary) {
        const resetsAt = typeof primary.resets_at === "string" ? primary.resets_at : "";
        windows.push({
          provider: "codex",
          windowType: "weekly",
          percentUsed: typeof primary.percent_used === "number" ? primary.percent_used : 0,
          resetsAt,
          resetsInMs: resetsAt ? Math.max(0, new Date(resetsAt).getTime() - Date.now()) : 0,
        });
      }

      // Parse secondary/session window
      const secondary = usage.secondary as Record<string, unknown> | undefined;
      if (secondary) {
        const resetsAt = typeof secondary.resets_at === "string" ? secondary.resets_at : "";
        windows.push({
          provider: "codex",
          windowType: "five_hour",
          percentUsed: typeof secondary.percent_used === "number" ? secondary.percent_used : 0,
          resetsAt,
          resetsInMs: resetsAt ? Math.max(0, new Date(resetsAt).getTime() - Date.now()) : 0,
        });
      }

      if (windows.length > 0) return { windows, errors };
    }
  } catch {
    // Fall through to CLI RPC
  }

  // Fallback: Codex CLI RPC
  try {
    const rpcResult = await pollCodexViaCliRpc(logger);
    windows.push(...rpcResult.windows);
    if (rpcResult.errors.length > 0) errors.push(...rpcResult.errors);
  } catch (err) {
    errors.push(`codex: CLI RPC failed: ${getErrorMessage(err)}`);
  }

  return { windows, errors };
}

async function pollCodexViaCliRpc(logger: Logger): Promise<{ windows: UsageWindow[]; errors: string[] }> {
  const windows: UsageWindow[] = [];
  const errors: string[] = [];

  try {
    // Initialize RPC connection
    const initPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });

    const rateLimitsPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "account/rateLimits/read",
      params: {},
    });

    const combined = `${initPayload}\n${rateLimitsPayload}\n`;

    const result = await runShellCommand(
      `echo '${combined.replace(/'/g, "'\\''")}' | codex -s read-only -a untrusted app-server 2>/dev/null`,
      10_000
    );

    if (result.exitCode !== 0) {
      errors.push("codex: CLI RPC exited with non-zero code");
      return { windows, errors };
    }

    // Parse JSONL responses
    const lines = result.stdout.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const parsed = safeJsonParse<Record<string, unknown>>(line, {});
      if (!parsed.result || typeof parsed.result !== "object") continue;
      const res = parsed.result as Record<string, unknown>;

      // Look for rate limit windows
      const limits = (res.rateLimits ?? res.rate_limits) as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(limits)) {
        for (const limit of limits) {
          const resetsAt = typeof limit.resets_at === "string" ? limit.resets_at : "";
          const windowType = typeof limit.window === "string" && limit.window.includes("hour")
            ? "five_hour" as const
            : "weekly" as const;
          windows.push({
            provider: "codex",
            windowType,
            percentUsed: typeof limit.percent_used === "number" ? limit.percent_used : 0,
            resetsAt,
            resetsInMs: resetsAt ? Math.max(0, new Date(resetsAt).getTime() - Date.now()) : 0,
          });
        }
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
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (entry.name.endsWith(".jsonl")) {
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.mtimeMs >= cutoff) {
              files.push(fullPath);
            }
          } catch {
            // Skip files we can't stat
          }
        }
      }
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
  // Find the weekly window (prefer Claude, then Codex)
  const weeklyWindow =
    windows.find((w) => w.windowType === "weekly" && w.provider === "claude") ??
    windows.find((w) => w.windowType === "weekly");

  if (!weeklyWindow) {
    return { status: "on-track", projectedWeeklyPercent: 0, weekElapsedPercent: 0 };
  }

  const totalWindowMs = 7 * 24 * 60 * 60 * 1000;
  const elapsedMs = totalWindowMs - weeklyWindow.resetsInMs;
  const weekElapsedPercent = Math.min(100, Math.max(0, (elapsedMs / totalWindowMs) * 100));

  // Project usage to end of week
  let projectedWeeklyPercent: number;
  if (weekElapsedPercent < 1) {
    projectedWeeklyPercent = weeklyWindow.percentUsed;
  } else {
    const rate = weeklyWindow.percentUsed / weekElapsedPercent;
    projectedWeeklyPercent = Math.min(200, rate * 100);
  }

  let status: UsagePacing["status"];
  if (projectedWeeklyPercent > 90) {
    status = "ahead";
  } else if (weekElapsedPercent > 50 && projectedWeeklyPercent < 50) {
    status = "behind";
  } else {
    status = "on-track";
  }

  return {
    status,
    projectedWeeklyPercent: Math.round(projectedWeeklyPercent * 10) / 10,
    weekElapsedPercent: Math.round(weekElapsedPercent * 10) / 10,
  };
}

// ── Service Factory ──────────────────────────────────────────────

export type UsageTrackingService = ReturnType<typeof createUsageTrackingService>;

export function createUsageTrackingService({
  logger,
  pollIntervalMs: configuredInterval,
  onUpdate,
}: {
  logger: Logger;
  pollIntervalMs?: number;
  onUpdate?: (snapshot: UsageSnapshot) => void;
}) {
  const pollIntervalMs = Math.max(
    MIN_POLL_INTERVAL_MS,
    Math.min(MAX_POLL_INTERVAL_MS, configuredInterval ?? DEFAULT_POLL_INTERVAL_MS)
  );

  let lastSnapshot: UsageSnapshot | null = null;
  let costCacheTimestamp = 0;
  let cachedCosts: CostSnapshot[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  const emptySnapshot = (): UsageSnapshot => ({
    windows: [],
    pacing: { status: "on-track", projectedWeeklyPercent: 0, weekElapsedPercent: 0 },
    costs: [],
    lastPolledAt: nowIso(),
    errors: [],
  });

  async function pollCosts(): Promise<CostSnapshot[]> {
    const now = Date.now();
    if (now - costCacheTimestamp < COST_CACHE_TTL_MS && cachedCosts.length > 0) {
      return cachedCosts;
    }

    const [claudeEntries, codexEntries] = await Promise.all([
      scanClaudeLogs().catch((err) => {
        logger.warn("usage.cost_scan.claude_failed", { error: getErrorMessage(err) });
        return [] as TokenEntry[];
      }),
      scanCodexLogs().catch((err) => {
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
    if (polling) {
      return lastSnapshot ?? emptySnapshot();
    }
    polling = true;

    const errors: string[] = [];
    let allWindows: UsageWindow[] = [];

    try {
      const [claudeResult, codexResult, costs] = await Promise.all([
        pollClaudeUsage(logger).catch((err) => {
          const msg = `claude: poll failed: ${getErrorMessage(err)}`;
          logger.warn("usage.poll.claude_failed", { error: msg });
          return { windows: [] as UsageWindow[], errors: [msg] };
        }),
        pollCodexUsage(logger).catch((err) => {
          const msg = `codex: poll failed: ${getErrorMessage(err)}`;
          logger.warn("usage.poll.codex_failed", { error: msg });
          return { windows: [] as UsageWindow[], errors: [msg] };
        }),
        pollCosts(),
      ]);

      allWindows = [...claudeResult.windows, ...codexResult.windows];
      errors.push(...claudeResult.errors, ...codexResult.errors);

      const pacing = calculatePacing(allWindows);

      const snapshot: UsageSnapshot = {
        windows: allWindows,
        pacing,
        costs,
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

      // Return stale data with errors if we have it
      if (lastSnapshot) {
        return { ...lastSnapshot, errors, lastPolledAt: nowIso() };
      }

      return { ...emptySnapshot(), errors };
    } finally {
      polling = false;
    }
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
  readClaudeCredentials,
  readCodexCredentials,
  isCodexTokenStale,
  pollClaudeUsage,
  pollCodexUsage,
  scanClaudeLogs,
  scanCodexLogs,
  aggregateCosts,
  calculatePacing,
  fetchJson,
  findJsonlFiles,
  resolveTokenPrice,
};
