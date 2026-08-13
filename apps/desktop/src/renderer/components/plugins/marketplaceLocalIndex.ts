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

/**
 * Where the official packages are published.
 *
 * One constant, never spelled out at a call site: the organisation moved once
 * already (from `ade-plugins` to `arul28`, which is where the directory
 * repository actually lives), and the only reason that rename was a one-line
 * change is that nothing below knows the org exists. Every official plugin's
 * repository is `${REGISTRY_ORG}/<pluginId>`.
 */
const REGISTRY_ORG = "https://github.com/arul28";

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
  version: "1.0.1",
  displayName: "Graph",
  description: "Lanes, commits and PR overlays on one canvas — as an optional tab.",
  icon: "graph",
  accent: "#6366F1",
  // `builtin` is what makes this a gate rather than a page: the tab it names is
  // compiled into the app, and installing or removing the plugin is what puts it
  // in or out of the rail. See `builtinTabs.ts`.
  surfaces: [{ kind: "tab", id: "graph", title: "Graph", icon: "graph", panelId: "main", builtin: "graph", mobile: false }],
  panels: [{ id: "main", schemaFile: "panels/main.json", title: "Graph" }],
});

/**
 * The rest of the compiled surfaces, as gates.
 *
 * Same shape as GRAPH and for the same reason: none of these draws anything
 * from its manifest. Review is a diff reader, History is an event timeline,
 * Linear talks to an API, the simulator and app panes own native processes —
 * none of that is expressible as vocabulary, and rewriting them as panels to
 * make them "real" plugins would have been a rewrite of working code for no
 * gain. What the manifest buys is the choice: installed, the surface is there;
 * removed, every entry point for it goes with it.
 *
 * The `builtin` id is the contract, not the surface `id`: `ade-ios-sim`
 * publishes surface id `ios-sim` but gates the compiled `ios` pane, and the
 * two being spelled differently is exactly why the compiled side keys off
 * `builtin` and never off the surface id. These mirror `plugins/<id>/plugin.json`
 * field for field — a drift here shows as a wrong "Adds" list in the install
 * modal, never as a wrong install.
 */
const REVIEW = manifest({
  name: "ade-review",
  version: "1.0.1",
  displayName: "Review",
  description: "AI review passes over your project and pull requests — as an optional tab.",
  icon: "git-pull-request",
  accent: "#22A06B",
  surfaces: [{ kind: "tab", id: "review", title: "Review", icon: "git-pull-request", panelId: "main", builtin: "review", mobile: false }],
  panels: [{ id: "main", schemaFile: "panels/main.json", title: "Review" }],
});

const HISTORY = manifest({
  name: "ade-history",
  version: "1.0.1",
  displayName: "History",
  description: "Commits, lane operations and captured artifacts — as an optional tab.",
  icon: "clock-counter-clockwise",
  accent: "#E0932F",
  surfaces: [{ kind: "tab", id: "history", title: "History", icon: "clock-counter-clockwise", panelId: "main", builtin: "history", mobile: false }],
  panels: [{ id: "main", schemaFile: "panels/main.json", title: "History" }],
});

const LINEAR = manifest({
  name: "ade-linear",
  version: "1.0.1",
  displayName: "Linear",
  description: "Open and browse Linear issues without leaving ADE.",
  icon: "list-checks",
  accent: "#5E6AD2",
  surfaces: [{ kind: "pane", id: "linear", title: "Linear", icon: "list-checks", panelId: "main", builtin: "linear", mobile: true }],
  panels: [{ id: "main", schemaFile: "panels/main.json", title: "Linear" }],
});

const IOS_SIM = manifest({
  name: "ade-ios-sim",
  version: "1.0.1",
  displayName: "iOS Simulator",
  description: "Drive an iOS Simulator from the Work tools, on a Mac.",
  icon: "device-mobile",
  accent: "#8A8F98",
  surfaces: [{ kind: "pane", id: "ios-sim", title: "iOS Simulator", icon: "device-mobile", panelId: "main", builtin: "ios", mobile: false }],
  panels: [{ id: "main", schemaFile: "panels/main.json", title: "iOS Simulator" }],
});

const APP_CONTROL = manifest({
  name: "ade-app-control",
  version: "1.0.1",
  displayName: "Electron Control",
  description: "Drive and inspect Electron apps from the Work tools.",
  icon: "desktop",
  accent: "#47848F",
  surfaces: [{ kind: "pane", id: "app-control", title: "Electron Control", icon: "desktop", panelId: "main", builtin: "app-control", mobile: false }],
  panels: [{ id: "main", schemaFile: "panels/main.json", title: "Electron Control" }],
});

const LOG_VIEWER = manifest({
  name: "ade-log-viewer",
  version: "1.0.1",
  displayName: "Log viewer",
  description: "Reads the end of .log and .ndjson files in Files, with levels picked out.",
  icon: "rows",
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
 * Voice, which gates nothing.
 *
 * The other entries above are gates: a compiled surface that appears when the
 * plugin is installed. This one is the opposite demonstration, and it is worth
 * being explicit about because it is the more important of the two. Dictation
 * is a `composer-action` socket, a `captureClip` SDK call and an
 * `{composer:{insertText}}` response — three public primitives, no `builtin`
 * binding, nothing an author outside this repository could not have written.
 * If that ever stops being true, the extraction it proves has regressed.
 */
const VOICE = manifest({
  name: "ade-voice",
  version: "1.0.0",
  displayName: "Voice",
  description: "Voice dictation for the composer, on-device. Downloads a 141 MB speech model on first use.",
  icon: "microphone",
  accent: "#C2508B",
  entry: "index.js",
  panels: [{ id: "main", schemaFile: "panels/main.json", title: "Voice" }],
  sockets: [
    {
      socket: "composer-action",
      surface: "work",
      id: "dictate",
      label: "Dictate",
      icon: "microphone",
      actionId: "dictate",
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
  version: "1.0.1",
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
        "--color-card-solid": "#FFFFFF",
        "--pane-bg": "#FBF8F2",
        "--pane-border": "#DED6C8",
        "--chat-canvas-bg": "#F5F0E6",

        "--shell-header-bg": "#EFE8DA",
        "--shell-header-fg": "#23201B",
        "--shell-header-border": "#D8CDB9",
        "--shell-header-divider": "#DED4C2",
        "--shell-surface": "#FFFDF8",

        "--shell-sidebar-bg": "linear-gradient(180deg, #F4EEE3 0%, #E8DFCE 100%)",
        "--shell-sidebar-border": "#D8CDB9",
        "--shell-sidebar-separator": "#DED4C2",
        "--shell-sidebar-item-fg": "#7A7263",
        "--shell-sidebar-item-hover-fg": "#23201B",
        "--shell-sidebar-item-hover-bg": "color-mix(in srgb, #A05C36 10%, transparent)",
        "--shell-sidebar-item-active-fg": "#7C4425",
        "--shell-sidebar-item-active-bg": "color-mix(in srgb, #A05C36 18%, transparent)",
        "--shell-sidebar-item-active-rail": "#A05C36",

        "--shell-project-tab-fg": "#7A7263",
        "--shell-project-tab-hover-fg": "#23201B",
        "--shell-project-tab-hover-bg": "color-mix(in srgb, #A05C36 10%, transparent)",
        "--shell-project-tab-hover-border": "color-mix(in srgb, #A05C36 30%, transparent)",

        "--shell-control-bg": "#FBF7F0",
        "--shell-control-fg": "#6B6455",
        "--shell-control-border": "#D8CDB9",
        "--shell-control-hover-bg": "#FFFFFF",
        "--shell-control-hover-fg": "#23201B",
        "--shell-control-hover-border": "color-mix(in srgb, #A05C36 40%, transparent)",
        "--shell-control-open-bg": "color-mix(in srgb, #A05C36 14%, #FBF7F0)",
        "--shell-control-open-fg": "#23201B",
        "--shell-control-open-border": "color-mix(in srgb, #A05C36 46%, transparent)",
        "--shell-control-kbd-bg": "#EFE8DA",
        "--shell-control-kbd-fg": "#8A8172",

        "--shell-status-running": "#4F7A46",
        "--shell-status-attention": "#B0761C",
        "--shell-attention-fg": "#8A5A12",
        "--shell-attention-edge": "#C08A2A",
        "--shell-pressure-1": "#B0761C",
        "--shell-pressure-2": "#B05F22",
        "--shell-pressure-3": "#A8452F",
        "--shell-pressure-4": "#93302B",

        "--work-sidebar-bg": "#F1EADE",
        "--work-session-sidebar-bg": "#EDE5D6",
        "--work-pane-border": "#DED4C2",
        "--work-pane-header-bg": "color-mix(in srgb, #A05C36 6%, transparent)",
        "--work-popover-bg": "#FFFDF8",
        "--work-popover-border": "#DED4C2",

        "--work-rail-terminal": "#8E5F3C",
        "--work-rail-git": "#4F7A46",
        "--work-rail-files": "#A8791F",
        "--work-rail-ios": "#3F6E85",
        "--work-rail-app-control": "#7C4F70",
        "--work-rail-browser": "#2F7368",
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
        "--color-card-solid": "#201C17",
        "--pane-bg": "#1A1713",
        "--pane-border": "#2E2820",
        "--chat-canvas-bg": "#171310",

        "--shell-header-bg": "#1C1813",
        "--shell-header-fg": "#EFE9DF",
        "--shell-header-border": "#332B22",
        "--shell-header-divider": "#2E2820",
        "--shell-surface": "#1B1712",

        "--shell-sidebar-bg": "linear-gradient(180deg, #201C17 0%, #14110E 100%)",
        "--shell-sidebar-border": "#332B22",
        "--shell-sidebar-separator": "#2E2820",
        "--shell-sidebar-item-fg": "#9A9081",
        "--shell-sidebar-item-hover-fg": "#EFE9DF",
        "--shell-sidebar-item-hover-bg": "color-mix(in srgb, #C98A5E 12%, transparent)",
        "--shell-sidebar-item-active-fg": "#E0A87D",
        "--shell-sidebar-item-active-bg": "color-mix(in srgb, #C98A5E 18%, transparent)",
        "--shell-sidebar-item-active-rail": "#C98A5E",

        "--shell-project-tab-fg": "#9A9081",
        "--shell-project-tab-hover-fg": "#EFE9DF",
        "--shell-project-tab-hover-bg": "color-mix(in srgb, #C98A5E 12%, transparent)",
        "--shell-project-tab-hover-border": "color-mix(in srgb, #C98A5E 28%, transparent)",

        "--shell-control-bg": "color-mix(in srgb, #C98A5E 7%, transparent)",
        "--shell-control-fg": "#B6AC9C",
        "--shell-control-border": "#332B22",
        "--shell-control-hover-bg": "color-mix(in srgb, #C98A5E 14%, transparent)",
        "--shell-control-hover-fg": "#EFE9DF",
        "--shell-control-hover-border": "color-mix(in srgb, #C98A5E 34%, transparent)",
        "--shell-control-open-bg": "color-mix(in srgb, #C98A5E 20%, transparent)",
        "--shell-control-open-fg": "#F6F1E8",
        "--shell-control-open-border": "color-mix(in srgb, #C98A5E 44%, transparent)",
        "--shell-control-kbd-bg": "#241F19",
        "--shell-control-kbd-fg": "#8E8578",

        "--shell-status-running": "#8FBF7A",
        "--shell-status-attention": "#E0A87D",
        "--shell-attention-fg": "#E8B98C",
        "--shell-attention-edge": "#C98A5E",
        "--shell-pressure-1": "#D9A05E",
        "--shell-pressure-2": "#D08350",
        "--shell-pressure-3": "#C56A50",
        "--shell-pressure-4": "#BE5450",

        "--work-sidebar-bg": "#1A1612",
        "--work-session-sidebar-bg": "#151210",
        "--work-pane-border": "color-mix(in srgb, #C98A5E 14%, transparent)",
        "--work-pane-header-bg": "color-mix(in srgb, #C98A5E 7%, transparent)",
        "--work-popover-bg": "#1F1B16",
        "--work-popover-border": "#3A3128",

        "--work-rail-terminal": "#D6A277",
        "--work-rail-git": "#8FBF7A",
        "--work-rail-files": "#D9B45E",
        "--work-rail-ios": "#7FA8BE",
        "--work-rail-app-control": "#BE8FB4",
        "--work-rail-browser": "#6FBDAF",
      },
    },
  },
});

const INK = manifest({
  name: "ade-theme-ink",
  version: "1.0.1",
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
        "--color-card-solid": "#161B24",
        "--pane-bg": "#11151C",
        "--pane-border": "#232A35",
        "--chat-canvas-bg": "#0E1219",

        "--shell-header-bg": "#0E131B",
        "--shell-header-fg": "#E6EAF0",
        "--shell-header-border": "#28313D",
        "--shell-header-divider": "#232A35",
        "--shell-surface": "#121721",

        "--shell-sidebar-bg": "linear-gradient(180deg, #161B24 0%, #0B0E13 100%)",
        "--shell-sidebar-border": "#28313D",
        "--shell-sidebar-separator": "#232A35",
        "--shell-sidebar-item-fg": "#8C97A6",
        "--shell-sidebar-item-hover-fg": "#E6EAF0",
        "--shell-sidebar-item-hover-bg": "color-mix(in srgb, #6FA8C7 12%, transparent)",
        "--shell-sidebar-item-active-fg": "#93C4DE",
        "--shell-sidebar-item-active-bg": "color-mix(in srgb, #6FA8C7 18%, transparent)",
        "--shell-sidebar-item-active-rail": "#6FA8C7",

        "--shell-project-tab-fg": "#8C97A6",
        "--shell-project-tab-hover-fg": "#E6EAF0",
        "--shell-project-tab-hover-bg": "color-mix(in srgb, #6FA8C7 12%, transparent)",
        "--shell-project-tab-hover-border": "color-mix(in srgb, #6FA8C7 28%, transparent)",

        "--shell-control-bg": "color-mix(in srgb, #6FA8C7 7%, transparent)",
        "--shell-control-fg": "#A9B3C0",
        "--shell-control-border": "#28313D",
        "--shell-control-hover-bg": "color-mix(in srgb, #6FA8C7 14%, transparent)",
        "--shell-control-hover-fg": "#E6EAF0",
        "--shell-control-hover-border": "color-mix(in srgb, #6FA8C7 34%, transparent)",
        "--shell-control-open-bg": "color-mix(in srgb, #6FA8C7 20%, transparent)",
        "--shell-control-open-fg": "#F1F5FA",
        "--shell-control-open-border": "color-mix(in srgb, #6FA8C7 44%, transparent)",
        "--shell-control-kbd-bg": "#181E28",
        "--shell-control-kbd-fg": "#7F8A99",

        "--shell-status-running": "#5EC8B0",
        "--shell-status-attention": "#E2B457",
        "--shell-attention-fg": "#E7C273",
        "--shell-attention-edge": "#C79A3E",
        "--shell-pressure-1": "#D9B45E",
        "--shell-pressure-2": "#D2905C",
        "--shell-pressure-3": "#C97F8E",
        "--shell-pressure-4": "#C96A6A",

        "--work-sidebar-bg": "#10141B",
        "--work-session-sidebar-bg": "#0C1016",
        "--work-pane-border": "color-mix(in srgb, #6FA8C7 14%, transparent)",
        "--work-pane-header-bg": "color-mix(in srgb, #6FA8C7 7%, transparent)",
        "--work-popover-bg": "#141A24",
        "--work-popover-border": "#2C3541",

        "--work-rail-terminal": "#9FB6D6",
        "--work-rail-git": "#5EBFA2",
        "--work-rail-files": "#C2A96B",
        "--work-rail-ios": "#6E9BE0",
        "--work-rail-app-control": "#A98FD6",
        "--work-rail-browser": "#5FC0D0",
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
        "--color-card-solid": "#FFFFFF",
        "--pane-bg": "#F8F9FB",
        "--pane-border": "#D3D9E1",
        "--chat-canvas-bg": "#EEF1F5",

        "--shell-header-bg": "#E9EDF3",
        "--shell-header-fg": "#161B24",
        "--shell-header-border": "#CBD3DD",
        "--shell-header-divider": "#D8DEE7",
        "--shell-surface": "#FFFFFF",

        "--shell-sidebar-bg": "linear-gradient(180deg, #F0F3F7 0%, #E3E8EF 100%)",
        "--shell-sidebar-border": "#CBD3DD",
        "--shell-sidebar-separator": "#D8DEE7",
        "--shell-sidebar-item-fg": "#5C6673",
        "--shell-sidebar-item-hover-fg": "#161B24",
        "--shell-sidebar-item-hover-bg": "color-mix(in srgb, #2E6C8E 10%, transparent)",
        "--shell-sidebar-item-active-fg": "#1F4E68",
        "--shell-sidebar-item-active-bg": "color-mix(in srgb, #2E6C8E 16%, transparent)",
        "--shell-sidebar-item-active-rail": "#2E6C8E",

        "--shell-project-tab-fg": "#5C6673",
        "--shell-project-tab-hover-fg": "#161B24",
        "--shell-project-tab-hover-bg": "color-mix(in srgb, #2E6C8E 10%, transparent)",
        "--shell-project-tab-hover-border": "color-mix(in srgb, #2E6C8E 30%, transparent)",

        "--shell-control-bg": "#F6F8FA",
        "--shell-control-fg": "#4A5462",
        "--shell-control-border": "#CBD3DD",
        "--shell-control-hover-bg": "#FFFFFF",
        "--shell-control-hover-fg": "#161B24",
        "--shell-control-hover-border": "color-mix(in srgb, #2E6C8E 40%, transparent)",
        "--shell-control-open-bg": "color-mix(in srgb, #2E6C8E 12%, #F6F8FA)",
        "--shell-control-open-fg": "#161B24",
        "--shell-control-open-border": "color-mix(in srgb, #2E6C8E 46%, transparent)",
        "--shell-control-kbd-bg": "#E9EDF3",
        "--shell-control-kbd-fg": "#6B7583",

        "--shell-status-running": "#0F7A66",
        "--shell-status-attention": "#8A6210",
        "--shell-attention-fg": "#7A5610",
        "--shell-attention-edge": "#B08A2A",
        "--shell-pressure-1": "#8A6210",
        "--shell-pressure-2": "#9A5320",
        "--shell-pressure-3": "#A03A4E",
        "--shell-pressure-4": "#9A2130",

        "--work-sidebar-bg": "#EDF0F5",
        "--work-session-sidebar-bg": "#E7EBF2",
        "--work-pane-border": "#D3D9E1",
        "--work-pane-header-bg": "color-mix(in srgb, #2E6C8E 6%, transparent)",
        "--work-popover-bg": "#FFFFFF",
        "--work-popover-border": "#D3D9E1",

        "--work-rail-terminal": "#3F5E8C",
        "--work-rail-git": "#0F7A66",
        "--work-rail-files": "#8A6210",
        "--work-rail-ios": "#2E6C8E",
        "--work-rail-app-control": "#6B4C9A",
        "--work-rail-browser": "#0E6E80",
      },
    },
  },
});

const CONTRAST = manifest({
  name: "ade-theme-contrast",
  version: "1.0.1",
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
        "--color-card-solid": "#000000",
        "--pane-bg": "#000000",
        "--pane-border": "#8A8A8A",
        "--chat-canvas-bg": "#000000",

        "--shell-header-bg": "#000000",
        "--shell-header-fg": "#FFFFFF",
        "--shell-header-border": "#FFFFFF",
        "--shell-header-divider": "#8A8A8A",
        "--shell-surface": "#000000",

        "--shell-sidebar-bg": "#000000",
        "--shell-sidebar-border": "#FFFFFF",
        "--shell-sidebar-separator": "#8A8A8A",
        "--shell-sidebar-item-fg": "#D6D6D6",
        "--shell-sidebar-item-hover-fg": "#000000",
        "--shell-sidebar-item-hover-bg": "#FFFFFF",
        "--shell-sidebar-item-active-fg": "#000000",
        "--shell-sidebar-item-active-bg": "#FFD54A",
        "--shell-sidebar-item-active-rail": "#FFD54A",

        "--shell-project-tab-fg": "#D6D6D6",
        "--shell-project-tab-hover-fg": "#000000",
        "--shell-project-tab-hover-bg": "#FFFFFF",
        "--shell-project-tab-hover-border": "#FFFFFF",
        "--shell-project-tab-active-fg": "#000000",
        "--shell-project-tab-active-bg": "#FFD54A",
        "--shell-project-tab-active-border": "#FFD54A",

        "--shell-control-bg": "#000000",
        "--shell-control-fg": "#FFFFFF",
        "--shell-control-border": "#8A8A8A",
        "--shell-control-hover-bg": "#FFFFFF",
        "--shell-control-hover-fg": "#000000",
        "--shell-control-hover-border": "#FFFFFF",
        "--shell-control-open-bg": "#FFD54A",
        "--shell-control-open-fg": "#000000",
        "--shell-control-open-border": "#FFD54A",
        "--shell-control-kbd-bg": "#000000",
        "--shell-control-kbd-fg": "#D6D6D6",

        "--shell-status-running": "#5BE38A",
        "--shell-status-attention": "#FFD54A",
        "--shell-attention-fg": "#FFD54A",
        "--shell-attention-edge": "#FFD54A",
        "--shell-pressure-1": "#FFD54A",
        "--shell-pressure-2": "#FFA23C",
        "--shell-pressure-3": "#FF7A9E",
        "--shell-pressure-4": "#FF5C5C",

        "--work-sidebar-bg": "#000000",
        "--work-session-sidebar-bg": "#000000",
        "--work-pane-border": "#8A8A8A",
        "--work-pane-header-bg": "#101010",
        "--work-popover-bg": "#000000",
        "--work-popover-border": "#FFFFFF",
        "--work-popover-item-hover": "#333333",
        "--work-popover-item-active": "#4A4A4A",

        "--work-rail-terminal": "#C9A0FF",
        "--work-rail-git": "#5BE38A",
        "--work-rail-files": "#FFD54A",
        "--work-rail-ios": "#7FC4FF",
        "--work-rail-app-control": "#FF9AF0",
        "--work-rail-browser": "#59F0E0",
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
        "--color-card-solid": "#FFFFFF",
        "--pane-bg": "#FFFFFF",
        "--pane-border": "#4A4A4A",
        "--chat-canvas-bg": "#FFFFFF",

        "--shell-header-bg": "#FFFFFF",
        "--shell-header-fg": "#000000",
        "--shell-header-border": "#000000",
        "--shell-header-divider": "#4A4A4A",
        "--shell-surface": "#FFFFFF",

        "--shell-sidebar-bg": "#FFFFFF",
        "--shell-sidebar-border": "#000000",
        "--shell-sidebar-separator": "#4A4A4A",
        "--shell-sidebar-item-fg": "#2E2E2E",
        "--shell-sidebar-item-hover-fg": "#FFFFFF",
        "--shell-sidebar-item-hover-bg": "#000000",
        "--shell-sidebar-item-active-fg": "#FFFFFF",
        "--shell-sidebar-item-active-bg": "#0B4FD0",
        "--shell-sidebar-item-active-rail": "#0B4FD0",

        "--shell-project-tab-fg": "#2E2E2E",
        "--shell-project-tab-hover-fg": "#FFFFFF",
        "--shell-project-tab-hover-bg": "#000000",
        "--shell-project-tab-hover-border": "#000000",
        "--shell-project-tab-active-fg": "#FFFFFF",
        "--shell-project-tab-active-bg": "#0B4FD0",
        "--shell-project-tab-active-border": "#0B4FD0",

        "--shell-control-bg": "#FFFFFF",
        "--shell-control-fg": "#000000",
        "--shell-control-border": "#4A4A4A",
        "--shell-control-hover-bg": "#000000",
        "--shell-control-hover-fg": "#FFFFFF",
        "--shell-control-hover-border": "#000000",
        "--shell-control-open-bg": "#0B4FD0",
        "--shell-control-open-fg": "#FFFFFF",
        "--shell-control-open-border": "#0B4FD0",
        "--shell-control-kbd-bg": "#FFFFFF",
        "--shell-control-kbd-fg": "#2E2E2E",

        "--shell-status-running": "#0A7A34",
        "--shell-status-attention": "#8A5200",
        "--shell-attention-fg": "#8A5200",
        "--shell-attention-edge": "#8A5200",
        "--shell-pressure-1": "#8A5200",
        "--shell-pressure-2": "#A34200",
        "--shell-pressure-3": "#B3001B",
        "--shell-pressure-4": "#8A0014",

        "--work-sidebar-bg": "#FFFFFF",
        "--work-session-sidebar-bg": "#F0F0F0",
        "--work-pane-border": "#4A4A4A",
        "--work-pane-header-bg": "#F0F0F0",
        "--work-popover-bg": "#FFFFFF",
        "--work-popover-border": "#000000",
        "--work-popover-item-hover": "#E0E0E0",
        "--work-popover-item-active": "#C8C8C8",

        "--work-rail-terminal": "#5B21B6",
        "--work-rail-git": "#0A7A34",
        "--work-rail-files": "#8A5200",
        "--work-rail-ios": "#0B4FD0",
        "--work-rail-app-control": "#A1006E",
        "--work-rail-browser": "#00666E",
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
    // Bundled packages publish no image and no gallery: they are drawn from
    // their glyph, and the app is not going to fetch a screenshot of itself.
    iconUrl: null,
    media: [],
    // The repository page, which is display-only here — `source` below is what
    // an install actually resolves against. It is what the author link and the
    // star button point at, and both of those want the project's page rather
    // than the bytes.
    repo: `${REGISTRY_ORG}/${source.name}`,
    links: {
      repository: `${REGISTRY_ORG}/${source.name}`,
      homepage: null,
      changelog: `${REGISTRY_ORG}/${source.name}/releases`,
      license: null,
      docs: null,
    },
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
  listing(REVIEW, {
    author: "ADE",
    readme: [
      "## Review",
      "",
      "Read a pull request and the changes in your working copy side by side, file",
      "by file, with comments in place.",
      "",
      "Review was part of ADE itself until plugins existed. Nothing about it changed —",
      "it stopped being something everyone has to carry. Install it and the Review tab",
      "is in your rail; remove it and the rail is one item shorter.",
      "",
      "### Notes",
      "",
      "- The diff is drawn by the desktop app rather than published as a panel, so on",
      "  a phone or in the terminal the plugin shows a card pointing at the machine",
      "  that holds the repository.",
      "- The `/review` route opens only while the plugin is installed and on.",
    ].join("\n"),
  }),
  listing(HISTORY, {
    author: "ADE",
    readme: [
      "## History",
      "",
      "Everything that happened in a project, in order: runs, commits, files that",
      "changed, and the screenshots and recordings your agents captured along the way.",
      "",
      "History was part of ADE itself until plugins existed. Nothing about it changed —",
      "it stopped being something everyone has to carry. Install it and the History tab",
      "is in your rail; remove it and the rail is one item shorter.",
      "",
      "### Notes",
      "",
      "- The timeline is drawn by the desktop app rather than published as a panel, so",
      "  on a phone or in the terminal the plugin shows a card pointing at the machine",
      "  that holds the project.",
      "- The `/history` route opens only while the plugin is installed and on.",
    ].join("\n"),
  }),
  listing(LINEAR, {
    author: "ADE",
    readme: [
      "## Linear",
      "",
      "Read and update the Linear issue you are working on without leaving ADE: open",
      "it beside your work, change its state, comment, and pick up the next one.",
      "",
      "Install it and the Linear pane and its buttons are there; remove it and they",
      "are gone, links included.",
      "",
      "### Notes",
      "",
      "- Needs a Linear connection, which lives in Settings and is separate from this",
      "  plugin — installing it does not connect an account.",
      "- The issue view is drawn by the desktop app rather than published as a panel.",
      "- Linear links open only while the plugin is installed and on, on the machine",
      "  you are attached to.",
    ].join("\n"),
  }),
  listing(IOS_SIM, {
    author: "ADE",
    readme: [
      "## iOS Simulator",
      "",
      "Run an iOS Simulator beside your work: launch a build, tap and type in it,",
      "take screenshots, and hand what you see to a chat.",
      "",
      "Install it and the simulator pane and its chat button are there; remove it and",
      "they are gone.",
      "",
      "### Notes",
      "",
      "- Macs only, and it needs Xcode. On anything else the pane stays hidden even",
      "  with the plugin installed.",
      "- Driving the simulator stays inside ADE rather than being published as a",
      "  panel, because it holds a running app and a video stream open.",
    ].join("\n"),
  }),
  listing(APP_CONTROL, {
    author: "ADE",
    readme: [
      "## Electron Control",
      "",
      "Point ADE at an Electron app and watch it work: click and type in it, read its",
      "logs, answer its prompts, and pull a screenshot back into a chat.",
      "",
      "Install it and the Electron Control pane and its chat button are there; remove",
      "it and they are gone.",
      "",
      "### Notes",
      "",
      "- It drives over the Chrome DevTools Protocol, so the app has to be Electron or",
      "  Chromium — a native desktop app has nothing to attach to.",
      "- Runs on the machine you are attached to, and asks that machine for permission",
      "  the first time it needs it.",
      "- Driving an app stays inside ADE rather than being published as a panel,",
      "  because it holds a live connection to a running program.",
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
  listing(VOICE, {
    author: "ADE",
    featured: true,
    readme: [
      "## Voice",
      "",
      "Dictate into the composer instead of typing. Press the microphone, speak, and",
      "the words arrive as text — transcribed on this computer, so no audio is",
      "uploaded anywhere and dictation keeps working with the network off.",
      "",
      "Dictation was part of ADE itself until plugins existed. All of it moved out —",
      "the microphone button, the recording, the speech model and the transcribing —",
      "and it moved out through the same doors any plugin has: a composer button, an",
      "SDK call for the recording, and a response that types into your draft.",
      "",
      "### The one-time download",
      "",
      "The speech model is about 141 MB and is fetched the first time you dictate,",
      "then kept in ADE's application-support folder — not in the plugin, so",
      "updating it never downloads the model again. If you dictated in ADE before",
      "voice became a plugin, it is already there.",
      "",
      "A download that size cannot finish inside one request, so the first recording",
      "starts it and says so; every recording after that is immediate. An interrupted",
      "download resumes, and the file is only used once its checksum matches.",
      "",
      "### Notes",
      "",
      "- macOS only. The engine is a universal build, so both Apple Silicon and Intel",
      "  Macs work; there is no Linux or Windows build in this package, and on those",
      "  the plugin says so rather than failing quietly.",
      "- English. The bundled model is `base.en`.",
      "- On iPhone, use the keyboard's own dictation key — iOS has it built in, so",
      "  this plugin does not ship a mobile surface.",
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
