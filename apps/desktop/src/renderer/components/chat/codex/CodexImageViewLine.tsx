import { useEffect, useState } from "react";
import { ArrowUpRight, ImageSquare } from "@phosphor-icons/react";
import type { AgentChatEvent } from "../../../../shared/types";
import { isDataUri } from "../../../../shared/chatImageUrls";
import { basenameCrossPlatform } from "../../../../shared/pathDisplay";
import { readAttachmentImageDataUrl } from "../../../lib/attachmentImage";
import { canOpenInAdeBrowser, openUrlInAdeBrowser } from "../../../lib/openExternal";
import { useChatRuntimeScope } from "../ChatRuntimeScope";

type ImageViewEvent = Extract<AgentChatEvent, { type: "codex_image_view" }>;

type CodexImageViewLineProps = {
  event: ImageViewEvent;
  /** Later image views folded into this row by adjacency (`imageViewSiblings`). */
  siblings?: ImageViewEvent[];
};

function deriveDisplayName(event: ImageViewEvent): string {
  if (event.title?.trim()) return event.title.trim();
  if (event.path?.trim()) return basenameCrossPlatform(event.path.trim());
  if (event.url?.trim()) {
    const raw = event.url.trim();
    // A data URI is not a name. Without this the row printed a megabyte of
    // base64 into a truncating span; the image itself renders below.
    if (isDataUri(raw)) return "image";
    try {
      const parsed = new URL(raw);
      const tail = basenameCrossPlatform(parsed.pathname);
      return tail || parsed.hostname;
    } catch {
      return raw;
    }
  }
  return "image";
}

function stripFileUrlPrefix(value: string | null): string | null {
  if (!value) return value;
  if (!/^file:\/\//i.test(value)) return value;
  const raw = value.replace(/^file:\/\//i, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type ImageViewTarget = {
  displayName: string;
  localPath: string | null;
  url: string | null;
  inlineSrc: string | null;
  canOpen: boolean;
  open: () => void;
};

function imageViewTarget(event: ImageViewEvent): ImageViewTarget {
  const displayName = deriveDisplayName(event);
  // Codex may pass a local path either in `event.path` or as a `file://` URL
  // in `event.url`. Normalize both into a real OS path before handing off to
  // `window.ade.app.openPath` (see plan §B.4).
  const trimmedPath = event.path?.trim() || null;
  const trimmedUrl = event.url?.trim() || null;
  const localPath = stripFileUrlPrefix(trimmedPath)
    ?? (trimmedUrl && /^file:\/\//i.test(trimmedUrl) ? stripFileUrlPrefix(trimmedUrl) : null);
  const url = trimmedUrl
    && !/^file:\/\//i.test(trimmedUrl)
    && canOpenInAdeBrowser(trimmedUrl)
    ? trimmedUrl
    : null;
  // Only a data URI can be previewed from the URL itself: the renderer's CSP
  // pins `img-src` to an explicit host allowlist plus data:/blob:, so a remote
  // URL would paint an empty bordered box (and widening the CSP for this row is
  // not worth an arbitrary-remote-fetch surface). Remote sources keep `open`.
  const inlineSrc = isDataUri(trimmedUrl) ? trimmedUrl : null;
  return {
    displayName,
    localPath,
    url,
    inlineSrc,
    canOpen: Boolean(localPath || url),
    open: () => {
      if (localPath) {
        void window.ade.app.openPath(localPath).catch(() => undefined);
        return;
      }
      if (url) openUrlInAdeBrowser(url);
    },
  };
}

/**
 * The picture behind an image view. A local file is read through the machine
 * that owns it (the chat's pin), the same route chat attachments use, so the
 * reader sees the image the agent saw instead of a bare file name. A refused
 * or missing read leaves null; there is no error state for a thumbnail.
 */
function useImageViewSrc(target: ImageViewTarget): string | null {
  const { pin } = useChatRuntimeScope();
  const [localSrc, setLocalSrc] = useState<string | null>(null);
  const { inlineSrc, localPath } = target;
  useEffect(() => {
    if (inlineSrc || !localPath) return;
    let cancelled = false;
    readAttachmentImageDataUrl(localPath, pin)
      .then(({ dataUrl }) => { if (!cancelled && isDataUri(dataUrl)) setLocalSrc(dataUrl); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [inlineSrc, localPath, pin]);
  return inlineSrc ?? localSrc;
}

function OpenButton({ target }: { target: ImageViewTarget }) {
  if (!target.canOpen) return null;
  return (
    <button
      type="button"
      onClick={target.open}
      className="inline-flex shrink-0 items-center gap-0.5 rounded text-fg/45 transition-colors hover:text-fg/85"
      aria-label="Open image"
      title={target.localPath ? "Open file" : "Open in browser"}
    >
      <ArrowUpRight size={11} weight="bold" />
      <span>open</span>
    </button>
  );
}

/** One tile in a strip: the picture when it loads, else a quiet placeholder. */
function ImageViewTile({ event }: { event: ImageViewEvent }) {
  const target = imageViewTarget(event);
  const src = useImageViewSrc(target);
  return (
    <button
      type="button"
      onClick={target.canOpen ? target.open : undefined}
      disabled={!target.canOpen}
      title={target.localPath ?? target.url ?? target.displayName}
      aria-label={`Open ${target.displayName}`}
      className="group/tile relative h-[68px] w-[108px] shrink-0 overflow-hidden rounded-md border border-white/[0.07] bg-black/25 transition-colors enabled:hover:border-white/[0.18]"
    >
      {src ? (
        <img src={src} alt={target.displayName} loading="lazy" draggable={false} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-1.5 text-fg/35">
          <ImageSquare size={16} weight="duotone" aria-hidden />
          <span className="w-full truncate text-center text-[length:calc(var(--chat-font-size)*9.5/14)]">{target.displayName}</span>
        </span>
      )}
    </button>
  );
}

export function CodexImageViewLine({ event, siblings }: CodexImageViewLineProps) {
  const target = imageViewTarget(event);
  const previewSrc = useImageViewSrc(target);

  // A run of image views: one line that counts them, then one strip.
  if (siblings?.length) {
    const all = [event, ...siblings];
    return (
      <div className="flex flex-col gap-2 pl-6 text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.5] text-fg/55">
        <div className="flex items-center gap-2">
          <span aria-hidden className="select-none text-fg/30">{"↳"}</span>
          <span>Viewed {all.length} images</span>
        </div>
        <div className="flex max-w-full gap-1.5 overflow-x-auto pb-0.5">
          {all.map((item, index) => <ImageViewTile key={`${item.itemId}:${index}`} event={item} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 pl-6 text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.5] text-fg/55">
      <div className="flex items-center gap-2">
        <span aria-hidden className="select-none text-fg/30">{"↳"}</span>
        <span>Viewing image:</span>
        <span className="min-w-0 truncate font-medium text-fg/80" title={target.localPath ?? target.url ?? target.displayName}>
          {target.displayName}
        </span>
        <OpenButton target={target} />
      </div>
      {previewSrc ? (
        <button
          type="button"
          onClick={target.canOpen ? target.open : undefined}
          disabled={!target.canOpen}
          className="inline-flex w-fit max-w-full rounded-lg border border-white/[0.07] bg-black/25 p-1 transition-colors enabled:hover:border-white/[0.16]"
          aria-label={`Open ${target.displayName}`}
        >
          <img
            src={previewSrc}
            alt={target.displayName}
            loading="lazy"
            draggable={false}
            className="max-h-40 max-w-full rounded object-contain"
          />
        </button>
      ) : null}
    </div>
  );
}

export default CodexImageViewLine;
