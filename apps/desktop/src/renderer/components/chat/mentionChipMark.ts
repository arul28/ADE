import type { ChatMentionKind } from "../../../shared/types/chatMentions";

// Inline SVG kind marks for composer mention chips. Chips are built with
// document.createElement inside the contenteditable, so the composer assigns
// this markup to an icon span rather than mounting React nodes.
//
// Lucide-style 24x24 stroke icons, currentColor so they inherit the chip tint.

function svg(inner: string): string {
  return `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="display:block">${inner}</svg>`;
}

const CHAT_MARK = svg(
  '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /><path d="M8 12h.01" /><path d="M12 12h.01" /><path d="M16 12h.01" />',
);
const LANE_MARK = svg(
  '<circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M18 8.5v4.2a3.3 3.3 0 0 1-3.3 3.3H8.5" /><path d="M6 8.5v9" />',
);
const TERMINAL_MARK = svg(
  '<rect x="3" y="4" width="18" height="16" rx="2" /><path d="m8 9 3 3-3 3" /><path d="M13 15h4" />',
);
const FILE_MARK = svg(
  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" />',
);

export type ComposerAtChipKind = ChatMentionKind | "file";

/** Kind glyph for a mention or file chip, or null for slash-command chips. */
export function mentionChipMarkSvg(kind: ComposerAtChipKind): string {
  switch (kind) {
    case "chat":
      return CHAT_MARK;
    case "lane":
      return LANE_MARK;
    case "terminal":
      return TERMINAL_MARK;
    case "file":
      return FILE_MARK;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
