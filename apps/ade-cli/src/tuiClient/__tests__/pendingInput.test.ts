import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope, PendingInputRequest } from "../../../../desktop/src/shared/types/chat";
import {
  buildPendingInputAnswers,
  cancelPendingQuestionDigitSelection,
  convertPendingQuestionDigitSelectionToText,
  createPendingQuestionSelectionState,
  latestPendingApproval,
  movePendingQuestionFocus,
  movePendingQuestionOption,
  pendingQuestionAnswerGuidance,
  pendingQuestionAnsweredCount,
  pendingQuestionSelectionValue,
  selectPendingQuestionDigit,
  selectPendingQuestionOptionIndex,
  selectedValuesForQuestion,
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

describe("pendingQuestionAnswerGuidance", () => {
  it("distinguishes freeform, options, defaults, and unanswerable questions", () => {
    const question = baseRequest.questions[0]!;
    expect(pendingQuestionAnswerGuidance(baseRequest, question, 0))
      .toBe("Type an answer in the prompt for this question.");
    expect(pendingQuestionAnswerGuidance(baseRequest, { ...question, allowsFreeform: false }, 0))
      .toBe("Select one of the offered options.");
    expect(pendingQuestionAnswerGuidance(baseRequest, {
      ...question,
      options: [],
      allowsFreeform: false,
      defaultAssumption: "Keep current",
    }, 0)).toBe("Press Enter to use the default assumption.");
    expect(pendingQuestionAnswerGuidance(baseRequest, {
      ...question,
      options: [],
      allowsFreeform: false,
    }, 0)).toBe("No answer options are available. Decline this request.");
  });
});

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

  // Bug 1. The TUI used to hand typed text through a separate parser
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

  // The seeded cursor sits on the recommended option so the list opens with a
  // highlight somewhere. That cursor is NOT an answer — preselecting the
  // recommendation was explicitly dropped (spec section 6) — so free text typed
  // without touching the list must travel alone, exactly as it does on desktop.
  it("regression: an untouched highlight never becomes a phantom pick", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{
        ...baseRequest.questions[0]!,
        options: [
          { label: "Recommended", value: "recommended", recommended: true },
          { label: "Manual", value: "manual" },
        ],
      }],
    };
    const untouched = createPendingQuestionSelectionState(questionApproval(request))!;

    expect(selectedValuesForQuestion(request, untouched, 0)).toEqual([]);
    expect(buildPendingInputAnswers(request, "neither, squash it", untouched))
      .toEqual({ path: "neither, squash it" });
  });

  it("counts the highlight once the user actually moves it", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{
        ...baseRequest.questions[0]!,
        options: [
          { label: "Recommended", value: "recommended", recommended: true },
          { label: "Manual", value: "manual" },
        ],
      }],
    };
    const moved = movePendingQuestionOption(request, createPendingQuestionSelectionState(questionApproval(request))!, 1);

    expect(selectedValuesForQuestion(request, moved, 0)).toEqual(["manual"]);
    expect(buildPendingInputAnswers(request, "if CI is green", moved))
      .toEqual({ path: ["manual", "if CI is green"] });
  });

  // `2` then more characters was never a pick, so rolling the digit back must
  // roll the touch back with it rather than leaving a phantom selection.
  it("regression: converting a digit selection to text leaves no pick behind", () => {
    const state = createPendingQuestionSelectionState(questionApproval())!;
    const digit = selectPendingQuestionDigit(baseRequest, state, "2");
    const converted = convertPendingQuestionDigitSelectionToText(baseRequest, digit.state, "x");

    expect(converted).not.toBeNull();
    expect(selectedValuesForQuestion(baseRequest, converted!.state, 0)).toEqual([]);
  });

  // The old parser comma-split and kept only the first segment for a
  // single-select, silently truncating any prose containing a comma.
  it("regression: free text with a comma survives verbatim on a single-select", () => {
    const state = createPendingQuestionSelectionState(questionApproval())!;
    expect(buildPendingInputAnswers(baseRequest, "neither, squash it instead", state))
      .toEqual({ path: "neither, squash it instead" });
  });

  it("still comma-splits a multi-select, keeping unmatched segments as the note", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{ ...baseRequest.questions[0]!, multiSelect: true }],
    };
    const state = createPendingQuestionSelectionState(questionApproval(request))!;
    expect(buildPendingInputAnswers(request, "1, Manual, and revisit later", state))
      .toEqual({ path: ["recommended", "manual", "and revisit later"] });
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

  it("sends nothing for an untouched question with no typed text", () => {
    const state = createPendingQuestionSelectionState(questionApproval())!;
    expect(buildPendingInputAnswers(baseRequest, "", state)).toEqual({});
  });

  it("sends a freeform answer alone when the question offers no options", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{ id: "path", question: "Which path?", allowsFreeform: true }],
    };
    const state = createPendingQuestionSelectionState(questionApproval(request))!;
    expect(buildPendingInputAnswers(request, "something else", state)).toEqual({ path: "something else" });
  });

  it("regression: refuses unmatched freeform when the question disallows it", () => {
    const request: PendingInputRequest = {
      ...baseRequest,
      questions: [{ ...baseRequest.questions[0]!, allowsFreeform: false }],
    };
    const state = createPendingQuestionSelectionState(questionApproval(request))!;

    expect(buildPendingInputAnswers(request, "neither, do something else", state)).toEqual({});
    const selected = movePendingQuestionOption(request, state, 1);
    expect(buildPendingInputAnswers(request, "ignore this freeform", selected)).toEqual({ path: "manual" });
  });

  it.each(["__proto__", "toString"])(
    "regression: provider question id %s is safe in TUI selection state",
    (id) => {
      const request: PendingInputRequest = {
        ...baseRequest,
        questions: [{ id, question: "What?", allowsFreeform: true }],
      };
      const state = createPendingQuestionSelectionState(questionApproval(request))!;
      const built = buildPendingInputAnswers(request, "safe", state)!;

      expect(Object.prototype.hasOwnProperty.call(built, id)).toBe(true);
      expect(built[id]).toBe("safe");
    },
  );

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
    expect(buildPendingInputAnswers(request, "3 apples", cancelled.state)).toEqual({ path: "3 apples" });
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
