/**
 * How a `list` draws more rows than it shows at once.
 *
 * The reduction this closes is D7/M9 in the parity map: a plugin list stopped
 * dead at 100 rows while the built-in it replaced paged to 500, and it stopped
 * SILENTLY — the reader saw a complete-looking list that was not one. Two
 * things fix that, and both live here so all four clients cannot disagree:
 *
 * 1. **A page.** A list draws {@link VOCAB_LIMITS.listPageSize} rows and adds
 *    another page each time the reader asks, up to
 *    {@link VOCAB_LIMITS.maxListItems}.
 * 2. **A sentence.** The list says how many of how many it is drawing, and says
 *    it before the reader has to guess.
 *
 * The page count is CLIENT-LOCAL. It is not panel state, it never reaches a
 * `where`, it never signs, and it never rides on an action payload — the same
 * terms a folded `group` is held on, and for the same reason: how far down a
 * list a reader has walked is a statement about their screen, not about which
 * rows the panel is showing.
 *
 * **Filter first, page second.** Paging extends the CAP, and a binding's
 * `where` has already run by the time anything here is called — see
 * `boundRowEntries`. Reversing the two would page a truncated window, so a
 * reader pressing "Show more" on a filtered list would be handed rows the
 * filter had already rejected.
 */

import { VOCAB_LIMITS, bindingKey, type VocabListNode } from "./vocabularyNodes";

/**
 * The ceiling a client reads a bound collection up to when the binding names no
 * `limit` of its own.
 *
 * Equal to {@link VOCAB_LIMITS.maxListItems} on purpose: a client that drew up
 * to 250 rows but fetched fewer would page into rows it did not have and stop
 * early with no way to say why. Passed explicitly rather than left to the
 * host's own default, which is 200 and is not this contract's number.
 */
export const VOCAB_PANEL_READ_LIMIT = VOCAB_LIMITS.maxListItems;

/**
 * What a client remembers one list's page count under.
 *
 * Content-derived, never positional, for the reason {@link vocabGroupKey} is:
 * a plugin republishing its panel with one more node above the list has not
 * put the reader back on page one. A bound list is identified by what it reads,
 * a selectable one by the key its ticks live under, and a literal one by its
 * first row — which is the most identity a hand-written list has.
 */
export function vocabListKey(node: VocabListNode): string {
  if (node.bind) return `bind:${bindingKey(node.bind)}`;
  if (node.selectable) return `sel:${node.selectable.stateKey}`;
  const first = node.items?.[0];
  return `items:${first?.key ?? first?.title ?? ""}`;
}

/** How many rows a list draws right now, and what it must say about that. */
export type VocabListPage = {
  /** Rows to draw, filters already applied. */
  drawn: number;
  /** Rows the client is holding, filters already applied. */
  total: number;
  /** More rows are held than are drawn: the reader may ask for another page. */
  hasMore: boolean;
  /**
   * `total` is a floor rather than a count.
   *
   * True when the client holds as many rows as it is allowed to hold, which
   * means the collection may have more and this client cannot know. There is no
   * count read in the host's data store — `listCollection` returns rows and
   * nothing else — so the honest move is to stop claiming a total rather than
   * to invent one.
   */
  totalIsFloor: boolean;
};

/**
 * Resolve one list's page.
 *
 * `pages` is the reader's own count and starts at 1. Values below 1 are read as
 * 1 rather than refused: a client that lost its page map mid-session should
 * draw the first page, not an empty list.
 */
export function vocabListPage(total: number, pages: number): VocabListPage {
  const held = Math.max(0, Math.trunc(total));
  const step = Math.max(1, Math.trunc(pages));
  // What the list may EVER draw, which is not the same as what it holds: a node
  // that combines literal `items` with a `bind` can hold more rows than the
  // ceiling allows. Without this, the last page would offer a "Show more" that
  // drew nothing — a control that does nothing, which is the failure every other
  // affordance in this vocabulary is written to avoid.
  const drawable = Math.min(held, VOCAB_LIMITS.maxListItems);
  const drawn = Math.min(drawable, step * VOCAB_LIMITS.listPageSize);
  return {
    drawn,
    total: held,
    hasMore: drawn < drawable,
    totalIsFloor: held >= VOCAB_LIMITS.maxListItems,
  };
}

/** The next page count, clamped so pressing "Show more" past the end is inert. */
export function vocabListNextPage(total: number, pages: number): number {
  const page = vocabListPage(total, pages);
  if (!page.hasMore) return Math.max(1, Math.trunc(pages));
  return Math.max(1, Math.trunc(pages)) + 1;
}

/**
 * The one sentence every client puts above the control, or `null` when a list
 * is drawing everything it holds and has nothing to explain.
 *
 * The wording follows what is actually knowable:
 *
 * - `Showing 100 of 143` — the client holds 143 rows and that is the true total.
 * - `Showing 100` — the client holds as many as it may, so a total would be a
 *   guess dressed as a fact.
 * - `Showing the first 250` — everything held is drawn and the ceiling is why
 *   there is no more. Silence here is what made a truncated list look complete.
 */
export function vocabListPageLabel(page: VocabListPage): string | null {
  if (page.hasMore) {
    return page.totalIsFloor ? `Showing ${page.drawn}` : `Showing ${page.drawn} of ${page.total}`;
  }
  return page.totalIsFloor ? `Showing the first ${page.drawn}` : null;
}

/** The words on the control itself, so four clients cannot each invent one. */
export const VOCAB_LIST_SHOW_MORE_LABEL = "Show more";
