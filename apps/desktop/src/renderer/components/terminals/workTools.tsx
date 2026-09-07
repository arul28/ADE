import {
  Desktop,
  DeviceMobile,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Globe,
  Terminal,
  type Icon,
} from "@phosphor-icons/react";
import type { WorkSidebarTab } from "../../state/appStore";

/**
 * The Work tools pane's catalogue.
 *
 * One definition per tool, in the order the picker shows them. Everything that
 * needs to name, colour, or gate a tool reads this list — the picker grid, the
 * active header, the activity dots, and the command palette — so a new tool is
 * one entry rather than six parallel switch statements.
 */
export type WorkToolDefinition = {
  id: WorkSidebarTab;
  label: string;
  icon: Icon;
  /** Accent for the card glyph and the active header icon. */
  color: string;
  /**
   * What the tool is for, in the user's words. Shown on a card only when the
   * tool has no live status to report — never as a stand-in for one.
   */
  blurb: string;
};

export const WORK_TOOL_DEFINITIONS: readonly WorkToolDefinition[] = [
  {
    id: "terminal",
    label: "Terminal",
    icon: Terminal,
    color: "#c4b5fd",
    blurb: "Shells attached to this session",
  },
  {
    id: "browser",
    label: "Browser",
    icon: Globe,
    color: "#22d3ee",
    blurb: "Open a page the agent can read",
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranch,
    color: "#34d399",
    blurb: "Stage, commit, and read diffs",
  },
  {
    id: "files",
    label: "Files",
    icon: FolderOpen,
    color: "#fbbf24",
    blurb: "Browse and edit the lane worktree",
  },
  {
    id: "ios",
    label: "iOS Simulator",
    icon: DeviceMobile,
    color: "#60a5fa",
    blurb: "Run and drive the app on a simulator",
  },
  {
    id: "app-control",
    label: "App Control",
    icon: Desktop,
    color: "#a78bfa",
    blurb: "Attach to a desktop app and drive it",
  },
  {
    id: "pr",
    label: "Pull request",
    icon: GitPullRequest,
    color: "#f472b6",
    blurb: "Open a PR for this lane",
  },
];

const WORK_TOOL_DEFINITIONS_BY_ID = new Map<WorkSidebarTab, WorkToolDefinition>(
  WORK_TOOL_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function workToolDefinition(id: WorkSidebarTab): WorkToolDefinition | null {
  return WORK_TOOL_DEFINITIONS_BY_ID.get(id) ?? null;
}

export function workToolLabel(id: WorkSidebarTab): string {
  return WORK_TOOL_DEFINITIONS_BY_ID.get(id)?.label ?? id;
}

/**
 * Everything the pane needs to decide whether a tool can run *here*.
 *
 * Deliberately capability flags rather than `process.platform` / "is this
 * Electron": the hosted web client renders this exact component, and its
 * `iosSimulator` / `appControl` / `builtInBrowser` namespaces are stubs. A
 * platform sniff in the renderer would offer it three tools that answer nothing.
 */
export type WorkToolContext = {
  /** The project tab is bound to another machine over SSH. */
  isRemoteProject: boolean;
  /** This computer can host an iOS simulator. */
  supportsIosSimulator: boolean;
  /** Running as the hosted browser web client, where native namespaces are stubs. */
  isWebClient: boolean;
};

export type WorkToolAvailability =
  | { available: true; reason: null }
  | { available: false; reason: string };

const AVAILABLE: WorkToolAvailability = { available: true, reason: null };

/**
 * Tools that drive something on *this* computer through a native namespace. A
 * remote project's work happens elsewhere and the web client has no namespace
 * at all, so both get the same honest sentence rather than a hidden card.
 */
const LOCAL_ONLY_TOOL_IDS = new Set<WorkSidebarTab>(["browser", "ios", "app-control"]);

/**
 * Tools the web client cannot DRIVE but can WATCH.
 *
 * The browser and App Control both leave a describable trail on the machine —
 * a tab list, an attached app, a screenshot — so the hosted client shows that
 * read-only rather than a dead "Desktop app only" card. The iOS simulator is
 * absent from this set because there is nothing equivalent to report: its pane
 * is a live video stream and nothing else.
 */
const WEB_READ_ONLY_TOOL_IDS = new Set<WorkSidebarTab>(["browser", "app-control"]);

/** True when this surface may only observe the tool, never operate it. */
export function isReadOnlyWorkTool(id: WorkSidebarTab, context: WorkToolContext): boolean {
  return context.isWebClient && WEB_READ_ONLY_TOOL_IDS.has(id);
}

export function workToolAvailability(
  id: WorkSidebarTab,
  context: WorkToolContext,
): WorkToolAvailability {
  if (isReadOnlyWorkTool(id, context)) return AVAILABLE;
  if (LOCAL_ONLY_TOOL_IDS.has(id)) {
    if (context.isWebClient) return { available: false, reason: "Desktop app only" };
    if (context.isRemoteProject) return { available: false, reason: "Runs on this computer only" };
  }
  if (id === "ios" && !context.supportsIosSimulator) {
    return { available: false, reason: "macOS only" };
  }
  if (id === "pr" && context.isRemoteProject) {
    return { available: false, reason: "Open the PRs tab for remote projects" };
  }
  return AVAILABLE;
}

export function isAvailableWorkSidebarTab(
  id: WorkSidebarTab,
  context: WorkToolContext,
): boolean {
  return workToolAvailability(id, context).available;
}
