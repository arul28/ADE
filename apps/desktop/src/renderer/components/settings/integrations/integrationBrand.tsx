/**
 * Each integration page wears its maker's colors, like a provider page: an
 * accent, a banner with the maker's own art on the right, and the logo
 * standing on it in 3D (`SolidLogo`, shared with the provider pages).
 */
import type { CSSProperties } from "react";
import { JIRA_LOGO_PATH } from "../../lanes/jiraBrand";
import { LINEAR_LOGO_PATH } from "../../lanes/linearBrand";
import type { ProviderBrandLogo } from "../providers/providerBrand";
import githubArt from "./banners/github.webp";
import jiraArt from "./banners/jira.webp";
import linearArt from "./banners/linear.webp";

export type IntegrationId = "github" | "linear" | "jira";

export const INTEGRATION_IDS: readonly IntegrationId[] = ["github", "linear", "jira"];

export function isIntegrationId(value: string | null | undefined): value is IntegrationId {
  return value === "github" || value === "linear" || value === "jira";
}

/** Simple Icons' GitHub mark (viewBox 0 0 24 24). */
const GITHUB_LOGO_PATH =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

function mark(path: string) {
  return (size: number) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden style={{ display: "block" }}>
      <path d={path} />
    </svg>
  );
}

export type IntegrationBrand = {
  id: IntegrationId;
  label: string;
  /** One line under the name: what the integration is for in ADE. */
  tagline: string;
  /** The maker's main color; links, focus rings and chips on the page take it. */
  accent: string;
  /** The banner behind the art, matched to the art's left edge. */
  banner: CSSProperties;
  /** The maker's banner, standing at the right of the hero. */
  art: string;
  /** Dark text on a light banner. */
  lightBanner?: boolean;
  logo: Extract<ProviderBrandLogo, { kind: "solid" }>;
};

const BRANDS: Record<IntegrationId, IntegrationBrand> = {
  github: {
    id: "github",
    label: "GitHub",
    tagline: "Pull requests, reviews, checks and issues for this project's repository.",
    accent: "#2DA44E",
    banner: {
      background: [
        "radial-gradient(60% 120% at 0% 110%, rgba(97, 226, 130, 0.45), transparent 60%)",
        "linear-gradient(90deg, #EFFCFF 0%, #E3FAFF 55%, #D8F8FF 100%)",
      ].join(", "),
    },
    art: githubArt,
    lightBanner: true,
    logo: { kind: "solid", mark: mark(GITHUB_LOGO_PATH), face: "#24292F", side: "#0B0D10", size: 80 },
  },
  linear: {
    id: "linear",
    label: "Linear",
    tagline: "Linear issues in lanes and chats, and an agent your team can assign work to.",
    accent: "#7C86F0",
    banner: {
      background: [
        "radial-gradient(70% 140% at 10% 0%, rgba(255, 255, 255, 0.10), transparent 60%)",
        "linear-gradient(90deg, #252D7C 0%, #2B3590 55%, #303C9A 100%)",
      ].join(", "),
    },
    art: linearArt,
    logo: { kind: "solid", mark: mark(LINEAR_LOGO_PATH), face: "#FFFFFF", side: "#1C2266", size: 76 },
  },
  jira: {
    id: "jira",
    label: "Jira",
    tagline: "Browse, edit and create Jira Cloud issues without leaving ADE.",
    accent: "#2684FF",
    banner: {
      background: [
        "radial-gradient(50% 120% at 0% 100%, rgba(38, 132, 255, 0.16), transparent 60%)",
        "linear-gradient(90deg, #EAFBFF 0%, #E2FAFF 55%, #DFF9FF 100%)",
      ].join(", "),
    },
    art: jiraArt,
    lightBanner: true,
    logo: { kind: "solid", mark: mark(JIRA_LOGO_PATH), face: "#2684FF", side: "#0B3F99", size: 76 },
  },
};

export function integrationBrand(id: IntegrationId): IntegrationBrand {
  return BRANDS[id];
}

/** The page's accent, set on its root so every control below takes it. */
export function integrationThemeVars(brand: IntegrationBrand): CSSProperties {
  return {
    ["--color-accent" as string]: brand.accent,
    ["--color-accent-muted" as string]: `color-mix(in srgb, ${brand.accent} 16%, transparent)`,
    ["--provider-accent" as string]: brand.accent,
    ["--provider-brand" as string]: brand.accent,
    ["--ig-accent" as string]: brand.accent,
  };
}
