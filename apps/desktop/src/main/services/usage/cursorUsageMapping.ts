import type { TokenEntry } from "../usage/ledgers/localUsageLedgers";
import type { AgentChatEvent } from "../../../shared/types";
import { mapTurnEndedTokensToEvent } from "../chat/cursorSdkEventMapper";

export type CursorAgentUsageCost = {
  rawCostCents: number | null;
  chargedCents: number | null;
};

export type CursorAgentUsageSnapshot = {
  agentId: string;
  runId?: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cost: CursorAgentUsageCost | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function centsToUsd(cents: number | null): number | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  return Math.round((cents / 100) * 1_000_000) / 1_000_000;
}

/**
 * Normalize `agent.getUsage()` / stream usage payloads. Cost stays in cents
 * here so Settings can convert to dollars; chat mapping must not copy costUsd.
 */
export function mapCursorAgentUsage(raw: unknown, args: {
  agentId: string;
  runId?: string | null;
}): CursorAgentUsageSnapshot {
  const record = asRecord(raw) ?? {};
  const usage = asRecord(record.usage) ?? record;
  const costRecord = asRecord(usage.cost) ?? asRecord(record.cost);
  const inputTokens = readNumber(
    usage.inputTokens ?? usage.input_tokens ?? usage.totalInputTokens ?? usage.total_input_tokens,
  );
  const outputTokens = readNumber(
    usage.outputTokens ?? usage.output_tokens ?? usage.totalOutputTokens ?? usage.total_output_tokens,
  );
  const cacheReadTokens = readNumber(usage.cacheReadTokens ?? usage.cache_read_tokens);
  const cacheWriteTokens = readNumber(
    usage.cacheWriteTokens ?? usage.cache_write_tokens ?? usage.cacheCreationTokens ?? usage.cache_creation_tokens,
  );
  const reasoningTokens = readNumber(usage.reasoningTokens ?? usage.reasoning_tokens);
  const totalTokens = readNumber(usage.totalTokens ?? usage.total_tokens)
    ?? ((inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) || null);
  const chargedCents = readNumber(costRecord?.chargedCents ?? costRecord?.charged_cents);
  const rawCostCents = readNumber(costRecord?.rawCostCents ?? costRecord?.raw_cost_cents);
  return {
    agentId: args.agentId,
    runId: args.runId ?? (typeof record.runId === "string" ? record.runId : typeof record.run_id === "string" ? record.run_id : null),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    reasoningTokens,
    cost: chargedCents != null || rawCostCents != null
      ? { chargedCents, rawCostCents }
      : null,
  };
}

/**
 * Prefer a per-turn / per-run entry from `getUsage().runs` so chat token lines
 * and Settings billed rows stay local-per-turn / cloud-per-run.
 */
export function selectCursorAgentTurnUsage(raw: unknown, args: {
  agentId: string;
  runId?: string | null;
}): CursorAgentUsageSnapshot {
  const record = asRecord(raw);
  const runs = Array.isArray(record?.runs) ? record.runs : [];
  const wanted = args.runId?.trim() || null;
  const selected = (wanted
    ? runs.find((entry) => {
        const row = asRecord(entry);
        const id = typeof row?.runId === "string" ? row.runId : typeof row?.run_id === "string" ? row.run_id : null;
        return id === wanted;
      })
    : null)
    ?? (runs.length ? runs[runs.length - 1] : null);
  if (selected) {
    const row = asRecord(selected) ?? {};
    const runId = typeof row.runId === "string"
      ? row.runId
      : typeof row.run_id === "string"
        ? row.run_id
        : wanted;
    return mapCursorAgentUsage(row, { agentId: args.agentId, runId });
  }
  return mapCursorAgentUsage(raw, args);
}

export function mapCursorAgentUsageToTokensEvent(
  snapshot: CursorAgentUsageSnapshot,
  meta: { turnId: string; runtime?: "local" | "cloud"; itemId?: string },
): Extract<AgentChatEvent, { type: "tokens" }> | null {
  return mapTurnEndedTokensToEvent({
    usage: {
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      cacheReadTokens: snapshot.cacheReadTokens,
      cacheWriteTokens: snapshot.cacheWriteTokens,
    },
  }, {
    turnId: meta.turnId,
    runtime: meta.runtime,
    ...(meta.itemId ? { itemId: meta.itemId } : snapshot.runId ? { itemId: snapshot.runId } : {}),
  });
}

export function mapCursorAgentUsageToTokenEntry(
  snapshot: CursorAgentUsageSnapshot,
  args: { timestamp?: number; projectPath?: string | null } = {},
): TokenEntry | null {
  const inputTokens = snapshot.inputTokens ?? 0;
  const outputTokens = snapshot.outputTokens ?? 0;
  const cachedTokens = snapshot.cacheReadTokens ?? 0;
  const cacheWriteTokens = snapshot.cacheWriteTokens ?? 0;
  const chargedUsd = centsToUsd(snapshot.cost?.chargedCents ?? null);
  if (inputTokens + outputTokens + cachedTokens + cacheWriteTokens === 0 && chargedUsd == null) {
    return null;
  }
  const runKey = snapshot.runId?.trim() || snapshot.agentId;
  return {
    messageId: `cursor:getUsage:${runKey}`,
    model: "cursor",
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens,
    timestamp: args.timestamp ?? Date.now(),
    ...(args.projectPath ? { projectPath: args.projectPath } : {}),
    ...(chargedUsd != null ? { costOverrideUsd: chargedUsd } : {}),
  };
}

export function cursorUsageCostUsd(snapshot: CursorAgentUsageSnapshot): number | null {
  return centsToUsd(snapshot.cost?.chargedCents ?? snapshot.cost?.rawCostCents ?? null);
}
