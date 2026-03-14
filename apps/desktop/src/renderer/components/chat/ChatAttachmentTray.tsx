import { File, Image, X } from "@phosphor-icons/react";
import type { AgentChatFileRef, ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";

export function ChatAttachmentTray({
  attachments,
  mode,
  onRemove,
  className,
}: {
  attachments: AgentChatFileRef[];
  mode: ChatSurfaceMode;
  onRemove?: (path: string) => void;
  className?: string;
}) {
  if (!attachments.length) return null;

  let chipTone: string;
  switch (mode) {
    case "resolver":
      chipTone = "border-orange-400/18 bg-orange-500/10 text-orange-100";
      break;
    case "mission-feed":
      chipTone = "border-emerald-400/18 bg-emerald-500/10 text-emerald-100";
      break;
    case "mission-thread":
      chipTone = "border-sky-400/18 bg-sky-500/10 text-sky-100";
      break;
    default:
      chipTone = "border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)] text-fg/82";
      break;
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2 px-4 py-3", className)}>
      {attachments.map((attachment) => (
        <span
          key={attachment.path}
          className={cn(
            "group inline-flex max-w-full items-center gap-2 border px-2.5 py-1 font-mono text-[10px] transition-colors",
            chipTone,
          )}
        >
          {attachment.type === "image" ? <Image size={12} weight="bold" /> : <File size={12} weight="bold" />}
          <span className="max-w-[260px] truncate">{attachment.path}</span>
          {onRemove ? (
            <button
              type="button"
              className="text-current/45 transition-colors hover:text-current"
              title={`Remove ${attachment.path}`}
              onClick={() => onRemove(attachment.path)}
            >
              <X size={10} weight="bold" />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}
