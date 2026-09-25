import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type {
  GitCommitSummary,
  LaneSummary,
  OpenProjectBinding,
  TerminalSessionSummary,
} from "../../../shared/types";
import { useAppStore, type WorkSidebarTab } from "../../state/appStore";
import {
  useWorkToolContextInsertion,
  type WorkSidebarContextTarget,
} from "./workToolContextInsertion";
import { useLanesForPin } from "../../state/crossMachineLanes";
import { machineNameForBinding } from "../../../shared/machineIdentity";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { isChatToolType, isPtyContextInsertableToolType } from "../../lib/sessions";
import { revealTransition } from "../../lib/motion";
import { showToast } from "../app/toast/toastStore";
import { WorkToolHeader, workToolPanelId } from "./WorkToolHeader";
import { WorkToolsMaximizeContext } from "./workToolsMaximize";
import { cn } from "../ui/cn";
import { WorkToolPicker } from "./WorkToolPicker";
import { useWorkToolStatuses } from "./useWorkToolStatuses";
import { AppleToolCardMenu } from "../apple/AppleToolCardMenu";
import { useNativeToolFeeds } from "./NativeToolFeedsContext";
import { isAvailableWorkSidebarTab, workToolContextLabel, workToolLabel } from "./workTools";
import { WORK_TOOL_COMPONENTS, type WorkToolPanelProps } from "./workToolPanels";

/** Escape returns to the picker, but only from inside the pane — see `work.tools.picker`. */
const TOOLS_PICKER_BINDING_ID = "work.tools.picker";
const TOOLS_PICKER_DEFAULT_BINDING = "Escape";

/**
 * Anything that owns Escape more strongly than the pane does.
 *
 * A dialog, a menu, or a Radix popper is a modal layer: its Escape closes it,
 * and the pane must not race that. Checked against the whole document because
 * these all portal to `document.body`, outside the pane's own subtree.
 */
const MODAL_LAYER_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]';

function aModalLayerIsOpen(): boolean {
  return document.querySelector(MODAL_LAYER_SELECTOR) != null;
}

/**
 * A subtree that has already promised Escape to something else.
 *
 * The browser panel's find bar is the first: Escape there closes the find bar,
 * and if the pane also acted you would lose the find bar AND the browser in one
 * keystroke. Any tool can opt out the same way by putting this attribute on the
 * element that owns the key.
 */
const ESCAPE_SCOPE_ATTR = "data-ade-escape-scope";

/**
 * True when the keystroke belongs to something inside the pane rather than to
 * the pane itself: a tool that claimed Escape, a menu or dialog portalled into
 * the pane, or a text field with something in it (where Escape is "clear this",
 * not "leave"). An EMPTY field is not a claim — Escape in a blank URL bar
 * should still get you back to the tools.
 */
function escapeIsClaimedInside(target: Element): boolean {
  if (target.closest(`[${ESCAPE_SCOPE_ATTR}]`)) return true;
  if (target.closest(MODAL_LAYER_SELECTOR)) return true;
  const field = target.closest<HTMLElement>("input, textarea, [contenteditable='true']");
  if (!field) return false;
  if (field.isContentEditable) return (field.textContent ?? "").length > 0;
  const value = (field as HTMLInputElement | HTMLTextAreaElement).value ?? "";
  return value.length > 0;
}

/**
 * Re-exported so the many callers that import it from the pane keep working;
 * it lives with the insertion hook now because the Apple column pane needs the
 * same target without importing the sidebar.
 */
export type { WorkSidebarContextTarget };

function shortLaneId(laneId: string): string {
  return laneId.length <= 8 ? laneId : `${laneId.slice(0, 4)}...${laneId.slice(-3)}`;
}

function laneDisplayName(lanes: LaneSummary[], laneId: string | null): string {
  if (!laneId) return "another lane";
  return lanes.find((lane) => lane.id === laneId)?.name ?? shortLaneId(laneId);
}

function laneMismatchMessage(
  toolName: string,
  ownerLaneId: string | null,
  activeLaneId: string | null,
  lanes: LaneSummary[],
): string {
  const ownerLane = laneDisplayName(lanes, ownerLaneId);
  const activeLane = laneDisplayName(lanes, activeLaneId);
  return `This ${toolName} view is claimed by ${ownerLane}, not ${activeLane}. You can still view, inspect, and attach context here. Claim it from ${activeLane} to move ownership.`;
}

function hideBuiltInBrowserView(projectRoot: string | null): void {
  const browser = window.ade?.builtInBrowser;
  if (!browser) return;
  const scope = projectRoot ? { projectRoot } : {};
  void browser.stopInspect(scope).catch(() => {});
  void browser.setBounds({
    ...scope,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    visible: false,
  }).catch(() => {});
}

export function WorkSidebar({
  active = true,
  laneId,
  lanes,
  activeSession,
  tool,
  openTools = [],
  onToolChange,
  onToolClose,
  onClose,
  contextTarget,
  contextDisabledReason: targetDisabledReason,
  runtimePin = null,
  maximized = false,
  onMaximizedChange,
}: {
  active?: boolean;
  laneId: string | null;
  lanes: LaneSummary[];
  activeSession: TerminalSessionSummary | null;
  /** The tab on screen, or null for the picker page. */
  tool: WorkSidebarTab | null;
  /** Every tool open as a tab, in strip order. */
  openTools?: readonly WorkSidebarTab[];
  onToolChange: (tool: WorkSidebarTab | null) => void;
  /** Removes a tab. Omitted on surfaces with no strip to close from. */
  onToolClose?: (tool: WorkSidebarTab) => void;
  onClose: () => void;
  contextTarget: WorkSidebarContextTarget | null;
  contextDisabledReason: string | null;
  /**
   * The machine the active Work session actually runs on. Null means this
   * tab's bound machine. Every tool in here follows the chat: a chat on
   * another machine gets THAT machine's git, terminals, and files.
   */
  runtimePin?: OpenProjectBinding | null;
  /** The pane fills the Work page, tabs and all. Owned by the page. */
  maximized?: boolean;
  onMaximizedChange?: (next: boolean) => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<"staged" | "unstaged" | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<GitCommitSummary | null>(null);
  const keybindings = useAppStore((state) => state.keybindings);
  const reduceMotion = useReducedMotion() ?? false;
  const sidebarRef = useRef<HTMLElement | null>(null);
  // The capability gate, the browser view's collection scope and the offline
  // guard all come from the page's feed provider rather than being recomputed
  // here: the corner card reads the same three values, and computing them twice
  // is how the two surfaces ended up disagreeing about `offline`.
  //
  // `browserViewRoot`: the browser view is owned by THIS window's main process.
  // A pin on another checkout of this computer still drives that view, just
  // under the pinned checkout's tab collection, so hiding it on leave has to
  // follow the pin. A pin on another machine never opens a view here — the
  // panel explains that instead of driving a browser nobody can see.
  const {
    context: toolContext,
    browserViewRoot,
    offline: pinnedMachineOffline,
  } = useNativeToolFeeds();
  // An unavailable tool falls back to the PICKER, not to some other tool: being
  // dropped into Git because the simulator is unavailable on this machine is a
  // non-sequitur, and the picker says why the card is dimmed.
  const effectiveTool: WorkSidebarTab | null =
    tool && isAvailableWorkSidebarTab(tool, toolContext) ? tool : null;
  /**
   * The strip as the header draws it.
   *
   * Two rules, both defensive: a tab this surface cannot open is dropped
   * (web client's Simulator), and the tool on screen is always in the strip —
   * a pane showing a tool with no tab for it would have no mark anywhere
   * saying what you are looking at.
   */
  const availableOpenTools = useMemo(() => {
    const strip = openTools.filter((entry) => isAvailableWorkSidebarTab(entry, toolContext));
    if (effectiveTool && !strip.includes(effectiveTool)) strip.push(effectiveTool);
    return strip;
  }, [effectiveTool, openTools, toolContext]);

  // A foreign chat's lane is absent from the tab-bound `lanes` array, so the
  // worktree path (and therefore iOS / App Control) resolved to null. Fall
  // back to the machine's slice of the cross-machine union.
  const pinnedLanes = useLanesForPin(runtimePin);
  const scopedLanes = pinnedLanes ?? lanes;
  const activeLane = useMemo(
    () => (laneId ? scopedLanes.find((lane) => lane.id === laneId) ?? null : null),
    [laneId, scopedLanes],
  );
  const laneRoot = activeLane?.worktreePath ?? null;
  const pinnedMachineName = runtimePin ? machineNameForBinding(runtimePin) : null;

  useEffect(() => {
    setSelectedPath(null);
    setSelectedMode(null);
    setSelectedCommit(null);
  }, [laneId, runtimePin?.key]);

  useEffect(() => {
    if (tool && !isAvailableWorkSidebarTab(tool, toolContext)) {
      onToolChange(null);
    }
  }, [onToolChange, tool, toolContext]);

  // Hiding the native browser view is the pane's one non-React obligation: the
  // WebContentsView lives in main and keeps painting over whatever replaces it
  // unless it is explicitly parked. Fires on tool switch, on close, on the pane
  // going inactive, and on unmount — the exact contract the tab strip had.
  const previousBrowserToolRef = useRef(effectiveTool === "browser");
  useEffect(() => {
    const wasBrowser = previousBrowserToolRef.current;
    const isBrowser = active && effectiveTool === "browser";
    if (wasBrowser && !isBrowser) hideBuiltInBrowserView(browserViewRoot);
    previousBrowserToolRef.current = isBrowser;
    return () => {
      if (previousBrowserToolRef.current) hideBuiltInBrowserView(browserViewRoot);
    };
  }, [active, browserViewRoot, effectiveTool]);

  /**
   * Who owns the shells, asked twice for two different reasons.
   *
   * `status` is for the picker line and the activity dot: a chat session, or
   * whatever the context target is. `pane` additionally counts a RUNNING agent
   * CLI session, because the pane can host that session's shells even though it
   * is not a chat — deriving the pane's answer from the status one showed
   * foreign chats an "open a chat…" empty state instead of a terminal. The two
   * rules differ in exactly one clause, stated once here.
   */
  const { statusOwnerSessionId, paneOwnerSessionId } = useMemo(() => {
    const fromContext = contextTarget?.kind === "chat" || contextTarget?.kind === "pty"
      ? contextTarget.sessionId
      : null;
    if (!activeSession) return { statusOwnerSessionId: fromContext, paneOwnerSessionId: fromContext };
    if (isChatToolType(activeSession.toolType)) {
      return { statusOwnerSessionId: activeSession.id, paneOwnerSessionId: activeSession.id };
    }
    const runningCliSession = activeSession.status === "running"
      && activeSession.ptyId
      && isPtyContextInsertableToolType(activeSession.toolType);
    return {
      statusOwnerSessionId: fromContext,
      paneOwnerSessionId: runningCliSession ? activeSession.id : null,
    };
  }, [activeSession, contextTarget]);

  // Status now spans every tool, not just the one on screen: the picker cards
  // and the header's activity dots both report on tools nobody is looking at.
  const panelSessionId = contextTarget?.kind === "chat" ? contextTarget.sessionId : null;
  // A bump re-reads the lane's Apple device after the card menu boots, releases,
  // or deletes it — the web client gets no `apple.device.state` events.
  const [appleDeviceRefreshKey, setAppleDeviceRefreshKey] = useState(0);
  const {
    statuses,
    loading: statusesLoading,
    appControlSession,
    appleDevice,
  } = useWorkToolStatuses({
    enabled: active,
    laneId,
    lane: activeLane,
    runtimePin,
    terminalOwnerSessionId: statusOwnerSessionId,
    prSessionId: panelSessionId,
    activeTool: tool,
    appleDeviceRefreshKey,
  });

  function resolveToolAttributionReason(): string | null {
    if (!laneId) return null;
    // The catalogue's names, not literals: the banner is the one place the pane
    // used to call the simulator something the header and the picker do not.
    if (effectiveTool === "app-control" && appControlSession?.laneId && appControlSession.laneId !== laneId) {
      return laneMismatchMessage(workToolLabel("app-control"), appControlSession.laneId, laneId, scopedLanes);
    }
    // Apple has no pane-level claim: per-device ownership lives in the picker.
    return null;
  }
  // Lane attribution only. "This session cannot receive inserted context" is
  // not a warning — it is a capability the panels simply do not offer here, so
  // they drop the controls that depend on it rather than narrating the absence
  // in a banner above controls you can still see.
  const warningReason = resolveToolAttributionReason();
  const contextDisabledReason = targetDisabledReason;
  const canInsertContext = Boolean(contextTarget && !contextDisabledReason);
  const shouldPersistPanelAttachment = canInsertContext && contextTarget?.kind === "pty";

  /**
   * The pane at window size, tabs included. The page owns the state so it can
   * hide the columns beside the pane without this subtree remounting (a portal
   * did remount it, which restarted the Mac Desktop stream on every toggle).
   * See `workToolsMaximize`.
   */
  const setMaximized = useCallback((next: boolean) => onMaximizedChange?.(next), [onMaximizedChange]);
  const maximizeContext = useMemo(() => ({ maximized, setMaximized }), [maximized, setMaximized]);
  // Losing every tool always restores the window.
  useEffect(() => {
    if (!effectiveTool && maximized) setMaximized(false);
  }, [effectiveTool, maximized, setMaximized]);

  const {
    addAttachment,
    addIosContext,
    addAppControlContext,
    addBuiltInBrowserContext,
    insertDraft,
  } = useWorkToolContextInsertion({ contextTarget, contextDisabledReason, runtimePin });

  // Resuming from here is the same call the Work row's Resume makes; the pane
  // owns it because the pane is where you notice the session is gone.
  const [resumingSession, setResumingSession] = useState(false);
  const resumeEndedSession = useCallback(() => {
    const session = activeSession;
    if (!session || resumingSession) return;
    setResumingSession(true);
    const args = { sessionId: session.id, cols: 100, rows: 30 };
    const request = runtimePin
      ? window.ade.pty.resumeSession(args, runtimePin)
      : window.ade.pty.resumeSession(args);
    void request
      .catch((error: unknown) => {
        showToast({
          title: "Resume failed",
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
      })
      .finally(() => setResumingSession(false));
  }, [activeSession, resumingSession, runtimePin]);

  const selectFile = useCallback((path: string, mode: "staged" | "unstaged") => {
    setSelectedPath(path);
    setSelectedMode(mode);
    setSelectedCommit(null);
  }, []);
  const selectCommit = useCallback((commit: GitCommitSummary | null) => {
    setSelectedCommit(commit);
    if (commit) {
      setSelectedPath(null);
      setSelectedMode(null);
    }
  }, []);
  const clearDiffSelection = useCallback(() => {
    setSelectedPath(null);
    setSelectedMode(null);
    setSelectedCommit(null);
  }, []);

  // One props object for every tool panel, and one lookup to pick the panel.
  // The cascade this replaces was a 270-line memo with a hand-written 28-entry
  // dependency array that could never actually memoize.
  const toolProps = useMemo<WorkToolPanelProps>(() => ({
    laneId,
    laneRoot,
    activeLane,
    activeSession: activeSession ?? null,
    runtimePin,
    panelSessionId,
    terminalOwnerSessionId: paneOwnerSessionId,
    toolContext,
    pinnedMachineOffline,
    pinnedMachineName,
    warningReason,
    canInsertContext,
    shouldPersistPanelAttachment,
    resumingSession,
    selectedPath,
    selectedMode,
    selectedCommit,
    onSelectFile: selectFile,
    onSelectCommit: selectCommit,
    onClearDiffSelection: clearDiffSelection,
    onAddAttachment: addAttachment,
    onAddBuiltInBrowserContext: addBuiltInBrowserContext,
    onAddAppControlContext: addAppControlContext,
    onAddIosContext: addIosContext,
    onInsertDraft: insertDraft,
    onResumeEndedSession: resumeEndedSession,
    onToolChange,
    onClose,
  }), [
    activeLane,
    activeSession,
    addAppControlContext,
    addAttachment,
    addBuiltInBrowserContext,
    addIosContext,
    canInsertContext,
    clearDiffSelection,
    insertDraft,
    laneId,
    laneRoot,
    onClose,
    onToolChange,
    panelSessionId,
    pinnedMachineName,
    pinnedMachineOffline,
    resumeEndedSession,
    resumingSession,
    runtimePin,
    selectCommit,
    selectFile,
    selectedCommit,
    selectedMode,
    selectedPath,
    paneOwnerSessionId,
    shouldPersistPanelAttachment,
    toolContext,
    warningReason,
  ]);

  // `active &&` must keep UNMOUNTING the tool, never hide it with CSS.
  //
  // Two things outside this file depend on the unmount rather than on the pane
  // merely being invisible: the browser panel releases its page-zoom claim
  // (`lib/appZoomCommands`) in an effect cleanup, and it parks the native
  // `WebContentsView` on the way out. A hidden-but-mounted pane has the same
  // blur state as a focused one, so a CSS hide here would leave an off-screen
  // browser eating the app's ⌘/Ctrl +=/−/0.
  //
  // `active` arrives as `active && isWorkRoute` (`App.tsx:436` mounts
  // `TerminalsPage` directly, not through `routeProps`), so all four ways of
  // leaving — switching tools, closing the pane, leaving the work route, and
  // leaving the project tab — unmount the panel before anything hides it. That
  // is why no tool panel is ever mounted inside an `inert` subtree today, and
  // it is the invariant a CSS hide of a panel would quietly break. The picker
  // keep-alive is not a panel: it has no WebContentsView, so it may be inert
  // while a tool is on screen.
  const ToolPanel = active && effectiveTool ? WORK_TOOL_COMPONENTS[effectiveTool] : null;
  const content = ToolPanel ? <ToolPanel {...toolProps} /> : null;

  const selectTool = useCallback((next: WorkSidebarTab | null) => {
    if (effectiveTool === "browser" && next !== "browser") hideBuiltInBrowserView(browserViewRoot);
    // Take focus BEFORE the swap, not after: the card that was clicked is about
    // to unmount, and when it does the browser drops focus onto <body> — where
    // the pane's Escape handler never hears it, because the keydown is not
    // dispatched inside the pane at all. Claiming it here means the incoming
    // panel's own mount-time autofocus (a terminal, a URL field) still runs
    // afterwards and still wins.
    sidebarRef.current?.focus({ preventScroll: true });
    onToolChange(next);
  }, [browserViewRoot, effectiveTool, onToolChange]);

  const closeTool = useCallback((target: WorkSidebarTab) => {
    // Same obligation as switching away: the native browser view keeps painting
    // over whatever replaces it unless it is parked here, synchronously.
    if (target === "browser") hideBuiltInBrowserView(browserViewRoot);
    onToolClose?.(target);
  }, [browserViewRoot, onToolClose]);

  const closePane = useCallback(() => {
    if (effectiveTool === "browser") hideBuiltInBrowserView(browserViewRoot);
    onClose();
  }, [browserViewRoot, effectiveTool, onClose]);

  /**
   * The one picker card that carries an action: the Apple device card.
   *
   * Its claim is otherwise invisible — the card reads the lane's device and its
   * power, but neither "give it up" nor "boot it" had a target on the card, so
   * releasing meant opening the pane and finding a control named "Choose another
   * device". The menu makes the claim actionable where it is stated. Absent
   * until the lane actually owns a device, so an unclaimed lane's card is
   * exactly what it always was.
   */
  const toolCardActions = useMemo<Partial<Record<WorkSidebarTab, ReactNode>>>(() => {
    if (!laneId || !appleDevice) return {};
    return {
      ios: (
        <AppleToolCardMenu
          device={appleDevice}
          laneId={laneId}
          chatSessionId={panelSessionId}
          runtimePin={runtimePin}
          onOpenTool={() => selectTool("ios")}
          onMutated={() => setAppleDeviceRefreshKey((nonce) => nonce + 1)}
        />
      ),
    };
  }, [appleDevice, laneId, panelSessionId, runtimePin, selectTool]);

  // Escape is scoped to the pane, not the window: a global binding would steal
  // Escape from the composer, from dialogs, and from the browser panel's own
  // URL field. Keyed off `work.tools.picker` so it stays rebindable.
  const pickerBinding = getEffectiveBinding(
    keybindings,
    TOOLS_PICKER_BINDING_ID,
    TOOLS_PICKER_DEFAULT_BINDING,
  );
  // Inside a terminal the pane cannot have plain Escape. xterm hands Escape to
  // whatever is running — vim, less, a TUI menu — and it does not report back
  // whether that program wanted it, so "act only if the terminal declined" is
  // not knowable from here. Shift+Escape is the pane's way out instead, and the
  // "Back to tools" tooltip says so wherever a terminal is on screen.
  const terminalPickerBinding = `Shift+${pickerBinding}`;
  /**
   * The pane's Escape, applied to one keystroke.
   *
   * Shared by the pane's own capture handler and the `<body>` fallback below,
   * so the two can never disagree about what counts as a claim.
   */
  const applyPickerBinding = useCallback((
    event: KeyboardEvent,
    targetElement: Element | null,
    options?: { insideTerminal?: boolean },
  ) => {
    if (aModalLayerIsOpen()) return;
    if (targetElement && escapeIsClaimedInside(targetElement)) return;
    // With no target there is nothing to walk up from, so the caller supplies
    // what it knew at pointer-down instead.
    const insideTerminal = targetElement
      ? targetElement.closest(".xterm") != null
      : options?.insideTerminal === true;
    const binding = insideTerminal ? terminalPickerBinding : pickerBinding;
    if (!eventMatchesBinding(event, binding)) return;
    event.preventDefault();
    event.stopPropagation();
    // At the picker there is nothing to go back to, so Escape means "dismiss".
    // Without this the pane was a keyboard trap: the only way out of the front
    // page was the mouse.
    if (!effectiveTool) {
      closePane();
      return;
    }
    selectTool(null);
  }, [closePane, effectiveTool, pickerBinding, selectTool, terminalPickerBinding]);

  const handleKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    // Same stand-down as the two document listeners below: `TerminalsPage` is
    // hidden with CSS rather than unmounted, so focus left on a pane button
    // when the route changes by keyboard would otherwise keep this handler
    // armed off-route — closing a tool behind the user's back and pulling focus
    // into a `pointer-events: none`, `z-index: -1` subtree.
    if (!active) return;
    const target = event.target as Node | null;
    // Capture phase, so this runs before xterm's own key handling — but only
    // for keys pressed inside this pane, and never while a modal layer is up.
    if (!target || !sidebarRef.current?.contains(target)) return;
    const targetElement = target instanceof Element ? target : target.parentElement;
    // A maximised pane gives Escape back first: it restores the window and
    // leaves the tool where it was, instead of also walking back to the
    // picker. A menu, a dialog or a claimed field still owns its own Escape.
    if (maximized && event.key === "Escape" && !aModalLayerIsOpen()
      && !(targetElement && escapeIsClaimedInside(targetElement))) {
      event.preventDefault();
      event.stopPropagation();
      setMaximized(false);
      return;
    }
    applyPickerBinding(event.nativeEvent, targetElement);
  }, [active, applyPickerBinding, maximized, setMaximized]);

  /**
   * Which surface the pointer last committed to.
   *
   * Focus is the usual answer to "whose key is this", but a click on a control
   * that then unmounts leaves focus on `<body>`, which belongs to nobody. The
   * last pointer-down is the honest tiebreaker for that one case, and it is
   * recomputed on every pointer-down anywhere, so clicking the composer hands
   * the keyboard back immediately.
   */
  const paneHasPointerRef = useRef(false);
  /**
   * …and whether that pointer-down landed inside a terminal.
   *
   * The `<body>` path has no target to inspect, so without this it would apply
   * the plain-Escape binding to a keystroke that belongs to an xterm whose
   * focus has since dropped to `<body>` (a reconnect, a dispose) — handing the
   * pane an Escape the terminal was owed. Remembered at pointer-down, which is
   * the same moment the pane decides the keyboard is its.
   */
  const paneTerminalHasPointerRef = useRef(false);
  useEffect(() => {
    // `TerminalsPage` stays mounted off-route (hidden with CSS, not unmounted),
    // so an ungated document listener here would arm the pane's Escape while
    // the user is on Lanes or Settings — closing a tool behind their back and
    // moving focus into a `pointer-events: none`, `z-index: -1` subtree.
    if (!active) {
      paneHasPointerRef.current = false;
      paneTerminalHasPointerRef.current = false;
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      const node = target instanceof Node ? target : null;
      paneHasPointerRef.current = Boolean(node && sidebarRef.current?.contains(node));
      const element = node instanceof Element ? node : node?.parentElement ?? null;
      paneTerminalHasPointerRef.current = paneHasPointerRef.current
        && element?.closest(".xterm") != null;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [active]);

  // Only ever for keystrokes that landed on `<body>`: anything with a real
  // focus target is handled by the pane's own capture handler above (or belongs
  // to whatever does have focus), so there is no double handling.
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== document.body) return;
      if (!paneHasPointerRef.current) return;
      applyPickerBinding(event, null, { insideTerminal: paneTerminalHasPointerRef.current });
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, applyPickerBinding]);

  // Browser: the page you are on. Terminal: how many shells. Git: the branch.
  // One compact fact, so the header answers "which one of these am I looking
  // at" without duplicating the panel's own chrome. The per-tool rule lives on
  // the tool's own catalogue entry, next to its label and its icon.
  const headerContextLabel = useMemo(() => (
    effectiveTool
      ? workToolContextLabel(effectiveTool, { lane: activeLane, status: statuses[effectiveTool] ?? null })
      : null
  ), [activeLane, effectiveTool, statuses]);

  /**
   * Tab → tab is a shorter, flatter fade than picker → tool.
   *
   * Switching tabs is a lateral move inside one surface: 120ms of opacity and no
   * y-shift, so the strip does not feel like it re-opened the pane. Arriving from
   * (or leaving for) the picker keeps the page-level reveal.
   */
  const previousPaneKeyRef = useRef<string | null>(null);
  const paneKey = effectiveTool ?? "picker";
  const tabSwitch = previousPaneKeyRef.current !== null
    && previousPaneKeyRef.current !== "picker"
    && paneKey !== "picker"
    && previousPaneKeyRef.current !== paneKey;
  useEffect(() => {
    previousPaneKeyRef.current = paneKey;
  }, [paneKey]);
  const transition = reduceMotion
    ? { duration: 0 }
    : tabSwitch
      ? { duration: 0.12, ease: "easeOut" as const }
      : revealTransition;

  return (
    <WorkToolsMaximizeContext.Provider value={maximizeContext}>
    <aside
      ref={sidebarRef}
      onKeyDownCapture={handleKeyDownCapture}
      data-maximized={maximized ? "true" : undefined}
      // Focusable only programmatically (`selectTool`), and never ringed for
      // it: this is a focus fallback, not a stop on the tab order.
      tabIndex={-1}
      // `min-w-0` + `overflow-hidden`, never a pixel `min-width`: a minimum on
      // the pane makes it wider than the column flexbox gave it, and the
      // overflow is then clipped by the window — which is how the ✕ and the
      // browser's ⋮ ended up unreachable. The drag is what enforces 280px
      // (`clampWorkSidebarWidthPct`); the pane itself just never escapes.
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden outline-none",
        // Opaque when it is the whole page: the columns it covers are hidden,
        // and a translucent pane over nothing reads as a broken overlay.
        maximized ? "bg-bg" : "border-l border-white/[0.08] bg-surface/85",
      )}
    >
      {/* One bar for both states. The strip does not disappear when the picker
          comes up — the tabs are still open, and a picker page that hid them
          would look like it had closed them. */}
      <WorkToolHeader
        activeTool={effectiveTool}
        openTools={availableOpenTools}
        context={toolContext}
        contextLabel={headerContextLabel}
        statuses={statuses}
        // Reads the real binding rather than a hard-coded "Esc", so a
        // rebound `work.tools.picker` never advertises the wrong key.
        backShortcut={effectiveTool === "terminal" ? terminalPickerBinding : pickerBinding}
        onShowPicker={() => selectTool(null)}
        onPick={selectTool}
        onCloseTool={closeTool}
        onClose={closePane}
      />
      {/* A true crossfade, so the two surfaces overlap rather than the pane
          blanking between them: both children are absolutely positioned and
          the outgoing one stops taking pointer events the moment it starts to
          leave. Switching away from the browser parks its WebContentsView
          synchronously (`selectTool`), so the native view is never composited
          over the incoming tool during the overlap. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* The picker stays mounted so its mesh does not recompile on every
            return from a tool. Hidden and paused while a tool is on screen —
            the loop stops, the last frame stays, opening Tools is a CSS show. */}
        <div
          className={
            effectiveTool
              ? "pointer-events-none absolute inset-0 min-h-0 opacity-0"
              : "absolute inset-0 min-h-0 opacity-100"
          }
          aria-hidden={effectiveTool ? true : undefined}
          {...(effectiveTool ? ({ inert: "" } as { inert: string }) : {})}
        >
          <WorkToolPicker
            activeTool={tool}
            context={toolContext}
            statuses={statuses}
            loading={statusesLoading}
            onPick={selectTool}
            cardActions={toolCardActions}
            playing={!effectiveTool}
          />
        </div>
        <AnimatePresence initial={false}>
          {effectiveTool ? (
            <motion.div
              key={effectiveTool}
              role="tabpanel"
              id={workToolPanelId(effectiveTool)}
              aria-label={workToolLabel(effectiveTool)}
              className="absolute inset-0 z-[1] min-h-0"
              initial={{ opacity: 0, y: tabSwitch ? 0 : 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: tabSwitch ? 0 : -4, pointerEvents: "none" }}
              transition={transition}
            >
              {content}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </aside>
    </WorkToolsMaximizeContext.Provider>
  );
}
