import fs from "node:fs";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { AgentChatEvent } from "../../../shared/types/chat";
import { BACKGROUND_UTILITY_CLAUDE_MODEL_ID } from "../../../shared/backgroundUtilityModel";
import { classifyTurnEndAsk, parseTurnEndAskDecision } from "./turnEndAsk";
import {
  createTurnEndQuestionCheck,
  type TurnEndHandState,
  type TurnEndQuestionFacts,
} from "./turnEndQuestionCheck";

const SESSION = "session-1";
const TURN = "turn-1";

const textEvent = (text: string, messageId = "m1", turnId = TURN): AgentChatEvent =>
  ({ type: "text", text, messageId, turnId }) as AgentChatEvent;
const userMessage = (): AgentChatEvent => ({ type: "user_message", text: "Use main." }) as AgentChatEvent;

type PromptResult = { structuredOutput?: unknown; text?: string | null };

/**
 * The check with its process-facing dependencies faked. `runPrompt` hands
 * back a promise the test settles; `tiebreakDone` resolves on the check's own
 * completion receipt (the tiebreak log line), so a test waits on that and not
 * on time.
 */
function harness(options: { hand?: Partial<TurnEndHandState> } = {}) {
  const hand: TurnEndHandState = { hasPendingInput: false, attentionRequestedAt: null, ...options.hand };
  let settlePrompt: { resolve: (value: PromptResult) => void; reject: (error: Error) => void } | null = null;
  let resolveTiebreakDone: () => void = () => {};
  const tiebreakDone = new Promise<void>((resolve) => { resolveTiebreakDone = resolve; });
  const runPrompt = vi.fn((_args: { cwd: string; modelId: string }) =>
    new Promise<PromptResult>((resolve, reject) => { settlePrompt = { resolve, reject }; }));
  const requestAttention = vi.fn((_args: { sessionId: string; message: string; source: string }) => true);
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn((event: string) => {
      if (event === "agent_chat.turn_end_question_tiebreak") resolveTiebreakDone();
    }),
  } as never;
  const check = createTurnEndQuestionCheck({
    logger,
    readHandState: () => hand,
    runPrompt,
    requestAttention,
  });
  const facts = (overrides: Partial<TurnEndQuestionFacts> = {}): TurnEndQuestionFacts => ({
    sessionId: SESSION,
    turnId: TURN,
    completed: true,
    isSubagentWithParent: false,
    backgroundWorkCount: 2,
    provider: "claude",
    lastUserMessage: "Ship the fix.",
    isStillCurrent: () => true,
    ...overrides,
  });
  /** Streams `reply` as one message of `replyTurnId`, then reports the turn's `done`. */
  const finishTurn = (
    reply: string,
    overrides: Partial<TurnEndQuestionFacts> = {},
    replyTurnId = overrides.turnId ?? TURN,
  ) => {
    check.onEvent(SESSION, textEvent(reply, `m-${replyTurnId}`, replyTurnId));
    check.onTurnDone(facts(overrides));
  };
  return {
    check,
    hand,
    facts,
    finishTurn,
    runPrompt,
    requestAttention,
    tiebreakDone,
    settle: () => {
      expect(settlePrompt, "the tiebreak asked the model").not.toBeNull();
      return settlePrompt!;
    },
  };
}

const CLEAR_ASK = "Should I target main or the release branch?";
const RHETORICAL = "Root cause? A stale cache.\n\nBoth agents are still running.";

describe("classifyTurnEndAsk", () => {
  it.each([
    ["a direct question", "ask", "I traced it to the cache layer. Should I clear it now?", "Should I clear it now?"],
    ["a progress note", "not_ask", "Both agents are still running. I'll report back when they finish.", null],
    [
      "a question paragraph, then a progress note",
      "ask",
      "Do you want the fix on main or on the release branch?\n\nBoth agents are still running.",
      "Do you want the fix on main or on the release branch?",
    ],
    [
      "a direct request, then a progress note",
      "ask",
      "Tell me which branch to target.\n\nBoth agents are still running.",
      "Tell me which branch to target.",
    ],
    ["a rhetorical question, then a progress note", "unsure", RHETORICAL, null],
    ["a sign-off offer", "unsure", "I updated foo. Let me know if anything breaks.", null],
    [
      "a question that only appears in quotes, then a progress note",
      "unsure",
      "The FAQ says “Why did it fail?”\n\nBoth agents are still running.",
      null,
    ],
    [
      "a question mark inside a code fence",
      "not_ask",
      "I ran:\n\n```sh\ntest -f out.json || echo missing?\n```\n\nBoth agents are still running.",
      null,
    ],
  ] as const)("%s → %s", (_name, verdict, reply, question) => {
    const result = classifyTurnEndAsk(reply);
    expect(result.verdict).toBe(verdict);
    expect(result.verdict === "ask" ? result.question : null).toBe(question);
  });
});

describe("parseTurnEndAskDecision", () => {
  it.each([
    ["a structured answer", { asksUser: true }, null, true],
    ["a structured no", { asksUser: false }, "{\"asksUser\": true}", false],
    ["JSON fenced in prose", null, "Sure.\n```json\n{\"asksUser\": false}\n```", false],
    ["a non-boolean field", { asksUser: "yes" }, "maybe", null],
    ["garbage", null, "I think the user is being asked something.", null],
  ] as const)("%s", (_name, structured, text, expected) => {
    expect(parseTurnEndAskDecision(structured, text)).toBe(expected);
  });
});

describe("createTurnEndQuestionCheck", () => {
  it.each([
    {
      name: "a question and a progress note streamed across the paragraph break",
      events: [
        textEvent("Should I target ma"),
        textEvent("in or the release branch?\n"),
        textEvent("\nBoth agents are still "),
        textEvent("running."),
      ],
      raised: CLEAR_ASK,
    },
    {
      name: "a progress note streamed mid-word",
      events: [
        textEvent("I started both agents.\n\nBoth are still run"),
        textEvent("ning."),
      ],
      raised: null,
    },
    {
      name: "a question in an earlier message of the turn, then a progress note",
      events: [textEvent(CLEAR_ASK, "m1"), textEvent("Both agents are still running.", "m2")],
      raised: null,
    },
  ])("judges the turn's last reply as streamed: $name", ({ events, raised }) => {
    const { check, facts, runPrompt, requestAttention } = harness();
    for (const event of events) check.onEvent(SESSION, event);
    check.onTurnDone(facts());

    // The rules decide all three; none needs the model.
    expect(runPrompt).not.toHaveBeenCalled();
    expect(requestAttention.mock.calls.map(([args]) => args.message)).toEqual(raised ? [raised] : []);
    if (raised) {
      expect(requestAttention).toHaveBeenCalledWith({ sessionId: SESSION, message: raised, source: "turn_end_question" });
    }
  });

  it.each([
    { name: "no background work is running", reply: CLEAR_ASK, facts: { backgroundWorkCount: 0 } },
    { name: "the chat is a subagent with a parent", reply: CLEAR_ASK, facts: { isSubagentWithParent: true } },
    { name: "the turn did not complete", reply: CLEAR_ASK, facts: { completed: false } },
    { name: "the hand is already up", reply: CLEAR_ASK, hand: { attentionRequestedAt: "2026-10-08T00:00:00.000Z" } },
    { name: "an approval card is open", reply: CLEAR_ASK, hand: { hasPendingInput: true } },
    { name: "the reply belongs to another turn", reply: CLEAR_ASK, replyTurnId: "turn-0" },
    { name: "the provider has no cheap model", reply: RHETORICAL, facts: { provider: "opencode" } },
  ] as Array<{
    name: string;
    reply: string;
    facts?: Partial<TurnEndQuestionFacts>;
    hand?: Partial<TurnEndHandState>;
    replyTurnId?: string;
  }>)(
    "raises nothing when $name",
    ({ reply, facts, hand, replyTurnId }) => {
      const { finishTurn, runPrompt, requestAttention } = harness({ hand });
      finishTurn(reply, facts, replyTurnId);
      expect(requestAttention).not.toHaveBeenCalled();
      expect(runPrompt).not.toHaveBeenCalled();
    },
  );

  it("judges a turn once, even when its done is reported again", () => {
    const { finishTurn, requestAttention } = harness();
    finishTurn(CLEAR_ASK);
    finishTurn(CLEAR_ASK);
    expect(requestAttention).toHaveBeenCalledTimes(1);
    // A later turn of the same chat is judged on its own.
    finishTurn(CLEAR_ASK, { turnId: "turn-2" });
    expect(requestAttention).toHaveBeenCalledTimes(2);
  });

  it("raises the hand when the cheap model breaks a tie with a yes", async () => {
    const { finishTurn, runPrompt, requestAttention, settle, tiebreakDone } = harness();
    finishTurn(RHETORICAL);

    expect(runPrompt).toHaveBeenCalledTimes(1);
    const [{ cwd, modelId }] = runPrompt.mock.calls[0]!;
    expect(modelId).toBe(BACKGROUND_UTILITY_CLAUDE_MODEL_ID);
    // The classifier runs in a scratch directory: no repo, no project
    // instructions, no hooks. It is removed afterwards.
    expect(cwd.startsWith(os.tmpdir())).toBe(true);
    expect(requestAttention).not.toHaveBeenCalled();

    settle().resolve({ structuredOutput: { asksUser: true } });
    await tiebreakDone;

    expect(requestAttention).toHaveBeenCalledTimes(1);
    expect(requestAttention.mock.calls[0]![0]).toMatchObject({ sessionId: SESSION, source: "turn_end_question" });
    expect(requestAttention.mock.calls[0]![0].message).toContain("?");
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it.each([
    {
      name: "the user replied while the model was deciding",
      act: (h: ReturnType<typeof harness>) => {
        h.check.onEvent(SESSION, userMessage());
        h.settle().resolve({ structuredOutput: { asksUser: true } });
      },
    },
    {
      name: "the hand went up while the model was deciding",
      act: (h: ReturnType<typeof harness>) => {
        h.hand.attentionRequestedAt = "2026-10-08T00:00:00.000Z";
        h.settle().resolve({ structuredOutput: { asksUser: true } });
      },
    },
    {
      name: "the model call failed",
      act: (h: ReturnType<typeof harness>) => h.settle().reject(new Error("timed out")),
    },
    {
      name: "the model said no",
      act: (h: ReturnType<typeof harness>) => h.settle().resolve({ structuredOutput: { asksUser: false } }),
    },
  ])("raises nothing when $name", async ({ act }) => {
    const h = harness();
    h.finishTurn(RHETORICAL);
    expect(h.runPrompt).toHaveBeenCalledTimes(1);

    act(h);
    await h.tiebreakDone;

    expect(h.requestAttention).not.toHaveBeenCalled();
  });
});
