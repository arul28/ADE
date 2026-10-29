/**
 * Each provider page wears its maker's colors: an accent, a banner, and how
 * its logo stands on the banner.
 *
 * The accent replaces the theme's own accent on that page only, so every
 * control that already reads `--color-accent` (links, focus rings, the
 * default-model star) takes the provider's color with no change of its own.
 * A neutral brand (black-and-white logos) mixes its color with the theme's
 * text color, so it stays readable on light and dark themes alike.
 */
import type { CSSProperties, ReactNode } from "react";
import { Antigravity, Claude, Codex, Cursor, GithubCopilot, Grok, Kimi, Qwen } from "@lobehub/icons";
import { DevinMark, MuseLogo } from "../../shared/ProviderLogos";
import claudeArt from "./banners/claude-art.webp";
import codexBanner from "./banners/codex.webp";
import copilotBanner from "./banners/copilot.webp";
import devinBanner from "./banners/devin.webp";
import droidBanner from "./banners/droid.webp";
import museBanner from "./banners/muse.webp";
import openCodeWordmark from "./banners/opencode-wordmark.webp";

export type ProviderBrand = {
  /** The maker's main color. */
  accent: string;
  /** True for black-and-white brands: the accent is mixed with the text color. */
  neutral?: boolean;
  /** The banner background: an image, a gradient, or both. */
  banner: CSSProperties;
  /** Art over the background, just left of the usage panel. */
  bannerArt?: { src: string; width: number; opacity?: number };
  /** Whether banner text should be dark (light banners). */
  lightBanner?: boolean;
  /** A saturated banner that white text reads on: a lighter shade keeps its color. */
  softShade?: boolean;
  /** How the logo stands on the banner. */
  logo: ProviderBrandLogo;
};

/**
 * A logo with a shape of its own (`solid`) stands as a solid object: the mark
 * is stacked in depth, its side in a dark shade of the maker's color. A
 * one-color mark takes `face` and `side` as its ink; a full-color mark keeps
 * its colors and darkens them for the side. A square logo (`tile`) keeps a
 * tile, because the tile is the logo's own shape.
 */
export type ProviderBrandLogo =
  | { kind: "solid"; mark: (size: number) => ReactNode; face?: string; side?: string; fullColor?: boolean; size?: number }
  | { kind: "tile"; background: string; color: string };

const solid = (mark: (size: number) => ReactNode, face: string, side: string, size?: number): ProviderBrandLogo => ({
  kind: "solid", mark, face, side, ...(size ? { size } : {}),
});
const fullColor = (mark: (size: number) => ReactNode, size?: number): ProviderBrandLogo => ({
  kind: "solid", mark, fullColor: true, ...(size ? { size } : {}),
});
const tile = (background: string, color: string): ProviderBrandLogo => ({ kind: "tile", background, color });

const image = (src: string, fallback: string): CSSProperties => ({
  backgroundColor: fallback,
  backgroundImage: `url(${src})`,
  backgroundSize: "cover",
  backgroundPosition: "center",
});

const BRANDS: Record<string, ProviderBrand> = {
  claude: {
    accent: "#D97757",
    banner: {
      background: [
        "radial-gradient(70% 140% at 85% 0%, rgba(255,255,255,0.14), transparent 60%)",
        "linear-gradient(120deg, #C9653F, #D97757 45%, #E0896A)",
      ].join(", "),
    },
    bannerArt: { src: claudeArt, width: 104 },
    softShade: true,
    logo: solid((size) => <Claude size={size} />, "#FFF4EA", "#9C3E1C"),
  },
  codex: {
    accent: "#5866F5",
    banner: image(codexBanner, "#4A57E8"),
    logo: solid((size) => <Codex size={size} />, "#FFFFFF", "#1F2A9C"),
  },
  cursor: {
    accent: "#9A9AA4",
    neutral: true,
    banner: {
      background: [
        "radial-gradient(120% 140% at 85% 10%, rgba(255,255,255,0.16), transparent 55%)",
        "repeating-linear-gradient(60deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 28px)",
        "repeating-linear-gradient(-60deg, rgba(255,255,255,0.035) 0 1px, transparent 1px 28px)",
        "linear-gradient(135deg, #1B1B1F, #0B0B0D 60%, #26262B)",
      ].join(", "),
    },
    logo: solid((size) => <Cursor size={size} />, "#F4F4F5", "#3A3A42"),
  },
  droid: {
    accent: "#F98A07",
    banner: image(droidBanner, "#FFB300"),
    lightBanner: true,
    logo: tile("linear-gradient(145deg, #1C1C1C, #000000)", "#FFFFFF"),
  },
  copilot: {
    accent: "#7448FF",
    banner: image(copilotBanner, "#2A00B8"),
    logo: solid((size) => <GithubCopilot size={size} />, "#FFFFFF", "#2A0C8F"),
  },
  muse: {
    accent: "#0866FF",
    banner: image(museBanner, "#E9EEF5"),
    lightBanner: true,
    logo: fullColor((size) => <MuseLogo size={size} />, 104),
  },
  pi: {
    accent: "#8E8E8E",
    neutral: true,
    banner: {
      background: [
        "linear-gradient(90deg, rgba(0,0,0,0.0), rgba(0,0,0,0.35))",
        "repeating-linear-gradient(0deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 16px)",
        "repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 16px)",
        "linear-gradient(135deg, #2B2B2B, #0E0E0E)",
      ].join(", "),
    },
    logo: tile("linear-gradient(145deg, #2C2C2C, #050505)", "#FFFFFF"),
  },
  opencode: {
    accent: "#A39E9E",
    neutral: true,
    banner: {
      background: [
        "radial-gradient(90% 120% at 80% 50%, rgba(241,236,236,0.10), transparent 60%)",
        "linear-gradient(135deg, #1A1717, #0F0D0D)",
      ].join(", "),
    },
    bannerArt: { src: openCodeWordmark, width: 200, opacity: 0.22 },
    logo: tile("linear-gradient(145deg, #2A2626, #131010)", "#F1ECEC"),
  },
  qwen: {
    accent: "#615CED",
    softShade: true,
    banner: {
      background: [
        "radial-gradient(80% 140% at 90% 0%, rgba(255,255,255,0.22), transparent 55%)",
        "radial-gradient(60% 120% at 10% 100%, rgba(140,80,255,0.55), transparent 60%)",
        "linear-gradient(120deg, #3F38D6, #615CED 45%, #7A4FE8)",
      ].join(", "),
    },
    logo: solid((size) => <Qwen size={size} />, "#FFFFFF", "#231C8C"),
  },
  kimi: {
    accent: "#1783FF",
    banner: {
      background: [
        "radial-gradient(40% 90% at 82% 20%, rgba(23,131,255,0.55), transparent 70%)",
        "radial-gradient(70% 120% at 10% 120%, rgba(255,255,255,0.10), transparent 60%)",
        "linear-gradient(135deg, #111214, #050506)",
      ].join(", "),
    },
    logo: solid((size) => <Kimi size={size} />, "#FFFFFF", "#0E4C9E"),
  },
  grok: {
    accent: "#A8A8A8",
    neutral: true,
    banner: {
      background: [
        "radial-gradient(55% 160% at 78% 50%, rgba(255,255,255,0.28), transparent 60%)",
        "radial-gradient(30% 80% at 78% 50%, rgba(255,255,255,0.18), transparent 70%)",
        "linear-gradient(135deg, #0A0A0A, #000000)",
      ].join(", "),
    },
    logo: solid((size) => <Grok size={size} />, "#FFFFFF", "#45454A"),
  },
  devin: {
    accent: "#B4B4B4",
    neutral: true,
    banner: image(devinBanner, "#050505"),
    logo: solid((size) => <DevinMark size={size} />, "#F2F2F2", "#3C3C40", 108),
  },
  antigravity: {
    accent: "#4B8DF8",
    banner: {
      background: [
        "radial-gradient(42% 120% at 70% 0%, rgba(66,133,244,0.50), transparent 70%)",
        "radial-gradient(36% 110% at 88% 100%, rgba(155,114,203,0.42), transparent 70%)",
        "radial-gradient(30% 90% at 52% 110%, rgba(52,168,83,0.18), transparent 70%)",
        "linear-gradient(135deg, #1B1C20, #0E0F12)",
      ].join(", "),
    },
    logo: fullColor((size) => <Antigravity.Color size={size} />),
  },
};

const FALLBACK: ProviderBrand = {
  accent: "var(--color-accent)",
  banner: { background: "linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 40%, #111), #0B0B0D)" },
  logo: tile("linear-gradient(145deg, #2A2A2F, #111114)", "#F2F2F3"),
};

export function providerBrand(providerId: string): ProviderBrand {
  return BRANDS[providerId] ?? FALLBACK;
}

/**
 * The CSS variables that give one page the provider's colors. Set on the
 * page's root element; nothing outside it changes.
 */
export function providerThemeVars(brand: ProviderBrand): CSSProperties {
  const accent = brand.neutral
    ? `color-mix(in srgb, ${brand.accent} 55%, var(--color-fg) 45%)`
    : brand.accent;
  return {
    ["--color-accent" as string]: accent,
    ["--color-accent-muted" as string]: `color-mix(in srgb, ${accent} 16%, transparent)`,
    ["--provider-accent" as string]: accent,
    ["--provider-brand" as string]: brand.accent,
  };
}
