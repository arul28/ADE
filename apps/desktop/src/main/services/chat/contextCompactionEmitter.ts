import type { AgentChatEvent, AgentChatSession } from "../../../shared/types";
import {
  contextCompactMergeKey,
  type ContextCompactEvent,
  type ContextCompactProvider,
} from "../../../shared/contextCompaction";

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

function resolveCompactionProvider(session: AgentChatSession): ContextCompactProvider | undefined {
  switch (session.provider) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "cursor":
      return "cursor";
    case "droid":
      return "droid";
    default:
      return undefined;
  }
}

export function buildContextCompactEvent(
  state: CompactionEmitterState,
  session: AgentChatSession,
  input: {
    trigger: "manual" | "auto";
    state?: "started" | "completed";
    turnId?: string;
    compactionId?: string;
    preTokens?: number;
    postTokens?: number;
    tokensRemoved?: number;
    completedAtMs?: number;
  },
): ContextCompactEvent {
  const lifecycle = input.state ?? "completed";
  const compactionId = input.compactionId ?? input.turnId;
  const mergeKey = contextCompactMergeKey({ compactionId, turnId: input.turnId });
  const provider = resolveCompactionProvider(session);
  const now = input.completedAtMs ?? Date.now();

  if (lifecycle === "started") {
    state.startedAtByKey.set(mergeKey, now);
    return {
      type: "context_compact",
      trigger: input.trigger,
      state: "started",
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(compactionId ? { compactionId } : {}),
      ...(provider ? { provider } : {}),
    };
  }

  const startedAt = state.startedAtByKey.get(mergeKey);
  state.startedAtByKey.delete(mergeKey);
  const durationMs = startedAt != null && now > startedAt ? now - startedAt : undefined;
  state.sessionCompactionCount += 1;

  return {
    type: "context_compact",
    trigger: input.trigger,
    state: "completed",
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(compactionId ? { compactionId } : {}),
    ...(input.preTokens != null ? { preTokens: input.preTokens } : {}),
    ...(input.postTokens != null ? { postTokens: input.postTokens } : {}),
    ...(input.tokensRemoved != null ? { tokensRemoved: input.tokensRemoved } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    ...(provider ? { provider } : {}),
    ...(state.sessionCompactionCount >= 2 ? { sessionCompactionCount: state.sessionCompactionCount } : {}),
  };
}

export function mapLegacyCompactionEvent(
  state: CompactionEmitterState,
  session: AgentChatSession,
  event: AgentChatEvent,
): ContextCompactEvent | null {
  if (event.type === "context_compact") {
    if (event.state !== "started" && event.provider && event.durationMs != null) return event;
    return buildContextCompactEvent(state, session, {
      trigger: event.trigger,
      state: event.state,
      turnId: event.turnId,
      compactionId: event.compactionId ?? event.turnId,
      preTokens: event.preTokens,
      postTokens: event.postTokens,
      tokensRemoved: event.tokensRemoved,
    });
  }
  if (event.type === "codex_context_compaction") {
    return buildContextCompactEvent(state, session, {
      trigger: event.trigger,
      state: event.state,
      turnId: event.turnId,
      compactionId: event.compactionId ?? event.turnId,
    });
  }
  return null;
}
