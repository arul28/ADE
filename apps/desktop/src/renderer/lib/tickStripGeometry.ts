/**
 * The index <-> position maths shared by every tick strip in ADE.
 *
 * A tick strip maps N items onto a fixed-height column, then maps a pointer Y
 * back onto an index. The two directions MUST be exact inverses: if they drift
 * apart, the tick under the cursor is not the tick the strip highlights, and the
 * error grows with the item count.
 *
 * Both the chat user minimap and the PR commit tick pill need exactly this, and
 * each had grown its own line-for-line copy. One implementation is what keeps
 * the invariant to a single place.
 *
 * The strip is the item span itself, not the box around it, so callers pass the
 * strip's own rectangle — not the padded hit area.
 */

/**
 * Position of `index` as a percentage of the strip height.
 *
 * Index 0 sits at 0% and the last index at 100%. The ORDER is the caller's: a
 * caller that passes items newest-first gets the newest item at 0%.
 */
export function tickTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) return 0;
  const clamped = Math.max(0, Math.min(index, itemCount - 1));
  return (clamped / (itemCount - 1)) * 100;
}

/**
 * Which index a pointer Y lands on.
 *
 * Derived from Y across the whole strip rather than from per-tick hit boxes, so
 * spacing can compress to sub-pixel without any item becoming unreachable. The
 * pointer is clamped, so a press in the surrounding padding selects the first or
 * last item instead of falling into dead space.
 */
export function tickIndexFromPointer(input: {
  readonly itemCount: number;
  readonly stripTop: number;
  readonly stripHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0) return null;
  if (!(input.stripHeight > 0)) return null;
  if (input.itemCount === 1) return 0;
  const progress = Math.max(0, Math.min(1, (input.pointerY - input.stripTop) / input.stripHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}
