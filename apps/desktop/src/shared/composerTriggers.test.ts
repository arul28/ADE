import { describe, expect, it } from "vitest";
import {
  composerTriggerSpansWholeDraft,
  detectComposerTrigger,
  replaceComposerTriggerSpan,
} from "./composerTriggers";

describe("detectComposerTrigger", () => {
  it("detects a slash trigger at position 0", () => {
    expect(detectComposerTrigger("/pl", 3)).toEqual({ type: "slash", query: "pl", start: 0 });
  });

  it("detects a bare slash with empty query", () => {
    expect(detectComposerTrigger("/", 1)).toEqual({ type: "slash", query: "", start: 0 });
  });

  it("detects a slash trigger mid-sentence", () => {
    const text = "fix the bug then run /te";
    expect(detectComposerTrigger(text, text.length)).toEqual({ type: "slash", query: "te", start: 21 });
  });

  it("detects a slash trigger on a new line of a multiline draft", () => {
    const text = "first line\n/qual";
    expect(detectComposerTrigger(text, text.length)).toEqual({ type: "slash", query: "qual", start: 11 });
  });

  it("allows namespaced command queries", () => {
    const text = "run /frontend-design:frontend";
    expect(detectComposerTrigger(text, text.length)?.query).toBe("frontend-design:frontend");
  });

  it("does not trigger on slashes inside words, paths, or fractions", () => {
    expect(detectComposerTrigger("and/or", 6)).toBeNull();
    expect(detectComposerTrigger("3/4", 3)).toBeNull();
    expect(detectComposerTrigger("see /usr/bin", 12)).toBeNull();
    expect(detectComposerTrigger("https://example.com", 8)).toBeNull();
  });

  it("closes the slash trigger once whitespace follows the command name", () => {
    expect(detectComposerTrigger("/plan now", 9)).toBeNull();
  });

  it("keeps the slash trigger when the cursor sits right after the token", () => {
    const text = "/plan now";
    expect(detectComposerTrigger(text, 5)).toEqual({ type: "slash", query: "plan", start: 0 });
  });

  it("detects an at trigger anywhere with a path query", () => {
    const text = "fix @src/foo.ts";
    expect(detectComposerTrigger(text, text.length)).toEqual({ type: "at", query: "src/foo.ts", start: 4 });
  });

  it("does not trigger on emails", () => {
    const text = "mail user@doma";
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });

  it("only inspects text before the cursor", () => {
    const text = "run /te and more";
    expect(detectComposerTrigger(text, 7)).toEqual({ type: "slash", query: "te", start: 4 });
    expect(detectComposerTrigger(text, 3)).toBeNull();
  });

  it("keeps a mid-token @ inside the slash query instead of switching triggers", () => {
    const text = "run /a@b";
    expect(detectComposerTrigger(text, text.length)).toEqual({ type: "slash", query: "a@b", start: 4 });
  });

  it("lets an at token carry a leading slash", () => {
    expect(detectComposerTrigger("@/foo", 5)).toEqual({ type: "at", query: "/foo", start: 0 });
  });

  it("clamps out-of-range cursors", () => {
    expect(detectComposerTrigger("/x", 99)).toEqual({ type: "slash", query: "x", start: 0 });
    expect(detectComposerTrigger("/x", -1)).toBeNull();
  });
});

describe("replaceComposerTriggerSpan", () => {
  it("replaces exactly the trigger span mid-sentence", () => {
    const text = "fix @src/f then run /te tomorrow";
    const trigger = { start: 20, query: "te" };
    expect(replaceComposerTriggerSpan(text, trigger, "/test ")).toEqual({
      text: "fix @src/f then run /test  tomorrow",
      caret: 26,
    });
  });

  it("supports multiple tokens in one draft", () => {
    const first = replaceComposerTriggerSpan("fix @src/f", { start: 4, query: "src/f" }, "@src/foo.ts ");
    expect(first.text).toBe("fix @src/foo.ts ");
    const next = `${first.text}then run /te`;
    const second = replaceComposerTriggerSpan(next, { start: 25, query: "te" }, "/test ");
    expect(second.text).toBe("fix @src/foo.ts then run /test ");
  });

  it("replaces a whole-draft trigger", () => {
    expect(replaceComposerTriggerSpan("/cle", { start: 0, query: "cle" }, "/clear ")).toEqual({
      text: "/clear ",
      caret: 7,
    });
  });
});

describe("composerTriggerSpansWholeDraft", () => {
  it("is true for a lone token", () => {
    expect(composerTriggerSpansWholeDraft("/plan", { start: 0, query: "plan" })).toBe(true);
    expect(composerTriggerSpansWholeDraft("  /plan", { start: 2, query: "plan" })).toBe(true);
  });

  it("is false when other content surrounds the token", () => {
    expect(composerTriggerSpansWholeDraft("run /plan", { start: 4, query: "plan" })).toBe(false);
    expect(composerTriggerSpansWholeDraft("/plan it", { start: 0, query: "plan" })).toBe(false);
  });
});
