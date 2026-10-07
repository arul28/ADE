/**
 * A picture's colours, turned into the five-stop ramp the window mesh paints.
 *
 * The picture is drawn into a tiny canvas and clustered (k-means, k = 7) in
 * RGB. The most colourful clusters with distinct hues become anchors, and the
 * ramp walks them the way the theme ramps walk an accent: a dark tinted base,
 * then deep, lobe, accent and a bright highlight.
 * The result is cached per scene id so a launch costs one localStorage read.
 */

import type { WorkToolPickerBackdropTheme } from "../components/terminals/workToolPickerBackdropShader";

export type Rgb = readonly [number, number, number];

export type ScenePalette = {
  /** 0…255 triples, dark → bright. The first is the base. */
  ramp: Rgb[];
  /** Mean luma of the picture, 0…1. */
  luma: number;
};

const CACHE_KEY = "ade.scenePalette.v3";
const SAMPLE_EDGE = 48;
const K = 7;

const memory = new Map<string, ScenePalette>();

function isRgb(value: unknown): value is Rgb {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** A cached entry is trusted only in the exact shape this file writes. */
function isScenePalette(value: unknown): value is ScenePalette {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { ramp?: unknown; luma?: unknown };
  return (
    Array.isArray(candidate.ramp)
    && candidate.ramp.length === 5
    && candidate.ramp.every(isRgb)
    && typeof candidate.luma === "number"
    && Number.isFinite(candidate.luma)
  );
}

function readCache(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeCache(id: string, palette: ScenePalette): void {
  try {
    const all = readCache();
    all[id] = palette;
    // Keep the cache small: a library of a few dozen pictures at most.
    const keys = Object.keys(all);
    for (const key of keys.slice(0, Math.max(0, keys.length - 40))) delete all[key];
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or unavailable: the palette is recomputed next launch.
  }
}

const luma = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function saturation([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export function toHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h / 6, s, l];
}

export function fromHsl(h: number, s: number, l: number): Rgb {
  const hue = (t: number, p: number, q: number) => {
    const x = ((t % 1) + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(h + 1 / 3, p, q) * 255, hue(h, p, q) * 255, hue(h - 1 / 3, p, q) * 255];
}

/** Degrees between two hues given as 0…1 turns. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d) * 360;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Pure: pixels (RGBA bytes) → palette. Exported for the settings preview. */
export function paletteFromPixels(data: Uint8ClampedArray): ScenePalette {
  const points: Rgb[] = [];
  let lumaSum = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3]! < 128) continue;
    const point: Rgb = [data[i]!, data[i + 1]!, data[i + 2]!];
    points.push(point);
    lumaSum += luma(point);
  }
  if (points.length === 0) {
    return { ramp: [[12, 11, 16], [60, 40, 120], [99, 102, 241], [167, 139, 250], [196, 181, 253]], luma: 0.1 };
  }

  // Seed centroids across the luma range so the result is deterministic.
  const sorted = [...points].sort((a, b) => luma(a) - luma(b));
  let centroids: Rgb[] = Array.from({ length: K }, (_, i) => sorted[Math.floor(((i + 0.5) / K) * sorted.length)]!);
  const assignment = new Array<number>(points.length).fill(0);
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const sums = centroids.map(() => [0, 0, 0, 0]);
    points.forEach((point, index) => {
      let best = 0;
      let bestDistance = Infinity;
      centroids.forEach((centroid, c) => {
        const distance =
          (point[0] - centroid[0]) ** 2 + (point[1] - centroid[1]) ** 2 + (point[2] - centroid[2]) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      });
      assignment[index] = best;
      const sum = sums[best]!;
      sum[0] += point[0];
      sum[1] += point[1];
      sum[2] += point[2];
      sum[3] += 1;
    });
    centroids = centroids.map((centroid, c) => {
      const sum = sums[c]!;
      return sum[3] ? [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]] : centroid;
    });
  }
  const counts = centroids.map((_, c) => assignment.filter((a) => a === c).length);
  const clusters = centroids
    .map((color, c) => ({ color, share: counts[c]! / points.length }))
    .filter((cluster) => cluster.share > 0);

  // Anchors: the most colourful clusters with distinct hues. Population counts,
  // colour counts more (a small blue sky beats a large brown floor), and
  // near-black or near-white clusters rarely lead. Greys never become anchors:
  // boosting a grey's saturation invents a hue the picture does not have.
  const score = ({ color, share }: { color: Rgb; share: number }) => {
    const l = luma(color);
    return share * (0.08 + saturation(color) ** 1.2 * 2) * (l > 0.18 && l < 0.82 ? 1 : 0.35);
  };
  const ranked = [...clusters].sort((a, b) => score(b) - score(a));
  const vivid = ranked.filter((cluster) => saturation(cluster.color) >= 0.3).map((cluster) => cluster.color);
  const candidates = vivid.length > 0 ? vivid : [ranked[0]!.color];
  const anchors: Rgb[] = [];
  for (const color of candidates) {
    if (anchors.every((anchor) => hueDistance(toHsl(anchor)[0], toHsl(color)[0]) > 28)) anchors.push(color);
    if (anchors.length === 3) break;
  }

  // The ramp walks the anchors the way the theme ramps walk an accent: a dark
  // tinted base, a deep tone, a second lobe, the accent, a bright highlight.
  // Saturation is lifted from the picture's own, never forced to a floor.
  const boost = (color: Rgb, lightness: number, hueShift = 0): Rgb => {
    const [h, sat] = toHsl(color);
    return fromHsl(h + hueShift / 360, Math.min(0.82, sat * 1.35 + 0.12), lightness);
  };
  const [a, b, c] = anchors;
  const darkest = [...clusters].sort((x, y) => luma(x.color) - luma(y.color))[0]!.color;
  const [baseHue, baseSat] = toHsl(darkest);
  const ramp: Rgb[] = [
    fromHsl(baseHue, Math.min(0.35, Math.max(baseSat, 0.2)), 0.06),
    boost(a!, 0.28),
    b ? boost(b, 0.4) : boost(a!, 0.4, -14),
    boost(a!, 0.55),
    c ? boost(c, 0.72) : b ? boost(b, 0.7) : boost(a!, 0.72, 12),
  ];

  const round = (color: Rgb): Rgb => [Math.round(color[0]), Math.round(color[1]), Math.round(color[2])];
  return { ramp: ramp.map(round), luma: lumaSum / points.length };
}

export async function extractScenePalette(id: string, url: string): Promise<ScenePalette | null> {
  const cached = readCache()[id];
  // A malformed entry (another build's shape, a partial write) is recomputed, not trusted.
  const known = memory.get(id) ?? (isScenePalette(cached) ? cached : undefined);
  if (known) {
    memory.set(id, known);
    return known;
  }
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("load failed"));
      element.src = url;
    });
    const canvas = document.createElement("canvas");
    const scale = SAMPLE_EDGE / Math.max(image.naturalWidth, image.naturalHeight);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const palette = paletteFromPixels(context.getImageData(0, 0, canvas.width, canvas.height).data);
    memory.set(id, palette);
    writeCache(id, palette);
    return palette;
  } catch {
    return null;
  }
}

/**
 * The mesh settings for a picture's colours. Light themes start from a pale
 * wash of the picture instead of its dark base, at the light ramp's strength.
 */
export function backdropThemeFromScene(palette: ScenePalette, mode: "dark" | "light"): WorkToolPickerBackdropTheme {
  const unit = (color: Rgb) => [color[0] / 255, color[1] / 255, color[2] / 255] as const;
  if (mode === "light") {
    const paper: Rgb = [250, 248, 245];
    const [, a, b, c, d] = palette.ramp;
    return {
      colors: [unit(paper), unit(mix(paper, a!, 0.25)), unit(mix(paper, b!, 0.45)), unit(mix(paper, c!, 0.5)), unit(mix(paper, d!, 0.55))],
      intensity: 0.26,
      vignette: 0.1,
      brightness: 0.02,
      saturation: 0.8,
    };
  }
  return {
    colors: palette.ramp.map(unit),
    intensity: 0.46,
    vignette: 0.24,
    brightness: -0.12,
    saturation: 0.9,
  };
}
