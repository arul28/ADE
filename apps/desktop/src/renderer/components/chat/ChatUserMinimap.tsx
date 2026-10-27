import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { CaretDown, CaretUp } from "@phosphor-icons/react";
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
  resolveMinimapWindow,
  CHAT_USER_MINIMAP_WINDOW_SIZE,
  type ChatUserMinimapSourceEntry,
  type ChatUserMinimapTurnOutcome,
} from "./chatUserMinimap.logic";

type ChatUserMinimapProps = {
  entries: readonly ChatUserMinimapSourceEntry[];
  /** `activeFullUserOrdinal` — ticks are 1:1 with entries, so this is already an index. */
  activeIndex: number | null;
  /** `entry` carries the row key and, for a row hidden in a closed turn fold, its fold. */
  onJumpToRow: (rowIndex: number, entry: ChatUserMinimapSourceEntry) => void;
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
  /** The reader pointed at or focused the rail: the list pages the rest of the chat in. */
  onReach?: () => void;
};

/**
 * Tick colour, in precedence order: turn outcome > viewport-active > lens centre
 * > rest. Tick geometry stays constant so colour remains the only type-specific
 * visual treatment.
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

function targetsPreviewCard(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null;
}

/**
 * Tick rail down the transcript's left gutter: one hairline per user message,
 * with a magnetic lens and a hover preview of the prompt plus the reply it got.
 *
 * A long chat draws only a window of `CHAT_USER_MINIMAP_WINDOW_SIZE` ticks
 * (the newest, by default); the folded rest sits behind an "earlier" / "later"
 * control at either end, and the window follows the message being read.
 *
 * The rail is a SINGLE button — one tab stop for the whole timeline rather than
 * one per message — and derives which tick is under the pointer from Y instead
 * of from per-tick hit targets, so tick spacing can compress arbitrarily.
 */
export function ChatUserMinimap({
  entries,
  activeIndex,
  onJumpToRow,
  listWidthPx,
  listHeightPx,
  columnWidthPx,
  keyboardFocusIndex = null,
  keyboardFocusRequestId = null,
  onReach,
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

  // The window is pinned by the key of its last entry rather than an index, so
  // older history paging in at the front (or new prompts at the back) does not
  // slide it. `null` keeps it on the newest entries.
  const [windowEndKey, setWindowEndKey] = useState<string | null>(null);
  const requestedWindowEnd = useMemo(() => {
    if (windowEndKey === null) return null;
    const index = entries.findIndex((entry) => entry.key === windowEndKey);
    return index < 0 ? null : index + 1;
  }, [entries, windowEndKey]);
  const { start: windowStart, end: windowEnd } = resolveMinimapWindow(itemCount, requestedWindowEnd);
  const windowCount = windowEnd - windowStart;

  const pageWindowTo = useCallback(
    (end: number) => {
      setWindowEndKey(end >= entries.length ? null : (entries[Math.max(0, end - 1)]?.key ?? null));
    },
    [entries],
  );

  // Follow the message being read (or picked from the composer): when it is
  // outside the drawn window, re-centre the window on it. Only a change of that
  // message re-centres, so paging the rail by hand is not undone.
  const activeEntryIndex = useMemo(() => {
    if (activeIndex === null) return null;
    const index = entries.findIndex(
      (entry) => (entry.kind ?? "user") === "user" && entry.fullUserOrdinal === activeIndex,
    );
    return index < 0 ? null : index;
  }, [entries, activeIndex]);
  const revealIndex = keyboardPreview && keyboardPreview.index < itemCount ? keyboardPreview.index : activeEntryIndex;
  const windowRef = useRef({ start: windowStart, end: windowEnd, pageWindowTo });
  windowRef.current = { start: windowStart, end: windowEnd, pageWindowTo };
  useEffect(() => {
    if (revealIndex === null) return;
    const current = windowRef.current;
    if (revealIndex >= current.start && revealIndex < current.end) return;
    current.pageWindowTo(revealIndex + Math.ceil(CHAT_USER_MINIMAP_WINDOW_SIZE / 2));
  }, [revealIndex]);

  const resolveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const local = resolveMinimapIndexFromPointer({
        itemCount: windowCount,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
      return local === null ? null : windowStart + local;
    },
    [windowCount, windowStart],
  );

  const handleMouseMove = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      setHoverIndex(resolveIndexFromPointer(event));
    },
    [resolveIndexFromPointer],
  );

  const handleClear = useCallback(() => setHoverIndex(null), []);

  const handleFocus = useCallback(() => {
    setHoverIndex((current) => current ?? activeEntryIndex ?? Math.max(0, windowEnd - 1));
  }, [activeEntryIndex, windowEnd]);

  const jumpToIndex = useCallback(
    (index: number | null) => {
      if (index === null) return;
      const entry = entries[index];
      if (!entry) return;
      onJumpToRow(entry.rowIndex, entry);
    },
    [entries, onJumpToRow],
  );

  const hitStripWidth = resolveMinimapHitStripWidth(listWidthPx, columnWidthPx);
  const hasPersistentGutter = minimapHasPersistentGutter(listWidthPx, columnWidthPx);
  // Keep the rail anchored to the message-list root. Floating panes are
  // intentionally independent overlays and must not move the history markers.
  const availablePx = listHeightPx;

  const inWindow = (index: number) => index >= windowStart && index < windowEnd;
  const resolvedHoverIndex = hoverIndex !== null && inWindow(hoverIndex) ? hoverIndex : null;
  const resolvedKeyboardIndex = keyboardPreview?.index !== undefined && inWindow(keyboardPreview.index)
    ? keyboardPreview.index
    : null;
  const resolvedPreviewIndex = resolvedHoverIndex ?? resolvedKeyboardIndex;
  const previewEntry = resolvedPreviewIndex === null ? null : (entries[resolvedPreviewIndex] ?? null);
  const previewOutcomeLabel = (previewEntry?.kind ?? "user") === "user"
    ? turnOutcomeLabel(previewEntry?.turnOutcome ?? null)
    : null;

  // Older history backfills on its own (the message list pages it in during
  // idle time), so the rail only ever shows what is resident and grows as
  // earlier prompts arrive.
  if (
    !chatUserMinimapEnabled
    || itemCount < 2
    || minimapRailInert(availablePx)
  ) {
    return null;
  }

  const ariaLabel = `Jump to message: ${previewEntry?.preview ?? "User message"}${
    previewOutcomeLabel ? ` (${previewOutcomeLabel})` : ""
  }`;

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
        <div
          className="relative shrink-0"
          // The rail inset expressed as a flex offset (so `items-center` above
          // can still centre the rail vertically). Driven by the same constant
          // the hit-strip width maths subtracts, never by a parallel `ml-3`.
          style={{ marginLeft: CHAT_USER_MINIMAP_HIT_STRIP_LEFT_PX }}
        >
          <button
            type="button"
            aria-label={ariaLabel}
            className={cn(
              "relative block cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
              // The strip is width-capped to the side gutter so it never overlays
              // the centered content column; with no usable gutter it goes inert
              // and can never swallow message-text selection.
              hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
            )}
            style={{
              height: resolveMinimapRailHeightStyle(windowCount, availablePx),
              width: previewEntry ? CHAT_USER_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : hitStripWidth,
            }}
            onMouseEnter={onReach}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleClear}
            onBlur={handleClear}
            onFocus={() => {
              onReach?.();
              handleFocus();
            }}
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
            {entries.slice(windowStart, windowEnd).map((entry, offset) => {
              const index = windowStart + offset;
              const outcome = entry.turnOutcome;
              const kind = entry.kind ?? "user";
              const isPrimary = kind === "user";
              const isActive = isPrimary && (entry.fullUserOrdinal === activeIndex || index === resolvedKeyboardIndex);
              const isLensCentre = isPrimary && resolvedPreviewIndex === index;
              return (
                <span
                  key={entry.key}
                  aria-hidden="true"
                  data-minimap-tick=""
                  data-outcome={outcome ?? undefined}
                  data-minimap-kind={kind}
                  className={cn(
                    "pointer-events-none absolute left-0 h-0.5 w-2 -translate-y-1/2 rounded-full",
                    tickToneClass(outcome, isActive, isLensCentre),
                    kind === "queued" && "bg-cyan-300/70",
                  )}
                  style={{ top: `${resolveMinimapTopPercent(offset, windowCount)}%` }}
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
                  top: `${resolveMinimapTopPercent((resolvedPreviewIndex ?? windowStart) - windowStart, windowCount)}%`,
                  transform: `translateY(${resolveMinimapPreviewTranslateY((resolvedPreviewIndex ?? windowStart) - windowStart, windowCount)})`,
                }}
                // Moving inside the card must not re-derive the index from Y, or
                // the card would chase the pointer and reselect messages.
                onMouseMove={(event) => event.stopPropagation()}
              >
                <span className="block rounded-xl border border-fg/[0.08] bg-[color:rgb(12,12,16)]/95 p-3 text-left font-sans shadow-xl shadow-black/25 backdrop-blur-md">
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
          {windowStart > 0 ? (
            <MinimapPageButton
              direction="earlier"
              hidden={windowStart}
              interactive={hitStripWidth > 0}
              onClick={() => pageWindowTo(windowStart)}
            />
          ) : null}
          {windowEnd < itemCount ? (
            <MinimapPageButton
              direction="later"
              hidden={itemCount - windowEnd}
              interactive={hitStripWidth > 0}
              onClick={() => pageWindowTo(windowEnd + CHAT_USER_MINIMAP_WINDOW_SIZE)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The fold at either end of a windowed rail: how many ticks it hides, click to page. */
function MinimapPageButton({
  direction,
  hidden,
  interactive,
  onClick,
}: {
  direction: "earlier" | "later";
  hidden: number;
  interactive: boolean;
  onClick: () => void;
}) {
  const earlier = direction === "earlier";
  const label = `Show ${earlier ? "earlier" : "later"} messages (${hidden} folded)`;
  const Icon = earlier ? CaretUp : CaretDown;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-minimap-page={direction}
      className={cn(
        "absolute -left-1 flex items-center gap-0.5 rounded px-0.5 font-sans text-[10px] leading-3 tabular-nums text-fg/45 hover:text-fg/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        earlier ? "bottom-full mb-1.5" : "top-full mt-1.5",
        interactive ? "pointer-events-auto cursor-pointer" : "pointer-events-none",
      )}
      // No focus flash or text drag on press, same as the rail.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Icon size={9} weight="bold" aria-hidden="true" />
      {hidden}
    </button>
  );
}
