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
