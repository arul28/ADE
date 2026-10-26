/**
 * Claude's structured `/usage` answer (the SDK's `get_usage` control request),
 * normalized for the chat's usage sheet.
 *
 * The SDK marks the shape experimental, so every field is read defensively:
 * a missing or renamed field drops that part of the sheet, never the whole
 * answer. Verified against @anthropic-ai/claude-agent-sdk 0.3.310.
 */

import { isRecord } from "./agentObservationNormalizers";
import { windowLabel } from "./usageWindowPresentation";

export type ClaudeUsageModelRow = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

export type ClaudeUsageLimitWindow = {
  /** `five_hour`, `seven_day`, `seven_day_opus`, … or `model:<name>` for a per-model weekly window. */
  key: string;
  label: string;
  /** 0-100, or null when the server did not say. */
  usedPercent: number | null;
  resetsAt: string | null;
};

export type ClaudeUsageExtraUsage = {
  enabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  usedPercent: number | null;
  currency: string | null;
};

export type ClaudeUsageRecommendation = {
  key: string;
  /** Share of weighted local usage this touches, 0-100. */
  pct: number;
  title: string;
  detail: string | null;
};

export type ClaudeUsageShare = { name: string; pct: number };

export type ClaudeUsageBehaviorWindow = {
  requestCount: number;
  sessionCount: number;
  behaviors: Array<{ key: string; pct: number; count: number }>;
  recommendations: ClaudeUsageRecommendation[];
  /** What one Fix does: the messages to send, in order. Null when nothing can be fixed here. */
  fix: { keys: string[]; messages: string[] } | null;
  sources: {
    agents: ClaudeUsageShare[];
    skills: ClaudeUsageShare[];
    plugins: ClaudeUsageShare[];
    mcpServers: ClaudeUsageShare[];
  };
};

export type ClaudeUsageReport = {
  session: {
    costUsd: number;
    apiDurationMs: number;
    durationMs: number;
    linesAdded: number;
    linesRemoved: number;
    models: ClaudeUsageModelRow[];
  };
  /** `pro`, `max`, `team`, `enterprise`, or null for an API key or a cloud provider. */
  subscriptionType: string | null;
  /** False when plan limits do not apply (API key, Bedrock, Vertex). */
  limitsAvailable: boolean;
  limits: ClaudeUsageLimitWindow[];
  extraUsage: ClaudeUsageExtraUsage | null;
  /** From a scan of this machine's transcripts; null when skipped or not a subscriber. */
  behaviors: { day: ClaudeUsageBehaviorWindow | null; week: ClaudeUsageBehaviorWindow | null } | null;
};

export type AgentChatClaudeUsageArgs = {
  sessionId: string;
  /**
   * Skip the transcript scan behind `behaviors` (it reads every local
   * transcript). The sheet asks without it first so the limits paint at once.
   */
  skipBehaviors?: boolean;
};

/** Claude's window keys under the app's own names (`windowLabel`); per-model weeks add the model. */
const LIMIT_LABELS: Record<string, string> = {
  five_hour: windowLabel({ windowType: "five_hour" }),
  seven_day: windowLabel({ windowType: "weekly" }),
  seven_day_opus: `${windowLabel({ windowType: "weekly" })} · Opus`,
  seven_day_sonnet: `${windowLabel({ windowType: "weekly" })} · Sonnet`,
  seven_day_oauth_apps: windowLabel({ windowType: "weekly_oauth_apps" }),
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function percent(value: unknown): number | null {
  const n = numOrNull(value);
  return n == null ? null : Math.max(0, Math.min(100, n));
}

function readWindow(key: string, label: string, value: unknown): ClaudeUsageLimitWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const usedPercent = percent(record.utilization);
  const resetsAt = str(record.resets_at);
  if (usedPercent == null && !resetsAt) return null;
  return { key, label, usedPercent, resetsAt };
}

function readShares(value: unknown): ClaudeUsageShare[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const name = str(record?.name);
    if (!record || !name) return [];
    return [{ name, pct: percent(record.pct) ?? 0 }];
  }).sort((a, b) => b.pct - a.pct);
}

function readBehaviorWindow(value: unknown): ClaudeUsageBehaviorWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const behaviors = Array.isArray(record.behaviors)
    ? record.behaviors.flatMap((entry) => {
      const row = asRecord(entry);
      const key = str(row?.key);
      if (!row || !key) return [];
      return [{ key, pct: percent(row.pct) ?? 0, count: num(row.count) }];
    }).sort((a, b) => b.pct - a.pct)
    : [];
  const recommendations = Array.isArray(record.recommendations)
    ? record.recommendations.flatMap((entry) => {
      const row = asRecord(entry);
      const key = str(row?.key);
      const title = str(row?.title);
      if (!row || !key || !title) return [];
      return [{ key, pct: percent(row.pct) ?? 0, title, detail: str(row.detail) }];
    })
    : [];
  const fixRecord = asRecord(record.fix);
  const fixMessages = Array.isArray(fixRecord?.messages)
    ? fixRecord.messages.filter((message): message is string => typeof message === "string" && message.trim().length > 0)
    : [];
  const fixKeys = Array.isArray(fixRecord?.keys)
    ? fixRecord.keys.filter((key): key is string => typeof key === "string")
    : [];
  return {
    requestCount: num(record.request_count),
    sessionCount: num(record.session_count),
    behaviors,
    recommendations,
    fix: fixMessages.length ? { keys: fixKeys, messages: fixMessages } : null,
    sources: {
      agents: readShares(record.agents),
      skills: readShares(record.skills),
      plugins: readShares(record.plugins),
      mcpServers: readShares(record.mcp_servers),
    },
  };
}

export function normalizeClaudeUsageReport(value: unknown): ClaudeUsageReport {
  const record = asRecord(value) ?? {};
  const session = asRecord(record.session) ?? {};
  const modelUsage = asRecord(session.model_usage) ?? {};
  const models: ClaudeUsageModelRow[] = Object.entries(modelUsage).flatMap(([model, raw]) => {
    const usage = asRecord(raw);
    if (!usage) return [];
    return [{
      model,
      inputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      cacheReadTokens: num(usage.cacheReadInputTokens),
      cacheWriteTokens: num(usage.cacheCreationInputTokens),
      costUsd: num(usage.costUSD),
    }];
  }).sort((a, b) => b.costUsd - a.costUsd);

  const rateLimits = asRecord(record.rate_limits);
  const limits: ClaudeUsageLimitWindow[] = [];
  if (rateLimits) {
    for (const [key, label] of Object.entries(LIMIT_LABELS)) {
      const window = readWindow(key, label, rateLimits[key]);
      if (window) limits.push(window);
    }
    if (Array.isArray(rateLimits.model_scoped)) {
      for (const entry of rateLimits.model_scoped) {
        const row = asRecord(entry);
        const name = str(row?.display_name);
        if (!row || !name) continue;
        const window = readWindow(`model:${name}`, `${windowLabel({ windowType: "weekly" })} · ${name}`, row);
        // The per-model row repeats a fixed window the server already sent.
        if (window && !limits.some((limit) => limit.label === window.label)) limits.push(window);
      }
    }
  }
  const extra = asRecord(rateLimits?.extra_usage);
  const behaviors = asRecord(record.behaviors);

  return {
    session: {
      costUsd: num(session.total_cost_usd),
      apiDurationMs: num(session.total_api_duration_ms),
      durationMs: num(session.total_duration_ms),
      linesAdded: num(session.total_lines_added),
      linesRemoved: num(session.total_lines_removed),
      models,
    },
    subscriptionType: str(record.subscription_type),
    limitsAvailable: record.rate_limits_available === true && limits.length > 0,
    limits,
    extraUsage: extra
      ? {
        enabled: extra.is_enabled === true,
        monthlyLimit: numOrNull(extra.monthly_limit),
        usedCredits: numOrNull(extra.used_credits),
        usedPercent: percent(extra.utilization),
        currency: str(extra.currency),
      }
      : null,
    behaviors: behaviors
      ? { day: readBehaviorWindow(behaviors.day), week: readBehaviorWindow(behaviors.week) }
      : null,
  };
}

/** Claude effort levels ADE can set itself; the Fix's `/effort` lines map onto these. */
const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export type ClaudeUsageFixPlan = {
  /** The effort level a `/effort <level>` line asks for, applied through ADE's own effort setting. */
  effort: string | null;
  /** Everything else, sent to the chat as messages in order. */
  messages: string[];
};

/**
 * Split a Fix into what ADE applies itself and what it sends. A `/effort`
 * line sent as text would change Claude's effort behind ADE's effort picker,
 * so it becomes a setting change; an `/effort` level ADE does not know is
 * sent as written.
 */
export function planClaudeUsageFix(messages: readonly string[]): ClaudeUsageFixPlan {
  let effort: string | null = null;
  const rest: string[] = [];
  for (const message of messages) {
    const match = /^\/effort\s+(\S+)\s*$/i.exec(message.trim());
    const level = match?.[1]?.toLowerCase();
    if (level && CLAUDE_EFFORT_LEVELS.has(level)) effort = level;
    else rest.push(message);
  }
  return { effort, messages: rest };
}
