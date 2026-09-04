/**
 * The official theme set, and the token spec every official theme satisfies.
 *
 * ## Why this file generates rather than lists
 *
 * A theme that sets only a background, a foreground and an accent is not a
 * theme: {@link expandPluginThemeTokens} fills the rest, and everything it
 * fills used to be a mix of the accent. Twelve themes built that way read as
 * twelve tints of one layout. So a theme here declares a PALETTE — a surface
 * ladder, a text ladder and nine named hues, per mode — and
 * {@link modeTokens} maps that palette onto every role ADE paints: shell
 * chrome, status, the work rail, code and diff, syntax, charts and selection.
 * The hues are the art direction; the mapping is the product knowledge, and it
 * lives in one place so a new theme cannot forget half of it.
 *
 * ## The spec
 *
 * {@link OFFICIAL_THEME_TOKEN_GROUPS} is the contract, in ten groups. Every
 * official theme sets every token in it, in BOTH modes.
 * `officialThemes.test.ts` walks `plugins/themes/*` and fails on a missing
 * group, so "we shipped a theme that forgets the terminal rail" is a red suite
 * rather than a grey rail. The manifest parser stays tolerant on purpose: a
 * community theme may set three tokens and is still a valid theme. The
 * completeness gate applies to the official set only.
 *
 * ## Provenance
 *
 * Several palettes are INSPIRED BY well-known editor themes — Nord, Gruvbox,
 * Catppuccin, Dracula, Tokyo Night, Rosé Pine, Solarized. Colour values are
 * not copyrightable and every value below is our own, shifted for ADE's
 * surfaces; the names and marks are theirs and are not used. No upstream file
 * is copied. Tokyo Night's own project is Apache-2.0 — inspiration only.
 */

import type { PluginManifest } from "../../../shared/plugins/manifest";

/* ── The spec ───────────────────────────────────────────────────────────── */

/**
 * The ten groups an official theme must fill, in both modes.
 *
 * Exported as data rather than prose because the README, the completeness test
 * and the generator all have to agree about it. A group is named for the part
 * of the product it paints, so a failure reads as "Frost is missing the work
 * rail" rather than "Frost is missing --work-rail-ios".
 */
export const OFFICIAL_THEME_TOKEN_GROUPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  /** The six-step surface ladder plus the popover plane. */
  background: Object.freeze([
    "--color-bg",
    "--color-surface",
    "--color-surface-raised",
    "--color-surface-recessed",
    "--color-surface-overlay",
    "--color-card",
    "--color-popup-bg",
  ]),
  /** Primary, on-card, secondary and muted text. */
  text: Object.freeze([
    "--color-fg",
    "--color-card-fg",
    "--color-secondary-fg",
    "--color-muted-fg",
  ]),
  accent: Object.freeze([
    "--color-accent",
    "--color-accent-fg",
    "--color-accent-bright",
    "--color-accent-deep",
  ]),
  borders: Object.freeze([
    "--color-border",
    "--color-separator",
    "--color-separator-active",
    "--color-glow",
  ]),
  /** Header, sidebar, project tabs and header controls — 24 states. */
  shellChrome: Object.freeze([
    "--shell-header-bg",
    "--shell-header-fg",
    "--shell-header-border",
    "--shell-header-divider",
    "--shell-surface",
    "--shell-sidebar-bg",
    "--shell-sidebar-border",
    "--shell-sidebar-separator",
    "--shell-sidebar-item-fg",
    "--shell-sidebar-item-hover-fg",
    "--shell-sidebar-item-hover-bg",
    "--shell-sidebar-item-active-fg",
    "--shell-sidebar-item-active-bg",
    "--shell-sidebar-item-active-rail",
    "--shell-project-tab-fg",
    "--shell-project-tab-hover-fg",
    "--shell-project-tab-hover-bg",
    "--shell-project-tab-active-fg",
    "--shell-project-tab-active-bg",
    "--shell-control-bg",
    "--shell-control-fg",
    "--shell-control-border",
    "--shell-control-hover-bg",
    "--shell-control-open-bg",
  ]),
  status: Object.freeze([
    "--color-success",
    "--color-warning",
    "--color-error",
    "--color-info",
    "--shell-status-running",
    "--shell-status-attention",
    "--shell-attention-fg",
    "--shell-attention-edge",
    "--shell-pressure-1",
    "--shell-pressure-2",
    "--shell-pressure-3",
    "--shell-pressure-4",
  ]),
  workRail: Object.freeze([
    "--work-rail-terminal",
    "--work-rail-git",
    "--work-rail-files",
    "--work-rail-ios",
    "--work-rail-app-control",
    "--work-rail-browser",
  ]),
  /** Diff gutters, the code plane, and the eight syntax roles. */
  code: Object.freeze([
    "--color-diff-add",
    "--color-diff-del",
    "--color-diff-hunk",
    "--chat-code-bg",
    "--chat-code-fg",
    "--color-syntax-keyword",
    "--color-syntax-string",
    "--color-syntax-number",
    "--color-syntax-comment",
    "--color-syntax-function",
    "--color-syntax-type",
    "--color-syntax-variable",
    "--color-syntax-operator",
  ]),
  /** Categorical series colours plus the activity heat ramp. */
  chart: Object.freeze([
    "--color-chart-1",
    "--color-chart-2",
    "--color-chart-3",
    "--color-chart-4",
    "--color-chart-5",
    "--color-chart-6",
    "--color-heat-1",
    "--color-heat-2",
    "--color-heat-3",
    "--color-heat-4",
  ]),
  selection: Object.freeze([
    "--color-selection-bg",
    "--color-selection-fg",
  ]),
});

/** Every token in the spec, flattened. 86 of them. */
export const OFFICIAL_THEME_REQUIRED_TOKENS: readonly string[] =
  Object.freeze(Object.values(OFFICIAL_THEME_TOKEN_GROUPS).flat());

/* ── The palette an author writes ───────────────────────────────────────── */

/**
 * One mode of one theme, as its author thinks about it.
 *
 * Six surfaces, three text weights, two line weights, nine hues and the accent
 * quartet. Everything ADE paints is derived from these by {@link modeTokens} —
 * which is the point: a role added to the product is added once, here, and
 * every theme gains it.
 */
type ModePalette = {
  /** Deepest well: the foot of the sidebar gradient and the session rail. */
  crust: string;
  /** The canvas. */
  base: string;
  /** One step under the canvas: recessed wells and the code plane. */
  mantle: string;
  /** Panels. */
  surface: string;
  /** Cards and raised chrome. */
  raised: string;
  /** Popovers, modals and menus. */
  overlay: string;

  text: string;
  subtext: string;
  muted: string;

  line: string;
  lineStrong: string;

  red: string;
  orange: string;
  yellow: string;
  green: string;
  teal: string;
  sky: string;
  blue: string;
  purple: string;
  pink: string;

  accent: string;
  accentBright: string;
  accentDeep: string;
  /** Text drawn ON the accent. */
  accentFg: string;
  /**
   * The accent at TEXT weight on this mode's canvas.
   *
   * Not derivable: "brighter" reads on a dark ground and disappears on a light
   * one, so the active sidebar label needs a value the author picked against
   * the real background. Every light mode below fails WCAG AA on
   * `accentBright` and passes on this.
   */
  accentText: string;
};

type ThemeSpec = {
  id: string;
  name: string;
  version: string;
  description: string;
  /** The gallery swatch. */
  accent: string;
  /** What makes this palette worth choosing, in the author's own words. */
  readme: string;
  dark: ModePalette;
  light: ModePalette;
};

/* ── Palette → tokens ───────────────────────────────────────────────────── */

function rgbChannels(hex: string): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function mix(color: string, percent: number, into: string): string {
  return `color-mix(in srgb, ${color} ${percent}%, ${into})`;
}

/**
 * The whole product, painted from one palette.
 *
 * Grouped in spec order so a reader can check the groups against
 * {@link OFFICIAL_THEME_TOKEN_GROUPS} by eye. Tokens beyond the spec are set
 * too — the spec is the floor, not the ceiling, and leaving a role like
 * `--work-popover-bg` to be derived would put a popover on the wrong plane.
 */
function modeTokens(p: ModePalette): Record<string, string> {
  return {
    /* background */
    "--color-bg": p.base,
    "--color-surface": p.surface,
    "--color-surface-raised": p.raised,
    "--color-surface-recessed": p.mantle,
    "--color-surface-overlay": p.overlay,
    "--color-card": p.raised,
    "--color-popup-bg": p.overlay,
    "--color-secondary": p.overlay,
    "--color-muted": p.surface,
    "--color-modal-bg": p.overlay,
    "--color-composer-bg": p.surface,
    "--color-glass-card": p.surface,
    "--color-card-solid": p.raised,
    "--color-card-rgb": rgbChannels(p.raised),
    "--pane-bg": p.surface,
    "--pane-border": p.line,
    "--chat-canvas-bg": p.base,

    /* text */
    "--color-fg": p.text,
    "--color-card-fg": p.text,
    "--color-secondary-fg": p.subtext,
    "--color-muted-fg": p.muted,

    /* accent */
    "--color-accent": p.accent,
    "--color-accent-fg": p.accentFg,
    "--color-accent-bright": p.accentBright,
    "--color-accent-deep": p.accentDeep,
    "--color-accent-muted": mix(p.accent, 18, "transparent"),

    /* borders */
    "--color-border": p.line,
    "--color-separator": p.line,
    "--color-separator-active": p.accent,
    "--color-glow": mix(p.accent, 18, "transparent"),

    /* shell chrome — surfaces first, accent only where the role IS the accent */
    "--shell-header-bg": p.surface,
    "--shell-header-fg": p.text,
    "--shell-header-border": p.lineStrong,
    "--shell-header-divider": p.line,
    "--shell-surface": p.overlay,
    "--shell-sidebar-bg": `linear-gradient(180deg, ${p.raised} 0%, ${p.crust} 100%)`,
    "--shell-sidebar-border": p.lineStrong,
    "--shell-sidebar-separator": p.line,
    "--shell-sidebar-item-fg": p.muted,
    "--shell-sidebar-item-hover-fg": p.text,
    "--shell-sidebar-item-hover-bg": mix(p.text, 8, "transparent"),
    "--shell-sidebar-item-active-fg": p.accentText,
    "--shell-sidebar-item-active-bg": mix(p.accent, 18, "transparent"),
    "--shell-sidebar-item-active-rail": p.accent,
    "--shell-project-tab-fg": p.muted,
    "--shell-project-tab-hover-fg": p.text,
    "--shell-project-tab-hover-bg": mix(p.text, 7, "transparent"),
    "--shell-project-tab-hover-border": p.lineStrong,
    "--shell-project-tab-active-fg": p.text,
    "--shell-project-tab-active-bg": p.raised,
    "--shell-project-tab-active-border": p.accent,
    "--shell-control-bg": p.mantle,
    "--shell-control-fg": p.subtext,
    "--shell-control-border": p.line,
    "--shell-control-hover-bg": mix(p.text, 8, p.mantle),
    "--shell-control-hover-fg": p.text,
    "--shell-control-hover-border": p.lineStrong,
    "--shell-control-open-bg": mix(p.accent, 18, p.mantle),
    "--shell-control-open-fg": p.text,
    "--shell-control-open-border": p.accent,
    "--shell-control-kbd-bg": p.raised,
    "--shell-control-kbd-fg": p.muted,

    /* status */
    "--color-success": p.green,
    "--color-warning": p.yellow,
    "--color-error": p.red,
    "--color-info": p.blue,
    "--shell-status-running": p.green,
    "--shell-status-attention": p.yellow,
    "--shell-attention-fg": p.yellow,
    "--shell-attention-edge": p.orange,
    "--shell-pressure-1": p.yellow,
    "--shell-pressure-2": p.orange,
    "--shell-pressure-3": p.pink,
    "--shell-pressure-4": p.red,

    /* work rail */
    "--work-rail-terminal": p.purple,
    "--work-rail-git": p.green,
    "--work-rail-files": p.yellow,
    "--work-rail-ios": p.blue,
    "--work-rail-app-control": p.pink,
    "--work-rail-browser": p.teal,
    "--work-chrome-surface": p.surface,
    "--work-sidebar-bg": p.surface,
    "--work-session-sidebar-bg": p.crust,
    "--work-pane-border": p.line,
    "--work-pane-header-bg": p.overlay,
    "--work-popover-bg": p.overlay,
    "--work-popover-border": p.lineStrong,
    "--work-popover-item-hover": mix(p.text, 8, "transparent"),
    "--work-popover-item-active": mix(p.accent, 15, p.overlay),

    /* code & diff */
    "--color-diff-add": p.green,
    "--color-diff-del": p.red,
    "--color-diff-hunk": p.blue,
    "--chat-code-bg": p.mantle,
    "--chat-code-fg": p.text,
    "--color-syntax-keyword": p.purple,
    "--color-syntax-string": p.green,
    "--color-syntax-number": p.orange,
    "--color-syntax-comment": p.muted,
    "--color-syntax-function": p.blue,
    "--color-syntax-type": p.yellow,
    "--color-syntax-variable": p.text,
    "--color-syntax-operator": p.sky,

    /* chart & heat */
    "--color-chart-1": p.blue,
    "--color-chart-2": p.teal,
    "--color-chart-3": p.yellow,
    "--color-chart-4": p.purple,
    "--color-chart-5": p.pink,
    "--color-chart-6": p.green,
    // Step 1 is "barely any activity" — a wash of the info hue over the panel,
    // not one of the nine hues, so the ramp starts near the surface it sits on.
    "--color-heat-1": mix(p.blue, 45, p.surface),
    "--color-heat-2": p.teal,
    "--color-heat-3": p.orange,
    "--color-heat-4": p.yellow,

    /* selection */
    "--color-selection-bg": mix(p.accent, 26, "transparent"),
    // `transparent` is the documented sentinel for "do not force a selection
    // foreground" — the terminal omits the property entirely when it sees it.
    "--color-selection-fg": "transparent",
  };
}

function themeManifest(spec: ThemeSpec): PluginManifest {
  return {
    name: spec.id,
    version: spec.version,
    displayName: spec.name,
    description: spec.description,
    icon: "palette",
    accent: spec.accent,
    vocabVersion: 1,
    surfaces: [],
    panels: [],
    sockets: [],
    collections: {},
    settings: [],
    cli: [],
    skills: [],
    tools: [],
    automationTriggers: [],
    automationSteps: [],
    searchProviders: [],
    keybindings: [],
    chatRuntimes: [],
    webhookIngress: [],
    theme: { tokens: { dark: modeTokens(spec.dark), light: modeTokens(spec.light) } },
    official: true,
  };
}

/* ── The themes ─────────────────────────────────────────────────────────── */

const THEMES: readonly ThemeSpec[] = [
  {
    id: "ade-theme-ink",
    name: "Ink",
    version: "1.1.0",
    description: "Deep blue-black with a steel accent. Quiet under long sessions.",
    accent: "#6FA8C7",
    readme: "Ink is the quiet one. A blue-black canvas, steel chrome and a single cool accent, with syntax and rail hues desaturated so nothing on screen competes with the code. Built for the sessions that run past midnight.",
    dark: {
      crust: "#070A0E", base: "#0B0E13", mantle: "#080A0E",
      surface: "#11151C", raised: "#161B24", overlay: "#1A202B",
      text: "#E6EAF0", subtext: "#A9B3C0", muted: "#8C97A6",
      line: "#232A35", lineStrong: "#303947",
      red: "#E08A8A", orange: "#D2905C", yellow: "#D9B45E", green: "#5EC8B0",
      teal: "#5FC0D0", sky: "#8FC4E4", blue: "#6E9BE0", purple: "#A98FD6", pink: "#D48FB4",
      accent: "#6FA8C7", accentBright: "#93C4DE", accentDeep: "#3E7695", accentText: "#93C4DE", accentFg: "#0B0E13",
    },
    light: {
      crust: "#DFE4EC", base: "#F2F4F7", mantle: "#E8EBF0",
      surface: "#F8F9FB", raised: "#FFFFFF", overlay: "#FFFFFF",
      text: "#161B24", subtext: "#4A5462", muted: "#5C6673",
      line: "#D3D9E1", lineStrong: "#BCC4CF",
      red: "#9A2130", orange: "#9A5320", yellow: "#8A6210", green: "#0F7A66",
      teal: "#0E6E80", sky: "#276A8C", blue: "#2C5CA8", purple: "#6B4C9A", pink: "#A03A4E",
      accent: "#2E6C8E", accentBright: "#4A88AA", accentDeep: "#1F4E68", accentText: "#1F4E68", accentFg: "#FFFFFF",
    },
  },
  {
    id: "ade-theme-paper",
    name: "Paper",
    version: "1.1.0",
    description: "Warm paper and ink, with a clay accent. For working in daylight.",
    accent: "#A05C36",
    readme: "Paper is the daylight theme. Warm off-white stock, ink-brown text and a clay accent, with every hue pulled toward earth so a bright room does not turn the screen into a mirror. Its dark mode is the same paper after sundown, not a different theme.",
    dark: {
      crust: "#100D0B", base: "#14110E", mantle: "#100D0B",
      surface: "#1A1713", raised: "#201C17", overlay: "#241F19",
      text: "#EFE9DF", subtext: "#B6AC9C", muted: "#9A9081",
      line: "#2E2820", lineStrong: "#3B3429",
      red: "#D98A7A", orange: "#D08350", yellow: "#D9B45E", green: "#8FBF7A",
      teal: "#6FBDAF", sky: "#9FBFD0", blue: "#7FA8BE", purple: "#B49AD0", pink: "#C98FA8",
      accent: "#C98A5E", accentBright: "#E0A87D", accentDeep: "#8E5B34", accentText: "#E0A87D", accentFg: "#14110E",
    },
    light: {
      crust: "#E4DBCB", base: "#F7F3EC", mantle: "#EFE9DE",
      surface: "#FBF8F2", raised: "#FFFFFF", overlay: "#FFFDF8",
      text: "#23201B", subtext: "#57503F", muted: "#6B6455",
      line: "#DED6C8", lineStrong: "#C7BCA8",
      red: "#93302B", orange: "#B05F22", yellow: "#A8791F", green: "#4F7A46",
      teal: "#2F7368", sky: "#3F6E85", blue: "#3A5F94", purple: "#6E4A86", pink: "#94405E",
      accent: "#A05C36", accentBright: "#C0724A", accentDeep: "#7C4425", accentText: "#7C4425", accentFg: "#FFFFFF",
    },
  },
  {
    id: "ade-theme-contrast",
    name: "High contrast",
    version: "1.1.0",
    description: "Accessibility theme. Maximum separation between text, edges and background.",
    accent: "#FFD54A",
    readme: "An accessibility theme, not a mood. Pure black or pure white canvas, borders that are actually visible, and status hues chosen for separation rather than harmony. Every text pair clears WCAG AA by a wide margin. Reach for it in bad light, on a projector, or at the end of a long day.",
    dark: {
      crust: "#000000", base: "#000000", mantle: "#000000",
      surface: "#000000", raised: "#0A0A0A", overlay: "#101010",
      text: "#FFFFFF", subtext: "#F2F2F2", muted: "#D6D6D6",
      line: "#8A8A8A", lineStrong: "#C8C8C8",
      red: "#FF7A7A", orange: "#FFA23C", yellow: "#FFD54A", green: "#5BE38A",
      teal: "#59F0E0", sky: "#9AD4FF", blue: "#6FB4FF", purple: "#C9A0FF", pink: "#FF9AF0",
      accent: "#FFD54A", accentBright: "#FFE685", accentDeep: "#C9A32E", accentText: "#FFE685", accentFg: "#000000",
    },
    light: {
      crust: "#FFFFFF", base: "#FFFFFF", mantle: "#F0F0F0",
      surface: "#FFFFFF", raised: "#FFFFFF", overlay: "#FFFFFF",
      text: "#000000", subtext: "#141414", muted: "#2E2E2E",
      line: "#4A4A4A", lineStrong: "#1A1A1A",
      red: "#B3001B", orange: "#A34200", yellow: "#8A5200", green: "#0A7A34",
      teal: "#00666E", sky: "#0F5C8A", blue: "#0B4FD0", purple: "#5B21B6", pink: "#A1006E",
      accent: "#0B4FD0", accentBright: "#2A6BE8", accentDeep: "#07379A", accentText: "#07379A", accentFg: "#FFFFFF",
    },
  },
  {
    id: "ade-theme-phosphor",
    name: "Phosphor",
    version: "2.0.0",
    description: "Green-screen terminal, rebuilt with a real syntax palette instead of one green.",
    accent: "#63D492",
    readme: "The green-screen idea, done properly. The chrome is phosphor — green-black wells, green rails, a green cursor — but the code is not: keywords, strings, numbers and types each get their own hue, so a file still reads like a file. That contrast between monochrome chrome and full-colour code is the whole point.",
    dark: {
      crust: "#050A07", base: "#08110C", mantle: "#050A07",
      surface: "#0D1912", raised: "#13231A", overlay: "#193024",
      text: "#DDF7E7", subtext: "#ADD2BA", muted: "#7FA28B",
      line: "#264332", lineStrong: "#33573F",
      red: "#FF8A7A", orange: "#FFB067", yellow: "#E8DC7A", green: "#63D492",
      teal: "#4FD6C0", sky: "#7ADCE8", blue: "#79B8F0", purple: "#C2A0F0", pink: "#F58FC8",
      accent: "#63D492", accentBright: "#8BE9AF", accentDeep: "#319D61", accentText: "#8BE9AF", accentFg: "#07170E",
    },
    light: {
      crust: "#D9E6DB", base: "#F3F7F1", mantle: "#E2EAE0",
      surface: "#F8FBF6", raised: "#FFFFFF", overlay: "#FFFFFF",
      text: "#1C2A22", subtext: "#3F5648", muted: "#607568",
      line: "#CAD8CD", lineStrong: "#AFC2B4",
      red: "#A33A2C", orange: "#9A5A15", yellow: "#7A6A12", green: "#287D55",
      teal: "#0F6E62", sky: "#16657A", blue: "#2A5C9E", purple: "#6B3FA0", pink: "#9E3673",
      accent: "#287D55", accentBright: "#42A873", accentDeep: "#185C3B", accentText: "#185C3B", accentFg: "#FFFFFF",
    },
  },
  {
    id: "ade-theme-frost",
    name: "Frost",
    version: "1.0.0",
    description: "Arctic blue-grey with a low-saturation aurora. Cold, even, and easy on the eyes.",
    accent: "#8CC4D4",
    readme: "Frost is built on a narrow band of blue-grey: the six surfaces sit close together, so panels separate by edge rather than by brightness. Every hue is desaturated to match, which keeps a full-colour diff from shouting. Inspired by the northern-palette tradition; the values are ours.",
    dark: {
      crust: "#21262F", base: "#2B313B", mantle: "#262C35",
      surface: "#333A45", raised: "#3C4450", overlay: "#454E5C",
      text: "#E3E8F0", subtext: "#C2CAD6", muted: "#98A3B3",
      line: "#4A5462", lineStrong: "#5A6675",
      red: "#C4646E", orange: "#D48A73", yellow: "#E8CE90", green: "#A6C28E",
      teal: "#93C0BF", sky: "#A8D4E0", blue: "#85A5C6", purple: "#B892B1", pink: "#C48FA8",
      accent: "#8CC4D4", accentBright: "#AEDCE8", accentDeep: "#5E85B0", accentText: "#AEDCE8", accentFg: "#21262F",
    },
    light: {
      crust: "#D5DCE6", base: "#EDF1F6", mantle: "#E2E8F0",
      surface: "#F4F7FA", raised: "#FFFFFF", overlay: "#FFFFFF",
      text: "#2B313B", subtext: "#47505E", muted: "#5C6675",
      line: "#CBD3DE", lineStrong: "#AEB8C6",
      red: "#9B3E4A", orange: "#A45A38", yellow: "#8A6A1E", green: "#4F7040",
      teal: "#2C6E6C", sky: "#2A6480", blue: "#3A5F8C", purple: "#7A4E76", pink: "#8E4463",
      accent: "#2A6480", accentBright: "#3E7F9E", accentDeep: "#1C4A62", accentText: "#1C4A62", accentFg: "#FFFFFF",
    },
  },
  {
    id: "ade-theme-kiln",
    name: "Kiln",
    version: "1.0.0",
    description: "Warm brown-grey with fired orange and olive. Retro, high-saturation, easy to read.",
    accent: "#F8862A",
    readme: "Kiln is warm all the way down: the greys are brown, the greens are olive, and the accent is fired orange. High-saturation hues on a low-saturation ground, which is why a busy diff still separates cleanly. Inspired by the classic retro-terminal palettes; the values are ours.",
    dark: {
      crust: "#1B1917", base: "#241F1C", mantle: "#1E1A18",
      surface: "#2E2925", raised: "#383029", overlay: "#423931",
      text: "#EDDCB6", subtext: "#C8B893", muted: "#A2937A",
      line: "#4A4038", lineStrong: "#5C5045",
      red: "#F0503C", orange: "#F8862A", yellow: "#F5BE3C", green: "#B4BC33",
      teal: "#8CC47E", sky: "#9CC2B4", blue: "#7FA3B8", purple: "#C08BD0", pink: "#D4899C",
      accent: "#F8862A", accentBright: "#FFA255", accentDeep: "#B85F17", accentText: "#FFA255", accentFg: "#241F1C",
    },
    light: {
      crust: "#EADFB8", base: "#FAF1D8", mantle: "#F1E6C6",
      surface: "#FDF6E3", raised: "#FFFCF2", overlay: "#FFFFFF",
      text: "#3A2F27", subtext: "#5C4E40", muted: "#75634F",
      line: "#DDCFAC", lineStrong: "#C2B18B",
      red: "#9E2B1E", orange: "#A85812", yellow: "#8A6A0E", green: "#5E6A16",
      teal: "#2F6E4E", sky: "#2C6070", blue: "#38607A", purple: "#7A3F86", pink: "#92375A",
      accent: "#A85812", accentBright: "#C46E22", accentDeep: "#7C3D08", accentText: "#7C3D08", accentFg: "#FFFCF2",
    },
  },
  {
    id: "ade-theme-mocha",
    name: "Mocha",
    version: "1.0.0",
    description: "Soft lavender-grey night palette with pastel hues. Gentle contrast, no glare.",
    accent: "#C9A8F2",
    readme: "Mocha runs on a lavender-tinted grey rather than a neutral one, and every hue is a pastel of the same lightness — so nothing in a syntax-coloured file jumps. It pairs with Latte, which is the same idea in daylight. Inspired by the pastel-palette tradition; the values are ours.",
    dark: {
      crust: "#12111C", base: "#201F31", mantle: "#1A1927",
      surface: "#2C2B40", raised: "#35334B", overlay: "#3F3D57",
      text: "#CFD6F2", subtext: "#A9AFC9", muted: "#9296AE",
      line: "#45435E", lineStrong: "#575473",
      red: "#F08CA6", orange: "#F7B489", yellow: "#F5E0B0", green: "#A6E0A2",
      teal: "#93E0D4", sky: "#8ADBE8", blue: "#8CB2F5", purple: "#C9A8F2", pink: "#F0C2E4",
      accent: "#C9A8F2", accentBright: "#DCC4F8", accentDeep: "#8E68C0", accentText: "#DCC4F8", accentFg: "#201F31",
    },
    light: {
      crust: "#DAD6EA", base: "#F0EEF8", mantle: "#E6E3F2",
      surface: "#F6F5FB", raised: "#FFFFFF", overlay: "#FFFFFF",
      text: "#2A2740", subtext: "#4C4767", muted: "#635F7E",
      line: "#D6D2E6", lineStrong: "#B9B3D0",
      red: "#B03A5A", orange: "#A85A28", yellow: "#8A6A18", green: "#3F7A3C",
      teal: "#1F7268", sky: "#2A6C86", blue: "#3C60B8", purple: "#6E3FB0", pink: "#A03A88",
      accent: "#6E3FB0", accentBright: "#8558CC", accentDeep: "#52288A", accentText: "#52288A", accentFg: "#FFFFFF",
    },
  },
  {
    id: "ade-theme-latte",
    name: "Latte",
    version: "1.0.0",
    description: "Light-first pastel: cool paper, violet accent, and hues tuned for a bright room.",
    accent: "#7E36DE",
    readme: "Latte is designed light-first — the daylight half got the attention, and its dark mode is a deepened version of the same hues rather than a borrowed night theme. Cool paper, a violet accent, and saturated-but-dark hues so a light background does not wash the syntax out. The daylight counterpart to Mocha.",
    dark: {
      crust: "#14161C", base: "#1C1F26", mantle: "#171A20",
      surface: "#252932", raised: "#2D323C", overlay: "#363B47",
      text: "#DFE2EA", subtext: "#B3B8C6", muted: "#878D9E",
      line: "#3A404C", lineStrong: "#4A5160",
      red: "#F0637F", orange: "#F58A4A", yellow: "#E0B057", green: "#74C45E",
      teal: "#3FBCC4", sky: "#5CC8E8", blue: "#6E9AF5", purple: "#A97CF0", pink: "#E290D2",
      accent: "#A97CF0", accentBright: "#C29CF8", accentDeep: "#7448C0", accentText: "#C29CF8", accentFg: "#14161C",
    },
    light: {
      crust: "#D9DDE6", base: "#EEF0F5", mantle: "#E4E7EE",
      surface: "#F5F6FA", raised: "#FFFFFF", overlay: "#FFFFFF",
      text: "#3A3D52", subtext: "#575A70", muted: "#6B6F84",
      line: "#D3D7E2", lineStrong: "#B6BBC9",
      red: "#C81640", orange: "#B04E0C", yellow: "#8A5D0C", green: "#357C24",
      teal: "#0F6E76", sky: "#0A6A92", blue: "#2960E0", purple: "#7E36DE", pink: "#A83C92",
      accent: "#7E36DE", accentBright: "#9A5CEC", accentDeep: "#5E22AC", accentText: "#5E22AC", accentFg: "#FFFFFF",
    },
  },
  {
    id: "ade-theme-spectre",
    name: "Spectre",
    version: "1.0.0",
    description: "Slate-violet night with electric pink, cyan and lime. The loud one.",
    accent: "#BC97F5",
    readme: "Spectre is the loud theme: a slate-violet ground under fully saturated pink, cyan, lime and purple. Chrome stays dark and calm so the colour lands where it matters — syntax, diffs, the rail and charts. Inspired by the classic vampire-palette tradition; the values are ours.",
    dark: {
      crust: "#1C1D27", base: "#262834", mantle: "#1F212C",
      surface: "#30323F", raised: "#3A3D4C", overlay: "#454857",
      text: "#F2F2EE", subtext: "#C7C7D6", muted: "#9BA3C6",
      line: "#474A5C", lineStrong: "#585C70",
      red: "#F85E5E", orange: "#FFB570", yellow: "#EEF48F", green: "#57F281",
      teal: "#7FE9D8", sky: "#8AE4F5", blue: "#7FB8F0", purple: "#BC97F5", pink: "#F87FC4",
      accent: "#BC97F5", accentBright: "#D4B6FF", accentDeep: "#7E56C0", accentText: "#D4B6FF", accentFg: "#1C1D27",
    },
    light: {
      crust: "#DCD8EA", base: "#F3F1FA", mantle: "#E9E6F4",
      surface: "#F8F7FC", raised: "#FFFFFF", overlay: "#FFFFFF",
      text: "#262834", subtext: "#4A4763", muted: "#605D7C",
      line: "#DAD5EA", lineStrong: "#BDB6D2",
      red: "#B22F44", orange: "#A65A1E", yellow: "#7E6C12", green: "#24713C",
      teal: "#14706A", sky: "#1F6785", blue: "#35509E", purple: "#6A34AE", pink: "#A62E82",
      accent: "#6A34AE", accentBright: "#8450C8", accentDeep: "#4E2088", accentText: "#4E2088", accentFg: "#FFFFFF",
    },
  },
  {
    id: "ade-theme-midnight",
    name: "Midnight",
    version: "1.0.0",
    description: "Deep indigo city night: dim chrome, bright blue accent, high-legibility code.",
    accent: "#7EA5F7",
    readme: "Midnight keeps the chrome dim and the code bright. Indigo surfaces with almost no separation, a blue accent that carries every active state, and a comment colour dark enough that a commented block genuinely recedes. Inspired by the city-at-night palette tradition; the values are ours.",
    dark: {
      crust: "#101119", base: "#1B1C28", mantle: "#16171F",
      surface: "#232535", raised: "#2B2E42", overlay: "#34384F",
      text: "#C4CDF2", subtext: "#9AA3C8", muted: "#7982A8",
      line: "#363A52", lineStrong: "#454A66",
      red: "#F27A90", orange: "#FFA166", yellow: "#E2B36C", green: "#A0D06F",
      teal: "#2FBFA4", sky: "#82D2FF", blue: "#7EA5F7", purple: "#BC9DF7", pink: "#E08AC8",
      accent: "#7EA5F7", accentBright: "#A3C0FF", accentDeep: "#4C6FC4", accentText: "#A3C0FF", accentFg: "#101119",
    },
    light: {
      crust: "#D6DAE6", base: "#E9ECF4", mantle: "#DFE3EE",
      surface: "#F2F4F9", raised: "#FFFFFF", overlay: "#FFFFFF",
      text: "#2A2E45", subtext: "#4A5070", muted: "#5C6384",
      line: "#CFD4E2", lineStrong: "#B0B7CA",
      red: "#B03050", orange: "#A85A20", yellow: "#8A6A16", green: "#4A7A24",
      teal: "#10786A", sky: "#1A6C96", blue: "#2E5AC0", purple: "#6A44B8", pink: "#A03C86",
      accent: "#2E5AC0", accentBright: "#4874DC", accentDeep: "#1E3F92", accentText: "#1E3F92", accentFg: "#FFFFFF",
    },
  },
  {
    id: "ade-theme-rose-ash",
    name: "Rose Ash",
    version: "1.0.0",
    description: "Ashen violet-grey with dusty rose and gold. Muted, warm, and low-glare.",
    accent: "#C6ABE8",
    readme: "Rose Ash is muted on purpose: ash-violet surfaces, dusty rose and gold hues, nothing at full saturation. The result is a palette with real colour that still reads as neutral after an hour. Its dawn mode is warm rather than white. Inspired by the muted-rose palette tradition; the values are ours.",
    dark: {
      crust: "#141221", base: "#1C1A2A", mantle: "#171525",
      surface: "#262336", raised: "#2E2B42", overlay: "#38344E",
      text: "#E2E0F5", subtext: "#ADA8C6", muted: "#8A85A6",
      line: "#3D3956", lineStrong: "#4E4A6A",
      red: "#EC7597", orange: "#F0A882", yellow: "#F4C57E", green: "#7FB08E",
      teal: "#9ACFD8", sky: "#A8C4DA", blue: "#6FA8C4", purple: "#C6ABE8", pink: "#E8B6B6",
      accent: "#C6ABE8", accentBright: "#DCC8F2", accentDeep: "#8A6CB0", accentText: "#DCC8F2", accentFg: "#141221",
    },
    light: {
      crust: "#EADFD4", base: "#FAF4EC", mantle: "#F2E9DE",
      surface: "#FEFAF4", raised: "#FFFFFF", overlay: "#FFFFFF",
      text: "#453F63", subtext: "#5E5878", muted: "#6E6786",
      line: "#E2D6C8", lineStrong: "#C7B8A8",
      red: "#A8465E", orange: "#A66424", yellow: "#8A660E", green: "#3E6A4C",
      teal: "#26707C", sky: "#265E74", blue: "#22566E", purple: "#7A5E98", pink: "#B0605C",
      accent: "#7A5E98", accentBright: "#93789E", accentDeep: "#5C4478", accentText: "#5C4478", accentFg: "#FFFFFF",
    },
  },
  {
    id: "ade-theme-solar-dusk",
    name: "Solar Dusk",
    version: "1.0.0",
    description: "Teal-black night and warm parchment day, sharing one set of hues.",
    accent: "#C29612",
    readme: "Solar Dusk is one palette with two grounds: a teal-black night and a warm parchment day, both carrying the same nine hues at the same relative lightness. Switching modes changes the ground, not the meaning of a colour — a green is the same green in both. Inspired by the dual-ground palette tradition; the values are ours.",
    dark: {
      crust: "#012029", base: "#032F3A", mantle: "#022733",
      surface: "#0A3B47", raised: "#114552", overlay: "#1A505E",
      text: "#E6DFCB", subtext: "#B4C0C0", muted: "#93A5A8",
      line: "#1E5462", lineStrong: "#2C6675",
      red: "#E2645E", orange: "#E0713C", yellow: "#C29612", green: "#92A414",
      teal: "#34AC9F", sky: "#4FB6C4", blue: "#3897DA", purple: "#8C90D8", pink: "#DA4A8E",
      accent: "#C29612", accentBright: "#DFB232", accentDeep: "#8E6C06", accentText: "#DFB232", accentFg: "#012029",
    },
    light: {
      crust: "#EDE4CA", base: "#FCF5E2", mantle: "#F3EAD3",
      surface: "#FEFAEE", raised: "#FFFDF5", overlay: "#FFFFFF",
      text: "#2E4A50", subtext: "#4A6068", muted: "#556A70",
      line: "#E4D9BE", lineStrong: "#C7BB9E",
      red: "#B22A22", orange: "#A8420E", yellow: "#8A6C06", green: "#62700C",
      teal: "#1A7C72", sky: "#1E7A88", blue: "#1A6EA8", purple: "#565AA0", pink: "#A82A68",
      accent: "#8A6C06", accentBright: "#A88410", accentDeep: "#664F02", accentText: "#664F02", accentFg: "#FFFDF5",
    },
  },
];

/**
 * The bundled official themes, as `{ manifest, readme }` pairs.
 *
 * `marketplaceLocalIndex.ts` folds these into the gallery, and
 * `plugins/themes/<id>/plugin.json` is generated from the same manifests — the
 * mirror test in `marketplaceLocalIndex.test.ts` is what keeps the two equal.
 */
export const MARKETPLACE_OFFICIAL_THEMES = THEMES.map((spec) => ({
  manifest: themeManifest(spec),
  readme: `## ${spec.name}\n\n${spec.readme}\n\nSets all ${OFFICIAL_THEME_REQUIRED_TOKENS.length} spec tokens in both light and dark. Preview it from the Marketplace without installing, then use it when you are ready.`,
}));
