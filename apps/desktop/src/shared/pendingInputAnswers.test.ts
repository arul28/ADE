import { describe, expect, it } from "vitest";
import type { PendingInputQuestion } from "./types/chat";
import {
  RESOLVED_ANSWERS_MAX_BYTES,
  TRUNCATED_ANSWER_MARKER,
  answerState,
  answeredQuestionCount,
  buildAnswers,
  flattenAnswerForSingleStringProvider,
  foldedSummary,
  notePlaceholder,
  sanitizeAnswersForTranscript,
  sendLabel,
} from "./pendingInputAnswers";

const question = (overrides: Partial<PendingInputQuestion> & { id: string }): PendingInputQuestion => ({
  question: `Question ${overrides.id}`,
  ...overrides,
});

describe("answerState", () => {
  const cases: Array<[string[], string, string]> = [
    [[], "", "EMPTY"],
    [[], "   ", "EMPTY"],
    [["a"], "", "PICK"],
    [["a", "b"], "", "PICK"],
    [["a"], "because", "PICK_NOTE"],
    [["a", "b"], "because", "PICK_NOTE"],
    [[], "because", "NOTE"],
  ];
  it.each(cases)("picks=%j note=%j -> %s", (picks, note, expected) => {
    expect(answerState(picks, note)).toBe(expected);
  });
});

describe("sendLabel", () => {
  const single = (picks: string[], note: string) =>
    sendLabel({ picks, note, isLast: true, totalAnswered: picks.length || (note.trim() ? 1 : 0), totalQuestions: 1 });

  const cases: Array<[string[], string, string]> = [
    [[], "", "Send"],
    [["a"], "", "Send 1"],
    [["a", "b"], "", "Send 2 picks"],
    [["a", "b", "c"], "", "Send 3 picks"],
    [["a"], "note", "Send 1 + note"],
    [["a", "b", "c"], "note", "Send 3 + note"],
    [[], "note", "Send note"],
  ];
  it.each(cases)("single question picks=%j note=%j -> %s", (picks, note, expected) => {
    expect(single(picks, note)).toBe(expected);
  });

  it("reads Next on any question that is not the last", () => {
    expect(sendLabel({ picks: ["a"], note: "note", isLast: false, totalAnswered: 1, totalQuestions: 3 })).toBe("Next");
  });

  it("counts answers rather than picks once the set is paged", () => {
    expect(sendLabel({ picks: ["a"], note: "", isLast: true, totalAnswered: 3, totalQuestions: 3 })).toBe("Send 3 answers");
    expect(sendLabel({ picks: [], note: "", isLast: true, totalAnswered: 2, totalQuestions: 3 })).toBe("Send");
  });
});

describe("buildAnswers", () => {
  const questions = [question({ id: "one" }), question({ id: "two", multiSelect: true })];

  it("puts selection values first and the note last", () => {
    expect(buildAnswers(questions, { one: ["alpha"] }, { one: "only on tuesdays" })).toEqual({
      one: ["alpha", "only on tuesdays"],
    });
  });

  it("keeps a lone value unwrapped", () => {
    expect(buildAnswers(questions, { one: ["alpha"] }, {})).toEqual({ one: "alpha" });
    expect(buildAnswers(questions, {}, { one: "freeform" })).toEqual({ one: "freeform" });
  });

  it("accumulates every pick of a multi-select ahead of the note", () => {
    expect(buildAnswers(questions, { two: ["a", "b"] }, { two: "and c if cheap" })).toEqual({
      two: ["a", "b", "and c if cheap"],
    });
  });

  it("omits a question that has neither a pick nor a note", () => {
    expect(buildAnswers(questions, { one: ["alpha"] }, { two: "   " })).toEqual({ one: "alpha" });
  });

  // The bug this contract exists to kill: on the TUI a typed note used to
  // REPLACE the selection. Both must travel, on every surface.
  it("regression: a note never replaces the selection", () => {
    const built = buildAnswers(questions, { one: ["alpha"] }, { one: "actually beta-ish" });
    expect(built.one).toEqual(["alpha", "actually beta-ish"]);
    expect(built.one).not.toBe("actually beta-ish");
  });
});

describe("notePlaceholder", () => {
  const cases: Array<[{ hasOptions: boolean; picks: string[]; multi: boolean }, string]> = [
    [{ hasOptions: false, picks: [], multi: false }, "Your answer"],
    [{ hasOptions: true, picks: [], multi: false }, "Or send your own response instead"],
    [{ hasOptions: true, picks: ["a"], multi: false }, "Add a note (sent with your pick)"],
    [{ hasOptions: true, picks: ["a"], multi: true }, "Add a note (sent with your pick)"],
    [{ hasOptions: true, picks: ["a", "b"], multi: true }, "Add a note (sent with your 2 picks)"],
  ];
  it.each(cases)("%j -> %s", (args, expected) => {
    expect(notePlaceholder(args)).toBe(expected);
  });
});

describe("foldedSummary", () => {
  it("prefers the question header", () => {
    expect(foldedSummary(question({ id: "one", header: "Isolation", question: "How separate?" }), 0)).toEqual({
      label: "Isolation",
      text: "How separate?",
    });
  });

  it("falls back to the 1-based page number", () => {
    expect(foldedSummary(question({ id: "two", question: "Which one?" }), 1)).toEqual({
      label: "Question 2",
      text: "Which one?",
    });
  });
});

describe("answeredQuestionCount", () => {
  const questions = [question({ id: "a" }), question({ id: "b" }), question({ id: "c" })];
  it("counts a pick or a note as answered", () => {
    expect(answeredQuestionCount(questions, { a: ["x"] }, { b: "typed" })).toBe(2);
    expect(answeredQuestionCount(questions, {}, { c: "  " })).toBe(0);
  });
});

describe("flattenAnswerForSingleStringProvider", () => {
  const withOptions = {
    options: [
      { label: "Hide it", value: "hide" },
      { label: "Own lane", value: "lane" },
    ],
  };

  it("joins picks plainly when there is no note", () => {
    expect(flattenAnswerForSingleStringProvider(withOptions, ["hide", "lane"])).toBe("hide, lane");
    expect(flattenAnswerForSingleStringProvider(withOptions, "hide")).toBe("hide");
  });

  it("labels the note so a pick and a qualification stay distinguishable", () => {
    expect(flattenAnswerForSingleStringProvider(withOptions, ["hide", "only if the pin survives"]))
      .toBe("hide\nNote: only if the pin survives");
  });

  it("passes a note-only answer through unlabelled", () => {
    expect(flattenAnswerForSingleStringProvider(withOptions, ["something else entirely"]))
      .toBe("something else entirely");
  });

  it("returns an empty string for an unanswered question", () => {
    expect(flattenAnswerForSingleStringProvider(withOptions, undefined)).toBe("");
    expect(flattenAnswerForSingleStringProvider(withOptions, [])).toBe("");
  });
});

describe("sanitizeAnswersForTranscript", () => {
  // `pending_input_resolved` is durable AND synced to every paired device (and
  // the widget App Group). A credential typed into an isSecret question must
  // never reach it.
  it("regression: never persists an isSecret question's answer", () => {
    const questions = [
      question({ id: "token", isSecret: true }),
      question({ id: "scope" }),
    ];
    const sanitized = sanitizeAnswersForTranscript(questions, {
      token: "sk-live-do-not-replicate",
      scope: "read-only",
    });
    expect(sanitized).toEqual({ scope: "read-only" });
    expect(JSON.stringify(sanitized)).not.toContain("sk-live");
  });

  it("returns undefined when every answer was secret", () => {
    const questions = [question({ id: "token", isSecret: true })];
    expect(sanitizeAnswersForTranscript(questions, { token: "hunter2" })).toBeUndefined();
  });

  it("returns undefined for a decline with no answers", () => {
    expect(sanitizeAnswersForTranscript([question({ id: "a" })], undefined)).toBeUndefined();
    expect(sanitizeAnswersForTranscript([question({ id: "a" })], {})).toBeUndefined();
  });

  it("caps the persisted payload and marks the truncation", () => {
    const questions = [question({ id: "essay" })];
    const sanitized = sanitizeAnswersForTranscript(questions, { essay: "x".repeat(10_000) });
    expect(JSON.stringify(sanitized).length).toBeLessThanOrEqual(RESOLVED_ANSWERS_MAX_BYTES);
    expect(String(sanitized?.essay)).toContain(TRUNCATED_ANSWER_MARKER);
  });

  it("keeps a key for every question when several are oversized", () => {
    const questions = [question({ id: "one" }), question({ id: "two" })];
    const sanitized = sanitizeAnswersForTranscript(questions, {
      one: "a".repeat(4000),
      two: "b".repeat(4000),
    });
    expect(Object.keys(sanitized ?? {})).toEqual(["one", "two"]);
    expect(JSON.stringify(sanitized).length).toBeLessThanOrEqual(RESOLVED_ANSWERS_MAX_BYTES);
  });

  it("leaves an in-budget payload untouched", () => {
    const questions = [question({ id: "one" })];
    expect(sanitizeAnswersForTranscript(questions, { one: ["alpha", "note"] })).toEqual({ one: ["alpha", "note"] });
  });
});
