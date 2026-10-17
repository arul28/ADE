import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClaudePromptCache } from "../../../shared/claudePromptCache";
import { compactFirstEligibleAtMs, lastFinishedTurnMs } from "../../../shared/compactFirst";
import { contextCompactMergeKey } from "../../../shared/contextCompaction";
import type { AgentChatEventEnvelope } from "../../../shared/types";

/** `dismissed` hides the offer until the next turn ends; the send then keeps the full history. */
export type CompactFirstChoice = { sessionId: string; value: boolean; dismissed?: boolean };

/**
 * State behind the "Compact first" chip for the selected chat.
 *
 * `idleWindowOpen` turns true once the chat's prompt cache has expired
 * (`compactFirstEligibleAtMs`: its lifetime, or an hour when unknown). The
 * user's choice covers one send: it is kept per chat with the turn end it was
 * made after, so a new turn end drops it and a visit to another chat does not.
 * `sendRef` carries what the chip shows into the send path, which is defined
 * before the chip is computed.
 */
export function useCompactFirst(
  events: readonly AgentChatEventEnvelope[],
  sessionId: string | null,
  cache?: ClaudePromptCache | null,
  provider?: string | null,
  model?: string | null,
  idleMs?: number | null,
) {
  const [now, setNow] = useState(Date.now());
  const [choices, setChoices] = useState<ReadonlyMap<string, CompactFirstChoice & { turnEndedAt: number | null }>>(new Map());
  const sendRef = useRef<CompactFirstChoice | null>(null);
  const { endedAtMs: lastTurnEndedAt, startedAtMs: lastTurnStartedAt } = useMemo(() => lastFinishedTurnMs(events), [events]);
  const cacheTtl = cache?.ttl;
  const cacheSince = cache?.since;
  const eligibleAt = useMemo(
    () => compactFirstEligibleAtMs(
      { provider: provider ?? "claude", model, cache: cacheTtl ? { ttl: cacheTtl, since: cacheSince } : null, idleMs },
      lastTurnEndedAt,
      lastTurnStartedAt,
    ),
    [provider, model, cacheTtl, cacheSince, idleMs, lastTurnEndedAt, lastTurnStartedAt],
  );
  useEffect(() => {
    if (eligibleAt == null) return;
    const wait = eligibleAt - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [eligibleAt]);
  const idleWindowOpen = eligibleAt != null && now >= eligibleAt;
  const stored = sessionId ? choices.get(sessionId) : undefined;
  const choice: CompactFirstChoice | null = stored && stored.turnEndedAt === lastTurnEndedAt ? stored : null;
  const setChoice = useCallback((next: CompactFirstChoice) => {
    setChoices((current) => new Map(current).set(next.sessionId, { ...next, turnEndedAt: lastTurnEndedAt }));
  }, [lastTurnEndedAt]);
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
