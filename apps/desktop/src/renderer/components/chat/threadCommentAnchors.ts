import {
  MAX_THREAD_COMMENT_EXCERPT_CHARS,
  THREAD_COMMENT_CONTEXT_CHARS,
  collapseWhitespace,
  type ChatThreadCommentAnchor,
} from "../../../shared/threadComments";

/** The element a thread comment hangs off: one finished agent reply. */
export const THREAD_COMMENT_MESSAGE_SELECTOR = "[data-thread-comment-key]";

/**
 * The reply's visible text as one whitespace-collapsed string, with the DOM
 * position of every character in it. Anchors are stored in collapsed form so a
 * re-render that changes line breaks or indentation still finds them.
 */
type CollapsedText = {
  text: string;
  /** For each char of `text`: the text node and offset it came from. */
  positions: Array<{ node: Text; offset: number }>;
};

function collapsedTextOf(root: HTMLElement): CollapsedText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent?.closest("[data-thread-comment-ignore]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "";
  const positions: CollapsedText["positions"] = [];
  let lastWasSpace = true;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const raw = node.data;
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index]!;
      if (/\s/.test(char)) {
        if (lastWasSpace) continue;
        text += " ";
        lastWasSpace = true;
      } else {
        text += char;
        lastWasSpace = false;
      }
      positions.push({ node, offset: index });
    }
    // Block boundaries (cells, list items) often carry no whitespace text
    // node between them; treat each text node edge as a soft space so
    // "row1" + "row2" does not read as "row1row2".
    if (!lastWasSpace && node.parentElement && /^(TD|TH|LI|P|DIV|H\d|PRE|CODE)$/.test(node.parentElement.tagName)) {
      const last = positions[positions.length - 1];
      if (last) {
        text += " ";
        positions.push({ node: last.node, offset: last.node.data.length });
        lastWasSpace = true;
      }
    }
  }
  return { text, positions };
}

function collapsedIndexOf(collapsed: CollapsedText, node: Node, offset: number): number {
  // Find the first collapsed char at or after (node, offset) in document order.
  const probe = document.createRange();
  for (let index = 0; index < collapsed.positions.length; index += 1) {
    const position = collapsed.positions[index]!;
    probe.setStart(position.node, Math.min(position.offset, position.node.data.length));
    if (probe.comparePoint(node, offset) <= 0) return index;
  }
  return collapsed.text.length;
}

/** Captures a text anchor for the current selection inside one reply. */
export function captureTextAnchor(root: HTMLElement, range: Range): ChatThreadCommentAnchor | null {
  const collapsed = collapsedTextOf(root);
  let start = collapsedIndexOf(collapsed, range.startContainer, range.startOffset);
  let end = collapsedIndexOf(collapsed, range.endContainer, range.endOffset);
  // Trim the selection itself, so the stored context sits right against the
  // quote and still tells repeated quotes apart.
  while (start < end && collapsed.text[start] === " ") start += 1;
  while (end > start && collapsed.text[end - 1] === " ") end -= 1;
  if (end <= start) return null;
  const quote = collapsed.text.slice(start, end);
  return {
    kind: "text",
    quote,
    prefix: collapsed.text.slice(Math.max(0, start - THREAD_COMMENT_CONTEXT_CHARS), start),
    suffix: collapsed.text.slice(end, end + THREAD_COMMENT_CONTEXT_CHARS),
  };
}

function commonSuffixLength(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
  return count;
}

function commonPrefixLength(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1;
  return count;
}

/** Finds a stored anchor in a reply again. Null when the text is gone. */
export function resolveThreadCommentRange(root: HTMLElement, anchor: ChatThreadCommentAnchor): Range | null {
  if (anchor.kind === "table_row") {
    const row = tableRowFor(root, anchor.tableIndex, anchor.rowIndex);
    if (!row) return null;
    const range = document.createRange();
    range.selectNodeContents(row);
    return range;
  }
  const collapsed = collapsedTextOf(root);
  const quote = collapseWhitespace(anchor.quote);
  if (!quote) return null;
  let best = -1;
  let bestScore = -1;
  for (let at = collapsed.text.indexOf(quote); at >= 0; at = collapsed.text.indexOf(quote, at + 1)) {
    const score = commonSuffixLength(collapsed.text.slice(0, at), anchor.prefix)
      + commonPrefixLength(collapsed.text.slice(at + quote.length), anchor.suffix);
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
  }
  if (best < 0) return null;
  const first = collapsed.positions[best];
  const last = collapsed.positions[best + quote.length - 1];
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, Math.min(last.offset + 1, last.node.data.length));
  return range;
}

function tableRowFor(root: HTMLElement, tableIndex: number, rowIndex: number): HTMLTableRowElement | null {
  const table = root.querySelectorAll("table")[tableIndex];
  if (!table) return null;
  const body = table.tBodies[0];
  const rows = body ? Array.from(body.rows) : Array.from(table.rows).slice(1);
  return rows[rowIndex] ?? null;
}

/** The anchor for a table body row: its place in the reply plus its header/value pairs. */
export function captureTableRowAnchor(root: HTMLElement, row: HTMLTableRowElement): ChatThreadCommentAnchor | null {
  const table = row.closest("table");
  if (!table || !root.contains(table) || row.parentElement?.tagName !== "TBODY") return null;
  const tableIndex = Array.from(root.querySelectorAll("table")).indexOf(table);
  const rowIndex = Array.from(table.tBodies[0]?.rows ?? []).indexOf(row);
  if (tableIndex < 0 || rowIndex < 0) return null;
  const headerRow = table.tHead?.rows[0];
  const headers = headerRow ? Array.from(headerRow.cells).map((cell) => collapseWhitespace(cell.textContent ?? "")) : [];
  const cells = Array.from(row.cells).map((cell) => collapseWhitespace(cell.textContent ?? ""));
  if (!cells.some(Boolean)) return null;
  return { kind: "table_row", tableIndex, rowIndex, headers, cells };
}

/** The first words of a reply, for the agent-facing source label. */
export function messageExcerptOf(root: HTMLElement): string {
  return collapseWhitespace(root.textContent ?? "").slice(0, MAX_THREAD_COMMENT_EXCERPT_CHARS);
}
