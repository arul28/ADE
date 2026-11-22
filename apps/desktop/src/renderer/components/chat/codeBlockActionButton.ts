import type { CSSProperties } from "react";

/**
 * The look of a code block's small action buttons (Copy, Run, the run's own row).
 *
 * No blur here: a button that hides until the block is hovered adds
 * `backdrop-blur-sm` with the same hover condition as its opacity. On macOS one
 * backdrop-filter anywhere on the page makes Chromium redraw the whole window
 * for every change (a streamed word, a caret), and a long chat has one button
 * per code block.
 */
export const CODE_BLOCK_ACTION_BUTTON_CLASS =
  "ade-chat-copy-button pointer-events-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-sans text-[9px] transition-all";

export const CODE_BLOCK_ACTION_BUTTON_STYLE: CSSProperties = {
  border: "1px solid var(--chat-copy-button-border)",
  background: "var(--chat-copy-button-bg)",
  color: "var(--chat-copy-button-fg)",
};
