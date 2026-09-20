import React, { useCallback, useEffect, useRef, useState } from "react";
import { COLORS, SANS_FONT, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";

/**
 * Crop an uploaded image into the round mark a preset shows.
 *
 * Every surface that lists a preset draws its logo in a circle, so the crop has
 * to be round too — scaling a rectangular photo into that circle is how you get
 * a logo that is recognisable in the wizard and a sliver of forehead in the
 * model picker. Drag moves the image, the slider scales it, and the output is
 * always a 256×256 PNG: one fixed size, small enough to live in a preference
 * blob and sharp enough on a retina row.
 *
 * The canvas is the only place this component does real work. When a renderer
 * cannot give us a 2D context (an old surface, a hardened test environment) the
 * control says so instead of silently producing a blank mark.
 */

const PREVIEW_SIZE = 224;
export const HARNESS_LOGO_OUTPUT_SIZE = 256;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

export function HarnessLogoCropper({
  imageSrc,
  onCancel,
  onConfirm,
}: {
  /** Object URL or data URL of the file the user picked. */
  imageSrc: string;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      setOffset({ x: 0, y: 0 });
      setZoom(1);
      setReady(true);
    };
    image.onerror = () => setError("That image could not be read.");
    image.src = imageSrc;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [imageSrc]);

  /** Paint the image into a square at the current pan and zoom. */
  const paint = useCallback(
    (canvas: HTMLCanvasElement | null, size: number) => {
      const image = imageRef.current;
      if (!canvas || !image) return false;
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      canvas.width = size;
      canvas.height = size;
      ctx.clearRect(0, 0, size, size);
      // Cover: the shorter edge fills the square, so there is never a gap.
      const base = size / Math.min(image.width || size, image.height || size);
      const scale = base * zoom;
      const drawWidth = (image.width || size) * scale;
      const drawHeight = (image.height || size) * scale;
      const scaleToPreview = size / PREVIEW_SIZE;
      const x = (size - drawWidth) / 2 + offset.x * scaleToPreview;
      const y = (size - drawHeight) / 2 + offset.y * scaleToPreview;
      ctx.drawImage(image, x, y, drawWidth, drawHeight);
      return true;
    },
    [offset.x, offset.y, zoom],
  );

  useEffect(() => {
    if (!ready) return;
    if (!paint(canvasRef.current, PREVIEW_SIZE)) {
      setError("This computer cannot render the crop preview.");
    }
  }, [paint, ready]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
  }, [offset.x, offset.y]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset({
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    });
  }, []);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }, []);

  const handleConfirm = useCallback(() => {
    const output = document.createElement("canvas");
    if (!paint(output, HARNESS_LOGO_OUTPUT_SIZE)) {
      setError("This computer cannot produce the cropped image.");
      return;
    }
    const ctx = output.getContext("2d");
    if (!ctx) {
      setError("This computer cannot produce the cropped image.");
      return;
    }
    // Round mask, applied after the draw so the source is never re-scaled.
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    ctx.arc(HARNESS_LOGO_OUTPUT_SIZE / 2, HARNESS_LOGO_OUTPUT_SIZE / 2, HARNESS_LOGO_OUTPUT_SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    try {
      onConfirm(output.toDataURL("image/png"));
    } catch {
      setError("This computer cannot produce the cropped image.");
    }
  }, [onConfirm, paint]);

  return (
    <div
      data-harness-logo-cropper=""
      style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", fontFamily: SANS_FONT }}
    >
      <div style={{ position: "relative", width: PREVIEW_SIZE, height: PREVIEW_SIZE }}>
        <canvas
          ref={canvasRef}
          width={PREVIEW_SIZE}
          height={PREVIEW_SIZE}
          aria-label="Drag to position the logo"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{
            width: PREVIEW_SIZE,
            height: PREVIEW_SIZE,
            borderRadius: 12,
            background: COLORS.recessedBg,
            cursor: "grab",
            touchAction: "none",
          }}
        />
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 12,
            pointerEvents: "none",
            boxShadow: `0 0 0 9999px transparent`,
            background: `radial-gradient(circle at center, transparent ${PREVIEW_SIZE / 2 - 1}px, rgba(0,0,0,0.55) ${PREVIEW_SIZE / 2}px)`,
          }}
        />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: COLORS.textMuted }}>
        Zoom
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.05}
          value={zoom}
          aria-label="Zoom"
          onChange={(event) => setZoom(Number(event.target.value))}
          style={{ width: 160 }}
        />
      </label>

      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 11, color: COLORS.danger, textAlign: "center", maxWidth: 260 }}>
          {error}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={outlineButton()} onClick={onCancel}>Cancel</button>
        <button type="button" style={primaryButton()} onClick={handleConfirm} disabled={!ready}>Use this crop</button>
      </div>
    </div>
  );
}
