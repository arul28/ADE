import { describe, expect, it } from "vitest";
import type { PendingInputQuestion } from "./types/chat";
import {
  RESOLVED_ANSWERS_MAX_BYTES,
  TRUNCATED_ANSWER_MARKER,
  answerState,
  answeredQuestionCount,
  buildAnswers,
  flattenAnswerForSingleStringProvider,
  formatPendingInputAnswersAsMessage,
  isDismissiblePendingRequest,
  isNonBlockingPendingRequest,
  normalizePendingInputAnswers,
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
  it("a note never replaces the selection", () => {
    const built = buildAnswers(questions, { one: ["alpha"] }, { one: "actually beta-ish" });
    expect(built.one).toEqual(["alpha", "actually beta-ish"]);
    expect(built.one).not.toBe("actually beta-ish");
  });

  it.each(["__proto__", "toString"])(
    "regression: provider question id %s remains an own serialized answer key",
    (id) => {
      const built = buildAnswers([question({ id })], Object.fromEntries([[id, ["safe"]]]), {});
      expect(Object.prototype.hasOwnProperty.call(built, id)).toBe(true);
      expect(built[id]).toBe("safe");
      expect(JSON.parse(JSON.stringify(built))).toEqual({ [id]: "safe" });
    },
  );
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
  it("never persists an isSecret question's answer", () => {
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

  it("an unknown answer key cannot bypass a secret question id", () => {
    const questions = [question({ id: "token", isSecret: true })];
    expect(sanitizeAnswersForTranscript(questions, {
      response: "sk-live-under-the-wrong-key",
    })).toBeUndefined();
  });

  it("returns undefined for a decline with no answers", () => {
    expect(sanitizeAnswersForTranscript([question({ id: "a" })], undefined)).toBeUndefined();
    expect(sanitizeAnswersForTranscript([question({ id: "a" })], {})).toBeUndefined();
  });

  // The cap is a BYTE ceiling, not a character count. Measuring String.length
  // under-counts CJK by 3x and emoji by 4x, which is how a nominal 2 KB cap
  // persisted 6 KB.
  const persistedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

  it("caps the persisted payload and marks the truncation", () => {
    const questions = [question({ id: "essay" })];
    const sanitized = sanitizeAnswersForTranscript(questions, { essay: "x".repeat(10_000) });
    expect(persistedBytes(sanitized)).toBeLessThanOrEqual(RESOLVED_ANSWERS_MAX_BYTES);
    expect(String(sanitized?.essay)).toContain(TRUNCATED_ANSWER_MARKER);
  });

  it("caps multi-byte answers by bytes, not code units", () => {
    for (const [label, filler] of [["CJK", "中"], ["emoji", "🙂"], ["accented", "é"]] as const) {
      const sanitized = sanitizeAnswersForTranscript(
        [question({ id: "essay" })],
        { essay: filler.repeat(20_000) },
      );
      expect(persistedBytes(sanitized), label).toBeLessThanOrEqual(RESOLVED_ANSWERS_MAX_BYTES);
    }
  });

  it("preserves complete Unicode code points when truncating", () => {
    const sanitized = sanitizeAnswersForTranscript(
      [question({ id: "essay" })],
      { essay: "🙂".repeat(5_000) },
    );
    const value = String(sanitized?.essay);
    expect(value).toContain(TRUNCATED_ANSWER_MARKER);
    const codePoints = [...value].map((character) => character.codePointAt(0)!);
    expect(codePoints.some((codePoint) => codePoint >= 0xd800 && codePoint <= 0xdfff)).toBe(false);
  });

  const byteBudgetCases = [
    ["a pathological question ID", () => {
      const id = "x".repeat(50_000);
      return { questions: [question({ id })], answers: { [id]: "short" } };
    }],
    ["many aggregate answers", () => {
      const questions = Array.from({ length: 400 }, (_, index) => question({ id: `q${index}` }));
      const answers = Object.fromEntries(questions.map((entry) => [entry.id, "an answer of some length"]));
      return { questions, answers };
    }],
  ] as const;
  it.each(byteBudgetCases)("keeps %s within the serialized answer limit", (_label, makeCase) => {
    const { questions, answers } = makeCase();
    const sanitized = sanitizeAnswersForTranscript(questions, answers);
    expect(persistedBytes(sanitized)).toBeLessThanOrEqual(2_048);
  });

  it("keeps a key for every question when several are oversized", () => {
    const questions = [question({ id: "one" }), question({ id: "two" })];
    const sanitized = sanitizeAnswersForTranscript(questions, {
      one: "a".repeat(4000),
      two: "b".repeat(4000),
    });
    expect(Object.keys(sanitized ?? {})).toEqual(["one", "two"]);
    expect(persistedBytes(sanitized)).toBeLessThanOrEqual(RESOLVED_ANSWERS_MAX_BYTES);
  });

  it("caps an oversized array answer too", () => {
    const questions = [question({ id: "many" })];
    const sanitized = sanitizeAnswersForTranscript(questions, {
      many: Array.from({ length: 50 }, () => "中".repeat(500)),
    });
    expect(persistedBytes(sanitized)).toBeLessThanOrEqual(RESOLVED_ANSWERS_MAX_BYTES);
  });

  it("leaves an in-budget payload untouched", () => {
    const questions = [question({ id: "one" })];
    expect(sanitizeAnswersForTranscript(questions, { one: ["alpha", "note"] })).toEqual({ one: ["alpha", "note"] });
  });
});

describe("normalizePendingInputAnswers", () => {
  const questions = [question({ id: "one" }), question({ id: "two" })];

  it("keys every answered question and omits the unanswered ones", () => {
    expect(normalizePendingInputAnswers({ questions }, { one: "alpha", two: "  " })).toEqual({
      one: ["alpha"],
    });
  });

  it("keeps every value of a multi-value answer, trimmed", () => {
    expect(normalizePendingInputAnswers({ questions }, { two: ["a ", " b", "  "] })).toEqual({
      two: ["a", "b"],
    });
  });

  // The bug: a shared responseText used to land under a synthetic "response"
  // key whenever more than one question was asked. Claude's `question.reply`
  // takes one array per ASKED question, so that key matched nothing and the
  // user's actual reply never reached the model.
  it("shared response text joins the last answered question, not a 'response' key", () => {
    const normalized = normalizePendingInputAnswers(
      { questions },
      { one: "alpha", two: "beta" },
      "and ship it friday",
    );

    expect(normalized).toEqual({ one: ["alpha"], two: ["beta", "and ship it friday"] });
    expect(Object.prototype.hasOwnProperty.call(normalized, "response")).toBe(false);
  });

  it("attaches shared response text to the last question that was actually answered", () => {
    expect(normalizePendingInputAnswers({ questions }, { one: "alpha" }, "with a caveat")).toEqual({
      one: ["alpha", "with a caveat"],
    });
  });

  it("falls back to the first question when nothing was answered", () => {
    expect(normalizePendingInputAnswers({ questions }, {}, "just do whatever")).toEqual({
      one: ["just do whatever"],
    });
    expect(normalizePendingInputAnswers({ questions }, undefined, "just do whatever")).toEqual({
      one: ["just do whatever"],
    });
  });

  it("still answers a single question the way it always did", () => {
    expect(normalizePendingInputAnswers({ questions: [questions[0]!] }, {}, "freeform")).toEqual({
      one: ["freeform"],
    });
  });

  it("does not repeat response text the composer already folded into the answer", () => {
    expect(
      normalizePendingInputAnswers({ questions }, { one: ["alpha", "a note"] }, "a note"),
    ).toEqual({ one: ["alpha", "a note"] });
  });

  it("uses the 'response' key only when the request asks no questions", () => {
    expect(normalizePendingInputAnswers({ questions: [] }, {}, "approved")).toEqual({
      response: ["approved"],
    });
    expect(normalizePendingInputAnswers(undefined, undefined, "approved")).toEqual({
      response: ["approved"],
    });
  });

  it("carries a model_selection selection alongside the questions", () => {
    expect(
      normalizePendingInputAnswers({ questions: [], kind: "model_selection" }, { selection: "opus" }),
    ).toEqual({ selection: ["opus"] });
  });

  it("ignores inherited Object.prototype keys in the answers record", () => {
    expect(normalizePendingInputAnswers({ questions: [question({ id: "toString" })] }, {})).toEqual({});
  });

  it("returns an empty payload when there is nothing to send", () => {
    expect(normalizePendingInputAnswers({ questions }, {}, "   ")).toEqual({});
  });
});

describe("isNonBlockingPendingRequest", () => {
  it("is true only for an explicit blocking: false", () => {
    expect(isNonBlockingPendingRequest({ blocking: false })).toBe(true);
    expect(isNonBlockingPendingRequest({ blocking: true })).toBe(false);
    // Absent means blocking, matching Codex `unwrap_or(true)`: a card ADE
    // cannot read must not silently stop gating sends.
    expect(isNonBlockingPendingRequest({})).toBe(false);
    expect(isNonBlockingPendingRequest(null)).toBe(false);
  });
});

describe("isDismissiblePendingRequest", () => {
  it("reads the provider's flag, not blocking", () => {
    expect(isDismissiblePendingRequest({ providerMetadata: { dismissible: true } })).toBe(true);
    expect(isDismissiblePendingRequest({ providerMetadata: { dismissible: false } })).toBe(false);
    // Codex steering: non-blocking, still an open app-server request.
    expect(isDismissiblePendingRequest({ providerMetadata: {} })).toBe(false);
    expect(isDismissiblePendingRequest({})).toBe(false);
  });
});

describe("formatPendingInputAnswersAsMessage", () => {
  const request = {
    questions: [
      { id: "0", question: "Which database?", allowsFreeform: true },
      { id: "1", question: "Ship today?", allowsFreeform: true },
    ],
  };

  it("restates each question above its answer, blocks separated by a blank line", () => {
    expect(formatPendingInputAnswersAsMessage(request, { "0": ["Postgres"], "1": ["Yes"] }))
      .toBe("Which database?\nPostgres\n\nShip today?\nYes");
  });

  it("joins a multi-select answer", () => {
    expect(formatPendingInputAnswersAsMessage(request, { "0": ["Postgres", "SQLite"] }))
      .toBe("Which database?\nPostgres, SQLite");
  });

  it("omits an unanswered question rather than sending it blank", () => {
    expect(formatPendingInputAnswersAsMessage(request, { "1": ["Yes"] }))
      .toBe("Ship today?\nYes");
  });

  it("returns an empty string when nothing was answered", () => {
    expect(formatPendingInputAnswersAsMessage(request, {})).toBe("");
    expect(formatPendingInputAnswersAsMessage(request, { "0": ["   "] })).toBe("");
  });
});
