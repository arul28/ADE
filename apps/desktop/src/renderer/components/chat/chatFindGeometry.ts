/**
 * Where find's matches are on the page, for a chat transcript: the painted
 * occurrences in a mounted row, which row is first in view, and where a new
 * query starts. Plain DOM reads; no React state.
 */
import { findTextRanges } from "../../lib/findText";
import { CHAT_FIND_TEXT_ATTRIBUTE, chatFindMatchAt, chatFindStartIndex, type ChatFindMatches } from "./chatFind";

/** A match by row and occurrence: stays on the same words when matches move elsewhere. */
export type FindSelection = { key: string; occurrence: number };

export const CHAT_ROW_SELECTOR = "[data-chat-row-key]";
export const chatRowSelectorFor = (key: string) => `[data-chat-row-key="${CSS.escape(key)}"]`;

/** The painted occurrences in one mounted row, in reading order. */
export function paintedRowRanges(row: Element, foldedNeedle: string): Range[] {
  const ranges: Range[] = [];
  for (const scope of row.querySelectorAll<HTMLElement>(`[${CHAT_FIND_TEXT_ATTRIBUTE}]`)) {
    ranges.push(...findTextRanges(scope, foldedNeedle));
  }
  return ranges;
}

/** Position (in `order`) of the first transcript row in or below the top of `scroll`. */
function firstRowInView(scroll: Element, content: Element, order: ReadonlyMap<string, number>): number | null {
  const viewTop = scroll.getBoundingClientRect().top;
  for (const element of content.querySelectorAll<HTMLElement>(CHAT_ROW_SELECTOR)) {
    if (element.getBoundingClientRect().bottom <= viewTop + 1) continue;
    // A drawn row that is not a transcript row (a fold, a merged run): the
    // next transcript row below it stands in.
    const position = order.get(element.dataset.chatRowKey ?? "");
    if (position !== undefined) return position;
  }
  return null;
}

/**
 * The first match in or below the view. Inside a long reply that starts above
 * the view, that is the first occurrence on screen; a reply whose matches are
 * all above the view hands over to the next match.
 *
 * Counts come from the row's text, the painted ranges from its DOM. They agree
 * except where the renderer rewrites text (a model id drawn as its display
 * name, a timestamp reformatted); only when they agree is a DOM range's
 * position also its occurrence number.
 */
export function startSelection(input: {
  counted: ChatFindMatches;
  scroll: Element | null;
  content: Element | null;
  order: ReadonlyMap<string, number>;
  foldedNeedle: string;
}): FindSelection | null {
  const { counted, scroll, content, order, foldedNeedle } = input;
  const fromOrder = scroll && content ? firstRowInView(scroll, content, order) : null;
  const at = chatFindStartIndex(counted, fromOrder, (key) => order.get(key));
  const first = at == null ? null : chatFindMatchAt(counted, at);
  if (!first || !scroll || !content) return first;
  const row = content.querySelector(chatRowSelectorFor(first.key));
  const entry = counted.entries.find((candidate) => candidate.key === first.key);
  if (!row || !entry) return first;
  const ranges = paintedRowRanges(row, foldedNeedle);
  if (ranges.length !== entry.count) return first;
  const viewTop = scroll.getBoundingClientRect().top;
  const onScreen = ranges.findIndex((range) => range.getBoundingClientRect().bottom > viewTop);
  if (onScreen >= 0) return { key: first.key, occurrence: onScreen };
  const after = entry.start + entry.count;
  return chatFindMatchAt(counted, after < counted.total ? after : 0);
}
