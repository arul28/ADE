import {
  ChatsCircle,
  Desktop,
  FolderOpen,
  WindowsLogo,
  GitBranch,
  GithubLogo,
  Globe,
  Ticket,
  Monitor,
  Terminal,
  type Icon,
} from "@phosphor-icons/react";
import { AppleLogo } from "../ui/appleIcons";
import type { WorkSidebarTab } from "../../state/appStore";
import { desktopProductName } from "../../../shared/types/macDesktop";

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
   * name, which is true of every tool: one tool with two names is one name too
   * many.
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

/** The Side chat tool's color, shared with its marks on the header and the session card. */
export const SIDE_CHAT_TOOL_COLOR = "#5eead4";

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
    id: "pr",
    label: "PR",
    icon: GithubLogo,
    color: "#3fb950",
    hint: "Open or create a PR",
  },
  {
    id: "issues",
    label: "Issues",
    tabTooltip: "Linear issues opened from this lane's chats",
    icon: Ticket,
    color: "#a5b4fc",
    hint: "Read an issue beside the chat",
  },
  {
    // Opened by `/side` in a chat's composer, and shown only for a chat that
    // has a side chat (`workToolAvailability`), so it never sits in the
    // picker as a card you could open with nothing behind it.
    id: "side-chat",
    label: "Side chat",
    tabTooltip: "This chat's read-only side chat",
    icon: ChatsCircle,
    color: SIDE_CHAT_TOOL_COLOR,
    hint: "Ask without cluttering the chat",
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
     * web. Not "Apple", which names the company rather than the work. The
     * subtitle is the device and what it is doing
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
    hint: "Drive an Electron app",
  },
  {
    id: "mac-desktop",
    label: "Mac Desktop",
    icon: Monitor,
    color: "#f472b6",
    // Only ever seen while the host's capability answer is still in flight or
    // unreachable: on a Mac host the card's line is the lane's own screen
    // state (`useMacDesktopToolStatus`). Phrased as the line it usually
    // resolves to, so the card does not change its mind a beat later.
    hint: "Mac Desktop is off",
  },
  {
    id: "windows-desktop",
    label: "Windows Desktop",
    icon: WindowsLogo,
    color: "#38bdf8",
    // Only ever seen while the host's capability answer is in flight or
    // unreachable: on a Windows host the card's line is the lane's own screen
    // state. Phrased as the line it usually resolves to.
    hint: "Windows Desktop is off",
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

/**
 * On a Linux host the lane-screen tool is the same pane as Mac Desktop (the
 * service, stream and takeover are shared), named for the host it runs on.
 */
function hostLaneScreenLabel(id: WorkSidebarTab, hostPlatform: NodeJS.Platform | null): string | null {
  return id === "mac-desktop" && hostPlatform === "linux" ? desktopProductName("linux") : null;
}

/**
 * The platform is required, not defaulted: a caller that has the host in hand
 * and forgets to pass it names the tool for the wrong product on Linux with
 * no error, and the compiler cannot help if the argument is optional.
 */
export function workToolLabel(id: WorkSidebarTab, hostPlatform: NodeJS.Platform | null): string {
  const definition = WORK_TOOL_DEFINITIONS_BY_ID.get(id);
  return hostLaneScreenLabel(id, hostPlatform) ?? definition?.tabLabel ?? definition?.label ?? id;
}

/** Card / picker name. Identical to `workToolLabel` for every tool today. */
export function workToolCardLabel(id: WorkSidebarTab, hostPlatform: NodeJS.Platform | null): string {
  return hostLaneScreenLabel(id, hostPlatform) ?? WORK_TOOL_DEFINITIONS_BY_ID.get(id)?.label ?? id;
}

/**
 * The definition's one line, named for the host it runs on.
 *
 * The lane-screen tool is "Linux Desktop" on a Linux host, so its off line has
 * to say so on every surface that writes it (the picker, the strip, the command
 * palette) instead of the catalogue's Mac Desktop wording. Null when the
 * definition carries no hint of its own.
 */
export function workToolHint(id: WorkSidebarTab, hostPlatform: NodeJS.Platform | null): string | null {
  const label = hostLaneScreenLabel(id, hostPlatform);
  if (label) return `${label} is off`;
  return WORK_TOOL_DEFINITIONS_BY_ID.get(id)?.hint ?? null;
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
  /**
   * The lane's RUNTIME HOST can host a Mac Desktop display.
   *
   * Not a property of this computer, which is why it is a tri-state rather than
   * a boolean: a Windows desktop watching a Mac-hosted lane must see the tool,
   * and the answer arrives from `macDesktop.getStatus` a round-trip after the
   * pane mounts. `null` means "not answered yet", and an unanswered capability
   * shows the tool — hiding it and bringing it back a beat later is worse than
   * showing it and letting the panel state its own error.
   */
  supportsMacDesktop?: boolean | null;
  /**
   * The lane's RUNTIME HOST can host a Windows Desktop screen: it is a Windows
   * host. Same tri-state and the same "show while unanswered" rule as
   * `supportsMacDesktop`, and the two are mutually exclusive by host platform.
   */
  supportsWindowsDesktop?: boolean | null;
  /** The host's own words for a `false` Windows answer. */
  windowsDesktopUnsupportedReason?: string | null;
  /**
   * The lane's runtime host's platform, from the same `macDesktop.getStatus`
   * read; `null` while it has not answered.
   *
   * Separate from the `supports*` flags on purpose: "this host is the wrong
   * platform" hides a tool, while "this host is the right platform but cannot
   * run it right now" (a driver missing from the install, no Xcode) keeps the
   * card, disabled, with the host's reason.
   */
  hostPlatform?: NodeJS.Platform | null;
  /**
   * The host's own words for a `false` above, e.g. the driver is missing from
   * this install. Shown in place of the generic "isn't a Mac" line, which is
   * wrong on a Mac whose driver did not ship.
   */
  macDesktopUnsupportedReason?: string | null;
  /**
   * The lane lives on a provider's cloud VM, not an ADE machine. Tools that
   * drive a real machine have nothing to drive there.
   */
  cloudLane?: "devin" | "cursor" | null;
  /**
   * The chat the pane serves has a side chat (or one is starting). The Side
   * chat tool exists only for that chat, and only while it has one.
   */
  hasSideChat?: boolean;
  /**
   * The chat drives a simulator on another machine through its work copy
   * (`ade apple … --machine`). The iOS tool then shows that simulator, so it
   * stays even on a host that cannot run one.
   */
  hasRemoteSimulator?: boolean;
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
 *
 * Mac Desktop IS here, and for the browser's reason: the lane's screen leaves a
 * describable trail — a display, a window list, a lease holder, and a live
 * stream the web client plays over the sync socket — so a web client shows
 * that instead of a dead card. It may start and stop the lane's display, and
 * when the host advertises `hello_ok.features.macDesktopControl` it may also
 * take the input lease and drive the pointer from the browser. The membership
 * here is therefore about the WATCHING fallback, not about a permanent
 * no-control rule: a host without the control commands (or a browser that
 * fails the capability check) still renders this read-only pane, and
 * `WORK_TOOLS_CONTROL_HINT` says control stays on the desktop exactly then.
 */
const WEB_READ_ONLY_TOOL_IDS = new Set<WorkSidebarTab>(["browser", "app-control", "mac-desktop", "windows-desktop"]);

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
/** The same `false` from a host that is a Mac: it has no usable simulators. */
export const IOS_MAC_UNSUPPORTED_REASON = "Apple simulators aren't available on this Mac. Install Xcode to use them.";

/** True when this surface may only watch the tool's live view, never drive it. */
export function isReadOnlyWorkTool(id: WorkSidebarTab, context: WorkToolContext): boolean {
  return context.isWebClient && WEB_READ_ONLY_TOOL_IDS.has(id);
}

const CLOUD_MACHINE_TOOLS = new Set<WorkSidebarTab>(["ios", "mac-desktop", "windows-desktop", "app-control"]);

export const SIDE_CHAT_TOOL_UNAVAILABLE_REASON = "This chat has no side chat. Type /side and a question in its composer.";

export function workToolAvailability(
  id: WorkSidebarTab,
  context: WorkToolContext,
): WorkToolAvailability {
  if (id === "side-chat") {
    return context.hasSideChat ? AVAILABLE : { available: false, reason: SIDE_CHAT_TOOL_UNAVAILABLE_REASON };
  }
  if (context.cloudLane && CLOUD_MACHINE_TOOLS.has(id)) {
    const cloud = context.cloudLane === "devin" ? "Devin Cloud" : "Cursor Cloud";
    return {
      available: false,
      reason: `This lane lives on ${cloud}. This tool drives a real machine, and the lane's machine is ${cloud}'s VM.`,
    };
  }
  // Windows Desktop follows the host platform strictly, before the read-only
  // short-circuit: a Mac-hosted lane must not offer a Windows screen even to a
  // web client that could watch one. The Mac rule below keeps its existing
  // behavior, including the web client's watch-only case.
  if (id === "windows-desktop" && context.supportsWindowsDesktop === false) {
    const reason = context.windowsDesktopUnsupportedReason?.trim();
    return { available: false, reason: reason || "This lane's host isn't Windows" };
  }
  if (id === "mac-desktop" && context.supportsMacDesktop === false) {
    const reason = context.macDesktopUnsupportedReason?.trim();
    return { available: false, reason: reason || "This lane's host isn't a Mac" };
  }
  if (isReadOnlyWorkTool(id, context)) return AVAILABLE;
  if (id === "ios" && context.hasRemoteSimulator) return AVAILABLE;
  // The HOST's platform, not this one. The reason says so, because "macOS only"
  // on a Mac desktop watching a Linux runtime reads as a bug in ADE — and "not
  // a Mac" on a Mac without simulators is just as wrong.
  if (id === "ios" && !context.supportsIosSimulator) {
    return {
      available: false,
      reason: context.hostPlatform === "darwin" ? IOS_MAC_UNSUPPORTED_REASON : IOS_RUNTIME_UNSUPPORTED_REASON,
    };
  }

  return AVAILABLE;
}

/**
 * True when the lane's host is the wrong platform for this tool: Mac Desktop
 * and Apple Development on a non-Mac host, Windows Desktop on a non-Windows
 * host. Such a card is not shown at all, because a disabled card for something
 * this machine can never do is noise.
 *
 * Only the host PLATFORM hides a tool. A Mac whose desktop driver is missing,
 * or that has no Xcode, keeps its card — disabled, with the host's own reason —
 * because that is something the user can fix. An unanswered platform keeps
 * every card, so nothing disappears and comes back a beat later. Cloud lanes
 * are not host mismatches: their card stays and says why.
 */
export function isHostMismatchWorkTool(id: WorkSidebarTab, context: WorkToolContext): boolean {
  if (context.cloudLane) return false;
  const platform = context.hostPlatform ?? null;
  if (!platform) return false;
  if (id === "windows-desktop") return platform !== "win32";
  // A Linux host's lane screen is the Mac Desktop pane, named for Linux.
  if (id === "mac-desktop") return platform !== "darwin" && platform !== "linux";
  if (id === "ios") return platform !== "darwin" && context.hasRemoteSimulator !== true;
  return false;
}

/** The tool cards this host can show, in catalogue order. A chat without a side chat shows no Side chat card. */
export function visibleWorkToolDefinitions(context: WorkToolContext): typeof WORK_TOOL_DEFINITIONS {
  return WORK_TOOL_DEFINITIONS.filter((definition) => !isHostMismatchWorkTool(definition.id, context)
    && (definition.id !== "side-chat" || context.hasSideChat === true))
    .map((definition) => {
      const label = hostLaneScreenLabel(definition.id, context.hostPlatform ?? null);
      return label ? { ...definition, label, hint: `${label} is off` } : definition;
    });
}

/** The lane-screen tools: one per host platform, never both. */
export type DesktopWorkTool = "mac-desktop" | "windows-desktop";

export function isDesktopWorkTool(id: WorkSidebarTab | string | null | undefined): id is DesktopWorkTool {
  return id === "mac-desktop" || id === "windows-desktop";
}

/**
 * The lane-screen tool this host offers. A Windows host offers Windows
 * Desktop; any other host — and a host that has not answered yet — offers Mac
 * Desktop, which is what every surface showed before the platform was known.
 */
export function hostDesktopTool(context: Pick<WorkToolContext, "hostPlatform">): DesktopWorkTool {
  return context.hostPlatform === "win32" ? "windows-desktop" : "mac-desktop";
}

/** "Mac Desktop", "Linux Desktop" or "Windows Desktop", from the one shared naming rule. */
export function desktopToolProductName(tool: DesktopWorkTool, hostPlatform?: NodeJS.Platform | null): string {
  if (tool === "windows-desktop") return desktopProductName("win32");
  return desktopProductName(hostPlatform === "linux" ? "linux" : "darwin");
}

export function isAvailableWorkSidebarTab(
  id: WorkSidebarTab,
  context: WorkToolContext,
): boolean {
  return workToolAvailability(id, context).available;
}
