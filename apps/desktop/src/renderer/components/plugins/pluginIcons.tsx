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
