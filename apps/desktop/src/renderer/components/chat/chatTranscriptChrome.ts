import type { CSSProperties } from "react";

/** Transcript bubble outer chrome — keep aligned with AgentChatMessageList. */
export const CHAT_TRANSCRIPT_GLASS_CARD_CLASS =
  "ade-liquid-glass overflow-hidden rounded-[var(--chat-radius-card)]";

export const CHAT_WORK_LOG_CARD_CLASS =
  "ade-chat-work-card overflow-hidden rounded-[var(--chat-radius-card)]";

export const CHAT_USER_MESSAGE_CARD_STYLE: CSSProperties = {
  borderColor:
    "color-mix(in srgb, var(--chat-accent) var(--chat-user-border-accent-mix, 28%), rgba(255,255,255,0.14))",
  boxShadow:
    "0 18px 28px -24px color-mix(in srgb, var(--chat-accent) var(--chat-user-shadow-accent-mix, 34%), transparent), 0 10px 26px -22px rgba(0,0,0,0.52)",
};

export const CHAT_ASSISTANT_MESSAGE_CARD_STYLE: CSSProperties = {
  borderColor: "color-mix(in srgb, var(--chat-glass-border) 100%, transparent)",
  boxShadow: "0 16px 32px -26px rgba(0, 0, 0, 0.5)",
};
