/**
 * Small readers shared by the translator, the turn telemetry, and the dialects'
 * own telemetry and ledger modules.
 *
 * A leaf: it imports types only, so a dialect module (and the usage ledger
 * worker, through a dialect's per-row reader) can use it without loading the
 * translator or the turn telemetry.
 */

import type { AcpTelemetrySignal, AcpUsageSample } from "./acpHostTypes";
import type { AcpCompactionUpdate } from "./acpProtocolTypes";

/**
 * A finite number, or `undefined`. A `bigint` (an integer column from
 * `node:sqlite`) reads as its number value.
 */
export function readFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/** A string with its surrounding whitespace removed, or `undefined` when nothing is left. */
export function readTrimmedText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length ? text : undefined;
}

/** The token counts of an `AcpUsageSample`, the fields a fold adds up. */
export const ACP_TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

/** True when the sample carries at least one token count. */
export function hasTokenCounts(sample: AcpUsageSample | null | undefined): sample is AcpUsageSample {
  return Boolean(sample && ACP_TOKEN_FIELDS.some((field) => sample[field] !== undefined));
}

/** Add every token count `sample` carries into `into`. Absent stays absent. */
export function addTokenCounts(into: AcpUsageSample, sample: AcpUsageSample): void {
  for (const field of ACP_TOKEN_FIELDS) {
    const value = sample[field];
    if (value !== undefined) into[field] = (into[field] ?? 0) + value;
  }
}

/** The split a chat event carries: input, output, cache read and write, reasoning. */
export type AcpTokenSplitFields = Pick<
  AcpUsageSample,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens"
>;

/**
 * The token split of a sample, without the unset fields. The `tokens` event
 * and a subagent's usage both carry it under these names.
 */
export function tokenSplitFields(usage: AcpUsageSample): AcpTokenSplitFields {
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
}

/**
 * The context-meter breakdown of one sample, in the chat event's names (the
 * cache write is `cacheCreationTokens` there).
 */
export function acpContextBreakdown(sample: AcpUsageSample): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
} {
  return {
    inputTokens: sample.inputTokens,
    outputTokens: sample.outputTokens,
    cacheReadTokens: sample.cacheReadTokens,
    cacheCreationTokens: sample.cacheWriteTokens,
  };
}

/**
 * Read a session-compaction RFD `compaction_update`. `cancelled` lands as a
 * failed compaction that was interrupted; an unknown status is ignored, as the
 * RFD's open enum asks.
 */
export function readAcpCompactionUpdate(update: AcpCompactionUpdate): Extract<AcpTelemetrySignal, { kind: "compaction" }> | null {
  const compactionId = typeof update.compactionId === "string" && update.compactionId.length
    ? { compactionId: update.compactionId }
    : {};
  switch (update.status) {
    case "in_progress":
      return { kind: "compaction", state: "started", ...compactionId };
    case "completed":
      return { kind: "compaction", state: "completed", ...compactionId };
    case "failed":
      return { kind: "compaction", state: "failed", ...compactionId };
    case "cancelled":
      return { kind: "compaction", state: "failed", failReason: "interrupted", ...compactionId };
    default:
      return null;
  }
}
