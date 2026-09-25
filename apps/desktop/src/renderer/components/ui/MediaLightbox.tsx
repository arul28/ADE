import { Check, Copy, DownloadSimple, X } from "@phosphor-icons/react";
import React, { useCallback, useRef, useState } from "react";
import { showToast } from "../app/toast/toastStore";
import { cn } from "./cn";
import { Dialog } from "./dialog";

/**
 * ADE's one full-size viewer for a picture or a video.
 *
 * The media is the whole view: it fits the window at its own aspect, with no
 * header, frame or rounded corners, so nothing of it is cut. A small toolbar
 * shows on hover over its top edge with the tools every opened picture needs:
 * copy (pictures), download, close.
 *
 * `readDataUrl` gives the bytes for copy and download. The renderer's CSP
 * blocks `fetch` of `ade-artifact:` and loopback URLs, so a caller whose
 * `src` is not already a `data:` URL passes a reader (proof uses the
 * runtime's preview read, which works for a local, a paired and a web
 * client). Without one, only a `data:` or `blob:` source can be copied or
 * downloaded, and the tools that cannot work are hidden.
 */
export function MediaLightbox({
  src,
  kind,
  title,
  fileName,
  readDataUrl,
  onMediaError,
  onClose,
}: {
  src: string;
  kind: "image" | "video";
  /** For assistive tech and the download name; never drawn. */
  title: string;
  /** The saved file's name. Defaults to the title plus an extension. */
  fileName?: string;
  readDataUrl?: () => Promise<string | null>;
  onMediaError?: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"copy" | "download" | null>(null);
  const inlineBytes = /^(data|blob):/i.test(src);
  const canReadBytes = inlineBytes || Boolean(readDataUrl);

  const resolveBytes = useCallback(async (): Promise<string | null> => {
    if (inlineBytes) return src;
    return readDataUrl ? await readDataUrl() : null;
  }, [inlineBytes, readDataUrl, src]);

  const copy = useCallback(async () => {
    setBusy("copy");
    try {
      const bytes = await resolveBytes();
      if (!bytes) throw new Error("ADE could not read this picture.");
      await copyPictureToClipboard(bytes);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      showToast({
        title: "Could not copy the picture",
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }, [resolveBytes]);

  const download = useCallback(async () => {
    setBusy("download");
    try {
      const bytes = await resolveBytes();
      if (!bytes) {
        throw new Error(kind === "video"
          ? "This video is too large to download from here."
          : "ADE could not read this picture.");
      }
      saveMediaAs(bytes, fileName ?? defaultFileName(title, bytes, kind));
    } catch (error) {
      showToast({
        title: "Could not download",
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  }, [fileName, kind, resolveBytes, title]);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      hideHeader
      hideClose
      maxHeight="calc(100vh - 32px)"
      bodyPadding={false}
      scrollBody={false}
      // The picture is the panel: no card, border or shadow around it, and the
      // panel is exactly the picture's size, so it stays centered and a click
      // beside it lands on the scrim and closes. `width` is set here, not
      // through the prop, because the prop wraps it in `min()`, where
      // `fit-content` is not valid.
      panelStyle={{
        width: "fit-content",
        maxWidth: "calc(100vw - 32px)",
        background: "transparent",
        border: "none",
        boxShadow: "none",
        borderRadius: 0,
        overflow: "visible",
      }}
      initialFocusRef={closeRef}
    >
      <div data-media-lightbox="" className="group/lightbox relative">
        {kind === "video" ? (
          <video
            src={src}
            controls
            autoPlay
            playsInline
            onError={onMediaError}
            aria-label={title}
            className="block h-auto max-h-[calc(100vh-32px)] w-auto max-w-[calc(100vw-32px)] bg-black object-contain"
          />
        ) : (
          <img
            src={src}
            alt={title}
            onError={onMediaError}
            className="block h-auto max-h-[calc(100vh-32px)] w-auto max-w-[calc(100vw-32px)] object-contain"
          />
        )}
        <div
          // Hidden until the pointer is over the media or a tool has keyboard focus, so
          // the picture shows whole and unobstructed.
          className="absolute right-2.5 top-2.5 flex items-center gap-0.5 rounded-lg border border-white/[0.12] bg-black/60 p-0.5 text-white/80 opacity-0 shadow-[0_6px_24px_rgba(0,0,0,0.45)] backdrop-blur-md transition-opacity duration-150 has-[:focus-visible]:opacity-100 group-hover/lightbox:opacity-100"
        >
          {kind === "image" && canReadBytes ? (
            <LightboxTool
              label={copied ? "Copied" : "Copy picture"}
              disabled={busy !== null}
              onClick={() => void copy()}
            >
              {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
            </LightboxTool>
          ) : null}
          {canReadBytes ? (
            <LightboxTool label="Download" disabled={busy !== null} onClick={() => void download()}>
              <DownloadSimple size={14} />
            </LightboxTool>
          ) : null}
          <LightboxTool ref={closeRef} label="Close" onClick={onClose}>
            <X size={14} weight="bold" />
          </LightboxTool>
        </div>
      </div>
    </Dialog>
  );
}

const LightboxTool = React.forwardRef<HTMLButtonElement, {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}>(function LightboxTool({ label, disabled, onClick, children }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        "hover:bg-white/[0.12] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40",
        "disabled:opacity-50",
      )}
    >
      {children}
    </button>
  );
});

/**
 * Puts a picture on the clipboard. `src` must be a `data:` or `blob:` URL; the
 * CSP blocks reading anything else from the renderer.
 */
export async function copyPictureToClipboard(src: string): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": await toPngBlob(src) })]);
}

/** Saves a `data:` or `blob:` URL as a file, through the save dialog. */
export function saveMediaAs(src: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = src;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** The clipboard takes PNG only, so any other picture is redrawn as one. */
async function toPngBlob(dataUrl: string): Promise<Blob> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("ADE could not prepare the picture.");
  context.drawImage(image, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("ADE could not prepare the picture."))), "image/png");
  });
}

function defaultFileName(title: string, bytes: string, kind: "image" | "video"): string {
  const mime = /^data:([^;,]+)/i.exec(bytes)?.[1]?.toLowerCase() ?? "";
  const extension = mime.split("/")[1]?.replace("jpeg", "jpg").replace("quicktime", "mov")
    ?? (kind === "video" ? "mp4" : "png");
  const base = title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "ade-proof";
  return `${base}.${extension}`;
}
