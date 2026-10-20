import { ArrowsOut, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { COLORS, fgTint } from "../../../lanes/laneDesignTokens";

/**
 * Zoom-out / percent / zoom-in / fit buttons shared by the file viewers'
 * toolbars (image, Mermaid, …). Styled like the PdfViewer toolbar buttons.
 * `fitActive` highlights the fit button while the content is fitted.
 */
export function ZoomControls({
  percent,
  onZoomOut,
  onZoomIn,
  onFit,
  fitActive,
}: {
  percent: number;
  onZoomOut(): void;
  onZoomIn(): void;
  onFit(): void;
  fitActive?: boolean;
}) {
  return (
    <>
      <button type="button" onClick={onZoomOut} title="Zoom out" aria-label="Zoom out" className="rounded p-1 hover:bg-fg/5">
        <MagnifyingGlassMinus size={14} />
      </button>
      <span className="w-12 text-center text-xs tabular-nums" style={{ color: COLORS.textMuted }}>
        {Math.round(percent)}%
      </span>
      <button type="button" onClick={onZoomIn} title="Zoom in" aria-label="Zoom in" className="rounded p-1 hover:bg-fg/5">
        <MagnifyingGlassPlus size={14} />
      </button>
      <button
        type="button"
        onClick={onFit}
        title="Fit to window"
        aria-label="Fit to window"
        aria-pressed={fitActive}
        className="rounded p-1 hover:bg-fg/5"
        style={fitActive ? { color: COLORS.textPrimary, background: fgTint(7) } : undefined}
      >
        <ArrowsOut size={14} />
      </button>
    </>
  );
}
