/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { formatChatOutputContextBlock } from "../../../shared/chatOutputContext";
import { hydrateChatOutputContextChipsInEditor } from "./composerChatOutputContext";

describe("hydrateChatOutputContextChipsInEditor", () => {
  it("replaces a context block with a chip that shows the quoted text", () => {
    const editor = document.createElement("div");
    const block = formatChatOutputContextBlock("retry the lane")!;
    editor.textContent = `please ${block} thanks`;
    expect(hydrateChatOutputContextChipsInEditor(editor)).toBe(true);
    const chip = editor.querySelector<HTMLElement>("[data-composer-chip='chat-context']");
    // The chip carries the first words of the quote, so the user can tell two
    // quotes apart at a glance; the full quote stays on the dataset.
    expect(chip?.textContent).toBe("retry the lane");
    expect(chip?.getAttribute("aria-label")).toContain("Quote");
    expect(chip?.dataset.chatOutputQuote).toBe("retry the lane");
    expect(editor.textContent).toContain("please");
    expect(editor.textContent).toContain("thanks");
    expect(editor.textContent).not.toContain("<ade-chat-context>");
  });
});
