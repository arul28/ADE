import {
  CHAT_OUTPUT_CONTEXT_CHIP_LABEL,
  extractChatOutputContextQuote,
  hasChatOutputContext,
  parseChatOutputContextBlocks,
} from "../../../shared/chatOutputContext";

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
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        !parent
        || parent.closest("[data-composer-chip], [data-ios-context-id], [data-app-control-context-id], [data-built-in-browser-context-id]")
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return hasChatOutputContext(node.textContent ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  if (!nodes.length) return false;
  for (const node of nodes) {
    const text = node.textContent ?? "";
    const matches = parseChatOutputContextBlocks(text);
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      if (match.start > offset) fragment.append(document.createTextNode(text.slice(offset, match.start)));
      fragment.append(createChatOutputContextChipNode(match.block));
      offset = match.end;
    }
    if (offset < text.length) fragment.append(document.createTextNode(text.slice(offset)));
    node.replaceWith(fragment);
  }
  return true;
}
