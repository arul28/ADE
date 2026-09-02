import fs from "node:fs";
import path from "node:path";

import type { PluginManifest } from "../../../shared/plugins/manifest";
import {
  PLUGIN_BRAND_ICON_LIMITS,
  sanitizePluginBrandSvg,
  type PluginBrandGlyph,
} from "../../../shared/plugins/vocabularyBrandIcons";

/**
 * Read and sanitize every SVG the manifest named under `brandIcons`.
 *
 * Fail-closed per file: a missing path, an over-long file, or a mark the
 * sanitizer refuses is skipped rather than poisoning the rest of the set.
 * The plugin still loads; `brand:whatever` for the skipped file puzzles like
 * any unknown token.
 */
export function loadPluginBrandIcons(
  pluginRoot: string,
  manifest: PluginManifest | null | undefined,
): Record<string, PluginBrandGlyph> {
  const declared = manifest?.brandIcons;
  if (!declared) return {};
  const glyphs: Record<string, PluginBrandGlyph> = {};
  for (const [token, relative] of Object.entries(declared)) {
    if (Object.keys(glyphs).length >= PLUGIN_BRAND_ICON_LIMITS.maxIcons) break;
    const file = path.resolve(pluginRoot, relative);
    if (!file.startsWith(path.resolve(pluginRoot) + path.sep) && file !== path.resolve(pluginRoot)) {
      continue;
    }
    let source: string;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > PLUGIN_BRAND_ICON_LIMITS.maxBytes) continue;
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const glyph = sanitizePluginBrandSvg(source);
    if (!glyph) continue;
    glyphs[token] = glyph;
  }
  return glyphs;
}
