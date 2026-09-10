import { useEffect, useRef, useState } from "react";
import type { ThemeId } from "../../state/appStore";
import { cn } from "../ui/cn";
import { createBackdropRenderer } from "./workToolPickerBackdropRenderer";

export {
  BACKDROP_FRAME_MS,
  BACKDROP_MAX_DPR,
  BACKDROP_PIXEL_BUDGET,
  backdropThemeFor,
  isSoftwareRenderer,
  resolveBackdropSize,
} from "./workToolPickerBackdropShader";
export type { WorkToolPickerBackdropTheme } from "./workToolPickerBackdropShader";

/**
 * The tools picker's backdrop: a slow violet mesh drifting behind the cards.
 *
 * Adapted from the 21st.dev Shader Builder "Mesh drift" background. Two things
 * are ours and neither is negotiable:
 *
 * 1. The colours are ADE's. They arrive as uniforms from `backdropThemeFor` in
 *    `workToolPickerBackdropShader.ts` — nothing in `FRAG` names a colour, so
 *    the same shader paints both themes and a token change is a one-line edit
 *    in that file rather than a hunt through GLSL.
 * 2. The budget. This is decoration on a page you land on constantly, sitting
 *    inside an Electron renderer that is also running a terminal, a browser
 *    view and a chat stream. It renders at DPR 1, never more than
 *    `BACKDROP_PIXEL_BUDGET` pixels, never faster than 30 fps, and not at all
 *    while the window is blurred, the document hidden, the canvas scrolled out
 *    of view, or the pointer's device cannot hover. Under
 *    `prefers-reduced-motion` it paints one frame and stops. Without WebGL — or
 *    with only a software rasteriser behind it — it is a static CSS gradient
 *    and no canvas at all.
 *
 * This file is only the React shell: the shader, palettes and size policy live
 * in `workToolPickerBackdropShader.ts`, and the GL context, the rAF loop and
 * every listener that gates it live in `workToolPickerBackdropRenderer.ts`.
 */
export function WorkToolPickerBackdrop({
  theme,
  className,
}: {
  theme: ThemeId;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Optimistic: the canvas mounts, and only a refused context downgrades the
  // page to the static gradient. Probing first would mean creating and throwing
  // away a context on every mount just to learn what the renderer finds out.
  const [webglRefused, setWebglRefused] = useState(false);
  // Bumped when the reduced-motion preference flips, so the effect re-runs and
  // either starts the loop or paints its one frame.
  const [motionEpoch, setMotionEpoch] = useState(0);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media?.addEventListener) return;
    const onChange = () => setMotionEpoch((value) => value + 1);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (webglRefused) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createBackdropRenderer({
      canvas,
      theme,
      onRefused: () => setWebglRefused(true),
    });
    return renderer?.dispose;
  }, [theme, webglRefused, motionEpoch]);

  // No WebGL — a software-rendered mesh would be the most expensive thing in
  // the window, so the page keeps the same violet corner light as flat CSS.
  if (webglRefused) {
    return (
      <div
        aria-hidden="true"
        data-backdrop="static"
        className={cn("ade-tool-picker-static", className)}
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-backdrop="shader"
      className={className}
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
}
