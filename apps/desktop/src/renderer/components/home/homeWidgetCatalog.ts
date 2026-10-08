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
import type { WidgetLimits } from "./homeGridPack";

export type HomeWidgetCategory = "work" | "insights" | "everyday" | "system";

export const HOME_WIDGET_CATEGORIES: ReadonlyArray<{ id: HomeWidgetCategory; label: string }> = [
  { id: "work", label: "Work" },
  { id: "insights", label: "Insights" },
  { id: "everyday", label: "Everyday" },
  { id: "system", label: "This computer" },
];

export type HomeWidgetMeta = {
  title: string;
  category: HomeWidgetCategory;
  /** Resize range in grid cells (columns × rows). Equal min and max lock that axis. */
  limits: { minW: number; maxW: number; minH: number; maxH: number };
  description: string;
  icon: Icon;
  sizes: readonly HomeWidgetSize[];
  defaultSize: HomeWidgetSize;
  /**
   * The smallest cell height, in px, at which the card shows every control
   * without clipping, per size (the whole span, header included). The grid
   * grows a span taller (within the limits) or hides the widget; it never scrolls.
   */
  minHeight: Record<HomeWidgetSize, number>;
  /** Not offered in the gallery yet (a slot reserved for work in progress). */
  comingSoon?: string;
  /** Needs the desktop app's main process (clipboard, ports, weather). */
  desktopOnly?: boolean;
};

export const HOME_WIDGET_CATALOG: Record<HomeWidgetType, HomeWidgetMeta> = {
  projects: {
    category: "work",
    limits: { minW: 1, maxW: 3, minH: 1, maxH: 3 },
    title: "Projects",
    description: "Your recent projects, on every machine.",
    icon: FolderSimple,
    sizes: ["s", "m", "l", "w"],
    defaultSize: "m",
    minHeight: { s: 180, m: 240, l: 240, w: 180 },
  },
  running: {
    category: "work",
    limits: { minW: 1, maxW: 3, minH: 1, maxH: 2 },
    title: "Working now",
    description: "Chats that are running or waiting on you.",
    icon: Pulse,
    sizes: ["s", "m", "l", "w"],
    defaultSize: "s",
    minHeight: { s: 150, m: 200, l: 200, w: 150 },
  },
  activity: {
    category: "insights",
    limits: { minW: 1, maxW: 4, minH: 1, maxH: 2 },
    title: "Activity & usage",
    description: "Tokens and spend over the last two weeks.",
    icon: ChartBar,
    sizes: ["w", "l", "s", "m"],
    defaultSize: "w",
    minHeight: { s: 270, m: 270, l: 270, w: 260 },
  },
  limits: {
    category: "insights",
    limits: { minW: 1, maxW: 3, minH: 1, maxH: 2 },
    title: "Limits & machines",
    description: "Headroom left per provider, and which machines are up.",
    icon: Gauge,
    sizes: ["s", "m", "l", "w"],
    defaultSize: "s",
    minHeight: { s: 200, m: 250, l: 250, w: 200 },
  },
  prs: {
    category: "work",
    limits: { minW: 1, maxW: 3, minH: 1, maxH: 3 },
    title: "Pull requests",
    description: "The open project's PRs, checks and this week's merges.",
    icon: GitPullRequest,
    sizes: ["s", "m", "l", "w"],
    defaultSize: "s",
    minHeight: { s: 210, m: 260, l: 260, w: 200 },
  },
  clock: {
    category: "everyday",
    limits: { minW: 1, maxW: 2, minH: 1, maxH: 2 },
    title: "Clock & weather",
    description: "The time, and the weather where you are.",
    icon: CloudSun,
    sizes: ["s", "w", "m", "l"],
    defaultSize: "s",
    minHeight: { s: 200, m: 220, l: 220, w: 190 },
  },
  pomodoro: {
    category: "everyday",
    limits: { minW: 1, maxW: 2, minH: 1, maxH: 1 },
    title: "Focus timer",
    description: "Pomodoro sessions, counted toward a focus streak.",
    icon: Timer,
    sizes: ["s", "w", "m", "l"],
    defaultSize: "s",
    minHeight: { s: 210, m: 230, l: 230, w: 200 },
  },
  clipboard: {
    category: "system",
    limits: { minW: 1, maxW: 2, minH: 1, maxH: 3 },
    title: "Clipboard history",
    description: "What you copied recently. Secrets are left out.",
    icon: ClipboardText,
    sizes: ["s", "m", "w", "l"],
    defaultSize: "m",
    minHeight: { s: 200, m: 240, l: 240, w: 200 },
    desktopOnly: true,
  },
  machine: {
    category: "system",
    limits: { minW: 1, maxW: 2, minH: 1, maxH: 3 },
    title: "Machine health",
    description: "CPU, memory, disk, and the dev servers holding ports.",
    icon: Cpu,
    sizes: ["s", "m", "w", "l"],
    defaultSize: "m",
    minHeight: { s: 230, m: 330, l: 300, w: 240 },
    desktopOnly: true,
  },
  heatmap: {
    category: "insights",
    limits: { minW: 2, maxW: 4, minH: 1, maxH: 2 },
    title: "Contributions",
    description: "Your daily activity in ADE, and your streak.",
    icon: SquaresFour,
    sizes: ["w", "l", "s", "m"],
    defaultSize: "w",
    minHeight: { s: 190, m: 220, l: 220, w: 180 },
  },
  shipped: {
    category: "work",
    limits: { minW: 1, maxW: 2, minH: 1, maxH: 2 },
    title: "Shipped this week",
    description: "Merged PRs, commits and chats since Monday.",
    icon: RocketLaunch,
    sizes: ["s", "m", "w", "l"],
    defaultSize: "s",
    minHeight: { s: 180, m: 240, l: 240, w: 190 },
  },
  feed: {
    category: "work",
    limits: { minW: 1, maxW: 3, minH: 1, maxH: 3 },
    title: "Feed",
    description: "Merges, finished chats, releases and Linear issues, across projects and machines.",
    icon: ClockCounterClockwise,
    sizes: ["m", "l", "s", "w"],
    defaultSize: "m",
    minHeight: { s: 200, m: 260, l: 260, w: 200 },
  },
  nowPlaying: {
    category: "everyday",
    limits: { minW: 1, maxW: 2, minH: 1, maxH: 1 },
    title: "Now playing",
    description: "What any app is playing, with play, pause and skip.",
    icon: MusicNotes,
    sizes: ["s", "w"],
    defaultSize: "w",
    minHeight: { s: 210, m: 210, l: 210, w: 160 },
    desktopOnly: true,
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

/** A widget's limits in the shape the grid packer reads. */
export function widgetLimits(type: HomeWidgetType): WidgetLimits {
  const meta = HOME_WIDGET_CATALOG[type];
  return { ...meta.limits, minHeight: meta.minHeight };
}
