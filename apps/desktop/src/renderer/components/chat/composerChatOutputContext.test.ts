/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { formatChatOutputContextBlock } from "../../../shared/chatOutputContext";
import { hydrateChatOutputContextChipsInEditor } from "./composerChatOutputContext";

describe("hydrateChatOutputContextChipsInEditor", () => {
  it("replaces a context block with a Chat context chip", () => {
    const editor = document.createElement("div");
    const block = formatChatOutputContextBlock("retry the lane")!;
    editor.textContent = `please ${block} thanks`;
    expect(hydrateChatOutputContextChipsInEditor(editor)).toBe(true);
    const chip = editor.querySelector<HTMLElement>("[data-composer-chip='chat-context']");
    expect(chip?.textContent).toBe("Chat context");
    expect(chip?.dataset.chatOutputQuote).toBe("retry the lane");
    expect(editor.textContent).toContain("please");
    expect(editor.textContent).toContain("thanks");
    expect(editor.textContent).not.toContain("<ade-chat-context>");
  });
});
