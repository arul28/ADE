import { describe, expect, it } from "vitest";

import { applyAction, type ToolbarAction } from "./PrMarkdownEditor";

// applyAction only reads value / selectionStart / selectionEnd off the textarea,
// so a minimal stub is enough to exercise the selection math without a DOM.
function ta(value: string, selStart: number, selEnd = selStart): HTMLTextAreaElement {
  return { value, selectionStart: selStart, selectionEnd: selEnd } as unknown as HTMLTextAreaElement;
}

function run(value: string, selStart: number, selEnd: number, action: ToolbarAction) {
  return applyAction(ta(value, selStart, selEnd), action);
}

describe("applyAction — inline wrap transforms", () => {
  it("wraps the selection in bold markers and selects only the inner text", () => {
    // "hello world", select "world" (6..11)
    const r = run("hello world", 6, 11, "bold");
    expect(r.value).toBe("hello **world**");
    // Selection should span the inner "world", excluding the ** markers.
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("world");
  });

  it("inserts a placeholder for an empty selection (italic) and selects the placeholder", () => {
    const r = run("", 0, 0, "italic");
    expect(r.value).toBe("_italic text_");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("italic text");
  });

  it("wraps inline code around the selection", () => {
    const r = run("call foo here", 5, 8, "code");
    expect(r.value).toBe("call `foo` here");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("foo");
  });
});

describe("applyAction — link", () => {
  it("builds [text](url) and selects the url placeholder", () => {
    const r = run("see docs", 4, 8, "link");
    expect(r.value).toBe("see [docs](url)");
    // The caret lands on the "url" placeholder so the user can type the target.
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("url");
  });

  it("uses a 'text' placeholder when nothing is selected", () => {
    const r = run("", 0, 0, "link");
    expect(r.value).toBe("[text](url)");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("url");
  });
});

describe("applyAction — line-prefix transforms", () => {
  it("prefixes a single line for a bulleted list and selects the whole prefixed block", () => {
    const r = run("item", 0, 4, "ul");
    expect(r.value).toBe("- item");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("- item");
  });

  it("numbers each line incrementally for an ordered list across a multi-line selection", () => {
    const value = "one\ntwo\nthree";
    // Select across all three lines.
    const r = run(value, 0, value.length, "ol");
    expect(r.value).toBe("1. one\n2. two\n3. three");
  });

  it("expands a mid-line selection to whole lines before prefixing (quote)", () => {
    const value = "alpha\nbeta\ngamma";
    // Caret sits inside "beta" (positions 7..8) — should still prefix the full "beta" line only.
    const r = run(value, 7, 8, "quote");
    expect(r.value).toBe("alpha\n> beta\ngamma");
  });

  it("prefixes a heading marker on the selected line", () => {
    const r = run("Title", 0, 5, "heading");
    expect(r.value).toBe("## Title");
  });
});
