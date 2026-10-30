import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import { useWindowFocused } from "../../lib/windowFocus";
import { cn } from "./cn";
import { attachThinkingGlyph, canPaintThinkingGlyph, type ThinkingGlyphHandle } from "./thinkingGlyphPainter";

/**
 * The glyph's shape loop: a sparkle that melts into a circle and back over 4 s.
 * Each segment steps 30 times a second (`steps(n, jump-none)`, n = 30 x the
 * segment's seconds), so the loop shows 120 shapes, one every 1/30 s.
 */
const GLYPH_KEYFRAMES = [
  { at: 0, steps: 36, d: "M 12 3 C 12.9 7.4 16.6 11.1 21 12 C 16.6 12.9 12.9 16.6 12 21 C 11.1 16.6 7.4 12.9 3 12 C 7.4 11.1 11.1 7.4 12 3 Z" },
  { at: 0.3, steps: 24, d: "M 12 4.2 C 16.8 3.4 20.6 7.2 19.8 12 C 20.6 16.4 16.4 20.6 12 19.8 C 7.8 20.6 3.4 16.8 4.2 12 C 3.4 7.6 7.2 3.4 12 4.2 Z" },
  { at: 0.5, steps: 24, d: "M 12 5 C 15.87 5 19 8.13 19 12 C 19 15.87 15.87 19 12 19 C 8.13 19 5 15.87 5 12 C 5 8.13 8.13 5 12 5 Z" },
  { at: 0.7, steps: 36, d: "M 12 3.6 C 16.4 4.6 18.6 8 19.2 12 C 18.6 16.2 16.2 19.4 12 20.4 C 8 19.4 5.2 16.4 4.8 12 C 5.4 7.8 7.6 4.4 12 3.6 Z" },
  { at: 1, steps: 0, d: "M 12 3 C 12.9 7.4 16.6 11.1 21 12 C 16.6 12.9 12.9 16.6 12 21 C 11.1 16.6 7.4 12.9 3 12 C 7.4 11.1 11.1 7.4 12 3 Z" },
];
const GLYPH_LOOP_SECONDS = 4;
const GLYPH_FRAMES = GLYPH_LOOP_SECONDS * 30;

/**
 * The 120 shapes the loop shows, in order: what CSS would draw for a `d:`
 * animation over `GLYPH_KEYFRAMES` at each 1/30 s. Every step edge of every
 * segment falls on one of those instants, so sampling there misses none.
 */
function glyphFrames(): string[] {
  const numbers = GLYPH_KEYFRAMES.map((keyframe) => keyframe.d.split(" ").map((token) => Number(token)));
  const tokens = GLYPH_KEYFRAMES[0]!.d.split(" ");
  return Array.from({ length: GLYPH_FRAMES }, (_, frame) => {
    const at = frame / GLYPH_FRAMES;
    const segment = GLYPH_KEYFRAMES.findIndex((keyframe, index) => at >= keyframe.at && at < GLYPH_KEYFRAMES[index + 1]!.at);
    const from = GLYPH_KEYFRAMES[segment]!;
    const progress = (at - from.at) / (GLYPH_KEYFRAMES[segment + 1]!.at - from.at);
    // jump-none: n held values, from the segment's start to its end inclusive.
    const eased = Math.min(1, Math.floor(progress * from.steps + 1e-9) / (from.steps - 1));
    return tokens
      .map((token, index) => {
        const a = numbers[segment]![index]!;
        if (Number.isNaN(a)) return token;
        const value = a + (numbers[segment + 1]![index]! - a) * eased;
        return String(Math.round(value * 1000) / 1000);
      })
      .join(" ");
  });
}

const GLYPH_STRIP = glyphFrames();

/**
 * A working status: a sparkle that melts into a circle and back, a small star
 * that twinkles at the turn, and a sheen that sweeps the label. Adapted from
 * the 21st.dev "thinking-indicator".
 *
 * The glyph and twinkle are drawn into a canvas by a shared worker
 * (thinkingGlyphPainter.ts), so the page runs no animation for them; where
 * that is not available they are CSS loops that move only transform or
 * opacity (`CssGlyph`). The sheen is a bright copy of the label seen through a
 * soft window that slides across while the copy slides back, so the text holds
 * still, run by the compositor (index.css, `.ade-thinking-*`). The steps and
 * timing are those of the path morph and `background-position` sheen they
 * replace, and the loops stay off the stepped loop clock
 * (`data-loop-clock="off"`), whose seeks would each cost a main-thread frame.
 * With the clock and a painted morph and sheen, one running chat cost the main
 * thread about 60 ms a second.
 *
 * The label is keyed, so a new label slides in once. The glyph takes
 * `currentColor`; the label is the theme's foreground at rest with a full
 * foreground sheen. Reduced motion leaves a still glyph and label.
 *
 * While ADE is not the focused app the loops are taken off (`data-resting`):
 * nobody is watching, so a long turn in the background costs no frames. The
 * glyph rests as a still sparkle and starts again on focus.
 */
export const ThinkingIndicator = memo(function ThinkingIndicator({ label, className }: { label: string; className?: string }) {
  const focused = useWindowFocused();
  // Decided once per indicator: a renderer without OffscreenCanvas, or a worker
  // that would not start, keeps the CSS glyph.
  const [painted, setPainted] = useState(canPaintThinkingGlyph);
  return (
    <span
      className={cn("ade-thinking-indicator inline-flex min-w-0 items-center gap-[0.5em]", className)}
      data-resting={focused ? undefined : "true"}
      data-loop-clock="off"
    >
      {painted ? <PaintedGlyph resting={!focused} onUnavailable={() => setPainted(false)} /> : <CssGlyph />}
      <span key={label} className="ade-thinking-label relative min-w-0 truncate font-medium">
        {label}
        {/* The bright copy is the window's `::before` (`content: attr(data-label)`), so the label's text is in the DOM once. */}
        <span className="ade-thinking-sheen-window" data-label={label} aria-hidden />
      </span>
    </span>
  );
});

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/**
 * The glyph and twinkle drawn by the shared worker. The main thread only tells
 * it the color, the size, and whether to hold still; the steps never touch the
 * page.
 */
function PaintedGlyph({ resting, onUnavailable }: { resting: boolean; onUnavailable: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<ThinkingGlyphHandle | null>(null);
  const restingRef = useRef(resting);
  restingRef.current = resting;

  const readState = (canvas: HTMLCanvasElement) => ({
    // The indicator's own text color, as the SVG's `currentColor` was.
    color: getComputedStyle(canvas).color,
    resting: restingRef.current,
    still: typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches,
    sizePx: Math.max(1, Math.round(canvas.getBoundingClientRect().width * (window.devicePixelRatio || 1))),
  });

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const handle = attachThinkingGlyph(canvas, GLYPH_STRIP, readState(canvas));
    if (!handle) {
      onUnavailable();
      return undefined;
    }
    handleRef.current = handle;
    const refresh = () => handle.update(readState(canvas));
    // A size, zoom or display change, a theme switch (attributes on <html>), or a motion setting.
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(refresh) : null;
    resize?.observe(canvas);
    const theme = new MutationObserver(refresh);
    theme.observe(document.documentElement, { attributes: true });
    const reducedMotion = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : null;
    reducedMotion?.addEventListener("change", refresh);
    return () => {
      resize?.disconnect();
      theme.disconnect();
      reducedMotion?.removeEventListener("change", refresh);
      handle.detach();
      handleRef.current = null;
    };
    // Attached once per mount; `onUnavailable` only matters on that attach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A focus change. Not every render: the parent re-renders on each streamed
  // event, and reading the size there forced a layout per event (about 0.2 s
  // over a 32 s stream). Size, theme and motion changes have their observers.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) handleRef.current?.update(readState(canvas));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resting]);

  return (
    <span className="relative inline-block h-[1.3em] w-[1.3em] shrink-0" aria-hidden>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </span>
  );
}

/** The same glyph as CSS loops (index.css `.ade-thinking-*`), where a worker canvas is not available. */
function CssGlyph() {
  // A bare token: React ids carry punctuation that `url(#…)` does not need.
  const gradientId = `ade-thinking-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <span className="relative inline-block h-[1.3em] w-[1.3em] shrink-0" aria-hidden>
      <span className="ade-thinking-glyph absolute inset-0">
        <span className="absolute inset-0 overflow-hidden">
          {/* An HTML box moves the strip: Chrome cannot composite a transform on an `<svg>` element. */}
          <span className="ade-thinking-glyph-strip absolute inset-y-0 left-0">
            <svg viewBox={`0 0 ${24 * GLYPH_FRAMES} 24`} className="h-full w-full" fill="none">
              <defs>
                <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="5" x2="20" y1="4" y2="20">
                  <stop offset="0" stopColor="currentColor" stopOpacity="1" />
                  <stop offset="1" stopColor="currentColor" stopOpacity="0.4" />
                </linearGradient>
              </defs>
              {GLYPH_STRIP.map((d, frame) => (
                // The gradient is in each shape's own space, so every frame keeps the same light.
                <path key={frame} transform={`translate(${24 * frame} 0)`} d={d} fill={`url(#${gradientId})`} />
              ))}
            </svg>
          </span>
        </span>
      </span>
      <span className="ade-thinking-twinkle absolute inset-0">
        <svg viewBox="0 0 24 24" className="h-full w-full" fill="none">
          <path
            d="M 19 2.5 C 19.18 4.32 19.68 4.82 21.5 5 C 19.68 5.18 19.18 5.68 19 7.5 C 18.82 5.68 18.32 5.18 16.5 5 C 18.32 4.82 18.82 4.32 19 2.5 Z"
            fill="currentColor"
          />
        </svg>
      </span>
    </span>
  );
}
