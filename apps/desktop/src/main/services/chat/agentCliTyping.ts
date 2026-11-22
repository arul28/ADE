import { AdeExpectedError } from "../../../shared/expectedError";
import { agentCliReadsFreePrompt } from "../../../shared/cliLaunch";
import type { AgentChatMessageSessionArgs, AgentCliTypeArgs, AgentCliTypeResult } from "../../../shared/types";
import { providerFromTool } from "../../utils/terminalSessionSignals";
import { isExactCliTurnSource } from "../pty/cliTurnSignals";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "../sessions/sessionService";
import { isQueuedCliTextWaiter, type ChatWaitRegistry } from "./chatWaitRegistry";

/**
 * Text a person sends to a running agent CLI from an ADE box (Work, phone,
 * web).
 *
 * It is typed through the wake path (`agentCliWakes.ts`), so it never lands
 * mid-turn and never shares a turn with a wake. A text that has to wait
 * (`holdUntilFree` from a phone or the web) joins the same durable queue
 * `ade chat send` uses for a busy CLI (a send wait on the CLI itself), so
 * every queued text for a CLI is typed in the order it was sent and survives
 * a brain restart.
 */

/** How long a typed or queued answer is kept for a resend with the same id. */
const TYPE_ANSWER_TTL_MS = 10 * 60_000;
/**
 * How long a text waits for a CLI that did not report a turn running to
 * show a free prompt before it is queued. A prompt that is only redrawing
 * (a resize, a focus change, output buffered through a stalled runtime) is
 * free again within a second; queueing then said "Queued" for an idle CLI
 * and typed the text only at the queue's next check.
 */
const SETTLE_WAIT_MS = 2_000;
const SETTLE_POLL_MS = 150;

type PtyService = ReturnType<typeof createPtyService>;

export type AgentCliTypingDeps = {
  sessionService: Pick<ReturnType<typeof createSessionService>, "get">;
  ptyService: Partial<Pick<PtyService, "hasLivePty" | "getTrackedCliTurn" | "typeLineIntoAgentCli">> | null;
  /** Read at call time: the registry starts after this module. */
  getChatWaits: () => ChatWaitRegistry | null;
  isTrackedAgentCliSession: (sessionId: string) => boolean;
  /** `@model:` / `@chat:` / `@lane:` … tokens get the facts block a chat send appends. */
  expandMentions: (args: { sessionId: string; text: string }) => Promise<{ text: string }>;
  deliverWakeToSession: (args: AgentChatMessageSessionArgs) => Promise<"delivered" | "deferred">;
  agentCliTypingDeferred: (sessionId: string) => boolean;
  isDisposed: () => boolean;
};

export function createAgentCliTyping(deps: AgentCliTypingDeps) {
  const { sessionService, ptyService } = deps;

  const processEnded = (sessionId: string): boolean =>
    typeof ptyService?.hasLivePty === "function" && !ptyService.hasLivePty(sessionId);

  /** The CLI said itself (Claude's hooks, Codex's OSC 7501) that its turn runs or waits on the person. */
  const reportedMidTurn = (sessionId: string): boolean => {
    const turn = ptyService?.getTrackedCliTurn?.(sessionId) ?? null;
    return turn != null && isExactCliTurnSource(turn.source) && turn.phase !== "idle";
  };

  const queuedSendWaits = async (sessionId: string) => {
    const chatWaits = deps.getChatWaits();
    if (!chatWaits) return [];
    return (await chatWaits.list({ sessionId })).filter((waiter) =>
      isQueuedCliTextWaiter(waiter) && waiter.action.sessionId === sessionId);
  };

  /** Texts that go before a new one: in the queue, or out of it and being typed now. */
  const hasQueuedSends = async (sessionId: string): Promise<boolean> =>
    deps.getChatWaits()?.hasCliTextsInFlight(sessionId) === true
    || (await queuedSendWaits(sessionId)).length > 0;

  const armQueuedSend = async (args: { sessionId: string; text: string; metadata?: Record<string, unknown> | null }) => {
    const chatWaits = deps.getChatWaits();
    if (!chatWaits) throw new Error("Queued sends are not available yet; try again in a moment.");
    // A wait on the CLI itself: it types the text at the CLI's next free
    // prompt, survives a brain restart, and gives up after a day.
    return await chatWaits.arm({
      targetSessionIds: [args.sessionId],
      mode: "all",
      waitFor: "idle",
      sendToSessionId: args.sessionId,
      text: args.text,
      ...(args.metadata ? { sendMetadata: args.metadata } : {}),
    });
  };

  /**
   * `when: "now"`, from older desktops' terminal local line. Typed into the
   * CLI's input at once, as the person's own keys would be, then Enter; no
   * wait for a free prompt, no clear keys, no `@` expansion. Any agent CLI
   * terminal takes it, tracked or not, like keys typed there.
   */
  const typeLineNow = async (sessionId: string, text: string, inputOrigin: unknown): Promise<AgentCliTypeResult> => {
    const row = sessionService.get(sessionId);
    // A plain terminal is not a chat: the line would run in its shell.
    if (row && row.toolType === "shell") {
      throw new AdeExpectedError(`Session '${sessionId}' is not an agent CLI session.`, "user");
    }
    if (row?.archivedAt) throw new AdeExpectedError("This CLI session is archived.", "user");
    if (typeof ptyService?.typeLineIntoAgentCli !== "function") {
      throw new AdeExpectedError("Typing a line into a CLI session is not available in this runtime.", "user");
    }
    const typed = await ptyService.typeLineIntoAgentCli({ sessionId, text, inputOrigin });
    return { outcome: typed ? "delivered" : "ended" };
  };

  const typeOrQueue = async (sessionId: string, text: string, holdUntilFree: boolean): Promise<AgentCliTypeResult> => {
    if (processEnded(sessionId)) return { outcome: "ended" };
    // The chat's own expansion step logs a failed lookup, sends the text as
    // typed, and records the same usage event.
    const typedText = (await deps.expandMentions({ sessionId, text })).text;
    // A CLI whose free prompt ADE cannot read takes the text at once
    // (`canTakeTypedMessage`); the person is told it did not wait.
    const row = sessionService.get(sessionId);
    const delivered: AgentCliTypeResult = agentCliReadsFreePrompt(row?.resumeMetadata?.provider ?? providerFromTool(row?.toolType))
      ? { outcome: "delivered" }
      : { outcome: "delivered", typedAtOnce: true };
    const deliver = async () =>
      await deps.deliverWakeToSession({ sessionId, text: typedText, kind: "auto" }) === "delivered";
    // Queued texts go first: a later send must not jump the line, also while
    // it waits for the prompt to settle. Arming checks the queue at once, so
    // a CLI that is free now still takes them.
    if (!(await hasQueuedSends(sessionId))) {
      if (await deliver()) return delivered;
      const settleBy = Date.now() + SETTLE_WAIT_MS;
      while (Date.now() < settleBy && !deps.isDisposed() && !reportedMidTurn(sessionId)) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, SETTLE_POLL_MS).unref?.();
        });
        if (processEnded(sessionId)) return { outcome: "ended" };
        if (deps.agentCliTypingDeferred(sessionId)) continue;
        if (await hasQueuedSends(sessionId)) break;
        if (await deliver()) return delivered;
      }
    }
    if (holdUntilFree) {
      await armQueuedSend({ sessionId, text: typedText });
      return { outcome: "held" };
    }
    return { outcome: "deferred" };
  };

  // One text per CLI at a time, in the order they came: a later send must
  // not be typed while an earlier one is still waiting for the prompt to
  // settle, nor be queued ahead of it.
  const flights = new Map<string, Promise<AgentCliTypeResult>>();

  const typeNow = async (args: AgentCliTypeArgs): Promise<AgentCliTypeResult> => {
    const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
    const text = typeof args?.text === "string" ? args.text : "";
    if (!sessionId) throw new AdeExpectedError("A session id is required.", "user");
    if (!text.trim()) throw new AdeExpectedError("There is no text to send.", "user");
    if (args.when === "now") return await typeLineNow(sessionId, text, args.inputOrigin);
    if (!deps.isTrackedAgentCliSession(sessionId)) {
      throw new AdeExpectedError(`Session '${sessionId}' is not an agent CLI session.`, "user");
    }
    if (sessionService.get(sessionId)?.archivedAt) {
      throw new AdeExpectedError("This CLI session is archived.", "user");
    }
    const flight = (flights.get(sessionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => typeOrQueue(sessionId, text, args.holdUntilFree === true));
    flights.set(sessionId, flight);
    try {
      return await flight;
    } finally {
      if (flights.get(sessionId) === flight) flights.delete(sessionId);
    }
  };

  /**
   * Answers by session and the caller's message id, so one text sent by two
   * windows, or sent again after a dropped link, is typed once. A call in
   * flight is shared; a typed or queued answer is kept for a while.
   */
  const answers = new Map<string, { at: number; answer: Promise<AgentCliTypeResult> }>();

  const typeIntoAgentCliWhenFree = async (args: AgentCliTypeArgs): Promise<AgentCliTypeResult> => {
    const clientMessageId = typeof args?.clientMessageId === "string" ? args.clientMessageId.trim() : "";
    if (!clientMessageId) return await typeNow(args);
    const key = `${typeof args?.sessionId === "string" ? args.sessionId.trim() : ""}:${clientMessageId}`;
    const now = Date.now();
    for (const [entryKey, entry] of answers) {
      if (now - entry.at > TYPE_ANSWER_TTL_MS) answers.delete(entryKey);
    }
    const known = answers.get(key);
    if (known) return await known.answer;
    const answer = typeNow(args);
    answers.set(key, { at: now, answer });
    try {
      const result = await answer;
      // Only a typed or queued text is final; busy, ended or a failure may be sent again.
      if (result.outcome !== "delivered" && result.outcome !== "held") answers.delete(key);
      return result;
    } catch (error) {
      answers.delete(key);
      throw error;
    }
  };

  return { typeIntoAgentCliWhenFree, queuedSendWaits, hasQueuedSends, armQueuedSend };
}
