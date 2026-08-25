import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { cn } from "../ui/cn";
import { useAppStore } from "../../state/appStore";
import {
  CHAT_USER_MINIMAP_EXPANDED_HIT_STRIP_WIDTH,
  CHAT_USER_MINIMAP_HIT_STRIP_LEFT_PX,
  minimapHasPersistentGutter,
  minimapRailInert,
  resolveMinimapHitStripWidth,
  resolveMinimapIndexFromPointer,
  resolveMinimapPreviewTranslateY,
  resolveMinimapRailHeightStyle,
  resolveMinimapTopPercent,
  type ChatUserMinimapSourceEntry,
  type ChatUserMinimapTurnOutcome,
} from "./chatUserMinimap.logic";

type ChatUserMinimapProps = {
  entries: readonly ChatUserMinimapSourceEntry[];
  /** `activeFullUserOrdinal` — ticks are 1:1 with entries, so this is already an index. */
  activeIndex: number | null;
  onJumpToRow: (rowIndex: number) => void;
  /** Older transcript pages exist before the currently resident row window. */
  hasOlderHistory?: boolean;
  /** Keeps the continuation marker stable while its page is in flight. */
  loadingOlderHistory?: boolean;
  /** Retry detail for the continuation marker; exposed as a tooltip. */
  olderHistoryError?: string | null;
  /** Pages the next older transcript window without loading the whole file. */
  onLoadOlderHistory?: () => void;
  /** Immediately retries a failed older-history request. */
  onRetryOlderHistory?: () => void;
  /** Measured width of the message-list root. */
  listWidthPx: number;
  /** Measured height of the message-list root. */
  listHeightPx: number;
  /** Measured width of the centered content wrapper. */
  columnWidthPx: number;
  /** Brief keyboard-navigation preview for a prompt selected from the composer. */
  keyboardFocusIndex?: number | null;
  /** Changes for every keyboard-navigation request, including repeated entries. */
  keyboardFocusRequestId?: number | null;
};

/** Lens widths by distance from the hovered tick; index 3+ is "everything else". */
const LENS_WIDTHS = ["w-6", "w-4", "w-2.5", "w-2"] as const;

function lensWidthClass(distance: number | null): string {
  if (distance === null) return LENS_WIDTHS[LENS_WIDTHS.length - 1]!;
  return LENS_WIDTHS[Math.min(distance, LENS_WIDTHS.length - 1)]!;
}

/**
 * Tick colour, in precedence order: turn outcome > viewport-active > lens centre
 * > rest. A failed/stopped turn is rare and worth more than the position cue,
 * which the lens width still conveys.
 */
function tickToneClass(
  outcome: ChatUserMinimapTurnOutcome | null,
  isActive: boolean,
  isLensCentre: boolean,
): string {
  if (outcome === "failed") return "bg-red-400/80";
  if (outcome === "interrupted") return "bg-amber-400/70";
  if (isActive) return "bg-[var(--chat-accent)]";
  if (isLensCentre) return "bg-[var(--color-fg)]/75";
  return "bg-[var(--color-fg)]/30";
}

/** Human label for a non-`completed` turn; `null` means nothing to surface. */
function turnOutcomeLabel(outcome: ChatUserMinimapTurnOutcome | null): string | null {
  if (outcome === "failed") return "Turn failed";
  if (outcome === "interrupted") return "Stopped";
  return null;
}

/** Colour alone must never carry the signal, so these ticks also render thicker. */
function isAttentionOutcome(outcome: ChatUserMinimapTurnOutcome | null): boolean {
  return outcome === "failed" || outcome === "interrupted";
}

function targetsPreviewCard(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null;
}

/**
 * Tick rail down the transcript's left gutter: one hairline per user message,
 * with a magnetic lens and a hover preview of the prompt plus the reply it got.
 *
 * The rail is a SINGLE button — one tab stop for the whole timeline rather than
 * one per message — and derives which tick is under the pointer from Y instead
 * of from per-tick hit targets, so tick spacing can compress arbitrarily.
 */
export function ChatUserMinimap({
  entries,
  activeIndex,
  onJumpToRow,
  hasOlderHistory = false,
  loadingOlderHistory = false,
  olderHistoryError = null,
  onLoadOlderHistory,
  onRetryOlderHistory,
  listWidthPx,
  listHeightPx,
  columnWidthPx,
  keyboardFocusIndex = null,
  keyboardFocusRequestId = null,
}: ChatUserMinimapProps) {
  const chatUserMinimapEnabled = useAppStore((s) => s.chatUserMinimapEnabled);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [keyboardPreview, setKeyboardPreview] = useState<{ index: number; requestId: number } | null>(null);

  useEffect(() => {
    if (keyboardFocusIndex === null || keyboardFocusRequestId === null) {
      setKeyboardPreview(null);
      return;
    }
    setKeyboardPreview({ index: keyboardFocusIndex, requestId: keyboardFocusRequestId });
    const timer = window.setTimeout(() => {
      setKeyboardPreview((current) => (
        current?.requestId === keyboardFocusRequestId ? null : current
      ));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [keyboardFocusIndex, keyboardFocusRequestId]);

  const itemCount = entries.length;

  const resolveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveMinimapIndexFromPointer({
        itemCount,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [itemCount],
  );

  const handleMouseMove = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      setHoverIndex(resolveIndexFromPointer(event));
    },
    [resolveIndexFromPointer],
  );

  const handleClear = useCallback(() => setHoverIndex(null), []);

  const handleFocus = useCallback(() => {
    setHoverIndex((current) => current ?? activeIndex ?? 0);
  }, [activeIndex]);

  const jumpToIndex = useCallback(
    (index: number | null) => {
      if (index === null) return;
      const entry = entries[index];
      if (!entry) return;
      onJumpToRow(entry.rowIndex);
    },
    [entries, onJumpToRow],
  );

  const hitStripWidth = resolveMinimapHitStripWidth(listWidthPx, columnWidthPx);
  const hasPersistentGutter = minimapHasPersistentGutter(listWidthPx, columnWidthPx);
  // Keep the rail anchored to the message-list root. Floating panes are
  // intentionally independent overlays and must not move the history markers.
  const availablePx = listHeightPx;

  const resolvedHoverIndex = hoverIndex !== null && hoverIndex < itemCount ? hoverIndex : null;
  const resolvedKeyboardIndex = keyboardPreview?.index !== undefined && keyboardPreview.index < itemCount
    ? keyboardPreview.index
    : null;
  const resolvedPreviewIndex = resolvedHoverIndex ?? resolvedKeyboardIndex;
  const previewEntry = resolvedPreviewIndex === null ? null : (entries[resolvedPreviewIndex] ?? null);
  const previewOutcomeLabel = (previewEntry?.kind ?? "user") === "user"
    ? turnOutcomeLabel(previewEntry?.turnOutcome ?? null)
    : null;

  // Keep a durable continuation marker when the resident tail has fewer than
  // two user turns. Otherwise the whole rail disappears at the transcript
  // cutoff and falsely implies that the loaded window is the complete chat.
  if (
    !chatUserMinimapEnabled
    || (itemCount < 2 && !hasOlderHistory)
    || minimapRailInert(availablePx)
  ) {
    return null;
  }

  const ariaLabel = `Jump to message: ${previewEntry?.preview ?? "User message"}${
    previewOutcomeLabel ? ` (${previewOutcomeLabel})` : ""
  }`;
  const continuationLabel = olderHistoryError
    ? "Retry loading earlier message markers"
    : loadingOlderHistory
      ? "Loading earlier message markers"
      : "Load earlier message markers";

  return (
    <div
      className={cn(
        "pointer-events-none absolute left-0 z-20 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter || resolvedKeyboardIndex !== null
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      role="region"
      aria-label="User message minimap"
      data-testid="chat-user-minimap"
      style={{ top: 0, bottom: 0 }}
    >
      <div className="flex h-full w-full select-none items-center">
        {hasOlderHistory ? (
          <button
            type="button"
            aria-label={continuationLabel}
            title={olderHistoryError ?? "Earlier messages are available"}
            disabled={loadingOlderHistory}
            data-minimap-history-continuation=""
            className={cn(
              "pointer-events-auto absolute left-3 top-1 z-10 flex h-5 w-6 items-start justify-start bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
              loadingOlderHistory ? "cursor-wait opacity-45" : "cursor-pointer opacity-70 hover:opacity-100",
            )}
            onClick={() => {
              if (olderHistoryError) onRetryOlderHistory?.();
              else onLoadOlderHistory?.();
            }}
          >
            <span aria-hidden="true" className="mt-1 block h-px w-4 bg-[var(--color-fg)]/45" />
            <span aria-hidden="true" className="absolute left-0 top-0 text-[9px] leading-none text-fg/50">↑</span>
          </button>
        ) : null}
        {itemCount > 0 ? (
          <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            "relative shrink-0 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
            // The strip is width-capped to the side gutter so it never overlays
            // the centered content column; with no usable gutter it goes inert
            // and can never swallow message-text selection.
            hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          style={{
            // The rail inset expressed as a flex offset (so `items-center` above
            // can still centre the rail vertically). Driven by the same constant
            // the hit-strip width maths subtracts, never by a parallel `ml-3`.
            marginLeft: CHAT_USER_MINIMAP_HIT_STRIP_LEFT_PX,
            height: resolveMinimapRailHeightStyle(itemCount, availablePx),
            width: previewEntry ? CHAT_USER_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : hitStripWidth,
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleClear}
          onBlur={handleClear}
          onFocus={handleFocus}
          onMouseDown={(event) => {
            if (targetsPreviewCard(event.target)) return;
            // Keeps the rail from flashing focus styles and from starting a
            // text drag on press.
            event.preventDefault();
          }}
          onClick={(event) => {
            // Selecting text inside the preview card must never navigate.
            if (targetsPreviewCard(event.target)) return;
            jumpToIndex(resolveIndexFromPointer(event));
            event.currentTarget.blur();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            jumpToIndex(resolvedPreviewIndex);
          }}
        >
          {entries.map((entry, index) => {
            const lensDistance =
              resolvedPreviewIndex === null ? null : Math.abs(index - resolvedPreviewIndex);
            const outcome = entry.turnOutcome;
            const kind = entry.kind ?? "user";
            const isPrimary = kind === "user";
            return (
              <span
                key={entry.key}
                aria-hidden="true"
                data-minimap-tick=""
                data-outcome={outcome ?? undefined}
                data-minimap-kind={kind}
                className={cn(
                  "pointer-events-none absolute -translate-y-1/2 transition-[background-color,width] duration-150",
                  kind === "compact" && "left-[2px] h-1.5 w-1.5 rotate-45 rounded-[1px]",
                  kind === "queued" && "left-[1px] h-1 w-1 rounded-[1px]",
                  isPrimary && "left-0 rounded-full",
                  isPrimary && (isAttentionOutcome(outcome) ? "h-1" : "h-0.5"),
                  isPrimary && lensWidthClass(lensDistance),
                  tickToneClass(
                    outcome,
                    isPrimary && (entry.fullUserOrdinal === activeIndex || index === resolvedKeyboardIndex),
                    isPrimary && lensDistance === 0,
                  ),
                  kind === "compact" && (outcome === "failed" ? "bg-red-400/80" : "bg-amber-300/70"),
                  kind === "queued" && "bg-cyan-300/70",
                )}
                style={{ top: `${resolveMinimapTopPercent(index, itemCount)}%` }}
              />
            );
          })}
          {previewEntry ? (
            <span
              data-minimap-preview
              className="pointer-events-auto absolute left-8 w-[min(20rem,60vw)] cursor-text select-text"
              // OFF-SCREEN-PREVIEW FIX: a card centered on its own tick hangs off
              // the top of the list at the first tick and off the bottom at the
              // last, so the translate anchors the card's top edge at the first
              // tick and its bottom edge at the last, centering only in between.
              style={{
                top: `${resolveMinimapTopPercent(resolvedPreviewIndex ?? 0, itemCount)}%`,
                transform: `translateY(${resolveMinimapPreviewTranslateY(resolvedPreviewIndex ?? 0, itemCount)})`,
              }}
              // Moving inside the card must not re-derive the index from Y, or
              // the card would chase the pointer and reselect messages.
              onMouseMove={(event) => event.stopPropagation()}
            >
              <span className="block rounded-xl border border-white/[0.08] bg-[color:rgb(12,12,16)]/95 p-3 text-left font-sans shadow-xl shadow-black/25 backdrop-blur-md">
                {previewOutcomeLabel ? (
                  <span
                    className={cn(
                      "mb-1 block text-[10px] font-semibold uppercase tracking-wide",
                      previewEntry.turnOutcome === "failed" ? "text-red-400/90" : "text-amber-400/90",
                    )}
                  >
                    {previewOutcomeLabel}
                  </span>
                ) : null}
                <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-medium leading-5 text-fg/90">
                  {previewEntry.preview}
                </span>
                {previewEntry.assistantPreview ? (
                  <span
                    className="mt-1 block max-h-[3.75rem] overflow-hidden text-[12px] leading-5 text-fg/55"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 3,
                    }}
                  >
                    {previewEntry.assistantPreview}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
          </button>
        ) : null}
      </div>
    </div>
  );
}
