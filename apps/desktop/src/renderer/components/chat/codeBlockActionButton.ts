import type { CSSProperties } from "react";

/** The look of a code block's small action buttons (Copy, Run, the run's own row). */
export const CODE_BLOCK_ACTION_BUTTON_CLASS =
  "ade-chat-copy-button pointer-events-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-sans text-[9px] backdrop-blur-sm transition-all";

export const CODE_BLOCK_ACTION_BUTTON_STYLE: CSSProperties = {
  border: "1px solid var(--chat-copy-button-border)",
  background: "var(--chat-copy-button-bg)",
  color: "var(--chat-copy-button-fg)",
};
