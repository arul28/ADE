import * as React from "react";

import { ADE_WORDMARK_ASPECT, adeWordmarkSrc } from "./AdeWordmark";
import { captureError } from "../../../shared/sentry/capture";
import { cn } from "./cn";
import { createRenderer } from "./liquidGlass/glassRenderer";
import { loadLogo, logoUrl, type LogoData, BOX } from "./liquidGlass/logoTexture";
import { LOOKS, type GlassTuning, type Look, type Settings } from "./liquidGlass/settings";
import { OUTRO, clamp01, endOf, frameAt, hexToRgb, luminance } from "./liquidGlass/timeline";

/*
 * Liquid glass logo reveal: a mark lingers big against the rim of a clear glass tile, the glass
 * bends it into colour at the corners, then lets go and leaves the mark.
 * Self-contained: one WebGL2 pass, no dependencies. Draws only while on screen and only while
 * the reveal plays; a finished, non-looping reveal stops its animation frames.
 * Based on the 21st.dev "liquid-glass-logo-reveal" component; shader and spring timeline ported
 * from zanwei/glass-icon-reveal (MIT): https://github.com/zanwei/glass-icon-reveal
 */

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */
export interface GlassIconRevealProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /** SVG markup (`<svg …>…</svg>`) or an image URL. Only the shape is used unless `originalColors` is on */
  logo: string;
  /** Starting preset: light glass over a pale backdrop, or dark glass with an icon plate */
  look?: Look;
  /** Backdrop colour (hex). Match it to the page: the canvas paints it */
  background?: string;
  logoColor?: string;
  /** Colour of the tile behind the logo while `iconPlate` is on */
  plateColor?: string;
  iconPlate?: boolean;
  /** End on the flat icon plate (an app icon, a badge) instead of the bare logo */
  keepPlate?: boolean;
  /** Keep the logo's own colours instead of `logoColor` */
  originalColors?: boolean;
  /** Largest tile size in px; it shrinks to fit the container */
  tileSize?: number;
  /** Logo half size relative to the tile's half size */
  logoScale?: number;
  /** Logo size once the glass is gone, relative to `logoScale` */
  finalScale?: number;
  /** Shift of the logo's centre, in tile half sizes (y up) */
  logoOffset?: [number, number];
  loop?: boolean;
  /** Seconds the finished logo stays before the next loop */
  hold?: number;
  speed?: number;
  /** Freeze the reveal at this many seconds instead of playing it */
  time?: number;
  /** Fine-tune the glass and the motion */
  tuning?: Partial<GlassTuning>;
  /** Accessible name of the logo */
  label?: string;
  /** 0–1: alpha under this turns clear, so a glow baked into a transparent image is not part of the shape */
  alphaFloor?: number;
  /** Click replays the reveal */
  replayOnClick?: boolean;
  /** Seconds into the reveal to start from, so a remount carries on where the last one was */
  startTime?: number;
  /** Called once the logo is loaded and the reveal starts to play */
  onPlaying?: () => void;
  /** Called when a non-looping reveal has nothing left to play: it reached its end, or it cannot
   * play at all (reduced motion, no WebGL, a logo that failed to load) */
  onFinished?: () => void;
}

type LiveState = {
  settings: Settings;
  loop: boolean;
  speed: number;
  time?: number;
  startTime: number;
  onPlaying?: () => void;
  onFinished?: () => void;
};

export function GlassIconReveal({
  logo,
  look = "light",
  background,
  logoColor,
  plateColor,
  iconPlate,
  keepPlate,
  originalColors,
  tileSize,
  logoScale,
  finalScale,
  logoOffset,
  loop = true,
  hold,
  speed = 1,
  time,
  tuning,
  label = "Logo",
  alphaFloor = 0,
  replayOnClick = false,
  startTime = 0,
  onPlaying,
  onFinished,
  className,
  style,
  onClick,
  ...props
}: GlassIconRevealProps) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const engineRef = React.useRef<ReturnType<typeof startEngine> | null>(null);
  const [fallback, setFallback] = React.useState(false);

  // Objects and arrays go through JSON so inline literals don't restart the memo every render.
  const tuningKey = JSON.stringify(tuning ?? {});
  const offsetKey = logoOffset ? logoOffset.join(",") : "";
  const settings = React.useMemo<Settings>(() => {
    const own = { background, logoColor, plateColor, iconPlate, keepPlate, originalColors, tileSize, logoScale, finalScale, hold };
    const set: Partial<Settings> = Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined));
    if (offsetKey) set.logoOffset = offsetKey.split(",").map(Number) as [number, number];
    return { ...LOOKS[look], ...set, ...(JSON.parse(tuningKey) as Partial<GlassTuning>) };
  }, [look, background, logoColor, plateColor, iconPlate, keepPlate, originalColors, tileSize, logoScale, finalScale, hold, offsetKey, tuningKey]);

  const live = React.useRef<LiveState>({ settings, loop, speed, time, startTime, onPlaying, onFinished });
  live.current = { settings, loop, speed, time, startTime, onPlaying, onFinished };

  React.useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const engine = startEngine(wrap, live);
    if (!engine) {
      setFallback(true);
      live.current.onFinished?.();
      return;
    }
    engineRef.current = engine;
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
  }, []);

  React.useEffect(() => {
    engineRef.current?.invalidate();
  }, [settings, loop, speed, time]);

  React.useEffect(() => {
    let cancelled = false;
    const { job, release } = loadLogo(logo, alphaFloor);
    job.then(
      (data) => {
        if (cancelled) return;
        engineRef.current?.setLogo(data);
      },
      (err) => {
        captureError(err, { tags: { area: "logo_reveal", step: "load_logo" }, fingerprint: ["logo_reveal", "load_logo"] });
        if (!cancelled) live.current.onFinished?.();
      },
    );
    return () => {
      cancelled = true;
      release();
    };
  }, [logo, alphaFloor]);

  const fallbackUrl = React.useMemo(() => (fallback ? logoUrl(logo) : ""), [fallback, logo]);
  const fallbackSize = settings.tileSize * settings.logoScale * settings.finalScale * BOX;

  return (
    <div
      ref={wrapRef}
      role="img"
      aria-label={label}
      className={cn("relative isolate overflow-hidden select-none", replayOnClick && "cursor-pointer", className)}
      style={{ backgroundColor: settings.background, ...style }}
      onClick={(e) => {
        if (replayOnClick) engineRef.current?.replay();
        onClick?.(e);
      }}
      {...props}
    >
      {fallback && settings.originalColors ? (
        <img
          aria-hidden
          alt=""
          draggable={false}
          src={fallbackUrl}
          className="absolute inset-0 m-auto block object-contain"
          style={{ width: fallbackSize, height: fallbackSize, maxWidth: "40%", maxHeight: "40%" }}
        />
      ) : fallback ? (
        <span
          aria-hidden
          className="absolute inset-0 m-auto block"
          style={{
            width: fallbackSize,
            height: fallbackSize,
            maxWidth: "40%",
            maxHeight: "40%",
            backgroundColor: settings.logoColor,
            maskImage: `url("${fallbackUrl}")`,
            WebkitMaskImage: `url("${fallbackUrl}")`,
            maskSize: "contain",
            WebkitMaskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
          }}
        />
      ) : null}
    </div>
  );
}

// Owns the canvas: a fresh one per mount (a lost context can never be revived on the same element),
// drawn only while on screen and only when something changed.
function startEngine(wrap: HTMLDivElement, live: React.MutableRefObject<LiveState>) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  wrap.appendChild(canvas);

  let renderer: ReturnType<typeof createRenderer> = null;
  try {
    renderer = createRenderer(canvas);
  } catch (err) {
    // A shader that will not compile; no WebGL at all is not an error and returns null.
    captureError(err, { tags: { area: "logo_reveal", step: "create_renderer" }, fingerprint: ["logo_reveal", "create_renderer"] });
  }
  if (!renderer) {
    canvas.remove();
    return null;
  }

  // The system's setting or ADE's own (Settings › Appearance), as every other ADE animation.
  const reduceMotion =
    window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced";
  let logo: LogoData | null = null;
  // Reduced motion: the finished frame, the bare logo, with no animation.
  let time = reduceMotion ? endOf(live.current.settings) : 0;
  let playing = !reduceMotion;
  let pauseLeft = 0;
  let outro = 0;
  let dirty = true;
  let visible = false;
  let lost = false;
  let raf = 0;
  let last = 0;

  function tick(now: number) {
    raf = 0;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const { settings: P, loop, speed, time: fixed } = live.current;
    const end = endOf(P);
    if (fixed !== undefined) {
      playing = false;
      time = fixed;
      outro = clamp01((fixed - end - Math.max(0.05, P.hold)) / OUTRO);
    } else if (playing && logo) {
      if (pauseLeft > 0) {
        pauseLeft -= dt;
        const was = outro;
        outro = clamp01(1 - pauseLeft / OUTRO);
        if (pauseLeft <= 0) {
          pauseLeft = 0;
          outro = 0;
          time = 0;
        }
        if (outro !== was || time === 0) dirty = true;
      } else {
        time += dt * speed;
        if (time >= end) {
          time = end;
          if (loop) pauseLeft = Math.max(0.05, P.hold) + OUTRO;
          else {
            playing = false;
            live.current.onFinished?.();
          }
        }
        dirty = true;
      }
    }
    if (dirty && logo && renderer && !lost) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      const w = Math.max(1, Math.round(cw * dpr));
      const h = Math.max(1, Math.round(ch * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const tile = Math.min(P.tileSize, Math.min(cw, ch) / 1.75);
      renderer.render(frameAt(Math.min(time, end), P, outro), w, h, tile * dpr);
      dirty = false;
    }
    if (visible && playing && logo && !lost) raf = requestAnimationFrame(tick);
  }

  function kick() {
    if (raf || !visible || lost) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) kick();
    else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  });
  io.observe(wrap);
  const ro = new ResizeObserver(() => {
    dirty = true;
    kick();
  });
  ro.observe(wrap);

  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
  };
  const onRestored = () => {
    lost = false;
    try {
      renderer = createRenderer(canvas);
      if (renderer && logo) renderer.setLogo(logo);
    } catch (err) {
      captureError(err, { tags: { area: "logo_reveal", step: "restore_context" }, fingerprint: ["logo_reveal", "restore_context"] });
    }
    dirty = true;
    kick();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    setLogo(data: LogoData) {
      // A later logo (the theme landed after the splash mounted, so the look changed) swaps
      // in mid-reveal; only the first one sets where the reveal starts.
      const first = logo === null;
      logo = data;
      renderer?.setLogo(data);
      if (!reduceMotion && first) {
        const end = endOf(live.current.settings);
        time = Math.min(Math.max(0, live.current.startTime), end);
        playing = time < end;
        pauseLeft = 0;
        outro = 0;
        if (playing) live.current.onPlaying?.();
      }
      if (!playing && !live.current.loop) live.current.onFinished?.();
      dirty = true;
      kick();
    },
    replay() {
      time = 0;
      playing = true;
      pauseLeft = 0;
      outro = 0;
      dirty = true;
      kick();
    },
    invalidate() {
      dirty = true;
      kick();
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      renderer?.dispose();
      canvas.remove();
    },
  };
}

/* ------------------------------------------------------------------ *
 * ADE logo reveal
 * ------------------------------------------------------------------ */

// The canvas paints its own backdrop, so it must match what sits behind it exactly. Any CSS colour
// (hex, rgb, color-mix, oklch) is resolved by painting it into one pixel and reading that back.
function cssColorToHex(value: string, fallback: string): string {
  const raw = value.trim();
  if (!raw) return fallback;
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;
  ctx.fillStyle = fallback;
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// The first opaque background at or above `el`: the colour the page really shows there.
function backdropColor(el: HTMLElement, fallbackVar: string): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(color)) return color;
  }
  return getComputedStyle(el).getPropertyValue(fallbackVar);
}

/** How long the ADE logo reveal plays, in seconds. */
export const ADE_LOGO_REVEAL_SECONDS = endOf(LOOKS.dark);

/** A box on screen, in CSS pixels. */
export type ScreenBox = { left: number; top: number; width: number; height: number };

// Measured on the final frame: the letters span 0.985 of the tile. In the wordmark
// picture they fill 87.35% of its width, centred 3.16% right and 6.49% down of its middle.
const LETTERS_PER_TILE = 0.985;
const WORDMARK_LETTERS = { width: 0.8735, dx: 0.0316, dy: 0.0649 };

/**
 * Where the wordmark picture (`logo.png`, `logo-light.png`) sits when the reveal in
 * `canvasBox` holds its last frame, so an `<img>` of it there covers the drawn
 * logo exactly. `tileSize` is the reveal's own prop.
 */
export function adeLogoRevealWordmarkBox(canvasBox: ScreenBox, tileSize: number): ScreenBox {
  const tile = Math.min(tileSize, Math.min(canvasBox.width, canvasBox.height) / 1.75);
  const width = (tile * LETTERS_PER_TILE) / WORDMARK_LETTERS.width;
  const height = width / ADE_WORDMARK_ASPECT;
  const centerX = canvasBox.left + canvasBox.width / 2 - WORDMARK_LETTERS.dx * width;
  const centerY = canvasBox.top + canvasBox.height / 2 - WORDMARK_LETTERS.dy * height;
  return { left: centerX - width / 2, top: centerY - height / 2, width, height };
}

export type AdeLogoRevealProps = Omit<GlassIconRevealProps, "logo" | "background" | "look"> & {
  /** CSS colour variable the reveal sits on; the canvas paints it as its backdrop */
  backgroundVar?: string;
};

/**
 * ADE's own logo, revealed through liquid glass. Follows the theme: it reads the page colour from
 * `backgroundVar` and picks the light or dark glass to match. Plays once and stops.
 */
export function AdeLogoReveal({ backgroundVar = "--color-bg", tuning, ...props }: AdeLogoRevealProps) {
  const probeRef = React.useRef<HTMLSpanElement>(null);
  const [background, setBackground] = React.useState<string | null>(null);

  // The theme lands on <html> after the boot splash mounts, and can change while it shows, so the
  // colour is read again whenever the root's style or class changes.
  React.useLayoutEffect(() => {
    const probe = probeRef.current;
    const host = probe?.parentElement;
    if (!probe || !host) return;
    const read = () => setBackground(cssColorToHex(backdropColor(host, backgroundVar), "#0c0b10"));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    return () => observer.disconnect();
  }, [backgroundVar]);

  const look: Look = background && luminance(hexToRgb(background)) > 0.5 ? "light" : "dark";

  return (
    <>
      <span ref={probeRef} aria-hidden className="hidden" />
      {background ? (
        <GlassIconReveal
          logo={adeWordmarkSrc(look)}
          label="ADE"
          look={look}
          background={background}
          plateColor={background}
          originalColors
          loop={false}
          // The dark logo carries a soft glow; without the floor it turns into a grey slab behind the letters.
          alphaFloor={0.5}
          logoScale={0.9}
          finalScale={1.15}
          {...props}
          tuning={{ startZoom: 2.2, ...tuning }}
        />
      ) : null}
    </>
  );
}

export default AdeLogoReveal;
