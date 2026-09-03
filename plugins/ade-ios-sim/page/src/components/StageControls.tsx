/**
 * The two overlays that sit ON the stage: the mode toolbar and the zoom rail.
 *
 * Both are `ChatIosSimulatorPanel.tsx`'s own markup. They keep
 * `pointer-events-auto` and their `onPointerDown` stop-propagation, because the
 * stage under them is the control surface: without it, pressing Zoom in would
 * also tap the running app at the button's coordinates.
 */

import React from "react";
import {
  ArrowsInSimple,
  ArrowsOutSimple,
  CursorClick,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Selection,
} from "@phosphor-icons/react";
import { cn } from "@ade-dev/ui";

import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "../host/uiState";
import type { SimulatorMode } from "../types";

/** Control / Inspect, anchored top-left of the stage. */
export function ModeToolbar({
  mode,
  onMode,
}: {
  mode: SimulatorMode;
  onMode: (next: "interact" | "inspect") => void;
}): React.ReactElement {
  return (
    <div
      className="pointer-events-auto absolute left-3 top-3 z-10 flex rounded-md border border-white/[0.08] bg-black/60 p-0.5 shadow-lg backdrop-blur"
      data-sim-pane="mode-toolbar"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded px-2 font-sans text-[10px] font-medium transition-colors",
          mode === "interact"
            ? "bg-emerald-500/22 text-emerald-100/95"
            : "text-muted-fg/55 hover:text-fg/85",
        )}
        aria-pressed={mode === "interact"}
        onClick={(event) => {
          event.stopPropagation();
          onMode("interact");
        }}
      >
        <CursorClick size={11} />
        Control
      </button>
      <button
        type="button"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded px-2 font-sans text-[10px] font-medium transition-colors",
          mode === "inspect"
            ? "bg-cyan-500/22 text-cyan-100/95"
            : "text-muted-fg/55 hover:text-fg/85",
        )}
        aria-pressed={mode === "inspect"}
        onClick={(event) => {
          event.stopPropagation();
          onMode("inspect");
        }}
      >
        <Selection size={11} />
        Inspect
      </button>
    </div>
  );
}

/**
 * Expand, zoom out, the percentage (which resets), zoom in.
 *
 * The percentage is the reset control rather than a separate button, exactly as
 * the compiled toolbar had it — a rail of four is already the most a 300px-wide
 * pane can carry.
 */
export function ZoomControl({
  zoom,
  expanded,
  onZoom,
  onResetZoom,
  onToggleExpanded,
  surfaceLabel,
}: {
  zoom: number;
  expanded: boolean;
  onZoom: (delta: number) => void;
  onResetZoom: () => void;
  onToggleExpanded: () => void;
  surfaceLabel: string;
}): React.ReactElement {
  const label = `${Math.round(zoom * 100)}%`;
  return (
    <div
      className="pointer-events-auto absolute bottom-3 right-3 z-20 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-end gap-1 rounded-md border border-white/[0.08] bg-black/62 p-1 shadow-lg backdrop-blur"
      data-sim-pane="zoom"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-fg/68 transition-colors hover:bg-white/[0.06] hover:text-fg/90"
        onClick={(event) => {
          event.stopPropagation();
          onToggleExpanded();
        }}
        aria-label={expanded ? `Exit expanded ${surfaceLabel} view` : `Expand ${surfaceLabel} view`}
        title={expanded ? `Exit expanded ${surfaceLabel} view` : `Expand ${surfaceLabel} view`}
      >
        {expanded ? <ArrowsInSimple size={13} /> : <ArrowsOutSimple size={13} />}
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-fg/68 transition-colors hover:bg-white/[0.06] hover:text-fg/90 disabled:cursor-not-allowed disabled:opacity-35"
        onClick={(event) => {
          event.stopPropagation();
          onZoom(-ZOOM_STEP);
        }}
        disabled={zoom <= ZOOM_MIN}
        aria-label={`Zoom out ${surfaceLabel} view`}
        title={`Zoom out ${surfaceLabel} view`}
      >
        <MagnifyingGlassMinus size={13} />
      </button>
      <button
        type="button"
        className="inline-flex h-7 min-w-10 items-center justify-center rounded px-1 font-sans text-[10px] font-medium tabular-nums text-muted-fg/72 transition-colors hover:bg-white/[0.06] hover:text-fg/90"
        onClick={(event) => {
          event.stopPropagation();
          onResetZoom();
        }}
        aria-label={`Reset ${surfaceLabel} zoom`}
        title={`Reset ${surfaceLabel} zoom`}
      >
        {label}
      </button>
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-fg/68 transition-colors hover:bg-white/[0.06] hover:text-fg/90 disabled:cursor-not-allowed disabled:opacity-35"
        onClick={(event) => {
          event.stopPropagation();
          onZoom(ZOOM_STEP);
        }}
        disabled={zoom >= ZOOM_MAX}
        aria-label={`Zoom in ${surfaceLabel} view`}
        title={`Zoom in ${surfaceLabel} view`}
      >
        <MagnifyingGlassPlus size={13} />
      </button>
    </div>
  );
}
