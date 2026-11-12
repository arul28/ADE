import type {
  AgentChatApprovalDecision,
  AgentChatRespondToInputArgs,
  PendingInputRequest,
} from "../../../shared/types";

/**
 * ADE's own cards for a tracked agent CLI.
 *
 * A chat holds a card (ask, secret, connect, MCP server) in its transcript. A
 * CLI has none, so before this an `ade secrets request` or `ade mcp servers
 * add` run from a Claude Code or Codex terminal failed with "not an agent chat
 * session". The card is held here instead, keyed by the CLI's session: its
 * Work surface lists it (`chat.listPendingInputs`) and answers it
 * (`chat.respondToInput`), and the `ade` command that raised it, still waiting
 * in the CLI's terminal, gets the answer as its result. Cards are in memory,
 * like a chat's local cards: a restart cancels them, and the waiting command
 * reports that.
 */

export type CliCardAnswer = {
  decision: string;
  answers: Record<string, string[]>;
  responseText: string | null;
  timedOut?: boolean;
};

type CliCardResponse = {
  decision?: AgentChatApprovalDecision | "cancel" | "none";
  answers?: Record<string, string | string[]>;
  responseText?: string | null;
};

type CliCardEntry = {
  request: PendingInputRequest;
  resolve: (response: CliCardResponse) => void;
  beforeAccept?: (answers: Record<string, string[]>) => void | Promise<void>;
  normalizeAnswers: (answers: Record<string, string | string[]> | undefined, responseText: string | null | undefined) => Record<string, string[]>;
  accepting: boolean;
};

export type CliCardInputsDeps = {
  /** Raise the row's hand while a card is open, so the Work list says "Needs you". */
  raiseAttention: (sessionId: string, message: string) => void;
  /** Lower it once the last card closes. */
  clearAttention: (sessionId: string) => void;
  /** Tell clients the session changed, so its surface re-reads its cards. */
  notifyChanged: (sessionId: string) => void;
};

const ACCEPTING_DECISIONS: ReadonlySet<string> = new Set(["accept", "accept_for_session"]);

export function createCliCardInputs(deps: CliCardInputsDeps) {
  const bySession = new Map<string, Map<string, CliCardEntry>>();

  const remove = (sessionId: string, itemId: string): CliCardEntry | null => {
    const cards = bySession.get(sessionId);
    const entry = cards?.get(itemId) ?? null;
    if (!cards || !entry) return null;
    cards.delete(itemId);
    if (cards.size === 0) {
      bySession.delete(sessionId);
      deps.clearAttention(sessionId);
    }
    deps.notifyChanged(sessionId);
    return entry;
  };

  const ask = (
    sessionId: string,
    request: PendingInputRequest,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      beforeAccept?: CliCardEntry["beforeAccept"];
      normalizeAnswers: CliCardEntry["normalizeAnswers"];
    },
  ): Promise<CliCardAnswer> => {
    let timedOut = false;
    let expiry: ReturnType<typeof setTimeout> | null = null;
    const itemId = request.itemId ?? request.requestId;
    return new Promise<CliCardResponse>((resolve) => {
      if (options.signal?.aborted) {
        resolve({ decision: "cancel" });
        return;
      }
      const entry: CliCardEntry = {
        request,
        resolve,
        ...(options.beforeAccept ? { beforeAccept: options.beforeAccept } : {}),
        normalizeAnswers: options.normalizeAnswers,
        accepting: false,
      };
      const cards = bySession.get(sessionId) ?? new Map<string, CliCardEntry>();
      cards.set(itemId, entry);
      bySession.set(sessionId, cards);
      deps.raiseAttention(sessionId, request.title?.trim() || request.description?.trim() || "An agent is waiting on you.");
      deps.notifyChanged(sessionId);
      options.signal?.addEventListener("abort", () => {
        remove(sessionId, itemId)?.resolve({ decision: "cancel" });
      }, { once: true });
      if (options.timeoutMs && options.timeoutMs > 0) {
        const expire = () => {
          const current = bySession.get(sessionId)?.get(itemId);
          if (current !== entry) return;
          // An answer still saving finishes first: a saved key is never "timed out".
          if (current.accepting) {
            expiry = setTimeout(expire, 1_000);
            expiry.unref?.();
            return;
          }
          timedOut = true;
          remove(sessionId, itemId)?.resolve({ decision: "cancel" });
        };
        expiry = setTimeout(expire, options.timeoutMs);
        expiry.unref?.();
      }
    }).then((response) => {
      if (expiry) clearTimeout(expiry);
      return {
        decision: response.decision ?? "none",
        answers: options.normalizeAnswers(response.answers, response.responseText),
        responseText: typeof response.responseText === "string" ? response.responseText : null,
        ...(timedOut ? { timedOut: true } : {}),
      };
    });
  };

  /** The open cards of one CLI session, oldest first. */
  const list = (sessionId: string): PendingInputRequest[] =>
    [...(bySession.get(sessionId.trim())?.values() ?? [])].map((entry) => entry.request);

  /**
   * Answer a card. False when the item is not one of these cards (the CLI's
   * own prompt, say), so the caller can try its other answer path.
   * A `beforeAccept` that throws keeps the card open and rethrows.
   */
  const respond = async (args: AgentChatRespondToInputArgs): Promise<boolean> => {
    const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
    const itemId = typeof args?.itemId === "string" ? args.itemId.trim() : "";
    const entry = bySession.get(sessionId)?.get(itemId);
    if (!entry) return false;
    if (entry.accepting) throw new Error("An answer is already being saved.");
    const decision = args.decision ?? "accept";
    if (ACCEPTING_DECISIONS.has(decision) && entry.beforeAccept) {
      entry.accepting = true;
      try {
        await entry.beforeAccept(entry.normalizeAnswers(args.answers, args.responseText));
      } catch (error) {
        entry.accepting = false;
        throw error;
      }
    }
    remove(sessionId, itemId)?.resolve({
      decision,
      ...(args.answers ? { answers: args.answers } : {}),
      responseText: args.responseText ?? null,
    });
    return true;
  };

  /** Cancel every card of a session (it ended), or of every session (shutdown). */
  const cancelAll = (sessionId?: string): void => {
    const ids = sessionId ? [sessionId.trim()] : [...bySession.keys()];
    for (const id of ids) {
      for (const itemId of [...(bySession.get(id)?.keys() ?? [])]) {
        remove(id, itemId)?.resolve({ decision: "cancel" });
      }
    }
  };

  return { ask, list, respond, cancelAll, has: (sessionId: string) => bySession.has(sessionId.trim()) };
}
