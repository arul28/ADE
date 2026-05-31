import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowsOut, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { COLORS } from "../../../lanes/laneDesignTokens";
import { streamFileBytes } from "../streamBytes";
import type { ViewerProps } from "./types";

const MIN_SCALE = 0.1;
const MAX_SCALE = 12;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Image viewer with fit/zoom/pan and trackpad pinch (ctrl+wheel) + drag-pan. */
export function ImageViewer({ workspaceId, content, tab }: ViewerProps) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [fit, setFit] = useState(true);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const mimeType = content.mimeType ?? "application/octet-stream";

  // Build the image source: inline base64 when present, else stream the bytes
  // into a blob URL (large images the backend omitted from the inline payload).
  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    if (content.content && content.encoding === "base64" && !content.contentOmitted) {
      setSrc(`data:${mimeType};base64,${content.content}`);
      return;
    }
    (async () => {
      try {
        const bytes = await streamFileBytes(workspaceId, tab.path, { isCancelled: () => cancelled });
        if (cancelled) return;
        // bytes is a fresh full-length Uint8Array, so its buffer is exactly the
        // file bytes; pass the ArrayBuffer to sidestep the typed-array BlobPart
        // generic mismatch.
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
        const url = URL.createObjectURL(blob);
        revoked = url;
        setSrc(url);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [workspaceId, tab.path, content.content, content.encoding, content.contentOmitted, mimeType]);

  const applyZoom = (factor: number, anchor?: { x: number; y: number }) => {
    setFit(false);
    setScale((prev) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * factor));
      void anchor; // anchor-aware zoom omitted for v1; center-zoom is acceptable
      return next;
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    applyZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (fit) return;
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset({ x: drag.ox + (e.clientX - drag.x), y: drag.oy + (e.clientY - drag.y) });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const resetFit = () => {
    setFit(true);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  const transform = useMemo(
    () => (fit ? undefined : `translate(${offset.x}px, ${offset.y}px) scale(${scale})`),
    [fit, offset.x, offset.y, scale],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: COLORS.border }}>
        <button type="button" onClick={() => applyZoom(1 / 1.2)} title="Zoom out" className="rounded p-1 hover:bg-white/5">
          <MagnifyingGlassMinus size={15} />
        </button>
        <span className="w-12 text-center text-xs tabular-nums" style={{ color: COLORS.textMuted }}>
          {Math.round(scale * 100)}%
        </span>
        <button type="button" onClick={() => applyZoom(1.2)} title="Zoom in" className="rounded p-1 hover:bg-white/5">
          <MagnifyingGlassPlus size={15} />
        </button>
        <button type="button" onClick={resetFit} title="Fit to window" className="rounded p-1 hover:bg-white/5">
          <ArrowsOut size={15} />
        </button>
        <span className="ml-auto text-xs" style={{ color: COLORS.textDim }}>
          {formatBytes(content.size)}
        </span>
      </div>
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        style={{ cursor: fit ? "default" : "grab" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {error ? (
          <div className="text-sm" style={{ color: COLORS.danger }}>Failed to load image: {error}</div>
        ) : src ? (
          <img
            src={src}
            alt={tab.title}
            draggable={false}
            onError={() => setError("decode failed")}
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
          <div className="text-sm" style={{ color: COLORS.textDim }}>Loading image…</div>
        )}
      </div>
    </div>
  );
}
