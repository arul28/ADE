/**
 * Colour maths for the ADE theme engine.
 *
 * A theme author may write a colour in any of the notations people actually
 * paste — `#A78BFA`, `#abc`, `rgb(167 139 250)`, `oklch(0.74 0.12 293)` — and
 * the engine has to turn all of them into something the renderer can mix,
 * measure and emit. This module is that translation layer and nothing else: no
 * DOM, no CSS, no store. Everything returns plain sRGB tuples so `color-mix`
 * behaviour can be reproduced in a unit test.
 *
 * Two things are load-bearing:
 *
 * - **OKLCH round-tripping.** The brief asks for OKLCH input. Perceptual
 *   lightness is what lets the engine derive a readable `muted-fg` from an
 *   arbitrary accent without every theme author hand-picking one.
 * - **Contrast is computed the way WCAG computes it** (relative luminance on
 *   linearised sRGB), so the warning the customizer shows is the same number a
 *   reviewer would measure.
 */

export type Rgb = { r: number; g: number; b: number };
export type Rgba = Rgb & { a: number };

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;
const RGB_FN = /^rgba?\(\s*([^)]+)\)$/i;
const OKLCH_FN = /^oklch\(\s*([^)]+)\)$/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp255(value: number): number {
  return clamp(Math.round(value), 0, 255);
}

/** Split a `rgb()`/`oklch()` argument list on commas and/or whitespace, plus `/` alpha. */
function splitComponents(raw: string): { parts: string[]; alphaPart: string | null } {
  const slash = raw.split("/");
  const head = slash[0] ?? "";
  const alphaPart = slash.length > 1 ? slash.slice(1).join("/").trim() : null;
  const parts = head
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return { parts, alphaPart };
}

function parseAlpha(part: string | null | undefined): number {
  if (part == null || part === "") return 1;
  const trimmed = part.trim();
  if (trimmed.endsWith("%")) {
    const pct = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(pct) ? clamp(pct / 100, 0, 1) : 1;
  }
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? clamp(value, 0, 1) : 1;
}

/** `rgb()` channel: a `%` reads as a fraction of 255. */
function parseRgbChannel(part: string): number | null {
  if (part.endsWith("%")) {
    const pct = Number.parseFloat(part.slice(0, -1));
    return Number.isFinite(pct) ? clamp255((pct / 100) * 255) : null;
  }
  const value = Number.parseFloat(part);
  return Number.isFinite(value) ? clamp255(value) : null;
}

/** OKLCH lightness: a bare `0.74` or a `74%` both mean 0.74. */
function parseOklchLightness(part: string): number | null {
  if (part.endsWith("%")) {
    const pct = Number.parseFloat(part.slice(0, -1));
    return Number.isFinite(pct) ? clamp(pct / 100, 0, 1) : null;
  }
  const value = Number.parseFloat(part);
  return Number.isFinite(value) ? clamp(value, 0, 1) : null;
}

function parseOklchChroma(part: string): number | null {
  if (part.endsWith("%")) {
    const pct = Number.parseFloat(part.slice(0, -1));
    // 100% chroma is 0.4 in the Oklch reference range.
    return Number.isFinite(pct) ? clamp((pct / 100) * 0.4, 0, 0.5) : null;
  }
  const value = Number.parseFloat(part);
  return Number.isFinite(value) ? clamp(value, 0, 0.5) : null;
}

function parseOklchHue(part: string): number | null {
  const value = Number.parseFloat(part.replace(/deg$/i, ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse any supported CSS colour into linear-free sRGB with alpha.
 *
 * Returns null rather than throwing on anything unrecognised: callers validate
 * user-supplied theme files and a bad colour must become a validation message,
 * not an exception in the middle of an app-wide style application.
 */
export function parseColor(input: unknown): Rgba | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const short = HEX_SHORT.exec(raw);
  if (short) {
    return {
      r: Number.parseInt(short[1] + short[1], 16),
      g: Number.parseInt(short[2] + short[2], 16),
      b: Number.parseInt(short[3] + short[3], 16),
      a: 1,
    };
  }

  const long = HEX_LONG.exec(raw);
  if (long) {
    return {
      r: Number.parseInt(long[1], 16),
      g: Number.parseInt(long[2], 16),
      b: Number.parseInt(long[3], 16),
      a: long[4] ? Number.parseInt(long[4], 16) / 255 : 1,
    };
  }

  const rgbMatch = RGB_FN.exec(raw);
  if (rgbMatch) {
    const { parts, alphaPart } = splitComponents(rgbMatch[1] ?? "");
    if (parts.length < 3) return null;
    const r = parseRgbChannel(parts[0]);
    const g = parseRgbChannel(parts[1]);
    const b = parseRgbChannel(parts[2]);
    if (r == null || g == null || b == null) return null;
    // `rgba(r, g, b, a)` carries alpha as the fourth comma-separated component;
    // `rgb(r g b / a)` carries it after a slash. Support both.
    const alpha = parts.length >= 4 ? parseAlpha(parts[3]) : parseAlpha(alphaPart);
    return { r, g, b, a: alpha };
  }

  const oklchMatch = OKLCH_FN.exec(raw);
  if (oklchMatch) {
    const { parts, alphaPart } = splitComponents(oklchMatch[1] ?? "");
    if (parts.length < 3) return null;
    const l = parseOklchLightness(parts[0]);
    const c = parseOklchChroma(parts[1]);
    const h = parseOklchHue(parts[2]);
    if (l == null || c == null || h == null) return null;
    const rgb = oklchToRgb(l, c, h);
    return { ...rgb, a: parseAlpha(alphaPart) };
  }

  return null;
}

/** True when `input` is a colour the engine can consume. */
export function isParsableColor(input: unknown): boolean {
  return parseColor(input) != null;
}

function linearChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function gammaChannel(value: number): number {
  const channel = clamp(value, 0, 1);
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** Oklab -> sRGB (D65), then gamma encode. Out-of-gamut values are clamped. */
function oklabToRgb(L: number, a: number, b: number): Rgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return {
    r: clamp255(gammaChannel(rLin) * 255),
    g: clamp255(gammaChannel(gLin) * 255),
    b: clamp255(gammaChannel(bLin) * 255),
  };
}

export function oklchToRgb(l: number, c: number, hDeg: number): Rgb {
  const hRad = (hDeg * Math.PI) / 180;
  return oklabToRgb(l, c * Math.cos(hRad), c * Math.sin(hRad));
}

/** sRGB -> Oklch. Used to make accent-derived variants perceptually even. */
export function rgbToOklch(input: Rgb): { l: number; c: number; h: number } {
  const r = linearChannel(input.r);
  const g = linearChannel(input.g);
  const b = linearChannel(input.b);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.sqrt(a * a + bb * bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

function toHexPair(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** Emit `#rrggbb`; alpha is dropped (callers that need it use `toRgbaString`). */
export function toHex(input: Rgb | Rgba): string {
  return `#${toHexPair(clamp255(input.r))}${toHexPair(clamp255(input.g))}${toHexPair(clamp255(input.b))}`;
}

export function toRgbaString(input: Rgba): string {
  const a = clamp(Number.isFinite(input.a) ? input.a : 1, 0, 1);
  const rounded = Math.round(a * 1000) / 1000;
  return `rgba(${clamp255(input.r)}, ${clamp255(input.g)}, ${clamp255(input.b)}, ${rounded})`;
}

/** CSS string a var can consume — hex when opaque, `rgba()` when translucent. */
export function colorToCssString(input: Rgb | Rgba): string {
  const alpha = "a" in input ? input.a : 1;
  return alpha >= 1 ? toHex(input) : toRgbaString({ ...input, a: alpha });
}

/** Start/end of a `color-mix(in srgb, a p%, b)` in sRGB, alpha weighted too. */
export function mixColors(a: Rgb | Rgba, b: Rgb | Rgba, t: number): Rgba {
  const ratio = clamp(t, 0, 1);
  const aA = "a" in a ? a.a : 1;
  const bA = "a" in b ? b.a : 1;
  return {
    r: clamp255(a.r * ratio + b.r * (1 - ratio)),
    g: clamp255(a.g * ratio + b.g * (1 - ratio)),
    b: clamp255(a.b * ratio + b.b * (1 - ratio)),
    a: Math.round((aA * ratio + bA * (1 - ratio)) * 1000) / 1000,
  };
}

/** Apply an alpha to a colour, replacing any alpha it already carried. */
export function withAlpha(input: Rgb | Rgba, alpha: number): Rgba {
  return { r: clamp255(input.r), g: clamp255(input.g), b: clamp255(input.b), a: clamp(alpha, 0, 1) };
}

/** Shift perceptual lightness in Oklch, preserving hue and chroma. */
export function shiftLightness(input: Rgb | Rgba, delta: number): Rgb {
  const { l, c, h } = rgbToOklch(input);
  return oklchToRgb(clamp(l + delta, 0, 1), c, h);
}

export function relativeLuminance(input: Rgb): number {
  return 0.2126 * linearChannel(input.r) + 0.7152 * linearChannel(input.g) + 0.0722 * linearChannel(input.b);
}

/**
 * WCAG contrast ratio, 1–21. Transparent inputs are composited over `over`
 * first so the number describes what a person sees.
 */
export function contrastRatio(
  foreground: Rgb | Rgba,
  background: Rgb | Rgba,
  over?: Rgb,
): number {
  const fg = composite(foreground, over);
  const bg = composite(background, over);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Flatten a translucent colour onto an opaque backdrop. */
export function composite(input: Rgb | Rgba, over?: Rgb): Rgb {
  const alpha = "a" in input ? input.a : 1;
  if (alpha >= 1) return { r: clamp255(input.r), g: clamp255(input.g), b: clamp255(input.b) };
  const base = over ?? { r: 255, g: 255, b: 255 };
  return {
    r: clamp255(input.r * alpha + base.r * (1 - alpha)),
    g: clamp255(input.g * alpha + base.g * (1 - alpha)),
    b: clamp255(input.b * alpha + base.b * (1 - alpha)),
  };
}

/** The WCAG AA floor for body text. Used as the theme warning threshold. */
export const WCAG_AA_TEXT_CONTRAST = 4.5;
/** The WCAG AA floor for large text and UI component boundaries. */
export const WCAG_AA_LARGE_CONTRAST = 3;

/** A readable `fg` over `bg`: light or dark, whichever clears the threshold better. */
export function readableForeground(background: Rgb | Rgba, candidates: Rgb[]): Rgb {
  let best = candidates[0] ?? { r: 0, g: 0, b: 0 };
  let bestRatio = -1;
  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, background);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
  }
  return best;
}
