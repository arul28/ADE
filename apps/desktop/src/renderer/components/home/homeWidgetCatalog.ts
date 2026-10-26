import {
  ChartBar,
  ClipboardText,
  ClockCounterClockwise,
  CloudSun,
  Cpu,
  FolderSimple,
  Gauge,
  GitPullRequest,
  Lightbulb,
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
  idealHeight: Partial<Record<HomeSizeClass, number>>;
  maxHeight: Partial<Record<HomeSizeClass, number>>;
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
    description: "Recent projects on every machine.",
    icon: FolderSimple,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 }, large: { w: 2, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 180, regular: 240, large: 240 },
    idealHeight: { compact: 180, regular: 240, large: 240 },
    maxHeight: { compact: 480, regular: 480, large: 480 },
    grow: true,
  },
  running: {
    category: "work",
    title: "Working now",
    description: "Chats running or waiting on you.",
    icon: Pulse,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 } },
    defaultClass: "compact",
    minHeight: { compact: 150, regular: 200 },
    idealHeight: { compact: 150, regular: 200 },
    maxHeight: { compact: 480, regular: 480 },
    grow: true,
  },
  activity: {
    category: "insights",
    title: "Activity & usage",
    description: "Tokens and spend, last two weeks.",
    icon: ChartBar,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 2, h: 1 }, large: { w: 2, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 200, regular: 200, large: 300 },
    idealHeight: { compact: 200, regular: 200, large: 300 },
    maxHeight: { compact: 480, regular: 480, large: 600 },
    grow: true,
  },
  limits: {
    category: "insights",
    title: "Limits & machines",
    description: "Provider headroom and machines.",
    icon: Gauge,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 } },
    defaultClass: "compact",
    minHeight: { compact: 200, regular: 250 },
    idealHeight: { compact: 200, regular: 250 },
    maxHeight: { compact: 480, regular: 500 },
    grow: true,
  },
  prs: {
    category: "work",
    title: "Pull requests",
    description: "This project's PRs and checks.",
    icon: GitPullRequest,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 }, large: { w: 2, h: 2 } },
    defaultClass: "compact",
    minHeight: { compact: 200, regular: 260, large: 260 },
    idealHeight: { compact: 200, regular: 260, large: 260 },
    maxHeight: { compact: 480, regular: 520, large: 520 },
    grow: true,
  },
  clock: {
    category: "everyday",
    title: "Clock & weather",
    description: "The time and your weather.",
    icon: CloudSun,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 2, h: 1 } },
    defaultClass: "compact",
    minHeight: { compact: 190, regular: 190 },
    idealHeight: { compact: 190, regular: 190 },
    maxHeight: { compact: 480, regular: 480 },
    grow: false,
  },
  pomodoro: {
    category: "everyday",
    title: "Focus timer",
    description: "Pomodoro sessions and streak.",
    icon: Timer,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 2, h: 1 } },
    defaultClass: "compact",
    minHeight: { compact: 210, regular: 200 },
    idealHeight: { compact: 210, regular: 200 },
    maxHeight: { compact: 480, regular: 480 },
    grow: false,
  },
  clipboard: {
    category: "system",
    title: "Clipboard history",
    description: "Recent copies, secrets left out.",
    icon: ClipboardText,
    desktopOnly: true,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 180, regular: 240 },
    idealHeight: { compact: 180, regular: 240 },
    maxHeight: { compact: 480, regular: 480 },
    grow: true,
  },
  machine: {
    category: "system",
    title: "Machine health",
    description: "CPU, memory, disks and ports.",
    icon: Cpu,
    desktopOnly: true,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 }, large: { w: 2, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 230, regular: 330, large: 330 },
    idealHeight: { compact: 230, regular: 330, large: 330 },
    maxHeight: { compact: 480, regular: 660, large: 660 },
    grow: true,
  },
  heatmap: {
    category: "insights",
    title: "Contributions",
    description: "Your contributions, day by day.",
    icon: SquaresFour,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 2, h: 1 }, large: { w: 2, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 190, regular: 190, large: 300 },
    idealHeight: { compact: 190, regular: 190, large: 300 },
    maxHeight: { compact: 480, regular: 480, large: 600 },
    grow: true,
  },
  shipped: {
    category: "work",
    title: "Shipped this week",
    description: "Merged PRs, commits and chats.",
    icon: RocketLaunch,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 } },
    defaultClass: "compact",
    minHeight: { compact: 180, regular: 240 },
    idealHeight: { compact: 180, regular: 240 },
    maxHeight: { compact: 480, regular: 480 },
    grow: true,
  },
  feed: {
    category: "work",
    title: "Feed",
    description: "Merges, chats, releases, issues.",
    icon: ClockCounterClockwise,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 1, h: 2 }, large: { w: 2, h: 2 } },
    defaultClass: "regular",
    minHeight: { compact: 180, regular: 240, large: 240 },
    idealHeight: { compact: 180, regular: 240, large: 240 },
    maxHeight: { compact: 480, regular: 480, large: 480 },
    grow: true,
  },
  nowPlaying: {
    category: "everyday",
    title: "Now playing",
    description: "What's playing, with controls.",
    icon: MusicNotes,
    desktopOnly: true,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 2, h: 1 } },
    defaultClass: "regular",
    minHeight: { compact: 210, regular: 160 },
    idealHeight: { compact: 210, regular: 160 },
    maxHeight: { compact: 480, regular: 480 },
    grow: false,
  },
  tips: {
    category: "everyday",
    title: "ADE Tips",
    description: "One ADE tip a day, to try.",
    icon: Lightbulb,
    classes: { compact: { w: 1, h: 1 }, regular: { w: 2, h: 1 } },
    defaultClass: "compact",
    minHeight: { compact: 190, regular: 160 },
    idealHeight: { compact: 200, regular: 170 },
    maxHeight: { compact: 320, regular: 280 },
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
  "tips", "feed", "clock", "pomodoro", "clipboard", "machine", "heatmap", "shipped", "nowPlaying",
  "projects", "running", "activity", "limits", "prs",
];

/** A widget's shape in the form the layout engine reads. */
export function widgetShape(type: HomeWidgetType): WidgetShape {
  const meta = HOME_WIDGET_CATALOG[type];
  return {
    classes: meta.classes,
    minHeight: meta.minHeight,
    idealHeight: meta.idealHeight,
    maxHeight: meta.maxHeight,
    grow: meta.grow,
  };
}
