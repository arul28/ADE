/**
 * Compact heat scrubber, bottom-right of the story canvas.
 *
 * Buckets are real-time proportional (so a quiet week reads as a quiet week
 * even though the canvas itself is event-ordered) and coloured by density, with
 * a green bucket where a merge landed and amber where something needed a human.
 *
 * Dragging scrolls the canvas. That path deliberately never touches React
 * state: the pointer handler writes `scrollLeft` directly and the viewport
 * window is repositioned inside a rAF from the canvas's own scroll event, so a
 * drag costs zero renders (ade-perf-lanes: "no per-frame React state").
 */

import React, { useCallback, useEffect, useRef } from "react";
import { COLORS, MONO_FONT } from "../laneDesignTokens";
import { formatClockTime, type HeatStrip } from "./laneStoryModel";

const WIDTH = 300;
const HEIGHT = 26;

function accentMix(percent: number): string {
  return `color-mix(in srgb, var(--color-accent) ${percent}%, transparent)`;
}

function bucketColor(bucket: HeatStrip["buckets"][number]): string {
  if (bucket.needsAttention) return "var(--color-warning)";
  if (bucket.hasMerge) return "var(--color-success)";
  // Density reads as accent strength, so the strip re-themes with the app
  // instead of needing a hand-written light-theme purple.
  if (bucket.count === 0) return accentMix(18);
  if (bucket.density > 0.6) return "var(--color-accent)";
  return accentMix(Math.round((0.18 + bucket.density * 0.37) * 100));
}

function shortDate(ts: string | null): string {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${formatClockTime(ts)}`;
}

export function LaneStoryScrubber({
  heat,
  scrollRef,
}: {
  heat: HeatStrip;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const windowRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const draggingRef = useRef(false);

  const syncWindow = useCallback(() => {
    frameRef.current = null;
    const scroller = scrollRef.current;
    const thumb = windowRef.current;
    if (!scroller || !thumb) return;
    const scrollable = Math.max(1, scroller.scrollWidth);
    const ratio = Math.min(1, scroller.clientWidth / scrollable);
    const left = (scroller.scrollLeft / scrollable) * WIDTH;
    thumb.style.width = `${Math.max(12, ratio * WIDTH)}px`;
    thumb.style.transform = `translateX(${left}px)`;
  }, [scrollRef]);

  const schedule = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = window.requestAnimationFrame(syncWindow);
  }, [syncWindow]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    schedule();
    scroller.addEventListener("scroll", schedule, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", schedule);
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [schedule, scrollRef, heat.buckets.length]);

  const scrollToPointer = useCallback((clientX: number) => {
    const track = trackRef.current;
    const scroller = scrollRef.current;
    if (!track || !scroller) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    scroller.scrollLeft = ratio * scroller.scrollWidth - scroller.clientWidth / 2;
    if (scroller.scrollLeft > max) scroller.scrollLeft = max;
    schedule();
  }, [schedule, scrollRef]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrollToPointer(event.clientX);
  }, [scrollToPointer]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    scrollToPointer(event.clientX);
  }, [scrollToPointer]);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  if (!heat.buckets.length) return null;
  const bucketWidth = WIDTH / heat.buckets.length;

  return (
    <div className="ade-lane-story-scrubber" data-testid="lane-story-scrubber" onClick={(event) => event.stopPropagation()}>
      <div
        ref={trackRef}
        style={{ position: "relative", width: WIDTH, height: HEIGHT, cursor: "ew-resize", touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg width={WIDTH} height={HEIGHT} aria-hidden>
          {heat.buckets.map((bucket) => {
            const height = bucket.count === 0 ? 3 : Math.max(4, Math.round(bucket.density * (HEIGHT - 6)));
            return (
              <rect
                key={bucket.index}
                x={bucket.index * bucketWidth}
                y={HEIGHT - height - 2}
                width={Math.max(1, bucketWidth - 1)}
                height={height}
                rx={1}
                fill={bucketColor(bucket)}
              />
            );
          })}
        </svg>
        <div
          ref={windowRef}
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            height: HEIGHT,
            width: 40,
            borderRadius: 3,
            border: `1px solid color-mix(in srgb, var(--color-accent) 60%, transparent)`,
            background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
            pointerEvents: "none",
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, fontFamily: MONO_FONT, fontSize: 8, color: COLORS.textDim }}>
        <span>{shortDate(heat.startTs)}</span>
        <span>{heat.durationLabel}</span>
        <span>{shortDate(heat.endTs)}</span>
      </div>
    </div>
  );
}
