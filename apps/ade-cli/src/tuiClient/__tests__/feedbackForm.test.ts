import { describe, it, expect } from "vitest";
import {
  FEEDBACK_TYPES,
  feedbackFormInitialState,
  feedbackFormReducer,
  feedbackFormCanSubmit,
  feedbackFormToFormValues,
  feedbackTypeToCategory,
  feedbackSummaryLine,
  serializeContextFooter,
  cycleFeedbackType,
  type ContextFooterInfo,
  type FeedbackType,
} from "../feedbackForm.js";
import { buildFeedbackDraftInput } from "../feedback.js";

describe("feedbackFormInitialState", () => {
  it("defaults to bug type, empty text, context enabled", () => {
    const s = feedbackFormInitialState();
    expect(s.type).toBe("bug");
    expect(s.text).toBe("");
    expect(s.showContext).toBe(true);
    expect(s.context).toEqual({});
  });

  it("captures the provided context snapshot by copy", () => {
    const ctx: ContextFooterInfo = { provider: "anthropic", model: "opus" };
    const s = feedbackFormInitialState(ctx);
    expect(s.context).toEqual(ctx);
    ctx.provider = "mutated";
    expect(s.context.provider).toBe("anthropic");
  });
});

describe("feedbackTypeToCategory", () => {
  it("maps UI types onto existing daemon categories", () => {
    expect(feedbackTypeToCategory("bug")).toBe("bug");
    expect(feedbackTypeToCategory("idea")).toBe("feature");
    expect(feedbackTypeToCategory("praise")).toBe("improvement");
  });
});

describe("cycleFeedbackType", () => {
  it("cycles forward with wrap", () => {
    expect(cycleFeedbackType("bug", 1)).toBe("idea");
    expect(cycleFeedbackType("idea", 1)).toBe("praise");
    expect(cycleFeedbackType("praise", 1)).toBe("bug");
  });
  it("cycles backward with wrap", () => {
    expect(cycleFeedbackType("bug", -1)).toBe("praise");
    expect(cycleFeedbackType("praise", -1)).toBe("idea");
  });
  it("covers every declared type", () => {
    let t: FeedbackType = FEEDBACK_TYPES[0];
    const seen = new Set<string>();
    for (let i = 0; i < FEEDBACK_TYPES.length; i++) {
      seen.add(t);
      t = cycleFeedbackType(t, 1);
    }
    expect(seen.size).toBe(FEEDBACK_TYPES.length);
  });
});

describe("feedbackFormReducer", () => {
  const base = feedbackFormInitialState();

  it("setType changes the type", () => {
    expect(feedbackFormReducer(base, { kind: "setType", type: "idea" }).type).toBe("idea");
  });
  it("setType is a no-op (same reference) when unchanged", () => {
    expect(feedbackFormReducer(base, { kind: "setType", type: "bug" })).toBe(base);
  });

  it("cycleType moves through types", () => {
    expect(feedbackFormReducer(base, { kind: "cycleType", direction: 1 }).type).toBe("idea");
  });

  it("setText replaces the body", () => {
    expect(feedbackFormReducer(base, { kind: "setText", text: "hello" }).text).toBe("hello");
  });

  it("appendChar / appendNewline / backspace edit the body", () => {
    let s = feedbackFormReducer(base, { kind: "appendChar", char: "a" });
    s = feedbackFormReducer(s, { kind: "appendNewline" });
    s = feedbackFormReducer(s, { kind: "appendChar", char: "b" });
    expect(s.text).toBe("a\nb");
    s = feedbackFormReducer(s, { kind: "backspace" });
    expect(s.text).toBe("a\n");
  });

  it("backspace on empty text is a no-op (same reference)", () => {
    expect(feedbackFormReducer(base, { kind: "backspace" })).toBe(base);
  });

  it("toggleContext flips the flag", () => {
    const off = feedbackFormReducer(base, { kind: "toggleContext" });
    expect(off.showContext).toBe(false);
    expect(feedbackFormReducer(off, { kind: "toggleContext" }).showContext).toBe(true);
  });

  it("setContext replaces and copies context", () => {
    const ctx: ContextFooterInfo = { lane: "my-lane" };
    const s = feedbackFormReducer(base, { kind: "setContext", context: ctx });
    expect(s.context).toEqual(ctx);
    expect(s.context).not.toBe(ctx);
  });

  it("reset returns to initial state preserving context", () => {
    let s = feedbackFormReducer(base, { kind: "setText", text: "abc" });
    s = feedbackFormReducer(s, { kind: "setContext", context: { lane: "L" } });
    const r = feedbackFormReducer(s, { kind: "reset" });
    expect(r.text).toBe("");
    expect(r.type).toBe("bug");
    expect(r.showContext).toBe(true);
    expect(r.context).toEqual({ lane: "L" });
  });
});

describe("feedbackFormCanSubmit", () => {
  it("is false for empty / whitespace-only text", () => {
    expect(feedbackFormCanSubmit(feedbackFormInitialState())).toBe(false);
    expect(
      feedbackFormCanSubmit({ ...feedbackFormInitialState(), text: "   \n\t " }),
    ).toBe(false);
  });
  it("is true once there is real content", () => {
    expect(
      feedbackFormCanSubmit({ ...feedbackFormInitialState(), text: "  x " }),
    ).toBe(true);
  });
});

describe("feedbackSummaryLine", () => {
  it("uses the first non-empty line of a multiline body", () => {
    expect(feedbackSummaryLine("\n\n  the title  \nmore detail")).toBe("the title");
  });
  it("is empty when the body is blank", () => {
    expect(feedbackSummaryLine("   \n  ")).toBe("");
  });
});

describe("serializeContextFooter", () => {
  it("returns empty string when nothing useful is present", () => {
    expect(serializeContextFooter({})).toBe("");
    expect(serializeContextFooter({ provider: "", model: null, lane: "  " })).toBe("");
  });
  it("combines provider and model on one line", () => {
    expect(serializeContextFooter({ provider: "anthropic", model: "opus" })).toContain(
      "Provider/Model: anthropic / opus",
    );
  });
  it("emits only the fields that are present", () => {
    const out = serializeContextFooter({ model: "opus", lane: "lane-1" });
    expect(out).toContain("Provider/Model: opus");
    expect(out).toContain("Lane: lane-1");
    expect(out).not.toContain("Last error");
  });
  it("includes last error/notice", () => {
    expect(serializeContextFooter({ lastError: "boom failed" })).toContain(
      "Last error/notice: boom failed",
    );
  });
});

describe("feedbackFormToFormValues", () => {
  it("derives summary + multiline details and maps the category", () => {
    const s = {
      ...feedbackFormInitialState(),
      type: "idea" as const,
      text: "the headline\nline two\nline three",
      showContext: false,
    };
    const values = feedbackFormToFormValues(s);
    expect(values.category).toBe("feature");
    expect(values.summary).toBe("the headline");
    expect(values.details).toBe("the headline\nline two\nline three");
    expect(values.additionalContext).toBeUndefined();
  });

  it("puts the context footer into additionalContext when enabled", () => {
    const s = {
      ...feedbackFormInitialState(),
      text: "it broke",
      showContext: true,
      context: { provider: "anthropic", model: "opus", lane: "L", lastError: "E" },
    };
    const values = feedbackFormToFormValues(s);
    expect(values.additionalContext).toContain("--- Context ---");
    expect(values.additionalContext).toContain("Provider/Model: anthropic / opus");
    expect(values.additionalContext).toContain("Lane: L");
    expect(values.additionalContext).toContain("Last error/notice: E");
  });

  it("omits additionalContext when context is toggled off", () => {
    const s = {
      ...feedbackFormInitialState(),
      text: "it broke",
      showContext: false,
      context: { provider: "anthropic" },
    };
    expect(feedbackFormToFormValues(s).additionalContext).toBeUndefined();
  });
});

describe("integration with buildFeedbackDraftInput (existing daemon path)", () => {
  it("multiline body survives into a bug draft and context lands in additionalContext", () => {
    const s = {
      ...feedbackFormInitialState(),
      type: "bug" as const,
      text: "crash on launch\nstep 1\nstep 2",
      showContext: true,
      context: { provider: "anthropic", model: "opus", lane: "L" },
    };
    const draft = buildFeedbackDraftInput(feedbackFormToFormValues(s));
    expect(draft.category).toBe("bug");
    expect(draft.summary).toBe("crash on launch");
    // details -> stepsToReproduce for bug category; newlines preserved.
    if (draft.category === "bug") {
      expect(draft.stepsToReproduce).toBe("crash on launch\nstep 1\nstep 2");
    }
    expect(draft.additionalContext).toContain("--- Context ---");
    expect(draft.additionalContext).toContain("Provider/Model: anthropic / opus");
  });

  it("idea maps to a feature draft", () => {
    const s = {
      ...feedbackFormInitialState(),
      type: "idea" as const,
      text: "add dark mode\nwould be nice",
      showContext: false,
    };
    const draft = buildFeedbackDraftInput(feedbackFormToFormValues(s));
    expect(draft.category).toBe("feature");
    expect(draft.summary).toBe("add dark mode");
  });
});
