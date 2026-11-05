import { useEffect, useMemo, useRef, useState } from "react";
import type { DeviceFrameFeed } from "../device/Device3DView";

/*
 * Boot on the model (plan §5): while the emulator boots, the 3D screen shows
 * a soft glow and a progress ring in place of the loading card.
 *
 * The boot reports no progress, so the ring follows the time a boot usually
 * takes: it eases toward 95 % over about a first boot's length and never
 * claims done. Drawn into a small canvas the 3D view samples like a video
 * frame. The loop runs only while the boot screen is on and the pane is
 * visible; reduced motion draws once a second and does not spin.
 */

/** A first boot of a new AVD took ~54 s, a cold boot ~24 s (plan §9). */
const BOOT_TIME_CONSTANT_MS = 22_000;
const CANVAS_LONG_SIDE = 640;

export type AndroidBootScreen = {
  canvas: HTMLCanvasElement | null;
  frames: DeviceFrameFeed;
  /** The canvas's size, as the 3D view's screen pixel size. */
  size: { width: number; height: number };
};

function reducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** 0..0.95: how far a boot that started `elapsedMs` ago probably is. */
export function androidBootProgress(elapsedMs: number): number {
  return 0.95 * (1 - Math.exp(-Math.max(0, elapsedMs) / BOOT_TIME_CONSTANT_MS));
}

function drawBootFrame(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: { elapsedMs: number; tint: string; label: string; spin: boolean },
): void {
  const cx = width / 2;
  const cy = height / 2;
  const short = Math.min(width, height);
  context.fillStyle = "#050507";
  context.fillRect(0, 0, width, height);
  // The glow: the body colour, breathing slowly.
  const breathe = options.spin ? 0.5 + 0.5 * Math.sin(options.elapsedMs / 900) : 0.6;
  const glow = context.createRadialGradient(cx, cy, short * 0.05, cx, cy, short * (0.55 + 0.08 * breathe));
  glow.addColorStop(0, `${options.tint}${Math.round(0x44 + 0x22 * breathe).toString(16).padStart(2, "0")}`);
  glow.addColorStop(1, `${options.tint}00`);
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
  // The ring: a faint track and the progress arc.
  const radius = short * 0.16;
  const line = Math.max(3, short * 0.018);
  context.lineCap = "round";
  context.lineWidth = line;
  context.strokeStyle = "rgba(255,255,255,0.12)";
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.stroke();
  const progress = androidBootProgress(options.elapsedMs);
  const start = -Math.PI / 2 + (options.spin ? (options.elapsedMs / 1400) % (Math.PI * 2) * 0.15 : 0);
  context.strokeStyle = "rgba(255,255,255,0.92)";
  context.beginPath();
  context.arc(cx, cy, radius, start, start + Math.max(0.08, progress) * Math.PI * 2);
  context.stroke();
  // The label under the ring.
  context.fillStyle = "rgba(255,255,255,0.72)";
  context.font = `500 ${Math.round(short * 0.042)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "top";
  context.fillText(options.label, cx, cy + radius + short * 0.07);
}

export function useAndroidBootScreen({
  active,
  hidden,
  screenAspect,
  tint,
  label,
}: {
  active: boolean;
  /** The pane is off screen: draw nothing. */
  hidden: boolean;
  /** Short side over long side; the canvas is portrait. */
  screenAspect: number;
  /** `#rrggbb`, the body colour. */
  tint: string;
  label: string;
}): AndroidBootScreen {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const listeners = useRef(new Set<() => void>());
  const startedAt = useRef<number | null>(null);
  const aspect = screenAspect > 0 && screenAspect <= 1 ? screenAspect : 9 / 20;
  const size = useMemo(() => ({
    width: Math.round(CANVAS_LONG_SIDE * aspect),
    height: CANVAS_LONG_SIDE,
  }), [aspect]);

  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      return undefined;
    }
    startedAt.current ??= performance.now();
    const node = document.createElement("canvas");
    node.width = size.width;
    node.height = size.height;
    setCanvas(node);
    return () => setCanvas(null);
  }, [active, size.height, size.width]);

  useEffect(() => {
    if (!canvas || hidden) return undefined;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const spin = !reducedMotion();
    let raf = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const draw = () => {
      const elapsedMs = performance.now() - (startedAt.current ?? performance.now());
      drawBootFrame(context, canvas.width, canvas.height, { elapsedMs, tint, label, spin });
      for (const listener of listeners.current) listener();
    };
    if (spin) {
      // 30 fps is plenty for a glow and a ring; every other display frame.
      let even = false;
      const loop = () => {
        even = !even;
        if (even) draw();
        raf = requestAnimationFrame(loop);
      };
      draw();
      raf = requestAnimationFrame(loop);
    } else {
      draw();
      timer = setInterval(draw, 1_000);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
    };
  }, [canvas, hidden, label, tint]);

  const frames = useMemo<DeviceFrameFeed>(() => ({
    subscribe(listener) {
      listeners.current.add(listener);
      return () => { listeners.current.delete(listener); };
    },
  }), []);

  return { canvas, frames, size };
}
