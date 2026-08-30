import { tickIndexFromPointer, tickTopPercent } from "../../../lib/tickStripGeometry";

/**
 * Pure geometry + index maths for {@link PrCommitTickPill}.
 *
 * Modelled on `chat/chatUserMinimap.logic.ts`: everything needed to turn a
 * pointer Y into a commit index, and a commit index into a tick position, lives
 * here so it can be unit-tested without a DOM. The component measures, this
 * module decides.
 *
 * ── Why a vertical cluster, not a horizontal strip ──────────────────────────
 * The ticks stack DOWN, exactly like the chat minimap's marks
 * (`ChatUserMinimap`), because that is the vocabulary this app already teaches:
 * a column of hairlines you scrub with the pointer. Two earlier shapes were
 * wrong in opposite directions and both are ruled out by the maths here:
 *
 *  - A full-height rail pinned to the thread's left edge spread three commits
 *    across 600px of column — marks further apart than the content they index.
 *    The span cap below is what forbids that: the cluster is CLUSTERED, close
 *    like the chat minimap's, and never stretches to the column's height.
 *  - A horizontal strip read left→right, which broke the family resemblance to
 *    the minimap for no gain — the pill floats in a corner, and a corner badge
 *    that lengthens sideways is no cheaper than one that lengthens downward.
 *
 * Order is the CALLER'S: this module maps index 0 to the top of the strip and
 * the last index to the bottom, and never sorts. The rails pass newest-first,
 * because the pill is a corner index you glance at and the newest commit is the
 * one you almost always want nearest the anchor. The pill grows in HEIGHT with
 * the commit count up
 * to {@link PR_COMMIT_TICK_MAX_SPAN_PX}; past that the pitch compresses and the
 * box stops growing.
 *
 * The invariant the module is built around: tick positions are a PERCENTAGE of
 * the tick strip, and the pointer maps back through the SAME percentage. That
 * keeps the index↔tick mapping exactly 1:1, so pointer resolution, the hover
 * lens and the preview can never disagree about which commit is under the
 * cursor — no matter how far spacing compresses.
 */

/**
 * Hard floor. One tick is a dot: it carries no relative position, no spacing and
 * nothing to scrub through, so the whole pill is suppressed below this count.
 */
export const PR_COMMIT_TICK_MIN_COMMITS = 2;

/**
 * Commit count past which the ticks stop animating.
 *
 * Every tick is an absolutely positioned span with a width/colour transition,
 * and the lens recomputes all of them whenever the hovered index changes. Below
 * this the animation is what makes the lens readable; above it the strip is
 * denser than one tick per pixel, so the animation buys nothing and a mousemove
 * would kick hundreds of concurrent transitions.
 */
export const PR_COMMIT_TICK_ANIMATE_BELOW = 100;

/**
 * Centre-to-centre gap between vertically adjacent ticks at natural
 * (uncompressed) density. A 2px tick at a 5px pitch leaves a 3px gap — the
 * clumped-together spacing the chat minimap uses, not a spread-out ladder.
 */
export const PR_COMMIT_TICK_PITCH_PX = 5;

/**
 * Cap on the tick strip: the distance from the first tick's centre to the last.
 * Reached at 25 commits (24 × 5px). Past that the pill stops growing and the
 * pitch compresses instead.
 *
 * This is the "not spread fully vertically" rule in numeric form: the cluster
 * can never exceed 120px however long the PR gets, so it stays a badge floating
 * over the thread's top-left corner rather than a rail down its side.
 */
export const PR_COMMIT_TICK_MAX_SPAN_PX = 120;

/* ── Pill chrome ───────────────────────────────────────────────────────────── */

/** Fixed cross-axis size. Only the height tracks the commit count. */
export const PR_COMMIT_TICK_PILL_WIDTH_PX = 22;
export const PR_COMMIT_TICK_PILL_PADDING_Y_PX = 6;
/**
 * The hairline. Counted explicitly because the app is `box-sizing: border-box`:
 * without it the pill's content box comes up 2px short of the tick span and the
 * flex column silently squeezes the strip, which would desync tick placement
 * from the pointer mapping at the dense end.
 */
export const PR_COMMIT_TICK_PILL_BORDER_PX = 1;
/**
 * A 2-commit pill would otherwise be 19px tall — a speck that reads as a
 * rendering artefact. The floor pads the pill; the ticks stay clustered at their
 * natural pitch, centred, rather than being spread to fill it.
 */
export const PR_COMMIT_TICK_PILL_MIN_HEIGHT_PX = 34;
export const PR_COMMIT_TICK_PILL_RADIUS_PX = 7;

/* ── Tick marks ────────────────────────────────────────────────────────────── */

/** Along the stack axis: how thick one mark is. Tracks pitch, see below. */
export const PR_COMMIT_TICK_MIN_HEIGHT_PX = 1;
export const PR_COMMIT_TICK_MAX_HEIGHT_PX = 2;
/** Emphasis (active / force-push) is height AND width, never colour alone. */
export const PR_COMMIT_TICK_EMPHASIS_EXTRA_HEIGHT_PX = 1;
export const PR_COMMIT_TICK_EMPHASIS_WIDTH_PX = 13;
/** Lens widths by distance from the focused tick; last entry is "everything else". */
export const PR_COMMIT_TICK_LENS_WIDTHS_PX = [13, 11, 10, 9] as const;
/** Column the ticks are horizontally centred in. Fits the widest tick. */
export const PR_COMMIT_TICK_COLUMN_WIDTH_PX = 14;

/** A commit (or force-push marker) as the tick pill needs it. */
export type PrCommitTick = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  /** True for the force-push entry (a branch action, not a real commit). */
  forcePushed?: boolean;
  threadCount?: number;
  resolvedCount?: number;
};

/** The hard rule, in one place: nothing at all renders below two commits. */
export function shouldRenderCommitTickPill(commitCount: number): boolean {
  return commitCount >= PR_COMMIT_TICK_MIN_COMMITS;
}

/** Clamp an arbitrary number into a valid tick index; `null` when there are none. */
export function clampCommitIndex(index: number, commitCount: number): number | null {
  if (commitCount <= 0) return null;
  if (!Number.isFinite(index)) return null;
  return Math.max(0, Math.min(commitCount - 1, Math.round(index)));
}

/**
 * Centre-to-centre spacing for the current count: the natural pitch until the
 * strip hits its cap, then whatever fits.
 */
export function resolveCommitTickPitchPx(commitCount: number): number {
  if (!shouldRenderCommitTickPill(commitCount)) return 0;
  return Math.min(PR_COMMIT_TICK_PITCH_PX, PR_COMMIT_TICK_MAX_SPAN_PX / (commitCount - 1));
}

/** First tick centre → last tick centre, in px. Zero when the pill is suppressed. */
export function resolveCommitTickSpanPx(commitCount: number): number {
  if (!shouldRenderCommitTickPill(commitCount)) return 0;
  return (commitCount - 1) * resolveCommitTickPitchPx(commitCount);
}

/** Chrome the pill carries around its tick strip, both edges counted. */
export const PR_COMMIT_TICK_PILL_CHROME_PX =
  (PR_COMMIT_TICK_PILL_PADDING_Y_PX + PR_COMMIT_TICK_PILL_BORDER_PX) * 2;

/**
 * Outer (border-box) pill height. Grows with the commit count up to
 * `MAX_SPAN + CHROME` — 134px — and never drops below the minimum.
 */
export function resolveCommitTickPillHeightPx(commitCount: number): number {
  if (!shouldRenderCommitTickPill(commitCount)) return 0;
  return Math.max(
    PR_COMMIT_TICK_PILL_MIN_HEIGHT_PX,
    resolveCommitTickSpanPx(commitCount) + PR_COMMIT_TICK_PILL_CHROME_PX,
  );
}

/**
 * Tick position as a percentage of the strip height. Index 0 sits at 0% and the
 * last index at 100%; the ORDER is the caller's, and the rails pass newest
 * first, so 0% is the newest commit. The strip IS the span, so this is the exact inverse of the pointer
 * mapping below.
 */
export function resolveCommitTickTopPercent(index: number, commitCount: number): number {
  return tickTopPercent(index, commitCount);
}

/**
 * Which commit a pointer Y lands on.
 *
 * Derived from Y across the whole strip rather than from per-tick hit boxes, so
 * spacing can compress to sub-pixel without any tick becoming unreachable. The
 * pointer is clamped, so the pill's padding selects the first / last commit
 * instead of falling into dead space.
 */
export function resolveCommitIndexFromPointer(input: {
  readonly commitCount: number;
  readonly stripTop: number;
  readonly stripHeight: number;
  readonly pointerY: number;
}): number | null {
  // The pill's own floor still applies: below two commits there is no strip to
  // point at, whatever the geometry says.
  if (!shouldRenderCommitTickPill(input.commitCount)) return null;
  return tickIndexFromPointer({
    itemCount: input.commitCount,
    stripTop: input.stripTop,
    stripHeight: input.stripHeight,
    pointerY: input.pointerY,
  });
}

/**
 * Tick height (along the stack axis) for the current density.
 *
 * Fixed-height ticks smear into a solid bar the moment pitch drops below the
 * tick height, so height tracks pitch: sparse pills get 2px dashes, dense ones
 * get hairlines that still read as separate marks.
 */
export function resolveCommitTickHeightPx(pitchPx: number, isEmphasised: boolean): number {
  const base = Number.isFinite(pitchPx) && pitchPx > 0
    ? Math.max(
      PR_COMMIT_TICK_MIN_HEIGHT_PX,
      Math.min(PR_COMMIT_TICK_MAX_HEIGHT_PX, Math.floor(pitchPx) - 1),
    )
    : PR_COMMIT_TICK_MAX_HEIGHT_PX;
  return isEmphasised ? base + PR_COMMIT_TICK_EMPHASIS_EXTRA_HEIGHT_PX : base;
}

/**
 * Tick width by distance from the focused tick. `null` distance (nothing
 * focused) gets the resting width.
 *
 * The lens scales the CROSS axis: on a vertical stack, making the focused tick
 * taller would eat its neighbours' pitch, whereas growing it wider is free.
 * This is the same trade the chat minimap makes with its `w-6 / w-4 / w-2.5`
 * lens widths.
 */
export function resolveCommitTickLensWidthPx(
  distance: number | null,
  isEmphasised: boolean,
): number {
  if (isEmphasised) return PR_COMMIT_TICK_EMPHASIS_WIDTH_PX;
  const resting = PR_COMMIT_TICK_LENS_WIDTHS_PX[PR_COMMIT_TICK_LENS_WIDTHS_PX.length - 1]!;
  if (distance === null || !Number.isFinite(distance)) return resting;
  const slot = Math.min(
    Math.max(0, Math.round(distance)),
    PR_COMMIT_TICK_LENS_WIDTHS_PX.length - 1,
  );
  return PR_COMMIT_TICK_LENS_WIDTHS_PX[slot]!;
}

/** How far a Page-Up/Page-Down jumps through a long pill. */
export const PR_COMMIT_TICK_PAGE_STEP = 10;

/**
 * Next index for a keyboard event, or `null` when the key is not ours (so the
 * component can let it bubble instead of swallowing Tab, Escape, etc.).
 *
 * Down moves toward the end of the caller's array, which is down the strip — the
 * arrow direction and the visual axis must agree. With the rails' newest-first
 * order that means Down walks back through history. Down moves toward the
 * stack; the arrow direction and the visual axis have to agree or the pill feels
 * inverted. Left/Right are kept as cross-axis conveniences for anyone who
 * reaches for them, mapped the same way round.
 */
export function resolveCommitIndexForKey(
  key: string,
  currentIndex: number | null,
  commitCount: number,
): number | null {
  if (commitCount <= 0) return null;
  const from = clampCommitIndex(currentIndex ?? 0, commitCount) ?? 0;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return clampCommitIndex(from + 1, commitCount);
    case "ArrowUp":
    case "ArrowLeft":
      return clampCommitIndex(from - 1, commitCount);
    case "PageDown":
      return clampCommitIndex(from + PR_COMMIT_TICK_PAGE_STEP, commitCount);
    case "PageUp":
      return clampCommitIndex(from - PR_COMMIT_TICK_PAGE_STEP, commitCount);
    case "Home":
      return 0;
    case "End":
      return commitCount - 1;
    default:
      return null;
  }
}

/** Subject text with the empty/force-push cases filled in. */
export function commitTickSubject(commit: PrCommitTick): string {
  const subject = commit.subject.trim();
  if (subject.length > 0) return subject;
  return commit.forcePushed ? "Force-pushed branch" : "No commit message";
}

/**
 * Accessible name for one tick. A screen reader must get the subject — "option"
 * repeated 300 times is not navigation — so the sha is a prefix, not the label.
 */
export function commitTickAccessibleLabel(commit: PrCommitTick): string {
  const lead = commit.forcePushed ? "Force-push" : commit.shortSha || commit.sha.slice(0, 7);
  return `${lead}: ${commitTickSubject(commit)}`;
}

/** Index of `sha` in the tick list, or `null` when it is not present. */
export function findCommitIndexBySha(
  commits: readonly PrCommitTick[],
  sha: string | null,
): number | null {
  if (!sha) return null;
  const index = commits.findIndex((commit) => commit.sha === sha);
  return index >= 0 ? index : null;
}
