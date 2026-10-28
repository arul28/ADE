import * as React from "react";

import { adeWordmarkSrc } from "./AdeWordmark";
import { cn } from "./cn";

/*
 * Liquid glass logo reveal: a mark lingers big against the rim of a clear glass tile, the glass
 * bends it into colour at the corners, then lets go and leaves the mark.
 * Self-contained: one WebGL2 pass, no dependencies. Draws only while on screen and only while
 * the reveal plays; a finished, non-looping reveal stops its animation frames.
 * Based on the 21st.dev "liquid-glass-logo-reveal" component; shader and spring timeline ported
 * from zanwei/glass-icon-reveal (MIT): https://github.com/zanwei/glass-icon-reveal
 */

type Look = "light" | "dark";

interface GlassTuning {
  /** How far the slab stands above the logo, so how hard the rim bends it */
  opticalDepth: number;
  /** Colour split of everything the rim draws in */
  dispersion: number;
  /** Soft colour glow inside the rim */
  colorBleed: number;
  doubleBevel: number;
  bevelWidth: number;
  /** Superellipse exponent of the tile: 2 is a circle, ~5 an app icon */
  corner: number;
  cornerPull: number;
  cornerWidth: number;
  cornerFocus: number;
  edgeSmear: number;
  stretch: number;
  tilt: number;
  /** Ball-lens bulge of the young droplet */
  bulge: number;
  specular: number;
  halo: number;
  shadow: number;
  ripple: number;
  /** Droplet spring: 0 = no overshoot */
  bounce: number;
  /** Droplet spring period, seconds */
  response: number;
  startSize: number;
  startZoom: number;
  /** Seconds the logo takes to glide out of the droplet's magnification */
  glide: number;
  /** Seconds the logo stays in glass */
  present: number;
  drift: number;
  swell: number;
  focus: number;
  /** Soft band of light that crosses the glass while it holds the logo (0 = none) */
  sheen: number;
  /** How far the light turns round the rim while the glass holds, radians */
  lightTurn: number;
}

interface Settings extends GlassTuning {
  tileSize: number;
  logoScale: number;
  finalScale: number;
  logoOffset: [number, number];
  iconPlate: boolean;
  keepPlate: boolean;
  originalColors: boolean;
  background: string;
  plateColor: string;
  logoColor: string;
  hold: number;
}

const LIGHT: Settings = {
  tileSize: 256, logoScale: 0.7, finalScale: 0.69, logoOffset: [0, 0], iconPlate: false, keepPlate: false, originalColors: false,
  opticalDepth: 1.1, dispersion: 1.7, colorBleed: 1.25, doubleBevel: 1, bevelWidth: 0.14, corner: 4.8,
  cornerPull: 2.1, cornerWidth: 2.2, cornerFocus: 0.58, edgeSmear: 2.85, stretch: 0, tilt: 0.35, bulge: 1,
  specular: 1, halo: 0, shadow: 1, ripple: 1,
  bounce: 0, response: 0.42, startSize: 0.2, startZoom: 2.6, glide: 2.3, present: 2.4, drift: 0.12, swell: 0.5, focus: 1,
  sheen: 1, lightTurn: 0.9,
  hold: 1, background: "#e9e9eb", plateColor: "#ffffff", logoColor: "#0e1428",
};

const LOOKS: Record<Look, Settings> = {
  light: LIGHT,
  dark: {
    ...LIGHT, logoScale: 0.72, finalScale: 1, iconPlate: true,
    halo: 1, shadow: 0, ripple: 0.5, startZoom: 1.6, drift: 0.05,
    opticalDepth: 0.75, bevelWidth: 0.22, dispersion: 0.9,
    colorBleed: 0.45, corner: 5, cornerPull: 1.4, edgeSmear: 1.2, tilt: 0, cornerWidth: 1.2, cornerFocus: 0.4,
    background: "#000000", plateColor: "#05070b", logoColor: "#ffffff",
  },
};

/* ------------------------------------------------------------------ *
 * Logo → texture + signed distance field
 * ------------------------------------------------------------------ */
const TEX = 1024; // logo texture size
const BOX = 0.75; // share of the texture the logo fills (the rest is room for the SDF)

interface LogoData {
  canvas: HTMLCanvasElement;
  sdf: Float32Array;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    // Only a cross-origin image needs CORS. A same-origin one (a packaged `file://` page
    // loading `./logo.png`) must not ask for it, or Chromium refuses the load.
    if (!src.startsWith("data:")) {
      try {
        if (new URL(src, window.location.href).origin !== window.location.origin) img.crossOrigin = "anonymous";
      } catch {
        img.crossOrigin = "anonymous";
      }
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("GlassIconReveal: the logo could not be loaded"));
    img.src = src;
  });
}

function isMarkup(logo: string) {
  return logo.trimStart().startsWith("<");
}

// SVG markup → data URL rendered at texture size; currentColor turns white (only the shape matters).
function svgToUrl(text: string) {
  const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== "svg") throw new Error("GlassIconReveal: the SVG could not be read");
  let w = parseFloat(svg.getAttribute("width") || "");
  let h = parseFloat(svg.getAttribute("height") || "");
  const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) [w, h] = [vb[2], vb[3]];
  if (!(w > 0 && h > 0)) w = h = 100;
  const s = TEX / Math.max(w, h);
  svg.setAttribute("width", String(Math.round(w * s)));
  svg.setAttribute("height", String(Math.round(h * s)));
  const out = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, "#ffffff");
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(out);
}

const logoUrl = (logo: string) => (isMarkup(logo) ? svgToUrl(logo) : logo);

// Draws the source into a TEX×TEX canvas, cropped to its visible pixels and fitted into the logo box.
// Opaque images (JPG, flat PNG) get their corner colour keyed out so the mark becomes the shape.
// alphaFloor drops a soft glow baked into a transparent image: alpha under it turns clear.
function fitToTexture(source: CanvasImageSource, sw: number, sh: number, alphaFloor = 0) {
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = TEX;
  const tc = tmp.getContext("2d", { willReadFrequently: true })!;
  const s0 = Math.min(TEX / sw, TEX / sh);
  const dx0 = (TEX - sw * s0) / 2;
  const dy0 = (TEX - sh * s0) / 2;
  tc.drawImage(source, dx0, dy0, sw * s0, sh * s0);
  const d = tc.getImageData(0, 0, TEX, TEX).data;

  let opaque = true;
  for (let i = 3; i < d.length; i += 4 * 97) if (d[i] < 250) { opaque = false; break; }
  const key = [d[0], d[1], d[2]];
  const floorAlpha = (a: number) => (alphaFloor > 0 ? Math.max(0, (a - alphaFloor * 255) / (1 - alphaFloor)) : a);
  const keyAlpha = (r: number, g: number, b: number) =>
    Math.min(1, Math.max(0, (Math.hypot(r - key[0], g - key[1], b - key[2]) / 441 - 0.08) / 0.2));

  let x0 = TEX, y0 = TEX, x1 = -1, y1 = -1;
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const i = (y * TEX + x) * 4;
      const a = opaque ? keyAlpha(d[i], d[i + 1], d[i + 2]) * 255 : floorAlpha(d[i + 3]);
      if (a > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("GlassIconReveal: the logo is empty");
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const s = (TEX * BOX) / Math.max(bw, bh);

  const out = document.createElement("canvas");
  out.width = out.height = TEX;
  const oc = out.getContext("2d", { willReadFrequently: true })!;
  oc.imageSmoothingQuality = "high";
  oc.drawImage(source, TEX / 2 - (x0 + bw / 2 - dx0) * s, TEX / 2 - (y0 + bh / 2 - dy0) * s, sw * s0 * s, sh * s0 * s);
  if (opaque) {
    const im = oc.getImageData(0, 0, TEX, TEX);
    const e = im.data;
    for (let i = 0; i < e.length; i += 4) e[i + 3] = Math.round(e[i + 3] * keyAlpha(e[i], e[i + 1], e[i + 2]));
    oc.putImageData(im, 0, 0);
  } else if (alphaFloor > 0) {
    const im = oc.getImageData(0, 0, TEX, TEX);
    const e = im.data;
    for (let i = 3; i < e.length; i += 4) e[i] = Math.round(floorAlpha(e[i]));
    oc.putImageData(im, 0, 0);
  }
  return out;
}

// Signed distance field from alpha (TinySDF method): + outside, − inside, in texture units.
function buildSdf(canvas: HTMLCanvasElement) {
  const n = TEX * TEX;
  const alpha = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, TEX, TEX).data;
  const INF = 1e20;
  const outer = new Float64Array(n);
  const inner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = alpha[i * 4 + 3] / 255;
    if (a >= 1) { outer[i] = 0; inner[i] = INF; }
    else if (a <= 0) { outer[i] = INF; inner[i] = 0; }
    else {
      const dd = 0.5 - a;
      outer[i] = dd > 0 ? dd * dd : 0;
      inner[i] = dd < 0 ? dd * dd : 0;
    }
  }
  const f = new Float64Array(TEX);
  const z = new Float64Array(TEX + 1);
  const v = new Uint16Array(TEX);
  edt(outer, f, v, z, INF);
  edt(inner, f, v, z, INF);
  const sdf = new Float32Array(n);
  for (let i = 0; i < n; i++) sdf[i] = (Math.sqrt(outer[i]) - Math.sqrt(inner[i])) / TEX;
  return sdf;
}

function edt(grid: Float64Array, f: Float64Array, v: Uint16Array, z: Float64Array, INF: number) {
  for (let x = 0; x < TEX; x++) edt1d(grid, x, TEX, f, v, z, INF);
  for (let y = 0; y < TEX; y++) edt1d(grid, y * TEX, 1, f, v, z, INF);
}

function edt1d(grid: Float64Array, offset: number, stride: number, f: Float64Array, v: Uint16Array, z: Float64Array, INF: number) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < TEX; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < TEX; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}

// One SDF per logo for the whole page: building it takes ~100 ms, remounts and twins reuse it.
const logoCache = new Map<string, Promise<LogoData>>();

function loadLogo(logo: string, alphaFloor = 0) {
  const key = `${alphaFloor}|${logo}`;
  let job = logoCache.get(key);
  if (!job) {
    job = loadImage(logoUrl(logo)).then((img) => {
      const canvas = fitToTexture(img, img.naturalWidth || TEX, img.naturalHeight || TEX, alphaFloor);
      return { canvas, sdf: buildSdf(canvas) };
    });
    logoCache.set(key, job);
    job.catch(() => logoCache.delete(key));
  }
  return job;
}

/* ------------------------------------------------------------------ *
 * Shader
 * ------------------------------------------------------------------ */
const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uCenter;
uniform float uTile;
uniform sampler2D uSdf;
uniform sampler2D uCol;
uniform float uTexSize;
uniform float uBoxFrac;

uniform float uPlateScale;
uniform float uShapeN;
uniform float uCornerN;
uniform float uOptics;
uniform float uPlateAlpha;
uniform float uLogoHalf;
uniform vec2 uLogoOff;
uniform float uBold;
uniform float uBlur;
uniform float uFrost;
uniform float uDome;
uniform float uDrop;
uniform float uPinch;
uniform float uTilt;
uniform float uRim;
uniform float uHalo;
uniform float uShadow;
uniform float uGhost;
uniform float uRipR;
uniform float uRipA;
uniform float uBare;
uniform float uReach;
uniform float uCornerPull;
uniform float uStreak;
uniform float uWiden;
uniform float uSlab;
uniform float uEtaSpread;
uniform float uFocus;
uniform float uFocusK;
uniform float uFocusSplit;
uniform float uRimLine;
uniform float uCornerOn;
uniform float uDissolve;
uniform float uGlow;
uniform float uFaceDisp;
uniform float uVivid;

uniform float uDisp;
uniform float uDouble;
uniform float uBevelW;
uniform float uSpec;
uniform float uIconPlate;
uniform float uUseColor;
uniform float uLightScene;
uniform float uLightGlass;
uniform float uKeep;
uniform float uSheen;
uniform float uSweep;
uniform float uLightAng;

uniform vec3 uBg;
uniform vec3 uPlateCol;
uniform vec3 uLogoCol;

float px;

vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }

vec4 logoAt(vec2 q, float blur, float aa) {
  float L = uLogoHalf;
  float k = 0.5 * uBoxFrac / L;
  vec2 uv = vec2(0.5 + (q.x - uLogoOff.x) * k, 0.5 - (q.y - uLogoOff.y) * k);
  float d = texture(uSdf, uv).r / k;
  float w = 0.75 * aa + blur;
  float a = 1.0 - smoothstep(-w, w, d - uBold * L);
  vec3 c = uLogoCol;
  if (uUseColor > 0.5) {
    float lod = log2(max(1.0, w * k * uTexSize));
    vec4 c0 = textureLod(uCol, uv, lod);
    vec4 c1 = textureLod(uCol, uv, lod + 3.0);
    vec4 c2 = textureLod(uCol, uv, 7.0);
    c = c2.rgb / max(c2.a, 1e-4);
    c = mix(c, c1.rgb / max(c1.a, 1e-4), smoothstep(0.0, 0.06, c1.a));
    c = mix(c, c0.rgb / max(c0.a, 1e-4), smoothstep(0.02, 0.3, c0.a));
  }
  return vec4(c, a);
}

float shape(vec2 p, float scale, float n, out vec2 nOut, out float g, out vec2 dg) {
  vec2 pp = p / scale;
  vec2 a = max(abs(pp), vec2(1e-6));
  g = pow(pow(a.x, n) + pow(a.y, n), 1.0 / n);
  dg = sign(pp) * pow(a, vec2(n - 1.0)) * pow(max(g, 1e-6), 1.0 - n);
  float dgl = max(length(dg), 1e-6);
  nOut = dg / dgl;
  return (g - 1.0) / dgl * scale;
}

float contourRadius(vec2 p, float scale, float n) {
  vec2 a = max(abs(p / scale), vec2(1e-4));
  vec2 a1 = pow(a, vec2(n - 1.0));
  vec2 a2 = pow(a, vec2(n - 2.0));
  float k = (n - 1.0) * (a2.x * a1.y * a1.y + a2.y * a1.x * a1.x) / pow(max(dot(a1, a1), 1e-30), 1.5);
  return scale / max(k, 1e-3);
}

vec2 refractSample(float x, float bwF, float eta, float R, vec2 dirOut, vec2 p, float dome, float offMul) {
  float u = clamp(1.0 - x, 0.0, 0.995);
  float th = asin(u), thr = asin(u / eta);
  float z = uSlab + bwF * sqrt(1.0 - u * u);
  float off = offMul * z * tan(th - thr);
  off = off / (1.0 + off / (6.0 * R));
  return p - (dirOut * off + p * dome) * uOptics;
}

float gauss(float x, float c, float w) { float d = (x - c) / w; return exp(-0.5 * d * d); }
float band(float x, float a, float b, float w) { return smoothstep(a - w, a, x) * (1.0 - smoothstep(b, b + w, x)); }

float bump(float x, float c, float w) { float d = (x - c) / w; return exp(-0.5 * d * d); }
vec3 spectrum(float x) {
  return vec3(bump(x, 0.34, 0.2) + 0.08 * bump(x, 0.93, 0.05), bump(x, 0.58, 0.1), bump(x, 0.8, 0.11));
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  px = 2.0 / uTile;
  vec2 p = (gl_FragCoord.xy - uCenter) * px;

  vec4 lg = logoAt(p, uBlur, px);
  vec3 plain = mix(uBg, lg.rgb, lg.a * uBare);

  vec2 nOut, dg; float g;
  float sd = shape(p, uPlateScale, uShapeN, nOut, g, dg);
  float s = -sd;
  float bw = max(uBevelW, 0.004) * uPlateScale;
  float x = clamp(s / bw, 0.0, 1.0);
  float R = contourRadius(p, uPlateScale, uShapeN);
  vec2 pq = p * p;
  float diag = 4.0 * pq.x * pq.y / max((pq.x + pq.y) * (pq.x + pq.y), 1e-6);
  float tilt = mix(1.0 - uTilt, 1.0, smoothstep(-0.02, 0.02, p.x * p.y));
  float pinchPart = uPinch * min(g * g, 1.0) * diag * diag * tilt;
  float dome = uDome * (1.0 - min(g * g, 1.0)) + pinchPart;
  vec2 dirOut = normalize(mix(nOut, p / max(length(p), 1e-4), 0.2));
  float cornerness = max(smoothstep(0.1, 0.9, 4.0 * nOut.x * nOut.x * nOut.y * nOut.y), smoothstep(0.15, 0.75, diag));
  float offMul = 1.0 + 0.4 * max(uCornerPull - 1.0, 0.0) * tilt * cornerness * uCornerOn;
  vec2 focus = sign(p) * (pow(0.5, 1.0 / uShapeN) - uFocus * 0.70710678) * uPlateScale;
  float focusW = tilt * cornerness * uOptics * uCornerOn;
  float bwF = max(uReach, 0.004) * (1.0 + uWiden * tilt * cornerness * uCornerOn);
  float xf = clamp(s / bwF, 0.0, 1.0);
  vec2 qc = refractSample(xf, bwF, 1.5, R, dirOut, p, dome, offMul);
  float foot = max(max(length(dFdx(qc)), length(dFdy(qc))), 0.25 * px);

  vec3 bg = uBg;
  vec3 lift = mix(uBg + vec3(0.06), mix(uBg, vec3(1.0), 0.55), uLightScene);
  if (uGhost > 0.001) {
    vec2 gn, gdg; float gg;
    float gsd = shape(p, 1.0, uCornerN, gn, gg, gdg);
    bg = mix(bg, lift, uGhost * 0.12 * (1.0 - smoothstep(-0.16, 0.14, gsd)));
    bg *= 1.0 - uGhost * 0.03 * uLightScene * exp(-max(gsd, 0.0) / 0.12) * step(0.0, gsd);
  }
  float outside = max(sd, 0.0);
  if (uRipA > 0.001) {
    float d0 = (uRipR - 1.0) * uPlateScale;
    float rx = (sd - d0) / 0.022;
    float ring = exp(-rx * rx);
    bg += uRipA * ring * (0.04 * (0.55 + 0.45 * dot(nOut, normalize(vec2(-0.5, 0.8))))) * mix(0.5, 1.0, uLightScene);
    bg -= uRipA * 0.016 * uLightScene * exp(-(rx - 1.6) * (rx - 1.6));
  }
  float shadowFall = max(sd, 0.0) / (0.9 * uPlateScale);
  bg *= 1.0 - uShadow * 0.03 * exp(-shadowFall * shadowFall) * step(0.0, sd);
  vec3 haloCol = mix(vec3(0.62, 0.69, 0.80), vec3(1.0), uLightScene);
  bg = mix(bg, haloCol, clamp(uHalo * (0.30 * exp(-outside / (0.025 * uPlateScale)) + 0.07 * exp(-outside / (0.12 * uPlateScale))), 0.0, 1.0) * step(0.0, sd));

  vec3 col = bg;
  float soft = px + uBlur * 0.8 + 0.06 * uDissolve * (1.0 - uKeep) * uPlateScale;
  if (sd < soft) {
    float y1 = 1.0 - x;
    const float K = 2.6;
    float base1 = max(1.0 - pow(y1, K), 1e-4);
    float db = min(pow(y1, K - 1.0) * pow(base1, 1.0 / K - 1.0), 25.0);
    float s1 = bw * 0.62;
    float w2 = bw * 0.22;
    float t2 = clamp((s - s1) / w2, -1.0, 1.0);
    float dh2 = uDouble * bw * 0.16;
    float dd = dh2 * 0.5 * cos(t2 * 1.5707963) * 1.5707963 / w2 * step(abs(t2), 0.999);
    vec2 gDome = -uDome * 2.0 * g * dg * step(g, 1.0);
    vec2 grad = -(db + dd) * nOut + gDome;

    vec3 back = mix(uBg, uPlateCol, uIconPlate);
    vec3 liftG = mix(back + vec3(0.06), mix(back, vec3(1.0), 0.55), uLightGlass);
    float rblur = uBlur + 0.05 * length(qc - p) + min(uGlow * uOptics * (1.0 - xf) * foot / px, 0.04);

    float cornerW = smoothstep(0.1, 0.9, 4.0 * nOut.x * nOut.x * nOut.y * nOut.y);
    float streak = 0.35 * uStreak * bw * mix(0.15, 1.0, cornerW) * pow(1.0 - xf, 1.5) * uOptics;
    vec2 tangent = vec2(-nOut.y, nOut.x);
    vec3 acc = vec3(0.0), wsum = vec3(0.0);
    for (int i = 0; i < 20; i++) {
      float lam = (float(i) + 0.5) / 20.0;
      float c = uDisp * (1.0 - 2.0 * lam);
      vec2 along = tangent * (streak * 2.0 * (fract(float(i) * 0.618034 + 0.31) - 0.5));
      float cf = uDisp * (1.0 - 2.0 * lam) * (lam > 0.5 ? 1.0 : 0.5);
      vec2 sp = refractSample(xf, bwF, 1.5 + uEtaSpread * c, R, dirOut, p + along,
                              dome + pinchPart * 0.3 * c, offMul);
      vec2 focusL = focus - sign(p) * (0.70710678 * uFocusSplit * c * uPlateScale);
      float wFocus = pow(1.0 - xf, uFocusK) * smoothstep(0.0, uRimLine * (1.0 + 0.6 * c), xf);
      sp = mix(sp, mix(p + along, focusL, wFocus), focusW);
      float faceOnly = smoothstep(0.7, 1.0, xf) * uOptics;
      sp *= 1.0 + uFaceDisp * cf * faceOnly;
      vec4 l = logoAt(sp, rblur + 0.12 * streak + uFaceDisp * 0.5 * max(c, 0.0) * faceOnly, foot);
      vec3 w = spectrum(lam);
      acc += mix(back, l.rgb, l.a) * w;
      wsum += w;
    }
    vec3 trans = acc / wsum;
    float tl = dot(trans, vec3(0.2126, 0.7152, 0.0722));
    trans = clamp(tl + (trans - tl) * (1.0 + uVivid * uOptics), 0.0, 1.0);
    float hazeLum = dot(trans, vec3(0.2126, 0.7152, 0.0722));
    float hazeGate = mix(1.0 - smoothstep(0.25, 0.75, hazeLum), smoothstep(0.25, 0.75, hazeLum), uLightGlass);
    trans = mix(trans, liftG, uFrost * 0.45 * hazeGate);

    float glassAmt = pow(1.0 - uDissolve, 1.5);
    float lit = uSpec * glassAmt;
    vec3 rimCol = mix(vec3(0.80, 0.87, 0.97), vec3(1.0), uLightGlass);

    float sc = uPlateScale;
    float tLum = dot(trans, vec3(0.2126, 0.7152, 0.0722));
    float lightOnly = smoothstep(0.35, 0.85, tLum);
    float hw = smoothstep(-0.85, 0.5, dot(nOut, rot(vec2(0.5, 0.866), uLightAng)));
    float tileBand = band(s, 0.016 * sc, 0.075 * sc, 0.022 * sc);
    float dropBand = (1.0 - smoothstep(0.06 * sc, 0.13 * sc, s)) * smoothstep(0.0, 0.004 * sc, s);
    float glow = mix(0.32 * tileBand, 0.75 * dropBand, uDrop) * lightOnly;
    float edgeLine = gauss(s, 0.005 * sc, 0.0045 * sc);
    float lip = gauss(s, 0.15 * sc, 0.007 * sc) * uDouble * (1.0 - uDrop);
    vec3 lightGlass = mix(trans, vec3(1.0), glow * glassAmt);
    lightGlass += (0.075 * hw * edgeLine + 0.06 * (0.4 + 0.6 * hw) * lip) * lit;
    lightGlass *= 1.0 - 0.05 * (1.0 - hw) * edgeLine * glassAmt * (1.0 - uDrop);
    lightGlass = mix(lightGlass, vec3(1.0), 0.55 * uDrop * glassAmt * edgeLine);

    vec3 Nl = normalize(vec3(-grad, 1.0));
    float edge = 1.0 - Nl.z;
    vec2 ldir = rot(normalize(vec2(-0.62, 0.78)), uLightAng);
    float side = dot(nOut, ldir);
    float fres = pow(edge, 1.5);
    vec3 rim = rimCol * fres * (0.35 + 0.65 * max(side, -side * 0.8)) * uRim * 0.65;
    vec3 Hv = normalize(normalize(vec3(-0.45, 0.6, 0.66)) + vec3(0.0, 0.0, 1.0));
    float spc = pow(max(dot(Nl, Hv), 0.0), 140.0) * 0.8 * smoothstep(0.0, 0.25, y1);
    vec3 darkGlass = trans * (1.0 - 0.25 * fres) + (rim + vec3(spc)) * lit;
    darkGlass = mix(darkGlass, rimCol, uDrop * 0.4 * uSpec * (1.0 - smoothstep(0.0, 0.1 * uPlateScale, s)));
    vec3 glass = mix(darkGlass, lightGlass, uLightGlass);

    float sweepD = dot(p / uPlateScale, normalize(vec2(0.8, 0.6))) - uSweep;
    float sheen = uSheen * glassAmt * exp(-sweepD * sweepD / 0.03) * (0.55 + 0.45 * (1.0 - x));
    glass = mix(glass, vec3(1.0), sheen * mix(0.22, 0.42, uLightGlass));

    float cov = clamp(0.5 - sd / soft, 0.0, 1.0);
    col = mix(bg, glass, cov);
  }

  vec3 outc = mix(plain, col, uPlateAlpha);
  outc += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(outc, 1.0);
}`;

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */
type Frame = ReturnType<typeof frameAt>;

function createRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader");
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "program");
  gl.useProgram(prog);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U: Record<string, WebGLUniformLocation | null> = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(prog, i)!;
    U[info.name] = gl.getUniformLocation(prog, info.name);
  }

  const sdfTex = gl.createTexture();
  const colTex = gl.createTexture();
  gl.uniform1i(U.uSdf, 0);
  gl.uniform1i(U.uCol, 1);
  let hasLogo = false;

  const params = (filter: number) => {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };

  function setLogo(logo: LogoData) {
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, sdfTex);
    gl!.pixelStorei(gl!.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.R16F, TEX, TEX, 0, gl!.RED, gl!.FLOAT, logo.sdf);
    params(gl!.LINEAR);

    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, colTex);
    gl!.pixelStorei(gl!.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA8, gl!.RGBA, gl!.UNSIGNED_BYTE, logo.canvas);
    gl!.pixelStorei(gl!.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl!.generateMipmap(gl!.TEXTURE_2D);
    params(gl!.LINEAR_MIPMAP_LINEAR);
    hasLogo = true;
  }

  function render(fr: Frame, w: number, h: number, tilePx: number) {
    if (!hasLogo) return;
    gl!.viewport(0, 0, w, h);
    gl!.uniform2f(U.uCenter, w / 2, h / 2);
    gl!.uniform1f(U.uTile, tilePx);
    gl!.uniform1f(U.uTexSize, TEX);
    gl!.uniform1f(U.uBoxFrac, BOX);
    for (const k in fr) {
      const v = fr[k as keyof Frame];
      if (typeof v === "number" && U[k]) gl!.uniform1f(U[k], v);
    }
    gl!.uniform3fv(U.uBg, fr.uBg);
    gl!.uniform3fv(U.uPlateCol, fr.uPlateCol);
    gl!.uniform3fv(U.uLogoCol, fr.uLogoCol);
    gl!.uniform2fv(U.uLogoOff, fr.uLogoOff);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }

  function dispose() {
    gl!.getExtension("WEBGL_lose_context")?.loseContext();
  }

  return { setLogo, render, dispose };
}

/* ------------------------------------------------------------------ *
 * Spring timeline
 * ------------------------------------------------------------------ */
const TAIL = 1.1; // from the glass letting go to everything at rest, seconds
const OUTRO = 0.5; // loop only: the logo blurs away before the next reveal
const endOf = (P: Settings) => P.present + TAIL;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const smoother = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.replace(/./g, "$&$&");
  const v = parseInt(h.slice(0, 6), 16) || 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Step response of a spring released at t = 0, from 0 toward 1 (damping 1 = no overshoot,
// response = period of the undamped spring, seconds).
function spring(t: number, response: number, damping: number) {
  if (t <= 0) return 0;
  const w = (2 * Math.PI) / response;
  if (damping >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
  const wd = w * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
}

const reachCache = new Map<string, number>();
function timeToReach(level: number, response: number, damping: number) {
  const key = `${level}/${response}/${damping}`;
  let t = reachCache.get(key);
  if (t === undefined) {
    let lo = 0;
    let hi = 3;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (spring(mid, response, damping) < level) lo = mid;
      else hi = mid;
    }
    reachCache.set(key, (t = hi));
  }
  return t;
}

// All motion lives here; the shader only sees the resulting numbers. The droplet grows on one spring,
// spreads from circle to squircle as it lands, the logo glides out of its magnification and the glass
// holds it while a band of light crosses the face and the rim light turns. Then the glass lets go: the
// bare logo stays, or with keepPlate the glass settles into a flat icon plate.
function frameAt(T: number, P: Settings, outro = 0) {
  const tx = P.present;
  const keep = P.keepPlate ? 1 : 0;
  const damping = 1 - P.bounce;
  const grow = spring(T + 0.01, P.response, damping);
  const tl = timeToReach(0.85, P.response, damping) - 0.01;
  const tm = timeToReach(0.92, P.response, damping) - 0.01;
  const morph = spring(T - tm, 0.4, 1);
  const drop = 1 - smooth(0.05, 1, morph);
  const appear = smooth(0, 0.08, T);
  const drift = P.drift * spring(T - 0.3, 2.2, 1);
  const zoomIn = 0.25 * spring(T, 0.7, 1) + 0.75 * smoother(0, P.glide, T);
  const settle = spring(T - 0.5, 2.4, 1);
  const exit = spring(T - tx, 0.95, 1);
  const release = spring(T - tx - 0.05, 0.65, 1);
  const dome = 0.15 * P.bulge * (1 - smooth(0.4, 0.95, grow));
  const view = (1 + (P.startZoom - 1) * (1 - zoomIn)) * (1 - 0.045 * settle) * mix(1, P.finalScale, exit) * (1 - 0.06 * outro);
  const bandW = mix(P.bevelWidth, Math.max(P.bevelWidth, 0.4), drop);
  const plateScale = mix(P.startSize, 1, grow) * (1 + drift) * (1 + 0.14 * release * (1 - keep)) * (1 - keep * (0.03 * release + 0.06 * outro));
  const bg = hexToRgb(P.background);
  return {
    uPlateScale: plateScale,
    uShapeN: mix(2, P.corner, morph),
    uCornerN: P.corner,
    uOptics: 1 - smooth(0.55, 1, release),
    uPlateAlpha: keep ? appear * (1 - outro) : appear * (1 - smooth(0.45, 1, release)),
    uLogoHalf: P.logoScale * view,
    uLogoOff: [P.logoOffset[0] * view, P.logoOffset[1] * view] as [number, number],
    uKeep: keep,
    uSheen: P.sheen,
    uSweep: mix(-1.6, 1.6, smoother(0.9, tx - 0.1, T)),
    uLightAng: P.lightTurn * smoother(0.4, tx + 0.4, T),
    uBold: P.swell * 0.03 * (1 - zoomIn),
    uBlur: P.focus * 0.05 * (1 - smooth(0.3, 0.95, grow)) + 0.03 * outro,
    uFrost: P.focus * (1 - smooth(0.5, 0.95, grow)),
    uPinch: 0.38 * P.stretch * smooth(0.1, 0.9, morph) * smooth(0.75, 0.97, zoomIn),
    uTilt: P.tilt,
    uDome: dome,
    uDrop: drop,
    uRim: 1 + 0.8 * drop,
    uHalo: P.halo * (0.5 + 0.5 * drop) * (1 - keep * release),
    uShadow: Math.max(P.shadow * smooth(0.45, 0.8, grow) * (1 - smooth(0, 0.6, morph)), 0.8 * P.shadow * keep * release),
    uGhost: smooth(0, 0.03, T) * (1 - smooth(0.04, 0.08, T)),
    uRipR: 1 + 0.9 * Math.max(0, T - tl),
    uRipA: P.ripple * smooth(tl, tl + 0.06, T) * Math.exp(-Math.max(0, T - tl) / 0.6),
    uBare: (1 - keep) * smooth(tx - 0.25, tx, T) * (1 - outro),
    uReach: bandW * plateScale,
    uCornerPull: P.cornerPull,
    uStreak: P.edgeSmear,
    uWiden: P.cornerWidth,
    uSlab: 0.3 * P.opticalDepth,
    uEtaSpread: 0.06,
    uFocus: P.cornerFocus,
    uFocusK: 1.0,
    uFocusSplit: 0.056 * P.colorBleed,
    uRimLine: 0.09,
    uCornerOn: smooth(0.35, 1, morph),
    uGlow: 0.012 * P.colorBleed,
    uFaceDisp: 0.012 * P.dispersion,
    uVivid: 0.85,
    uDissolve: release,
    uDisp: P.dispersion,
    uDouble: P.doubleBevel,
    uBevelW: bandW * (1 - release),
    uSpec: P.specular,
    uIconPlate: P.iconPlate ? 1 : 0,
    uUseColor: P.originalColors ? 1 : 0,
    uLightScene: luminance(bg) > 0.5 ? 1 : 0,
    uLightGlass: luminance(P.iconPlate ? hexToRgb(P.plateColor) : bg) > 0.5 ? 1 : 0,
    uBg: bg,
    uPlateCol: hexToRgb(P.plateColor),
    uLogoCol: hexToRgb(P.logoColor),
  };
}

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
    loadLogo(logo, alphaFloor).then(
      (data) => {
        if (cancelled) return;
        engineRef.current?.setLogo(data);
      },
      (err) => {
        console.error(err);
        if (!cancelled) live.current.onFinished?.();
      },
    );
    return () => {
      cancelled = true;
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
    console.error(err);
  }
  if (!renderer) {
    canvas.remove();
    return null;
  }

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
      console.error(err);
    }
    dirty = true;
    kick();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    setLogo(data: LogoData) {
      logo = data;
      renderer?.setLogo(data);
      if (!reduceMotion) {
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
const WORDMARK_LETTERS = { width: 0.8735, dx: 0.0316, dy: 0.0649, aspect: 1012 / 493 };

/**
 * Where the wordmark picture (`logo.png`, `logo-light.png`) sits when the reveal in
 * `canvasBox` holds its last frame, so an `<img>` of it there covers the drawn
 * logo exactly. `tileSize` is the reveal's own prop.
 */
export function adeLogoRevealWordmarkBox(canvasBox: ScreenBox, tileSize: number): ScreenBox {
  const tile = Math.min(tileSize, Math.min(canvasBox.width, canvasBox.height) / 1.75);
  const width = (tile * LETTERS_PER_TILE) / WORDMARK_LETTERS.width;
  const height = width / WORDMARK_LETTERS.aspect;
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
