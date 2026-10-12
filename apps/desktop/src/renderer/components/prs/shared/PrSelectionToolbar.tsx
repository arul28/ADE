import { useLayoutEffect, useRef, useState } from "react";
import { Quotes } from "@phosphor-icons/react";

import { cssZoomOf } from "../../../lib/webZoom";
import { ViewportOverlayPortal } from "../../ui/ViewportOverlayHost";
import type { PrChatQuote } from "./prMarkdownContext";

/** Marks an element whose text has a known place in the PR, for a quote's `from`. */
export const PR_QUOTE_FROM_ATTRIBUTE = "data-pr-quote-from";

type ToolbarState = { text: string; from: string; left: number; top: number };

const TOOLBAR_WIDTH = 118;

function readSelection(root: HTMLElement | null): Omit<ToolbarState, "left" | "top"> & { rect: DOMRect } | null {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const anchor = range.commonAncestorContainer;
  const element = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
  if (!element || !root.contains(element)) return null;
  // Text typed into a reply box is the reader's own, not the PR's.
  if (element.closest("textarea, input, [contenteditable='true']")) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const rects = range.getClientRects();
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  const from = element.closest(`[${PR_QUOTE_FROM_ATTRIBUTE}]`)?.getAttribute(PR_QUOTE_FROM_ATTRIBUTE) ?? "the pull request";
  return { text, from, rect };
}

/**
 * "Add to chat" for text selected anywhere in the PR thread: the description,
 * a comment, a review thread. The chat's own selection toolbar does the same
 * for an agent's answer.
 */
export function PrSelectionToolbar({
  rootRef,
  onAddToChat,
}: {
  rootRef: { current: HTMLElement | null };
  onAddToChat: (quote: PrChatQuote) => void;
}) {
  const [state, setState] = useState<ToolbarState | null>(null);
  // Scrolling only moves a toolbar that is already open; it cannot change the
  // selection.
  const showingRef = useRef(false);
  showingRef.current = state != null;

  useLayoutEffect(() => {
    const sync = () => {
      try {
        const next = readSelection(rootRef.current);
        if (!next) {
          setState(null);
          return;
        }
        // Rects are zoomed under the hosted web client's body zoom; styles are not.
        const zoom = cssZoomOf();
        setState({
          text: next.text,
          from: next.from,
          left: Math.min(Math.max(8, next.rect.right / zoom + 8), Math.max(8, window.innerWidth / zoom - TOOLBAR_WIDTH - 8)),
          top: Math.max(8, next.rect.top / zoom - 36),
        });
      } catch {
        setState(null);
      }
    };
    const onScrollOrResize = () => {
      if (showingRef.current) sync();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setState(null);
    };
    document.addEventListener("selectionchange", sync);
    document.addEventListener("mouseup", sync);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("selectionchange", sync);
      document.removeEventListener("mouseup", sync);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [rootRef]);

  if (!state) return null;
  return (
    <ViewportOverlayPortal layer="popover">
      <div
        data-testid="pr-selection-toolbar"
        className="pointer-events-auto absolute inline-flex items-stretch overflow-hidden rounded-md border border-fg/[0.1] bg-[color:color-mix(in_srgb,var(--color-card)_94%,black_6%)] text-fg/85 shadow-[0_12px_32px_rgba(0,0,0,0.42)]"
        style={{ left: state.left, top: state.top }}
        // Keep the selection while the button is pressed.
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <button
          type="button"
          data-testid="pr-selection-add-to-chat"
          className="inline-flex items-center gap-1.5 px-2 py-1 font-sans text-[11px] font-medium transition-colors hover:bg-fg/[0.07]"
          title="Quote this in the chat that works on this pull request"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onAddToChat({ text: state.text, from: state.from });
            window.getSelection()?.removeAllRanges();
            setState(null);
          }}
        >
          <Quotes size={13} weight="fill" style={{ color: "var(--color-accent)" }} aria-hidden />
          Add to chat
        </button>
      </div>
    </ViewportOverlayPortal>
  );
}
