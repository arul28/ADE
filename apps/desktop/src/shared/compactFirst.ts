import type { AgentChatEventEnvelope } from "./types/chat";

export const COMPACT_FIRST_IDLE_MS = 60 * 60_000;
export type CompactFirstOffer = { contextTokens: number; estimatedPostTokens: number; eligibleAt: number };

/** Only measured occupancy is eligible; cumulative turn totals are never used. */
export function compactFirstOffer({ provider, events, contextTokens, mode = "ask", now = Date.now() }: {
  provider: string;
  events: readonly AgentChatEventEnvelope[];
  contextTokens?: number | null;
  mode?: "ask" | "always" | "never";
  now?: number;
}): CompactFirstOffer | null {
  if (provider !== "claude" || mode === "never") return null;
  let endedAt: number | null = null;
  let measured = contextTokens;
  let lastPost: number | null = null;
  for (const { event, timestamp } of events) {
    if (event.type === "status" && event.turnStatus === "started") endedAt = null;
    if (event.type === "done") {
      endedAt = Date.parse(timestamp);
      if (contextTokens == null && event.usage?.contextTokens != null) measured = event.usage.contextTokens;
    }
    if (contextTokens == null && event.type === "context_usage" && (!event.state || event.state === "measured")) measured = event.usage.totalTokens;
    if (event.type === "context_compact" && event.state !== "started" && event.state !== "failed" && event.postTokens != null) {
      lastPost = event.postTokens;
      if (contextTokens == null) measured = lastPost;
    }
  }
  if (measured == null || !Number.isFinite(measured) || measured < 100_000 || endedAt == null || !Number.isFinite(endedAt)) return null;
  const eligibleAt = endedAt + COMPACT_FIRST_IDLE_MS;
  if (now < eligibleAt) return null;
  return { contextTokens: measured, estimatedPostTokens: lastPost ?? Math.round(measured * 0.02), eligibleAt };
}
