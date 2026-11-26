import type { CtoOpenWorkItem, CtoOpenWorkLink } from "../../../shared/types/cto";

/**
 * What an open-work item is linked to, and when that link says the work is
 * done. The memory service closes linked items with the outcome this returns.
 */

export function normalizeOpenWorkLink(value: unknown): CtoOpenWorkLink | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "pr") {
    const number = Number(record.number);
    return Number.isInteger(number) && number > 0 ? { kind: "pr", number } : null;
  }
  if (record.kind === "chat") {
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    if (!sessionId) return null;
    const machineId = typeof record.machineId === "string" ? record.machineId.trim() : "";
    return machineId ? { kind: "chat", sessionId, machineId } : { kind: "chat", sessionId };
  }
  return null;
}

/** What a linked item's chat or PR looks like right now, as far as this machine knows. */
export type CtoLinkedWorkResolver = {
  /** The PR's state on the repo ("open", "draft", "merged", "closed"), or null when unknown. */
  prState: (number: number) => string | null;
  /**
   * The chat as far as this machine can tell, or null when it cannot (a
   * machine it has not read): done (settled, archived or ended), when it last
   * came to rest after a clean turn, and its last status line. A chat's live
   * state comes from its runtime, so this may answer later.
   */
  chatState: (link: Extract<CtoOpenWorkLink, { kind: "chat" }>) =>
    | CtoLinkedChatState
    | null
    | Promise<CtoLinkedChatState | null>;
};

export type CtoLinkedChatState = { done: boolean; restedAt: string | null; statusLine: string | null };

/**
 * The outcome line for a linked item whose chat or PR has closed, or null
 * while it is still going. A chat counts as done when it ended, or when it
 * came to rest after the item was linked: a chat that was already resting
 * when the CTO linked it has not done that work yet.
 */
export async function linkedWorkOutcome(
  item: Pick<CtoOpenWorkItem, "link" | "createdAt">,
  resolver: CtoLinkedWorkResolver,
): Promise<string | null> {
  const link = item.link;
  if (!link) return null;
  if (link.kind === "pr") {
    const state = resolver.prState(link.number);
    // The row already shows the PR number beside the outcome.
    if (state === "merged") return "Merged";
    if (state === "closed") return "Closed without merging";
    return null;
  }
  const chat = await resolver.chatState(link);
  if (!chat) return null;
  const restedSince = chat.restedAt != null && Date.parse(chat.restedAt) > Date.parse(item.createdAt);
  if (!chat.done && !restedSince) return null;
  return chat.statusLine ? `Done: ${chat.statusLine}` : "Done";
}
