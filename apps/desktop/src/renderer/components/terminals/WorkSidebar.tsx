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
  BuiltInBrowserStatus,
  GitCommitSummary,
  IosElementContextItem,
  IosSimulatorSession,
  LaneSummary,
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
import { formatToolTypeLabel } from "../../lib/sessions";
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
import { useBuiltinGateInput } from "../plugins/useBuiltinTabs";
import { isBuiltinSurfaceVisible } from "../plugins/builtinTabs";
import {
  isPluginPanelSlotId,
  PluginSlotPanel,
  pluginSessionContext,
  usePluginPanelSlots,
} from "../plugins/sockets";
import type { PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";

/**
 * The glow behind a rail item is the item's own colour at low alpha, so the two
 * are one decision, not two. Deriving it here means a theme overrides a single
 * `--work-rail-*` token and gets both.
 */
function railGlow(token: string, percent: number): string {
  return `radial-gradient(circle, color-mix(in srgb, var(${token}) ${percent}%, transparent) 0%, transparent 70%)`;
}

const WORK_SIDEBAR_TABS: Array<GlowMenuItem<WorkSidebarTab>> = [
  {
    id: "terminal",
    label: "Terminal",
    icon: Terminal,
    gradient: railGlow("--work-rail-terminal", 38),
    color: "var(--work-rail-terminal)",
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranch,
    gradient: railGlow("--work-rail-git", 42),
    color: "var(--work-rail-git)",
  },
  {
    id: "files",
    label: "Files",
    icon: FolderOpen,
    gradient: railGlow("--work-rail-files", 38),
    color: "var(--work-rail-files)",
  },
  {
    id: "ios",
    label: "iOS Sim",
    icon: DeviceMobile,
    gradient: railGlow("--work-rail-ios", 40),
    color: "var(--work-rail-ios)",
  },
  {
    id: "app-control",
    label: "Electron Control",
    icon: Desktop,
    gradient: railGlow("--work-rail-app-control", 42),
    color: "var(--work-rail-app-control)",
  },
  {
    id: "browser",
    label: "Browser",
    icon: Globe,
    gradient: railGlow("--work-rail-browser", 38),
    color: "var(--work-rail-browser)",
  },
];

const REMOTE_WORK_SIDEBAR_TAB_IDS = new Set<WorkSidebarTab>(["terminal", "git", "files"]);

function isRemoteWorkSidebarTab(tab: WorkSidebarTab): boolean {
  return REMOTE_WORK_SIDEBAR_TAB_IDS.has(tab);
}

/**
 * Terminal, Git, Files and Browser are ADE itself and are never gated. iOS Sim
 * and Electron Control are compiled panes owned by plugins, so each needs its
 * owner installed and enabled on top of the host checks it already had —
 * a Mac with no iOS Simulator plugin has no iOS Sim tab.
 *
 * Pure on purpose: the caller passes the gate in, so the rail filter, the
 * fallback and the force-switch effect all ask the same question, and the
 * answer can be tested without rendering a sidebar.
 */
export function isAvailableWorkSidebarTab(
  tab: WorkSidebarTab,
  options: {
    isRemoteProject: boolean;
    supportsIosSimulator: boolean;
    builtinSurfaceVisible: (id: PluginBuiltinSurfaceId) => boolean;
    /** Slot ids currently contributed to the rail. Absent means none. */
    pluginPaneIds?: ReadonlySet<string>;
  },
): boolean {
  // A contributed pane is available exactly while its contribution is, and it
  // is asked FIRST: the remote and macOS gates below describe host capabilities
  // the six built-ins need, and a plugin panel is a vocabulary schema read from
  // the local plugin host — none of which a remote checkout changes.
  if (isPluginPanelSlotId(tab)) return options.pluginPaneIds?.has(tab) === true;
  if (tab === "ios" && !options.builtinSurfaceVisible("ios")) return false;
  if (tab === "app-control" && !options.builtinSurfaceVisible("app-control")) return false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function browserEventProjectRoot(value: unknown): string | null | undefined {
  if (!isRecord(value)) return undefined;
  if ("collectionProjectRoot" in value) {
    const root = value.collectionProjectRoot;
    return typeof root === "string" && root.trim().length > 0 ? root : null;
  }
  return browserEventProjectRoot(value.status);
}

function browserEventMatchesProject(event: unknown, projectRoot: string | null): boolean {
  const root = browserEventProjectRoot(event);
  if (root === undefined) return projectRoot == null;
  if (!projectRoot) return root === null;
  return root === projectRoot;
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
}) {
  const navigate = useNavigate();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<"staged" | "unstaged" | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<GitCommitSummary | null>(null);
  const [appControlSession, setAppControlSession] = useState<AppControlSession | null>(null);
  const [iosSession, setIosSession] = useState<IosSimulatorSession | null>(null);
  const [browserStatus, setBrowserStatus] = useState<BuiltInBrowserStatus | null>(null);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const isRemoteProject = useAppStore((state) => state.projectBinding?.kind === "remote");
  const supportsIosSimulator = isMacPlatform();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [compactTabs, setCompactTabs] = useState(false);
  const builtinGateInput = useBuiltinGateInput();
  const builtinSurfaceVisible = useCallback(
    (id: PluginBuiltinSurfaceId) => isBuiltinSurfaceVisible(id, builtinGateInput),
    [builtinGateInput],
  );
  // The session the rail sits beside, as a plugin sees it. Also what selects a
  // plugin's per-session `work-rail-pane` rows, so one chat can be offered a
  // different pane than another.
  const railSessionContext = useMemo(
    () => (activeSession
      ? pluginSessionContext({
        id: activeSession.id,
        title: activeSession.goal ?? activeSession.title,
        provider: activeSession.toolType,
        status: activeSession.runtimeState,
      })
      : null),
    [activeSession],
  );
  const pluginPanes = usePluginPanelSlots("work", "work-rail-pane", {
    active,
    context: railSessionContext,
  });
  const pluginPaneIds = useMemo(
    () => new Set(pluginPanes.map((pane) => pane.id)),
    [pluginPanes],
  );
  const tabAvailability = useMemo(
    () => ({ isRemoteProject, supportsIosSimulator, builtinSurfaceVisible, pluginPaneIds }),
    [builtinSurfaceVisible, isRemoteProject, pluginPaneIds, supportsIosSimulator],
  );
  const sidebarTabs = useMemo(
    () => [
      ...WORK_SIDEBAR_TABS.filter((item) => isAvailableWorkSidebarTab(item.id, tabAvailability)),
      // Always after ADE's own six. Contributed panes carry no rail colour of
      // their own: the `--work-rail-*` tokens name the product's tools, and a
      // plugin borrowing one would claim to be a tool it is not.
      ...pluginPanes.map((pane): GlowMenuItem<WorkSidebarTab> => ({
        id: pane.id as WorkSidebarTab,
        label: pane.label,
        icon: pane.icon,
        gradient: railGlow("--work-rail-plugin", 34),
        color: "var(--work-rail-plugin)",
      })),
    ],
    [pluginPanes, tabAvailability],
  );
  const effectiveTab: WorkSidebarTab = isAvailableWorkSidebarTab(tab, tabAvailability) ? tab : "git";
  const selectedPluginPane = useMemo(
    () => pluginPanes.find((pane) => pane.id === effectiveTab) ?? null,
    [effectiveTab, pluginPanes],
  );

  const activeLane = useMemo(
    () => (laneId ? lanes.find((lane) => lane.id === laneId) ?? null : null),
    [laneId, lanes],
  );
  const laneRoot = activeLane?.worktreePath ?? null;

  useEffect(() => {
    setSelectedPath(null);
    setSelectedMode(null);
    setSelectedCommit(null);
  }, [laneId]);

  // Also the uninstall path: the pane the user is sitting in can lose its
  // plugin mid-session, and `tabAvailability` changing is what moves them off
  // it instead of leaving a rail with no matching tab.
  //
  // A contributed pane is deliberately exempt from the WRITE. Contributions
  // load a tick after the rail mounts, so a persisted plugin pane is
  // unavailable on the first render of every launch — and writing "git" there
  // would erase the user's selected pane before the plugin that owns it had a
  // chance to arrive. `effectiveTab` already falls back for the render, so the
  // pane shows Git until the contribution lands and then restores itself; a
  // plugin that is genuinely gone simply never restores, and the stale id is
  // overwritten the next time a tab is picked.
  useEffect(() => {
    if (isPluginPanelSlotId(tab)) return;
    if (!isAvailableWorkSidebarTab(tab, tabAvailability)) {
      onTabChange("git");
    }
  }, [onTabChange, tab, tabAvailability]);

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
    if (wasBrowser && !isBrowser) hideBuiltInBrowserView(projectRoot);
    previousBrowserTabRef.current = isBrowser;
    return () => {
      if (previousBrowserTabRef.current) hideBuiltInBrowserView(projectRoot);
    };
  }, [active, effectiveTab, projectRoot]);

  useEffect(() => {
    if (!active) return undefined;
    if (effectiveTab !== "browser") return undefined;
    const browser = window.ade?.builtInBrowser;
    if (!browser?.getStatus || !browser.onEvent) return undefined;
    let cancelled = false;
    const scope = projectRoot ? { projectRoot } : {};
    void browser.getStatus(scope)
      .then((status) => {
        if (!cancelled) setBrowserStatus(status);
      })
      .catch(() => {
        if (!cancelled) setBrowserStatus(null);
      });
    const unsubscribe = browser.onEvent((event) => {
      if (event.type === "status" || event.type === "open-request") {
        if (!isRecord(event.status)) return;
        if (!browserEventMatchesProject(event, projectRoot)) return;
        setBrowserStatus(event.status as BuiltInBrowserStatus);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, effectiveTab, projectRoot]);

  useEffect(() => {
    if (!active) return undefined;
    if (effectiveTab !== "app-control") return undefined;
    const appControl = window.ade?.appControl;
    if (!appControl?.getStatus || !appControl.onEvent) return undefined;
    let cancelled = false;
    void appControl.getStatus()
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
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, effectiveTab]);

  useEffect(() => {
    if (!active) return undefined;
    if (effectiveTab !== "ios") return undefined;
    const iosSimulator = window.ade?.iosSimulator;
    if (!iosSimulator?.getStatus || !iosSimulator.onEvent) return undefined;
    let cancelled = false;
    void iosSimulator.getStatus()
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
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, effectiveTab]);

  function resolveToolAttributionReason(): string | null {
    if (!laneId) return null;
    if (effectiveTab === "app-control" && appControlSession?.laneId && appControlSession.laneId !== laneId) {
      return laneMismatchMessage("Electron Control", appControlSession.laneId, laneId, lanes);
    }
    if (effectiveTab === "ios" && iosSession?.laneId && iosSession.laneId !== laneId) {
      return laneMismatchMessage("iOS Simulator", iosSession.laneId, laneId, lanes);
    }
    return null;
  }
  const toolAttributionReason = resolveToolAttributionReason();
  const contextDisabledReason = targetDisabledReason;
  const warningReason = toolAttributionReason ?? contextDisabledReason;
  const canInsertContext = Boolean(contextTarget && !contextDisabledReason);
  const shouldPersistPanelAttachment = canInsertContext && contextTarget?.kind === "pty";
  const panelSessionId = contextTarget?.kind === "chat" ? contextTarget.sessionId : null;
  const terminalOwnerSessionId =
    contextTarget?.kind === "chat" || contextTarget?.kind === "pty"
      ? contextTarget.sessionId
      : null;

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
    })
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
  }, []);

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
    // Before the lane guard below: a plugin pane's subject is its own data and
    // the chat beside it, so it works in a window with no lane selected — which
    // is exactly the case a "no lane" placeholder would wrongly claim it needs.
    if (selectedPluginPane) {
      return (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
          <PluginSlotPanel slot={selectedPluginPane} active={active} context={railSessionContext} />
        </div>
      );
    }
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
      return (
        <ChatTerminalDrawer
          variant="panel"
          open
          onToggle={onClose}
          laneId={laneId}
          chatSessionId={terminalOwnerSessionId}
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
              sessionId={panelSessionId}
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
      const hasDiffSelection = Boolean(selectedPath || selectedCommit);
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className={cn("min-h-0 overflow-auto", hasDiffSelection ? "max-h-[58%] shrink-0" : "flex-1")}>
            <LaneGitActionsPane
              laneId={laneId}
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
      return <FilesTab preferredLaneId={laneId} embedded />;
    }

    const panel = effectiveTab === "ios" ? (
      <ChatIosSimulatorPanel
        sessionId={panelSessionId}
        laneId={laneId}
        projectRoot={laneRoot}
        controlDisabledReason={null}
        ignoreChatOwnership
        onAddAttachment={shouldPersistPanelAttachment ? addAttachment : undefined}
        onAddContext={canInsertContext ? addIosContext : undefined}
        onInsertDraft={canInsertContext ? insertDraft : undefined}
      />
    ) : (
      <ChatAppControlPanel
        sessionId={panelSessionId}
        laneId={laneId}
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
    terminalOwnerSessionId,
    railSessionContext,
    selectedPluginPane,
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
            if (effectiveTab === "browser" && nextTab !== "browser") hideBuiltInBrowserView(projectRoot);
            onTabChange(nextTab);
          }}
        />
        <button
          type="button"
          className="ade-shell-control inline-flex w-9 shrink-0 items-center justify-center self-stretch rounded-none border-l border-white/[0.08] text-muted-fg/70 transition-colors hover:bg-white/[0.04] hover:text-fg"
          data-variant="ghost"
          onClick={() => {
            if (effectiveTab === "browser") hideBuiltInBrowserView(projectRoot);
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
