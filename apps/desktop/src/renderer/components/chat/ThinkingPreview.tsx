import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { MarkdownBlock } from "./chatMarkdownBlock";
import { useRevealedLength, useSplitRevealed } from "./useRevealedText";
import { parseTimestampMs } from "../../../shared/timestamps";

/**
 * Live reasoning presentation for the chat transcript.
 *
 * While the newest row of a live turn is a streaming reasoning row, that row
 * draws a header (`<spinner> Claude is thinking · 12s`) over a compact block
 * that streams the text at the assistant text's pace and grows up to four
 * lines. Once anything else lands after it (or the turn ends) the same row
 * falls back to the compact `Thought` row, and opening a Thought row shows the
 * full text in the grey block.
 *
 * Perf contract (see docs/features/chat/transcript-and-turns.md):
 * - the only timer is one 1s interval per visible live header, owned by the
 *   tiny `ThinkingElapsed` leaf so a tick never re-renders the text;
 * - the paced reveal re-renders only the `LiveThoughtText` leaf;
 * - tail-following is one rAF-coalesced `scrollTop` write per frame, driven by
 *   refs when the text or the content's size changes;
 * - the block grows only until four lines; the live row is always the list's
 *   newest row, so its growth is below any scroll anchor and bottom-follow
 *   keeps a reader at the bottom pinned.
 */

/** Characters of the streaming text the live block keeps mounted. */
export const THINKING_PREVIEW_TAIL_CHARS = 4000;
const THINKING_PREVIEW_CUT_STEP_CHARS = 1024;

type LiveThinkingCandidateRow = {
  key: string;
  timestamp: string;
  event: { type: string; turnId?: string | null };
};

/**
 * The row key of the reasoning row that is still streaming at the end of a live
 * turn, or null. Callers gate on the turn being live; this reads only the rows.
 *
 * Reads the grouped rows BEFORE work-log groups are dropped from the drawn
 * timeline: a tool starting after the thought is a newer row even though the
 * timeline never draws it, so the preview must collapse for it. A noisy
 * activity phase merges `thought → tool → thought` into one Thought row placed
 * before one merged work row; there the thought is still the newest content
 * exactly when it was updated after the merged work row.
 */
export function deriveLiveThinkingRowKey(
  rows: readonly LiveThinkingCandidateRow[],
  activeTurnId: string | null,
): string | null {
  let newestWorkMs: number | null = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const turnId = row.event.turnId ?? null;
    if (turnId && activeTurnId && turnId !== activeTurnId) return null;
    if (row.event.type === "work_log_group") {
      const ms = parseTimestampMs(row.timestamp);
      if (ms == null) return null;
      newestWorkMs = newestWorkMs == null ? ms : Math.max(newestWorkMs, ms);
      continue;
    }
    if (row.event.type !== "reasoning") return null;
    if (newestWorkMs == null) return row.key;
    const reasoningMs = parseTimestampMs(row.timestamp);
    return reasoningMs != null && reasoningMs > newestWorkMs ? row.key : null;
  }
  return null;
}

/** `12s`, `1m 05s`. */
export function formatThinkingElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export { thoughtDurationSeconds } from "./chatThoughtRuns";

/**
 * The tail of a long streaming thought, cut on a paragraph (else line)
 * boundary so markdown is never parsed from the middle of a block. An unclosed
 * code fence in the dropped head reopens so the tail still renders as code.
 */
export function thinkingPreviewCut(text: string, maxChars = THINKING_PREVIEW_TAIL_CHARS): number {
  if (text.length <= maxChars) return 0;
  const floor = text.length - maxChars;
  const paragraph = text.indexOf("\n\n", floor);
  const line = text.indexOf("\n", floor);
  return paragraph >= 0 && paragraph < text.length - 2
    ? paragraph + 2
    : line >= 0 && line < text.length - 1
      ? line + 1
      : Math.floor(floor / THINKING_PREVIEW_CUT_STEP_CHARS) * THINKING_PREVIEW_CUT_STEP_CHARS;
}

export function thinkingPreviewTail(text: string, maxChars = THINKING_PREVIEW_TAIL_CHARS): string {
  const cut = thinkingPreviewCut(text, maxChars);
  if (cut === 0) return text;
  const tail = text.slice(cut);
  const droppedFences = text.slice(0, cut).match(/^\s*```/gm)?.length ?? 0;
  return droppedFences % 2 === 1 ? `\`\`\`\n${tail}` : tail;
}

type FenceIndex = {
  scannedLength: number;
  overlap: string;
  fenceEnds: number[];
  linePrefixWhitespace: boolean;
  linePrefixBackticks: number;
};

function appendFenceIndex(text: string, index: FenceIndex): void {
  // The live provider stream is append-only. Compare a short suffix to detect
  // row replacement without rescanning the full accumulated thought per token.
  const overlapStart = Math.max(0, index.scannedLength - 32);
  const hasSamePrefix = text.length >= index.scannedLength
    && text.slice(overlapStart, index.scannedLength) === index.overlap;
  if (!hasSamePrefix) {
    index.scannedLength = 0;
    index.overlap = "";
    index.fenceEnds.length = 0;
    index.linePrefixWhitespace = true;
    index.linePrefixBackticks = 0;
  }
  for (let cursor = index.scannedLength; cursor < text.length; cursor += 1) {
    const character = text[cursor]!;
    if (character === "\n" || character === "\r") {
      index.linePrefixWhitespace = true;
      index.linePrefixBackticks = 0;
      continue;
    }
    if (!index.linePrefixWhitespace) continue;
    if (character === "`") {
      index.linePrefixBackticks += 1;
      if (index.linePrefixBackticks === 3) {
        index.fenceEnds.push(cursor + 1);
        index.linePrefixWhitespace = false;
      }
    } else if (!/\s/u.test(character)) {
      index.linePrefixWhitespace = false;
    }
  }
  index.scannedLength = text.length;
  index.overlap = text.slice(Math.max(0, text.length - 32));
}

export function countThinkingFencesBeforeCut(fenceEnds: readonly number[], cut: number): number {
  let low = 0;
  let high = fenceEnds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (fenceEnds[middle]! <= cut) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The only ticking state: re-renders this span once per second, nothing else. */
function ThinkingElapsed({ startedAtMs }: { startedAtMs: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs == null) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [startedAtMs]);
  if (startedAtMs == null) return null;
  return (
    <span className="shrink-0 tabular-nums text-fg/38" data-testid="thinking-elapsed">
      <span aria-hidden className="mr-1.5">·</span>
      {formatThinkingElapsed((now - startedAtMs) / 1000)}
    </span>
  );
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("a, button, input, textarea, select") != null;
}

function hasTextSelection(): boolean {
  const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim().length > 0);
}

/** The grey rounded block every open thought draws its full text in. */
export function ThoughtBlock({
  children,
  onToggle,
  className,
}: {
  children: React.ReactNode;
  /** When set, a click (not a text selection or a link) on the block toggles it. */
  onToggle?: () => void;
  className?: string;
}) {
  const toggleable = Boolean(onToggle);
  return (
    <div
      data-testid="thought-block"
      role={toggleable ? "button" : undefined}
      tabIndex={toggleable ? 0 : undefined}
      aria-expanded={toggleable ? true : undefined}
      aria-label={toggleable ? "Collapse thinking" : undefined}
      onClick={toggleable
        ? (event) => {
            if (isInteractiveTarget(event.target) || hasTextSelection()) return;
            onToggle?.();
          }
        : undefined}
      onKeyDown={toggleable
        ? (event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onToggle?.();
            }
          }
        : undefined}
      className={cn(
        "ade-thinking-card mt-1.5 rounded-lg px-4 py-3 text-fg/60 text-[length:calc(var(--chat-font-size)*12/14)] leading-relaxed",
        toggleable && "cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/40",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Lines the live block grows to before older lines scroll up under the fade. */
export const THINKING_LIVE_MAX_LINES = 4;

/**
 * The growing tail of the live thought, painted at the assistant text's pace.
 * A leaf, like `AssistantTextBody`: the reveal re-renders only this subtree.
 * The reveal runs over the whole text; only the last ~4,000 characters of the
 * revealed part are mounted (`thinkingPreviewTail`), split into a settled
 * prefix and a growing tail so each frame parses only the tail.
 */
const LiveThoughtText = React.memo(function LiveThoughtText({ text }: { text: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fenceIndexRef = useRef<FenceIndex>({
    scannedLength: 0,
    overlap: "",
    fenceEnds: [],
    linePrefixWhitespace: true,
    linePrefixBackticks: 0,
  });
  const revealedLength = useRevealedLength(text, true, hostRef);
  const cut = thinkingPreviewCut(text, THINKING_PREVIEW_TAIL_CHARS);
  appendFenceIndex(text, fenceIndexRef.current);
  const droppedFences = countThinkingFencesBeforeCut(fenceIndexRef.current.fenceEnds, cut);
  const fencePrefix = droppedFences % 2 === 1 ? "```\n" : "";
  const windowText = useMemo(() => text.slice(cut), [text, cut]);
  // Synthetic fence repair is settled; provider characters not yet painted
  // remain at the end of the actual tail.
  const windowRevealed = fencePrefix.length + Math.max(0, windowText.length - (text.length - revealedLength));
  // Constant while the tail's cut point holds; a moved cut starts a fresh split.
  const cutKey = cut;
  const renderedWindowText = `${fencePrefix}${windowText}`;
  return (
    <div ref={hostRef} className="min-w-0">
      <PacedThoughtMarkdown key={cutKey} text={renderedWindowText} revealedLength={windowRevealed} />
    </div>
  );
});

function PacedThoughtMarkdown({ text, revealedLength }: { text: string; revealedLength: number }) {
  const { settled, tail } = useSplitRevealed(text, revealedLength);
  return <MarkdownBlock markdown={settled} tailMarkdown={tail.length > 0 ? tail : undefined} tone="thought" />;
}

/**
 * The live thinking block: the streamed text at the thought's own size, with
 * no box and no empty space. It grows with the text up to four lines
 * (`.ade-thinking-live-viewport`, `max-height: calc(4 * 1lh)`); past that the
 * newest line stays at the bottom and older lines scroll up under a top fade.
 * It scrolls only inside itself (`overflow: hidden`, so it never captures the
 * wheel). Clicking it opens the full text.
 */
function ThinkingLiveBlock({
  text,
  onExpand,
  reducedMotion,
}: {
  text: string;
  onExpand: () => void;
  reducedMotion: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);

  /** Marks whether older lines are out of view (the fade); returns the tail offset. */
  const measure = useCallback((node: HTMLDivElement): number => {
    const max = node.scrollHeight - node.clientHeight;
    const overflowing = max >= 1 ? "true" : "false";
    if (node.dataset.overflowing !== overflowing) node.dataset.overflowing = overflowing;
    return max;
  }, []);

  // At most one scroll write per frame, however many deltas or paced reveal
  // steps land in it.
  const follow = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const node = viewportRef.current;
      if (!node) return;
      const max = measure(node);
      if (max >= 1 && Math.abs(node.scrollTop - max) >= 1) node.scrollTop = max;
    });
  }, [measure]);

  // First paint already shows the tail, with no smooth scroll from the top.
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const max = measure(node);
    if (max < 1) return;
    if (typeof node.scrollTo === "function") node.scrollTo({ top: max, behavior: "instant" });
    else node.scrollTop = max;
  }, [measure]);

  // Store deltas. The paced reveal grows the text between deltas without a
  // render here, so the content's own size changes drive the follow as well.
  useLayoutEffect(() => {
    follow();
  }, [follow, text]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => follow());
    observer.observe(content);
    return () => observer.disconnect();
  }, [follow]);

  useEffect(() => () => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
  }, []);

  return (
    <div
      data-testid="thinking-preview-card"
      role="button"
      tabIndex={0}
      aria-expanded={false}
      aria-label="Show full thinking"
      onClick={(event) => {
        if (isInteractiveTarget(event.target) || hasTextSelection()) return;
        onExpand();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onExpand();
        }
      }}
      className="mt-0.5 block w-full cursor-pointer rounded-sm pl-[18px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/40"
    >
      <div
        ref={viewportRef}
        data-testid="thinking-preview-scroll"
        data-max-lines={THINKING_LIVE_MAX_LINES}
        className={cn(
          "ade-thinking-live-viewport text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.65]",
          !reducedMotion && "ade-thinking-live-smooth",
        )}
      >
        <div ref={contentRef}>
          <LiveThoughtText text={text} />
        </div>
      </div>
    </div>
  );
}

/**
 * The live reasoning row: header plus either the compact live block or, once
 * the reader expands it, the full text in a grey block.
 */
export function ThinkingPreview({
  text,
  label,
  startedAtMs,
  expanded,
  onToggleExpanded,
}: {
  text: string;
  /** Provider/agent display label ("Claude"); null draws plain "Thinking". */
  label: string | null;
  startedAtMs: number | null;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const heading = label ? `${label} is thinking` : "Thinking";
  const body = text.trim().length ? text : "…";
  return (
    <div className="w-full font-sans" data-testid="thinking-preview">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggleExpanded}
        className="flex max-w-full items-center gap-1.5 py-0.5 text-left text-[length:calc(var(--chat-font-size)*11/14)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/40"
      >
        <CircleNotch
          size={12}
          weight="bold"
          aria-hidden
          data-testid="thinking-spinner"
          className={cn("shrink-0 text-fg/45", !reducedMotion && "animate-spin")}
        />
        <span
          data-testid="thinking-heading"
          className={cn("min-w-0 truncate font-medium", reducedMotion ? "text-fg/60" : "ade-thinking-shimmer")}
        >
          {heading}
        </span>
        <ThinkingElapsed startedAtMs={startedAtMs} />
      </button>
      {expanded ? (
        <ThoughtBlock onToggle={onToggleExpanded}>
          <MarkdownBlock markdown={body} tone="thought" />
        </ThoughtBlock>
      ) : (
        <ThinkingLiveBlock text={body} onExpand={onToggleExpanded} reducedMotion={reducedMotion} />
      )}
    </div>
  );
}
