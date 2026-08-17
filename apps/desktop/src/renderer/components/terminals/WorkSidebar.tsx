import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Desktop,
  DeviceMobile,
  FolderOpen,
  GitBranch,
  Globe,
  Terminal,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type {
  AgentChatFileRef,
  AppControlContextItem,
  AppControlSession,
  GitCommitSummary,
  IosElementContextItem,
  IosSimulatorSession,
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
import { formatToolTypeLabel, isChatToolType, isPtyContextInsertableToolType } from "../../lib/sessions";
import { isMacPlatform } from "../../lib/platform";
import { ChatAppControlPanel } from "../chat/ChatAppControlPanel";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { ChatIosSimulatorPanel } from "../chat/ChatIosSimulatorPanel";
import { ChatTerminalDrawer } from "../chat/ChatTerminalDrawer";
import { FilesTab } from "../files/FilesTab";
import { LaneDiffPane } from "../lanes/LaneDiffPane";
import { LaneGitActionsPane } from "../lanes/LaneGitActionsPane";
import { GlowMenu, type GlowMenuItem } from "../ui/GlowMenu";
import { cn } from "../ui/cn";
import { settingsRouteFor } from "../settings/settingsManifest";

const WORK_SIDEBAR_TABS: Array<GlowMenuItem<WorkSidebarTab>> = [
  {
    id: "terminal",
    label: "Terminal",
    icon: Terminal,
    gradient: "radial-gradient(circle, rgba(196,181,253,0.38) 0%, transparent 70%)",
    color: "#c4b5fd",
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranch,
    gradient: "radial-gradient(circle, rgba(52,211,153,0.42) 0%, transparent 70%)",
    color: "#34d399",
  },
  {
    id: "files",
    label: "Files",
    icon: FolderOpen,
    gradient: "radial-gradient(circle, rgba(251,191,36,0.38) 0%, transparent 70%)",
    color: "#fbbf24",
  },
  {
    id: "ios",
    label: "iOS Sim",
    icon: DeviceMobile,
    gradient: "radial-gradient(circle, rgba(96,165,250,0.4) 0%, transparent 70%)",
    color: "#60a5fa",
  },
  {
    id: "app-control",
    label: "App Control",
    icon: Desktop,
    gradient: "radial-gradient(circle, rgba(167,139,250,0.42) 0%, transparent 70%)",
    color: "#a78bfa",
  },
  {
    id: "browser",
    label: "Browser",
    icon: Globe,
    gradient: "radial-gradient(circle, rgba(34,211,238,0.38) 0%, transparent 70%)",
    color: "#22d3ee",
  },
];

const REMOTE_WORK_SIDEBAR_TAB_IDS = new Set<WorkSidebarTab>(["terminal", "git", "files"]);

function isRemoteWorkSidebarTab(tab: WorkSidebarTab): boolean {
  return REMOTE_WORK_SIDEBAR_TAB_IDS.has(tab);
}

function isAvailableWorkSidebarTab(
  tab: WorkSidebarTab,
  options: { isRemoteProject: boolean; supportsIosSimulator: boolean },
): boolean {
  if (options.isRemoteProject) return isRemoteWorkSidebarTab(tab);
  return tab !== "ios" || options.supportsIosSimulator;
}

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
  tab,
  onTabChange,
  onClose,
  contextTarget,
  contextDisabledReason: targetDisabledReason,
  runtimePin = null,
}: {
  active?: boolean;
  laneId: string | null;
  lanes: LaneSummary[];
  activeSession: TerminalSessionSummary | null;
  tab: WorkSidebarTab;
  onTabChange: (tab: WorkSidebarTab) => void;
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
  const [appControlSession, setAppControlSession] = useState<AppControlSession | null>(null);
  const [iosSession, setIosSession] = useState<IosSimulatorSession | null>(null);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  // The browser view is owned by THIS window's main process. A pin on another
  // checkout of this computer still drives that view, just under the pinned
  // checkout's tab collection, so hiding it on leave has to follow the pin. A
  // pin on another machine never opens a view here — the panel explains that
  // instead of driving a browser nobody in this window can see.
  const browserViewRoot = runtimePin?.kind === "local" ? runtimePin.rootPath : projectRoot;
  const isRemoteProject = useAppStore((state) => state.projectBinding?.kind === "remote");
  const supportsIosSimulator = isMacPlatform();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [compactTabs, setCompactTabs] = useState(false);
  const sidebarTabs = useMemo(
    () => WORK_SIDEBAR_TABS.filter((item) => isAvailableWorkSidebarTab(item.id, {
      isRemoteProject,
      supportsIosSimulator,
    })),
    [isRemoteProject, supportsIosSimulator],
  );
  const effectiveTab: WorkSidebarTab = isAvailableWorkSidebarTab(tab, {
    isRemoteProject,
    supportsIosSimulator,
  }) ? tab : "git";

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
    if (!isAvailableWorkSidebarTab(tab, {
      isRemoteProject,
      supportsIosSimulator,
    })) {
      onTabChange("git");
    }
  }, [isRemoteProject, onTabChange, supportsIosSimulator, tab]);

  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return undefined;
    const update = () => {
      setCompactTabs(el.getBoundingClientRect().width < 460);
    };
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const previousBrowserTabRef = useRef(effectiveTab === "browser");
  useEffect(() => {
    const wasBrowser = previousBrowserTabRef.current;
    const isBrowser = active && effectiveTab === "browser";
    if (wasBrowser && !isBrowser) hideBuiltInBrowserView(browserViewRoot);
    previousBrowserTabRef.current = isBrowser;
    return () => {
      if (previousBrowserTabRef.current) hideBuiltInBrowserView(browserViewRoot);
    };
  }, [active, browserViewRoot, effectiveTab]);

  useEffect(() => {
    if (!active) return undefined;
    if (effectiveTab !== "app-control") return undefined;
    if (pinnedMachineOffline) return undefined;
    const appControl = window.ade?.appControl;
    if (!appControl?.getStatus || !appControl.onEvent) return undefined;
    let cancelled = false;
    void appControl.getStatus(runtimePin)
      .then((status) => {
        if (!cancelled) setAppControlSession(status.activeSession ?? null);
      })
      .catch(() => {
        if (!cancelled) setAppControlSession(null);
      });
    const unsubscribe = appControl.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        setAppControlSession(event.session ?? null);
      } else if (event.type === "session-stopped") {
        setAppControlSession(null);
      }
    }, runtimePin);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, effectiveTab, pinnedMachineOffline, runtimePin]);

  useEffect(() => {
    if (!active) return undefined;
    if (effectiveTab !== "ios") return undefined;
    if (pinnedMachineOffline) return undefined;
    const iosSimulator = window.ade?.iosSimulator;
    if (!iosSimulator?.getStatus || !iosSimulator.onEvent) return undefined;
    let cancelled = false;
    void iosSimulator.getStatus(runtimePin)
      .then((status) => {
        if (!cancelled) setIosSession(status.activeSession ?? null);
      })
      .catch(() => {
        if (!cancelled) setIosSession(null);
      });
    const unsubscribe = iosSimulator.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        setIosSession(event.session ?? null);
      } else if (event.type === "session-released") {
        setIosSession(null);
      }
    }, runtimePin);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, effectiveTab, pinnedMachineOffline, runtimePin]);

  function resolveToolAttributionReason(): string | null {
    if (!laneId) return null;
    if (effectiveTab === "app-control" && appControlSession?.laneId && appControlSession.laneId !== laneId) {
      return laneMismatchMessage("App Control", appControlSession.laneId, laneId, scopedLanes);
    }
    if (effectiveTab === "ios" && iosSession?.laneId && iosSession.laneId !== laneId) {
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
    if (!active) return null;
    if (effectiveTab === "terminal") {
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

    if (effectiveTab === "browser") {
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

    if (effectiveTab === "git") {
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

    if (effectiveTab === "files") {
      return (
        <FilesTab
          key={`work-files:${runtimePin?.key ?? "bound"}`}
          preferredLaneId={laneId}
          pin={runtimePin}
          embedded
        />
      );
    }

    const panel = effectiveTab === "ios" ? (
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
    selectedCommit,
    selectedMode,
    selectedPath,
    active,
    effectiveTab,
    activeSession,
    onClose,
    pinnedMachineName,
    pinnedMachineOffline,
    runtimePin,
    terminalOwnerSessionId,
  ]);

  return (
    <aside
      ref={sidebarRef}
      className="flex h-full min-h-0 min-w-[280px] flex-col border-l border-white/[0.08] bg-surface/85"
    >
      <div className="flex min-h-[42px] shrink-0 items-stretch border-b border-white/[0.08]">
        <GlowMenu
          variant="flat"
          className="min-w-0"
          items={sidebarTabs}
          activeItem={effectiveTab}
          compact={compactTabs}
          onItemClick={(nextTab) => {
            if (effectiveTab === "browser" && nextTab !== "browser") hideBuiltInBrowserView(browserViewRoot);
            onTabChange(nextTab);
          }}
        />
        <button
          type="button"
          className="ade-shell-control inline-flex w-9 shrink-0 items-center justify-center self-stretch rounded-none border-l border-white/[0.08] text-muted-fg/70 transition-colors hover:bg-white/[0.04] hover:text-fg"
          data-variant="ghost"
          onClick={() => {
            if (effectiveTab === "browser") hideBuiltInBrowserView(browserViewRoot);
            onClose();
          }}
          title="Close Tools sidebar"
          aria-label="Close Tools sidebar"
        >
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {content}
      </div>
    </aside>
  );
}
