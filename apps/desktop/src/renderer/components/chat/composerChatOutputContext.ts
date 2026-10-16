import {
  CHAT_OUTPUT_CONTEXT_CHIP_LABEL,
  extractChatOutputContextQuote,
  hasChatOutputContext,
  parseChatOutputContextBlocks,
} from "../../../shared/chatOutputContext";
import { hydrateTokenChipsInEditor } from "./composerChipDom";

const CHIP_CLASS =
  "mx-0.5 inline-flex max-w-[300px] translate-y-[1px] cursor-default items-center gap-1.5 rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] py-0.5 pl-1.5 pr-2 font-sans text-[length:calc(var(--chat-font-size)*11.5/14)] leading-5 text-[color:color-mix(in_srgb,var(--chat-accent)_45%,var(--chat-fg,#e6e6e6))] align-baseline outline-none transition-colors hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] focus:ring-1 focus:ring-[color:color-mix(in_srgb,var(--chat-accent)_45%,transparent)]";

/** The first words of a quote, on one line — what the chip shows instead of a bare label. */
export function chatOutputContextSnippet(quote: string, max = 48): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function createChatOutputContextChipNode(block: string): HTMLElement {
  const quote = extractChatOutputContextQuote(block);
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.tabIndex = 0;
  chip.role = "button";
  chip.dataset.composerChip = "chat-context";
  chip.dataset.composerChipText = block;
  chip.dataset.chatOutputQuote = quote;
  chip.className = CHIP_CLASS;
  chip.title = quote || CHAT_OUTPUT_CONTEXT_CHIP_LABEL;
  chip.setAttribute("aria-label", `${CHAT_OUTPUT_CONTEXT_CHIP_LABEL}: ${quote}`.trim());
  // A short accent bar, the same mark the sent message's quote card carries.
  const bar = document.createElement("span");
  bar.setAttribute("aria-hidden", "true");
  bar.className = "h-3 w-[3px] shrink-0 rounded-full bg-[var(--chat-accent)] opacity-80";
  const label = document.createElement("span");
  label.className = "truncate italic";
  label.textContent = chatOutputContextSnippet(quote) || CHAT_OUTPUT_CONTEXT_CHIP_LABEL;
  chip.append(bar, label);
  return chip;
}

export function hydrateChatOutputContextChipsInEditor(editor: HTMLElement): boolean {
  return hydrateTokenChipsInEditor(editor, {
    has: hasChatOutputContext,
    parse: parseChatOutputContextBlocks,
    createNode: (match) => createChatOutputContextChipNode(match.block),
  });
}
