export const ASSISTANT_OUTPUT_SELECTOR = "[data-assistant-output]";

export type AssistantOutputSelection = {
  text: string;
  rect: DOMRect;
};

function nodeElement(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

export function selectionIsInsideAssistantOutput(
  selection: Selection,
  root: HTMLElement,
): boolean {
  if (!selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  const start = nodeElement(range.startContainer);
  const end = nodeElement(range.endContainer);
  if (!start || !end || !root.contains(start) || !root.contains(end)) return false;
  return Boolean(start.closest(ASSISTANT_OUTPUT_SELECTOR) && end.closest(ASSISTANT_OUTPUT_SELECTOR));
}

export function readAssistantOutputSelection(
  root: HTMLElement | null,
  selection: Selection | null = typeof window === "undefined" ? null : window.getSelection(),
): AssistantOutputSelection | null {
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return null;
  if (!selectionIsInsideAssistantOutput(selection, root)) return null;
  const text = selection.toString().replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  const range = selection.getRangeAt(0);
  const rect = typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : new DOMRect(8, 8, 0, 0);
  return { text, rect };
}
