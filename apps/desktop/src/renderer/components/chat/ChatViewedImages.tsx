/**
 * The pictures behind the images an agent opened, drawn small under the line
 * that names them: an image-view line, or the computer-use action that wrote
 * the file (its screenshot, the picture its observation saved). They stay
 * closed until the reader opens the line; then each is read from the machine
 * that owns the chat, and a click shows it full size.
 */
import { useEffect, useRef, useState } from "react";
import { ImageSquare } from "@phosphor-icons/react";
import { imageViewLocalPath, imageViewName, isDataUri } from "../../../shared/chatImageUrls";
import { readAttachmentImageDataUrl } from "../../lib/attachmentImage";
import { MediaLightbox } from "../ui/MediaLightbox";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import type { CodexImageViewRenderEvent } from "./chatTranscriptRows";

type ViewedImageRead = { src: string | null; failed: boolean };

/**
 * The picture behind one view. A file is read through the machine that owns
 * the chat (its pin), the route chat attachments use, so a chat on another
 * machine shows the file the agent saw there.
 */
function useViewedImageSrc(view: CodexImageViewRenderEvent): ViewedImageRead {
  const { pin } = useChatRuntimeScope();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const inline = isDataUri(view.url) ? view.url!.trim() : null;
  const path = inline ? null : imageViewLocalPath(view);
  const [read, setRead] = useState<ViewedImageRead & { path: string } | null>(null);
  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    // An agent can rewrite the file it viewed at the same path: read it fresh.
    readAttachmentImageDataUrl(path, pinRef.current, { cache: false })
      .then(({ dataUrl }) => {
        if (!cancelled) setRead({ path, src: isDataUri(dataUrl) ? dataUrl : null, failed: !isDataUri(dataUrl) });
      })
      .catch(() => {
        if (!cancelled) setRead({ path, src: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [path, pinKey]);
  if (inline) return { src: inline, failed: false };
  if (!path) return { src: null, failed: true };
  // A new path must not keep showing the previous picture while it loads.
  return read?.path === path ? { src: read.src, failed: read.failed } : { src: null, failed: false };
}

function ViewedImageThumbnail({ view, height }: { view: CodexImageViewRenderEvent; height: number }) {
  const { src, failed } = useViewedImageSrc(view);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const name = imageViewName(view);
  if (!src) {
    // Loading, or gone: a quiet tile with the file's name, never a dead button.
    return (
      <span
        className="flex shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-fg/[0.08] bg-black/25 px-1.5 text-muted-fg"
        style={{ height, width: Math.round(height * 1.6) }}
        title={failed ? `Could not load ${name}` : name}
        data-testid="viewed-image-placeholder"
      >
        <ImageSquare size={14} weight="duotone" aria-hidden />
        <span className="w-full truncate text-center text-[length:calc(var(--chat-font-size)*9.5/14)]">{name}</span>
      </span>
    );
  }
  return (
    <span className="block shrink-0" style={{ height }}>
      <button
        type="button"
        className="block h-full overflow-hidden rounded-md border border-fg/[0.08] bg-black/25 transition-colors hover:border-fg/[0.18] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/45"
        aria-label={`Enlarge ${name}`}
        title={name}
        onClick={() => setLightboxOpen(true)}
      >
        <img src={src} alt={name} draggable={false} className="m-0 block h-full w-auto object-contain" />
      </button>
      {lightboxOpen ? (
        <MediaLightbox src={src} kind="image" title={name} fileName={name} onClose={() => setLightboxOpen(false)} />
      ) : null}
    </span>
  );
}

/** The pictures of some views, small, in one strip that scrolls sideways. */
export function ViewedImageStrip({ views, height }: { views: readonly CodexImageViewRenderEvent[]; height: number }) {
  return (
    <span className="flex min-w-0 max-w-full gap-1.5 overflow-x-auto pb-0.5" data-testid="viewed-image-strip">
      {views.map((view, index) => (
        <ViewedImageThumbnail key={`${view.itemId}:${index}`} view={view} height={height} />
      ))}
    </span>
  );
}
