import { useEffect, useState, type MouseEvent } from "react";
import { Copy, File, Image, X } from "@phosphor-icons/react";
import type { AgentChatFileRef, ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";

function attachmentName(path: string): string {
  return path.split("/").pop() || path;
}

function ImageAttachmentPreview({
  attachment,
  toneClassName,
  onRemove,
}: {
  attachment: AgentChatFileRef;
  toneClassName: string;
  onRemove?: (path: string) => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const name = attachmentName(attachment.path);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setPreviewFailed(false);
    if (!window.ade?.app?.getImageDataUrl) {
      setPreviewFailed(true);
      return;
    }
    window.ade.app.getImageDataUrl(attachment.path)
      .then((result) => {
        if (!cancelled) setDataUrl(result.dataUrl);
      })
      .catch(() => {
        if (!cancelled) setPreviewFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.path]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1200);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copyImage = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    try {
      await window.ade.app.writeClipboardImage(attachment.path);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <>
      <div
        className={cn(
          "group/image relative h-14 w-14 shrink-0 overflow-hidden rounded-md border p-0 text-left transition-colors focus:outline-none focus:ring-1 focus:ring-white/25",
          toneClassName,
        )}
      >
        <button
          type="button"
          className="block h-full w-full p-0"
          title={`Open ${name}`}
          aria-label={`Open ${name}`}
          onClick={() => {
            if (dataUrl) setExpanded(true);
          }}
        >
          {dataUrl ? (
            <img src={dataUrl} alt={name} className="h-full w-full object-cover" draggable={false} />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-black/18 text-current/60">
              <Image size={18} weight="bold" />
            </span>
          )}
        </button>
        {previewFailed ? (
          <span className="absolute inset-x-1 bottom-1 truncate rounded bg-black/65 px-1 py-0.5 text-center text-[8px] text-white/75">
            No preview
          </span>
        ) : null}
        <span className="pointer-events-none absolute inset-0 flex items-start justify-end gap-1 bg-black/0 p-1 opacity-0 transition-opacity group-hover/image:bg-black/35 group-hover/image:opacity-100 group-focus-within/image:bg-black/35 group-focus-within/image:opacity-100">
          <button
            type="button"
            className="pointer-events-auto inline-flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-black/70 text-white/80 transition-colors hover:bg-black hover:text-white"
            title={copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : `Copy ${name}`}
            aria-label={`Copy ${name}`}
            onClick={copyImage}
          >
            <Copy size={11} weight="bold" />
          </button>
          {onRemove ? (
            <button
              type="button"
              className="pointer-events-auto inline-flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-black/70 text-white/80 transition-colors hover:bg-black hover:text-white"
              title={`Remove ${name}`}
              aria-label={`Remove ${name}`}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(attachment.path);
              }}
            >
              <X size={11} weight="bold" />
            </button>
          ) : null}
        </span>
      </div>
      {expanded && dataUrl ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-8"
          role="dialog"
          aria-modal="true"
          aria-label={name}
          onClick={() => setExpanded(false)}
        >
          <div className="relative max-h-full max-w-full">
            <button
              type="button"
              className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded border border-white/10 bg-black/70 text-white/80 transition-colors hover:bg-black hover:text-white"
              title="Close"
              aria-label="Close"
              onClick={() => setExpanded(false)}
            >
              <X size={14} weight="bold" />
            </button>
            <img
              src={dataUrl}
              alt={name}
              className="max-h-[calc(100vh-4rem)] max-w-[calc(100vw-4rem)] rounded-md object-contain"
              onClick={(event) => event.stopPropagation()}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

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
      {attachments.map((attachment) => {
        if (attachment.type === "image") {
          return (
            <ImageAttachmentPreview
              key={attachment.path}
              attachment={attachment}
              toneClassName={chipTone}
              onRemove={onRemove}
            />
          );
        }
        return (
          <span
            key={attachment.path}
            className={cn(
              "ade-liquid-glass-pill group inline-flex max-w-full items-center gap-2 rounded-[var(--chat-radius-pill)] px-2.5 py-1.5 font-mono text-[10px] transition-colors",
              chipTone,
            )}
          >
            <File size={12} weight="bold" />
            <span className="max-w-[260px] truncate">{attachmentName(attachment.path)}</span>
            {onRemove ? (
              <button
                type="button"
                className="rounded-full text-current/45 transition-colors hover:bg-white/[0.06] hover:text-current"
                title={`Remove ${attachment.path}`}
                onClick={() => onRemove(attachment.path)}
              >
                <X size={10} weight="bold" />
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
