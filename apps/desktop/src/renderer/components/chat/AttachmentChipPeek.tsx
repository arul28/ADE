// The small pieces an inline attachment chip shares between the composer and
// the transcript: its thumbnail source and the hover peek.
//
// The composer draws its chips as raw DOM inside a contentEditable, the
// transcript draws them with React, so the chip bodies differ. What must not
// differ is how an `[Image #k]` chip finds its picture and what hovering it
// shows — those live here.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AgentChatFileRef } from "../../../shared/types";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { readAttachmentImageDataUrl } from "../../lib/attachmentImage";
import { ViewportOverlayHost } from "../ui/ViewportOverlayHost";

/** Edge of the hover peek. Large enough to recognize, small enough to stay out of the way. */
const PEEK_SIZE_PX = 160;
const PEEK_GAP_PX = 6;

/**
 * The image an attachment chip shows: the caller's already-loaded preview when
 * it has one, the URL itself for an `image-url`, otherwise one read through the
 * machine that owns the attachment. Null for a non-image, or until the read lands.
 */
export function useAttachmentThumbnail(
  attachment: AgentChatFileRef | null,
  pin: OpenProjectBinding | null,
  initialUrl?: string | null,
): string | null {
  const path = attachment?.type === "image" ? attachment.path : null;
  const directUrl = attachment?.type === "image-url" ? attachment.url : null;
  const [dataUrl, setDataUrl] = useState<string | null>(initialUrl ?? null);
  // The read is keyed on the pin's identity, not the object, so a re-created
  // pin for the same machine does not read the image again.
  const pinRef = useRef(pin);
  pinRef.current = pin;

  useEffect(() => {
    let cancelled = false;
    setDataUrl(initialUrl ?? null);
    if (!path || initialUrl) return;
    readAttachmentImageDataUrl(path, pinRef.current)
      .then((result) => {
        if (!cancelled) setDataUrl(result.dataUrl);
      })
      .catch(() => {
        // No thumbnail is a degraded chip, not an error: it keeps its glyph.
      });
    return () => {
      cancelled = true;
    };
  }, [initialUrl, path, pin?.key]);

  return directUrl ?? dataUrl;
}

/**
 * A ~160px look at an image chip, above its anchor. Portaled to the body
 * because both homes of a chip clip: the user bubble is `overflow-hidden` and
 * the composer editor scrolls.
 */
export function AttachmentPeekCard({
  anchor,
  src,
  name,
}: {
  anchor: HTMLElement | null;
  src: string | null;
  name: string;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !src) {
      setPosition(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth || PEEK_SIZE_PX;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, viewportWidth - PEEK_SIZE_PX - 8));
    // Prefer above the chip; drop below when the chip sits near the top.
    const above = rect.top - PEEK_SIZE_PX - PEEK_GAP_PX;
    const top = above >= 8 ? above : rect.bottom + PEEK_GAP_PX;
    setPosition({ left, top });
  }, [anchor, src]);

  if (!anchor || !src || !position || typeof document === "undefined") return null;
  return createPortal(
    // The shared host owns the viewport anchoring and the tooltip layer, so
    // the card is placed inside it at the viewport point computed above.
    <ViewportOverlayHost layer="tooltip">
      <div
        aria-hidden
        className="pointer-events-none absolute overflow-hidden rounded-md border border-white/[0.12] bg-black/70 shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
        style={{
          left: position.left,
          top: position.top,
          width: PEEK_SIZE_PX,
          height: PEEK_SIZE_PX,
        }}
        data-chat-attachment-peek=""
      >
        <img src={src} alt={name} className="h-full w-full object-contain" draggable={false} />
      </div>
    </ViewportOverlayHost>,
    document.body,
  );
}
