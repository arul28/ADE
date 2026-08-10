import { describe, expect, it } from "vitest";
import {
  composerFileSearchQuery,
  composerTriggerForSelection,
  composerTriggerHasConfirmedPrefix,
  composerTriggerSpansWholeDraft,
  detectComposerTrigger,
  findConfirmedComposerTokens,
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

  it("keeps an at trigger open across spaces for multi-word chat names", () => {
    expect(detectComposerTrigger("@a b c", 6)).toEqual({ type: "at", query: "a b c", start: 0 });
    // A trailing space is still part of the in-progress query. The menu trims
    // it for searching, so cached suggestions remain visible while the next
    // word is being typed.
    expect(detectComposerTrigger("@a ", 3)).toEqual({ type: "at", query: "a ", start: 0 });
  });

  it("narrows path-like file queries before trailing prose", () => {
    expect(composerFileSearchQuery("src/foo.ts about this")).toBe("src/foo.ts");
    expect(composerFileSearchQuery("src/my file.ts about this")).toBe("src/my file.ts");
    expect(composerFileSearchQuery("src/my folder about this")).toBe("src/my folder about this");
    expect(composerFileSearchQuery("a b c")).toBe("a b c");
  });

  it("does not let an at query cross a newline or another at sign", () => {
    expect(detectComposerTrigger("@a\nb", 4)).toBeNull();
    expect(detectComposerTrigger("@a@b", 4)).toBeNull();
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
  it("keeps prose after a selected mention prefix", () => {
    const trigger = detectComposerTrigger("ask @a b c about this", 20)!;
    const selected = composerTriggerForSelection(trigger, "a b c");

    expect(selected.query).toBe("a b c ");
    expect(replaceComposerTriggerSpan("ask @a b c about this", selected, "@chat:chat-1 ")).toEqual({
      text: "ask @chat:chat-1 about this",
      caret: 17,
    });
  });

  it("does not shorten a partial or non-prefix selection", () => {
    const trigger = detectComposerTrigger("@abc", 4)!;
    expect(composerTriggerForSelection(trigger, "a b c")).toEqual(trigger);
    expect(composerTriggerForSelection(trigger, "other")).toEqual(trigger);
  });

  it("narrows shorthand file labels without consuming trailing prose", () => {
    const text = "ask @foo.ts about this";
    const trigger = detectComposerTrigger(text, text.length)!;
    const selected = composerTriggerForSelection(trigger, "src/foo.ts", "file");

    expect(selected.query).toBe("foo.ts ");
    expect(replaceComposerTriggerSpan(text, selected, "@src/foo.ts ").text).toBe("ask @src/foo.ts about this");
  });

  it("narrows a spaced extensionless basename without consuming trailing prose", () => {
    const text = "ask @my folder about this";
    const trigger = detectComposerTrigger(text, text.length)!;
    const selected = composerTriggerForSelection(trigger, "src/my folder", "file");

    expect(selected.query).toBe("my folder ");
    expect(replaceComposerTriggerSpan(text, selected, "@src/my folder ").text).toBe("ask @src/my folder about this");
  });

  it("preserves prose after an extensionless path-prefix match", () => {
    const text = "ask @src/my review this";
    const trigger = detectComposerTrigger(text, text.length)!;
    const selected = composerTriggerForSelection(trigger, "src/my folder", "file");

    expect(selected.query).toBe("src/my ");
    expect(replaceComposerTriggerSpan(text, selected, "@src/my folder ").text).toBe(
      "ask @src/my folder review this",
    );
  });

  it("narrows a root-level spaced file prefix without consuming trailing prose", () => {
    const text = "ask @my review this";
    const trigger = detectComposerTrigger(text, text.length)!;
    const selected = composerTriggerForSelection(trigger, "my file", "file");

    expect(selected.query).toBe("my ");
    expect(replaceComposerTriggerSpan(text, selected, "@my file ").text).toBe(
      "ask @my file review this",
    );
    expect(composerTriggerForSelection(trigger, "my file", "mention")).toEqual(trigger);
  });

  it("preserves prose after an intermediate path-component match", () => {
    const text = "ask @my review this";
    const trigger = detectComposerTrigger(text, text.length)!;
    const selected = composerTriggerForSelection(trigger, "src/my/file", "file");

    expect(selected.query).toBe("my ");
    expect(replaceComposerTriggerSpan(text, selected, "@src/my/file ").text).toBe(
      "ask @src/my/file review this",
    );
  });

  it("preserves prose after a nested basename prefix match", () => {
    const text = "ask @my review this";
    const trigger = detectComposerTrigger(text, text.length)!;
    const selected = composerTriggerForSelection(trigger, "docs/my file", "file");

    expect(selected.query).toBe("my ");
    expect(replaceComposerTriggerSpan(text, selected, "@docs/my file ").text).toBe(
      "ask @docs/my file review this",
    );
  });

  it("preserves prose after a substring path-component match", () => {
    const text = "ask @ead review this";
    const trigger = detectComposerTrigger(text, text.length)!;
    const selected = composerTriggerForSelection(trigger, "docs/README", "file");

    expect(selected.query).toBe("ead ");
    expect(replaceComposerTriggerSpan(text, selected, "@docs/README ").text).toBe(
      "ask @docs/README review this",
    );
  });

  it("recognizes a confirmed @ token as a terminated trigger", () => {
    const text = "ask @src/foo.ts about this";
    const trigger = detectComposerTrigger(text, text.length)!;
    const confirm = { isFile: (body: string) => body === "src/foo.ts" };

    expect(composerTriggerHasConfirmedPrefix(text, trigger, confirm)).toBe(true);
    expect(composerTriggerHasConfirmedPrefix("ask @src/foo.ts", detectComposerTrigger("ask @src/foo.ts", 15)!, confirm)).toBe(false);
  });

  it("recognizes a confirmed file token with spaces as terminated", () => {
    const text = "ask @src/my folder about this";
    const trigger = detectComposerTrigger(text, text.length)!;
    const confirm = { isFile: (body: string) => body === "src/my folder" };

    expect(composerTriggerHasConfirmedPrefix(text, trigger, confirm)).toBe(true);
    expect(findConfirmedComposerTokens(text, {
      ...confirm,
      isCommand: () => false,
    })).toEqual([{ start: 4, end: 18, kind: "file" }]);
  });

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

describe("findConfirmedComposerTokens", () => {
  const confirm = {
    isFile: (body: string) => body === "src/foo.ts",
    isCommand: (body: string) => body === "test",
  };

  it("finds confirmed file and command tokens with correct spans", () => {
    const text = "fix @src/foo.ts then run /test now";
    expect(findConfirmedComposerTokens(text, confirm)).toEqual([
      { start: 4, end: 15, kind: "file" },
      { start: 25, end: 30, kind: "command" },
    ]);
  });

  it("skips unconfirmed tokens and mid-word matches", () => {
    const text = "mail user@doma or run /unknown with @other.ts";
    expect(findConfirmedComposerTokens(text, confirm)).toEqual([]);
  });

  it("requires a word boundary before the trigger char", () => {
    expect(findConfirmedComposerTokens("path/@src/foo.ts", confirm)).toEqual([]);
    expect(findConfirmedComposerTokens("a/test", confirm)).toEqual([]);
  });

  it("finds confirmed files whose names contain an at sign", () => {
    const token = "@assets/icon@2x.png";
    const text = `fix ${token} then continue`;
    expect(findConfirmedComposerTokens(text, {
      isFile: (body: string) => body === "assets/icon@2x.png",
      isCommand: () => false,
    })).toEqual([{ start: 4, end: 4 + token.length, kind: "file" }]);
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
