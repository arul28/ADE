/**
 * What the placement a page was given lets it draw.
 *
 * One question, asked in three entries, so the answer cannot drift between
 * them: does the HOST already draw a frame and a title around this page?
 *
 * `composer-picker` and `popover` are the two placements where it does. Both
 * are chrome the app opened — a card over the composer, a popover anchored to
 * the row the reader pressed — and both are sized by the host. A page that
 * portals its own dialog into one of them paints a second header over the
 * first, a `bg-black/55` backdrop across the reader's window, and a centred box
 * measured against the guest viewport rather than against the frame: a 360×420
 * popover asking for `min(1760px, 100vw - 28px)` by `min(940px, 100dvh - 28px)`.
 *
 * Every other placement gets the chrome, and for the same reason rather than by
 * omission. An `overlay` is a page floating over the app with nothing around
 * it; a transcript `chat-card` draws a row, not a dialog; a `tab`, a `pane` and
 * a `drawer` are the page's own surface. In all of them the pane IS the frame.
 */

import type { PluginWebviewPlacement } from "../bridge";

/** The placements the host frames and titles itself. */
const HOST_FRAMED: readonly PluginWebviewPlacement[] = ["composer-picker", "popover"];

/**
 * Whether this page should draw its own dialog chrome.
 *
 * An unknown or absent placement answers `true`: a page that guessed
 * "chromeless" for a placement nobody named would draw a headerless list with
 * no way out of it, and a redundant header is a smaller failure than a dead
 * end.
 */
export function drawsOwnChrome(placement: PluginWebviewPlacement | undefined): boolean {
  return !placement || !HOST_FRAMED.includes(placement);
}
