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
import type { JevService } from "../jev/jevService";
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
/** Jev's yes/no bars; an answer between them is no answer and falls through. */
const JEV_ASKS_YES = 0.8;
const JEV_ASKS_NO = 0.2;
const JEV_WAITING_YES = 0.8;

/**
 * The one Jev request per checked turn end: does the reply ask the user, and
 * does it say the agent waits on its own work. Measured on free Jev: optional
 * offers 0.06–0.11, "Which do you prefer?" 0.95, CI/subagent progress notes
 * 0.03 asks and 0.96–0.97 waiting.
 */
const TURN_END_JEV_QUESTIONS = {
  asksUser: {
    type: "noul",
    instructions: "Does the end of the agent's reply ask the user to answer, choose, approve, or decide something the agent must wait for before it can continue? An optional offer the user can ignore (\"let me know if you want X\", \"I can also...\", \"say the word if you would rather...\") is not an ask. A progress update (work is running, the agent will report back) is not an ask.",
  },
  waitingOnOwnWork: {
    type: "noul",
    instructions: "Does the end of the agent's reply say the agent is now waiting on work it started itself (subagents, background jobs, CI, a build, a watcher) and will continue or report back when that finishes, rather than being finished or waiting on the user?",
  },
} as const;

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
  /** Chats this one started (nested or `--no-parent`) that are still busy; absent is none. */
  liveChildCount?: number;
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
  /** Clear only an inferred marker older than this committed turn start. */
  clearInferredAttention: (sessionId: string, startedAt: string) => void;
  /** The shared Jev helper; absent where the host has none, which keeps today's path. */
  decide?: JevService["decide"] | null;
  /**
   * Record (an ISO time) or clear (null) that the chat's last reply waits on
   * its own work, which the Work fold reads as Waiting while that work runs.
   */
  setAwaitingOwnWork?: (sessionId: string, at: string | null) => void;
};

export type TurnEndQuestionCheck = {
  /** Every live chat event, so the check can keep the turn's last reply verbatim. */
  onEvent: (sessionId: string, event: AgentChatEvent, turnStartedAt?: string | null) => void;
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
 * clear asks at once, clear progress notes never, the rest by Jev for any
 * provider, then by a cheap model when the provider has one and Jev gave no
 * clear answer. Once per turn and live only (replay never reaches here); the
 * raised hand is what persists.
 *
 * The same Jev request also asks whether the reply says the agent waits on
 * its own work. A turn that ends with live background work or live child
 * chats and says so is marked `awaitingOwnWorkAt`, which the Work fold reads
 * as Waiting rather than Done while that work still runs.
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

  const raise = (sessionId: string, turnId: string, question: string, decidedBy: "rules" | "jev" | "model"): void => {
    const raised = deps.requestAttention({ sessionId, message: question, source: "turn_end_question" });
    logger.info("agent_chat.turn_end_question_raised", { sessionId, turnId, decidedBy, raised });
  };

  /** Jev's reading of the reply, or null when Jev is absent, failed, or unsure of both. */
  const askJev = async (
    facts: TurnEndQuestionFacts,
    replyText: string,
  ): Promise<{ asksUser: boolean | null; waitingOnOwnWork: boolean } | null> => {
    if (!deps.decide) return null;
    const answers = await deps.decide({
      feature: "turn_end",
      state: buildTurnEndAskPrompt({ userMessage: facts.lastUserMessage, replyText }),
      questions: TURN_END_JEV_QUESTIONS,
      priority: "background",
    });
    if (!answers) return null;
    const asks = answers.asksUser.noul;
    return {
      asksUser: asks >= JEV_ASKS_YES ? true : asks <= JEV_ASKS_NO ? false : null,
      waitingOnOwnWork: answers.waitingOnOwnWork.noul >= JEV_WAITING_YES,
    };
  };

  const runCheapModel = async (args: {
    facts: TurnEndQuestionFacts;
    turnId: string;
    provider: AdeBackgroundUtilityProvider;
    replyText: string;
  }): Promise<boolean | null> => {
    const { facts, turnId, provider } = args;
    const { sessionId } = facts;
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
      return parseTurnEndAskDecision(result.structuredOutput, result.text);
    } catch (error) {
      // Fail quiet: an unanswered tiebreak never raises a hand.
      logger.warn("agent_chat.turn_end_question_tiebreak_failed", {
        sessionId,
        turnId,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
    }
  };

  /**
   * Jev first, for any provider. When it gives no clear ask answer on an
   * unsure ending, exactly today's path: the provider's cheap model, if any.
   * `unsure` false means the rules already said "not an ask"; Jev is then
   * asked only whether the agent waits on its own work.
   */
  const runTiebreak = async (args: {
    facts: TurnEndQuestionFacts;
    turnId: string;
    provider: AdeBackgroundUtilityProvider | null;
    replyText: string;
    unsure: boolean;
  }): Promise<void> => {
    const { facts, turnId, provider } = args;
    const { sessionId } = facts;
    const startedAt = Date.now();
    const jev = await askJev(facts, args.replyText);
    let asksUser: boolean | null = args.unsure ? jev?.asksUser ?? null : false;
    let decidedBy: "jev" | "model" = "jev";
    if (asksUser === null && provider) {
      decidedBy = "model";
      asksUser = await runCheapModel({ facts, turnId, provider, replyText: args.replyText });
    }
    // The hand may still go up only if nothing happened since the turn ended:
    // same live chat, no user message or new turn (either clears the pending
    // entry), no approval card, and no hand raised in the meantime.
    const stillOpen = pendingTurnBySession.get(sessionId) === turnId
      && facts.isStillCurrent()
      && handCanRise(deps.readHandState(sessionId));
    if (pendingTurnBySession.get(sessionId) === turnId) pendingTurnBySession.delete(sessionId);
    const awaitingOwnWork = stillOpen && asksUser !== true && jev?.waitingOnOwnWork === true;
    logger.info("agent_chat.turn_end_question_tiebreak", {
      sessionId,
      turnId,
      provider,
      jev: jev ? (jev.asksUser === null ? "unsure" : jev.asksUser ? "ask" : "not_ask") : "no_answer",
      decidedBy,
      asksUser,
      awaitingOwnWork,
      stillOpen,
      durationMs: Date.now() - startedAt,
    });
    // As with the rules, the hand is only for a reply hidden under Working.
    if (asksUser === true && stillOpen && facts.backgroundWorkCount > 0) {
      raise(sessionId, turnId, turnEndQuestionText(args.replyText), decidedBy);
    } else if (awaitingOwnWork) {
      deps.setAwaitingOwnWork?.(sessionId, new Date().toISOString());
    }
  };

  return {
    onEvent(sessionId, event, turnStartedAt) {
      if (event.type === "status" && event.turnStatus === "started") {
        pendingTurnBySession.delete(sessionId);
        lastReplyBySession.delete(sessionId);
        deps.setAwaitingOwnWork?.(sessionId, null);
        const startedAt = turnStartedAt?.trim();
        if (startedAt) {
          // The persisted source + timestamp fence makes duplicate and stale
          // status events harmless without retaining per-session start state.
          deps.clearInferredAttention(sessionId, startedAt);
        }
        return;
      }
      if (event.type === "user_message") {
        pendingTurnBySession.delete(sessionId);
        lastReplyBySession.delete(sessionId);
        deps.setAwaitingOwnWork?.(sessionId, null);
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
      const hasBackgroundWork = facts.backgroundWorkCount > 0;
      if (facts.isSubagentWithParent || (!hasBackgroundWork && (facts.liveChildCount ?? 0) <= 0)) return;
      if (!handCanRise(deps.readHandState(sessionId))) return;
      if (!reply || (reply.turnId && reply.turnId !== turnId)) return;

      const classification = classifyTurnEndAsk(reply.text);
      if (classification.verdict === "ask") {
        // With only child chats running, the row already reads Done and shows
        // the question; the hand is for a reply hidden under Working.
        if (hasBackgroundWork) raise(sessionId, turnId, classification.question, "rules");
        return;
      }
      // Background work already reads Working, so a clear progress note adds nothing.
      if (classification.verdict === "not_ask" && hasBackgroundWork) return;
      // The cheap model keeps today's scope: unsure endings of background-work turns.
      const provider = hasBackgroundWork ? adeBackgroundUtilityProvider(facts.provider) : null;
      if (!deps.decide && !provider) return;
      pendingTurnBySession.set(sessionId, turnId);
      void runTiebreak({ facts, turnId, provider, replyText: reply.text, unsure: classification.verdict === "unsure" });
    },

    forget(sessionId) {
      lastReplyBySession.delete(sessionId);
      pendingTurnBySession.delete(sessionId);
      deps.setAwaitingOwnWork?.(sessionId, null);
    },
  };
}
