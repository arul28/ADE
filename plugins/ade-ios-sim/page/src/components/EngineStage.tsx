/**
 * The reserved rect: the one element in this page that draws nothing.
 *
 * Everything around it is the page's; the pixels inside it are the host's. The
 * div is deliberately transparent and empty — a background here would be
 * painted OVER by the engine on a host that has one and would be the only thing
 * visible on a host that does not, so the "no engine" line is drawn as a real
 * child instead, and only when there is genuinely no painter.
 *
 * The measurement discipline is the whole reason this is its own component:
 *
 * - one `ResizeObserver` on the element, plus a window `resize` and `scroll`
 *   listener, because a rect can move without changing size (a chip above it
 *   wraps, the pane scrolls) and `ResizeObserver` says nothing about that;
 * - every measurement goes through `createEnginePlacer`, which drops a rect
 *   equal to the one already placed, so a layout tick does not become a host
 *   call;
 * - `release()` on unmount AND whenever the element loses its box, so a hidden
 *   placement never leaves the engine painting over chrome that has moved.
 */

import React, { useEffect, useRef, useState } from "react";
import { cn } from "@ade-dev/ui";

import type { HostEngineRect } from "../bridge";
import {
  NO_ENGINE_MESSAGE,
  createEnginePlacer,
  hasHostEngine,
  measureRect,
  type EnginePlacer,
} from "../host/engine";

export function EngineStage({
  active,
  className,
  style,
  remeasureKey,
  onRectChange,
  children,
}: {
  /**
   * Whether the host should be painting right now.
   *
   * False in Preview mode, behind the unsupported card, and while another chat
   * owns the session — every case where the page is drawing something else in
   * the same box. A `false` releases rather than merely stopping the measuring,
   * because a host that was never told to stop keeps painting.
   */
  active: boolean;
  className?: string;
  /**
   * The element's own size, which is how zoom reaches the host.
   *
   * A zoomed pane makes the RESERVED RECT bigger inside a scrolling frame
   * rather than scaling a picture the page holds, because the page holds no
   * picture: the host paints at whatever rect it was last given, so a bigger
   * rect is a bigger screen.
   */
  style?: React.CSSProperties;
  /**
   * Bump to force a re-measure.
   *
   * `ResizeObserver` covers a box that changes on its own; it does not cover a
   * change the page MADE — a zoom step, an expand — in the same commit that
   * changed the style. Naming that change here is honest and, unlike a poll,
   * costs nothing when nothing moved.
   */
  remeasureKey?: string | number;
  /** The rect actually handed to the host, for a header line and for the test. */
  onRectChange?: (rect: HostEngineRect | null) => void;
  /** Overlays drawn ON TOP of the engine — the mode toolbar, the zoom control. */
  children?: React.ReactNode;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const placerRef = useRef<EnginePlacer | null>(null);
  const [engineAvailable, setEngineAvailable] = useState<boolean>(() => hasHostEngine());

  if (!placerRef.current) placerRef.current = createEnginePlacer();

  useEffect(() => {
    setEngineAvailable(hasHostEngine());
  }, []);

  useEffect(() => {
    const placer = placerRef.current;
    if (!placer) return;
    if (!active) {
      void placer.release();
      onRectChange?.(null);
      return;
    }

    const element = hostRef.current;
    if (!element) return;

    const report = (): void => {
      const rect = measureRect(element);
      if (!rect) {
        // No box: the placement is hidden, or a parent collapsed. Same call as
        // an unmount, because the host cannot tell the two apart and must not
        // keep painting for either.
        void placer.release();
        onRectChange?.(null);
        return;
      }
      if (placer.place(rect)) onRectChange?.(rect);
    };

    report();

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => report());
    observer?.observe(element);
    window.addEventListener("resize", report);
    // Capture phase: a scroll inside any ancestor moves this rect, and a
    // non-capturing window listener never hears one.
    window.addEventListener("scroll", report, true);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", report);
      window.removeEventListener("scroll", report, true);
    };
  }, [active, remeasureKey, onRectChange]);

  // The unmount release, kept apart from the effect above so that changing
  // `active` never runs it and unmounting always does.
  useEffect(() => {
    const placer = placerRef.current;
    return () => {
      void placer?.release();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      data-sim-pane="stage"
      className={cn("relative h-full min-h-[300px] w-full", className)}
      style={style}
    >
      {active && !engineAvailable ? (
        <div className="flex h-full items-center justify-center p-4 text-center font-sans text-[11px] text-muted-fg/60">
          {NO_ENGINE_MESSAGE}
        </div>
      ) : null}
      {children}
    </div>
  );
}
