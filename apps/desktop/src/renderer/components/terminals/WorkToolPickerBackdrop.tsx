import { useEffect, useRef, useState } from "react";
import type { ThemeId } from "../../state/appStore";
import { cn } from "../ui/cn";

/**
 * The tools picker's backdrop: a slow violet mesh drifting behind the cards.
 *
 * Adapted from the 21st.dev Shader Builder "Mesh drift" background. Two things
 * are ours and neither is negotiable:
 *
 * 1. The colours are ADE's. They arrive as uniforms from `backdropThemeFor`
 *    below — nothing in `FRAG` names a colour, so the same shader paints both
 *    themes and a token change is a one-line edit in this file rather than a
 *    hunt through GLSL.
 * 2. The budget. This is decoration on a page you land on constantly, sitting
 *    inside an Electron renderer that is also running a terminal, a browser
 *    view and a chat stream. It renders at DPR 1, never more than
 *    `BACKDROP_PIXEL_BUDGET` pixels, never faster than 30 fps, and not at all
 *    while the window is blurred, the document hidden, the canvas scrolled out
 *    of view, or the pointer's device cannot hover. Under
 *    `prefers-reduced-motion` it paints one frame and stops. Without WebGL — or
 *    with only a software rasteriser behind it — it is a static CSS gradient
 *    and no canvas at all.
 */

const VERT = `attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec3 u_colors[8];
uniform vec4 u_scene;      // resolution.xy, time, colour count
uniform vec4 u_shape;      // scale, intensity, warp, detail
uniform vec4 u_surface;    // contrast, brightness, saturation, grain
uniform vec4 u_transform;  // seed, rotation, drift, vignette
uniform vec4 u_space;      // offset.xy, pointer.xy
uniform vec4 u_cursor;     // presence, strength, radius, unused

#define u_resolution u_scene.xy
#define u_time u_scene.z
#define u_colorCount u_scene.w
#define u_scale u_shape.x
#define u_intensity u_shape.y
#define u_warp u_shape.z
#define u_detail u_shape.w
#define u_contrast u_surface.x
#define u_brightness u_surface.y
#define u_saturation u_surface.z
#define u_grain u_surface.w
#ifdef GL_FRAGMENT_PRECISION_HIGH
#define u_seed u_transform.x
#else
#define u_seed mod(u_transform.x, 31.0)
#endif
#define u_rotate u_transform.y
#define u_drift u_transform.z
#define u_vignette u_transform.w
#define u_offset u_space.xy
#define u_mouse u_space.zw
#define u_cursorPresence u_cursor.x
#define u_cursorStrength u_cursor.y
#define u_cursorRadius u_cursor.z

float hash21(vec2 p) {
#ifndef GL_FRAGMENT_PRECISION_HIGH
  p = mod(p, 31.0);
#endif
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.0, 9.2);
    a *= 0.5;
  }
  return v;
}

vec3 shade(vec2 p, float t) {
  vec3 acc = u_colors[0] * 0.15;
  float total = 0.15;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= u_colorCount) break;
    float fi = float(i);
    vec2 c = vec2(
      sin(t * (0.21 + fi * 0.071) + fi * 2.4 + u_seed),
      cos(t * (0.17 + fi * 0.093) + fi * 1.7)) * (0.45 + u_intensity * 0.35);
    float w = exp(-dot(p - c, p - c) * 6.0);
    acc += u_colors[i] * w;
    total += w;
  }
  return acc / total;
}

void main() {
  vec2 screenUv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
    / min(u_resolution.x, u_resolution.y);

  // One cursor effect only — the swirl. The builder's other three modes were
  // dead branches in a fragment shader, which is the one place a branch nobody
  // takes still costs something.
  if (u_cursorPresence > 0.001) {
    vec2 cursor = (0.5 * u_mouse * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
    vec2 cursorDelta = p - cursor;
    float cursorDistance = length(cursorDelta);
    float cursorMask = u_cursorPresence
      * (1.0 - smoothstep(0.0, u_cursorRadius, cursorDistance));
    float cursorAngle = cursorMask * u_cursorStrength * 2.2;
    float cc = cos(cursorAngle), cs = sin(cursorAngle);
    p = cursor + mat2(cc, -cs, cs, cc) * cursorDelta;
  }

  p *= u_scale;
  if (abs(u_rotate) > 0.0001) {
    float cr = cos(u_rotate), sr = sin(u_rotate);
    p = mat2(cr, -sr, sr, cr) * p;
  }
  p += u_offset;
  if (u_drift > 0.0001)
    p += u_drift * vec2(sin(u_time * 0.31), cos(u_time * 0.23));
  if (u_warp > 0.0) {
    p += u_warp * (vec2(
      fbm(p * u_detail + u_seed),
      fbm(p * u_detail + vec2(5.2, 1.3))) - 0.5);
  }
  vec3 col = shade(p, u_time);
  if (abs(u_contrast - 1.0) > 0.0001)
    col = (col - 0.5) * u_contrast + 0.5;
  if (abs(u_saturation - 1.0) > 0.0001) {
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, u_saturation);
  }
  if (abs(u_brightness) > 0.0001)
    col += u_brightness;
  if (u_vignette > 0.0001) {
    float vd = length(screenUv - 0.5) * 1.41421356;
    col *= 1.0 - u_vignette * smoothstep(0.35, 1.0, vd);
  }
  if (u_grain > 0.0001)
    col += (grainHash(
      gl_FragCoord.xy + vec2(u_seed * 17.0, u_seed * 31.0)) - 0.5) * u_grain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/** `#rrggbb` → the 0…1 triple the shader wants. */
function rgb(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

export type WorkToolPickerBackdropTheme = {
  /** Base first, then the ramp the mesh blends towards. Max 8. */
  colors: readonly (readonly [number, number, number])[];
  intensity: number;
  vignette: number;
  brightness: number;
  saturation: number;
};

/**
 * The two palettes, both taken straight from `index.css`.
 *
 * Dark is the app's own canvas (`--color-bg`) lifted through
 * `--color-accent-deep` → `--color-accent` → `--color-accent-bright`, kept low
 * on intensity with a slightly negative brightness: the mesh is a *surface* for
 * the cards, not a picture behind them, and every one of those cards is a
 * translucent rectangle full of 12px text. Light starts from
 * `--color-surface` and walks the same violet hues down (`#EDE9FE` is that ramp
 * one step lighter than `--color-accent-bright`), at well under half the
 * intensity — on a light canvas the same amount of colour reads as a stain.
 */
export function backdropThemeFor(theme: ThemeId): WorkToolPickerBackdropTheme {
  if (theme === "light") {
    return {
      colors: [rgb("#faf8f5"), rgb("#EDE9FE"), rgb("#C4B5FD"), rgb("#A78BFA")],
      intensity: 0.24,
      vignette: 0.18,
      brightness: 0.02,
      saturation: 0.7,
    };
  }
  return {
    colors: [rgb("#0C0B10"), rgb("#7C3AED"), rgb("#A78BFA"), rgb("#C4B5FD")],
    intensity: 0.4,
    vignette: 0.35,
    // Measured, not guessed: at the pane's default size this ramp means a mean
    // luminance of 57/255 with the brightness at -0.05, which is BRIGHTER than
    // the card fill (`--color-card`, ~26) and inverts the page — the mesh would
    // be reading as the content and the cards as holes in it. -0.16 lands the
    // mean at ~37 and the peak at ~118: still violet, still moving, and still
    // underneath.
    brightness: -0.16,
    saturation: 0.9,
  };
}

/**
 * Everything that is not a colour: the builder's own numbers, minus its dead
 * weight. The motion is slowed 4× (`timeScale`) because "premium" here means
 * you notice it only if you stare; the 5-tap blur is gone because it multiplies
 * the mesh evaluation by five per pixel to soften what the gaussian falloff has
 * already softened; the hue rotation and three of the four cursor modes are
 * gone because a branch no one takes still costs something in a fragment
 * shader.
 */
const UNIFORMS = {
  scale: 1.3,
  warp: 0.192,
  detail: 2.016,
  contrast: 1.167,
  grain: 0.06,
  seed: 5069,
  rotate: 2.7227,
  offsetX: 0.09,
  offsetY: 0.15,
  drift: 0.12,
  cursorStrength: 0.62,
  cursorRadius: 0.365,
  timeScale: -0.34,
} as const;

/** DPR 1, always. This is a soft gradient; it has nothing to resolve. */
export const BACKDROP_MAX_DPR = 1;
/**
 * The hard pixel ceiling. Roughly a 1000×600 pane at DPR 1 — past that the
 * canvas keeps its CSS size and renders fewer pixels, stretched. A mesh this
 * soft cannot show the difference, and the fragment cost is linear in pixels.
 */
export const BACKDROP_PIXEL_BUDGET = 600_000;
/** 30 fps. Drift this slow gains nothing from 60, let alone from 240. */
export const BACKDROP_FRAME_MS = 1000 / 30;

/**
 * The drawing-buffer size for a given CSS box — the whole size/budget policy,
 * pulled out of the WebGL path so it can be tested without a GPU.
 */
export function resolveBackdropSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  budget: number = BACKDROP_PIXEL_BUDGET,
): { width: number; height: number } {
  const dpr = Math.min(
    Math.max(Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1, 0.5),
    BACKDROP_MAX_DPR,
  );
  const rawWidth = Math.max(1, Math.round((Number.isFinite(cssWidth) ? cssWidth : 0) * dpr));
  const rawHeight = Math.max(1, Math.round((Number.isFinite(cssHeight) ? cssHeight : 0) * dpr));
  const scale = Math.min(1, Math.sqrt(Math.max(1, budget) / (rawWidth * rawHeight)));
  // Floor, not round: rounding both axes up can carry the product a few hundred
  // pixels back over the ceiling it was just scaled under.
  return {
    width: Math.max(1, Math.floor(rawWidth * scale)),
    height: Math.max(1, Math.floor(rawHeight * scale)),
  };
}

/**
 * Chromium answers `getContext("webgl")` even when there is no usable GPU — on
 * a locked-down Windows box, a VM, or a machine whose driver is blacklisted it
 * hands back SwiftShader and rasterises every fragment on the CPU. That is the
 * one configuration where this backdrop would be the most expensive thing in
 * the window, so a software renderer is treated exactly like no WebGL at all.
 */
export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|software|llvmpipe|basic render|microsoft basic/iu.test(renderer);
}

/**
 * Releasing a WebGL context is not free and React remounts this component for
 * every picker ↔ tool crossfade, so the release is deferred by a task and
 * cancelled if the same canvas comes straight back.
 */
const pendingContextReleases = new WeakMap<HTMLCanvasElement, number>();

function matches(query: string): boolean {
  try {
    return window.matchMedia?.(query).matches ?? false;
  } catch {
    return false;
  }
}

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
  // away a context on every mount just to learn what the next line finds out.
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

    const pendingRelease = pendingContextReleases.get(canvas);
    if (pendingRelease !== undefined) window.clearTimeout(pendingRelease);
    pendingContextReleases.delete(canvas);

    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl", {
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "low-power",
      }) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) {
      setWebglRefused(true);
      return;
    }
    const context = gl;

    const debugInfo = context.getExtension("WEBGL_debug_renderer_info") as
      | { UNMASKED_RENDERER_WEBGL: number }
      | null;
    const rendererName = debugInfo
      ? String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "")
      : "";
    if (isSoftwareRenderer(rendererName)) {
      setWebglRefused(true);
      return;
    }

    const compile = (type: number, src: string) => {
      const shader = context.createShader(type);
      if (!shader) return null;
      context.shaderSource(shader, src);
      context.compileShader(shader);
      return shader;
    };
    const program = context.createProgram();
    const vertexShader = compile(context.VERTEX_SHADER, VERT);
    const fragmentShader = compile(context.FRAGMENT_SHADER, FRAG);
    if (!program || !vertexShader || !fragmentShader) {
      setWebglRefused(true);
      return;
    }
    context.attachShader(program, vertexShader);
    context.attachShader(program, fragmentShader);
    context.linkProgram(program);
    context.deleteShader(vertexShader);
    context.deleteShader(fragmentShader);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) {
      context.deleteProgram(program);
      setWebglRefused(true);
      return;
    }
    context.useProgram(program);

    const buffer = context.createBuffer();
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    context.bufferData(
      context.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      context.STATIC_DRAW,
    );
    const positionLocation = context.getAttribLocation(program, "a_position");
    context.enableVertexAttribArray(positionLocation);
    context.vertexAttribPointer(positionLocation, 2, context.FLOAT, false, 0, 0);

    const uniform = {
      colors: context.getUniformLocation(program, "u_colors"),
      scene: context.getUniformLocation(program, "u_scene"),
      shape: context.getUniformLocation(program, "u_shape"),
      surface: context.getUniformLocation(program, "u_surface"),
      transform: context.getUniformLocation(program, "u_transform"),
      space: context.getUniformLocation(program, "u_space"),
      cursor: context.getUniformLocation(program, "u_cursor"),
    };

    const palette = backdropThemeFor(theme);
    const colorCount = Math.min(palette.colors.length, 8);
    const flat = new Float32Array(24);
    for (let i = 0; i < colorCount; i += 1) {
      const [r, g, b] = palette.colors[i]!;
      flat[i * 3] = r;
      flat[i * 3 + 1] = g;
      flat[i * 3 + 2] = b;
    }
    context.uniform3fv(uniform.colors, flat);
    context.uniform4f(uniform.shape, UNIFORMS.scale, palette.intensity, UNIFORMS.warp, UNIFORMS.detail);
    context.uniform4f(
      uniform.surface,
      UNIFORMS.contrast,
      palette.brightness,
      palette.saturation,
      UNIFORMS.grain,
    );
    context.uniform4f(
      uniform.transform,
      UNIFORMS.seed,
      UNIFORMS.rotate,
      UNIFORMS.drift,
      palette.vignette,
    );
    context.uniform4f(uniform.space, UNIFORMS.offsetX, UNIFORMS.offsetY, 0, 0);
    context.uniform4f(uniform.cursor, 0, UNIFORMS.cursorStrength, UNIFORMS.cursorRadius, 0);

    const reduceMotion = matches("(prefers-reduced-motion: reduce)");
    // A trackpad or a mouse can swirl the mesh. A touchscreen cannot hover, so
    // the "cursor" there is a tap that would yank the background sideways.
    const cursorEnabled = !reduceMotion && matches("(hover: hover)") && matches("(pointer: fine)");

    let bounds = canvas.getBoundingClientRect();
    let targetX = 0;
    let targetY = 0;
    let targetPresence = 0;
    let mouseX = 0;
    let mouseY = 0;
    let cursorPresence = 0;
    let pointerKnown = false;
    let pointerClientX = 0;
    let pointerClientY = 0;
    let raf = 0;
    let lastNow: number | null = null;
    let lastDrawn = 0;
    let visible = document.visibilityState === "visible";
    let focused = document.hasFocus();
    let inView = true;
    let disposed = false;
    const start = performance.now();

    const resizeCanvas = () => {
      const { width, height } = resolveBackdropSize(
        bounds.width,
        bounds.height,
        window.devicePixelRatio || 1,
      );
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        context.viewport(0, 0, width, height);
        return true;
      }
      return false;
    };

    const draw = (seconds: number) => {
      resizeCanvas();
      context.uniform4f(uniform.scene, canvas.width, canvas.height, seconds, colorCount);
      context.uniform4f(uniform.space, UNIFORMS.offsetX, UNIFORMS.offsetY, mouseX, mouseY);
      context.uniform4f(
        uniform.cursor,
        cursorEnabled ? cursorPresence : 0,
        UNIFORMS.cursorStrength,
        UNIFORMS.cursorRadius,
        0,
      );
      context.drawArrays(context.TRIANGLES, 0, 3);
    };

    function requestRender() {
      if (reduceMotion || disposed || !visible || !focused || !inView) return;
      if (raf === 0) raf = requestAnimationFrame(render);
    }

    function render(now: number) {
      raf = 0;
      if (disposed || !visible || !focused || !inView) return;
      // 30 fps, gated on the timestamp rather than on a timer: the frame is
      // simply skipped and re-requested, so a 240Hz panel costs eight cheap
      // no-ops instead of eight mesh evaluations.
      if (lastDrawn !== 0 && now - lastDrawn < BACKDROP_FRAME_MS - 1) {
        requestRender();
        return;
      }
      const dt = lastNow === null ? 0 : Math.min((now - lastNow) / 1000, 0.1);
      lastNow = now;
      lastDrawn = now;
      const follow = 1 - Math.exp(-12 * dt);
      mouseX += (targetX - mouseX) * follow;
      mouseY += (targetY - mouseY) * follow;
      cursorPresence += (targetPresence - cursorPresence) * follow;
      draw(((now - start) / 1000) * UNIFORMS.timeScale);
      requestRender();
    }

    const stop = () => {
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      lastNow = null;
    };

    const updatePointerTarget = () => {
      if (!pointerKnown || bounds.width === 0 || bounds.height === 0) return;
      const inside = pointerClientX >= bounds.left
        && pointerClientX <= bounds.right
        && pointerClientY >= bounds.top
        && pointerClientY <= bounds.bottom;
      if (!inside) {
        targetPresence = 0;
        requestRender();
        return;
      }
      const nextX = ((pointerClientX - bounds.left) / bounds.width) * 2 - 1;
      const nextY = -(((pointerClientY - bounds.top) / bounds.height) * 2 - 1);
      // Entering from cold: jump rather than sweep the swirl in from wherever
      // the pointer happened to leave last time.
      if (targetPresence === 0 && cursorPresence < 0.01) {
        mouseX = nextX;
        mouseY = nextY;
      }
      targetX = nextX;
      targetY = nextY;
      targetPresence = 1;
      requestRender();
    };

    const onPointerMove = (event: PointerEvent) => {
      pointerKnown = true;
      pointerClientX = event.clientX;
      pointerClientY = event.clientY;
      bounds = canvas.getBoundingClientRect();
      updatePointerTarget();
    };
    const onPointerLeave = () => {
      pointerKnown = false;
      targetPresence = 0;
      requestRender();
    };
    const updateLayout = () => {
      bounds = canvas.getBoundingClientRect();
      if (resizeCanvas() && reduceMotion) draw(0);
      updatePointerTarget();
      requestRender();
    };
    const onVisibilityChange = () => {
      visible = document.visibilityState === "visible";
      if (visible) requestRender();
      else stop();
    };
    const onWindowFocus = () => {
      focused = true;
      requestRender();
    };
    const onWindowBlur = () => {
      focused = false;
      targetPresence = 0;
      pointerKnown = false;
      stop();
    };

    window.addEventListener("resize", updateLayout);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (cursorEnabled) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointercancel", onPointerLeave);
      window.addEventListener("scroll", updateLayout, true);
      document.documentElement.addEventListener("pointerleave", onPointerLeave);
    }

    const resizeObserver = new ResizeObserver(updateLayout);
    resizeObserver.observe(canvas);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;
      if (inView) requestRender();
      else stop();
    });
    intersectionObserver.observe(canvas);

    // One frame unconditionally, before any of the gates get a say: a window
    // that is blurred or a tab that is hidden at mount would otherwise show an
    // empty canvas over the pane until it was looked at.
    draw(0);
    if (!reduceMotion) requestRender();

    return () => {
      disposed = true;
      stop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("resize", updateLayout);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      if (cursorEnabled) {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointercancel", onPointerLeave);
        window.removeEventListener("scroll", updateLayout, true);
        document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      }
      context.deleteBuffer(buffer);
      context.deleteProgram(program);
      const releaseTimer = window.setTimeout(() => {
        if (pendingContextReleases.get(canvas) !== releaseTimer) return;
        pendingContextReleases.delete(canvas);
        context.getExtension("WEBGL_lose_context")?.loseContext();
        canvas.width = 1;
        canvas.height = 1;
      }, 0);
      pendingContextReleases.set(canvas, releaseTimer);
    };
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
