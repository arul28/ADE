import {
  Desktop,
  DeviceMobile,
  FolderOpen,
  GitBranch,
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
   * What this tool is FOR, in three to five words.
   *
   * Shown only when the tool has measured NOTHING yet — a live status ("2
   * shells", "3 tabs · agent") is always the better answer, and a card carrying
   * both is the over-explained layout the picker replaced. It lives on the
   * catalogue rather than in a map beside the picker so the card, the header
   * tooltip and the truncation tooltip all read one string: a picker-local copy
   * meant a clipped card's tooltip showed LESS text than the card it was
   * explaining. Omitted means the tool always has a real status (Files always
   * knows whether the worktree is dirty), so a hint there could never render.
   */
  hint?: string;
  /**
   * The one compact fact the active header shows beside the tool's name.
   *
   * On the definition rather than in a `if (tool === …)` cascade at the header:
   * two of the six tools answer this differently and the rule belongs with
   * the tool. Omitted means "your status line", which is what most tools want.
   */
  contextLabel?: (context: WorkToolHeaderContext) => string | null;
};

/** What a `contextLabel` rule may read. */
export type WorkToolHeaderContext = {
  lane: { branchRef?: string | null; name?: string | null } | null;
  status: { line: string | null } | null;
};

export const WORK_TOOL_DEFINITIONS: readonly WorkToolDefinition[] = [
  {
    id: "terminal",
    label: "Terminal",
    icon: Terminal,
    color: "#c4b5fd",
    hint: "Run a shell here",
  },
  {
    id: "browser",
    label: "Browser",
    icon: Globe,
    color: "#22d3ee",
    hint: "Drive a real browser",
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranch,
    color: "#34d399",
    hint: "Commit, push, rebase",
    // The branch, not the dirty count: the count is already the status line.
    contextLabel: ({ lane }) => lane?.branchRef ?? null,
  },
  {
    id: "files",
    label: "Files",
    icon: FolderOpen,
    color: "#fbbf24",
    contextLabel: ({ lane }) => lane?.name ?? null,
  },
  {
    id: "ios",
    // "Simulator", not "iOS Simulator". The picker already had to shorten it
    // to fit a card, so the pane was calling one tool two names — the card said
    // Simulator, the header and the palette said iOS Simulator. The icon is a
    // phone and the availability rule is "macOS only"; the platform word was
    // never carrying anything the surface did not already say.
    label: "Simulator",
    icon: DeviceMobile,
    color: "#60a5fa",
    hint: "Boot a simulator",
  },
  {
    id: "app-control",
    label: "App Control",
    icon: Desktop,
    color: "#a78bfa",
    hint: "Drive a desktop app",
  },
];

const WORK_TOOL_DEFINITIONS_BY_ID = new Map<WorkSidebarTab, WorkToolDefinition>(
  WORK_TOOL_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function workToolDefinition(id: WorkSidebarTab): WorkToolDefinition | null {
  return WORK_TOOL_DEFINITIONS_BY_ID.get(id) ?? null;
}

/** The header's one fact for a tool: its own rule, or its status line. */
export function workToolContextLabel(id: WorkSidebarTab, context: WorkToolHeaderContext): string | null {
  const definition = WORK_TOOL_DEFINITIONS_BY_ID.get(id);
  if (definition?.contextLabel) return definition.contextLabel(context);
  return context.status?.line ?? null;
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
 *
 * The browser is deliberately NOT here. It is hosted by this desktop's own main
 * process, and a remote lane drives that same window: loopback URLs on the
 * pinned machine are rewritten onto a port-forward (`localizeRemoteLoopbackUrl`)
 * and `ade browser open` run over there is handed to this desktop as a
 * `built_in_browser_remote_request`. Gating it on the project binding took the
 * one tool the tunnel work exists for away from the lanes that need it.
 */
const LOCAL_ONLY_TOOL_IDS = new Set<WorkSidebarTab>(["ios", "app-control"]);

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
  return AVAILABLE;
}

export function isAvailableWorkSidebarTab(
  id: WorkSidebarTab,
  context: WorkToolContext,
): boolean {
  return workToolAvailability(id, context).available;
}
