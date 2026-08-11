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
  name: "graph",
  version: "1.0.0",
  displayName: "Graph",
  description: "The lane and commit graph, as its own tab.",
  icon: "graph",
  accent: "#7C6FF0",
  entry: "index.js",
  surfaces: [{ kind: "tab", id: "graph", title: "Graph", panelId: "main" }],
  panels: [{ id: "main", schemaFile: "panels/main.json" }],
  sockets: [
    { socket: "row-menu-item", surface: "lanes", id: "show-in-graph", label: "Show in graph", actionId: "reveal" },
  ],
  collections: { nodes: { sync: false } },
  settings: [
    { key: "depth", kind: "number", label: "Commits to draw", default: 200 },
  ],
  cli: ["show"],
});

const HISTORY = manifest({
  name: "history",
  version: "1.0.0",
  displayName: "History",
  description: "Every prompt you have sent, searchable across lanes.",
  icon: "clock",
  accent: "#4C9AFF",
  entry: "index.js",
  surfaces: [{ kind: "tab", id: "history", title: "History", panelId: "main" }],
  panels: [{ id: "main", schemaFile: "panels/main.json" }],
  sockets: [
    { socket: "toolbar-action", surface: "work", id: "open-history", label: "History", icon: "clock", actionId: "open" },
  ],
  collections: { prompts: { sync: true } },
  cli: ["search"],
  skills: ["skills/searching-history"],
});

const VIDEO_VIEWER = manifest({
  name: "video-viewer",
  version: "1.0.0",
  displayName: "Video viewer",
  description: "Plays video files in the Files tab instead of downloading them.",
  icon: "video",
  accent: "#E06C9F",
  entry: "index.js",
  panels: [{ id: "player", schemaFile: "panels/player.json" }],
  sockets: [
    {
      socket: "file-viewer",
      surface: "files",
      id: "player",
      panelId: "player",
      extensions: [".mp4", ".mov", ".webm", ".m4v"],
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
const SLATE = manifest({
  name: "slate-theme",
  version: "1.0.0",
  displayName: "Slate",
  description: "Cooler greys and a steel accent. Quiet under long sessions.",
  icon: "palette",
  accent: "#5E8AA8",
  theme: {
    tokens: {
      dark: {
        "--color-accent": "#5E8AA8",
        "--color-accent-muted": "color-mix(in srgb, #5E8AA8 22%, transparent)",
        "--color-bg": "#0E1114",
        "--color-card": "#151A1F",
        "--color-border": "#232A31",
      },
      light: {
        "--color-accent": "#3F6C8A",
        "--color-accent-muted": "color-mix(in srgb, #3F6C8A 16%, transparent)",
        "--color-bg": "#F5F7F9",
        "--color-card": "#FFFFFF",
        "--color-border": "#DDE3E8",
      },
    },
  },
});

const EMBER = manifest({
  name: "ember-theme",
  version: "1.0.0",
  displayName: "Ember",
  description: "Warm neutrals with an amber accent.",
  icon: "palette",
  accent: "#D98A4B",
  theme: {
    tokens: {
      dark: {
        "--color-accent": "#D98A4B",
        "--color-accent-muted": "color-mix(in srgb, #D98A4B 20%, transparent)",
        "--color-bg": "#14100D",
        "--color-card": "#1D1815",
        "--color-border": "#2E2622",
      },
      light: {
        "--color-accent": "#B96C2E",
        "--color-accent-muted": "color-mix(in srgb, #B96C2E 15%, transparent)",
        "--color-bg": "#FAF6F2",
        "--color-card": "#FFFFFF",
        "--color-border": "#E7DED6",
      },
    },
  },
});

const PAPER = manifest({
  name: "paper-theme",
  version: "1.0.0",
  displayName: "Paper",
  description: "A high-contrast light palette for bright rooms.",
  icon: "palette",
  accent: "#2F6F5B",
  theme: {
    tokens: {
      dark: {
        "--color-accent": "#4E9C82",
        "--color-accent-muted": "color-mix(in srgb, #4E9C82 20%, transparent)",
        "--color-bg": "#101312",
        "--color-card": "#181C1A",
        "--color-border": "#252B28",
      },
      light: {
        "--color-accent": "#2F6F5B",
        "--color-accent-muted": "color-mix(in srgb, #2F6F5B 14%, transparent)",
        "--color-bg": "#FBFBF8",
        "--color-card": "#FFFFFF",
        "--color-border": "#E2E2DA",
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
    source: `${REGISTRY_ORG}/${source.name}`,
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
      "Draws your lanes and their commits as a graph, so a stack of branches reads",
      "as a shape rather than a list. Selecting a node opens that lane.",
      "",
      "Graph was part of ADE itself until plugins existed. Nothing about it changed —",
      "it simply stopped being something everyone had to carry.",
      "",
      "### Settings",
      "",
      "- **Commits to draw** — how far back the graph reaches. Larger values cost",
      "  render time on very old repositories.",
    ].join("\n"),
  }),
  listing(HISTORY, {
    author: "ADE",
    featured: true,
    readme: [
      "## History",
      "",
      "Keeps every prompt you have sent, across every lane and machine, and makes",
      "it searchable. Use it to find the phrasing that worked and send it again.",
      "",
      "Prompts sync to your other devices. They are stored in your own ADE database",
      "and never leave it.",
    ].join("\n"),
  }),
  listing(VIDEO_VIEWER, {
    author: "ADE",
    featured: true,
    readme: [
      "## Video viewer",
      "",
      "Adds a player to the Files tab for `.mp4`, `.mov`, `.webm` and `.m4v`, so a",
      "recorded run or a screen capture opens where you found it.",
      "",
      "Files stream from the machine that holds them; nothing is copied anywhere.",
    ].join("\n"),
  }),
  listing(SLATE, {
    author: "ADE",
    readme: [
      "## Slate",
      "",
      "Cooler greys and a steel accent, for people who find the default palette warm.",
      "Ships both a dark and a light set — the theme layers over whichever you have",
      "chosen rather than replacing it.",
    ].join("\n"),
  }),
  listing(EMBER, {
    author: "ADE",
    readme: [
      "## Ember",
      "",
      "Warm neutrals with an amber accent. Pairs with the dark palette; the light set",
      "keeps the same accent at a higher contrast.",
    ].join("\n"),
  }),
  listing(PAPER, {
    author: "ADE",
    readme: [
      "## Paper",
      "",
      "A high-contrast light palette for bright rooms. The dark set is included so",
      "switching back at night does not drop the theme.",
    ].join("\n"),
  }),
];
