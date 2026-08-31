import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { formatTimeAgo, formatTimestampShort } from "./prFormatters";
import {
  PR_COMMIT_TICK_ANIMATE_BELOW,
  PR_COMMIT_TICK_COLUMN_WIDTH_PX,
  PR_COMMIT_TICK_PILL_BORDER_PX,
  PR_COMMIT_TICK_PILL_PADDING_Y_PX,
  PR_COMMIT_TICK_PILL_RADIUS_PX,
  PR_COMMIT_TICK_PILL_WIDTH_PX,
  clampCommitIndex,
  commitTickAccessibleLabel,
  commitTickSubject,
  findCommitIndexBySha,
  resolveCommitIndexForKey,
  resolveCommitIndexFromPointer,
  resolveCommitTickHeightPx,
  resolveCommitTickLensWidthPx,
  resolveCommitTickPillHeightPx,
  resolveCommitTickPitchPx,
  resolveCommitTickSpanPx,
  resolveCommitTickTopPercent,
  shouldRenderCommitTickPill,
  type PrCommitTick,
} from "./prCommitTickPill.logic";

export type PrCommitTickPillProps = {
  /** Newest first. Index 0 renders at the TOP of the strip; this never sorts. */
  commits: readonly PrCommitTick[];
  /** The commit currently in view / selected. */
  activeSha: string | null;
  onSelectCommit: (sha: string) => void;
  /**
   * Where the pill floats. MUST establish a containing block (i.e. include
   * `absolute`/`fixed`/`relative`) — the hover preview hangs off the pill with
   * `left-full`, so a static wrapper would let the card escape to the page.
   */
  className?: string;
  /** Offsets for the float (`top`/`left`), applied to the same wrapper. */
  style?: CSSProperties;
};

/** Tick colour, in precedence order: force-push > active > lens centre > rest. */
function tickColor(commit: PrCommitTick, isActive: boolean, isLensCentre: boolean): string {
  if (commit.forcePushed) return COLORS.warning;
  if (isActive) return COLORS.accent;
  if (isLensCentre) return COLORS.textPrimary;
  // Resting ticks are the pill's only resting affordance, so they have to read
  // against the translucent black fill.
  return COLORS.textMuted;
}

function targetsPreviewCard(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-pr-commit-tick-preview]") !== null;
}

/**
 * A small floating pill holding a VERTICAL cluster of tick marks — one per
 * commit, NEWEST at the top — that sits in the top-left corner of the PR
 * overview's thread column and indexes it. Hover a tick to preview the commit,
 * click to jump to it in the timeline.
 *
 * The stack is deliberately the same shape as `ChatUserMinimap`'s: marks
 * clustered close together, never stretched to the height of the column they
 * index. The pill grows DOWNWARD with the commit count up to a capped span,
 * after which the pitch compresses and the box holds still.
 *
 * It floats: absolutely positioned, out of flow, over the thread. The thread
 * keeps its full width, which is the point — the version this replaces reserved
 * a permanent left gutter and then smeared three commits down 600px of it.
 *
 * Two behaviours are lifted wholesale from `ChatUserMinimap` because they solve
 * the same problems: a hit area larger than the visible ticks (so a 2px-tall
 * mark is still aimable — here the pill's padding, with the pointer clamped),
 * and resolving the hovered tick from pointer Y across the whole strip instead
 * of from per-tick hit boxes (so pitch can compress arbitrarily without any
 * commit becoming unreachable).
 *
 * The pill is ONE tab stop, not one per commit: it is a `listbox` driven by
 * `aria-activedescendant`, so arrow keys walk the commits and a screen reader
 * announces each one's subject, but a 300-commit PR does not put 300 stops in
 * the tab order.
 */
export const PrCommitTickPill = memo(function PrCommitTickPill({
  commits,
  activeSha,
  onSelectCommit,
  className,
  style,
}: PrCommitTickPillProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const stripRef = useRef<HTMLDivElement | null>(null);

  const commitCount = commits.length;
  const activeIndex = useMemo(
    () => findCommitIndexBySha(commits, activeSha),
    [commits, activeSha],
  );

  const pitchPx = resolveCommitTickPitchPx(commitCount);
  const spanPx = resolveCommitTickSpanPx(commitCount);
  const pillHeightPx = resolveCommitTickPillHeightPx(commitCount);

  // Pointer maths always reads the STRIP's box, never the event target's, so a
  // move over the pill's padding still resolves against the tick geometry
  // (clamped to the ends) instead of a differently-sized rectangle.
  const resolveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = stripRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return resolveCommitIndexFromPointer({
        commitCount,
        stripTop: rect.top,
        stripHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [commitCount],
  );

  const handleMouseMove = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (targetsPreviewCard(event.target)) return;
      setHoverIndex(resolveIndexFromPointer(event));
    },
    [resolveIndexFromPointer],
  );

  const handleMouseLeave = useCallback(() => setHoverIndex(null), []);

  const selectIndex = useCallback(
    (index: number | null) => {
      if (index === null) return;
      const commit = commits[index];
      if (!commit) return;
      onSelectCommit(commit.sha);
    },
    [commits, onSelectCommit],
  );

  const handleClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      // Selecting text inside the preview card must never navigate.
      if (targetsPreviewCard(event.target)) return;
      const index = resolveIndexFromPointer(event);
      setFocusIndex(index);
      selectIndex(index);
    },
    [resolveIndexFromPointer, selectIndex],
  );

  const handleFocus = useCallback(() => {
    setFocused(true);
    setFocusIndex((current) => current ?? activeIndex ?? 0);
  }, [activeIndex]);

  const handleBlur = useCallback(() => {
    setFocused(false);
    setHoverIndex(null);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectIndex(focusIndex ?? activeIndex ?? 0);
        return;
      }
      const next = resolveCommitIndexForKey(event.key, focusIndex ?? activeIndex, commitCount);
      // An unhandled key must bubble — swallowing Tab would trap focus here.
      if (next === null) return;
      event.preventDefault();
      setFocusIndex(next);
      // Arrowing IS navigating: the pill's whole job is moving the timeline, and
      // requiring Enter after every arrow would make it a two-key control.
      selectIndex(next);
    },
    [activeIndex, commitCount, focusIndex, selectIndex],
  );

  // The hard rule: below two commits there is no cluster, no axis and nothing to
  // scrub — so nothing renders at all.
  if (!shouldRenderCommitTickPill(commitCount)) return null;

  const keyboardIndex = focused ? clampCommitIndex(focusIndex ?? 0, commitCount) : null;
  const previewIndex = hoverIndex !== null && hoverIndex < commitCount
    ? hoverIndex
    : keyboardIndex;
  const previewCommit = previewIndex === null ? null : (commits[previewIndex] ?? null);
  const animated = commitCount < PR_COMMIT_TICK_ANIMATE_BELOW;
  const activeDescendantIndex = keyboardIndex ?? activeIndex;

  return (
    <div
      className={`select-none ${className ?? ""}`}
      style={style}
      data-testid="pr-commit-tick-pill"
      onMouseLeave={handleMouseLeave}
    >
      <div
        role="listbox"
        aria-orientation="vertical"
        tabIndex={0}
        aria-label={`Commits, newest first (${commitCount})`}
        aria-activedescendant={
          activeDescendantIndex === null ? undefined : `pr-commit-tick-${activeDescendantIndex}`
        }
        data-testid="pr-commit-tick-pill-strip"
        className="flex cursor-pointer flex-col items-center justify-center outline-none focus-visible:ring-1"
        style={{
          width: PR_COMMIT_TICK_PILL_WIDTH_PX,
          height: pillHeightPx,
          padding: `${PR_COMMIT_TICK_PILL_PADDING_Y_PX}px 0`,
          borderRadius: PR_COMMIT_TICK_PILL_RADIUS_PX,
          // See-through, per the brief: the thread scrolling underneath stays
          // visible, and the blur keeps 1px ticks legible over moving text.
          background: "rgba(0, 0, 0, 0.42)",
          border: `${PR_COMMIT_TICK_PILL_BORDER_PX}px solid rgba(255, 255, 255, 0.10)`,
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
        }}
        onMouseMove={handleMouseMove}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onMouseDown={(event) => {
          if (targetsPreviewCard(event.target)) return;
          // Keeps a press from starting a text drag across the timeline.
          event.preventDefault();
          // `preventDefault` also cancels the default focus, so focus it by
          // hand — without this, clicking a tick leaves the pill unfocused and
          // the arrow keys scroll the page instead of stepping commits.
          event.currentTarget.focus();
        }}
        onClick={handleClick}
      >
        {/* The strip is exactly the tick span, centred in the pill. Keeping it
            span-sized (rather than stretching it to the pill's minimum height)
            is what lets the ticks stay clumped on a short PR while the pointer
            mapping stays the exact inverse of the tick placement. */}
        <div
          ref={stripRef}
          className="relative shrink-0"
          style={{ width: PR_COMMIT_TICK_COLUMN_WIDTH_PX, height: spanPx }}
        >
          {commits.map((commit, index) => {
            const isActive = index === activeIndex;
            const isEmphasised = isActive || Boolean(commit.forcePushed);
            const lensDistance = previewIndex === null ? null : Math.abs(index - previewIndex);
            // Colour is never the only signal: force-push and active ticks are
            // both taller and wider than their neighbours.
            const heightPx = resolveCommitTickHeightPx(pitchPx, isEmphasised);
            const widthPx = resolveCommitTickLensWidthPx(lensDistance, isEmphasised);
            return (
              <span
                key={commit.sha}
                id={`pr-commit-tick-${index}`}
                role="option"
                aria-selected={isActive}
                aria-label={commitTickAccessibleLabel(commit)}
                data-sha={commit.sha}
                data-testid="pr-commit-tick"
                data-force-push={commit.forcePushed ? "true" : undefined}
                className={`pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2${
                  animated ? " transition-[width,background-color] duration-150" : ""
                }`}
                style={{
                  top: `${resolveCommitTickTopPercent(index, commitCount)}%`,
                  width: widthPx,
                  height: heightPx,
                  borderRadius: 1,
                  background: tickColor(commit, isActive, lensDistance === 0),
                }}
              />
            );
          })}
        </div>
      </div>

      {previewCommit ? (
        <div
          data-pr-commit-tick-preview=""
          data-testid="pr-commit-tick-preview"
          // `pl-1.5` and not a gap: the card has to touch the pill, or the
          // pointer crosses dead space on its way across and dismisses the card
          // before it can be read. It hangs to the SIDE now that the pill is a
          // tall column — below it would sit over the first comments.
          className="absolute left-full top-0 z-20 w-64 cursor-text select-text pl-1.5"
        >
          {/* Flat by house rule: one hairline, small radius, no shadow. The fill
              exists only so the text stays legible over the timeline behind it. */}
          <div
            className="px-2.5 py-2"
            style={{
              background: COLORS.cardBgSolid,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
            }}
          >
            <div className="flex items-baseline gap-2">
              <span
                className="text-[10px] font-semibold"
                style={{
                  color: previewCommit.forcePushed
                    ? COLORS.warning
                    : previewIndex === activeIndex
                      ? COLORS.accent
                      : COLORS.textMuted,
                  fontFamily: previewCommit.forcePushed ? SANS_FONT : MONO_FONT,
                }}
              >
                {previewCommit.forcePushed ? "Force-push" : previewCommit.shortSha}
              </span>
              <span
                className="ml-auto shrink-0 text-[10px]"
                style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}
                title={formatTimestampShort(previewCommit.authoredAt)}
              >
                {formatTimeAgo(previewCommit.authoredAt)}
              </span>
            </div>
            <div
              className="mt-1 line-clamp-3 text-[11px] leading-[1.35]"
              style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}
            >
              {commitTickSubject(previewCommit)}
            </div>
            {previewCommit.threadCount ? (
              <div
                className="mt-1 text-[10px]"
                style={{
                  color:
                    previewCommit.threadCount - (previewCommit.resolvedCount ?? 0) > 0
                      ? COLORS.warning
                      : COLORS.textMuted,
                  fontFamily: MONO_FONT,
                }}
              >
                {previewCommit.resolvedCount ?? 0}/{previewCommit.threadCount} resolved
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default PrCommitTickPill;
