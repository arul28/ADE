import { Suspense, forwardRef, lazy, useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Copy, GithubLogo, Globe, Image, X } from "@phosphor-icons/react";
import type { AgentChatContextAttachment, AgentChatFileRef, ChatSurfaceMode } from "../../../shared/types";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { chatContextAttachmentKey } from "../../../shared/chatContextAttachments";
import { formatAttachmentSize } from "../../../shared/chatAttachmentLimits";
import { githubIssueIdentifier } from "../../../shared/laneGitHubIssue";
import { cn } from "../ui/cn";
import { getFileIcon } from "../files/filePresentation";
import { GITHUB_BRAND } from "../lanes/githubBrand";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";
/**
 * The preview popup pulls in the whole Files viewer platform — Monaco, the PDF
 * and document renderers, the CSV grid. That is a large amount of code for a
 * surface most chats never open, and the composer is on the app's hottest
 * render path, so it loads on first open rather than with the tray.
 */
const ChatAttachmentPreviewModal = lazy(() => import("./ChatAttachmentPreviewModal")
  .then((module) => ({ default: module.ChatAttachmentPreviewModal })));

/**
 * The open-on-demand preview popup every attachment chip shares, so one popup
 * renders the whole set rather than each chip growing its own.
 *
 * `fallbackImageDataUrl` is the only thing the two callers differ on: an image
 * thumbnail has already loaded bytes, and those are the only way to render an
 * attachment that lives outside every workspace, where the Files viewers
 * cannot reach it. A file chip has no such bytes and passes nothing.
 */
function useAttachmentPreview(args: {
  path: string;
  title: string;
  pin: OpenProjectBinding | null;
  fallbackImageDataUrl?: string | null;
}): { open: () => void; element: ReactNode } {
  const [expanded, setExpanded] = useState(false);
  return {
    open: () => setExpanded(true),
    element: expanded ? (
      <Suspense fallback={null}>
        <ChatAttachmentPreviewModal
          attachmentPath={args.path}
          title={args.title}
          pin={args.pin}
          fallbackImageDataUrl={args.fallbackImageDataUrl}
          onClose={() => setExpanded(false)}
        />
      </Suspense>
    ) : null,
  };
}

function attachmentName(path: string): string {
  // Split on both POSIX and Windows separators so a Windows path
  // like "C:\\Users\\foo\\bar.png" yields "bar.png" instead of the
  // full path.
  const segments = path.split(/[/\\]/);
  return segments.pop() || path;
}

/**
 * Keep the head and the extension, elide the middle. A file chip's two useful
 * ends are what the user named it and what type it is; truncating from the
 * right throws the second one away, which is exactly the part that tells them
 * whether they attached the PDF or the spreadsheet.
 */
function middleTruncateFilename(name: string, maxLength = 32): string {
  if (name.length <= maxLength) return name;
  const head = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
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

type OrchestrationAnnotationContextAttachment = Extract<AgentChatContextAttachment, { type: "orchestration_annotation" }>;

function ContextAttachmentChip({
  attachment,
  onRemove,
  onOpen,
}: {
  attachment: AgentChatContextAttachment;
  onRemove?: (key: string) => void;
  onOpen?: (attachment: AgentChatContextAttachment) => void;
}) {
  switch (attachment.type) {
    case "linear_issue":
      return <LinearIssueContextChip attachment={attachment} onRemove={onRemove} onOpen={onOpen} />;
    case "github_issue":
      return <GitHubIssueContextChip attachment={attachment} onRemove={onRemove} onOpen={onOpen} />;
    case "orchestration_annotation":
      return <OrchestrationAnnotationContextChip attachment={attachment} onRemove={onRemove} />;
  }
}

function OrchestrationAnnotationContextChip({
  attachment,
  onRemove,
}: {
  attachment: OrchestrationAnnotationContextAttachment;
  onRemove?: (key: string) => void;
}) {
  const item = attachment.item;
  const anchorKind = item.anchor.kind;
  const previewLabel = item.anchor.preview.trim();
  const commentLabel = item.comment.trim();
  const title = commentLabel.length
    ? `Annotation (${anchorKind}) — ${commentLabel}`
    : `Annotation (${anchorKind}) — ${previewLabel.slice(0, 80)}`;
  return (
    <span
      className={cn(
        "ade-liquid-glass-pill group inline-flex max-w-full items-center gap-2 rounded-[var(--chat-radius-pill)] border px-2.5 py-1.5 text-[10px] transition-colors",
        "border-violet-400/22 bg-violet-500/8 text-violet-100/85",
      )}
      title={title}
      data-testid="orchestration-annotation-context-chip"
    >
      <span
        className="shrink-0 rounded font-mono text-[9px] font-semibold uppercase tracking-wider"
        style={{ background: "rgba(168,130,255,0.16)", color: "rgba(220,210,255,0.92)", padding: "1px 4px" }}
      >
        {anchorKind}
      </span>
      <span className="min-w-0 max-w-[260px] truncate font-sans text-[11px] font-medium text-fg/90">
        {commentLabel.length ? commentLabel : previewLabel || "(no comment)"}
      </span>
      {onRemove ? (
        <button
          type="button"
          className="rounded-full text-current/55 transition-colors hover:bg-white/[0.06] hover:text-current"
          title="Remove annotation"
          aria-label="Remove annotation"
          onClick={() => onRemove(chatContextAttachmentKey(attachment))}
        >
          <X size={10} weight="bold" />
        </button>
      ) : null}
    </span>
  );
}

function LinearIssueContextChip({
  attachment,
  onRemove,
  onOpen,
}: {
  attachment: AgentChatContextAttachment;
  onRemove?: (key: string) => void;
  onOpen?: (attachment: AgentChatContextAttachment) => void;
}) {
  if (attachment.type !== "linear_issue") return null;
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
        onOpen ? "cursor-pointer" : "",
      )}
      style={{
        borderColor: LINEAR_BRAND.borderSubtle,
        background: LINEAR_BRAND.surface,
        color: LINEAR_BRAND.text,
      }}
      title={title}
      data-testid="linear-issue-context-chip"
      onClick={onOpen ? () => onOpen(attachment) : undefined}
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
          onClick={(event) => {
            event.stopPropagation();
            onRemove(chatContextAttachmentKey(attachment));
          }}
        >
          <X size={10} weight="bold" />
        </button>
      ) : null}
    </span>
  );
}

function GitHubIssueContextChip({
  attachment,
  onRemove,
  onOpen,
}: {
  attachment: AgentChatContextAttachment;
  onRemove?: (key: string) => void;
  onOpen?: (attachment: AgentChatContextAttachment) => void;
}) {
  if (attachment.type !== "github_issue") return null;
  const issue = attachment.issue;
  const identifier = githubIssueIdentifier(issue);
  const title = [identifier, issue.title, issue.state].filter(Boolean).join(" - ");
  return (
    <span
      className={cn(
        "ade-liquid-glass-pill group inline-flex max-w-full items-center gap-2 rounded-[var(--chat-radius-pill)] border px-2.5 py-1.5 text-[10px] transition-colors",
        onOpen ? "cursor-pointer" : "",
      )}
      style={{
        borderColor: GITHUB_BRAND.borderSubtle,
        background: GITHUB_BRAND.surface,
        color: GITHUB_BRAND.text,
      }}
      title={title}
      data-testid="github-issue-context-chip"
      onClick={onOpen ? () => onOpen(attachment) : undefined}
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
        style={{ background: GITHUB_BRAND.surfaceHover, color: GITHUB_BRAND.primaryBright }}
      >
        <GithubLogo size={11} weight="fill" />
      </span>
      <span
        className="shrink-0 rounded font-mono text-[10px] font-semibold"
        style={{ background: "rgba(255,255,255,0.08)", color: GITHUB_BRAND.text, padding: "1px 4px" }}
      >
        {identifier}
      </span>
      <span className="min-w-0 max-w-[240px] truncate font-sans text-[11px] font-medium text-fg/90">
        {issue.title}
      </span>
      {onRemove ? (
        <button
          type="button"
          className="rounded-full text-current/55 transition-colors hover:bg-white/[0.06] hover:text-current"
          title={`Remove ${identifier}`}
          aria-label={`Remove ${identifier}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(chatContextAttachmentKey(attachment));
          }}
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
  machinePin,
  onRemove,
  onFocusPrompt,
}: {
  attachment: AgentChatFileRef;
  toneClassName: string;
  initialPreviewUrl?: string | null;
  machinePin: OpenProjectBinding | null;
  onRemove?: (path: string) => void;
  onFocusPrompt?: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(initialPreviewUrl ?? null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const name = attachmentName(attachment.path);
  const preview = useAttachmentPreview({
    path: attachment.path,
    title: name,
    pin: machinePin,
    fallbackImageDataUrl: dataUrl,
  });

  useEffect(() => {
    let cancelled = false;
    setDataUrl(initialPreviewUrl ?? null);
    setPreviewFailed(false);
    if (initialPreviewUrl) {
      return () => {
        cancelled = true;
      };
    }
    const runtimeImageDataUrl = window.ade?.agentChat?.getImageDataUrl;
    const localImageDataUrl = window.ade?.app?.getImageDataUrl;
    if (!runtimeImageDataUrl && !localImageDataUrl) {
      setPreviewFailed(true);
      return;
    }
    const readPreview = async (): Promise<{ dataUrl: string }> => {
      if (!runtimeImageDataUrl) {
        return localImageDataUrl!(attachment.path);
      }
      try {
        return await runtimeImageDataUrl(attachment.path);
      } catch (error) {
        if (!localImageDataUrl) throw error;
        return localImageDataUrl(attachment.path);
      }
    };
    readPreview()
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
          onClick={preview.open}
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
      {preview.element}
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

/**
 * Every non-image attachment, as one chip: type icon, middle-truncated name,
 * human size when known, remove ×.
 *
 * Size is shown only when the caller knows it. The composer does — it staged
 * the file and has the `File.size` — but a chip re-rendered from transcript
 * history has only a path, and statting every attachment of every past message
 * would be a per-chip round trip (two, on a remote machine) to render one
 * label. The chip degrades to name-only rather than paying that, or worse,
 * flashing a number in late.
 */
function FileAttachmentChip({
  attachment,
  toneClassName,
  sizeBytes,
  machinePin,
  onRemove,
  onFocusPrompt,
}: {
  attachment: AgentChatFileRef;
  toneClassName: string;
  sizeBytes?: number;
  machinePin: OpenProjectBinding | null;
  onRemove?: (path: string) => void;
  onFocusPrompt?: () => void;
}) {
  const name = attachmentName(attachment.path);
  const preview = useAttachmentPreview({ path: attachment.path, title: name, pin: machinePin });
  const onOpen = preview.open;
  const { icon: Icon, color } = getFileIcon(name);
  const sizeLabel = typeof sizeBytes === "number" && Number.isFinite(sizeBytes)
    ? formatAttachmentSize(sizeBytes)
    : null;
  return (
    <>
    <span
      className={cn(
        "ade-liquid-glass-pill group inline-flex max-w-full cursor-pointer items-center gap-2 rounded-[var(--chat-radius-pill)] border px-2.5 py-1.5 transition-colors focus:outline-none focus:ring-1 focus:ring-white/25",
        toneClassName,
      )}
      title={sizeLabel ? `${name} — ${sizeLabel}` : name}
      role="button"
      aria-label={`Open ${name}`}
      tabIndex={0}
      data-testid="chat-file-attachment-chip"
      data-chat-image-attachment-focus-target="true"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
          return;
        }
        handleImageAttachmentKeyDown(event, {
          onRemove: onRemove ? () => onRemove(attachment.path) : undefined,
          onFocusPrompt,
        });
      }}
    >
      <Icon size={13} weight="bold" style={{ color }} className="shrink-0" />
      <span className="min-w-0 max-w-[240px] truncate text-[11px] font-medium text-fg/85">
        {middleTruncateFilename(name)}
      </span>
      {sizeLabel ? (
        <span className="shrink-0 text-[10px] tabular-nums text-current/45">{sizeLabel}</span>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="shrink-0 rounded-full text-current/45 transition-colors hover:bg-white/[0.06] hover:text-current"
          title={`Remove ${name}`}
          aria-label={`Remove ${name}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(attachment.path);
          }}
        >
          <X size={10} weight="bold" />
        </button>
      ) : null}
    </span>
    {preview.element}
    </>
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

type ChatAttachmentTrayProps = {
  attachments: AgentChatFileRef[];
  contextAttachments?: AgentChatContextAttachment[];
  pendingImageAttachments?: ChatAttachmentPendingImage[];
  imagePreviewUrls?: Record<string, string | undefined>;
  /**
   * Staged sizes by path. The composer knows them from the `File` it staged;
   * a tray rendered from transcript history does not, and chips render
   * name-only there rather than statting every past attachment.
   */
  attachmentSizes?: Record<string, number | undefined>;
  /**
   * Machine that owns these attachments. The preview popup reads the file
   * through the Files API with this pin, so an attachment staged on a paired
   * host opens from that host instead of resolving a same-named path here.
   */
  machinePin?: OpenProjectBinding | null;
  mode: ChatSurfaceMode;
  onRemove?: (path: string) => void;
  onRemoveContext?: (key: string) => void;
  onOpenContext?: (attachment: AgentChatContextAttachment) => void;
  onRemovePendingImageAttachment?: (id: string) => void;
  onFocusPrompt?: () => void;
  className?: string;
};

export const ChatAttachmentTray = forwardRef<HTMLDivElement, ChatAttachmentTrayProps>(function ChatAttachmentTray({
  attachments,
  contextAttachments = [],
  pendingImageAttachments = [],
  imagePreviewUrls = {},
  attachmentSizes = {},
  machinePin = null,
  mode,
  onRemove,
  onRemoveContext,
  onOpenContext,
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
        <ContextAttachmentChip
          key={chatContextAttachmentKey(attachment)}
          attachment={attachment}
          onRemove={onRemoveContext}
          onOpen={onOpenContext}
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
              machinePin={machinePin}
              onRemove={onRemove}
              onFocusPrompt={onFocusPrompt}
            />
          );
        }
        return (
          <FileAttachmentChip
            key={attachment.path}
            attachment={attachment}
            toneClassName={chipTone}
            sizeBytes={attachmentSizes[attachment.path]}
            machinePin={machinePin}
            onRemove={onRemove}
            onFocusPrompt={onFocusPrompt}
          />
        );
      })}
    </div>
  );
});
