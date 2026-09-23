import {
  isAcpChatProvider,
  type AcpChatProvider,
  type AgentChatCompactDetection,
  type AgentChatCompactProvider,
  type AgentChatEvent,
  type AgentChatSession,
} from "../../../shared/types";
import { contextCompactMergeKey, type ContextCompactEvent } from "../../../shared/contextCompaction";

export type CompactionEmitterState = {
  startedAtByKey: Map<string, number>;
  sessionCompactionCount: number;
};

export function createCompactionEmitterState(): CompactionEmitterState {
  return {
    startedAtByKey: new Map(),
    sessionCompactionCount: 0,
  };
}

/** Keyed by type, so a provider added to `AgentChatCompactProvider` must be added here. */
const NATIVE_COMPACT_PROVIDERS: Record<Exclude<AgentChatCompactProvider, AcpChatProvider>, true> = {
  claude: true,
  codex: true,
  opencode: true,
  cursor: true,
  droid: true,
  pi: true,
};

export function isContextCompactProvider(provider: string | null | undefined): provider is AgentChatCompactProvider {
  if (provider == null) return false;
  return Object.hasOwn(NATIVE_COMPACT_PROVIDERS, provider) || isAcpChatProvider(provider);
}

export function buildContextCompactEvent(
  state: CompactionEmitterState,
  session: AgentChatSession,
  input: {
    trigger: "manual" | "auto" | "ade_fallback";
    state?: "started" | "completed" | "failed";
    failReason?: "interrupted" | "timed_out" | "teardown";
    turnId?: string;
    compactionId?: string;
    preTokens?: number;
    postTokens?: number;
    tokensRemoved?: number;
    durationMs?: number;
    completedAtMs?: number;
    detection?: AgentChatCompactDetection;
  },
): ContextCompactEvent {
  const lifecycle = input.state ?? "completed";
  const compactionId = input.compactionId ?? input.turnId;
  const mergeKey = contextCompactMergeKey({ compactionId, turnId: input.turnId });
  const provider = isContextCompactProvider(session.provider) ? session.provider : undefined;
  const now = input.completedAtMs ?? Date.now();

  if (lifecycle === "started") {
    state.startedAtByKey.set(mergeKey, now);
    return {
      type: "context_compact",
      trigger: input.trigger,
      state: "started",
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(compactionId ? { compactionId } : {}),
      // A begin signal can already know the size being compacted (Cursor's
      // PreCompact hook, Droid's context stats); keep it on the started event.
      ...(input.preTokens != null ? { preTokens: input.preTokens } : {}),
      ...(provider ? { provider } : {}),
      ...(input.detection ? { detection: input.detection } : {}),
    };
  }

  const startedAt = state.startedAtByKey.get(mergeKey);
  state.startedAtByKey.delete(mergeKey);
  const durationMs = input.durationMs ?? (startedAt != null && now > startedAt ? now - startedAt : undefined);
  if (lifecycle !== "failed") {
    state.sessionCompactionCount += 1;
  }

  return {
    type: "context_compact",
    trigger: input.trigger,
    state: lifecycle,
    ...(input.failReason ? { failReason: input.failReason } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(compactionId ? { compactionId } : {}),
    ...(input.preTokens != null ? { preTokens: input.preTokens } : {}),
    ...(input.postTokens != null ? { postTokens: input.postTokens } : {}),
    ...(input.tokensRemoved != null ? { tokensRemoved: input.tokensRemoved } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    ...(provider ? { provider } : {}),
    ...(input.detection ? { detection: input.detection } : {}),
    ...(lifecycle !== "failed" && state.sessionCompactionCount >= 2
      ? { sessionCompactionCount: state.sessionCompactionCount }
      : {}),
  };
}

export function mapLegacyCompactionEvent(
  state: CompactionEmitterState,
  session: AgentChatSession,
  event: AgentChatEvent,
): ContextCompactEvent | null {
  if (event.type === "context_compact") {
    // Always rebuilt, so every provider's compaction counts toward the session
    // and closes its started entry; a provider-measured `durationMs` wins.
    return buildContextCompactEvent(state, session, {
      trigger: event.trigger,
      state: event.state,
      failReason: event.failReason,
      turnId: event.turnId,
      compactionId: event.compactionId ?? event.turnId,
      preTokens: event.preTokens,
      postTokens: event.postTokens,
      tokensRemoved: event.tokensRemoved,
      durationMs: event.durationMs,
      detection: event.detection,
    });
  }
  if (event.type === "codex_context_compaction") {
    return buildContextCompactEvent(state, session, {
      trigger: event.trigger,
      state: event.state,
      failReason: event.failReason,
      turnId: event.turnId,
      compactionId: event.compactionId ?? event.turnId,
    });
  }
  return null;
}
