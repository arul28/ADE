import type { ThemeId } from "../../state/appStore";

/**
 * The tools picker backdrop's shader source, palettes and size policy.
 *
 * Everything here is data: two GLSL programs, the two colour ramps, the
 * builder's non-colour numbers, and the pure functions that decide how big a
 * drawing buffer to ask for and whether to ask for one at all. No WebGL calls,
 * no DOM — `workToolPickerBackdropRenderer.ts` owns those.
 */

export const VERT = `attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export const FRAG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
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
 * The two palettes: the reference component's own four-stop structure, painted
 * in ADE's colours.
 *
 * The 21st.dev "Mesh drift" original ("kk") runs deep teal-navy → blue → cyan →
 * near-white at intensity 0.56, vignette 0.15, brightness 0, saturation 1. That
 * SHAPE is what makes it read as a gradient, and it is exactly what this file
 * previously got wrong: the old dark ramp stopped at `--color-accent-bright`
 * and then subtracted 0.24 of brightness back off, putting the mesh's median
 * luminance at ~16/255 against a `--color-bg` of ~11 and a `--color-card` of
 * ~25. Half the backdrop sat within nine levels of the flat page behind it and
 * the cards were the brightest thing in the pane — the gradient was, correctly,
 * invisible. (The in-file history shows brightness walked down −0.05 → −0.16 →
 * −0.24 to stop the mesh out-shouting the cards. The right instrument for that
 * is a scrim, not a darker mesh; see `.ade-tool-picker-scrim` in `index.css`.)
 *
 * Both ramps are measured against the reference's own luminance envelope by a
 * CPU port of `FRAG`. Under the shared recipe in `UNIFORMS` the reference
 * palette runs p5 13 / median 63 / p95 175 / peak 215; the dark ramp below runs
 * 11 / 64 / 168 / 212. Same picture, ADE's hues.
 *
 * Two details carry more weight than they look like they do:
 *
 * 1. The deep stop is TINTED, not the page's own black. The reference's base is
 *    `#031C26` — a deep teal-navy, not `#000`. `#17122E` is the same move in
 *    violet. A ramp that bottoms out on `--color-bg` has no bottom: it just
 *    dissolves into the pane.
 * 2. The top stop is NEAR-WHITE (`#F3F0FF`, against the reference's `#EAF9FF`).
 *    Dropping it for `--color-accent-bright` costs ~45 points of peak luminance
 *    and the ramp collapses back into the near-black it came from.
 *
 * Light is ADE's GREEN, not a violet. `--color-accent` under
 * `[data-theme="light"]` is `#049068`; the violets this ramp used to hardcode
 * were the DARK theme's `--color-accent-*` leaking through, because the light
 * block never redefines `--color-accent-bright` or `--color-accent-deep`. It
 * runs the same four-stop structure inverted onto a light canvas: p5 147,
 * median 222, and the white cards still stand clear of the deepest lobe.
 */
export function backdropThemeFor(theme: ThemeId): WorkToolPickerBackdropTheme {
  if (theme === "light") {
    return {
      // `--color-surface` → three tints of `--color-accent`, climbing but never
      // reaching the accent itself. Light is the one place the reference's
      // luminance envelope is NOT matched literally: the original is a dark
      // component, and running its p5 of ~13 inverted onto a light canvas put
      // the deepest lobe at a mid-green that read as a stain over the pane
      // rather than as light in it. This ramp keeps the recipe's numbers and
      // its four-stop shape, and lands at p5 ~172 / median ~236 — an 81-level
      // spread against the old flat ramp's 59, with white cards still clear of
      // the deepest lobe.
      colors: [rgb("#faf8f5"), rgb("#D6F3E7"), rgb("#8FDCC0"), rgb("#2FB48A")],
      intensity: 0.56,
      vignette: 0.15,
      brightness: 0,
      saturation: 1,
    };
  }
  return {
    // Deep violet surface tone → `--color-accent-deep` → `--color-accent` →
    // near-white violet.
    colors: [rgb("#17122E"), rgb("#7C3AED"), rgb("#A78BFA"), rgb("#F3F0FF")],
    intensity: 0.56,
    vignette: 0.15,
    brightness: 0,
    saturation: 1,
  };
}

/**
 * Everything that is not a colour: the reference component's recipe, verbatim
 * except where its renderer's budget conflicts with ours.
 *
 * Adopted as-is: `scale` 1.3, `warp` 0.192, `detail` 2.016, `contrast` 1.167,
 * `grain` 0.098, `seed` 5069, `rotate` 2.7227, `offsetX` 0.09, `offsetY` 0.15,
 * `drift` 0.148, `timeScale` -1.373, and the pointer effect at strength 0.73 /
 * radius 0.365. The reference's `paramA` is a Shader Builder slot this shader
 * never reads, so it has nothing to be set to.
 *
 * Two things from the reference are deliberately NOT adopted:
 *
 * - Its `blur` (0.0072). That is a 5-tap blur, which multiplies the mesh
 *   evaluation by five FOR EVERY PIXEL to soften what the gaussian falloff has
 *   already softened. This is decoration on a page you land on constantly,
 *   inside a renderer that is also running a terminal, a browser view and a
 *   chat stream; a 5× fragment cost is not what that budget is for.
 * - Its renderer's DPR 2 and 2,000,000-pixel budget. Ours stays at DPR 1 and
 *   `BACKDROP_PIXEL_BUDGET`, and at 30 fps. A gradient this soft has nothing to
 *   resolve, and the frame cost is linear in pixels.
 *
 * The pointer effect is the reference's mode 2 — the rotate/swirl under the
 * cursor — and it is the only one of its four kept: the other three were dead
 * branches, and a branch nobody takes still costs something in a fragment
 * shader. It stays cheap because it rides the existing 30 fps loop with the
 * reference's own `exp(-12 dt)` follow, so it only redraws while the pointer is
 * still settling, and it is switched off entirely on a device that cannot hover.
 */
export const UNIFORMS = {
  scale: 1.3,
  warp: 0.192,
  detail: 2.016,
  contrast: 1.167,
  grain: 0.098,
  seed: 5069,
  rotate: 2.7227,
  offsetX: 0.09,
  offsetY: 0.15,
  drift: 0.148,
  cursorStrength: 0.73,
  cursorRadius: 0.365,
  timeScale: -1.373,
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
