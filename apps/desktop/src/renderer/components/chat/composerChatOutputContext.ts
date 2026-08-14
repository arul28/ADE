import {
  CHAT_OUTPUT_CONTEXT_CHIP_LABEL,
  extractChatOutputContextQuote,
  hasChatOutputContext,
  parseChatOutputContextBlocks,
} from "../../../shared/chatOutputContext";

const CHIP_CLASS =
  "mx-0.5 inline-flex max-w-[280px] translate-y-[1px] cursor-default items-center gap-1.5 rounded-md border border-violet-300/24 bg-violet-500/13 px-2 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] font-medium leading-5 text-violet-100/90 align-baseline outline-none transition-colors hover:border-violet-300/38 hover:bg-violet-500/18 focus:border-violet-200/45 focus:ring-1 focus:ring-violet-300/30";

export function createChatOutputContextChipNode(block: string): HTMLElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.tabIndex = 0;
  chip.role = "button";
  chip.dataset.composerChip = "chat-context";
  chip.dataset.composerChipText = block;
  chip.dataset.chatOutputQuote = extractChatOutputContextQuote(block);
  chip.className = CHIP_CLASS;
  chip.title = chip.dataset.chatOutputQuote || CHAT_OUTPUT_CONTEXT_CHIP_LABEL;
  chip.setAttribute(
    "aria-label",
    `${CHAT_OUTPUT_CONTEXT_CHIP_LABEL}. ${chip.dataset.chatOutputQuote || ""}`.trim(),
  );
  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = CHAT_OUTPUT_CONTEXT_CHIP_LABEL;
  chip.appendChild(label);
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
