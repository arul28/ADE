import {
  ChartBar,
  ClipboardText,
  ClockCounterClockwise,
  CloudSun,
  Cpu,
  FolderSimple,
  Gauge,
  GitPullRequest,
  MusicNotes,
  Pulse,
  RocketLaunch,
  SquaresFour,
  Timer,
  type Icon,
} from "@phosphor-icons/react";
import type { HomeWidgetSize, HomeWidgetType } from "./homeLayout";

export type HomeWidgetMeta = {
  title: string;
  description: string;
  icon: Icon;
  sizes: readonly HomeWidgetSize[];
  defaultSize: HomeWidgetSize;
  /**
   * The smallest cell height, in px, at which the card shows every control
   * without clipping, per size (the whole span, header included). The grid
   * never shrinks a row below what its widgets declare; it scrolls instead.
   */
  minHeight: Record<HomeWidgetSize, number>;
  /** Not offered in the gallery yet (a slot reserved for work in progress). */
  comingSoon?: string;
  /** Needs the desktop app's main process (clipboard, ports, weather). */
  desktopOnly?: boolean;
};

export const HOME_WIDGET_CATALOG: Record<HomeWidgetType, HomeWidgetMeta> = {
  projects: {
    title: "Projects",
    description: "Your recent projects, on every machine.",
    icon: FolderSimple,
    sizes: ["s", "m", "l", "w"],
    defaultSize: "m",
    minHeight: { s: 180, m: 240, l: 240, w: 180 },
  },
  running: {
    title: "Working now",
    description: "Chats that are running or waiting on you.",
    icon: Pulse,
    sizes: ["s", "m", "l", "w"],
    defaultSize: "s",
    minHeight: { s: 150, m: 200, l: 200, w: 150 },
  },
  activity: {
    title: "Activity & usage",
    description: "Tokens and spend over the last two weeks.",
    icon: ChartBar,
    sizes: ["w", "l", "s", "m"],
    defaultSize: "w",
    minHeight: { s: 270, m: 270, l: 270, w: 260 },
  },
  limits: {
    title: "Limits & machines",
    description: "Headroom left per provider, and which machines are up.",
    icon: Gauge,
    sizes: ["s", "m", "l", "w"],
    defaultSize: "s",
    minHeight: { s: 200, m: 250, l: 250, w: 200 },
  },
  prs: {
    title: "Pull requests",
    description: "The open project's PRs, checks and this week's merges.",
    icon: GitPullRequest,
    sizes: ["s", "m", "l", "w"],
    defaultSize: "s",
    minHeight: { s: 210, m: 260, l: 260, w: 200 },
  },
  clock: {
    title: "Clock & weather",
    description: "The time, and the weather where you are.",
    icon: CloudSun,
    sizes: ["s", "w", "m", "l"],
    defaultSize: "s",
    minHeight: { s: 200, m: 220, l: 220, w: 190 },
  },
  pomodoro: {
    title: "Focus timer",
    description: "Pomodoro sessions, counted toward a focus streak.",
    icon: Timer,
    sizes: ["s", "w", "m", "l"],
    defaultSize: "s",
    minHeight: { s: 210, m: 230, l: 230, w: 200 },
  },
  clipboard: {
    title: "Clipboard history",
    description: "What you copied recently. Secrets are left out.",
    icon: ClipboardText,
    sizes: ["s", "m", "w", "l"],
    defaultSize: "m",
    minHeight: { s: 200, m: 240, l: 240, w: 200 },
    desktopOnly: true,
  },
  machine: {
    title: "Machine health",
    description: "CPU, memory, disk, and the dev servers holding ports.",
    icon: Cpu,
    sizes: ["s", "m", "w", "l"],
    defaultSize: "m",
    minHeight: { s: 230, m: 330, l: 300, w: 240 },
    desktopOnly: true,
  },
  heatmap: {
    title: "Contributions",
    description: "Your daily activity in ADE, and your streak.",
    icon: SquaresFour,
    sizes: ["w", "l", "s", "m"],
    defaultSize: "w",
    minHeight: { s: 190, m: 220, l: 220, w: 180 },
  },
  shipped: {
    title: "Shipped this week",
    description: "Merged PRs, commits and chats since Monday.",
    icon: RocketLaunch,
    sizes: ["s", "m", "w", "l"],
    defaultSize: "s",
    minHeight: { s: 180, m: 240, l: 240, w: 190 },
  },
  feed: {
    title: "Feed",
    description: "Merges, finished chats, releases and Linear issues, across projects and machines.",
    icon: ClockCounterClockwise,
    sizes: ["m", "l", "s", "w"],
    defaultSize: "m",
    minHeight: { s: 200, m: 260, l: 260, w: 200 },
  },
  nowPlaying: {
    title: "Now playing",
    description: "Apple Music, without leaving ADE.",
    icon: MusicNotes,
    sizes: ["s", "w"],
    defaultSize: "w",
    minHeight: { s: 150, m: 180, l: 180, w: 150 },
    comingSoon: "Arrives with the Music tab.",
  },
};

export const HOME_SIZE_LABEL: Record<HomeWidgetSize, { short: string; long: string }> = {
  s: { short: "S", long: "Small · 1 × 1" },
  m: { short: "M", long: "Medium · 1 × 2, tall" },
  l: { short: "L", long: "Large · 2 × 2" },
  w: { short: "Wide", long: "Wide · 2 × 1" },
};

/** Gallery order: what is new first, then the cards the page shipped with. */
export const HOME_GALLERY_ORDER: readonly HomeWidgetType[] = [
  "feed", "clock", "pomodoro", "clipboard", "machine", "heatmap", "shipped", "nowPlaying",
  "projects", "running", "activity", "limits", "prs",
];
