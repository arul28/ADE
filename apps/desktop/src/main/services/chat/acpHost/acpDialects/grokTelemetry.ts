/**
 * Grok telemetry. Grok sends no standard `usage_update`; everything rides xAI
 * extension notifications (verified live on Grok CLI 1.0.40, and in the
 * `updates.jsonl` Grok keeps under `~/.grok/sessions/`).
 *
 * `x.ai/session_notification` and `x.ai/session/update` carry an
 * `update.sessionUpdate` tag:
 *
 * - `response_completed` — one model response. Its `usage` is snake_case and
 *   its `input_tokens` EXCLUDES the cache read (18962 + 3456 cached = 22418
 *   in the capture).
 * - `turn_completed` — the turn totals, camelCase, where `inputTokens`
 *   INCLUDES the cache read. `costUsdTicks` are nano-dollars (1e9 = $1), and
 *   `modelUsage` is keyed by the model that SERVED the turn (`grok-4.5-build`
 *   for a `grok-4.5` request). The `session/prompt` result `_meta` repeats it.
 * - `subagent_spawned` / `subagent_finished` — the task tool's children, with
 *   `tokens_used`, `tool_calls`, and `duration_ms` on the finish.
 * - `auto_compact_started` / `_completed` / `_failed` / `_cancelled` — Grok's
 *   own compaction, with `tokens_before` / `tokens_after` on completion.
 * - `model_changed` / `model_auto_switched` — the requested model moved.
 * - `pending_interaction` — a spinner hint that looks like a permission
 *   request. It maps to nothing, on purpose.
 *
 * `x.ai/models/update` carries `{ currentModelId, availableModels: [{ modelId,
 * _meta: { totalContextTokens } }] }`, the requested model and each window.
 *
 * Grok 1.0.13 spelled these methods without the leading underscore and 1.0.40
 * adds it. Both spellings are registered.
 */

import type { AcpSubagentUsage, AcpTelemetrySignal, AcpUsageSample } from "../acpHostTypes";
import type { AcpCompactionUpdate } from "../acpProtocolTypes";
import {
  readAcpCompactionUpdate,
  readFiniteNumber,
  readTrimmedText,
  tokenSplitFields,
} from "../acpTelemetryReaders";
import { GROK_COST_TICKS_PER_USD } from "../../../usage/providerLedgerFormats";
import { uncachedInputTokens } from "../../../usage/tokenSplit";
import { asRecord } from "../../../shared/utils";
import { extensionSessionId } from "./shared";

/**
 * Grok's extension methods, bare. The dialect registers each one under both
 * spellings with `extensionMethodVariants`.
 */
export const GROK_SESSION_NOTIFICATION_METHOD = "x.ai/session_notification";
export const GROK_SESSION_UPDATE_METHOD = "x.ai/session/update";
export const GROK_MODELS_UPDATE_METHOD = "x.ai/models/update";

function readFromLayers(
  layers: Array<Record<string, unknown> | null | undefined>,
  keys: readonly string[],
): number | undefined {
  for (const layer of layers) {
    for (const key of keys) {
      const value = readFiniteNumber(layer?.[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/**
 * One `modelUsage` entry's counts, as Grok wrote them. `input` INCLUDES the
 * cache read and write, like the turn totals; split it with
 * `uncachedInputTokens`.
 */
export type GrokModelUsageRow = {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  /** Model requests the entry covers (`modelCalls`). */
  calls?: number;
  /** Provider cost in ticks; divide by `GROK_COST_TICKS_PER_USD`. */
  costTicks?: number;
};

/** `modelUsage` summed across models, and the model that did most of the work. */
export type GrokModelUsageTotals = GrokModelUsageRow & {
  /** The model that carried the most tokens. */
  dominantModel?: string;
};

const GROK_MODEL_USAGE_FIELDS = [
  "input", "output", "reasoning", "cacheRead", "cacheWrite", "total", "calls", "costTicks",
] as const satisfies ReadonlyArray<keyof GrokModelUsageRow>;

/**
 * Read one `turn_completed.usage.modelUsage[model]` entry (the same shape in
 * the live notification, the `session/prompt` result `_meta`, and the
 * `updates.jsonl` Grok keeps). Accepts the older spellings too:
 * `promptTokens`, `completionTokens`, and `thoughtTokens`. Pure, so the usage
 * history scanner can read `updates.jsonl` rows with it. `null` when the entry
 * carries neither input nor output.
 */
export function readGrokModelUsageRow(entry: unknown): GrokModelUsageRow | null {
  const row = asRecord(entry);
  if (!row) return null;
  const input = readFiniteNumber(row.inputTokens) ?? readFiniteNumber(row.promptTokens);
  const output = readFiniteNumber(row.outputTokens) ?? readFiniteNumber(row.completionTokens);
  if (input === undefined && output === undefined) return null;
  const fields: Record<keyof GrokModelUsageRow, number | undefined> = {
    input,
    output,
    reasoning: readFiniteNumber(row.reasoningTokens) ?? readFiniteNumber(row.thoughtTokens),
    cacheRead: readFiniteNumber(row.cachedReadTokens),
    cacheWrite: readFiniteNumber(row.cacheCreationTokens),
    total: readFiniteNumber(row.totalTokens),
    calls: readFiniteNumber(row.modelCalls),
    costTicks: readFiniteNumber(row.costUsdTicks),
  };
  const read: GrokModelUsageRow = {};
  for (const key of GROK_MODEL_USAGE_FIELDS) {
    if (fields[key] !== undefined) read[key] = fields[key];
  }
  return read;
}

/**
 * Sum a `modelUsage` map across models with `readGrokModelUsageRow`, and name
 * the model that did most of the work. `null` when no entry carried tokens.
 */
export function readGrokModelUsage(modelUsage: unknown): GrokModelUsageTotals | null {
  const entries = asRecord(modelUsage);
  if (!entries) return null;
  const totals: GrokModelUsageTotals = {};
  let dominantTokens = -1;
  let sawAny = false;
  for (const [modelId, entry] of Object.entries(entries)) {
    const row = readGrokModelUsageRow(entry);
    if (!row) continue;
    sawAny = true;
    for (const key of GROK_MODEL_USAGE_FIELDS) {
      const value = row[key];
      if (value !== undefined) totals[key] = (totals[key] ?? 0) + value;
    }
    const tokens = row.total ?? (row.input ?? 0) + (row.output ?? 0);
    if (tokens > dominantTokens) {
      dominantTokens = tokens;
      totals.dominantModel = modelId;
    }
  }
  return sawAny ? totals : null;
}

/**
 * Read a Grok turn-usage record: `turn_completed.usage`, or the
 * `session/prompt` result `_meta` (whose nested `usage` holds the same totals
 * on 1.0.13 and later; older captures put them at the top level). Earlier
 * layers win.
 */
export function readGrokUsageRecord(layers: Array<Record<string, unknown> | null | undefined>): AcpUsageSample | null {
  const models = layers.map((layer) => readGrokModelUsage(layer?.modelUsage)).find(Boolean) ?? null;
  const sample: AcpUsageSample = {};

  const costTicks = readFromLayers(layers, ["costUsdTicks"]) ?? models?.costTicks;
  if (costTicks !== undefined) sample.costUsd = costTicks / GROK_COST_TICKS_PER_USD;

  const cacheRead = models?.cacheRead ?? readFromLayers(layers, ["cachedReadTokens", "cacheReadTokens"]);
  const cacheWrite = models?.cacheWrite ?? readFromLayers(layers, ["cacheCreationTokens", "cachedWriteTokens"]);
  const input = models?.input ?? readFromLayers(layers, ["inputTokens", "promptTokens"]);
  const output = models?.output ?? readFromLayers(layers, ["outputTokens", "completionTokens"]);
  const reasoning = models?.reasoning ?? readFromLayers(layers, ["reasoningTokens"]);
  const total = readFromLayers(layers, ["totalTokens"]) ?? models?.total;

  // The turn totals count the cache inside `inputTokens`. ADE's convention is
  // uncached input, with the cache in its own fields.
  if (input !== undefined) sample.inputTokens = uncachedInputTokens(input, cacheRead, cacheWrite);
  if (output !== undefined) sample.outputTokens = output;
  if (cacheRead !== undefined) sample.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) sample.cacheWriteTokens = cacheWrite;
  if (reasoning !== undefined) sample.reasoningTokens = reasoning;
  if (total !== undefined) sample.totalTokens = total;
  else if (input !== undefined || output !== undefined) sample.totalTokens = (input ?? 0) + (output ?? 0);

  const requestCount = readFromLayers(layers, ["modelCalls"]) ?? models?.calls;
  if (requestCount !== undefined) sample.requestCount = requestCount;
  if (models?.dominantModel) sample.servedModel = models.dominantModel;

  return Object.keys(sample).length ? sample : null;
}

/** Read Grok's usage from the `session/prompt` result `_meta`. */
export function readGrokPromptUsage(meta: Record<string, unknown> | null | undefined): AcpUsageSample | null {
  if (!meta) return null;
  return readGrokUsageRecord([asRecord(meta.usage), meta]);
}

/**
 * Read one `response_completed` usage. The input side of the response is the
 * context the model just carried, so it doubles as a context sample.
 */
export function readGrokResponseUsage(raw: unknown): AcpUsageSample | null {
  const usage = asRecord(raw);
  if (!usage) return null;
  const input = readFiniteNumber(usage.input_tokens);
  const output = readFiniteNumber(usage.output_tokens);
  const cacheRead = readFiniteNumber(usage.cache_read_input_tokens);
  const cacheWrite = readFiniteNumber(usage.cache_creation_input_tokens);
  const reasoning = readFiniteNumber(usage.reasoning_tokens);
  if (input === undefined && output === undefined) return null;
  const inputSide = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    totalTokens: inputSide + (output ?? 0),
    contextUsedTokens: inputSide,
  };
}

function subagentStatus(raw: unknown): "completed" | "failed" | "stopped" {
  const status = typeof raw === "string" ? raw.toLowerCase() : "";
  if (["failed", "error", "errored", "timed_out", "timeout"].includes(status)) return "failed";
  if (["cancelled", "canceled", "stopped", "killed", "interrupted", "aborted"].includes(status)) return "stopped";
  return "completed";
}

function readSubagentUsage(update: Record<string, unknown>): AcpSubagentUsage {
  const split = readGrokUsageRecord([asRecord(update.usage)]);
  const totalTokens = readFiniteNumber(update.tokens_used) ?? split?.totalTokens;
  const toolUses = readFiniteNumber(update.tool_calls);
  const durationMs = readFiniteNumber(update.duration_ms);
  return {
    ...(split ? tokenSplitFields(split) : {}),
    ...(split?.costUsd !== undefined ? { costUsd: split.costUsd } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** Map one Grok `update` payload to telemetry signals. Unknown kinds map to nothing. */
export function readGrokUpdate(update: Record<string, unknown>): AcpTelemetrySignal[] {
  switch (update.sessionUpdate) {
    case "response_completed": {
      const usage = readGrokResponseUsage(update.usage);
      return usage ? [{ kind: "request_usage", usage }] : [];
    }
    case "turn_completed": {
      const usage = readGrokUsageRecord([asRecord(update.usage)]);
      return usage ? [{ kind: "turn_usage", usage }] : [];
    }
    case "subagent_spawned": {
      const agentId = readTrimmedText(update.subagent_id) ?? readTrimmedText(update.child_session_id);
      if (!agentId) return [];
      const agentType = readTrimmedText(update.subagent_type);
      const model = readTrimmedText(update.model);
      const description = readTrimmedText(update.description);
      return [{
        kind: "subagent_started",
        agentId,
        ...(agentType ? { agentType } : {}),
        ...(model ? { model } : {}),
        ...(description ? { description } : {}),
      }];
    }
    case "subagent_finished": {
      const agentId = readTrimmedText(update.subagent_id) ?? readTrimmedText(update.child_session_id);
      if (!agentId) return [];
      const summary = readTrimmedText(update.output);
      const model = readTrimmedText(update.model);
      return [{
        kind: "subagent_finished",
        agentId,
        status: subagentStatus(update.status),
        ...(summary ? { summary } : {}),
        ...(model ? { model } : {}),
        usage: readSubagentUsage(update),
      }];
    }
    case "auto_compact_started": {
      const preTokens = readFiniteNumber(update.tokens_used);
      return [{ kind: "compaction", state: "started", ...(preTokens !== undefined ? { preTokens } : {}) }];
    }
    case "auto_compact_completed": {
      const preTokens = readFiniteNumber(update.tokens_before);
      const postTokens = readFiniteNumber(update.tokens_after);
      return [{
        kind: "compaction",
        state: "completed",
        ...(preTokens !== undefined ? { preTokens } : {}),
        ...(postTokens !== undefined ? { postTokens } : {}),
      }];
    }
    case "auto_compact_failed":
      return [{ kind: "compaction", state: "failed" }];
    case "auto_compact_cancelled":
      return [{ kind: "compaction", state: "failed", failReason: "interrupted" }];
    case "compaction_update": {
      const signal = readAcpCompactionUpdate(update as AcpCompactionUpdate);
      return signal ? [signal] : [];
    }
    case "model_changed":
    case "model_auto_switched": {
      const modelId = readTrimmedText(update.new_model_id) ?? readTrimmedText(update.model_id);
      return modelId ? [{ kind: "model_catalog", currentModelId: modelId, contextWindows: {} }] : [];
    }
    default:
      return [];
  }
}

/** Reader for `x.ai/session_notification` and `x.ai/session/update`. */
export function readGrokSessionNotification(params: unknown): { sessionId: string | null; signals: AcpTelemetrySignal[] } {
  const update = asRecord(asRecord(params)?.update);
  return { sessionId: extensionSessionId(params), signals: update ? readGrokUpdate(update) : [] };
}

/** Reader for `x.ai/models/update`: the requested model and every model's window. */
export function readGrokModelsUpdate(params: unknown): { sessionId: string | null; signals: AcpTelemetrySignal[] } {
  const payload = asRecord(params);
  if (!payload) return { sessionId: null, signals: [] };
  const contextWindows: Record<string, number> = {};
  if (Array.isArray(payload.availableModels)) {
    for (const entry of payload.availableModels) {
      const model = asRecord(entry);
      const modelId = readTrimmedText(model?.modelId);
      const window = readFiniteNumber(asRecord(model?._meta)?.totalContextTokens);
      if (modelId && window !== undefined && window > 0) contextWindows[modelId] = window;
    }
  }
  const currentModelId = readTrimmedText(payload.currentModelId) ?? null;
  if (!currentModelId && !Object.keys(contextWindows).length) {
    return { sessionId: extensionSessionId(params), signals: [] };
  }
  return {
    sessionId: extensionSessionId(params),
    signals: [{ kind: "model_catalog", currentModelId, contextWindows }],
  };
}
