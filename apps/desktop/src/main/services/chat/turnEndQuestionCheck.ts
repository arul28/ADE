import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adeBackgroundUtilityProvider,
  backgroundUtilityModelId,
  type AdeBackgroundUtilityProvider,
} from "../../../shared/backgroundUtilityModel";
import type { AgentChatEvent } from "../../../shared/types/chat";
import type { SessionAttentionSource } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import {
  buildTurnEndAskPrompt,
  classifyTurnEndAsk,
  parseTurnEndAskDecision,
  TURN_END_ASK_JSON_SCHEMA,
  TURN_END_ASK_SYSTEM_PROMPT,
  turnEndQuestionText,
} from "./turnEndAsk";

/** How long the cheap model gets to break a tie before ADE gives up quietly. */
const TIEBREAK_TIMEOUT_MS = 8_000;
/** `sessionId:turnId` pairs remembered as checked, oldest dropped first. */
const MAX_CHECKED_TURNS = 1_024;

/** What can hold the hand down: an open approval card, or a hand already up. */
export type TurnEndHandState = {
  hasPendingInput: boolean;
  attentionRequestedAt: string | null | undefined;
};

/** What the chat service knows about a turn when its `done` arrives. */
export type TurnEndQuestionFacts = {
  sessionId: string;
  turnId: string | null | undefined;
  completed: boolean;
  /** A subagent's questions are for the agent that spawned it. */
  isSubagentWithParent: boolean;
  backgroundWorkCount: number;
  /** The session's provider; only those with a cheap model get a tiebreak. */
  provider: string | null | undefined;
  lastUserMessage: string | null;
  /** False once the chat is deleted or replaced by another managed session. */
  isStillCurrent: () => boolean;
};

export type TurnEndQuestionCheckDeps = {
  logger: Logger;
  /** Read per call: the hand may have gone up, or a card opened, meanwhile. */
  readHandState: (sessionId: string) => TurnEndHandState;
  runPrompt: (args: {
    /** The chat whose turn ended; the call runs as that chat's account. */
    sessionId: string;
    cwd: string;
    modelId: string;
    systemPrompt: string;
    prompt: string;
    jsonSchema: unknown;
    timeoutMs: number;
  }) => Promise<{ structuredOutput?: unknown; text?: string | null }>;
  requestAttention: (args: {
    sessionId: string;
    message: string;
    source: SessionAttentionSource;
  }) => boolean;
};

export type TurnEndQuestionCheck = {
  /** Every live chat event, so the check can keep the turn's last reply verbatim. */
  onEvent: (sessionId: string, event: AgentChatEvent) => void;
  onTurnDone: (facts: TurnEndQuestionFacts) => void;
  forget: (sessionId: string) => void;
};

function handCanRise(hand: TurnEndHandState): boolean {
  return !hand.hasPendingInput && !hand.attentionRequestedAt;
}

/**
 * A turn that ends while the chat still owns live background work reads as
 * Working, so a question in its reply is invisible unless the agent called
 * `ade chat ask`. This reads the reply's ending and raises the hand for it:
 * clear asks at once, clear progress notes never, the rest by a cheap model
 * when the provider has one. Once per turn and live only (replay never
 * reaches here); the raised hand is what persists.
 */
export function createTurnEndQuestionCheck(deps: TurnEndQuestionCheckDeps): TurnEndQuestionCheck {
  const { logger } = deps;
  /**
   * The raw text of each chat's latest assistant message, deltas joined as
   * they arrived. Spaces and paragraph breaks matter to the classifier, so
   * nothing here is trimmed.
   */
  const lastReplyBySession = new Map<string, { key: string; turnId: string | null; text: string }>();
  /**
   * The turn whose ending question is still being judged by the cheap model,
   * per chat. Any user message or turn start removes it, so an answer that
   * arrives after the chat moved on finds nothing to apply to.
   */
  const pendingTurnBySession = new Map<string, string>();
  const checkedTurns = new Set<string>();

  const rememberChecked = (key: string): void => {
    checkedTurns.add(key);
    while (checkedTurns.size > MAX_CHECKED_TURNS) {
      const [oldest] = checkedTurns;
      if (oldest === undefined) break;
      checkedTurns.delete(oldest);
    }
  };

  const raise = (sessionId: string, turnId: string, question: string, decidedBy: "rules" | "model"): void => {
    const raised = deps.requestAttention({ sessionId, message: question, source: "turn_end_question" });
    logger.info("agent_chat.turn_end_question_raised", { sessionId, turnId, decidedBy, raised });
  };

  const runTiebreak = async (args: {
    facts: TurnEndQuestionFacts;
    turnId: string;
    provider: AdeBackgroundUtilityProvider;
    replyText: string;
  }): Promise<void> => {
    const { facts, turnId, provider } = args;
    const { sessionId } = facts;
    const startedAt = Date.now();
    let asksUser: boolean | null = null;
    let cwd: string | null = null;
    try {
      // A fresh scratch directory: the classifier must see no repo, no
      // CLAUDE.md or AGENTS.md, no hooks.
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ade-turn-end-ask-"));
      const result = await deps.runPrompt({
        sessionId,
        cwd,
        modelId: backgroundUtilityModelId(provider),
        systemPrompt: TURN_END_ASK_SYSTEM_PROMPT,
        prompt: buildTurnEndAskPrompt({ userMessage: facts.lastUserMessage, replyText: args.replyText }),
        jsonSchema: TURN_END_ASK_JSON_SCHEMA,
        timeoutMs: TIEBREAK_TIMEOUT_MS,
      });
      asksUser = parseTurnEndAskDecision(result.structuredOutput, result.text);
    } catch (error) {
      // Fail quiet: an unanswered tiebreak never raises a hand.
      logger.warn("agent_chat.turn_end_question_tiebreak_failed", {
        sessionId,
        turnId,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
    }
    // The hand may still go up only if nothing happened since the turn ended:
    // same live chat, no user message or new turn (either clears the pending
    // entry), no approval card, and no hand raised in the meantime.
    const stillOpen = pendingTurnBySession.get(sessionId) === turnId
      && facts.isStillCurrent()
      && handCanRise(deps.readHandState(sessionId));
    if (pendingTurnBySession.get(sessionId) === turnId) pendingTurnBySession.delete(sessionId);
    logger.info("agent_chat.turn_end_question_tiebreak", {
      sessionId,
      turnId,
      provider,
      asksUser,
      stillOpen,
      durationMs: Date.now() - startedAt,
    });
    if (asksUser === true && stillOpen) {
      raise(sessionId, turnId, turnEndQuestionText(args.replyText), "model");
    }
  };

  return {
    onEvent(sessionId, event) {
      if ((event.type === "status" && event.turnStatus === "started") || event.type === "user_message") {
        pendingTurnBySession.delete(sessionId);
        lastReplyBySession.delete(sessionId);
        return;
      }
      if (event.type !== "text") return;
      const turnId = event.turnId ?? null;
      const key = event.messageId ?? turnId ?? "";
      const current = lastReplyBySession.get(sessionId);
      if (current && current.key === key) {
        current.text += event.text;
      } else {
        lastReplyBySession.set(sessionId, { key, turnId, text: event.text });
      }
    },

    onTurnDone(facts) {
      const { sessionId } = facts;
      const reply = lastReplyBySession.get(sessionId);
      lastReplyBySession.delete(sessionId);
      const turnId = facts.turnId?.trim();
      if (!facts.completed || !turnId) return;
      const checkKey = `${sessionId}:${turnId}`;
      if (checkedTurns.has(checkKey)) return;
      rememberChecked(checkKey);
      if (facts.isSubagentWithParent || facts.backgroundWorkCount <= 0) return;
      if (!handCanRise(deps.readHandState(sessionId))) return;
      if (!reply || (reply.turnId && reply.turnId !== turnId)) return;

      const classification = classifyTurnEndAsk(reply.text);
      if (classification.verdict === "not_ask") return;
      if (classification.verdict === "ask") {
        raise(sessionId, turnId, classification.question, "rules");
        return;
      }
      const provider = adeBackgroundUtilityProvider(facts.provider);
      if (!provider) return;
      pendingTurnBySession.set(sessionId, turnId);
      void runTiebreak({ facts, turnId, provider, replyText: reply.text });
    },

    forget(sessionId) {
      lastReplyBySession.delete(sessionId);
      pendingTurnBySession.delete(sessionId);
    },
  };
}
