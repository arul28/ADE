import { createContext, useContext } from "react";
import type { CSSProperties } from "react";
import type { ChatChromeTint, ChatTranscriptDensity } from "../../state/appStore";

/** Defaults to `"colored"` when rendered outside `ChatSurfaceShell` (e.g. isolated tests). */
export const ChatChromeTintContext = createContext<ChatChromeTint>("colored");

export function useChatChromeTint(): ChatChromeTint {
  return useContext(ChatChromeTintContext);
}

/** Row spacing between transcript rows — must stay in sync with virtualization math. */
export function transcriptRowGapPx(density: ChatTranscriptDensity): number {
  switch (density) {
    case "compact":
      return 6;
    case "spacious":
      return 28;
    default:
      return 14;
  }
}

/** Multiplier for transcript outer padding — comfortable == 1 (matches prior ~px-5 feel). */
export function transcriptTimelinePaddingScale(density: ChatTranscriptDensity): number {
  switch (density) {
    case "compact":
      return 0.72;
    case "spacious":
      return 1.42;
    default:
      return 1;
  }
}

/** Inner bubble padding (px) — scales with density for obvious vertical rhythm in the thread. */
export function transcriptBubblePaddingPx(density: ChatTranscriptDensity): {
  userX: number;
  userY: number;
  assistantX: number;
  assistantY: number;
} {
  switch (density) {
    case "compact":
      return { userX: 12, userY: 7, assistantX: 14, assistantY: 11 };
    case "spacious":
      return { userX: 20, userY: 14, assistantX: 26, assistantY: 22 };
    default:
      return { userX: 16, userY: 8, assistantX: 20, assistantY: 16 };
  }
}

/**
 * The transcript's ONE content width.
 *
 * Every row — prose, cards, plan, files-changed, activity bundles, pills —
 * clamps to `--chat-content-width` and nothing else. Before this token there
 * were seven disagreeing clamps (832 / 804 / 736 / 704 / 672 / 616 / 544 px),
 * and the card clamp — 70 characters, which resolved against the browser's 16px
 * default because no card sets a font-size — stopped ~26% short of the prose it
 * sat under.
 *
 * It scales with the viewport on purpose: a fixed 832px wastes most of a 27"
 * display. `min(100%, clamp(min, vw, max))` keeps the reading measure sane on a
 * laptop, grows on a large screen, and never exceeds its container — so an open
 * side pane (which shrinks the container, not the viewport) narrows the column
 * rather than clipping it.
 */
export const CHAT_CONTENT_WIDTH_MIN_PX = 720;
export const CHAT_CONTENT_WIDTH_MAX_PX = 1180;
export const CHAT_CONTENT_WIDTH_VIEWPORT_RATIO = 0.62;

/** CSS half of the token. Must stay in lockstep with {@link resolveChatContentWidthPx}. */
export const CHAT_CONTENT_WIDTH_CSS =
  `min(100%, clamp(${CHAT_CONTENT_WIDTH_MIN_PX}px, ${CHAT_CONTENT_WIDTH_VIEWPORT_RATIO * 100}vw, ${CHAT_CONTENT_WIDTH_MAX_PX}px))`;

/**
 * JS half of the token, for layout maths that cannot read a CSS `clamp()`
 * (the chat pane's floating-pane reserve). Same inputs, same answer.
 */
export function resolveChatContentWidthPx(
  availableWidthPx: number,
  viewportWidthPx?: number,
): number {
  const viewport = Number.isFinite(viewportWidthPx) && (viewportWidthPx ?? 0) > 0
    ? (viewportWidthPx as number)
    : (typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : availableWidthPx);
  const target = Math.min(
    CHAT_CONTENT_WIDTH_MAX_PX,
    Math.max(CHAT_CONTENT_WIDTH_MIN_PX, viewport * CHAT_CONTENT_WIDTH_VIEWPORT_RATIO),
  );
  return availableWidthPx > 0 ? Math.min(availableWidthPx, target) : target;
}

/** CSS vars for transcript + composer (scoped under `[data-chat-appearance-root]`). */
export function buildChatAppearanceRootStyle(params: {
  chatFontSizePx: number;
  transcriptDensity: ChatTranscriptDensity;
}): CSSProperties {
  const gap = transcriptRowGapPx(params.transcriptDensity);
  const padScale = transcriptTimelinePaddingScale(params.transcriptDensity);
  const padX = Math.round(20 * padScale * 100) / 100;
  const padTop = Math.round(20 * padScale * 100) / 100;
  const padBot = Math.round(32 * padScale * 100) / 100;
  const bubble = transcriptBubblePaddingPx(params.transcriptDensity);

  return {
    ["--chat-font-size" as string]: `${params.chatFontSizePx}px`,
    ["--chat-content-width" as string]: CHAT_CONTENT_WIDTH_CSS,
    // `--chat-column` predates the token and is read by the composer and the
    // pane's draft-launch rows. Aliasing it here keeps composer and transcript
    // on ONE width instead of two independent definitions.
    ["--chat-column" as string]: "var(--chat-content-width)",
    ["--chat-row-gap" as string]: `${gap}px`,
    ["--chat-timeline-pad-x" as string]: `${padX}px`,
    ["--chat-timeline-pad-top" as string]: `${padTop}px`,
    ["--chat-timeline-pad-bottom" as string]: `${padBot}px`,
    ["--chat-bubble-user-px" as string]: `${bubble.userX}px`,
    ["--chat-bubble-user-py" as string]: `${bubble.userY}px`,
    ["--chat-bubble-assistant-px" as string]: `${bubble.assistantX}px`,
    ["--chat-bubble-assistant-py" as string]: `${bubble.assistantY}px`,
  };
}
