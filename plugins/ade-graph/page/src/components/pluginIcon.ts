/**
 * Manifest icon names → glyphs, for the nodes a plugin contributes.
 *
 * A narrowed copy of `components/plugins/pluginIcons.tsx`. The app's map is
 * curated for the same reason — a namespace import would drag the whole Phosphor
 * set into the chunk — and this one is curated harder still, because the only
 * thing on this page that draws a plugin icon is a 168px node.
 *
 * An unknown name falls back to the puzzle glyph rather than rendering nothing,
 * exactly as the app's does. Brand tokens (`brand:linear`) resolve to the
 * fallback here: they need the app's brand loader, which a guest cannot reach.
 */

import {
  Bell,
  Bug,
  ChartBar,
  ChatCircleDots,
  Clock,
  Cloud,
  Code,
  Cube,
  Database,
  Flag,
  Folder,
  GearSix,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Globe,
  Graph,
  Kanban,
  Lightning,
  Link,
  ListChecks,
  Package,
  Play,
  Plug,
  PuzzlePiece,
  Robot,
  Rocket,
  ShieldCheck,
  Sparkle,
  Star,
  Tag,
  Terminal,
  Timer,
  TrendUp,
  Warning,
  Wrench,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

const ICONS: Record<string, PhosphorIcon> = {
  bell: Bell,
  bug: Bug,
  "chart-bar": ChartBar,
  chat: ChatCircleDots,
  clock: Clock,
  cloud: Cloud,
  code: Code,
  cube: Cube,
  database: Database,
  flag: Flag,
  folder: Folder,
  gear: GearSix,
  "git-branch": GitBranch,
  "git-commit": GitCommit,
  "git-pull-request": GitPullRequest,
  globe: Globe,
  graph: Graph,
  kanban: Kanban,
  lightning: Lightning,
  link: Link,
  "list-checks": ListChecks,
  package: Package,
  play: Play,
  plug: Plug,
  puzzle: PuzzlePiece,
  robot: Robot,
  rocket: Rocket,
  shield: ShieldCheck,
  sparkle: Sparkle,
  star: Star,
  tag: Tag,
  terminal: Terminal,
  timer: Timer,
  "trend-up": TrendUp,
  warning: Warning,
  wrench: Wrench,
};

export function pluginIcon(name?: string | null): PhosphorIcon {
  if (!name) return PuzzlePiece;
  return ICONS[name.trim().toLowerCase()] ?? PuzzlePiece;
}
