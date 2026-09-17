import {
  AGENT_CHAT_CONTEXT_ROTATION_PCT,
  AGENT_CHAT_CONTEXT_ROTATION_TURNS,
  isContextOverflowFailureText,
  type AgentChatLastTurnFailure,
  type AgentChatSessionContextHealth,
} from "../../../shared/types/chat";

/**
 * A session's durable turn health, as pure functions over plain records.
 *
 * Two questions, answered from what is already on disk rather than from a
 * provider: "can this thread take another turn at all" (the overflow verdict,
 * which outlives restarts) and "is this thread getting close" (the occupancy
 * streak the CTO page offers a rotation on).
 *
 * They live outside `agentChatService` because they touch no runtime — they
 * take a settled turn's facts and return the next record — and because their
 * tests should not have to stand up the provider graph to run.
 */

export function normalizeLastTurnFailure(value: unknown): AgentChatLastTurnFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === "context_overflow" ? "context_overflow" : record.kind === "error" ? "error" : null;
  if (!kind) return null;
  const message = typeof record.message === "string" ? record.message.trim() : "";
  const at = typeof record.at === "string" && record.at.trim().length ? record.at.trim() : "";
  if (!at.length) return null;
  const turnId = typeof record.turnId === "string" && record.turnId.trim().length ? record.turnId.trim() : null;
  return { kind, message, at, ...(turnId ? { turnId } : {}) };
}

/** Read a persisted `contextHealth` back, or null if it is not one. */
export function normalizeSessionContextHealth(value: unknown): AgentChatSessionContextHealth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const at = typeof record.updatedAt === "string" && record.updatedAt.trim().length ? record.updatedAt.trim() : "";
  if (!at.length) return null;
  const pct = typeof record.occupancyPct === "number" && Number.isFinite(record.occupancyPct)
    ? Math.max(0, Math.min(100, record.occupancyPct))
    : null;
  const turns = typeof record.aboveHighWaterTurns === "number" && Number.isFinite(record.aboveHighWaterTurns)
    ? Math.max(0, Math.floor(record.aboveHighWaterTurns))
    : 0;
  return {
    occupancyPct: pct,
    aboveHighWaterTurns: turns,
    compactionSeen: record.compactionSeen === true,
    updatedAt: at,
  };
}

/**
 * Should this thread be rotated before it wedges?
 *
 * Two conditions, both deliberately conservative. A thread that has ALREADY
 * failed on overflow is past advice — it is broken, and saying so is the honest
 * answer. Short of that, ADE only speaks up once the thread has sat above the
 * high-water mark for two settled turns in a row AND a compaction has already
 * run, because before compaction the occupancy number is not yet the thread's
 * floor: the next compaction may win most of it back.
 */
export function shouldAdviseSessionRotation(
  failure: AgentChatLastTurnFailure | null,
  context: AgentChatSessionContextHealth | null,
): boolean {
  if (failure?.kind === "context_overflow") return true;
  if (!context?.compactionSeen) return false;
  if (context.occupancyPct == null) return false;
  if (context.occupancyPct < AGENT_CHAT_CONTEXT_ROTATION_PCT) return false;
  return context.aboveHighWaterTurns >= AGENT_CHAT_CONTEXT_ROTATION_TURNS;
}

/**
 * Do two failure records say the same thing?
 *
 * Field by field rather than by `JSON.stringify`, because both records are
 * rehydrated — one from persisted JSON, the other freshly built — and two
 * objects that agree on every field can still serialize differently when their
 * optional `turnId` is absent on one side and present-but-undefined on the
 * other, or when key order differs. A false "changed" here costs a disk write
 * on every settled turn of every chat.
 */
function sameLastTurnFailure(
  a: AgentChatLastTurnFailure | null,
  b: AgentChatLastTurnFailure | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind
    && a.message === b.message
    && a.at === b.at
    && (a.turnId ?? null) === (b.turnId ?? null);
}

/** Same reasoning as `sameLastTurnFailure`, for the occupancy record. */
function sameSessionContextHealth(
  a: AgentChatSessionContextHealth | null,
  b: AgentChatSessionContextHealth | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (a.occupancyPct ?? null) === (b.occupancyPct ?? null)
    && a.aboveHighWaterTurns === b.aboveHighWaterTurns
    && a.compactionSeen === b.compactionSeen
    && a.updatedAt === b.updatedAt;
}

export type SettledTurnHealthInput = {
  /** How the turn ended, as the `done` event reported it. */
  status: "completed" | "failed" | "interrupted";
  turnId?: string | null;
  /** Error text the turn streamed past, spent here. */
  errorText: string | null;
  /** The session preview, used as the failure message when nothing streamed. */
  previewText: string | null;
  /** Context occupancy this turn reported, or null when the provider said nothing. */
  occupancyPct: number | null;
  /** Has a compaction run on this thread, by the live runtime's account? */
  compactionSeen: boolean;
  previousFailure: AgentChatLastTurnFailure | null;
  previousContext: AgentChatSessionContextHealth | null;
  /** The instant to stamp, injected so a test does not race the clock. */
  now: string;
};

export type SettledTurnHealth = {
  failure: AgentChatLastTurnFailure | null;
  context: AgentChatSessionContextHealth | null;
  /** False when neither record moved, which is the caller's cue to skip the write. */
  changed: boolean;
};

/**
 * The next durable health record for a settled turn.
 *
 * A completed turn clears the failure, because a thread that just answered is
 * not over its limit. An INTERRUPTED turn says nothing about the thread's
 * health — the user stopped it — so the previous verdict stands untouched.
 */
export function nextSessionTurnHealth(input: SettledTurnHealthInput): SettledTurnHealth {
  let failure = input.previousFailure;
  if (input.status === "completed") {
    failure = null;
  } else if (input.status === "failed") {
    const message = input.errorText?.trim() || input.previewText?.trim() || "The turn failed.";
    const turnId = typeof input.turnId === "string" && input.turnId.trim().length ? input.turnId.trim() : null;
    failure = {
      kind: isContextOverflowFailureText(message) ? "context_overflow" : "error",
      message,
      at: input.now,
      ...(turnId ? { turnId } : {}),
    };
  }

  let context = input.previousContext;
  if (input.occupancyPct != null) {
    const above = input.occupancyPct >= AGENT_CHAT_CONTEXT_ROTATION_PCT;
    context = {
      occupancyPct: input.occupancyPct,
      aboveHighWaterTurns: above ? (input.previousContext?.aboveHighWaterTurns ?? 0) + 1 : 0,
      compactionSeen: input.compactionSeen || input.previousContext?.compactionSeen === true,
      updatedAt: input.now,
    };
  }

  return {
    failure,
    context,
    changed: !sameLastTurnFailure(failure, input.previousFailure)
      || !sameSessionContextHealth(context, input.previousContext),
  };
}
