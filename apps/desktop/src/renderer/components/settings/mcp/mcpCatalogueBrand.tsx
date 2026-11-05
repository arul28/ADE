/**
 * A catalogue server's look, built from its entry's brand color and mark:
 * the same shape as an integration's (`IntegrationHeroBrand`), so the MCP
 * card, the Integrations tiles and the server page draw it the same way.
 * A server outside the catalogue keeps MCP's own violet and a plug.
 */
import type { CSSProperties, ReactNode } from "react";
import type { McpCatalogueEntry } from "../../../../shared/mcpCatalogue";

/** MCP's own violet, for servers ADE does not know. */
export const MCP_ACCENT = "#8b7cf6";

export type McpBrand = {
  accent: string;
  /** The accent is light (a black-and-white brand): buttons on it take dark text. */
  inkDark: boolean;
  banner: CSSProperties;
  logo: { kind: "solid"; mark: (size: number) => ReactNode; face: string; side: string; size?: number };
};

function channel(hex: string, start: number): number {
  return Number.parseInt(hex.slice(start, start + 2), 16) / 255;
}

/** Relative luminance of `#rrggbb`, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#000000";
  const linear = (value: number) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(channel(clean, 1)) + 0.7152 * linear(channel(clean, 3)) + 0.0722 * linear(channel(clean, 5));
}

function pathMark(path: string, fillRule?: "evenodd") {
  return (size: number) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden style={{ display: "block" }}>
      <path d={path} fillRule={fillRule} />
    </svg>
  );
}

function letterMark(name: string) {
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  return (size: number) => (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: "block" }}>
      <text x="12" y="17.5" textAnchor="middle" fontSize="17" fontWeight="700" fill="currentColor" fontFamily="inherit">{letter}</text>
    </svg>
  );
}

export function mcpCatalogueBrand(entry: McpCatalogueEntry): McpBrand {
  const hex = /^#[0-9a-f]{6}$/i.test(entry.brand.hex) ? entry.brand.hex : MCP_ACCENT;
  const light = luminance(hex);
  // A near-black brand (Notion, PostHog) still needs an accent that reads on
  // the dark card: its buttons go white with dark text, the way its own are.
  const mono = light < 0.06 || light > 0.8;
  const accent = mono ? "#e4e4e7" : hex;
  return {
    accent,
    inkDark: mono,
    banner: {
      background: [
        `radial-gradient(90% 180% at 0% 0%, color-mix(in srgb, ${accent} ${mono ? 16 : 42}%, transparent), transparent 62%)`,
        `linear-gradient(90deg, color-mix(in srgb, ${hex} 26%, #0d0e12) 0%, color-mix(in srgb, ${hex} 12%, #0d0e12) 100%)`,
      ].join(", "),
    },
    logo: {
      kind: "solid",
      mark: entry.brand.path ? pathMark(entry.brand.path, entry.brand.fillRule) : letterMark(entry.name),
      face: mono ? "#ffffff" : hex,
      side: `color-mix(in srgb, ${light < 0.06 ? "#52525b" : hex} 45%, #000)`,
    },
  };
}
