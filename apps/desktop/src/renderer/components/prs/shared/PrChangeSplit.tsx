import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PrFile } from "../../../../shared/types/prs";
import {
  PR_CHANGE_KINDS,
  isPrChangeSummaryComplete,
  prChangeNonCodeLines,
  type PrChangeKind,
  type PrChangeKindSummary,
} from "../../../../shared/prChangeKind";
import { fixedFrameOf, fixedRect, fixedViewport } from "../../../lib/webZoom";
import { computeTooltipPosition, type TooltipPlacement, type TooltipSide } from "../../ui/tooltipPosition";
import { Z_LAYERS } from "../../ui/zLayers";
import { usePortalContainer } from "../../ui/portalContainer";
import { prChangeSplitKey, requestPrChangeSplit, usePrChangeSplit } from "./prChangeSplitStore";
import "./prChangeSplit.css";

/**
 * How much of a PR's `+N −N` is code, and how much is tests, test data, docs
 * and generated output: a thin stacked bar beside the diff stat, and a hover
 * card with the numbers. Code is the solid ink; everything a reviewer can skim
 * is a lighter step of the same ink, and generated output is hatched.
 */

const KIND_LABEL: Record<PrChangeKind, string> = {
  code: "Code",
  tests: "Tests",
  mocks: "Mocks & fixtures",
  docs: "Docs",
  generated: "Generated",
};

const HOVER_DELAY_MS = 250;
const numberFormat = new Intl.NumberFormat("en-US");
const fmt = (value: number) => numberFormat.format(value);

/** The bar is worth drawing only when something besides code changed. */
function splitWorthShowing(summary: PrChangeKindSummary | null, complete: boolean): summary is PrChangeKindSummary {
  return Boolean(summary) && complete && prChangeNonCodeLines(summary!) > 0;
}

export function describePrChangeSplit(summary: PrChangeKindSummary): string {
  const parts = PR_CHANGE_KINDS
    .filter((kind) => summary.kinds[kind].files > 0)
    .map((kind) => {
      const tally = summary.kinds[kind];
      return `${KIND_LABEL[kind]} +${fmt(tally.additions)} −${fmt(tally.deletions)} in ${fmt(tally.files)} ${tally.files === 1 ? "file" : "files"}`;
    });
  return `${fmt(summary.total.additions)} lines added, ${fmt(summary.total.deletions)} removed. ${parts.join(", ")}.`;
}

export function PrChangeSplitBar({ summary, size = "header" }: { summary: PrChangeKindSummary; size?: "header" | "row" | "card" }) {
  return (
    <span className="ade-pr-change-bar" data-size={size} aria-hidden>
      {PR_CHANGE_KINDS.map((kind) => {
        const lines = summary.kinds[kind].additions + summary.kinds[kind].deletions;
        if (lines === 0) return null;
        return <i key={kind} data-kind={kind} style={{ flexGrow: lines }} />;
      })}
    </span>
  );
}

function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  const value = (part / whole) * 100;
  // A sliver still reads as "<1%", never as 0%.
  return value > 0 && value < 1 ? 0.5 : Math.round(value);
}

function formatPercent(value: number): string {
  return value === 0.5 ? "<1%" : `${value}%`;
}

function PrChangeSplitCard({ summary }: { summary: PrChangeKindSummary }) {
  const totalLines = summary.total.additions + summary.total.deletions;
  const codeLines = summary.kinds.code.additions + summary.kinds.code.deletions;
  const codeShare = percentOf(codeLines, totalLines);
  return (
    <>
      <div className="ade-pr-change-card-head">
        <span className="kit-eyebrow">Lines changed</span>
        <span className="kit-num">
          <span className="ade-pr-change-add">+{fmt(summary.total.additions)}</span>{" "}
          <span className="ade-pr-change-del">−{fmt(summary.total.deletions)}</span>
          <span className="ade-pr-change-card-dim"> · {fmt(summary.total.files)} {summary.total.files === 1 ? "file" : "files"}</span>
        </span>
      </div>
      <PrChangeSplitBar summary={summary} size="card" />
      <div className="ade-pr-change-card-rows">
        {PR_CHANGE_KINDS.map((kind) => {
          const tally = summary.kinds[kind];
          if (tally.files === 0) return null;
          return (
            <React.Fragment key={kind}>
              <i className="ade-pr-change-swatch" data-kind={kind} />
              <span className="ade-pr-change-card-label">{KIND_LABEL[kind]}</span>
              <span className="kit-num ade-pr-change-card-share">
                {formatPercent(percentOf(tally.additions + tally.deletions, totalLines))}
              </span>
              <span className="kit-num ade-pr-change-card-dim">
                {fmt(tally.files)} {tally.files === 1 ? "file" : "files"}
              </span>
              <span className="kit-num ade-pr-change-add" data-zero={tally.additions === 0 || undefined}>+{fmt(tally.additions)}</span>
              <span className="kit-num ade-pr-change-del" data-zero={tally.deletions === 0 || undefined}>−{fmt(tally.deletions)}</span>
            </React.Fragment>
          );
        })}
      </div>
      <div className="ade-pr-change-card-foot">
        {codeLines === 0
          ? "No code changed: the rest is quick to skim."
          : <><span className="kit-num">{formatPercent(codeShare)}</span> of the change is code; the rest is quick to skim.</>}
      </div>
    </>
  );
}

/**
 * Hover (after a short intent delay) or keyboard focus opens the card; a
 * click pins it open until the next click, Escape, scroll or window blur.
 * Unpinned, any pointer-down or key closes it. Portalled and
 * `pointer-events: none`, placed by the same flip-then-shift rule as the
 * app's tooltips, so it never covers the stat it describes.
 */
function useHoverCard(onIntent?: () => void) {
  const [visible, setVisible] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const onIntentRef = useRef(onIntent);
  onIntentRef.current = onIntent;

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  const hide = useCallback(() => {
    clearTimer();
    setVisible(false);
    setPinned(false);
    setPlacement(null);
  }, [clearTimer]);
  const showAfterDelay = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onIntentRef.current?.();
      setVisible(true);
    }, HOVER_DELAY_MS);
  }, [clearTimer]);
  const showNow = useCallback(() => {
    clearTimer();
    onIntentRef.current?.();
    setVisible(true);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  const togglePinned = useCallback(() => {
    if (pinned) {
      hide();
      return;
    }
    clearTimer();
    onIntentRef.current?.();
    setVisible(true);
    setPinned(true);
  }, [clearTimer, hide, pinned]);
  const leave = useCallback(() => {
    if (!pinned) hide();
  }, [hide, pinned]);

  useEffect(() => {
    if (!visible) return undefined;
    const dismiss = (event: Event) => {
      // The trigger's own click toggles the pin.
      if (event.type === "pointerdown" && triggerRef.current?.contains(event.target as Node)) return;
      if (pinned && event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      hide();
    };
    window.addEventListener("keydown", dismiss, true);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("wheel", dismiss, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("wheel", dismiss, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("blur", dismiss);
    };
  }, [hide, pinned, visible]);

  const place = useCallback((side: TooltipSide) => {
    const trigger = triggerRef.current;
    const card = cardRef.current;
    if (!trigger || !card) return;
    const frame = fixedFrameOf(card.parentElement);
    const triggerBox = fixedRect(frame, trigger.getBoundingClientRect());
    const cardBox = fixedRect(frame, card.getBoundingClientRect());
    const viewport = fixedViewport(frame);
    const next = computeTooltipPosition({
      preferredSide: side,
      trigger: triggerBox,
      tooltip: { width: cardBox.width, height: cardBox.height },
      viewport: { width: viewport.width, height: viewport.height },
    });
    setPlacement((previous) => (
      previous && previous.x === next.x && previous.y === next.y && previous.side === next.side ? previous : next
    ));
  }, []);

  return { visible, pinned, placement, triggerRef, cardRef, hide, leave, togglePinned, showAfterDelay, showNow, place };
}

function HoverCardPortal({
  card,
  summary,
  side,
}: {
  card: ReturnType<typeof useHoverCard>;
  summary: PrChangeKindSummary;
  side: TooltipSide;
}) {
  const portalContainer = usePortalContainer();
  const { place, visible } = card;
  useLayoutEffect(() => {
    if (visible) place(side);
  }, [place, side, visible, summary]);
  return createPortal(
    <div
      ref={card.cardRef}
      className="ade-pr-change-card"
      // The trigger's own label already reads every number.
      aria-hidden
      style={{
        zIndex: Z_LAYERS.tooltip,
        left: card.placement?.x ?? 0,
        top: card.placement?.y ?? 0,
        pointerEvents: "none",
        visibility: card.placement ? "visible" : "hidden",
      }}
    >
      <PrChangeSplitCard summary={summary} />
    </div>,
    portalContainer ?? document.body,
  );
}

function isKeyboardFocus(event: React.FocusEvent<HTMLElement>): boolean {
  try {
    return event.currentTarget.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * The PR header's diff stat, from the files the pane holds.
 */
export function PrHeaderChangeStat({ summary }: { summary: PrChangeKindSummary | null }) {
  const card = useHoverCard();
  if (!summary || summary.total.files === 0) return null;
  // Only the files cap applies here: the totals shown are this list's own, so
  // a split of it always adds up to them.
  const complete = isPrChangeSummaryComplete(summary);
  const showSplit = splitWorthShowing(summary, complete);
  const stat = (
    <>
      <span className="kit-num ade-pr-change-add">+{fmt(summary.total.additions)}</span>
      <span className="kit-num ade-pr-change-del">−{fmt(summary.total.deletions)}</span>
    </>
  );
  if (!showSplit) {
    return (
      <span className="ade-pr-change-stat" data-testid="pr-header-diff-stat">
        {stat}
      </span>
    );
  }
  return (
    <>
      <span
        ref={card.triggerRef}
        className="ade-pr-change-stat"
        data-interactive="true"
        data-testid="pr-header-diff-stat"
        tabIndex={0}
        role="button"
        aria-label={describePrChangeSplit(summary)}
        aria-expanded={card.visible}
        data-pinned={card.pinned || undefined}
        onPointerEnter={() => { if (!card.visible) card.showAfterDelay(); }}
        onPointerLeave={card.leave}
        onClick={card.togglePinned}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            card.togglePinned();
          }
        }}
        onFocus={(event) => { if (isKeyboardFocus(event)) card.showNow(); }}
        onBlur={card.leave}
      >
        {stat}
        <PrChangeSplitBar summary={summary} />
      </span>
      {card.visible ? <HoverCardPortal card={card} summary={summary} side="bottom" /> : null}
    </>
  );
}

export type PrRowChangeStatSource = {
  repoOwner: string;
  repoName: string;
  githubPrNumber: number;
  /** Reads the PR's files on the machine that owns it. */
  loadFiles: () => Promise<readonly PrFile[]>;
};

/**
 * A list row's diff stat. Shows the split only when this window already holds
 * the PR's files; otherwise hovering the stat reads them once (see
 * `requestPrChangeSplit`). It lives inside the row's button, so it takes no
 * focus of its own.
 */
export function PrRowChangeStat({
  additions,
  deletions,
  changedFiles,
  source,
}: {
  additions: number | null;
  deletions: number | null;
  changedFiles?: number | null;
  source: PrRowChangeStatSource;
}) {
  const key = prChangeSplitKey(source);
  const summary = usePrChangeSplit(key);
  const loadRef = useRef(source.loadFiles);
  loadRef.current = source.loadFiles;
  const complete = summary
    ? isPrChangeSummaryComplete(summary, { additions, deletions, changedFiles })
    : false;
  const card = useHoverCard(() => {
    // A list that disagrees with the row's totals is stale: read it again
    // (the store allows one read per PR per minute).
    if (!complete) requestPrChangeSplit(key, loadRef.current);
  });
  if (additions == null && deletions == null) return null;
  const showSplit = splitWorthShowing(summary, complete);
  return (
    <>
      <span
        ref={card.triggerRef}
        className="ade-pr-change-stat"
        data-size="row"
        data-testid="pr-row-diff-stat"
        onPointerEnter={card.showAfterDelay}
        onPointerLeave={card.hide}
      >
        <span className="ade-pr-change-add">+{additions ?? 0}</span>
        <span className="ade-pr-change-del">-{deletions ?? 0}</span>
        {showSplit ? <PrChangeSplitBar summary={summary} size="row" /> : null}
      </span>
      {card.visible && showSplit ? <HoverCardPortal card={card} summary={summary} side="top" /> : null}
    </>
  );
}
