import {
  ChartBar,
  ClipboardText,
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
  },
  running: {
    title: "Working now",
    description: "Chats that are running or waiting on you.",
    icon: Pulse,
    sizes: ["s", "m", "l", "w"],
    defaultSize: "s",
  },
  activity: {
    title: "Activity & usage",
    description: "Tokens and spend over the last two weeks.",
    icon: ChartBar,
    sizes: ["w", "l", "s", "m"],
    defaultSize: "w",
  },
  limits: {
    title: "Limits & machines",
    description: "Headroom left per provider, and which machines are up.",
    icon: Gauge,
    sizes: ["s", "m", "l", "w"],
    defaultSize: "s",
  },
  prs: {
    title: "Pull requests",
    description: "The open project's PRs, checks and this week's merges.",
    icon: GitPullRequest,
    sizes: ["s", "m", "l", "w"],
    defaultSize: "s",
  },
  clock: {
    title: "Clock & weather",
    description: "The time, and the weather where you are.",
    icon: CloudSun,
    sizes: ["s", "w", "m", "l"],
    defaultSize: "s",
  },
  pomodoro: {
    title: "Focus timer",
    description: "Pomodoro sessions, counted toward a focus streak.",
    icon: Timer,
    sizes: ["s", "w", "m", "l"],
    defaultSize: "s",
  },
  clipboard: {
    title: "Clipboard history",
    description: "What you copied recently. Secrets are left out.",
    icon: ClipboardText,
    sizes: ["s", "m", "w", "l"],
    defaultSize: "m",
    desktopOnly: true,
  },
  machine: {
    title: "Machine health",
    description: "CPU, memory, disk, and the dev servers holding ports.",
    icon: Cpu,
    sizes: ["s", "m", "w", "l"],
    defaultSize: "m",
    desktopOnly: true,
  },
  heatmap: {
    title: "Contributions",
    description: "Your daily activity in ADE, and your streak.",
    icon: SquaresFour,
    sizes: ["w", "l", "s", "m"],
    defaultSize: "w",
  },
  shipped: {
    title: "Shipped this week",
    description: "Merged PRs, commits and chats since Monday.",
    icon: RocketLaunch,
    sizes: ["s", "m", "w", "l"],
    defaultSize: "s",
  },
  nowPlaying: {
    title: "Now playing",
    description: "Apple Music, without leaving ADE.",
    icon: MusicNotes,
    sizes: ["s", "w"],
    defaultSize: "w",
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
  "clock", "pomodoro", "clipboard", "machine", "heatmap", "shipped", "nowPlaying",
  "projects", "running", "activity", "limits", "prs",
];
