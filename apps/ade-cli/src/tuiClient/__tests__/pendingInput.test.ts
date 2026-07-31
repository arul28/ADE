import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope, PendingInputRequest } from "../../../../desktop/src/shared/types/chat";
import {
  answerForQuestion,
  buildPendingInputAnswers,
  cancelPendingQuestionDigitSelection,
  convertPendingQuestionDigitSelectionToText,
  createPendingQuestionSelectionState,
  latestPendingApproval,
  movePendingQuestionFocus,
  movePendingQuestionOption,
  pendingQuestionAnsweredCount,
  pendingQuestionSelectionValue,
  selectPendingQuestionDigit,
  selectPendingQuestionOptionIndex,
} from "../pendingInput";

const baseRequest: PendingInputRequest = {
  requestId: "req-1",
  source: "codex",
  kind: "structured_question",
  title: "Pick path",
  questions: [{
    id: "path",
    question: "Which path?",
    options: [
      { label: "Recommended", value: "recommended" },
      { label: "Manual", value: "manual" },
    ],
    allowsFreeform: true,
  }],
  allowsFreeform: true,
  blocking: true,
  canProceedWithoutAnswer: false,
};

function questionApproval(request: PendingInputRequest = baseRequest) {
  return {
    itemId: "item-questions",
    description: "Need input",
    highStakes: false,
    mode: "question" as const,
    request,
  };
}

describe("pendingInput", () => {
  it("maps option numbers to structured answers", () => {
    expect(buildPendingInputAnswers(baseRequest, "2")).toEqual({ path: "manual" });
  });

  it("keeps multi-select answers as arrays", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{
        ...baseRequest.questions[0]!,
        multiSelect: true,
      }],
    };
    expect(buildPendingInputAnswers(request, "1, Manual")).toEqual({ path: ["recommended", "manual"] });
  });

  // Bug 1. The TUI used to hand the typed text straight to answerForQuestion
  // and return it as the whole answer, so a note typed alongside a selection
  // threw that selection away. Both must travel, selection first, note last —
  // the same contract desktop and the web client answer under.
  it("regression: a typed note accumulates onto the selection instead of replacing it", () => {
    const state = createPendingQuestionSelectionState(questionApproval())!;
    const selected = selectPendingQuestionDigit(baseRequest, state, "2").state;

    expect(buildPendingInputAnswers(baseRequest, "only if the pin survives a restart", selected))
      .toEqual({ path: ["manual", "only if the pin survives a restart"] });
  });

  it("regression: a typed note accumulates onto every multi-select pick", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{ ...baseRequest.questions[0]!, multiSelect: true }],
    };
    let state = createPendingQuestionSelectionState(questionApproval(request))!;
    state = selectPendingQuestionOptionIndex(request, state, 0);
    state = selectPendingQuestionOptionIndex(request, state, 1);

    expect(buildPendingInputAnswers(request, "and roll back if CI is red", state))
      .toEqual({ path: ["recommended", "manual", "and roll back if CI is red"] });
  });

  it("keeps typing an option number a pick rather than a note", () => {
    const state = createPendingQuestionSelectionState(questionApproval())!;
    expect(buildPendingInputAnswers(baseRequest, "2", state)).toEqual({ path: "manual" });
  });

  it("sends the selection alone when nothing was typed", () => {
    const state = createPendingQuestionSelectionState(questionApproval())!;
    const selected = selectPendingQuestionDigit(baseRequest, state, "2").state;
    expect(buildPendingInputAnswers(baseRequest, "", selected)).toEqual({ path: "manual" });
  });

  it("sends a freeform answer alone when the question offers no options", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{ id: "path", question: "Which path?", allowsFreeform: true }],
    };
    const state = createPendingQuestionSelectionState(questionApproval(request))!;
    expect(buildPendingInputAnswers(request, "something else", state)).toEqual({ path: "something else" });
  });

  it("returns the latest unresolved pending input request", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        event: {
          type: "approval_request",
          itemId: "item-1",
          kind: "tool_call",
          description: "Need input",
          detail: { request: { ...baseRequest, itemId: "item-1" } },
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T00:00:01.000Z",
        sequence: 2,
        event: {
          type: "pending_input_resolved",
          itemId: "item-1",
          resolution: "accepted",
        },
      },
    ];
    expect(latestPendingApproval(events)).toBeNull();

    events.push({
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:02.000Z",
      sequence: 3,
      event: {
        type: "approval_request",
        itemId: "item-2",
        kind: "tool_call",
        description: "Need input",
        detail: { request: { ...baseRequest, requestId: "req-2", itemId: "item-2" } },
      },
    });
    expect(latestPendingApproval(events)).toEqual(expect.objectContaining({
      itemId: "item-2",
      mode: "question",
      highStakes: false,
    }));
  });

  it("flags destructive or external-impact approvals as high stakes", () => {
    const events: AgentChatEventEnvelope[] = [{
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:00.000Z",
      sequence: 1,
      event: {
        type: "approval_request",
        itemId: "item-1",
        kind: "tool_call",
        description: "Force-push the main branch to production",
        detail: { command: "git push --force origin main" },
      },
    }];

    expect(latestPendingApproval(events)).toEqual(expect.objectContaining({
      itemId: "item-1",
      mode: "approval",
      highStakes: true,
    }));
  });

  it("keeps plan approvals on the one-key approval path", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      kind: "plan_approval",
      title: "Approve plan",
      questions: [],
      allowsFreeform: false,
    };
    const events: AgentChatEventEnvelope[] = [{
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:00.000Z",
      sequence: 1,
      event: {
        type: "approval_request",
        itemId: "item-plan",
        kind: "tool_call",
        description: "Approve plan",
        detail: { request },
      },
    }];

    expect(latestPendingApproval(events)).toEqual(expect.objectContaining({
      itemId: "item-plan",
      mode: "approval",
      highStakes: false,
    }));
  });

  it("tracks arrow-key selection across multi-question input", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [
        baseRequest.questions[0]!,
        {
          id: "banner",
          question: "Which banner text?",
          options: [
            { label: "Short", value: "short" },
            { label: "Detailed", value: "detailed", recommended: true },
          ],
        },
      ],
    };
    const approval = questionApproval(request);

    const initial = createPendingQuestionSelectionState(approval)!;
    expect(pendingQuestionSelectionValue(request, initial)).toBe("recommended");

    const movedOption = movePendingQuestionOption(request, initial, 1);
    expect(pendingQuestionSelectionValue(request, movedOption)).toBe("manual");

    const movedQuestion = movePendingQuestionFocus(request, movedOption, 1);
    expect(movedQuestion.activeQuestionIndex).toBe(1);
    expect(pendingQuestionSelectionValue(request, movedQuestion)).toBe("detailed");
  });

  it("maps a typed answer for the active question by option label, index, or free text", () => {
    const question = baseRequest.questions[0]!; // options: Recommended/recommended, Manual/manual
    // Typed answers route through answerForQuestion so the multi-question flow
    // preserves option-label matching and multi-select splitting (not raw text).
    expect(answerForQuestion(question, "Manual")).toBe("manual");
    expect(answerForQuestion(question, "2")).toBe("manual");
    expect(answerForQuestion({ ...question, multiSelect: true }, "1, manual")).toEqual([
      "recommended",
      "manual",
    ]);
    expect(answerForQuestion({ id: "free", question: "Notes?" }, "  ship it  ")).toBe("ship it");
  });

  it("toggles multi-select option picker values without collapsing to a scalar", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{
        ...baseRequest.questions[0]!,
        multiSelect: true,
      }],
    };
    const approval = questionApproval(request);

    const initial = createPendingQuestionSelectionState(approval)!;
    expect(pendingQuestionSelectionValue(request, initial)).toBeNull();

    const withRecommended = selectPendingQuestionOptionIndex(request, initial, 0);
    expect(pendingQuestionSelectionValue(request, withRecommended)).toEqual(["recommended"]);

    const withBoth = selectPendingQuestionOptionIndex(request, withRecommended, 1);
    expect(pendingQuestionSelectionValue(request, withBoth)).toEqual(["recommended", "manual"]);

    const withoutRecommended = selectPendingQuestionOptionIndex(request, withBoth, 0);
    expect(pendingQuestionSelectionValue(request, withoutRecommended)).toEqual(["manual"]);
  });

  it("counts answered pending questions by id", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [
        baseRequest.questions[0]!,
        { id: "second", question: "Second?", options: [{ label: "Yes", value: "yes" }] },
      ],
    };

    expect(pendingQuestionAnsweredCount(request, { path: "manual" })).toBe(1);
    expect(pendingQuestionAnsweredCount(request, { path: "manual", second: "yes" })).toBe(2);
  });

  it("selects a numbered option provisionally until Enter submits the highlighted answer", () => {
    const initial = createPendingQuestionSelectionState(questionApproval())!;
    const result = selectPendingQuestionDigit(baseRequest, initial, "2");

    expect(result.selected).toBe(true);
    expect(pendingQuestionSelectionValue(baseRequest, result.state)).toBe("manual");
    expect(result.state.answers).toEqual({});
    expect(result.state.pendingDigitSelection).toEqual(expect.objectContaining({
      digit: "2",
      previousOptionIndex: 0,
      questionId: "path",
    }));
  });

  it("converts a provisional digit into free text and restores the previous option", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{
        ...baseRequest.questions[0]!,
        options: [
          { label: "One", value: "one" },
          { label: "Two", value: "two" },
          { label: "Three", value: "three" },
        ],
      }],
    };
    const initial = createPendingQuestionSelectionState(questionApproval(request))!;
    const selected = selectPendingQuestionDigit(request, initial, "3").state;

    const converted = convertPendingQuestionDigitSelectionToText(request, selected, " apples");

    expect(converted?.text).toBe("3 apples");
    expect(converted?.state.pendingDigitSelection).toBeNull();
    expect(converted ? pendingQuestionSelectionValue(request, converted.state) : null).toBe("one");
  });

  it("restores the original default when a provisional digit is cancelled before Enter", () => {
    const initial = createPendingQuestionSelectionState(questionApproval())!;
    const selected = selectPendingQuestionDigit(baseRequest, initial, "2").state;

    const cancelled = cancelPendingQuestionDigitSelection(selected);

    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.state.pendingDigitSelection).toBeNull();
    expect(pendingQuestionSelectionValue(baseRequest, cancelled.state)).toBe("recommended");
  });

  it("lets Backspace-cancelled digit input fall back to plain typed text", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{
        ...baseRequest.questions[0]!,
        options: [
          { label: "One", value: "one" },
          { label: "Two", value: "two" },
          { label: "Three", value: "three" },
        ],
      }],
    };
    const initial = createPendingQuestionSelectionState(questionApproval(request))!;
    const selected = selectPendingQuestionDigit(request, initial, "3").state;

    const cancelled = cancelPendingQuestionDigitSelection(selected);

    expect(cancelled.cancelled).toBe(true);
    expect(convertPendingQuestionDigitSelectionToText(request, cancelled.state, " apples")).toBeNull();
    expect(pendingQuestionSelectionValue(request, cancelled.state)).toBe("one");
    expect(answerForQuestion(request.questions[0]!, "3 apples")).toBe("3 apples");
  });

  it("leaves out-of-range digits for the composer", () => {
    const initial = createPendingQuestionSelectionState(questionApproval())!;
    const result = selectPendingQuestionDigit(baseRequest, initial, "9");

    expect(result.selected).toBe(false);
    expect(result.state).toBe(initial);
    expect(convertPendingQuestionDigitSelectionToText(baseRequest, result.state, "9")).toBeNull();
  });

  it("replaces a provisional quick-select on rapid in-range digits", () => {
    const selectedOne = selectPendingQuestionDigit(baseRequest, createPendingQuestionSelectionState(questionApproval())!, "1").state;
    const selectedTwo = selectPendingQuestionDigit(baseRequest, selectedOne, "2").state;

    expect(pendingQuestionSelectionValue(baseRequest, selectedTwo)).toBe("manual");
    expect(selectedTwo.pendingDigitSelection).toEqual(expect.objectContaining({
      digit: "2",
      previousOptionIndex: 0,
    }));
  });

  it("converts an out-of-range second digit after a provisional quick-select into text", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{
        ...baseRequest.questions[0]!,
        options: [
          { label: "One", value: "one" },
          { label: "Two", value: "two" },
          { label: "Three", value: "three" },
        ],
      }],
    };
    const selectedThree = selectPendingQuestionDigit(request, createPendingQuestionSelectionState(questionApproval(request))!, "3").state;
    const ignoredNine = selectPendingQuestionDigit(request, selectedThree, "9");
    const converted = convertPendingQuestionDigitSelectionToText(request, ignoredNine.state, "9");

    expect(ignoredNine.selected).toBe(false);
    expect(converted?.text).toBe("39");
    expect(converted ? pendingQuestionSelectionValue(request, converted.state) : null).toBe("one");
  });

  it("keeps direct option selection immediate for click-style callers", () => {
    const initial = createPendingQuestionSelectionState(questionApproval())!;
    const selected = selectPendingQuestionOptionIndex(baseRequest, initial, 1);

    expect(pendingQuestionSelectionValue(baseRequest, selected)).toBe("manual");
    expect(selected.pendingDigitSelection).toBeNull();
  });
});
