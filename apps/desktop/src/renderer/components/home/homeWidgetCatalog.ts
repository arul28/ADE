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
import type { HomeWidgetType } from "./homeLayout";
import type { HomeSizeClass, Span, WidgetShape } from "./homeGridPack";

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
  description: string;
  icon: Icon;
  /** The size classes it offers, as columns × rows. */
  classes: Partial<Record<HomeSizeClass, Span>>;
  defaultClass: HomeSizeClass;
  /**
   * The smallest card height, in px, at which the card shows every control
   * without clipping, per class (header included). The layout grows a span
   * taller, shows a smaller class, or hides the widget; it never scrolls.
   */
  minHeight: Partial<Record<HomeSizeClass, number>>;
  /** Uses extra room well (a list shows more rows, a chart gets bigger), so it gets leftover space first. */
  grow: boolean;
  /** Not offered in the gallery yet (a slot reserved for work in progress). */
  comingSoon?: string;
  /** Needs the desktop app's main process (clipboard, ports, weather). */
  desktopOnly?: boolean;
};

export const HOME_WIDGET_CATALOG: Record<HomeWidgetType, HomeWidgetMeta> = {
  projects: {
    category: "work",
    title: "Projects",
    description: "Your recent projects, on every machine.",
    icon: FolderSimple,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 }, large: { w: 2, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 180, regular: 240, large: 240 },
    grow: true,
  },
  running: {
    category: "work",
    title: "Working now",
    description: "Chats that are running or waiting on you.",
    icon: Pulse,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 } },
    defaultClass: "compact",
    minHeight: { compact: 150, regular: 200 },
    grow: true,
  },
  activity: {
    category: "insights",
    title: "Activity & usage",
    description: "Tokens and spend over the last two weeks.",
    icon: ChartBar,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 2, h: 1 }, large: { w: 2, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 200, regular: 200, large: 300 },
    grow: true,
  },
  limits: {
    category: "insights",
    title: "Limits & machines",
    description: "Headroom left per provider, and which machines are up.",
    icon: Gauge,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 } },
    defaultClass: "compact",
    minHeight: { compact: 200, regular: 250 },
    grow: true,
  },
  prs: {
    category: "work",
    title: "Pull requests",
    description: "The open project's PRs, checks and this week's merges.",
    icon: GitPullRequest,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 }, large: { w: 2, h: 2 } },
    defaultClass: "compact",
    minHeight: { compact: 200, regular: 260, large: 260 },
    grow: true,
  },
  clock: {
    category: "everyday",
    title: "Clock & weather",
    description: "The time, and the weather where you are.",
    icon: CloudSun,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 2, h: 1 } },
    defaultClass: "compact",
    minHeight: { compact: 190, regular: 190 },
    grow: false,
  },
  pomodoro: {
    category: "everyday",
    title: "Focus timer",
    description: "Pomodoro sessions, counted toward a focus streak.",
    icon: Timer,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 2, h: 1 } },
    defaultClass: "compact",
    minHeight: { compact: 210, regular: 200 },
    grow: false,
  },
  clipboard: {
    category: "system",
    title: "Clipboard history",
    description: "What you copied recently. Secrets are left out.",
    icon: ClipboardText,
    desktopOnly: true,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 180, regular: 240 },
    grow: true,
  },
  machine: {
    category: "system",
    title: "Machine health",
    description: "CPU, memory, disks, network, the biggest apps, and the dev servers holding ports.",
    icon: Cpu,
    desktopOnly: true,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 }, large: { w: 2, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 230, regular: 330, large: 330 },
    grow: true,
  },
  heatmap: {
    category: "insights",
    title: "Contributions",
    description: "Your daily activity in ADE, and your streak.",
    icon: SquaresFour,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 2, h: 1 }, large: { w: 2, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 190, regular: 190, large: 300 },
    grow: true,
  },
  shipped: {
    category: "work",
    title: "Shipped this week",
    description: "Merged PRs, commits and chats since Monday.",
    icon: RocketLaunch,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 } },
    defaultClass: "compact",
    minHeight: { compact: 180, regular: 240 },
    grow: true,
  },
  feed: {
    category: "work",
    title: "Feed",
    description: "Merges, finished chats, releases and Linear issues, across projects and machines.",
    icon: ClockCounterClockwise,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 }, large: { w: 2, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 180, regular: 240, large: 240 },
    grow: true,
  },
  nowPlaying: {
    category: "everyday",
    title: "Now playing",
    description: "What any app is playing, with play, pause and skip.",
    icon: MusicNotes,
    desktopOnly: true,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 2, h: 1 } },
    defaultClass: "regular",
    minHeight: { compact: 210, regular: 160 },
    grow: false,
  },
};

export const HOME_CLASS_LABEL: Record<HomeSizeClass, { short: string; long: string }> = {
  compact: { short: "S", long: "Compact" },
  regular: { short: "M", long: "Regular" },
  large: { short: "L", long: "Large" },
};

/** Gallery order: what is new first, then the cards the page shipped with. */
export const HOME_GALLERY_ORDER: readonly HomeWidgetType[] = [
  "feed", "clock", "pomodoro", "clipboard", "machine", "heatmap", "shipped", "nowPlaying",
  "projects", "running", "activity", "limits", "prs",
];

/** A widget's shape in the form the layout engine reads. */
export function widgetShape(type: HomeWidgetType): WidgetShape {
  const meta = HOME_WIDGET_CATALOG[type];
  return { classes: meta.classes, minHeight: meta.minHeight, grow: meta.grow };
}
