import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsOut,
  Check,
  Code,
  Copy,
  DownloadSimple,
  Eye,
  GridFour,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from "@phosphor-icons/react";
import { showToast } from "../../../app/toast/toastStore";
import { copyPictureToClipboard, saveMediaAs } from "../../../ui/MediaLightbox";
import { COLORS, fgTint } from "../../../lanes/laneDesignTokens";
import { streamFileBytes } from "../streamBytes";
import type { FileContent } from "../../../../../shared/types";
import type { ViewerProps } from "./types";
import { CodeViewer } from "./CodeViewer";
import { DocumentSurface } from "./DocumentSurface";
import { ViewerModeToggleButton } from "./ViewerModeToggle";
import { readViewerMode, rememberViewerMode } from "./viewerModeMemory";
import { cssZoomOf } from "../../../../lib/webZoom";

const MIN_SCALE = 0.1;
const MAX_SCALE = 12;
const MAX_IMAGE_STREAM_BYTES = 25 * 1024 * 1024;
const ALPHA_IMAGE_EXTS = /\.(?:svg|png|webp|gif)$/i;
type Mode = "image" | "source";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + 0x8000, bytes.length),
    );
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function decodeBase64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Toolbar for image controls shared by raster and SVG previews. */
function ImageToolbar({
  isSvg,
  mode,
  setMode,
  scale,
  onZoom,
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
  onZoom: (factor: number) => void;
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
          <button
            type="button"
            onClick={() => onZoom(1 / 1.2)}
            title="Zoom out"
            className="rounded p-1 hover:bg-fg/5"
          >
            <MagnifyingGlassMinus size={15} />
          </button>
          <span
            className="w-12 text-center text-xs tabular-nums"
            style={{ color: COLORS.textMuted }}
          >
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => onZoom(1.2)}
            title="Zoom in"
            className="rounded p-1 hover:bg-fg/5"
          >
            <MagnifyingGlassPlus size={15} />
          </button>
          <button
            type="button"
            onClick={onFit}
            title="Fit to window"
            className="rounded p-1 hover:bg-fg/5"
          >
            <ArrowsOut size={15} />
          </button>
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
  onWheel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
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
  onWheel: (event: React.WheelEvent) => void;
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: () => void;
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
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
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
  const isSvg = /\.svg$/i.test(tab.path);
  const isConverted = /\.(?:tif|tiff|heic|heif)$/i.test(tab.path);
  const [mode, setModeState] = useState<Mode>(() =>
    readViewerMode<Mode>(tab.id, "image"),
  );
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [fit, setFit] = useState(true);
  const [src, setSrc] = useState<string | null>(null);
  const [svgText, setSvgText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converted, setConverted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkerboard, setCheckerboard] = useState(() =>
    ALPHA_IMAGE_EXTS.test(tab.path),
  );
  const dragRef = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
  } | null>(null);
  const mimeType = content.mimeType ?? "application/octet-stream";

  const setMode = (next: Mode) => {
    rememberViewerMode(tab.id, next);
    setModeState(next);
  };

  // Keep the transparency grid enabled only for formats that can contain alpha.
  useEffect(() => {
    setCheckerboard(ALPHA_IMAGE_EXTS.test(tab.path));
  }, [tab.path]);

  // Build an image URL from inline bytes or the pinned file stream. SVG is decoded
  // independently for Source mode, while its original bytes remain in an <img>.
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    setSrc(null);
    setSvgText(null);
    setError(null);
    setConverted(false);

    const load = async () => {
      try {
        if (isSvg) {
          let bytes: Uint8Array<ArrayBuffer>;
          if (
            content.content &&
            content.encoding === "base64" &&
            !content.contentOmitted
          ) {
            bytes = decodeBase64Bytes(content.content);
          } else if (
            content.content &&
            content.encoding !== "base64" &&
            !content.contentOmitted
          ) {
            bytes = new TextEncoder().encode(content.content);
          } else {
            bytes = await streamFileBytes(files, workspaceId, tab.path, {
              isCancelled: () => cancelled,
              maxBytes: MAX_IMAGE_STREAM_BYTES,
            });
          }
          if (cancelled) return;
          const text =
            content.encoding === "base64" &&
            content.content &&
            !content.contentOmitted
              ? decodeBase64Utf8(content.content)
              : new TextDecoder("utf-8").decode(bytes);
          revoked = URL.createObjectURL(
            new Blob([bytes], { type: "image/svg+xml" }),
          );
          setSvgText(text);
          setSrc(revoked);
          return;
        }

        if (isConverted) {
          if (content.size > MAX_IMAGE_STREAM_BYTES) {
            throw new Error(
              `Image is larger than the ${formatBytes(MAX_IMAGE_STREAM_BYTES)} preview limit.`,
            );
          }
          const bytes = await streamFileBytes(files, workspaceId, tab.path, {
            isCancelled: () => cancelled,
            maxBytes: MAX_IMAGE_STREAM_BYTES,
          });
          if (cancelled) return;
          const convert = window.ade.app.convertImageToJpeg;
          if (!convert)
            throw new Error("Image conversion is unavailable on this system.");
          const result = await convert({
            data: bytesToBase64(bytes),
            filename: tab.path.split(/[\\/]/).pop() ?? tab.title,
            mimeType,
          });
          if (!result.ok) {
            const format = /\.(?:tif|tiff)$/i.test(tab.path) ? "TIFF" : "HEIC";
            const reason =
              result.errorCode === "unavailable"
                ? `This system can't decode ${format} images in ADE.`
                : "ADE could not convert this image for preview.";
            throw new Error(reason);
          }
          if (cancelled) return;
          const jpegBytes = decodeBase64Bytes(result.data);
          revoked = URL.createObjectURL(
            new Blob([jpegBytes], { type: result.mimeType || "image/jpeg" }),
          );
          setSrc(revoked);
          setConverted(true);
          return;
        }

        // Build the image source from inline base64 when available; otherwise
        // stream bounded bytes and use a temporary blob URL for the preview.
        if (
          content.content &&
          content.encoding === "base64" &&
          !content.contentOmitted
        ) {
          setSrc(`data:${mimeType};base64,${content.content}`);
          return;
        }
        const maxBytes = 100 * 1024 * 1024;
        if (content.size > maxBytes) {
          throw new Error(
            `Image is too large for inline preview (${formatBytes(content.size)}).`,
          );
        }
        const bytes = await streamFileBytes(files, workspaceId, tab.path, {
          isCancelled: () => cancelled,
          maxBytes,
        });
        if (cancelled) return;
        revoked = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        setSrc(revoked);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
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

  const setZoom = (factor: number) => {
    setFit(false);
    setScale((previous) =>
      Math.min(MAX_SCALE, Math.max(MIN_SCALE, previous * factor)),
    );
  };

  const onWheel = (event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom(event.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (fit) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      ox: offset.x,
      oy: offset.y,
    };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const zoom = cssZoomOf();
    setOffset({
      x: drag.ox + (event.clientX - drag.x) / zoom,
      y: drag.oy + (event.clientY - drag.y) / zoom,
    });
  };

  const resetFit = () => {
    setFit(true);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

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

  const transform = useMemo(
    () =>
      fit
        ? undefined
        : `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
    [fit, offset.x, offset.y, scale],
  );
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
        scale={scale}
        onZoom={setZoom}
        onFit={resetFit}
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
          fit={fit}
          scale={scale}
          offset={offset}
          transform={transform}
          checkerboard={checkerboard}
          onError={() =>
            setError("This image format could not be decoded by the viewer.")
          }
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => {
            dragRef.current = null;
          }}
        />
      )}
    </div>
  );
}
