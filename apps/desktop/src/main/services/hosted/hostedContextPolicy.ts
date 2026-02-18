import type { HostedContextDeliveryMode, HostedJobType } from "../../../shared/types";

const AUTO_MIRROR_THRESHOLD_BYTES = 60_000;
const INLINE_FALLBACK_MAX_BYTES = 18_000;

type ReduceLimits = {
  maxStringChars: number;
  maxArrayItems: number;
  maxDepth: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sortForStableJson(value: unknown, depth = 0, maxDepth = 24): unknown {
  if (depth > maxDepth) return "[omitted:depth]" as const;
  if (Array.isArray(value)) return value.map((entry) => sortForStableJson(entry, depth + 1, maxDepth));
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = sortForStableJson(v, depth + 1, maxDepth);
  }
  return out;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

export function estimateUtf8Bytes(text: string): number {
  return Buffer.byteLength(text ?? "", "utf8");
}

export function decideHostedContextDelivery(args: {
  mode: HostedContextDeliveryMode;
  jobType: HostedJobType;
  estimatedBytes: number;
  mirrorLastSuccessAt?: string | null;
  policyTtlMs?: number | null;
}): {
  mode: "inline" | "mirror";
  reasonCode: string;
  estimatedBytes: number;
  policyMode: HostedContextDeliveryMode;
  thresholdBytes: number;
  inlineFallbackMaxBytes: number;
  staleness: {
    mirrorLastSuccessAt: string | null;
    mirrorStalenessMs: number | null;
    policyTtlMs: number | null;
  } | null;
} {
  const policyMode = args.mode;
  const mirrorLastSuccessAt = args.mirrorLastSuccessAt ?? null;
  const policyTtlMs = args.policyTtlMs ?? null;
  const mirrorStalenessMs = (() => {
    if (!mirrorLastSuccessAt) return null;
    const ts = Date.parse(mirrorLastSuccessAt);
    if (!Number.isFinite(ts)) return null;
    return Math.max(0, Date.now() - ts);
  })();

  const staleness =
    mirrorLastSuccessAt != null || policyTtlMs != null
      ? { mirrorLastSuccessAt, mirrorStalenessMs, policyTtlMs }
      : null;

  // Conflict-first escalation: hosted conflict jobs should use mirror-ref unless truly impossible
  // (upload failures are handled as a separate fallback path with explicit warnings).
  if (args.jobType === "ProposeConflictResolution" || args.jobType === "ConflictResolution") {
    return {
      mode: "mirror",
      reasonCode: "AUTO_MIRROR_JOBTYPE_CONFLICT",
      estimatedBytes: args.estimatedBytes,
      policyMode,
      thresholdBytes: AUTO_MIRROR_THRESHOLD_BYTES,
      inlineFallbackMaxBytes: INLINE_FALLBACK_MAX_BYTES,
      staleness
    };
  }

  if (policyMode === "inline") {
    return {
      mode: "inline",
      reasonCode: "POLICY_INLINE_FORCED",
      estimatedBytes: args.estimatedBytes,
      policyMode,
      thresholdBytes: AUTO_MIRROR_THRESHOLD_BYTES,
      inlineFallbackMaxBytes: INLINE_FALLBACK_MAX_BYTES,
      staleness
    };
  }

  if (policyMode === "mirror_preferred") {
    return {
      mode: "mirror",
      reasonCode: "POLICY_MIRROR_PREFERRED",
      estimatedBytes: args.estimatedBytes,
      policyMode,
      thresholdBytes: AUTO_MIRROR_THRESHOLD_BYTES,
      inlineFallbackMaxBytes: INLINE_FALLBACK_MAX_BYTES,
      staleness
    };
  }

  const stalePolicyExceeded =
    mirrorStalenessMs != null &&
    policyTtlMs != null &&
    mirrorStalenessMs > policyTtlMs;
  if (stalePolicyExceeded) {
    return {
      mode: "mirror",
      reasonCode: "POLICY_STALE_CONTEXT_REQUIRED",
      estimatedBytes: args.estimatedBytes,
      policyMode,
      thresholdBytes: AUTO_MIRROR_THRESHOLD_BYTES,
      inlineFallbackMaxBytes: INLINE_FALLBACK_MAX_BYTES,
      staleness
    };
  }

  // Auto: mirror for large payloads.
  if (args.estimatedBytes > AUTO_MIRROR_THRESHOLD_BYTES) {
    return {
      mode: "mirror",
      reasonCode: "AUTO_MIRROR_PARAMS_LARGE",
      estimatedBytes: args.estimatedBytes,
      policyMode,
      thresholdBytes: AUTO_MIRROR_THRESHOLD_BYTES,
      inlineFallbackMaxBytes: INLINE_FALLBACK_MAX_BYTES,
      staleness
    };
  }

  return {
    mode: "inline",
    reasonCode: "AUTO_INLINE_UNDER_THRESHOLD",
    estimatedBytes: args.estimatedBytes,
    policyMode,
    thresholdBytes: AUTO_MIRROR_THRESHOLD_BYTES,
    inlineFallbackMaxBytes: INLINE_FALLBACK_MAX_BYTES,
    staleness
  };
}

type ReductionStats = {
  omittedDepth: number;
  omittedString: number;
  omittedArray: number;
  omittedNonJson: number;
};

function reduceValue(value: unknown, limits: ReduceLimits, depth: number, stats: ReductionStats): unknown {
  if (depth > limits.maxDepth) {
    stats.omittedDepth += 1;
    return "[omitted:depth]" as const;
  }

  if (typeof value === "string") {
    if (value.length <= limits.maxStringChars) return value;
    stats.omittedString += 1;
    return `[omitted:string chars=${value.length}]`;
  }

  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;

  if (Array.isArray(value)) {
    if (value.length <= limits.maxArrayItems) return value.map((entry) => reduceValue(entry, limits, depth + 1, stats));
    stats.omittedArray += 1;
    const kept = value
      .slice(0, Math.max(0, limits.maxArrayItems))
      .map((entry) => reduceValue(entry, limits, depth + 1, stats));
    return [...kept, `[omitted:array items=${value.length - kept.length}]`];
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = reduceValue(v, limits, depth + 1, stats);
    }
    return out;
  }

  // Non-JSON types (functions, symbols, BigInt, etc.)
  stats.omittedNonJson += 1;
  return String(value);
}

export function buildInlineFallbackParams(args: {
  params: Record<string, unknown>;
  maxBytes?: number;
}): { fallback: Record<string, unknown>; approxBytes: number; approxOriginalBytes: number; clipReasonTags: string[] } {
  const maxBytes = typeof args.maxBytes === "number" ? Math.max(1000, args.maxBytes) : INLINE_FALLBACK_MAX_BYTES;
  const limits: ReduceLimits = { maxStringChars: 1800, maxArrayItems: 60, maxDepth: 10 };
  const approxOriginalBytes = estimateUtf8Bytes(stableJsonStringify(args.params));

  const statsToTags = (stats: ReductionStats, label: string): string[] => {
    const tags: string[] = [label];
    if (stats.omittedDepth > 0) tags.push("omitted:depth");
    if (stats.omittedString > 0) tags.push("omitted:string");
    if (stats.omittedArray > 0) tags.push("omitted:array");
    if (stats.omittedNonJson > 0) tags.push("omitted:non_json");
    return tags;
  };

  // First pass: cap strings/arrays.
  const stats1: ReductionStats = { omittedDepth: 0, omittedString: 0, omittedArray: 0, omittedNonJson: 0 };
  let reduced = reduceValue(args.params, limits, 0, stats1);
  const asRecord = isRecord(reduced) ? reduced : { value: reduced };

  let json = stableJsonStringify(asRecord);
  let bytes = estimateUtf8Bytes(json);
  if (bytes <= maxBytes) {
    return { fallback: asRecord, approxBytes: bytes, approxOriginalBytes, clipReasonTags: statsToTags(stats1, "reduce:pass1") };
  }

  // Second pass: more aggressive caps.
  const tighter: ReduceLimits = { maxStringChars: 900, maxArrayItems: 24, maxDepth: 7 };
  const stats2: ReductionStats = { omittedDepth: 0, omittedString: 0, omittedArray: 0, omittedNonJson: 0 };
  reduced = reduceValue(args.params, tighter, 0, stats2);
  const asRecord2 = isRecord(reduced) ? reduced : { value: reduced };
  json = stableJsonStringify(asRecord2);
  bytes = estimateUtf8Bytes(json);

  // Final hard-stop: if still too big, return a tiny envelope.
  if (bytes > maxBytes) {
    const envelope = {
      note: "Inline fallback clipped aggressively; prefer __adeContextRef payload.",
      approxOriginalBytes
    };
    return {
      fallback: envelope,
      approxBytes: estimateUtf8Bytes(stableJsonStringify(envelope)),
      approxOriginalBytes,
      clipReasonTags: ["clipped:envelope", ...statsToTags(stats2, "reduce:pass2")]
    };
  }

  return {
    fallback: asRecord2,
    approxBytes: bytes,
    approxOriginalBytes,
    clipReasonTags: statsToTags(stats2, "reduce:pass2")
  };
}
