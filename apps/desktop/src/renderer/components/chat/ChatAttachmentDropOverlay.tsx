import { cn } from "../ui/cn";
import { PARALLEL_CHAT_MAX_ATTACHMENTS } from "../../../shared/types/chat";

export function ChatAttachmentDropOverlay({
  variant,
  parallelChatMode = false,
}: {
  variant: "composer" | "pane";
  parallelChatMode?: boolean;
}) {
  const compact = variant === "composer";
  return (
    <div className={cn(
      "flex h-full w-full items-center justify-center bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,rgba(5,5,8,0.58))] backdrop-blur-sm",
      compact && "bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,rgba(5,5,8,0.58))]",
    )}>
      <div className={cn(
        "rounded-[var(--chat-radius-card)] border border-[color:color-mix(in_srgb,var(--chat-accent)_34%,transparent)] bg-card/92 text-center shadow-[var(--chat-composer-shadow)]",
        compact ? "px-5 py-4" : "px-6 py-5",
      )}>
        <div className={cn(
          "font-mono uppercase tracking-[0.18em] text-[var(--chat-accent)]",
          compact
            ? "text-[length:calc(var(--chat-font-size)*10/14)]"
            : "text-[length:calc(var(--chat-font-size)*11/14)]",
        )}>
          Drop files to attach
        </div>
        <div className={cn(
          "mt-1 text-fg/74",
          compact
            ? "text-[length:calc(var(--chat-font-size)*12/14)]"
            : "font-sans text-[length:calc(var(--chat-font-size)*12/14)]",
        )}>
          {compact && parallelChatMode
            ? `Up to ${PARALLEL_CHAT_MAX_ATTACHMENTS} files, sent to every parallel lane.`
            : "Images and files will be added to this turn."}
        </div>
      </div>
    </div>
  );
}
