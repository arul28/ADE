import { Quotes } from "@phosphor-icons/react";

import { ViewportOverlayPortal } from "../../ui/ViewportOverlayHost";
import { useSelectionAnchor } from "../../ui/useSelectionAnchor";
import type { PrChatQuote } from "./prMarkdownContext";

/** Marks an element whose text has a known place in the PR, for a quote's `from`. */
export const PR_QUOTE_FROM_ATTRIBUTE = "data-pr-quote-from";

const TOOLBAR_WIDTH = 118;

function readSelection(root: HTMLElement | null): { text: string; from: string; rect: DOMRect } | null {
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
  const [anchor, clear] = useSelectionAnchor(true, () => readSelection(rootRef.current), TOOLBAR_WIDTH);
  if (!anchor) return null;
  return (
    <ViewportOverlayPortal layer="popover">
      <div
        data-testid="pr-selection-toolbar"
        className="pointer-events-auto absolute inline-flex items-stretch overflow-hidden rounded-md border border-fg/[0.1] bg-[color:color-mix(in_srgb,var(--color-card)_94%,black_6%)] text-fg/85 shadow-[0_12px_32px_rgba(0,0,0,0.42)]"
        style={{ left: anchor.left, top: anchor.top }}
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
            onAddToChat({ text: anchor.selection.text, from: anchor.selection.from });
            clear();
          }}
        >
          <Quotes size={13} weight="fill" style={{ color: "var(--color-accent)" }} aria-hidden />
          Add to chat
        </button>
      </div>
    </ViewportOverlayPortal>
  );
}
