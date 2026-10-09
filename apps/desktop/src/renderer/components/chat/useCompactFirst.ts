import { useEffect, useMemo, useRef, useState } from "react";
import { COMPACT_FIRST_IDLE_MS } from "../../../shared/compactFirst";
import { contextCompactMergeKey } from "../../../shared/contextCompaction";
import type { AgentChatEventEnvelope } from "../../../shared/types";

export type CompactFirstChoice = { sessionId: string; value: boolean };

/**
 * State behind the "Compact first" pill for the selected chat.
 *
 * `idleWindowOpen` turns true once the last turn ended an hour ago, when the
 * prompt cache has expired. The user's pill choice covers one send: a new turn
 * end or a switch to another chat clears it. `sendRef` carries what the pill
 * shows into the send path, which is defined before the pill is computed.
 */
export function useCompactFirst(events: readonly AgentChatEventEnvelope[], sessionId: string | null) {
  const [now, setNow] = useState(Date.now());
  const [choice, setChoice] = useState<CompactFirstChoice | null>(null);
  const sendRef = useRef<CompactFirstChoice | null>(null);
  // Walks back only to the last `done`, so streaming deltas stay cheap.
  const lastTurnEndedAt = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const entry = events[index];
      if (entry?.event.type === "done") return Date.parse(entry.timestamp);
    }
    return null;
  }, [events]);
  useEffect(() => {
    setChoice(null);
  }, [sessionId, lastTurnEndedAt]);
  useEffect(() => {
    if (lastTurnEndedAt == null || !Number.isFinite(lastTurnEndedAt)) return;
    const wait = lastTurnEndedAt + COMPACT_FIRST_IDLE_MS - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [lastTurnEndedAt]);
  const idleWindowOpen = lastTurnEndedAt != null && now >= lastTurnEndedAt + COMPACT_FIRST_IDLE_MS;
  return { now, idleWindowOpen, choice, setChoice, sendRef };
}

/** Merge key (`contextCompactMergeKey`) of the chat's latest compaction, or null when it has none. */
export function latestCompactionKeyOf(events: readonly AgentChatEventEnvelope[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === "context_compact" || event?.type === "codex_context_compaction") {
      return contextCompactMergeKey(event);
    }
  }
  return null;
}
