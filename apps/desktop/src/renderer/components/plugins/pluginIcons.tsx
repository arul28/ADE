import {
  Bell,
  Bookmark,
  Brain,
  Bug,
  Calendar,
  ChartBar,
  ChartLine,
  ChatCircleDots,
  Clock,
  Cloud,
  Code,
  Compass,
  Cube,
  CurrencyDollar,
  Database,
  EnvelopeSimple,
  Eye,
  FileCode,
  Flag,
  Folder,
  GearSix,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Globe,
  Graph,
  Heart,
  Image,
  Kanban,
  Key,
  Lightning,
  Link,
  ListChecks,
  Lock,
  MagicWand,
  Microphone,
  MusicNote,
  Note,
  Package,
  Palette,
  Play,
  Plug,
  PuzzlePiece,
  Robot,
  Rocket,
  ShieldCheck,
  Sparkle,
  Star,
  Storefront,
  Table,
  Tag,
  Terminal,
  Timer,
  Toolbox,
  TrendUp,
  UsersThree,
  VideoCamera,
  Wrench,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

/**
 * Manifest icon names → glyphs.
 *
 * Deliberately a curated map rather than `import * as PhosphorIcons`. A
 * namespace import defeats tree-shaking for whatever chunk it lands in, and the
 * tab rail lives in the always-loaded shell chunk — the whole Phosphor set would
 * ride along with it. Authors pick a name from this list; anything else falls
 * back to the puzzle glyph rather than rendering nothing.
 *
 * Adding a name here is additive and safe. Removing one is not: a plugin already
 * shipped with that icon silently changes appearance.
 */
const PLUGIN_ICONS: Record<string, PhosphorIcon> = {
  bell: Bell,
  bookmark: Bookmark,
  brain: Brain,
  bug: Bug,
  calendar: Calendar,
  chart: ChartLine,
  "chart-bar": ChartBar,
  chat: ChatCircleDots,
  clock: Clock,
  cloud: Cloud,
  code: Code,
  compass: Compass,
  cube: Cube,
  currency: CurrencyDollar,
  database: Database,
  envelope: EnvelopeSimple,
  eye: Eye,
  file: FileCode,
  flag: Flag,
  folder: Folder,
  gear: GearSix,
  "git-branch": GitBranch,
  "git-commit": GitCommit,
  "git-pull-request": GitPullRequest,
  globe: Globe,
  graph: Graph,
  heart: Heart,
  image: Image,
  kanban: Kanban,
  key: Key,
  lightning: Lightning,
  link: Link,
  list: ListChecks,
  lock: Lock,
  magic: MagicWand,
  microphone: Microphone,
  music: MusicNote,
  note: Note,
  package: Package,
  palette: Palette,
  play: Play,
  plug: Plug,
  puzzle: PuzzlePiece,
  robot: Robot,
  rocket: Rocket,
  shield: ShieldCheck,
  sparkle: Sparkle,
  star: Star,
  storefront: Storefront,
  table: Table,
  tag: Tag,
  terminal: Terminal,
  timer: Timer,
  toolbox: Toolbox,
  trend: TrendUp,
  users: UsersThree,
  video: VideoCamera,
  wrench: Wrench,
};

/** The glyph for a plugin that named no icon, or named one this build lacks. */
export const DEFAULT_PLUGIN_ICON: PhosphorIcon = PuzzlePiece;

/** The Marketplace's own nav glyph. Exported so the rail and the page agree. */
export const MARKETPLACE_ICON: PhosphorIcon = Storefront;

/** Icon names a manifest may use, for docs and the authoring skill. */
export const PLUGIN_ICON_NAMES: readonly string[] = Object.keys(PLUGIN_ICONS).sort();

/**
 * Resolve a manifest icon name. Never returns null — unknown names degrade.
 *
 * `Object.hasOwn`, not a plain lookup: the name comes from an untrusted
 * manifest, and `"constructor"` or `"toString"` resolve through the prototype
 * chain to functions that are not components. React throws on the first one it
 * is asked to render, and a tab-rail glyph renders above the route's error
 * boundary — so a one-word manifest field could take the whole app chrome down.
 */
export function pluginIcon(name: string | null | undefined): PhosphorIcon {
  const key = (name ?? "").trim().toLowerCase();
  return Object.hasOwn(PLUGIN_ICONS, key) ? PLUGIN_ICONS[key]! : DEFAULT_PLUGIN_ICON;
}

/* ── Identity ───────────────────────────────────────────────────────────── */

/**
 * The glyphs a plugin gets when it names none.
 *
 * A subset of {@link PLUGIN_ICONS}, and a subset for a reason: this list is
 * what an unnamed plugin is DRAWN AS, so it holds only glyphs that read as a
 * generic piece of software. `heart`, `currency` and `bug` are all legal icon
 * names and none of them should ever be assigned to a plugin that did not ask
 * for one — a payments glyph on a colour theme is worse than a puzzle piece.
 *
 * Order is part of the contract: the assignment is `hash % length`, so
 * inserting a name in the middle re-skins every plugin after it. Append only.
 */
export const PLUGIN_IDENTITY_GLYPHS: readonly string[] = [
  "puzzle",
  "cube",
  "package",
  "plug",
  "toolbox",
  "sparkle",
  "compass",
  "graph",
  "kanban",
  "table",
  "list",
  "note",
  "terminal",
  "code",
  "file",
  "folder",
  "database",
  "cloud",
  "lightning",
  "rocket",
  "palette",
  "magic",
  "gear",
  "globe",
];

/**
 * The colours those glyphs are drawn in.
 *
 * Tokens, declared per theme in `index.css`, because the tile inverts between
 * light and dark and a fixed hex would be unreadable on one of them. Same
 * append-only rule as the glyph list.
 */
export const PLUGIN_IDENTITY_COLORS: readonly string[] = [
  "var(--plugin-identity-0)",
  "var(--plugin-identity-1)",
  "var(--plugin-identity-2)",
  "var(--plugin-identity-3)",
  "var(--plugin-identity-4)",
  "var(--plugin-identity-5)",
  "var(--plugin-identity-6)",
  "var(--plugin-identity-7)",
];

/**
 * FNV-1a over the plugin id.
 *
 * Any stable hash would do; what matters is that it is computed HERE rather
 * than stored anywhere. A plugin's derived look must be identical on every
 * machine, in the gallery and in the tab rail, before and after it is
 * installed, and the only input that is the same in all four places is the id.
 */
function hashPluginId(pluginId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < pluginId.length; index += 1) {
    hash ^= pluginId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export type PluginIdentity = {
  Icon: PhosphorIcon;
  /** A CSS colour — a theme token when derived, a published hex when named. */
  color: string;
  /** Set only when the plugin published an image. */
  imageUrl: string | null;
};

/**
 * What a plugin looks like.
 *
 * Three layers, in order: a published image wins, then a published glyph and
 * colour, then a pair derived from the id. There is deliberately no fourth
 * layer where a plugin has no identity at all — an unstyled row in a
 * catalogue reads as broken, and "the author didn't fill in a field" is not
 * something a reader should be able to see.
 *
 * The derived pair is two independent draws off one hash so that two plugins
 * sharing a glyph are unlikely to share its colour as well.
 */
export function pluginIdentity(input: {
  pluginId: string;
  icon?: string | null;
  accent?: string | null;
  iconUrl?: string | null;
}): PluginIdentity {
  const hash = hashPluginId(input.pluginId);
  const named = (input.icon ?? "").trim().toLowerCase();
  const hasNamedIcon = named.length > 0 && Object.hasOwn(PLUGIN_ICONS, named);
  const glyph = hasNamedIcon
    ? named
    : PLUGIN_IDENTITY_GLYPHS[hash % PLUGIN_IDENTITY_GLYPHS.length]!;
  const accent = (input.accent ?? "").trim();
  const color = accent.length > 0
    ? accent
    // A second, decorrelated draw: `hash >>> 8` so a glyph collision does not
    // drag the colour along with it.
    : PLUGIN_IDENTITY_COLORS[(hash >>> 8) % PLUGIN_IDENTITY_COLORS.length]!;
  return {
    Icon: pluginIcon(glyph),
    color,
    imageUrl: input.iconUrl?.trim() ? input.iconUrl.trim() : null,
  };
}
