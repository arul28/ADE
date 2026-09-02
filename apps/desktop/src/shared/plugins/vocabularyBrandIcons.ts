/**
 * Plugin-shipped mono brand glyphs — the portable half of `brand:*`.
 *
 * ADE already ships five vendor marks (`claude`/`codex`/`cursor`/`github`/`openai`)
 * because those logos already live on every client. A plugin whose subject is
 * some other vendor — Linear, Jira — has no honest token in that closed set,
 * and inventing one here would be a new ADE release for someone else's logo.
 *
 * So a plugin may ship a small SVG, the host sanitizes it to a path list, and
 * every client draws that list. The SQL tables stay frozen: the glyph rides
 * `plugin_collections` under {@link PLUGIN_BRAND_ICONS_COLLECTION}, a reserved
 * name the plugin cannot write. Older clients ignore the collection; unknown
 * `brand:*` tokens still puzzle identically on every surface.
 *
 * The sanitizer is fail-closed on purpose. The source is a file the plugin
 * author chose, and the renderer turns it into a vector on four clients. A
 * `<script>`, an event handler, an external `href`, a raster `<image>` or a
 * `<use>` of a remote document would be a capability the plugin was never
 * granted. Anything the extractor does not understand is dropped; a file that
 * yields no paths is refused whole.
 */

import { isRecord } from "./parse";

/**
 * The reserved collection the host writes sanitized glyphs into.
 *
 * Same reservation as `ade.memory`: the plugin cannot name it through
 * `collections.*`, declaring it in a manifest does not open it, and it is
 * dropped with the plugin on uninstall. The name is the host's, so a plugin
 * cannot collide with it.
 *
 * Mirrored in `sdk.ts` `isReservedPluginCollection` — keep the two
 * spellings pinned by the tests in `vocabularyBrandIcons.test.ts`.
 */
export const PLUGIN_BRAND_ICONS_COLLECTION = "ade.brandIcons";

export const PLUGIN_BRAND_ICON_LIMITS = {
  /** Source file, UTF-8. A logo that does not fit is not a glyph. */
  maxBytes: 8_192,
  /** Glyphs one plugin may ship. Linear needs one. */
  maxIcons: 8,
  /** Path elements one glyph may keep. */
  maxPaths: 24,
  /** Characters of one path `d`. */
  maxPathChars: 4_096,
  /** The suffix after `brand:`. Lowercase kebab, same charset as a plugin id. */
  tokenPattern: /^[a-z][a-z0-9-]{0,31}$/,
} as const;

/**
 * A sanitized mono glyph: a viewBox and one or more path `d` strings.
 *
 * Fill is always `currentColor` at draw time, so a tinted row still tints the
 * mark. `evenodd` is the only extra the sanitizer keeps, because Linear's own
 * mark needs it and a default nonzero fill would punch the holes shut.
 */
export type PluginBrandGlyph = {
  viewBox: string;
  paths: { d: string; evenodd?: true }[];
};

const FORBIDDEN = /<script\b|on[a-z]+\s*=|javascript:|foreignObject|<iframe\b|<embed\b|<object\b|<image\b|<use\b|<style\b|xlink:href|data:/i;

const VIEWBOX_PATTERN = /^-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?){3}$/;

/** `brand:linear` → `linear`. Anything else, including a bare `linear`, is null. */
export function pluginBrandTokenKey(name: string | null | undefined): string | null {
  const raw = (name ?? "").trim().toLowerCase();
  if (!raw.startsWith("brand:")) return null;
  const key = raw.slice("brand:".length);
  return PLUGIN_BRAND_ICON_LIMITS.tokenPattern.test(key) ? key : null;
}

/** True for any well-formed `brand:<token>`, shipped or not. Unknown still puzzles. */
export function isPluginBrandTokenName(name: string | null | undefined): boolean {
  return pluginBrandTokenKey(name) !== null;
}

/**
 * Re-validate a glyph that already passed the sanitizer — a collection row,
 * a summary field, a panel payload.
 *
 * The host writes only sanitized glyphs, but the phone reads them off a CRR
 * table another machine filled, so the same ceilings run again here. A
 * malformed row is dropped rather than drawn.
 */
export function parsePluginBrandGlyph(value: unknown): PluginBrandGlyph | null {
  if (!isRecord(value)) return null;
  const viewBox = typeof value.viewBox === "string" ? value.viewBox.trim() : "";
  if (!VIEWBOX_PATTERN.test(viewBox)) return null;
  if (!Array.isArray(value.paths) || value.paths.length === 0) return null;
  if (value.paths.length > PLUGIN_BRAND_ICON_LIMITS.maxPaths) return null;
  const paths: PluginBrandGlyph["paths"] = [];
  for (const entry of value.paths) {
    if (!isRecord(entry) || typeof entry.d !== "string") return null;
    const d = entry.d.trim();
    if (d.length === 0 || d.length > PLUGIN_BRAND_ICON_LIMITS.maxPathChars) return null;
    if (/[<>]/.test(d)) return null;
    paths.push(entry.evenodd === true ? { d, evenodd: true } : { d });
  }
  return { viewBox, paths };
}

/**
 * Turn an SVG file into a portable glyph, or nothing.
 *
 * Path-only, currentColor, no scripts. A logo made of circles and rects has
 * to be converted to paths by the author — the extractor does not invent
 * geometry, because inventing it would be a second renderer to keep in sync
 * with four clients.
 */
export function sanitizePluginBrandSvg(source: string): PluginBrandGlyph | null {
  if (typeof source !== "string") return null;
  const trimmed = source.replace(/^\uFEFF/, "").trim();
  if (trimmed.length === 0 || trimmed.length > PLUGIN_BRAND_ICON_LIMITS.maxBytes) return null;
  if (FORBIDDEN.test(trimmed)) return null;

  const svg = extractSvg(trimmed);
  if (svg === null) return null;

  const viewBox = readViewBox(svg) ?? "0 0 24 24";
  const paths = readPaths(svg);
  if (paths.length === 0) return null;
  return { viewBox, paths };
}

function extractSvg(source: string): string | null {
  const withoutDecl = source.replace(/<\?xml[\s\S]*?\?>/i, "").trim();
  const match = withoutDecl.match(/<svg\b[\s\S]*<\/svg>/i);
  return match ? match[0] : null;
}

function readViewBox(svg: string): string | null {
  const attr = svg.match(/\bviewBox\s*=\s*("([^"]+)"|'([^']+)')/i);
  const raw = (attr?.[2] ?? attr?.[3] ?? "").trim().replace(/,/g, " ").replace(/\s+/g, " ");
  return VIEWBOX_PATTERN.test(raw) ? raw : null;
}

function readPaths(svg: string): PluginBrandGlyph["paths"] {
  const paths: PluginBrandGlyph["paths"] = [];
  const tag = /<path\b([^>]*)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(svg)) !== null) {
    if (paths.length >= PLUGIN_BRAND_ICON_LIMITS.maxPaths) break;
    const attrs = match[1] ?? "";
    const d = readAttr(attrs, "d");
    if (!d || d.length > PLUGIN_BRAND_ICON_LIMITS.maxPathChars) continue;
    if (/[<>]/.test(d)) continue;
    const rule = (readAttr(attrs, "fill-rule") ?? readAttr(attrs, "fillRule") ?? "").toLowerCase();
    paths.push(rule === "evenodd" ? { d, evenodd: true } : { d });
  }
  return paths;
}

function readAttr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  const value = match?.[2] ?? match?.[3];
  return value && value.trim().length > 0 ? value.trim() : null;
}
