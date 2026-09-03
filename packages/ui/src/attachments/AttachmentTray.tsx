/**
 * The generic half of the desktop app's `components/chat/ChatAttachmentTray.tsx`.
 *
 * Every chip's markup, class names, `data-*` hooks and keyboard model are
 * verbatim. What changed is the *inputs*: the compiled chips resolve their own
 * data from the renderer, and none of that can cross into a plugin page, so the
 * ports take the resolved values as props instead.
 *
 * Deliberately NOT ported, because each one needs the app:
 *
 * - `useAttachmentPreview` / `ChatAttachmentPreviewModal` — the popup drags in
 *   the whole Files viewer platform (Monaco, the PDF and document renderers,
 *   the CSV grid). Chips take an `onOpen` callback and the host decides what
 *   opening means.
 * - `ContextAttachmentChip`'s `useBuiltinSurfaceVisible("linear")` gate — that
 *   reads the app's installed-plugin state. Callers pass `onOpen` or omit it.
 * - `chatContextAttachmentKey`, `githubIssueIdentifier`, `formatAttachmentSize`
 *   and `getFileIcon` — renderer/shared modules. The chips take the already
 *   computed key, identifier, size label and icon.
 * - `machinePin` — an `OpenProjectBinding` is an Electron-side concept and only
 *   existed to route the preview popup, which is gone with it.
 * - The tray's own branching over `AgentChatFileRef` types: `AttachmentTray` is
 *   just the container, and callers compose the chips they need.
 */

import { forwardRef, useEffect, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Copy, File, Globe, Image, X } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { cn } from "../primitives/cn";

/** Filename from a POSIX or Windows path. */
export function attachmentName(path: string): string {
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
export function middleTruncateFilename(name: string, maxLength = 32): string {
  if (name.length <= maxLength) return name;
  const head = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

export const CHAT_IMAGE_ATTACHMENT_FOCUS_SELECTOR = "[data-chat-image-attachment-focus-target='true']";

export function focusAdjacentImageAttachment(currentTarget: HTMLElement, delta: -1 | 1): boolean {
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

export function handleImageAttachmentKeyDown(
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

/**
 * The tone every chip in one tray shares. Verbatim from the compiled tray's
 * `chipTone` switch, which is the only thing `ChatSurfaceMode` was read for.
 */
export function attachmentChipTone(mode: "resolver" | "default"): string {
  switch (mode) {
    case "resolver":
      return "border-orange-400/18 bg-orange-500/10 text-orange-100";
    default:
      return "border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)] text-fg/82";
  }
}

/**
 * The tray container. Callers compose the chips: which `AgentChatFileRef` type
 * maps to which chip is the app's business, not the kit's.
 */
export const AttachmentTray = forwardRef<
  HTMLDivElement,
  { children?: ReactNode; className?: string }
>(function AttachmentTray({ children, className }, ref) {
  return (
    <div
      ref={ref}
      className={cn("flex flex-wrap items-center gap-2 px-4 py-3", className)}
      data-chat-attachment-tray="true"
    >
      {children}
    </div>
  );
});

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
 *
 * The icon arrives as a prop: `getFileIcon` is a renderer module, and a page
 * that knows its own file types can pass a better one.
 */
export function FileAttachmentChip({
  name,
  sizeLabel,
  icon: Icon = File,
  iconColor,
  toneClassName,
  onOpen,
  onRemove,
  onFocusPrompt,
}: {
  name: string;
  sizeLabel?: string | null;
  icon?: Icon;
  iconColor?: string;
  toneClassName: string;
  onOpen?: () => void;
  onRemove?: () => void;
  onFocusPrompt?: () => void;
}) {
  return (
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
          onOpen?.();
          return;
        }
        handleImageAttachmentKeyDown(event, {
          ...(onRemove ? { onRemove } : {}),
          ...(onFocusPrompt ? { onFocusPrompt } : {}),
        });
      }}
    >
      <Icon size={13} weight="bold" style={{ color: iconColor }} className="shrink-0" />
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
            onRemove();
          }}
        >
          <X size={10} weight="bold" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * An image attachment thumbnail.
 *
 * The compiled version reads the bytes itself through `window.ade`, retrying a
 * remote runtime against the local one; here the caller supplies `dataUrl` and
 * says whether reading it failed. Copy is drawn only when `onCopy` is given —
 * the clipboard write is the host's, and the three title states are driven from
 * whether its promise resolves.
 */
export function ImageAttachmentPreview({
  name,
  dataUrl,
  previewFailed = false,
  toneClassName,
  onOpen,
  onRemove,
  onCopy,
  onFocusPrompt,
}: {
  name: string;
  dataUrl?: string | null;
  previewFailed?: boolean;
  toneClassName: string;
  onOpen?: () => void;
  onRemove?: () => void;
  onCopy?: () => Promise<unknown>;
  onFocusPrompt?: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1200);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copyImage = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!onCopy) return;
    try {
      await onCopy();
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
          ...(onRemove ? { onRemove } : {}),
          ...(onFocusPrompt ? { onFocusPrompt } : {}),
        })}
        onClick={onOpen}
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
        {onCopy ? (
          <button
            type="button"
            className="pointer-events-auto inline-flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-black/70 text-white/80 transition-colors hover:bg-black hover:text-white"
            title={copyTitle}
            aria-label={`Copy ${name}`}
            onClick={copyImage}
          >
            <Copy size={11} weight="bold" />
          </button>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            className="pointer-events-auto inline-flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-black/70 text-white/80 transition-colors hover:bg-black hover:text-white"
            title={`Remove ${name}`}
            aria-label={`Remove ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            <X size={11} weight="bold" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** An image still being written to disk: the same tile, greyed, with "Saving". */
export function PendingImageAttachmentPreview({
  name,
  previewUrl,
  toneClassName,
  onRemove,
  onFocusPrompt,
}: {
  name: string;
  previewUrl?: string | null;
  toneClassName: string;
  onRemove?: () => void;
  onFocusPrompt?: () => void;
}) {
  return (
    <div
      className={cn(
        "group/image relative h-14 w-14 shrink-0 overflow-hidden rounded-md border p-0 text-left transition-colors focus:outline-none focus:ring-1 focus:ring-white/25",
        toneClassName,
      )}
      title={`Attaching ${name}`}
      aria-label={`Attaching ${name}`}
      role="status"
      tabIndex={0}
      data-chat-image-attachment-focus-target="true"
      onKeyDown={(event) => handleImageAttachmentKeyDown(event, {
        ...(onRemove ? { onRemove } : {}),
        ...(onFocusPrompt ? { onFocusPrompt } : {}),
      })}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={`${name} preview`}
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
          title={`Cancel ${name}`}
          aria-label={`Cancel ${name}`}
          onClick={() => onRemove()}
        >
          <X size={11} weight="bold" />
        </button>
      ) : null}
    </div>
  );
}

/** A remote image referenced by URL: the thumbnail falls back to a globe. */
export function ImageUrlAttachmentChip({
  url,
  label,
  toneClassName,
  onRemove,
  onFocusPrompt,
}: {
  url: string;
  label: string;
  toneClassName: string;
  onRemove?: () => void;
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
        ...(onRemove ? { onRemove } : {}),
        ...(onFocusPrompt ? { onFocusPrompt } : {}),
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
          onClick={() => onRemove()}
        >
          <X size={10} weight="bold" />
        </button>
      ) : null}
    </span>
  );
}

/** The brand surface an issue chip paints itself with. */
export type IssueAttachmentBrand = {
  borderSubtle: string;
  surface: string;
  surfaceHover: string;
  text: string;
  textMuted: string;
  primaryBright: string;
};

/**
 * One chip for an attached issue.
 *
 * `LinearIssueContextChip` and `GitHubIssueContextChip` were the same markup
 * with a different brand and glyph, and the only structural difference — the
 * Linear chip's project pill — is just its optional `secondaryLabel`. One
 * component, two brands.
 */
export function IssueAttachmentChip({
  identifier,
  title,
  secondaryLabel,
  brand,
  glyph,
  tooltip,
  testId,
  onOpen,
  onRemove,
}: {
  identifier: string;
  title: string;
  secondaryLabel?: string | null;
  brand: IssueAttachmentBrand;
  glyph: ReactNode;
  tooltip?: string;
  testId?: string;
  onOpen?: () => void;
  onRemove?: () => void;
}) {
  return (
    <span
      className={cn(
        "ade-liquid-glass-pill group inline-flex max-w-full items-center gap-2 rounded-[var(--chat-radius-pill)] border px-2.5 py-1.5 text-[10px] transition-colors",
        onOpen ? "cursor-pointer" : "",
      )}
      style={{
        borderColor: brand.borderSubtle,
        background: brand.surface,
        color: brand.text,
      }}
      title={tooltip ?? [identifier, title, secondaryLabel].filter(Boolean).join(" - ")}
      data-testid={testId}
      onClick={onOpen ? () => onOpen() : undefined}
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
        style={{ background: brand.surfaceHover, color: brand.primaryBright }}
      >
        {glyph}
      </span>
      <span
        className="shrink-0 rounded font-mono text-[10px] font-semibold"
        style={{ background: "rgba(255,255,255,0.08)", color: brand.text, padding: "1px 4px" }}
      >
        {identifier}
      </span>
      <span className="min-w-0 max-w-[240px] truncate font-sans text-[11px] font-medium text-fg/90">
        {title}
      </span>
      {secondaryLabel ? (
        <span
          className="hidden shrink-0 rounded font-mono text-[9px] sm:inline"
          style={{ background: "rgba(255,255,255,0.05)", color: brand.textMuted, padding: "1px 4px" }}
        >
          {secondaryLabel}
        </span>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="rounded-full text-current/55 transition-colors hover:bg-white/[0.06] hover:text-current"
          title={`Remove ${identifier}`}
          aria-label={`Remove ${identifier}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X size={10} weight="bold" />
        </button>
      ) : null}
    </span>
  );
}

/** An orchestration annotation carried into the turn as context. */
export function OrchestrationAnnotationChip({
  anchorKind,
  comment,
  preview,
  onRemove,
}: {
  anchorKind: string;
  comment: string;
  preview: string;
  onRemove?: () => void;
}) {
  const previewLabel = preview.trim();
  const commentLabel = comment.trim();
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
          onClick={() => onRemove()}
        >
          <X size={10} weight="bold" />
        </button>
      ) : null}
    </span>
  );
}
