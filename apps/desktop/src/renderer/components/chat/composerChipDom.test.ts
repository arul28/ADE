/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { serializeComposerDom, serializedComposerOffsetAt } from "./composerChipDom";

describe("serialized composer selection offsets", () => {
  it("counts a chip's canonical token instead of its display label", () => {
    const editor = document.createElement("div");
    editor.innerHTML = [
      '<span data-composer-chip="mention" data-composer-chip-text="@chat:chat-1">',
      '<span data-composer-chip-label>a b c</span></span>',
      " follow up",
    ].join("");
    const followUp = editor.lastChild!;
    const serialized = serializeComposerDom(editor).text;

    expect(serialized).toBe("@chat:chat-1 follow up");
    expect(serializedComposerOffsetAt(editor, followUp, followUp.textContent!.length, serialized))
      .toBe(serialized.length);
  });

  it("maps a caret after a chip to the serialized token boundary", () => {
    const editor = document.createElement("div");
    editor.innerHTML = [
      '<span data-composer-chip="mention" data-composer-chip-text="@chat:chat-1">',
      '<span data-composer-chip-label>a b c</span></span>',
      " follow up",
    ].join("");
    const serialized = serializeComposerDom(editor).text;

    expect(serializedComposerOffsetAt(editor, editor, 1, serialized)).toBe("@chat:chat-1".length);
  });
});
