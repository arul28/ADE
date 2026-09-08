import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import type {
  AgentChatFileRef,
  AppControlContextItem,
  GitCommitSummary,
  IosElementContextItem,
  LaneSummary,
  OpenProjectBinding,
  TerminalSessionSummary,
  TerminalToolType,
} from "../../../shared/types";
import { useAppStore, type WorkDraftKind, type WorkSidebarTab } from "../../state/appStore";
import {
  formatAppControlContextForPrompt,
  formatBuiltInBrowserContextForPrompt,
  formatIosElementContextForPrompt,
  normalizeBuiltInBrowserContextItem,
} from "../../lib/visualContextFormatting";
import {
  dispatchWorkPtyContextInserted,
  type WorkPtyContextInsertKind,
} from "../../lib/workPtyContextEvents";
import { useLanesForPin } from "../../state/crossMachineLanes";
import { machineNameForBinding } from "../../../shared/machineIdentity";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { isChatToolType, isPtyContextInsertableToolType } from "../../lib/sessions";
import { revealTransition } from "../../lib/motion";
import { showToast } from "../app/toast/toastStore";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";
import { WorkToolHeader, WorkToolPickerHeader } from "./WorkToolHeader";
import { WorkToolPicker } from "./WorkToolPicker";
import { useWorkToolStatuses } from "./useWorkToolStatuses";
import { useNativeToolFeeds } from "./NativeToolFeedsContext";
import { isAvailableWorkSidebarTab, workToolContextLabel } from "./workTools";
import {
  WORK_TOOL_COMPONENTS,
  type PrRefreshAction,
  type WorkToolPanelProps,
} from "./workToolPanels";

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

/** See `ChatPrPane.onRegisterRefresh`. */

export type WorkSidebarContextTarget =
  | { kind: "chat"; sessionId: string }
  | { kind: "draft"; draftTargetId: string; laneId: string; draftKind: WorkDraftKind }
  | { kind: "pty"; sessionId: string; ptyId: string; toolType: TerminalToolType | null };

const NO_CONTEXT_TARGET_ERROR = "Open a chat, draft, or agent CLI session in this lane before inserting tool context.";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

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

function dispatchAgentChatEvent<T>(
  eventName: string,
  target: Extract<WorkSidebarContextTarget, { kind: "chat" | "draft" }>,
  key: string,
  value: T,
): void {
  const targetDetail = target.kind === "chat"
    ? { sessionId: target.sessionId }
    : {
        draftTargetId: target.draftTargetId,
        laneId: target.laneId,
        draftKind: target.draftKind,
      };
  window.dispatchEvent(new CustomEvent(eventName, {
    detail: {
      ...targetDetail,
      [key]: value,
    },
  }));
}

function bracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text.trimEnd()}\n${BRACKETED_PASTE_END}`;
}

function formatAttachmentForPty(attachment: AgentChatFileRef): string {
  return [
    "ADE visual attachment saved by the Work sidebar.",
    `Path: ${attachment.path}`,
    `Type: ${attachment.type}`,
    "",
  ].join("\n");
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
  onToolChange,
  onClose,
  contextTarget,
  contextDisabledReason: targetDisabledReason,
  runtimePin = null,
}: {
  active?: boolean;
  laneId: string | null;
  lanes: LaneSummary[];
  activeSession: TerminalSessionSummary | null;
  /** The one tool on screen, or null for the picker page. */
  tool: WorkSidebarTab | null;
  onToolChange: (tool: WorkSidebarTab | null) => void;
  onClose: () => void;
  contextTarget: WorkSidebarContextTarget | null;
  contextDisabledReason: string | null;
  /**
   * The machine the active Work session actually runs on. Null means this
   * tab's bound machine. Every tool in here follows the chat: a chat on
   * another machine gets THAT machine's git, terminals, and files.
   */
  runtimePin?: OpenProjectBinding | null;
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
  const {
    statuses,
    loading: statusesLoading,
    iosSession,
    appControlSession,
  } = useWorkToolStatuses({
    enabled: active,
    laneId,
    lane: activeLane,
    runtimePin,
    terminalOwnerSessionId: statusOwnerSessionId,
  });

  function resolveToolAttributionReason(): string | null {
    if (!laneId) return null;
    if (effectiveTool === "app-control" && appControlSession?.laneId && appControlSession.laneId !== laneId) {
      return laneMismatchMessage("App Control", appControlSession.laneId, laneId, scopedLanes);
    }
    if (effectiveTool === "ios" && iosSession?.laneId && iosSession.laneId !== laneId) {
      return laneMismatchMessage("iOS Simulator", iosSession.laneId, laneId, scopedLanes);
    }
    return null;
  }
  const toolAttributionReason = resolveToolAttributionReason();
  const contextDisabledReason = targetDisabledReason;
  const warningReason = toolAttributionReason ?? contextDisabledReason;
  const canInsertContext = Boolean(contextTarget && !contextDisabledReason);
  const shouldPersistPanelAttachment = canInsertContext && contextTarget?.kind === "pty";
  const panelSessionId = contextTarget?.kind === "chat" ? contextTarget.sessionId : null;
  // The PR tool's refresh, surrendered by `ChatPrPane` when it renders without
  // its own title bar. Held here so the shell header can place it.
  const [prRefreshAction, setPrRefreshAction] = useState<PrRefreshAction | null>(null);
  useEffect(() => {
    if (effectiveTool !== "pr") setPrRefreshAction(null);
  }, [effectiveTool]);

  const dispatchTargetRef = useRef({ contextTarget, contextDisabledReason });
  dispatchTargetRef.current = { contextTarget, contextDisabledReason };

  const insertIntoPty = useCallback((
    target: Extract<WorkSidebarContextTarget, { kind: "pty" }>,
    text: string,
    kind: WorkPtyContextInsertKind,
  ) => {
    const payload = text.trimEnd();
    if (!payload) return;
    void window.ade.terminal.write({
      terminalId: target.sessionId,
      ptyId: target.ptyId,
      data: bracketedPaste(payload),
    }, runtimePin)
      .then(() => {
        dispatchWorkPtyContextInserted({
          sessionId: target.sessionId,
          ptyId: target.ptyId,
          toolType: target.toolType,
          kind,
        });
      })
      .catch((error: unknown) => {
        console.error("[WorkSidebar] Failed to insert context into PTY", {
          sessionId: target.sessionId,
          toolType: target.toolType,
          error,
        });
      });
  }, [runtimePin]);

  const withContextTarget = useCallback((
    fallbackError: string,
    action: (target: WorkSidebarContextTarget) => void,
  ) => {
    const { contextTarget: target, contextDisabledReason: targetReason } = dispatchTargetRef.current;
    if (!target || targetReason) {
      throw new Error(targetReason ?? fallbackError);
    }
    action(target);
  }, []);

  const insertContext = useCallback(<T,>(
    eventName: string,
    key: string,
    value: T,
    kind: WorkPtyContextInsertKind,
    formatForPty: (value: T) => string | null,
  ) => {
    withContextTarget(NO_CONTEXT_TARGET_ERROR, (target) => {
      if (target.kind === "chat" || target.kind === "draft") {
        dispatchAgentChatEvent(eventName, target, key, value);
        return;
      }
      const text = formatForPty(value);
      if (text) insertIntoPty(target, text, kind);
    });
  }, [insertIntoPty, withContextTarget]);

  const addAttachment = useCallback((attachment: AgentChatFileRef) => {
    insertContext(
      "ade:agent-chat:add-attachment",
      "attachment",
      attachment,
      "attachment",
      formatAttachmentForPty,
    );
  }, [insertContext]);
  const addIosContext = useCallback((item: IosElementContextItem) => {
    insertContext(
      "ade:agent-chat:add-ios-context",
      "item",
      item,
      "ios",
      (value) => formatIosElementContextForPrompt([value]),
    );
  }, [insertContext]);
  const addAppControlContext = useCallback((item: AppControlContextItem) => {
    insertContext(
      "ade:agent-chat:add-app-control-context",
      "item",
      item,
      "app-control",
      (value) => formatAppControlContextForPrompt([value]),
    );
  }, [insertContext]);
  const addBuiltInBrowserContext = useCallback((item: unknown) => {
    insertContext(
      "ade:agent-chat:add-builtin-browser-context",
      "item",
      item,
      "browser",
      (value) => {
        const browserItem = normalizeBuiltInBrowserContextItem(value);
        return browserItem ? formatBuiltInBrowserContextForPrompt([browserItem]) : null;
      },
    );
  }, [insertContext]);
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

  const insertDraft = useCallback((text: string) => {
    withContextTarget("Open a chat, draft, or agent CLI session in this lane before inserting draft text.", (target) => {
      if (target.kind === "chat" || target.kind === "draft") {
        dispatchAgentChatEvent("ade:agent-chat:insert-draft", target, "text", text);
        return;
      }
      insertIntoPty(target, text, "draft");
    });
  }, [insertIntoPty, withContextTarget]);

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
    onRegisterPrRefresh: setPrRefreshAction,
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
  // is why no panel is ever mounted inside an `inert` subtree today, and it is
  // the invariant a CSS hide here would quietly break.
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

  const closePane = useCallback(() => {
    if (effectiveTool === "browser") hideBuiltInBrowserView(browserViewRoot);
    onClose();
  }, [browserViewRoot, effectiveTool, onClose]);

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
  const applyPickerBinding = useCallback((event: KeyboardEvent, targetElement: Element | null) => {
    if (aModalLayerIsOpen()) return;
    if (targetElement && escapeIsClaimedInside(targetElement)) return;
    const insideTerminal = targetElement?.closest(".xterm") != null;
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
    const target = event.target as Node | null;
    // Capture phase, so this runs before xterm's own key handling — but only
    // for keys pressed inside this pane, and never while a modal layer is up.
    if (!target || !sidebarRef.current?.contains(target)) return;
    const targetElement = target instanceof Element ? target : target.parentElement;
    applyPickerBinding(event.nativeEvent, targetElement);
  }, [applyPickerBinding]);

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
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      paneHasPointerRef.current = target instanceof Node
        ? Boolean(sidebarRef.current?.contains(target))
        : false;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // Only ever for keystrokes that landed on `<body>`: anything with a real
  // focus target is handled by the pane's own capture handler above (or belongs
  // to whatever does have focus), so there is no double handling.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== document.body) return;
      if (!paneHasPointerRef.current) return;
      applyPickerBinding(event, null);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [applyPickerBinding]);

  // Browser: the page you are on. Terminal: how many shells. Git: the branch.
  // One compact fact, so the header answers "which one of these am I looking
  // at" without duplicating the panel's own chrome. The per-tool rule lives on
  // the tool's own catalogue entry, next to its label and its icon.
  const headerContextLabel = useMemo(() => (
    effectiveTool
      ? workToolContextLabel(effectiveTool, { lane: activeLane, status: statuses[effectiveTool] ?? null })
      : null
  ), [activeLane, effectiveTool, statuses]);

  const transition = reduceMotion
    ? { duration: 0 }
    : revealTransition;

  return (
    <aside
      ref={sidebarRef}
      onKeyDownCapture={handleKeyDownCapture}
      // Focusable only programmatically (`selectTool`), and never ringed for
      // it: this is a focus fallback, not a stop on the tab order.
      tabIndex={-1}
      // `min-w-0` + `overflow-hidden`, never a pixel `min-width`: a minimum on
      // the pane makes it wider than the column flexbox gave it, and the
      // overflow is then clipped by the window — which is how the ✕ and the
      // browser's ⋮ ended up unreachable. The drag is what enforces 280px
      // (`clampWorkSidebarWidthPct`); the pane itself just never escapes.
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l border-white/[0.08] bg-surface/85 outline-none"
    >
      {effectiveTool ? (
        <WorkToolHeader
          tool={effectiveTool}
          context={toolContext}
          contextLabel={headerContextLabel}
          statuses={statuses}
          contextAction={effectiveTool === "pr" && prRefreshAction ? (
            <PaneTooltip label={prRefreshAction.syncing ? "Syncing PR status…" : "Refresh pull request"} side="bottom">
              <button
                type="button"
                onClick={prRefreshAction.run}
                disabled={prRefreshAction.syncing}
                aria-label="Refresh pull request"
                className={cn(
                  "inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-fg/70",
                  "transition-colors duration-[120ms] ease-out hover:bg-white/[0.06] hover:text-fg",
                  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                  "disabled:pointer-events-none disabled:opacity-45",
                )}
              >
                <ArrowsClockwise size={12} weight="bold" className={cn(prRefreshAction.syncing && "animate-spin")} />
              </button>
            </PaneTooltip>
          ) : null}
          // Reads the real binding rather than a hard-coded "Esc", so a
          // rebound `work.tools.picker` never advertises the wrong key.
          backShortcut={effectiveTool === "terminal" ? terminalPickerBinding : pickerBinding}
          onShowPicker={() => selectTool(null)}
          onPick={selectTool}
          onClose={closePane}
        />
      ) : (
        <WorkToolPickerHeader onClose={closePane} />
      )}
      {/* A true crossfade, so the two surfaces overlap rather than the pane
          blanking between them: both children are absolutely positioned and
          the outgoing one stops taking pointer events the moment it starts to
          leave. Switching away from the browser parks its WebContentsView
          synchronously (`selectTool`), so the native view is never composited
          over the incoming tool during the overlap. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence initial={false}>
          <motion.div
            key={effectiveTool ?? "picker"}
            className="absolute inset-0 min-h-0"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, pointerEvents: "none" }}
            transition={transition}
          >
            {effectiveTool ? content : (
              <WorkToolPicker
                activeTool={tool}
                context={toolContext}
                statuses={statuses}
                loading={statusesLoading}
                pickerShortcut={pickerBinding}
                onPick={selectTool}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </aside>
  );
}
