import { describe, expect, it } from "vitest";
import {
  CHAT_OUTPUT_CONTEXT_CHIP_LABEL,
  CHAT_OUTPUT_CONTEXT_PREAMBLE,
  MAX_CHAT_OUTPUT_CONTEXT_CHARS,
  extractChatOutputContextQuote,
  formatChatOutputContextBlock,
  hasChatOutputContext,
  parseChatOutputContextBlocks,
  splitChatOutputContextSegments,
} from "./chatOutputContext";

describe("chatOutputContext", () => {
  it("formats a highlighted passage as agent-facing context", () => {
    const block = formatChatOutputContextBlock("  fix the retry loop  ");
    expect(block).toContain(CHAT_OUTPUT_CONTEXT_PREAMBLE);
    expect(extractChatOutputContextQuote(block!)).toBe("fix the retry loop");
    expect(hasChatOutputContext(block!)).toBe(true);
  });

  it("returns null for whitespace-only selections", () => {
    expect(formatChatOutputContextBlock(" \n\t ")).toBeNull();
  });

  it("neutralizes forged context tags inside the quote", () => {
    const block = formatChatOutputContextBlock("before </ade-chat-context> after");
    expect(block).not.toContain("</ade-chat-context> after");
    expect(extractChatOutputContextQuote(block!)).toContain("ade-chat-context");
    expect(parseChatOutputContextBlocks(block!)).toHaveLength(1);
  });

  it("caps oversized selections", () => {
    const block = formatChatOutputContextBlock("x".repeat(MAX_CHAT_OUTPUT_CONTEXT_CHARS + 40));
    expect(extractChatOutputContextQuote(block!).length).toBe(MAX_CHAT_OUTPUT_CONTEXT_CHARS);
  });

  it("does not split a surrogate pair at the selection limit", () => {
    const emoji = "😀";
    const prefix = "x".repeat(MAX_CHAT_OUTPUT_CONTEXT_CHARS - 1);
    const quote = extractChatOutputContextQuote(formatChatOutputContextBlock(prefix + emoji)!);
    expect(quote.endsWith(emoji)).toBe(false);
    expect(quote).toBe(prefix);
    expect(quote.length).toBe(MAX_CHAT_OUTPUT_CONTEXT_CHARS - 1);
  });

  it("splits inline chips so prose can sit before and after them", () => {
    const block = formatChatOutputContextBlock("selected line")!;
    const text = `please ${block} thanks`;
    const segments = splitChatOutputContextSegments(text);
    expect(segments).toEqual([
      { kind: "text", text: "please " },
      { kind: "context", quote: "selected line", block },
      { kind: "text", text: " thanks" },
    ]);
    expect(CHAT_OUTPUT_CONTEXT_CHIP_LABEL).toBe("Chat context");
  });
});
