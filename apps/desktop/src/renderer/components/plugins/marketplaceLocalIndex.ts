/**
 * The bundled plugin index.
 *
 * ADE's directory lives in a public repository whose index is rebuilt by a
 * scheduled job (design decision D16). That is the right home for it and the
 * wrong thing to depend on at first paint: it is a network fetch, it can be
 * unreachable, and until the registry is populated it has nothing in it. So the
 * official set ships inside the app and the live index is layered on top —
 * `mergeMarketplaceCatalogue` gives directory entries precedence over these for
 * the same id, which means a published entry always wins and this file only
 * ever fills a gap.
 *
 * What is deliberately NOT here: install counts and stars. Those are facts the
 * directory measures, and inventing plausible-looking numbers for the bundled
 * copy would poison the one signal the gallery has. They stay null, the stats
 * column renders nothing, and the popularity sorts push these entries down to
 * the unranked tail — which is exactly where an unmeasured plugin belongs.
 *
 * The manifests below are the real shapes these plugins ship, so the install
 * modal's "Adds" list is derived rather than written by hand. Keeping them in
 * step with the published manifests is a Wave F/E concern; a drift here shows
 * as a wrong "Adds" list, never as a wrong install.
 */

import type { PluginManifest } from "../../../shared/plugins/manifest";
import type { MarketplaceListing } from "./marketplaceModel";
import { surfacesFromManifest } from "./marketplaceModel";

const REGISTRY_ORG = "https://github.com/ade-plugins";

/** Fills the fields every manifest has but most official plugins leave empty. */
function manifest(partial: Partial<PluginManifest> & Pick<PluginManifest,
  "name" | "version" | "displayName" | "description">): PluginManifest {
  return {
    vocabVersion: 1,
    surfaces: [],
    panels: [],
    sockets: [],
    collections: {},
    settings: [],
    cli: [],
    skills: [],
    official: true,
    ...partial,
  };
}

const GRAPH = manifest({
  name: "ade-graph",
  version: "1.0.0",
  displayName: "Graph",
  description: "Lanes, commits and PR overlays on one canvas — as an optional tab.",
  icon: "graph",
  accent: "#7C6FF0",
  // `builtin` is what makes this a gate rather than a page: the tab it names is
  // compiled into the app, and installing or removing the plugin is what puts it
  // in or out of the rail. See `builtinTabs.ts`.
  surfaces: [{ kind: "tab", id: "graph", title: "Graph", icon: "graph", panelId: "main", builtin: "graph" }],
  panels: [{ id: "main", schemaFile: "panels/main.json", title: "Graph" }],
});

const LOG_VIEWER = manifest({
  name: "ade-log-viewer",
  version: "1.0.0",
  displayName: "Log viewer",
  description: "Reads the end of .log and .ndjson files in Files, with levels picked out.",
  icon: "list",
  accent: "#4C9AFF",
  entry: "index.js",
  panels: [{ id: "viewer", schemaFile: "panels/viewer.json", title: "Log" }],
  sockets: [
    {
      socket: "file-viewer",
      surface: "files",
      id: "viewer",
      panelId: "viewer",
      extensions: [".log", ".ndjson"],
    },
  ],
  settings: [
    {
      key: "tailLines",
      kind: "number",
      label: "Lines to show",
      description: "How many of the most recent lines the panel lists. Up to 100.",
      default: 100,
    },
  ],
});

/**
 * The starter themes.
 *
 * Each ships both palettes, because a theme that only defines dark tokens
 * silently reverts half of itself the moment someone switches to light — the
 * failure the engine's two-block stylesheet exists to make visible.
 */
const PAPER = manifest({
  name: "ade-theme-paper",
  version: "1.0.0",
  displayName: "Paper",
  description: "Warm paper and ink, with a clay accent. For working in daylight.",
  icon: "palette",
  accent: "#A05C36",
  theme: {
    tokens: {
      light: {
        "--color-bg": "#F7F3EC",
        "--color-fg": "#23201B",
        "--color-surface": "#FBF8F2",
        "--color-surface-raised": "#FFFFFF",
        "--color-surface-recessed": "#EFE9DE",
        "--color-surface-overlay": "#FFFDF8",
        "--color-card": "#FFFFFF",
        "--color-card-fg": "#23201B",
        "--color-card-rgb": "255, 255, 255",
        "--color-secondary": "#EDE7DC",
        "--color-secondary-fg": "#57503F",
        "--color-muted": "#F0EAE0",
        "--color-muted-fg": "#6B6455",
        "--color-border": "#DED6C8",
        "--color-separator": "#E4DCCE",
        "--color-separator-active": "#A05C36",
        "--color-accent": "#A05C36",
        "--color-accent-fg": "#FFFFFF",
        "--color-accent-muted": "color-mix(in srgb, #A05C36 14%, transparent)",
        "--color-accent-bright": "#C0724A",
        "--color-accent-deep": "#7C4425",
        "--color-glow": "color-mix(in srgb, #A05C36 12%, transparent)",
        "--color-popup-bg": "#FFFDF8",
        "--color-modal-bg": "#FFFFFF",
        "--color-composer-bg": "#FBF7F0",
        "--color-glass-card": "#FBF7F0",
        "--pane-bg": "#FBF8F2",
        "--pane-border": "#DED6C8",
      },
      dark: {
        "--color-bg": "#14110E",
        "--color-fg": "#EFE9DF",
        "--color-surface": "#1A1713",
        "--color-surface-raised": "#201C17",
        "--color-surface-recessed": "#100D0B",
        "--color-surface-overlay": "#201C17",
        "--color-card": "#201C17",
        "--color-card-fg": "#EFE9DF",
        "--color-card-rgb": "32, 28, 23",
        "--color-secondary": "#272219",
        "--color-secondary-fg": "#B6AC9C",
        "--color-muted": "#1D1915",
        "--color-muted-fg": "#9A9081",
        "--color-border": "#2E2820",
        "--color-separator": "#2E2820",
        "--color-separator-active": "#C98A5E",
        "--color-accent": "#C98A5E",
        "--color-accent-fg": "#14110E",
        "--color-accent-muted": "color-mix(in srgb, #C98A5E 20%, transparent)",
        "--color-accent-bright": "#E0A87D",
        "--color-accent-deep": "#8E5B34",
        "--color-glow": "color-mix(in srgb, #C98A5E 18%, transparent)",
        "--color-popup-bg": "#1B1712",
        "--color-modal-bg": "#201C17",
        "--color-composer-bg": "#191510",
        "--color-glass-card": "#191510",
        "--pane-bg": "#1A1713",
        "--pane-border": "#2E2820",
      },
    },
  },
});

const INK = manifest({
  name: "ade-theme-ink",
  version: "1.0.0",
  displayName: "Ink",
  description: "Deep blue-black with a steel accent. Quiet under long sessions.",
  icon: "palette",
  accent: "#6FA8C7",
  theme: {
    tokens: {
      dark: {
        "--color-bg": "#0B0E13",
        "--color-fg": "#E6EAF0",
        "--color-surface": "#11151C",
        "--color-surface-raised": "#161B24",
        "--color-surface-recessed": "#080A0E",
        "--color-surface-overlay": "#161B24",
        "--color-card": "#161B24",
        "--color-card-fg": "#E6EAF0",
        "--color-card-rgb": "22, 27, 36",
        "--color-secondary": "#1C222C",
        "--color-secondary-fg": "#A9B3C0",
        "--color-muted": "#141922",
        "--color-muted-fg": "#8C97A6",
        "--color-border": "#232A35",
        "--color-separator": "#232A35",
        "--color-separator-active": "#6FA8C7",
        "--color-accent": "#6FA8C7",
        "--color-accent-fg": "#0B0E13",
        "--color-accent-muted": "color-mix(in srgb, #6FA8C7 20%, transparent)",
        "--color-accent-bright": "#93C4DE",
        "--color-accent-deep": "#3E7695",
        "--color-glow": "color-mix(in srgb, #6FA8C7 18%, transparent)",
        "--color-popup-bg": "#121721",
        "--color-modal-bg": "#161B24",
        "--color-composer-bg": "#0F131A",
        "--color-glass-card": "#0F131A",
        "--pane-bg": "#11151C",
        "--pane-border": "#232A35",
      },
      light: {
        "--color-bg": "#F2F4F7",
        "--color-fg": "#161B24",
        "--color-surface": "#F8F9FB",
        "--color-surface-raised": "#FFFFFF",
        "--color-surface-recessed": "#E8EBF0",
        "--color-surface-overlay": "#FFFFFF",
        "--color-card": "#FFFFFF",
        "--color-card-fg": "#161B24",
        "--color-card-rgb": "255, 255, 255",
        "--color-secondary": "#E5E9EF",
        "--color-secondary-fg": "#4A5462",
        "--color-muted": "#EBEEF3",
        "--color-muted-fg": "#5C6673",
        "--color-border": "#D3D9E1",
        "--color-separator": "#DFE3EA",
        "--color-separator-active": "#2E6C8E",
        "--color-accent": "#2E6C8E",
        "--color-accent-fg": "#FFFFFF",
        "--color-accent-muted": "color-mix(in srgb, #2E6C8E 14%, transparent)",
        "--color-accent-bright": "#4A88AA",
        "--color-accent-deep": "#1F4E68",
        "--color-glow": "color-mix(in srgb, #2E6C8E 12%, transparent)",
        "--color-popup-bg": "#FFFFFF",
        "--color-modal-bg": "#FFFFFF",
        "--color-composer-bg": "#F6F8FA",
        "--color-glass-card": "#F6F8FA",
        "--pane-bg": "#F8F9FB",
        "--pane-border": "#D3D9E1",
      },
    },
  },
});

const CONTRAST = manifest({
  name: "ade-theme-contrast",
  version: "1.0.0",
  displayName: "High contrast",
  description: "Maximum separation between text, edges and background. For bad light and tired eyes.",
  icon: "palette",
  accent: "#FFD54A",
  theme: {
    tokens: {
      dark: {
        "--color-bg": "#000000",
        "--color-fg": "#FFFFFF",
        "--color-surface": "#000000",
        "--color-surface-raised": "#101010",
        "--color-surface-recessed": "#000000",
        "--color-surface-overlay": "#101010",
        "--color-card": "#0A0A0A",
        "--color-card-fg": "#FFFFFF",
        "--color-card-rgb": "10, 10, 10",
        "--color-secondary": "#1A1A1A",
        "--color-secondary-fg": "#F2F2F2",
        "--color-muted": "#141414",
        "--color-muted-fg": "#D6D6D6",
        "--color-border": "#8A8A8A",
        "--color-separator": "#6E6E6E",
        "--color-separator-active": "#FFD54A",
        "--color-accent": "#FFD54A",
        "--color-accent-fg": "#000000",
        "--color-accent-muted": "color-mix(in srgb, #FFD54A 26%, transparent)",
        "--color-accent-bright": "#FFE685",
        "--color-accent-deep": "#C9A32E",
        "--color-glow": "color-mix(in srgb, #FFD54A 22%, transparent)",
        "--color-popup-bg": "#0A0A0A",
        "--color-modal-bg": "#0A0A0A",
        "--color-composer-bg": "#0A0A0A",
        "--color-glass-card": "#0A0A0A",
        "--color-success": "#5BE38A",
        "--color-warning": "#FFB020",
        "--color-error": "#FF7A7A",
        "--color-info": "#7FC4FF",
        "--pane-bg": "#000000",
        "--pane-border": "#8A8A8A",
      },
      light: {
        "--color-bg": "#FFFFFF",
        "--color-fg": "#000000",
        "--color-surface": "#FFFFFF",
        "--color-surface-raised": "#FFFFFF",
        "--color-surface-recessed": "#F0F0F0",
        "--color-surface-overlay": "#FFFFFF",
        "--color-card": "#FFFFFF",
        "--color-card-fg": "#000000",
        "--color-card-rgb": "255, 255, 255",
        "--color-secondary": "#EBEBEB",
        "--color-secondary-fg": "#141414",
        "--color-muted": "#F2F2F2",
        "--color-muted-fg": "#2E2E2E",
        "--color-border": "#4A4A4A",
        "--color-separator": "#6E6E6E",
        "--color-separator-active": "#0B4FD0",
        "--color-accent": "#0B4FD0",
        "--color-accent-fg": "#FFFFFF",
        "--color-accent-muted": "color-mix(in srgb, #0B4FD0 16%, transparent)",
        "--color-accent-bright": "#2A6BE8",
        "--color-accent-deep": "#07379A",
        "--color-glow": "color-mix(in srgb, #0B4FD0 14%, transparent)",
        "--color-popup-bg": "#FFFFFF",
        "--color-modal-bg": "#FFFFFF",
        "--color-composer-bg": "#FFFFFF",
        "--color-glass-card": "#FFFFFF",
        "--color-success": "#0A7A34",
        "--color-warning": "#8A5200",
        "--color-error": "#B3001B",
        "--color-info": "#0B4FD0",
        "--pane-bg": "#FFFFFF",
        "--pane-border": "#4A4A4A",
      },
    },
  },
});

function listing(
  source: PluginManifest,
  extra: { author: string; featured?: boolean; readme: string },
): MarketplaceListing {
  return {
    pluginId: source.name,
    displayName: source.displayName,
    author: extra.author,
    description: source.description,
    version: source.version,
    icon: source.icon ?? null,
    accent: source.accent ?? null,
    official: true,
    featured: extra.featured === true,
    isTheme: source.theme !== undefined,
    installs: null,
    stars: null,
    publishedAt: null,
    // The install source is the plugin ID, not a URL. These packages ship inside
    // the app, so the install resolves against what ADE already bundles and
    // records itself as a builtin — which is also the only way back after
    // someone removes one. The repository links below are display only; that
    // organisation is planned, not published, and sending its URL here made
    // every bundled install fail against a repository that does not exist.
    source: source.name,
    changelogUrl: `${REGISTRY_ORG}/${source.name}/releases`,
    readme: extra.readme,
    manifest: source,
    addsSummary: [],
    surfaces: surfacesFromManifest(source),
    themeTokens: source.theme?.tokens ?? null,
    origin: "bundled",
  };
}

/**
 * The official set, as shipped. Ordering here is irrelevant — the gallery sorts
 * — but the featured flags are the curated hero row and are deliberately few.
 */
export const MARKETPLACE_LOCAL_INDEX: readonly MarketplaceListing[] = [
  listing(GRAPH, {
    author: "ADE",
    featured: true,
    readme: [
      "## Graph",
      "",
      "Lanes, commits, PR overlays, conflict risk and sync presence, drawn on one",
      "canvas. Selecting a node opens that lane.",
      "",
      "Graph was part of ADE itself until plugins existed. Nothing about it changed —",
      "it stopped being something everyone has to carry. Install it and the Graph tab",
      "is in your rail; remove it and the rail is one item shorter.",
      "",
      "### Notes",
      "",
      "- The canvas is drawn by the desktop app rather than published as a panel, so",
      "  on a phone or in the terminal the plugin shows a card pointing at the machine",
      "  that holds the repository.",
      "- The `/graph` route keeps working even with the tab hidden, so links minted",
      "  before you removed it still open.",
    ].join("\n"),
  }),
  listing(LOG_VIEWER, {
    author: "ADE",
    featured: true,
    readme: [
      "## Log viewer",
      "",
      "Opens `.log` and `.ndjson` files in the Files tab as lines rather than as a",
      "wall of text: levels are picked out, errors and warnings are counted, and you",
      "can filter to one level without leaving the file.",
      "",
      "### How it reads",
      "",
      "Logs get large, so it reads the last 128 KiB of a file rather than the whole",
      "thing, and only when you press Load. The panel says which part it read and how",
      "big the file actually is, so a truncated view never looks like a complete one.",
      "",
      "Reading goes through ADE's own file action on the machine that holds the file,",
      "and the parsing happens there too — what reaches your screen is the rows.",
      "",
      "### Settings",
      "",
      "- **Lines to show** — how many of the most recent lines the panel lists, up to",
      "  100.",
    ].join("\n"),
  }),
  listing(PAPER, {
    author: "ADE",
    featured: true,
    readme: [
      "## Paper",
      "",
      "Warm paper and ink, with a clay accent — the palette of something printed",
      "rather than something emitted. Made for working in daylight, where ADE's",
      "default dark surfaces go flat.",
      "",
      "Ships both a light and a dark set, so switching between them keeps the theme.",
    ].join("\n"),
  }),
  listing(INK, {
    author: "ADE",
    readme: [
      "## Ink",
      "",
      "Deep blue-black with a steel accent. Lower saturation than the default palette",
      "and no violet, for people who spend the whole day in one window and want the",
      "interface to stop asking for attention.",
    ].join("\n"),
  }),
  listing(CONTRAST, {
    author: "ADE",
    readme: [
      "## High contrast",
      "",
      "Black on white and white on black, with edges you can actually see: borders",
      "and separators are raised well above ADE's default whisper, and muted text",
      "stops being muted. For bad light, glare, and eyes at the end of a long day.",
      "",
      "Coverage is as good as ADE's own design tokens — surfaces that still carry",
      "hard-coded colours are unchanged by any theme, this one included.",
    ].join("\n"),
  }),
];
