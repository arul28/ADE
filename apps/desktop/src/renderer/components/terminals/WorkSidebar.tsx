import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Desktop,
  DeviceMobile,
  FolderOpen,
  GitBranch,
  Globe,
  Cube,
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
  MacosVmContextItem,
  TerminalSessionSummary,
} from "../../../shared/types";
import type { WorkSidebarTab } from "../../state/appStore";
import { formatToolTypeLabel } from "../../lib/sessions";
import { ChatAppControlPanel } from "../chat/ChatAppControlPanel";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { ChatIosSimulatorPanel } from "../chat/ChatIosSimulatorPanel";
import { FilesPage } from "../files/FilesPage";
import { LaneDiffPane } from "../lanes/LaneDiffPane";
import { LaneGitActionsPane } from "../lanes/LaneGitActionsPane";
import { MacosVmPanel } from "./MacosVmPanel";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";

const WORK_SIDEBAR_TABS: Array<{
  id: WorkSidebarTab;
  label: string;
  Icon: typeof GitBranch;
}> = [
  { id: "git", label: "Git", Icon: GitBranch },
  { id: "files", label: "Files", Icon: FolderOpen },
  { id: "ios", label: "iOS Sim", Icon: DeviceMobile },
  { id: "app-control", label: "App Control", Icon: Desktop },
  { id: "browser", label: "Browser", Icon: Globe },
  { id: "macos-vm", label: "Mac VM", Icon: Cube },
];

const NOT_CHAT_ERROR = "Context attachment only works in ADE chat sessions.";

function dispatchAgentChatEvent<T>(eventName: string, sessionId: string, key: string, value: T): void {
  window.dispatchEvent(new CustomEvent(eventName, {
    detail: {
      sessionId,
      [key]: value,
    },
  }));
}

function hideBuiltInBrowserView(): void {
  const browser = window.ade?.builtInBrowser;
  if (!browser) return;
  void browser.stopInspect().catch(() => {});
  void browser.setBounds({
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

export function WorkSidebar({
  laneId,
  lanes,
  activeSession,
  tab,
  onTabChange,
  onClose,
  attachChatSessionId,
  attachDisabledReason,
}: {
  laneId: string | null;
  lanes: LaneSummary[];
  activeSession: TerminalSessionSummary | null;
  tab: WorkSidebarTab;
  onTabChange: (tab: WorkSidebarTab) => void;
  onClose: () => void;
  attachChatSessionId: string | null;
  attachDisabledReason: string | null;
}) {
  const navigate = useNavigate();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<"staged" | "unstaged" | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<GitCommitSummary | null>(null);
  const [appControlSession, setAppControlSession] = useState<AppControlSession | null>(null);
  const [iosSession, setIosSession] = useState<IosSimulatorSession | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [compactTabs, setCompactTabs] = useState(false);

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

  const previousBrowserTabRef = useRef(tab === "browser");
  useEffect(() => {
    const wasBrowser = previousBrowserTabRef.current;
    const isBrowser = tab === "browser";
    if (wasBrowser && !isBrowser) hideBuiltInBrowserView();
    previousBrowserTabRef.current = isBrowser;
    return () => {
      if (previousBrowserTabRef.current) hideBuiltInBrowserView();
    };
  }, [tab]);

  useEffect(() => {
    if (tab !== "app-control") return undefined;
    let cancelled = false;
    void window.ade.appControl.getStatus()
      .then((status) => {
        if (!cancelled) setAppControlSession(status.activeSession ?? null);
      })
      .catch(() => {
        if (!cancelled) setAppControlSession(null);
      });
    const unsubscribe = window.ade.appControl.onEvent((event) => {
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
  }, [tab]);

  useEffect(() => {
    if (tab !== "ios") return undefined;
    let cancelled = false;
    void window.ade.iosSimulator.getStatus()
      .then((status) => {
        if (!cancelled) setIosSession(status.activeSession ?? null);
      })
      .catch(() => {
        if (!cancelled) setIosSession(null);
      });
    const unsubscribe = window.ade.iosSimulator.onEvent((event) => {
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
  }, [tab]);

  function resolveLaneMismatchReason(): string | null {
    if (!laneId) return null;
    if (tab === "app-control" && appControlSession?.laneId && appControlSession.laneId !== laneId) {
      return "App Control is attached to a different lane. You can still stop or relaunch it here, but ADE will not attach selections to this chat until the tool session matches the active lane.";
    }
    if (tab === "ios" && iosSession?.laneId && iosSession.laneId !== laneId) {
      return "The iOS Simulator session was launched from a different lane. You can still inspect it, but ADE will not attach simulator context to this chat until the tool session matches the active lane.";
    }
    return null;
  }
  const contextDisabledReason = resolveLaneMismatchReason() ?? attachDisabledReason;
  const canAttachToChat = Boolean(attachChatSessionId && !contextDisabledReason);

  const dispatchTargetRef = useRef({ attachChatSessionId, contextDisabledReason });
  dispatchTargetRef.current = { attachChatSessionId, contextDisabledReason };

  const dispatchToChat = useCallback(<T,>(eventName: string, key: string, value: T, fallbackError: string) => {
    const { attachChatSessionId: targetSessionId, contextDisabledReason: targetReason } = dispatchTargetRef.current;
    if (!targetSessionId || targetReason) {
      throw new Error(targetReason ?? fallbackError);
    }
    dispatchAgentChatEvent(eventName, targetSessionId, key, value);
  }, []);

  const addAttachment = useCallback((attachment: AgentChatFileRef) => {
    dispatchToChat("ade:agent-chat:add-attachment", "attachment", attachment, NOT_CHAT_ERROR);
  }, [dispatchToChat]);
  const addIosContext = useCallback((item: IosElementContextItem) => {
    dispatchToChat("ade:agent-chat:add-ios-context", "item", item, NOT_CHAT_ERROR);
  }, [dispatchToChat]);
  const addAppControlContext = useCallback((item: AppControlContextItem) => {
    dispatchToChat("ade:agent-chat:add-app-control-context", "item", item, NOT_CHAT_ERROR);
  }, [dispatchToChat]);
  const addMacosVmContext = useCallback((item: MacosVmContextItem) => {
    dispatchToChat("ade:agent-chat:add-macos-vm-context", "item", item, NOT_CHAT_ERROR);
  }, [dispatchToChat]);
  const addBuiltInBrowserContext = useCallback((item: unknown) => {
    dispatchToChat("ade:agent-chat:add-builtin-browser-context", "item", item, NOT_CHAT_ERROR);
  }, [dispatchToChat]);
  const insertDraft = useCallback((text: string) => {
    dispatchToChat("ade:agent-chat:insert-draft", "text", text, "Draft insertion only works in ADE chat sessions.");
  }, [dispatchToChat]);

  const content = useMemo(() => {
    if (tab === "browser") {
      return (
        <div className="flex h-full min-h-0 flex-col">
          {contextDisabledReason ? <WarningBanner message={contextDisabledReason} /> : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatBuiltInBrowserPanel
              sessionId={attachChatSessionId}
              onAddAttachment={canAttachToChat ? addAttachment : undefined}
              onAddContext={canAttachToChat ? addBuiltInBrowserContext : undefined}
              onInsertDraft={canAttachToChat ? insertDraft : undefined}
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

    if (tab === "git") {
      const hasDiffSelection = Boolean(selectedPath || selectedCommit);
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className={cn("min-h-0 overflow-auto", hasDiffSelection ? "max-h-[58%] shrink-0" : "flex-1")}>
            <LaneGitActionsPane
              laneId={laneId}
              autoRebaseEnabled={false}
              onOpenSettings={() => navigate("/settings?tab=lane-templates")}
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

    if (tab === "files") {
      return <FilesPage preferredLaneId={laneId} embedded />;
    }

    if (tab === "macos-vm") {
      return (
        <div className="flex h-full min-h-0 flex-col">
          {contextDisabledReason ? <WarningBanner message={contextDisabledReason} /> : null}
          <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
            <MacosVmPanel
              laneId={laneId}
              laneRoot={laneRoot}
              onAddContext={canAttachToChat ? addMacosVmContext : undefined}
            />
          </div>
        </div>
      );
    }

    const panel = tab === "ios" ? (
      <ChatIosSimulatorPanel
        sessionId={null}
        laneId={laneId}
        projectRoot={laneRoot}
        onAddAttachment={canAttachToChat ? addAttachment : undefined}
        onAddContext={canAttachToChat ? addIosContext : undefined}
        onInsertDraft={canAttachToChat ? insertDraft : undefined}
      />
    ) : (
      <ChatAppControlPanel
        sessionId={null}
        laneId={laneId}
        projectRoot={laneRoot}
        onAddAttachment={canAttachToChat ? addAttachment : undefined}
        onAddContext={canAttachToChat ? addAppControlContext : undefined}
        onInsertDraft={canAttachToChat ? insertDraft : undefined}
      />
    );
    return (
      <div className="flex h-full min-h-0 flex-col">
        {contextDisabledReason ? <WarningBanner message={contextDisabledReason} /> : null}
        <div className="min-h-0 flex-1 overflow-auto px-3 py-3">{panel}</div>
      </div>
    );
  }, [
    addAppControlContext,
    addAttachment,
    addBuiltInBrowserContext,
    addIosContext,
    addMacosVmContext,
    attachChatSessionId,
    canAttachToChat,
    contextDisabledReason,
    insertDraft,
    laneId,
    laneRoot,
    navigate,
    selectedCommit,
    selectedMode,
    selectedPath,
    tab,
  ]);

  const activeSessionLabel = activeSession
    ? `${formatToolTypeLabel(activeSession.toolType)} · ${activeSession.laneName}`
    : activeLane?.name ?? "No active session";

  return (
    <aside
      ref={sidebarRef}
      className="flex h-full min-h-0 min-w-[280px] flex-col border-l border-white/[0.08] bg-surface/85"
    >
      <div className="flex min-h-[42px] shrink-0 items-center gap-2 border-b border-white/[0.08] px-2 py-1.5">
        <div className="ade-liquid-glass-pill flex min-w-0 flex-1 items-center gap-0.5 rounded-full p-0.5">
          {WORK_SIDEBAR_TABS.map(({ id, label, Icon }) => {
            const active = id === tab;
            return (
              <SmartTooltip
                key={id}
                content={{
                  label,
                  description: `${label} tools for the active Work lane.`,
                }}
              >
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-7 min-w-0 shrink-0 cursor-pointer items-center rounded-full border-none bg-transparent text-[10px] font-medium transition-all",
                    compactTabs ? "w-8 justify-center px-0" : "gap-1.5 px-2",
                    active ? "ade-work-tab-active text-fg" : "text-muted-fg",
                  )}
                  onClick={() => {
                    if (tab === "browser" && id !== "browser") hideBuiltInBrowserView();
                    onTabChange(id);
                  }}
                  aria-pressed={active}
                  aria-label={label}
                  title={label}
                >
                  <Icon size={12} weight={active ? "fill" : "regular"} className="shrink-0" />
                  <span className={compactTabs ? "sr-only" : "truncate"}>{label}</span>
                </button>
              </SmartTooltip>
            );
          })}
        </div>
        <button
          type="button"
          className="ade-shell-control inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          data-variant="ghost"
          onClick={() => {
            if (tab === "browser") hideBuiltInBrowserView();
            onClose();
          }}
          title="Close Work sidebar"
          aria-label="Close Work sidebar"
        >
          <X size={13} />
        </button>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.05] px-3 py-1.5 text-[10px] text-muted-fg/65">
        <span className="min-w-0 truncate">{activeLane?.name ?? "No lane"}</span>
        <span className="shrink-0 truncate text-muted-fg/45" title={activeSessionLabel}>
          {activeSessionLabel}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {content}
      </div>
    </aside>
  );
}
