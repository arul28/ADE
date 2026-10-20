import { useEffect, useState } from "react";
import {
  Check,
  Code,
  Copy,
  DownloadSimple,
  Eye,
  GridFour,
} from "@phosphor-icons/react";
import { showToast } from "../../../app/toast/toastStore";
import { copyPictureToClipboard, saveMediaAs } from "../../../ui/MediaLightbox";
import { COLORS, fgTint } from "../../../lanes/laneDesignTokens";
import { formatBytes } from "../../../../../shared/formatting";
import { LEGACY_MAX_CHAT_ATTACHMENT_BYTES } from "../../../../../shared/chatAttachmentLimits";
import { base64ToBytes, bytesToBase64 } from "../../../../lib/base64";
import type { PinnedFilesApi } from "../pinnedFilesApi";
import { streamFileBytes } from "../streamBytes";
import { CONVERTED_IMAGE_EXTS, extensionOf } from "../viewerRegistry";
import type { FileContent } from "../../../../../shared/types";
import type { ViewerProps } from "./types";
import { CodeViewer } from "./CodeViewer";
import { DocumentSurface } from "./DocumentSurface";
import { usePanZoom } from "./usePanZoom";
import { ViewerModeToggleButton } from "./ViewerModeToggle";
import { ZoomControls } from "./ZoomControls";
import { readViewerMode, rememberViewerMode } from "./viewerModeMemory";

/** SVG is held whole (as an image and as Source text). */
const MAX_SVG_BYTES = 25 * 1024 * 1024;
/** Raster images without inline bytes stream into a blob URL up to this size. */
const MAX_RASTER_PREVIEW_BYTES = 100 * 1024 * 1024;
/**
 * TIFF/HEIC bytes cross IPC as base64 to the main-process converter, which
 * refuses anything over the legacy attachment cap.
 */
const MAX_CONVERTED_IMAGE_BYTES = LEGACY_MAX_CHAT_ATTACHMENT_BYTES;
const ALPHA_IMAGE_EXTS = /\.(?:svg|png|webp|gif)$/i;
type Mode = "image" | "source";

type ImageLoadContext = {
  files: PinnedFilesApi;
  workspaceId: string;
  path: string;
  title: string;
  mimeType: string;
  size: number;
  /** The inline payload, or null when the bytes must be streamed. */
  inline: { content: string; encoding: FileContent["encoding"] } | null;
  isCancelled: () => boolean;
};

/** A ready image source; `objectUrl` sources must be revoked by the caller. */
type LoadedImage = {
  src: string;
  objectUrl: boolean;
  svgText?: string;
  converted?: boolean;
};

/** SVG keeps its original bytes for the <img> and decodes them once for Source mode. */
async function loadSvg(ctx: ImageLoadContext): Promise<LoadedImage | null> {
  const bytes = ctx.inline
    ? ctx.inline.encoding === "base64"
      ? base64ToBytes(ctx.inline.content)
      : new TextEncoder().encode(ctx.inline.content)
    : await streamFileBytes(ctx.files, ctx.workspaceId, ctx.path, {
        isCancelled: ctx.isCancelled,
        maxBytes: MAX_SVG_BYTES,
      });
  if (ctx.isCancelled()) return null;
  return {
    src: URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" })),
    objectUrl: true,
    svgText: new TextDecoder("utf-8").decode(bytes),
  };
}

/** TIFF/HEIC: stream the bytes and have the host convert them to JPEG. */
async function loadConverted(
  ctx: ImageLoadContext,
): Promise<LoadedImage | null> {
  const format = /^tiff?$/.test(extensionOf(ctx.path)) ? "TIFF" : "HEIC";
  // Reject by declared size before streaming bytes the converter would refuse.
  if (ctx.size > MAX_CONVERTED_IMAGE_BYTES) {
    throw new Error(
      `This ${format} image is ${formatBytes(ctx.size)}. ADE converts images up to ${formatBytes(MAX_CONVERTED_IMAGE_BYTES)} for preview.`,
    );
  }
  const bytes = await streamFileBytes(ctx.files, ctx.workspaceId, ctx.path, {
    isCancelled: ctx.isCancelled,
    maxBytes: MAX_CONVERTED_IMAGE_BYTES,
  });
  if (ctx.isCancelled()) return null;
  const convert = window.ade.app.convertImageToJpeg;
  if (!convert)
    throw new Error("Image conversion is unavailable on this system.");
  const result = await convert({
    data: bytesToBase64(bytes),
    filename: ctx.path.split(/[\\/]/).pop() ?? ctx.title,
    mimeType: ctx.mimeType,
  });
  if (!result.ok) {
    throw new Error(
      result.errorCode === "unavailable"
        ? `This system can't decode ${format} images in ADE.`
        : "ADE could not convert this image for preview.",
    );
  }
  if (ctx.isCancelled()) return null;
  return {
    src: URL.createObjectURL(
      new Blob([base64ToBytes(result.data)], {
        type: result.mimeType || "image/jpeg",
      }),
    ),
    objectUrl: true,
    converted: true,
  };
}

/**
 * Raster images use inline base64 as a data URL when the payload has it;
 * otherwise they stream bounded bytes into a temporary blob URL.
 */
async function loadRaster(ctx: ImageLoadContext): Promise<LoadedImage | null> {
  if (ctx.inline?.encoding === "base64") {
    return {
      src: `data:${ctx.mimeType};base64,${ctx.inline.content}`,
      objectUrl: false,
    };
  }
  if (ctx.size > MAX_RASTER_PREVIEW_BYTES) {
    throw new Error(
      `Image is too large for inline preview (${formatBytes(ctx.size)}).`,
    );
  }
  const bytes = await streamFileBytes(ctx.files, ctx.workspaceId, ctx.path, {
    isCancelled: ctx.isCancelled,
    maxBytes: MAX_RASTER_PREVIEW_BYTES,
  });
  if (ctx.isCancelled()) return null;
  return {
    src: URL.createObjectURL(new Blob([bytes], { type: ctx.mimeType })),
    objectUrl: true,
  };
}

/** Toolbar for image controls shared by raster and SVG previews. */
function ImageToolbar({
  isSvg,
  mode,
  setMode,
  scale,
  fit,
  onZoomIn,
  onZoomOut,
  onFit,
  checkerboard,
  onToggleCheckerboard,
  size,
  converted,
  src,
  copied,
  onCopy,
  onDownload,
}: {
  isSvg: boolean;
  mode: Mode;
  setMode: (mode: Mode) => void;
  scale: number;
  fit: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  checkerboard: boolean;
  onToggleCheckerboard: () => void;
  size: number;
  converted: boolean;
  src: string | null;
  copied: boolean;
  onCopy: () => void;
  onDownload: () => void;
}) {
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5"
      style={{ borderColor: COLORS.border }}
    >
      {isSvg ? (
        <>
          <ViewerModeToggleButton
            active={mode === "image"}
            onClick={() => setMode("image")}
            icon={<Eye size={14} />}
            label="Image"
          />
          <ViewerModeToggleButton
            active={mode === "source"}
            onClick={() => setMode("source")}
            icon={<Code size={14} />}
            label="Source"
          />
        </>
      ) : null}
      {mode === "image" ? (
        <>
          <ZoomControls
            percent={scale * 100}
            onZoomOut={onZoomOut}
            onZoomIn={onZoomIn}
            onFit={onFit}
            fitActive={fit}
          />
          <button
            type="button"
            onClick={onToggleCheckerboard}
            title={
              checkerboard ? "Hide transparency grid" : "Show transparency grid"
            }
            aria-label="Transparency grid"
            aria-pressed={checkerboard}
            className="rounded p-1"
            style={{
              color: checkerboard ? COLORS.textPrimary : COLORS.textMuted,
              background: checkerboard ? fgTint(7) : "transparent",
            }}
          >
            <GridFour size={15} />
          </button>
        </>
      ) : null}
      <span className="ml-auto text-xs" style={{ color: COLORS.textDim }}>
        {formatBytes(size)}
        {converted ? " · Converted for preview" : ""}
      </span>
      {mode === "image" ? (
        <>
          <button
            type="button"
            disabled={!src}
            onClick={onCopy}
            title={copied ? "Copied" : "Copy picture"}
            aria-label={copied ? "Copied" : "Copy picture"}
            className="rounded p-1 hover:bg-fg/5 disabled:opacity-40"
          >
            {copied ? <Check size={15} weight="bold" /> : <Copy size={15} />}
          </button>
          <button
            type="button"
            disabled={!src}
            onClick={onDownload}
            title="Download"
            aria-label="Download"
            className="rounded p-1 hover:bg-fg/5 disabled:opacity-40"
          >
            <DownloadSimple size={15} />
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Image canvas with fit/zoom, trackpad pinch zoom, and drag pan. */
function ImageCanvas({
  src,
  error,
  title,
  fit,
  scale,
  offset,
  transform,
  checkerboard,
  onError,
  panHandlers,
}: {
  src: string | null;
  error: string | null;
  title: string;
  fit: boolean;
  scale: number;
  offset: { x: number; y: number };
  transform: string | undefined;
  checkerboard: boolean;
  onError: () => void;
  panHandlers: ReturnType<typeof usePanZoom>["panHandlers"];
}) {
  return (
    <div
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      style={{
        cursor: fit ? "default" : "grab",
        background: checkerboard
          ? "conic-gradient(#8882 25%, transparent 0 50%, #8882 0 75%, transparent 0) 0 0 / 18px 18px"
          : undefined,
      }}
      {...panHandlers}
    >
      {error ? (
        <div className="text-sm" style={{ color: COLORS.danger }}>
          Failed to load image: {error}
        </div>
      ) : src ? (
        <img
          src={src}
          alt={title}
          draggable={false}
          onError={onError}
          style={{
            transform,
            maxWidth: fit ? "100%" : "none",
            maxHeight: fit ? "100%" : "none",
            objectFit: "contain",
            transformOrigin: "center center",
            userSelect: "none",
          }}
        />
      ) : (
        <div className="text-sm" style={{ color: COLORS.textDim }}>
          Loading image…
        </div>
      )}
      <span className="sr-only">
        Image zoom {Math.round(scale * 100)} percent at {offset.x},{offset.y}
      </span>
    </div>
  );
}

/** Image viewer with fit/zoom/pan and trackpad pinch (ctrl+wheel) + drag-pan. */
export function ImageViewer(props: ViewerProps) {
  const { files, workspaceId, rootPath, content, tab } = props;
  const extension = extensionOf(tab.path);
  const isSvg = extension === "svg";
  const isConverted = CONVERTED_IMAGE_EXTS.has(extension);
  const [mode, setModeState] = useState<Mode>(() =>
    readViewerMode<Mode>(tab.id, "image"),
  );
  const view = usePanZoom();
  const [src, setSrc] = useState<string | null>(null);
  const [svgText, setSvgText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converted, setConverted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkerboard, setCheckerboard] = useState(() =>
    ALPHA_IMAGE_EXTS.test(tab.path),
  );
  const mimeType = content.mimeType ?? "application/octet-stream";

  const setMode = (next: Mode) => {
    rememberViewerMode(tab.id, next);
    setModeState(next);
  };

  // Keep the transparency grid enabled only for formats that can contain alpha.
  useEffect(() => {
    setCheckerboard(ALPHA_IMAGE_EXTS.test(tab.path));
  }, [tab.path]);

  // Build an image URL from inline bytes or the pinned file stream.
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setSrc(null);
    setSvgText(null);
    setError(null);
    setConverted(false);

    const ctx: ImageLoadContext = {
      files,
      workspaceId,
      path: tab.path,
      title: tab.title,
      mimeType,
      size: content.size,
      inline:
        content.content && !content.contentOmitted
          ? { content: content.content, encoding: content.encoding }
          : null,
      isCancelled: () => cancelled,
    };
    const load = isSvg ? loadSvg : isConverted ? loadConverted : loadRaster;
    load(ctx).then(
      (loaded) => {
        if (!loaded) return;
        if (cancelled) {
          if (loaded.objectUrl) URL.revokeObjectURL(loaded.src);
          return;
        }
        if (loaded.objectUrl) objectUrl = loaded.src;
        setSrc(loaded.src);
        setSvgText(loaded.svgText ?? null);
        setConverted(loaded.converted === true);
      },
      (err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      },
    );

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    files,
    workspaceId,
    tab.path,
    tab.title,
    content.content,
    content.encoding,
    content.contentOmitted,
    content.size,
    mimeType,
    isSvg,
    isConverted,
  ]);

  const fileName = tab.path.split(/[\\/]/).pop() || tab.title;
  const copy = async () => {
    if (!src) return;
    try {
      await copyPictureToClipboard(src);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      showToast({
        title: "Could not copy the picture",
        message: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    }
  };

  const svgContent: FileContent | null =
    svgText == null
      ? null
      : {
          ...content,
          content: svgText,
          encoding: "utf-8",
          isBinary: false,
          contentOmitted: false,
        };

  if (error && (isConverted || isSvg)) {
    return (
      <DocumentSurface
        rootPath={rootPath}
        relativePath={tab.path}
        title={`${tab.title} can't be previewed`}
        mimeType={mimeType}
        size={content.size}
        notice={`${error} Open externally to view this image.`}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ImageToolbar
        isSvg={isSvg}
        mode={mode}
        setMode={setMode}
        scale={view.scale}
        fit={view.fit}
        onZoomIn={view.zoomIn}
        onZoomOut={view.zoomOut}
        onFit={view.reset}
        checkerboard={checkerboard}
        onToggleCheckerboard={() => setCheckerboard((value) => !value)}
        size={content.size}
        converted={converted}
        src={src}
        copied={copied}
        onCopy={() => void copy()}
        onDownload={() => {
          if (src) saveMediaAs(src, fileName);
        }}
      />
      {mode === "source" && isSvg && svgContent ? (
        <CodeViewer {...props} content={svgContent} readOnly />
      ) : (
        <ImageCanvas
          src={src}
          error={error}
          title={tab.title}
          fit={view.fit}
          scale={view.scale}
          offset={view.offset}
          transform={view.transform}
          checkerboard={checkerboard}
          onError={() =>
            setError("This image format could not be decoded by the viewer.")
          }
          panHandlers={view.panHandlers}
        />
      )}
    </div>
  );
}
