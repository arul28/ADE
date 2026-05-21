import { forwardRef, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, File, Globe, Image, X } from "@phosphor-icons/react";
import type { AgentChatContextAttachment, AgentChatFileRef, ChatSurfaceMode } from "../../../shared/types";
import { chatContextAttachmentKey } from "../../../shared/chatContextAttachments";
import { cn } from "../ui/cn";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";

function attachmentName(path: string): string {
  // Split on both POSIX and Windows separators so a Windows path
  // like "C:\\Users\\foo\\bar.png" yields "bar.png" instead of the
  // full path.
  const segments = path.split(/[/\\]/);
  return segments.pop() || path;
}

export type ChatAttachmentPendingImage = {
  id: string;
  name: string;
  previewUrl?: string | null;
};

export const CHAT_IMAGE_ATTACHMENT_FOCUS_SELECTOR = "[data-chat-image-attachment-focus-target='true']";

function focusAdjacentImageAttachment(currentTarget: HTMLElement, delta: -1 | 1): boolean {
  const root = currentTarget.closest("[data-chat-attachment-tray='true']");
  if (!(root instanceof HTMLElement)) return false;
  const targets = Array.from(root.querySelectorAll<HTMLElement>(CHAT_IMAGE_ATTACHMENT_FOCUS_SELECTOR));
  const currentIndex = targets.findIndex((target) => target === currentTarget || target.contains(currentTarget));
  if (currentIndex < 0) return false;
  const next = targets[currentIndex + delta];
  if (!next) return false;
  next.focus({ preventScroll: true });
  return true;
}

function handleImageAttachmentKeyDown(
  event: KeyboardEvent<HTMLElement>,
  args: {
    onRemove?: () => void;
    onFocusPrompt?: () => void;
  },
): void {
  if (event.key === "ArrowDown") {
    if (!args.onFocusPrompt) return;
    event.preventDefault();
    event.stopPropagation();
    args.onFocusPrompt();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (!focusAdjacentImageAttachment(event.currentTarget, event.key === "ArrowLeft" ? -1 : 1)) return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.key !== "Backspace" && event.key !== "Delete") return;
  if (!args.onRemove) return;
  event.preventDefault();
  event.stopPropagation();
  args.onRemove();
  args.onFocusPrompt?.();
}

function LinearIssueContextChip({
  attachment,
  onRemove,
}: {
  attachment: AgentChatContextAttachment;
  onRemove?: (key: string) => void;
}) {
  const issue = attachment.issue;
  const projectLabel = issue.projectName?.trim() || issue.projectSlug || issue.teamKey || null;
  const title = [
    attachment.issue.identifier,
    attachment.issue.title,
    projectLabel,
    attachment.issue.stateName,
  ].filter(Boolean).join(" - ");

  return (
    <span
      className={cn(
        "ade-liquid-glass-pill group inline-flex max-w-full items-center gap-2 rounded-[var(--chat-radius-pill)] border px-2.5 py-1.5 text-[10px] transition-colors",
      )}
      style={{
        borderColor: LINEAR_BRAND.borderSubtle,
        background: LINEAR_BRAND.surface,
        color: LINEAR_BRAND.text,
      }}
      title={title}
      data-testid="linear-issue-context-chip"
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
        style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
      >
        <LinearMark size={9} />
      </span>
      <span
        className="shrink-0 rounded font-mono text-[10px] font-semibold"
        style={{ background: "rgba(255,255,255,0.08)", color: LINEAR_BRAND.text, padding: "1px 4px" }}
      >
        {attachment.issue.identifier}
      </span>
      <span className="min-w-0 max-w-[240px] truncate font-sans text-[11px] font-medium text-fg/90">
        {attachment.issue.title}
      </span>
      {projectLabel ? (
        <span
          className="hidden shrink-0 rounded font-mono text-[9px] sm:inline"
          style={{ background: "rgba(255,255,255,0.05)", color: LINEAR_BRAND.textMuted, padding: "1px 4px" }}
        >
          {projectLabel}
        </span>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="rounded-full text-current/55 transition-colors hover:bg-white/[0.06] hover:text-current"
          title={`Remove ${attachment.issue.identifier}`}
          aria-label={`Remove ${attachment.issue.identifier}`}
          onClick={() => onRemove(chatContextAttachmentKey(attachment))}
        >
          <X size={10} weight="bold" />
        </button>
      ) : null}
    </span>
  );
}

function ImageAttachmentPreview({
  attachment,
  toneClassName,
  initialPreviewUrl,
  onRemove,
  onFocusPrompt,
}: {
  attachment: AgentChatFileRef;
  toneClassName: string;
  initialPreviewUrl?: string | null;
  onRemove?: (path: string) => void;
  onFocusPrompt?: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(initialPreviewUrl ?? null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const name = attachmentName(attachment.path);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(initialPreviewUrl ?? null);
    setPreviewFailed(false);
    if (initialPreviewUrl) {
      return () => {
        cancelled = true;
      };
    }
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
  }, [attachment.path, initialPreviewUrl]);

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

  let copyTitle: string;
  switch (copyState) {
    case "copied":
      copyTitle = "Copied";
      break;
    case "failed":
      copyTitle = "Copy failed";
      break;
    default:
      copyTitle = `Copy ${name}`;
      break;
  }

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
          className="block h-full w-full p-0 focus:outline-none focus:ring-1 focus:ring-white/30"
          title={`Open ${name}`}
          aria-label={`Open ${name}`}
          data-chat-image-attachment-focus-target="true"
          onKeyDown={(event) => handleImageAttachmentKeyDown(event, {
            onRemove: onRemove ? () => onRemove(attachment.path) : undefined,
            onFocusPrompt,
          })}
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
            title={copyTitle}
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
        <ImageLightbox
          name={name}
          dataUrl={dataUrl}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </>
  );
}

function PendingImageAttachmentPreview({
  attachment,
  toneClassName,
  onRemove,
  onFocusPrompt,
}: {
  attachment: ChatAttachmentPendingImage;
  toneClassName: string;
  onRemove?: (id: string) => void;
  onFocusPrompt?: () => void;
}) {
  return (
    <div
      className={cn(
        "group/image relative h-14 w-14 shrink-0 overflow-hidden rounded-md border p-0 text-left transition-colors focus:outline-none focus:ring-1 focus:ring-white/25",
        toneClassName,
      )}
      title={`Attaching ${attachment.name}`}
      aria-label={`Attaching ${attachment.name}`}
      role="status"
      tabIndex={0}
      data-chat-image-attachment-focus-target="true"
      onKeyDown={(event) => handleImageAttachmentKeyDown(event, {
        onRemove: onRemove ? () => onRemove(attachment.id) : undefined,
        onFocusPrompt,
      })}
    >
      {attachment.previewUrl ? (
        <img
          src={attachment.previewUrl}
          alt={`${attachment.name} preview`}
          className="h-full w-full object-cover opacity-80"
          draggable={false}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center bg-black/18 text-current/60">
          <Image size={18} weight="bold" />
        </span>
      )}
      <span className="pointer-events-none absolute inset-x-1 bottom-1 truncate rounded bg-black/65 px-1 py-0.5 text-center text-[8px] text-white/75">
        Saving
      </span>
      {onRemove ? (
        <button
          type="button"
          className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-black/70 text-white/80 transition-colors hover:bg-black hover:text-white"
          title={`Cancel ${attachment.name}`}
          aria-label={`Cancel ${attachment.name}`}
          onClick={() => onRemove(attachment.id)}
        >
          <X size={11} weight="bold" />
        </button>
      ) : null}
    </div>
  );
}

function ImageUrlAttachmentChip({
  path,
  url,
  label,
  toneClassName,
  onRemove,
  onFocusPrompt,
}: {
  path: string;
  url: string;
  label: string;
  toneClassName: string;
  onRemove?: (path: string) => void;
  onFocusPrompt?: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <span
      className={cn(
        "ade-liquid-glass-pill group inline-flex max-w-full items-center gap-2 rounded-[var(--chat-radius-pill)] px-2 py-1 transition-colors focus:outline-none focus:ring-1 focus:ring-white/25",
        toneClassName,
      )}
      title={url}
      tabIndex={0}
      data-chat-image-attachment-focus-target="true"
      onKeyDown={(event) => handleImageAttachmentKeyDown(event, {
        onRemove: onRemove ? () => onRemove(path) : undefined,
        onFocusPrompt,
      })}
    >
      {imageFailed ? (
        <Globe size={12} weight="bold" />
      ) : (
        <img
          src={url}
          alt={label}
          loading="lazy"
          draggable={false}
          onError={() => setImageFailed(true)}
          className="h-8 w-8 shrink-0 rounded-sm border border-white/10 bg-black/30 object-cover"
        />
      )}
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="max-w-[220px] truncate text-[11px] font-medium">{label}</span>
      </span>
      {onRemove ? (
        <button
          type="button"
          className="rounded-full text-current/45 transition-colors hover:bg-white/[0.06] hover:text-current"
          title={`Remove ${label}`}
          aria-label={`Remove ${label}`}
          onClick={() => onRemove(path)}
        >
          <X size={10} weight="bold" />
        </button>
      ) : null}
    </span>
  );
}

function ImageLightbox({
  name,
  dataUrl,
  onClose,
}: {
  name: string;
  dataUrl: string;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Save the element that opened us so focus can return there on close,
  // pull focus into the dialog on mount, and lock body scroll while open so
  // the wheel doesn't move the page behind the overlay.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, []);

  // Close on Escape and trap Tab / Shift-Tab inside the dialog. The dialog
  // contains exactly the close button as a focusable element, so the trap
  // pins focus there in either direction.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const root = containerRef.current;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.tabIndex >= 0);
    if (focusables.length === 0) {
      event.preventDefault();
      closeButtonRef.current?.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey) {
      if (active === first || !active || !root.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !active || !root.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-8"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div className="relative max-h-full max-w-full">
        <button
          ref={closeButtonRef}
          type="button"
          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded border border-white/10 bg-black/70 text-white/80 transition-colors hover:bg-black hover:text-white"
          title="Close"
          aria-label="Close"
          onClick={onClose}
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
    </div>,
    document.body,
  );
}

type ChatAttachmentTrayProps = {
  attachments: AgentChatFileRef[];
  contextAttachments?: AgentChatContextAttachment[];
  pendingImageAttachments?: ChatAttachmentPendingImage[];
  imagePreviewUrls?: Record<string, string | undefined>;
  mode: ChatSurfaceMode;
  onRemove?: (path: string) => void;
  onRemoveContext?: (key: string) => void;
  onRemovePendingImageAttachment?: (id: string) => void;
  onFocusPrompt?: () => void;
  className?: string;
};

export const ChatAttachmentTray = forwardRef<HTMLDivElement, ChatAttachmentTrayProps>(function ChatAttachmentTray({
  attachments,
  contextAttachments = [],
  pendingImageAttachments = [],
  imagePreviewUrls = {},
  mode,
  onRemove,
  onRemoveContext,
  onRemovePendingImageAttachment,
  onFocusPrompt,
  className,
}, ref) {
  if (!attachments.length && !contextAttachments.length && !pendingImageAttachments.length) return null;

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
    <div
      ref={ref}
      className={cn("flex flex-wrap items-center gap-2 px-4 py-3", className)}
      data-chat-attachment-tray="true"
    >
      {contextAttachments.map((attachment) => (
        <LinearIssueContextChip
          key={chatContextAttachmentKey(attachment)}
          attachment={attachment}
          onRemove={onRemoveContext}
        />
      ))}
      {pendingImageAttachments.map((attachment) => (
        <PendingImageAttachmentPreview
          key={attachment.id}
          attachment={attachment}
          toneClassName={chipTone}
          onRemove={onRemovePendingImageAttachment}
          onFocusPrompt={onFocusPrompt}
        />
      ))}
      {attachments.map((attachment) => {
        if (attachment.type === "image-url") {
          const label = (() => {
            try {
              const parsed = new URL(attachment.url);
              return parsed.hostname || attachment.url;
            } catch {
              return attachmentName(attachment.url);
            }
          })();
          return (
            <ImageUrlAttachmentChip
              key={attachment.path}
              path={attachment.path}
              url={attachment.url}
              label={label}
              toneClassName={chipTone}
              onRemove={onRemove}
              onFocusPrompt={onFocusPrompt}
            />
          );
        }
        if (attachment.type === "image") {
          return (
            <ImageAttachmentPreview
              key={attachment.path}
              attachment={attachment}
              toneClassName={chipTone}
              initialPreviewUrl={imagePreviewUrls[attachment.path]}
              onRemove={onRemove}
              onFocusPrompt={onFocusPrompt}
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
                title={`Remove ${attachmentName(attachment.path)}`}
                aria-label={`Remove ${attachmentName(attachment.path)}`}
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
});
