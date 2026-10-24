import { ChatsCircle } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { WORK_HEADER_ICON_BUTTON_CLASS } from "../work/WorkHeaderPaneToggles";
import { useSideChatView } from "./sideChatState";

/** One sentence, everywhere the mark appears. */
export const SIDE_CHAT_PRESENCE_LABEL = "Has a side chat";

/**
 * A small mark beside a chat that has a side chat (`/side`), in the same
 * family as the live-browser globe. Renders nothing otherwise, so callers can
 * place it unconditionally.
 */
export function SideChatBadge({
  mainSessionId,
  rowSideChatSessionId,
  size = 12,
  className,
}: {
  mainSessionId: string | null | undefined;
  rowSideChatSessionId: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const view = useSideChatView(mainSessionId, rowSideChatSessionId);
  if (view.kind === "none") return null;
  return (
    <span
      data-testid="side-chat-presence"
      role="img"
      title={SIDE_CHAT_PRESENCE_LABEL}
      aria-label={SIDE_CHAT_PRESENCE_LABEL}
      className={cn("inline-flex shrink-0 items-center justify-center text-[#5eead4]", className)}
    >
      <ChatsCircle size={size} weight="bold" />
    </span>
  );
}

/** The same mark as a chat-header control that opens the Side chat tool. */
export function SideChatHeaderButton({
  mainSessionId,
  rowSideChatSessionId,
  onClick,
}: {
  mainSessionId: string | null | undefined;
  rowSideChatSessionId: string | null | undefined;
  onClick: () => void;
}) {
  const view = useSideChatView(mainSessionId, rowSideChatSessionId);
  if (view.kind === "none") return null;
  return (
    <button
      type="button"
      data-testid="side-chat-presence"
      className={WORK_HEADER_ICON_BUTTON_CLASS}
      title={SIDE_CHAT_PRESENCE_LABEL}
      aria-label="Open side chat"
      onClick={onClick}
    >
      <ChatsCircle size={16} weight="bold" />
    </button>
  );
}
