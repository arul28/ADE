import type { PluginManifest } from "../../../shared/plugins/manifest";

type PaletteHalf = {
  background: string;
  foreground: string;
  surface: string;
  card: string;
  cardRgb: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  accent: string;
  accentForeground: string;
  accentBright: string;
  accentDeep: string;
  raised: string;
  recessed: string;
  popup: string;
  sidebarTop: string;
  sidebarBottom: string;
};

type ThemeSpec = {
  id: string;
  name: string;
  description: string;
  accent: string;
  light: PaletteHalf;
  dark: PaletteHalf;
  readme: string;
};

function paletteTokens(palette: PaletteHalf): Record<string, string> {
  return {
    "--color-bg": palette.background,
    "--color-fg": palette.foreground,
    "--color-surface": palette.surface,
    "--color-card": palette.card,
    "--color-card-fg": palette.foreground,
    "--color-card-rgb": palette.cardRgb,
    "--color-secondary": palette.secondary,
    "--color-secondary-fg": palette.secondaryForeground,
    "--color-muted": palette.muted,
    "--color-muted-fg": palette.mutedForeground,
    "--color-border": palette.border,
    "--color-accent": palette.accent,
    "--color-accent-fg": palette.accentForeground,
    "--color-accent-bright": palette.accentBright,
    "--color-accent-deep": palette.accentDeep,
    "--color-surface-raised": palette.raised,
    "--color-surface-recessed": palette.recessed,
    "--color-surface-overlay": palette.card,
    "--color-popup-bg": palette.popup,
    "--color-modal-bg": palette.card,
    "--color-composer-bg": palette.surface,
    "--color-glass-card": palette.surface,
    "--color-card-solid": palette.card,
    "--pane-bg": palette.surface,
    "--pane-border": palette.border,
    "--chat-canvas-bg": palette.background,
    "--shell-header-bg": palette.surface,
    "--shell-header-fg": palette.foreground,
    "--shell-header-border": palette.border,
    "--shell-surface": palette.popup,
    "--shell-sidebar-bg": `linear-gradient(180deg, ${palette.sidebarTop} 0%, ${palette.sidebarBottom} 100%)`,
    "--shell-sidebar-border": palette.border,
    "--work-sidebar-bg": palette.surface,
    "--work-session-sidebar-bg": palette.recessed,
    "--work-popover-bg": palette.popup,
    "--work-popover-border": palette.border,
  };
}

function themeManifest(spec: ThemeSpec): PluginManifest {
  return {
    name: spec.id,
    version: "1.0.0",
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
    theme: { tokens: { light: paletteTokens(spec.light), dark: paletteTokens(spec.dark) } },
    official: true,
  };
}

const THEMES: readonly ThemeSpec[] = [
  {
    id: "ade-theme-grove",
    name: "Grove",
    description: "Moss, pine and soft stone. Calm, grounded, and built for long focus.",
    accent: "#3F8F62",
    light: {
      background: "#F3F6F1", foreground: "#1C2921", surface: "#F8FAF7", card: "#FFFFFF", cardRgb: "255, 255, 255",
      secondary: "#E1EAE0", secondaryForeground: "#405449", muted: "#E9EFE7", mutedForeground: "#617267", border: "#CCD8CC",
      accent: "#2F7D50", accentForeground: "#FFFFFF", accentBright: "#489A68", accentDeep: "#205D3A",
      raised: "#FFFFFF", recessed: "#E4EBE2", popup: "#FBFCFA", sidebarTop: "#EAF1E8", sidebarBottom: "#DDE8DC",
    },
    dark: {
      background: "#101712", foreground: "#E7F0E9", surface: "#151F18", card: "#1B281F", cardRgb: "27, 40, 31",
      secondary: "#223328", secondaryForeground: "#B2C5B6", muted: "#1B2920", mutedForeground: "#8FA594", border: "#2C4032",
      accent: "#78C792", accentForeground: "#102016", accentBright: "#9DDFB1", accentDeep: "#438C5E",
      raised: "#203026", recessed: "#0C120E", popup: "#19251D", sidebarTop: "#1A291F", sidebarBottom: "#0E1510",
    },
    readme: "A forest palette with legible moss accents, soft surfaces, and low visual noise. Grove stays green without turning success states into decoration.",
  },
  {
    id: "ade-theme-ocean",
    name: "Ocean",
    description: "Deep water blues with clear cyan highlights and cool, spacious surfaces.",
    accent: "#238CB7",
    light: {
      background: "#F1F7FA", foreground: "#172936", surface: "#F7FBFD", card: "#FFFFFF", cardRgb: "255, 255, 255",
      secondary: "#DCEBF2", secondaryForeground: "#3B596A", muted: "#E6F0F5", mutedForeground: "#607887", border: "#C7DCE6",
      accent: "#167DA8", accentForeground: "#FFFFFF", accentBright: "#2FA4CF", accentDeep: "#0F5B7B",
      raised: "#FFFFFF", recessed: "#DCECF3", popup: "#FAFDFF", sidebarTop: "#E5F2F7", sidebarBottom: "#D5E8F0",
    },
    dark: {
      background: "#07151D", foreground: "#E3F4FA", surface: "#0C202B", card: "#112A37", cardRgb: "17, 42, 55",
      secondary: "#153747", secondaryForeground: "#A9CEDD", muted: "#102B38", mutedForeground: "#7FA7B8", border: "#1D4354",
      accent: "#54C3E8", accentForeground: "#06202B", accentBright: "#82D9F3", accentDeep: "#218AAF",
      raised: "#163442", recessed: "#051016", popup: "#0E2531", sidebarTop: "#102A37", sidebarBottom: "#06131B",
    },
    readme: "Ocean uses cool depth instead of flat navy: brighter focus rings, quiet blue-black canvas layers, and cyan accents that remain easy to scan.",
  },
  {
    id: "ade-theme-ember",
    name: "Ember",
    description: "Charcoal, copper and ember orange. Warm without sacrificing code contrast.",
    accent: "#C86D32",
    light: {
      background: "#FAF4EF", foreground: "#30221B", surface: "#FDF9F6", card: "#FFFFFF", cardRgb: "255, 255, 255",
      secondary: "#F0E1D6", secondaryForeground: "#654A3C", muted: "#F4E9E0", mutedForeground: "#80685B", border: "#E3CFC1",
      accent: "#B95D26", accentForeground: "#FFFFFF", accentBright: "#D7793E", accentDeep: "#873E19",
      raised: "#FFFFFF", recessed: "#F0E2D8", popup: "#FFFCFA", sidebarTop: "#F5E7DD", sidebarBottom: "#ECD8C9",
    },
    dark: {
      background: "#180E0A", foreground: "#F7E9DF", surface: "#21130E", card: "#2A1912", cardRgb: "42, 25, 18",
      secondary: "#362117", secondaryForeground: "#D7B8A5", muted: "#2A1B14", mutedForeground: "#AB8B78", border: "#493023",
      accent: "#F08A49", accentForeground: "#251208", accentBright: "#FFAD72", accentDeep: "#B95525",
      raised: "#321E16", recessed: "#110805", popup: "#26160F", sidebarTop: "#2A180F", sidebarBottom: "#130A07",
    },
    readme: "Ember gives ADE a warm studio feel: charcoal structure, copper controls, and orange focus cues tuned to stay distinct from warnings.",
  },
  {
    id: "ade-theme-iris",
    name: "Iris",
    description: "Elegant violet, lavender and graphite with crisp focus states.",
    accent: "#7667D8",
    light: {
      background: "#F6F4FB", foreground: "#252237", surface: "#FAF9FD", card: "#FFFFFF", cardRgb: "255, 255, 255",
      secondary: "#E8E3F5", secondaryForeground: "#514B6C", muted: "#EFECF7", mutedForeground: "#716B86", border: "#D8D1E9",
      accent: "#6657C8", accentForeground: "#FFFFFF", accentBright: "#887AE1", accentDeep: "#493BA2",
      raised: "#FFFFFF", recessed: "#EAE6F3", popup: "#FDFCFF", sidebarTop: "#EFEAF8", sidebarBottom: "#E3DDF0",
    },
    dark: {
      background: "#11101A", foreground: "#EFEFFD", surface: "#181625", card: "#201D30", cardRgb: "32, 29, 48",
      secondary: "#29253D", secondaryForeground: "#C7C1E2", muted: "#211E31", mutedForeground: "#9992B5", border: "#37324E",
      accent: "#A99AF4", accentForeground: "#191427", accentBright: "#C2B8FF", accentDeep: "#7463D4",
      raised: "#27233A", recessed: "#0C0B13", popup: "#1B1929", sidebarTop: "#211D32", sidebarBottom: "#0E0D17",
    },
    readme: "Iris is the polished purple option: graphite foundations, lavender hierarchy, and restrained gradients that keep dense screens calm.",
  },
  {
    id: "ade-theme-sakura",
    name: "Sakura",
    description: "Soft blossom pink, plum ink and porcelain surfaces. Playful but precise.",
    accent: "#C65A83",
    light: {
      background: "#FFF6F8", foreground: "#35242C", surface: "#FFFAFB", card: "#FFFFFF", cardRgb: "255, 255, 255",
      secondary: "#F6E2E9", secondaryForeground: "#674B58", muted: "#FAEBF0", mutedForeground: "#846875", border: "#E9CED8",
      accent: "#B94D77", accentForeground: "#FFFFFF", accentBright: "#D66F98", accentDeep: "#8A3357",
      raised: "#FFFFFF", recessed: "#F6E4EA", popup: "#FFFCFD", sidebarTop: "#FBEAF0", sidebarBottom: "#F3DCE5",
    },
    dark: {
      background: "#180F14", foreground: "#F8EAF0", surface: "#21151B", card: "#2A1B23", cardRgb: "42, 27, 35",
      secondary: "#36232D", secondaryForeground: "#DDB9C8", muted: "#2A1D24", mutedForeground: "#AF8C9B", border: "#49313C",
      accent: "#F08BAD", accentForeground: "#2A121D", accentBright: "#FFACC6", accentDeep: "#B95678",
      raised: "#321F29", recessed: "#11090E", popup: "#261820", sidebarTop: "#2B1A23", sidebarBottom: "#130B10",
    },
    readme: "Sakura is deliberately cheerful without becoming candy: blossom accents sit on plum neutrals, while text and borders stay sober.",
  },
  {
    id: "ade-theme-synthwave",
    name: "Synthwave",
    description: "Electric magenta and cyan over midnight navy, with a bright pastel daytime mix.",
    accent: "#E85DDA",
    light: {
      background: "#F8F5FF", foreground: "#25203A", surface: "#FCFAFF", card: "#FFFFFF", cardRgb: "255, 255, 255",
      secondary: "#EAE3F8", secondaryForeground: "#534B72", muted: "#F0EBFA", mutedForeground: "#746B91", border: "#DAD0EC",
      accent: "#B33AB5", accentForeground: "#FFFFFF", accentBright: "#D85BD1", accentDeep: "#7C278E",
      raised: "#FFFFFF", recessed: "#EDE6F7", popup: "#FEFCFF", sidebarTop: "#F1EAFE", sidebarBottom: "#E4DBF5",
    },
    dark: {
      background: "#090B1A", foreground: "#F2EEFF", surface: "#10142A", card: "#171B36", cardRgb: "23, 27, 54",
      secondary: "#20264A", secondaryForeground: "#C2BCE2", muted: "#181D39", mutedForeground: "#9690B8", border: "#30375E",
      accent: "#F06DE1", accentForeground: "#200A25", accentBright: "#FF93EA", accentDeep: "#A83DB5",
      raised: "#1D2241", recessed: "#060713", popup: "#12162E", sidebarTop: "#171B39", sidebarBottom: "#080A18",
    },
    readme: "Synthwave is the loud one: neon focus and gradient energy, balanced by deep navy surfaces so code and chat remain glanceable.",
  },
  {
    id: "ade-theme-phosphor",
    name: "Phosphor",
    description: "Terminal green, smoked glass and old-computer charm without the eye strain.",
    accent: "#42B883",
    light: {
      background: "#F3F7F1", foreground: "#1C2A22", surface: "#F8FBF6", card: "#FFFFFF", cardRgb: "255, 255, 255",
      secondary: "#E0EAE2", secondaryForeground: "#3F5648", muted: "#E9F0E8", mutedForeground: "#607568", border: "#CAD8CD",
      accent: "#287D55", accentForeground: "#FFFFFF", accentBright: "#42A873", accentDeep: "#185C3B",
      raised: "#FFFFFF", recessed: "#E2EAE0", popup: "#FBFDF9", sidebarTop: "#E7F0E7", sidebarBottom: "#D9E6DB",
    },
    dark: {
      background: "#08110C", foreground: "#DDF7E7", surface: "#0D1912", card: "#13231A", cardRgb: "19, 35, 26",
      secondary: "#1A3023", secondaryForeground: "#ADD2BA", muted: "#14271C", mutedForeground: "#7FA28B", border: "#264332",
      accent: "#63D492", accentForeground: "#07170E", accentBright: "#8BE9AF", accentDeep: "#319D61",
      raised: "#193024", recessed: "#050A07", popup: "#102017", sidebarTop: "#14271C", sidebarBottom: "#060E09",
    },
    readme: "Phosphor borrows the confidence of a green-screen terminal, then softens it with layered glass and modern contrast.",
  },
];

export const MARKETPLACE_OFFICIAL_THEMES = THEMES.map((spec) => ({
  manifest: themeManifest(spec),
  readme: `## ${spec.name}\n\n${spec.readme}\n\nShips coordinated light and dark palettes. Preview it from the Marketplace without installing, then use it when you are ready.`,
}));
