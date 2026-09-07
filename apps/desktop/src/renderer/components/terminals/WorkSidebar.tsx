import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { WarningCircle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
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
import { selectActiveProjectRoot, useAppStore, type WorkDraftKind, type WorkSidebarTab } from "../../state/appStore";
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
import { useLanesForPin, useMachineEntryForBinding } from "../../state/crossMachineLanes";
import { machineNameForBinding } from "../../../shared/machineIdentity";
import { eventMatchesBinding, getEffectiveBinding } from "../../lib/keybindings";
import { formatToolTypeLabel, isChatToolType, isPtyContextInsertableToolType } from "../../lib/sessions";
import { isMacPlatform } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";
import { ChatAppControlPanel } from "../chat/ChatAppControlPanel";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { ChatIosSimulatorPanel } from "../chat/ChatIosSimulatorPanel";
import { ChatPrPane } from "../chat/ChatPrPane";
import { ChatTerminalDrawer } from "../chat/ChatTerminalDrawer";
import { FilesTab } from "../files/FilesTab";
import { LaneDiffPane } from "../lanes/LaneDiffPane";
import { LaneGitActionsPane } from "../lanes/LaneGitActionsPane";
import { cn } from "../ui/cn";
import { settingsRouteFor } from "../settings/settingsManifest";
import { WorkToolHeader, WorkToolPickerHeader } from "./WorkToolHeader";
import { WorkToolPicker } from "./WorkToolPicker";
import { useWorkToolStatuses } from "./useWorkToolStatuses";
import { isAvailableWorkSidebarTab, isReadOnlyWorkTool, type WorkToolContext } from "./workTools";
import { WorkToolReadOnlyView } from "./WorkToolReadOnlyView";

/** Escape returns to the picker, but only from inside the pane — see `work.tools.picker`. */
const TOOLS_PICKER_BINDING_ID = "work.tools.picker";
const TOOLS_PICKER_DEFAULT_BINDING = "Escape";

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

function WarningBanner({ message }: { message: string }) {
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-amber-400/15 bg-amber-500/[0.055] px-3 py-2 text-[11px] leading-4 text-amber-100/85">
      <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0 text-amber-200/80" />
      <span>{message}</span>
    </div>
  );
}

function TerminalPanelEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-[12px] leading-5 text-muted-fg">
      {message}
    </div>
  );
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
  const navigate = useNavigate();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<"staged" | "unstaged" | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<GitCommitSummary | null>(null);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const keybindings = useAppStore((state) => state.keybindings);
  const reduceMotion = useReducedMotion() ?? false;
  // The browser view is owned by THIS window's main process. A pin on another
  // checkout of this computer still drives that view, just under the pinned
  // checkout's tab collection, so hiding it on leave has to follow the pin. A
  // pin on another machine never opens a view here — the panel explains that
  // instead of driving a browser nobody in this window can see.
  const browserViewRoot = runtimePin?.kind === "local" ? runtimePin.rootPath : projectRoot;
  const isRemoteProject = useAppStore((state) => state.projectBinding?.kind === "remote");
  const sidebarRef = useRef<HTMLElement | null>(null);
  // Capability flags, never a platform sniff: the hosted web client renders this
  // same component with stubbed native namespaces.
  const toolContext = useMemo<WorkToolContext>(() => ({
    isRemoteProject,
    supportsIosSimulator: isMacPlatform(),
    isWebClient: isWebClientMode(),
  }), [isRemoteProject]);
  // An unavailable tool falls back to the PICKER, not to some other tool: being
  // dropped into Git because the simulator is unavailable on this machine is a
  // non-sequitur, and the picker says why the card is dimmed.
  const effectiveTool: WorkSidebarTab | null =
    tool && isAvailableWorkSidebarTab(tool, toolContext) ? tool : null;

  // A foreign chat's lane is absent from the tab-bound `lanes` array, so the
  // worktree path (and therefore iOS / App Control) resolved to null. Fall
  // back to the machine's slice of the cross-machine union.
  const pinnedMachine = useMachineEntryForBinding(runtimePin);
  const pinnedLanes = useLanesForPin(runtimePin);
  const scopedLanes = pinnedLanes ?? lanes;
  const activeLane = useMemo(
    () => (laneId ? scopedLanes.find((lane) => lane.id === laneId) ?? null : null),
    [laneId, scopedLanes],
  );
  const laneRoot = activeLane?.worktreePath ?? null;
  // Pinned calls have no local fallback, so a machine that is not answering
  // gets one plain line instead of a wall of rejected IPC.
  const pinnedMachineOffline = Boolean(runtimePin) && pinnedMachine?.online === false;
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

  const terminalOwnerSessionIdForStatus = useMemo(() => {
    if (activeSession && isChatToolType(activeSession.toolType)) return activeSession.id;
    return contextTarget?.kind === "chat" || contextTarget?.kind === "pty"
      ? contextTarget.sessionId
      : null;
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
    context: toolContext,
    laneId,
    lane: activeLane,
    runtimePin,
    terminalOwnerSessionId: terminalOwnerSessionIdForStatus,
    browserViewRoot,
    pinnedMachineId: pinnedMachine?.machineId ?? null,
    offline: pinnedMachineOffline,
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
  // Terminal ownership is an identity question, not a permission one: any chat
  // or running agent-CLI session can host attached terminals, including one on
  // another machine. Deriving it from `contextTarget` conflated the two and
  // showed foreign chats an "open a chat..." empty state instead of a terminal.
  const terminalOwnerSessionId = useMemo(() => {
    if (activeSession) {
      if (isChatToolType(activeSession.toolType)) return activeSession.id;
      if (
        activeSession.status === "running"
        && activeSession.ptyId
        && isPtyContextInsertableToolType(activeSession.toolType)
      ) {
        return activeSession.id;
      }
      return null;
    }
    return contextTarget?.kind === "chat" || contextTarget?.kind === "pty"
      ? contextTarget.sessionId
      : null;
  }, [activeSession, contextTarget]);

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
  const insertDraft = useCallback((text: string) => {
    withContextTarget("Open a chat, draft, or agent CLI session in this lane before inserting draft text.", (target) => {
      if (target.kind === "chat" || target.kind === "draft") {
        dispatchAgentChatEvent("ade:agent-chat:insert-draft", target, "text", text);
        return;
      }
      insertIntoPty(target, text, "draft");
    });
  }, [insertIntoPty, withContextTarget]);

  const content = useMemo(() => {
    if (!active || !effectiveTool) return null;
    if (effectiveTool === "terminal") {
      if (!laneId) {
        return <TerminalPanelEmpty message="Select a lane or open a Work session to attach terminals." />;
      }
      if (!terminalOwnerSessionId) {
        const message = activeSession?.status && activeSession.status !== "running"
          ? `Continue this ${formatToolTypeLabel(activeSession.toolType)} session before opening an attached terminal.`
          : "Open a chat or running agent CLI session to attach terminals.";
        return <TerminalPanelEmpty message={message} />;
      }
      if (pinnedMachineOffline) {
        return <TerminalPanelEmpty message={`${pinnedMachineName} is offline.`} />;
      }
      return (
        <ChatTerminalDrawer
          // Remount on a machine change so a foreign machine's tabs can never
          // paint into the machine you just switched to.
          key={`work-terminal:${runtimePin?.key ?? "bound"}:${terminalOwnerSessionId}`}
          variant="panel"
          open
          onToggle={onClose}
          laneId={laneId}
          chatSessionId={terminalOwnerSessionId}
          runtimePin={runtimePin}
          emptyMessage="Create a terminal to work alongside this session."
        />
      );
    }

    // A surface that cannot drive the tool shows what the desktop is doing with
    // it instead. Checked before the native panels so neither one mounts a
    // stubbed namespace it would only fail against.
    if (
      (effectiveTool === "browser" || effectiveTool === "app-control")
      && isReadOnlyWorkTool(effectiveTool, toolContext)
    ) {
      return <WorkToolReadOnlyView tool={effectiveTool} laneId={laneId} />;
    }

    if (effectiveTool === "browser") {
      return (
        <div className="flex h-full min-h-0 flex-col">
          {warningReason ? <WarningBanner message={warningReason} /> : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatBuiltInBrowserPanel
              key={`work-browser:${runtimePin?.key ?? "bound"}`}
              sessionId={panelSessionId}
              runtimePin={runtimePin}
              onAddAttachment={shouldPersistPanelAttachment ? addAttachment : undefined}
              onAddContext={canInsertContext ? addBuiltInBrowserContext : undefined}
              onInsertDraft={canInsertContext ? insertDraft : undefined}
            />
          </div>
        </div>
      );
    }

    if (!laneId) {
      return (
        <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-fg">
          Select a lane or open a Work session to use the sidebar.
        </div>
      );
    }

    if (effectiveTool === "git") {
      if (pinnedMachineOffline) {
        return <TerminalPanelEmpty message={`${pinnedMachineName} is offline.`} />;
      }
      const hasDiffSelection = Boolean(selectedPath || selectedCommit);
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className={cn("min-h-0 overflow-auto", hasDiffSelection ? "max-h-[58%] shrink-0" : "flex-1")}>
            <LaneGitActionsPane
              key={`work-git:${runtimePin?.key ?? "bound"}:${laneId}`}
              laneId={laneId}
              runtimePin={runtimePin}
              autoRebaseEnabled={false}
              onOpenSettings={() => navigate(settingsRouteFor("lanes-git.lane-templates"))}
              onSelectFile={(path, mode) => {
                setSelectedPath(path);
                setSelectedMode(mode);
                setSelectedCommit(null);
              }}
              onSelectCommit={(commit) => {
                setSelectedCommit(commit);
                if (commit) {
                  setSelectedPath(null);
                  setSelectedMode(null);
                }
              }}
              onClearDiffSelection={() => {
                setSelectedPath(null);
                setSelectedMode(null);
                setSelectedCommit(null);
              }}
              selectedPath={selectedPath}
              selectedMode={selectedMode}
              selectedCommit={selectedCommit}
              selectedCommitSha={selectedCommit?.sha ?? null}
            />
          </div>
          {hasDiffSelection ? (
            <div className="min-h-0 flex-1 border-t border-white/[0.08]">
              <LaneDiffPane
                laneId={laneId}
                runtimePin={runtimePin}
                selectedPath={selectedPath}
                selectedFileMode={selectedMode}
                selectedCommit={selectedCommit}
                liveSync
              />
            </div>
          ) : null}
        </div>
      );
    }

    if (effectiveTool === "pr") {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <ChatPrPane
            key={`work-pr:${runtimePin?.key ?? "bound"}:${laneId}`}
            laneId={laneId}
            branchName={activeLane?.branchRef ?? null}
            sessionTitle={activeSession?.title ?? null}
            sessionId={panelSessionId}
            runtimePin={runtimePin}
            onClose={() => onToolChange(null)}
          />
        </div>
      );
    }

    if (effectiveTool === "files") {
      return (
        <FilesTab
          key={`work-files:${runtimePin?.key ?? "bound"}`}
          preferredLaneId={laneId}
          pin={runtimePin}
          embedded
        />
      );
    }

    const panel = effectiveTool === "ios" ? (
      <ChatIosSimulatorPanel
        key={`work-ios:${runtimePin?.key ?? "bound"}`}
        sessionId={panelSessionId}
        laneId={laneId}
        runtimePin={runtimePin}
        projectRoot={laneRoot}
        controlDisabledReason={null}
        ignoreChatOwnership
        onAddAttachment={shouldPersistPanelAttachment ? addAttachment : undefined}
        onAddContext={canInsertContext ? addIosContext : undefined}
        onInsertDraft={canInsertContext ? insertDraft : undefined}
      />
    ) : (
      <ChatAppControlPanel
        key={`work-appcontrol:${runtimePin?.key ?? "bound"}`}
        sessionId={panelSessionId}
        laneId={laneId}
        runtimePin={runtimePin}
        projectRoot={laneRoot}
        controlDisabledReason={null}
        onAddAttachment={shouldPersistPanelAttachment ? addAttachment : undefined}
        onAddContext={canInsertContext ? addAppControlContext : undefined}
        onInsertDraft={canInsertContext ? insertDraft : undefined}
      />
    );
    return (
      <div className="flex h-full min-h-0 flex-col">
        {warningReason ? <WarningBanner message={warningReason} /> : null}
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3">{panel}</div>
      </div>
    );
  }, [
    activeLane?.branchRef,
    addAppControlContext,
    addAttachment,
    addBuiltInBrowserContext,
    addIosContext,
    panelSessionId,
    canInsertContext,
    insertDraft,
    laneId,
    warningReason,
    shouldPersistPanelAttachment,
    laneRoot,
    navigate,
    onToolChange,
    selectedCommit,
    selectedMode,
    selectedPath,
    active,
    effectiveTool,
    activeSession,
    onClose,
    pinnedMachineName,
    pinnedMachineOffline,
    runtimePin,
    terminalOwnerSessionId,
  ]);

  const selectTool = useCallback((next: WorkSidebarTab | null) => {
    if (effectiveTool === "browser" && next !== "browser") hideBuiltInBrowserView(browserViewRoot);
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
  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (!effectiveTool) return;
    if (!eventMatchesBinding(event.nativeEvent, pickerBinding)) return;
    event.preventDefault();
    event.stopPropagation();
    selectTool(null);
  }, [effectiveTool, pickerBinding, selectTool]);

  // Browser: the page you are on. Terminal: how many shells. Git: the branch.
  // One compact fact, so the header answers "which one of these am I looking
  // at" without duplicating the panel's own chrome.
  const headerContextLabel = useMemo(() => {
    if (!effectiveTool) return null;
    if (effectiveTool === "git") return activeLane?.branchRef ?? null;
    if (effectiveTool === "files") return activeLane?.name ?? null;
    return statuses[effectiveTool]?.line ?? null;
  }, [activeLane, effectiveTool, statuses]);

  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.4, 0, 0.2, 1] as const };

  return (
    <aside
      ref={sidebarRef}
      onKeyDown={handleKeyDown}
      className="flex h-full min-h-0 min-w-[280px] flex-col border-l border-white/[0.08] bg-surface/85"
    >
      {effectiveTool ? (
        <WorkToolHeader
          tool={effectiveTool}
          context={toolContext}
          contextLabel={headerContextLabel}
          statuses={statuses}
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
                onPick={selectTool}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </aside>
  );
}
