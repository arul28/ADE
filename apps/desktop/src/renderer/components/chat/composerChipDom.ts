// Serializing the composer's contentEditable DOM back to draft text.
//
// One walker, used by two callers that must never disagree: `serializeRichEditor`
// (what gets sent) and the clipboard writer (what gets copied). They were two
// copies of the same traversal, and the copy had ALREADY lost the chat-context
// placeholder handling below — so copying a selection containing a chat-context
// chip produced different text than sending the same draft.

/** Chip kind whose text is stashed behind a placeholder across whitespace collapsing. */
const CHAT_CONTEXT_CHIP = "chat-context";

export type SerializedComposerDom = {
  text: string;
  /** Display label per chip token, for callers that rebuild pills elsewhere. */
  labels: Map<string, string>;
};

/**
 * Walk `root` and produce the draft text it represents.
 *
 * A chip contributes its serialized `data-composer-chip-text`, not its visible
 * label. A chat-context chip's text is protected behind a placeholder across the
 * whitespace-collapsing pass, because that text can contain runs of spaces the
 * collapse would otherwise eat.
 */
export function serializeComposerDom(root: Node): SerializedComposerDom {
  const parts: string[] = [];
  const labels = new Map<string, string>();
  const preservedChipText = new Map<string, string>();

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;

    const chipText = node.dataset.composerChipText;
    if (chipText != null) {
      if (node.dataset.composerChip === CHAT_CONTEXT_CHIP) {
        const placeholder = `\u0000ctx${preservedChipText.size}\u0000`;
        preservedChipText.set(placeholder, chipText);
        parts.push(placeholder);
      } else {
        parts.push(chipText);
      }
      const label = node.querySelector<HTMLElement>("[data-composer-chip-label]")?.textContent?.trim();
      if (label && label !== chipText) labels.set(chipText, label);
      return;
    }

    if (
      node.dataset.iosContextId
      || node.dataset.appControlContextId
      || node.dataset.builtInBrowserContextId
    ) {
      parts.push(" ");
      return;
    }
    if (node.tagName === "BR") {
      parts.push("\n");
      return;
    }
    node.childNodes.forEach(visit);
    if (node.tagName === "DIV" || node.tagName === "P") parts.push("\n");
  };
  root.childNodes.forEach(visit);

  let text = parts
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n");
  for (const [placeholder, value] of preservedChipText) {
    // A function replacer, because a string replacement interprets `$&`, "$`",
    // `$'` and `$$`. The value is captured agent output — a sed expression or a
    // regex snippet is routine in a coding tool — and `$&` would otherwise
    // expand to the placeholder itself, sending a literal control sequence to
    // the agent in place of the quoted text.
    text = text.replace(placeholder, () => value);
  }
  return { text, labels };
}

/** Return a DOM selection point as an offset in the canonical serialized text. */
export function serializedComposerOffsetAt(
  root: HTMLElement,
  container: Node,
  offset: number,
  serializedText = serializeComposerDom(root).text,
): number {
  if (container !== root && !root.contains(container)) return serializedText.length;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  const prefix = serializeComposerDom(range.cloneContents()).text;
  let matchingLength = 0;
  while (
    matchingLength < prefix.length
    && matchingLength < serializedText.length
    && prefix[matchingLength] === serializedText[matchingLength]
  ) {
    matchingLength += 1;
  }
  return matchingLength;
}

/**
 * Return the DOM point for an offset in the serialized draft text.
 *
 * The inverse of `serializedComposerOffsetAt`, for the one case that needs it:
 * the composer switches from the plain textarea to the rich editor and must put
 * the caret back where it was. A chip counts as its serialized text, and an
 * offset inside or at the end of a chip resolves to the point after the chip,
 * because the caret cannot stand inside a contentEditable="false" node.
 */
export function composerDomPointAtSerializedOffset(
  root: HTMLElement,
  offset: number,
): { node: Node; offset: number } {
  let remaining = Math.max(0, offset);
  let found: { node: Node; offset: number } | null = null;

  const pointAfter = (node: Node): { node: Node; offset: number } => {
    const parent = node.parentNode ?? root;
    return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node) + 1 };
  };

  const visit = (node: Node) => {
    if (found) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) {
        found = { node, offset: remaining };
        return;
      }
      remaining -= length;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const chipText = node.dataset.composerChipText;
    if (chipText != null) {
      if (remaining <= chipText.length) {
        found = pointAfter(node);
        return;
      }
      remaining -= chipText.length;
      return;
    }
    if (node.tagName === "BR") {
      if (remaining === 0) {
        found = { node: node.parentNode ?? root, offset: Array.prototype.indexOf.call((node.parentNode ?? root).childNodes, node) };
        return;
      }
      remaining -= 1;
      return;
    }
    node.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  return found ?? { node: root, offset: root.childNodes.length };
}

// Loose text inside these is already a chip (or a context card) and is left alone.
const HYDRATE_SKIP_SELECTOR =
  "[data-composer-chip], [data-ios-context-id], [data-app-control-context-id], [data-built-in-browser-context-id]";

/**
 * Turn every serialized block a parser finds in the editor's loose text into
 * the chip `createNode` builds for it. Returns whether anything changed.
 */
export function hydrateTokenChipsInEditor<Match extends { start: number; end: number }>(
  editor: HTMLElement,
  options: {
    has: (text: string) => boolean;
    parse: (text: string) => Match[];
    createNode: (match: Match) => HTMLElement;
  },
): boolean {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(HYDRATE_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return options.has(node.textContent ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  let changed = false;
  for (const node of nodes) {
    const text = node.textContent ?? "";
    const matches = options.parse(text);
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      if (match.start > offset) fragment.append(document.createTextNode(text.slice(offset, match.start)));
      fragment.append(options.createNode(match));
      offset = match.end;
    }
    if (offset < text.length) fragment.append(document.createTextNode(text.slice(offset)));
    node.replaceWith(fragment);
    changed = true;
  }
  return changed;
}
