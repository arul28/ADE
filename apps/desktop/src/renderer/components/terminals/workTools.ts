import {
  Desktop,
  FolderOpen,
  GitBranch,
  Globe,
  Terminal,
  type Icon,
} from "@phosphor-icons/react";
import { AppleLogo } from "../ui/appleIcons";
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
  /**
   * Name on the tools tab strip. Omitted means the card label is also the tab
   * name, which is now true of every tool: the Apple card used to read
   * "Simulator" while its tab read "Apple", and one tool with two names is one
   * name too many (spec §0).
   */
  tabLabel?: string;
  /**
   * Idle-tab tooltip. When omitted, the tab uses the same summary as the card.
   */
  tabTooltip?: string;
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
    /*
     * One name everywhere: card, tab, palette, settings, docs, CLI, phone and
     * web (§B1). Round 2 called it "Apple", which named the company rather
     * than the work and sat under a generic phone glyph that could equally
     * have been the browser's. The subtitle is the device and what it is doing
     * (`appleToolCardSubtitle`), which is the part worth reading twice.
     */
    label: "Apple Development",
    tabTooltip: "Apple simulators and previews",
    icon: AppleLogo,
    color: "#60a5fa",
    hint: "Open an Apple device",
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
  const definition = WORK_TOOL_DEFINITIONS_BY_ID.get(id);
  return definition?.tabLabel ?? definition?.label ?? id;
}

/** Card / picker name. Identical to `workToolLabel` for every tool today. */
export function workToolCardLabel(id: WorkSidebarTab): string {
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
  /**
   * The bound runtime can host an iOS simulator.
   *
   * This is `iosSimulator.getStatus().supported` for that runtime, not the
   * viewer's OS. A Windows desktop pinned to a Mac reports true; a Linux
   * runtime reports false.
   */
  supportsIosSimulator: boolean;
  /** Running as the hosted browser web client, where native namespaces are stubs. */
  isWebClient: boolean;
};

export type WorkToolAvailability =
  | { available: true; reason: null }
  | { available: false; reason: string };

const AVAILABLE: WorkToolAvailability = { available: true, reason: null };

/**
 * Tools the web client cannot DRIVE but can WATCH.
 *
 * The browser and App Control both leave a describable trail on the machine —
 * a tab list, an attached app, a screenshot — so the hosted client shows that
 * read-only rather than a dead "Desktop app only" card. The iOS simulator is
 * absent from this set because it is not read-only on the web at all: the
 * hosted client drives the device for real over the brain's H.264 pipe.
 */
const WEB_READ_ONLY_TOOL_IDS = new Set<WorkSidebarTab>(["browser", "app-control"]);

/*
 * There is deliberately no "local only" set any more.
 *
 * Work tools follow the SESSION's machine, not the project tab's binding, so a
 * remote-pinned session is a first-class driver rather than a dimmed card. The
 * browser is hosted by this desktop's own main process and reaches a remote
 * lane's loopback URLs through a port-forward; App Control attaches over the
 * session's runtime; and the Apple device environment runs its helper — H.264
 * encode and touch injection alike — entirely on the bound runtime. That last
 * one is also why Apple is absent from the web read-only set above: a browser
 * tab needs no native namespace to drive it, only the brain's video pipe and
 * the `apple.*` commands. The viewer's OS is irrelevant; Apple's availability
 * follows the bound runtime's `status.supported` and nothing else.
 */

/** Shown on the picker when the bound runtime reports `supported: false`. */
export const IOS_RUNTIME_UNSUPPORTED_REASON = "The runtime for this project is not a Mac";

/** True when this surface may only observe the tool, never operate it. */
export function isReadOnlyWorkTool(id: WorkSidebarTab, context: WorkToolContext): boolean {
  return context.isWebClient && WEB_READ_ONLY_TOOL_IDS.has(id);
}

export function workToolAvailability(
  id: WorkSidebarTab,
  context: WorkToolContext,
): WorkToolAvailability {
  if (isReadOnlyWorkTool(id, context)) return AVAILABLE;
  if (id === "ios" && !context.supportsIosSimulator) {
    return { available: false, reason: IOS_RUNTIME_UNSUPPORTED_REASON };
  }
  return AVAILABLE;
}

export function isAvailableWorkSidebarTab(
  id: WorkSidebarTab,
  context: WorkToolContext,
): boolean {
  return workToolAvailability(id, context).available;
}
