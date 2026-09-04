/**
 * The official theme spec, enforced.
 *
 * A theme plugin ships no code, so nothing about it fails loudly. A theme that
 * forgets the work rail does not throw — it renders a grey rail on a green
 * background, and only a person looking at the right screen would notice. This
 * file is what turns that into a red suite.
 *
 * Three claims are checked, and each one is a real failure we can otherwise
 * ship blind:
 *
 * 1. **Completeness.** Every official theme sets every token in
 *    {@link OFFICIAL_THEME_TOKEN_GROUPS}, in BOTH modes. Reported per group, so
 *    a failure reads "Frost [dark] is missing workRail" rather than naming one
 *    custom property out of a hundred.
 * 2. **Contrast.** Text on the surface ladder clears WCAG AA. A palette is
 *    picked by eye against one background; the ladder has six, and the fifth
 *    one is where a pretty theme becomes unreadable.
 * 3. **Nothing the engine would reject.** Every value passes the same
 *    sanitizer the paint path uses, so an official theme cannot ship a token
 *    that is silently dropped at runtime.
 *
 * Scope is deliberate: this gate is for the OFFICIAL set. The manifest parser
 * stays tolerant, because a community theme that sets three tokens is a valid
 * theme and always was.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_OFFICIAL_THEMES,
  OFFICIAL_THEME_REQUIRED_TOKENS,
  OFFICIAL_THEME_TOKEN_GROUPS,
} from "./marketplaceThemeCatalog";
import { sanitizePluginThemeTokens } from "../../lib/pluginTheme";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const themesRoot = path.join(repoRoot, "plugins", "themes");

type OnDiskTheme = { id: string; tokens: Record<"dark" | "light", Record<string, string>> };

/**
 * Read the themes from disk, not from the catalogue.
 *
 * The catalogue generates the manifests, so asking it whether it is complete
 * proves only that it agrees with itself. `plugins/themes/*` is what ships and
 * what a release tars up, so the walk starts there and a theme directory added
 * tomorrow is graded tomorrow.
 */
function onDiskThemes(): OnDiskTheme[] {
  return fs.readdirSync(themesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const raw = JSON.parse(
        fs.readFileSync(path.join(themesRoot, entry.name, "plugin.json"), "utf8"),
      ) as { name: string; theme?: { tokens?: Record<string, Record<string, string>> } };
      return {
        id: raw.name,
        tokens: {
          dark: raw.theme?.tokens?.dark ?? {},
          light: raw.theme?.tokens?.light ?? {},
        },
      };
    });
}

const themes = onDiskThemes();
const MODES = ["dark", "light"] as const;

/* ── Contrast ───────────────────────────────────────────────────────────── */

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const c = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const [high, low] = first > second ? [first, second] : [second, first];
  return (high + 0.05) / (low + 0.05);
}

/** The six planes any text can land on. */
const SURFACES = [
  "--color-bg",
  "--color-surface",
  "--color-surface-raised",
  "--color-surface-recessed",
  "--color-surface-overlay",
  "--color-popup-bg",
] as const;

/**
 * Body and secondary text carry meaning and take the AA body threshold. Muted
 * text is the timestamp/hint tier — never the only carrier of anything — so it
 * takes AA's large-text threshold instead of being excluded.
 */
const TEXT_MINIMA: Readonly<Record<string, number>> = {
  "--color-fg": 4.5,
  "--color-secondary-fg": 4.5,
  "--color-muted-fg": 3,
};

/* ── The gates ──────────────────────────────────────────────────────────── */

describe("the official themes satisfy the token spec", () => {
  it("grades the themes that actually ship", () => {
    expect(themes.length).toBeGreaterThanOrEqual(12);
    expect(themes.map((theme) => theme.id).sort()).toEqual(
      MARKETPLACE_OFFICIAL_THEMES.map((theme) => theme.manifest.name).sort(),
    );
  });

  it("describes a spec of ten groups and 86 tokens", () => {
    expect(Object.keys(OFFICIAL_THEME_TOKEN_GROUPS)).toHaveLength(10);
    expect(OFFICIAL_THEME_REQUIRED_TOKENS).toHaveLength(86);
    expect(new Set(OFFICIAL_THEME_REQUIRED_TOKENS).size).toBe(OFFICIAL_THEME_REQUIRED_TOKENS.length);
  });

  for (const theme of themes) {
    for (const mode of MODES) {
      const tokens = theme.tokens[mode];

      it(`${theme.id} [${mode}]: fills every spec group`, () => {
        const missing = Object.entries(OFFICIAL_THEME_TOKEN_GROUPS)
          .flatMap(([group, names]) => names
            .filter((name) => typeof tokens[name] !== "string" || tokens[name]!.length === 0)
            .map((name) => `${group}: ${name}`));

        expect(missing).toEqual([]);
      });

      it(`${theme.id} [${mode}]: keeps text readable on every surface`, () => {
        const failures: string[] = [];
        for (const [textToken, minimum] of Object.entries(TEXT_MINIMA)) {
          for (const surface of SURFACES) {
            const ratio = contrastRatio(tokens[textToken]!, tokens[surface]!);
            if (ratio < minimum) {
              failures.push(`${textToken} on ${surface} = ${ratio.toFixed(2)} (needs ${minimum})`);
            }
          }
        }
        // The accent is a background wherever a primary button is, so the pair
        // it carries has to clear AA on its own.
        const onAccent = contrastRatio(tokens["--color-accent-fg"]!, tokens["--color-accent"]!);
        if (onAccent < 4.5) failures.push(`--color-accent-fg on --color-accent = ${onAccent.toFixed(2)}`);
        // The active sidebar label is accent-coloured TEXT on the canvas, which
        // is the pairing an author is most likely to get wrong: the value that
        // reads on a dark ground disappears on a light one.
        const activeItem = contrastRatio(tokens["--shell-sidebar-item-active-fg"]!, tokens["--color-bg"]!);
        if (activeItem < 4.5) failures.push(`--shell-sidebar-item-active-fg on --color-bg = ${activeItem.toFixed(2)}`);

        expect(failures).toEqual([]);
      });

      it(`${theme.id} [${mode}]: sets nothing the theme engine would drop`, () => {
        const { tokens: kept, rejected } = sanitizePluginThemeTokens({ [mode]: tokens });
        expect(rejected).toEqual([]);
        expect(Object.keys(kept[mode] ?? {})).toHaveLength(Object.keys(tokens).length);
      });
    }
  }
});
