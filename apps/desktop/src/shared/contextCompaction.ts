import type { AgentChatEvent } from "./types";

export type ContextCompactProvider = "claude" | "codex" | "opencode" | "cursor" | "droid";

export type ContextCompactEvent = Extract<AgentChatEvent, { type: "context_compact" }>;

export type NormalizedContextCompact = {
  trigger: "manual" | "auto" | "ade_fallback";
  state: "started" | "completed";
  turnId?: string;
  compactionId?: string;
  preTokens?: number;
  postTokens?: number;
  tokensRemoved?: number;
  durationMs?: number;
  provider?: ContextCompactProvider;
  sessionCompactionCount?: number;
};

const PROVIDER_TINTS: Record<ContextCompactProvider, { ring: string; border: string }> = {
  claude: { ring: "ring-amber-400/25", border: "border-amber-400/30" },
  codex: { ring: "ring-white/20", border: "border-white/25" },
  opencode: { ring: "ring-sky-400/25", border: "border-sky-400/30" },
  cursor: { ring: "ring-violet-400/25", border: "border-violet-400/30" },
  droid: { ring: "ring-orange-400/25", border: "border-orange-400/30" },
};

export function isContextCompactionChatEvent(
  event: AgentChatEvent,
): event is ContextCompactEvent | Extract<AgentChatEvent, { type: "codex_context_compaction" }> {
  return event.type === "context_compact" || event.type === "codex_context_compaction";
}

export function normalizeContextCompactEvent(event: AgentChatEvent): NormalizedContextCompact | null {
  if (event.type === "context_compact") {
    return {
      trigger: event.trigger,
      state: event.state ?? "completed",
      turnId: event.turnId,
      compactionId: event.compactionId,
      preTokens: event.preTokens,
      postTokens: event.postTokens,
      tokensRemoved: event.tokensRemoved,
      durationMs: event.durationMs,
      provider: event.provider,
      sessionCompactionCount: event.sessionCompactionCount,
    };
  }
  if (event.type === "codex_context_compaction") {
    return {
      trigger: event.trigger,
      state: event.state,
      turnId: event.turnId,
      compactionId: event.compactionId ?? event.turnId,
    };
  }
  return null;
}

export function contextCompactMergeKey(event: Pick<NormalizedContextCompact, "compactionId" | "turnId">): string {
  if (event.compactionId?.trim()) return event.compactionId.trim();
  if (event.turnId?.trim()) return event.turnId.trim();
  return "legacy";
}

export function formatCompactTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

export function formatCompactDuration(durationMs: number | null | undefined): string | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
}

export function resolveProviderTint(provider?: ContextCompactProvider | string | null): {
  ring: string;
  border: string;
} {
  if (provider && provider in PROVIDER_TINTS) {
    return PROVIDER_TINTS[provider as ContextCompactProvider];
  }
  return PROVIDER_TINTS.claude;
}

export type ContextCompactMetadataChip = {
  key: string;
  label: string;
};

export function buildContextCompactMetadataChips(
  compact: NormalizedContextCompact,
): ContextCompactMetadataChip[] {
  const chips: ContextCompactMetadataChip[] = [];
  chips.push({
    key: "trigger",
    label: compact.trigger === "manual" ? "MANUAL" : "AUTO",
  });

  const pre = formatCompactTokenCount(compact.preTokens);
  const post = formatCompactTokenCount(compact.postTokens);
  if (pre && post) {
    chips.push({ key: "tokens", label: `${pre} → ${post}` });
  } else if (pre) {
    chips.push({ key: "tokens", label: `before ${pre}` });
  } else if (typeof compact.tokensRemoved === "number" && compact.tokensRemoved > 0) {
    const removed = formatCompactTokenCount(compact.tokensRemoved);
    if (removed) chips.push({ key: "removed", label: `${removed} freed` });
  }

  const duration = formatCompactDuration(compact.durationMs);
  if (duration) chips.push({ key: "duration", label: duration });

  return chips;
}

export function mergeNormalizedContextCompact(
  previous: NormalizedContextCompact,
  incoming: NormalizedContextCompact,
  options?: { durationMs?: number; sessionCompactionCount?: number },
): NormalizedContextCompact {
  return {
    ...previous,
    ...incoming,
    state: incoming.state,
    trigger: incoming.trigger ?? previous.trigger,
    turnId: incoming.turnId ?? previous.turnId,
    compactionId: incoming.compactionId ?? previous.compactionId,
    preTokens: incoming.preTokens ?? previous.preTokens,
    postTokens: incoming.postTokens ?? previous.postTokens,
    tokensRemoved: incoming.tokensRemoved ?? previous.tokensRemoved,
    durationMs: options?.durationMs ?? incoming.durationMs ?? previous.durationMs,
    provider: incoming.provider ?? previous.provider,
    sessionCompactionCount: options?.sessionCompactionCount ?? incoming.sessionCompactionCount ?? previous.sessionCompactionCount,
  };
}

export function toContextCompactChatEvent(
  compact: NormalizedContextCompact,
): ContextCompactEvent {
  return {
    type: "context_compact",
    trigger: compact.trigger,
    state: compact.state,
    ...(compact.turnId ? { turnId: compact.turnId } : {}),
    ...(compact.compactionId ? { compactionId: compact.compactionId } : {}),
    ...(compact.preTokens != null ? { preTokens: compact.preTokens } : {}),
    ...(compact.postTokens != null ? { postTokens: compact.postTokens } : {}),
    ...(compact.tokensRemoved != null ? { tokensRemoved: compact.tokensRemoved } : {}),
    ...(compact.durationMs != null ? { durationMs: compact.durationMs } : {}),
    ...(compact.provider ? { provider: compact.provider } : {}),
    ...(compact.sessionCompactionCount != null ? { sessionCompactionCount: compact.sessionCompactionCount } : {}),
  };
}

export function detectCompactionSignalText(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return /\b(compact(ing|ed|ion)?|summariz(e|ing|ed|ation)?|trim(ming|med)?\s+context|context\s+(window\s+)?(trim|compact|summar))\b/.test(lower);
}
