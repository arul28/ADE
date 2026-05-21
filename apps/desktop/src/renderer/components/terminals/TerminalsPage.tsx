import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { useWorkSessions } from "./useWorkSessions";
import { SessionListPane } from "./SessionListPane";
import { WorkViewArea } from "./WorkViewArea";
import { WorkSidebar, type WorkSidebarContextTarget } from "./WorkSidebar";
import { SessionContextMenu, type SessionContextMenuState } from "./SessionContextMenu";
import { SessionInfoPopover, type InfoPopoverState } from "./SessionInfoPopover";
import type { AgentChatPermissionMode, AgentChatSession, TerminalSessionSummary } from "../../../shared/types";
import type { AgentChatSessionCreatedOptions } from "../chat/AgentChatPane";
import { formatToolTypeLabel, isChatToolType } from "../../lib/sessions";
import { sortLanesForTabs } from "../lanes/laneUtils";
import { invalidateSessionListCache } from "../../lib/sessionListCache";
import { useAppStore } from "../../state/appStore";
import { ADE_OPEN_BUILT_IN_BROWSER_EVENT } from "../../lib/openExternal";
import {
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT,
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT,
} from "../../lib/workSidebarBrowserResize";

const TERMINALS_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    { node: { type: "pane", id: "sessions" }, defaultSize: 24, minSize: 15 },
    { node: { type: "pane", id: "view" }, defaultSize: 76, minSize: 40 },
  ],
};

const MIN_WORK_SIDEBAR_WIDTH_PCT = 26;
const MAX_WORK_SIDEBAR_WIDTH_PCT = 55;
const BULK_SESSION_DELETE_CONCURRENCY = 4;

function clampWorkSidebarWidthPct(widthPct: number): number {
  return Math.max(MIN_WORK_SIDEBAR_WIDTH_PCT, Math.min(MAX_WORK_SIDEBAR_WIDTH_PCT, widthPct));
}

function dispatchWorkSidebarBrowserResizeEvent(type: "start" | "end"): void {
  window.dispatchEvent(new Event(
    type === "start"
      ? ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT
      : ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT,
  ));
}

function isPtyContextInsertableToolType(toolType: TerminalSessionSummary["toolType"]): boolean {
  return toolType === "claude";
}

async function allSettledWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        await task(items[index] as T);
        results[index] = { status: "fulfilled", value: undefined };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));

  return results;
}

export function TerminalsPage({ active = true }: { active?: boolean }) {
  const work = useWorkSessions({ active });
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const sortedLanes = useMemo(() => sortLanesForTabs(work.lanes), [work.lanes]);

  const [contextMenu, setContextMenu] = useState<SessionContextMenuState>(null);
  const [infoPopover, setInfoPopover] = useState<InfoPopoverState>(null);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const workContentPaneRef = useRef<HTMLDivElement | null>(null);
  const workSidebarPaneRef = useRef<HTMLDivElement | null>(null);

  const selectableSessions = useMemo(
    () => [...work.runningFiltered, ...work.awaitingInputFiltered, ...work.endedFiltered],
    [work.awaitingInputFiltered, work.endedFiltered, work.runningFiltered],
  );

  useEffect(() => {
    const visibleIds = new Set(selectableSessions.map((session) => session.id));
    setSelectedSessionIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [selectableSessions]);

  const handleSelectSession = useCallback(
    (id: string, event?: React.MouseEvent, visibleSessionIds?: string[]) => {
      const useRange = event?.shiftKey === true;
      const useToggle = event?.metaKey === true || event?.ctrlKey === true;
      const orderedIds = visibleSessionIds?.length ? visibleSessionIds : selectableSessions.map((session) => session.id);

      if (useRange) {
        const anchorId = selectionAnchorId ?? id;
        const anchorIndex = orderedIds.indexOf(anchorId);
        const nextIndex = orderedIds.indexOf(id);
        if (anchorIndex >= 0 && nextIndex >= 0) {
          const [start, end] = anchorIndex <= nextIndex ? [anchorIndex, nextIndex] : [nextIndex, anchorIndex];
          const rangeIds = orderedIds.slice(start, end + 1);
          setSelectedSessionIds(new Set(rangeIds));
          setSelectionAnchorId(anchorId);
          work.setSelectedSessionId(id);
          return;
        }
      }

      if (useToggle) {
        setSelectedSessionIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        setSelectionAnchorId(id);
        work.setSelectedSessionId(id);
        return;
      }

      setSelectedSessionIds(new Set());
      setSelectionAnchorId(id);
      work.setSelectedSessionId(id);
      work.openSessionTab(id);
    },
    [selectableSessions, selectionAnchorId, work],
  );

  const handleInfoClick = useCallback(
    (session: TerminalSessionSummary, e: React.MouseEvent) => {
      const r = e.currentTarget.getBoundingClientRect();
      setInfoPopover({
        session,
        anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      });
    },
    [],
  );

  const handleContextMenu = useCallback(
    (session: TerminalSessionSummary, e: React.MouseEvent) => {
      setContextMenu({ session, x: e.clientX, y: e.clientY });
    },
    [],
  );

  const handleOpenChatSession = useCallback(
    (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => {
      // Invalidate all cache entries so other views (e.g. Lanes tab) pick up
      // the new session on their next refresh.
      invalidateSessionListCache();
      work.upsertOptimisticChatSession(session);
      if (options?.activate !== false) {
        work.selectLane(session.laneId);
        work.focusSession(session.id);
        work.openSessionTab(session.id);
      }
      void work.refresh({ showLoading: false, force: true }).catch((err: unknown) => {
        console.error("[TerminalsPage] refresh after opening chat session failed", {
          sessionId: session.id,
          laneId: session.laneId,
          err,
        });
      });
    },
    [work],
  );

  const handleGoToLane = useCallback(
    (session: TerminalSessionSummary) => {
      work.selectLane(session.laneId);
      work.focusSession(session.id);
      work.navigate(`/lanes?laneId=${encodeURIComponent(session.laneId)}&sessionId=${encodeURIComponent(session.id)}`);
    },
    [work],
  );

  const handleDeleteChat = useCallback(
    (session: TerminalSessionSummary) => {
      const label = (session.goal ?? session.title).trim() || "this chat";
      const confirmed = window.confirm(
        `Delete "${label}"?\n\nThis permanently removes the saved chat history from ADE.`,
      );
      if (!confirmed) return;

      setSessionActionError(null);
      setDeletingSessionId(session.id);
      void window.ade.agentChat.delete({ sessionId: session.id })
        .then(async () => {
          invalidateSessionListCache();
          work.removeSessionFromList(session.id);
          work.closeTab(session.id);
          setContextMenu((current) => (current?.session.id === session.id ? null : current));
          setInfoPopover((current) => (current?.session.id === session.id ? null : current));
          // Refresh is post-delete housekeeping; a failure here must not be
          // reported as "Delete failed" because the delete itself succeeded.
          await work.refresh({ showLoading: false, force: true }).catch((refreshErr: unknown) => {
            console.error("[TerminalsPage] refresh after delete failed", { sessionId: session.id, refreshErr });
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[TerminalsPage] delete chat failed", { sessionId: session.id, err });
          setSessionActionError(`Delete failed: ${message}`);
          window.setTimeout(() => setSessionActionError(null), 6000);
        })
        .finally(() => {
          setDeletingSessionId((current) => (current === session.id ? null : current));
        });
    },
    [work],
  );

  const handleDeleteSession = useCallback(
    (session: TerminalSessionSummary) => {
      const label = (session.goal ?? session.title).trim() || "this session";
      const confirmed = window.confirm(
        `Delete "${label}"?\n\nThis permanently removes the saved terminal session from ADE.`,
      );
      if (!confirmed) return;

      setSessionActionError(null);
      setDeletingSessionId(session.id);
      void window.ade.sessions.delete({ sessionId: session.id })
        .then(async () => {
          invalidateSessionListCache();
          work.removeSessionFromList(session.id);
          work.closeTab(session.id);
          setContextMenu((current) => (current?.session.id === session.id ? null : current));
          setInfoPopover((current) => (current?.session.id === session.id ? null : current));
          await work.refresh({ showLoading: false, force: true }).catch((refreshErr: unknown) => {
            console.error("[TerminalsPage] refresh after session delete failed", { sessionId: session.id, refreshErr });
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[TerminalsPage] delete session failed", { sessionId: session.id, err });
          setSessionActionError(`Delete failed: ${message}`);
          window.setTimeout(() => setSessionActionError(null), 6000);
        })
        .finally(() => {
          setDeletingSessionId((current) => (current === session.id ? null : current));
        });
    },
    [work],
  );

  const selectedSessions = useMemo(
    () => selectableSessions.filter((session) => selectedSessionIds.has(session.id)),
    [selectableSessions, selectedSessionIds],
  );

  const handleBulkCloseSelected = useCallback(() => {
    const running = selectedSessions.filter((session) => session.status === "running" && !isChatToolType(session.toolType));
    if (!running.length) return;
    const confirmed = window.confirm(
      `Stop ${running.length} running runtime${running.length === 1 ? "" : "s"}?\n\nThis terminates the underlying CLI or shell process for each selected running session. Saved transcripts stay in ADE.`,
    );
    if (!confirmed) return;

    setSessionActionError(null);
    void Promise.allSettled(
      running.map((session) => {
        if (session.ptyId) {
          return work.stopRuntime(session.ptyId, session.id);
        }
        return Promise.resolve();
      }),
    )
      .then((results) => {
        const failed = results.filter((result) => result.status === "rejected").length;
        if (failed > 0) {
          setSessionActionError(`Stop failed for ${failed} selected runtime${failed === 1 ? "" : "s"}.`);
          window.setTimeout(() => setSessionActionError(null), 6000);
        }
        setSelectedSessionIds(new Set());
        setSelectionAnchorId(null);
        invalidateSessionListCache();
        return work.refresh({ showLoading: false, force: true });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setSessionActionError(`Stop failed: ${message}`);
        window.setTimeout(() => setSessionActionError(null), 6000);
      });
  }, [selectedSessions, work]);

  const handleBulkDeleteSelected = useCallback(() => {
    const ended = selectedSessions.filter((session) => session.status !== "running");
    if (!ended.length) return;
    const confirmed = window.confirm(
      `Delete ${ended.length} ended session${ended.length === 1 ? "" : "s"}?\n\nThis permanently removes the selected saved session history from ADE.`,
    );
    if (!confirmed) return;

    setSessionActionError(null);
    setDeletingSessionId("bulk");
    void allSettledWithConcurrency(
      ended,
      BULK_SESSION_DELETE_CONCURRENCY,
      async (session) => {
        if (isChatToolType(session.toolType)) {
          await window.ade.agentChat.delete({ sessionId: session.id });
          return;
        }
        await window.ade.sessions.delete({ sessionId: session.id });
      },
    )
      .then(async (results) => {
        const failed = results.filter((result) => result.status === "rejected").length;
        const succeededIds = ended
          .filter((_, index) => results[index]?.status === "fulfilled")
          .map((session) => session.id);
        for (const sessionId of succeededIds) {
          work.removeSessionFromList(sessionId);
          work.closeTab(sessionId);
        }
        setSelectedSessionIds(new Set());
        setSelectionAnchorId(null);
        setContextMenu(null);
        setInfoPopover(null);
        invalidateSessionListCache();
        await work.refresh({ showLoading: false, force: true }).catch((refreshErr: unknown) => {
          console.error("[TerminalsPage] refresh after bulk delete failed", { refreshErr });
        });
        if (failed > 0) {
          setSessionActionError(`Delete failed for ${failed} selected session${failed === 1 ? "" : "s"}.`);
          window.setTimeout(() => setSessionActionError(null), 6000);
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setSessionActionError(`Delete failed: ${message}`);
        window.setTimeout(() => setSessionActionError(null), 6000);
      })
      .finally(() => {
        setDeletingSessionId((current) => (current === "bulk" ? null : current));
      });
  }, [selectedSessions, work]);

  const handleContinueCliSession = useCallback(
    async (session: TerminalSessionSummary, text: string, options?: { model?: string | null; reasoningEffort?: string | null; permissionMode?: AgentChatPermissionMode | null }) => {
      setSessionActionError(null);
      try {
        const result = await window.ade.pty.sendToSession({
          sessionId: session.id,
          text,
          cols: 100,
          rows: 30,
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
          ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}),
        });
        invalidateSessionListCache();
        // Patch the local sessions list with the freshly-resumed snapshot so
        // the Work view flips from ClosedCliSessionSurface to the live
        // TerminalView immediately. Without this the user sees the frozen
        // pre-resume snapshot until the next refresh round-trip completes —
        // and the PTY data events stream to a TerminalView that hasn't been
        // mounted yet.
        if (result.session) {
          work.upsertSessionSnapshot(result.session);
        }
        try {
          await work.refresh({ showLoading: false, force: true });
        } catch {
          // Best-effort after reattach; the PTY events will also refresh state.
        }
        work.selectLane(session.laneId);
        work.focusSession(result.sessionId);
        work.setActiveItemId(result.sessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSessionActionError(`Send failed: ${message}`);
        window.setTimeout(() => setSessionActionError(null), 6000);
        throw err;
      }
    },
    [work],
  );

  const activeWorkSession = useMemo(
    () => (work.activeItemId ? work.sessions.find((session) => session.id === work.activeItemId) ?? null : null),
    [work.activeItemId, work.sessions],
  );

  const activeLaneId = useMemo(() => {
    if (activeWorkSession?.laneId) return activeWorkSession.laneId;
    if (selectedLaneId && sortedLanes.some((lane) => lane.id === selectedLaneId)) return selectedLaneId;
    return sortedLanes.find((lane) => lane.laneType === "primary")?.id ?? sortedLanes[0]?.id ?? null;
  }, [activeWorkSession?.laneId, selectedLaneId, sortedLanes]);

  const contextTarget = useMemo<WorkSidebarContextTarget | null>(() => {
    if (!activeWorkSession || activeWorkSession.laneId !== activeLaneId) return null;
    if (isChatToolType(activeWorkSession.toolType)) {
      return { kind: "chat", sessionId: activeWorkSession.id };
    }
    if (
      activeWorkSession.status === "running"
      && activeWorkSession.ptyId
      && isPtyContextInsertableToolType(activeWorkSession.toolType)
    ) {
      return {
        kind: "pty",
        sessionId: activeWorkSession.id,
        ptyId: activeWorkSession.ptyId,
        toolType: activeWorkSession.toolType,
      };
    }
    return null;
  }, [activeLaneId, activeWorkSession]);

  let contextDisabledReason: string | null;
  if (!activeWorkSession) {
    contextDisabledReason = "Open a chat or agent CLI session in this lane to insert tool context.";
  } else if (activeWorkSession.laneId !== activeLaneId) {
    contextDisabledReason = "Open a Work session in the active lane to insert tool context.";
  } else if (activeWorkSession.toolType === "shell" || activeWorkSession.toolType === "run-shell") {
    contextDisabledReason = "Shell sessions can use the lane tools, but context insertion targets chats or agent CLI sessions.";
  } else if (!contextTarget && activeWorkSession.ptyId && activeWorkSession.status !== "running") {
    contextDisabledReason = `Continue this ${formatToolTypeLabel(activeWorkSession.toolType)} session before inserting tool context.`;
  } else if (!contextTarget) {
    contextDisabledReason = `This ${formatToolTypeLabel(activeWorkSession.toolType)} session can use the lane tools, but it cannot receive inserted context.`;
  } else {
    contextDisabledReason = null;
  }

  const workSidebarVisible = active && work.workSidebarOpen && work.viewMode !== "grid";
  const { setViewMode, setWorkSidebarTab } = work;
  useEffect(() => {
    if (!active) return;
    const openBrowserSidebar = () => {
      setViewMode("tabs");
      setWorkSidebarTab("browser");
    };
    window.addEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, openBrowserSidebar);
    const unsubscribeBrowserEvents = window.ade?.builtInBrowser?.onEvent?.((event) => {
      if (event.type === "open-request") openBrowserSidebar();
    }) ?? null;
    return () => {
      window.removeEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, openBrowserSidebar);
      unsubscribeBrowserEvents?.();
    };
  }, [active, setViewMode, setWorkSidebarTab]);

  const expandSessionsPane = useCallback(() => {
    work.setWorkFocusSessionsHidden(false);
  }, [work]);
  const toggleWorkSidebar = useCallback(() => {
    work.setWorkSidebarOpen(!work.workSidebarOpen);
  }, [work]);
  const closeWorkSidebar = useCallback(() => {
    work.setWorkSidebarOpen(false);
  }, [work]);
  const handleStopRunningSession = useCallback((session: TerminalSessionSummary) => {
    if (!session.ptyId) return;
    work.stopRuntime(session.ptyId, session.id).catch((err: unknown) => {
      console.error("[TerminalsPage] Failed to stop CLI session from header", {
        sessionId: session.id,
        ptyId: session.ptyId,
        err,
      });
    });
  }, [work]);
  const handleWorkSidebarResizeMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const totalWidth = container.getBoundingClientRect().width;
    if (totalWidth <= 0) return;
    const startX = event.clientX;
    const startWidthPct = work.workSidebarWidthPct;
    let pendingWidthPct = clampWorkSidebarWidthPct(startWidthPct);
    let animationFrame: number | null = null;
    const applyWidth = (widthPct: number) => {
      const nextWidthPct = clampWorkSidebarWidthPct(widthPct);
      pendingWidthPct = nextWidthPct;
      const contentPane = workContentPaneRef.current;
      const sidebarPane = workSidebarPaneRef.current;
      if (contentPane) contentPane.style.flexGrow = `${100 - nextWidthPct}`;
      if (sidebarPane) sidebarPane.style.flexGrow = `${nextWidthPct}`;
    };
    const scheduleWidth = (widthPct: number) => {
      pendingWidthPct = clampWorkSidebarWidthPct(widthPct);
      if (animationFrame != null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        applyWidth(pendingWidthPct);
      });
    };
    const onMove = (moveEvent: MouseEvent) => {
      const deltaPct = ((startX - moveEvent.clientX) / totalWidth) * 100;
      scheduleWidth(startWidthPct + deltaPct);
    };
    const onUp = () => {
      if (animationFrame != null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      applyWidth(pendingWidthPct);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (work.workSidebarTab === "browser") dispatchWorkSidebarBrowserResizeEvent("end");
      work.setWorkSidebarWidthPct(pendingWidthPct);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    if (work.workSidebarTab === "browser") dispatchWorkSidebarBrowserResizeEvent("start");
    applyWidth(startWidthPct);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [work]);

  const workViewArea = useMemo(
    () => (
      <WorkViewArea
        pageActive={active}
        gridLayoutId={work.gridLayoutId}
        lanes={sortedLanes}
        sessions={work.sessions}
        visibleSessions={work.visibleSessions}
        tabGroups={work.tabGroups}
        tabVisibleSessionIds={work.tabVisibleSessionIds}
        activeItemId={work.activeItemId}
        viewMode={work.viewMode}
        draftKind={work.draftKind}
        draftLaneId={work.draftLaneId}
        setViewMode={work.setViewMode}
        onSelectItem={work.setActiveItemId}
        onCloseItem={work.closeTab}
        onOpenChatSession={handleOpenChatSession}
        onLaunchPtySession={work.launchPtySession}
        onDraftLaneChange={work.setDraftLaneId}
        onShowDraftKind={work.showDraftKind}
        onToggleTabGroupCollapsed={work.toggleWorkTabGroupCollapsed}
        closingPtyIds={work.closingPtyIds}
        onContextMenu={handleContextMenu}
        onContinueCliSession={handleContinueCliSession}
        sessionsPaneCollapsed={work.workFocusSessionsHidden}
        onExpandSessionsPane={expandSessionsPane}
        sessionsPaneListCount={work.filtered.length}
        sessionsPaneRunningCount={work.runningSessions.length}
        sessionsListLoading={work.loading}
        workSidebarOpen={work.workSidebarOpen}
        onToggleWorkSidebar={toggleWorkSidebar}
        onInfoClick={handleInfoClick}
        onStopRunningSession={handleStopRunningSession}
        onReorderLaneSessions={work.reorderLaneSessions}
        onOpenSessionInTabsView={(sessionId) => {
          work.setViewMode("tabs");
          work.openSessionTab(sessionId);
          work.setActiveItemId(sessionId);
        }}
        onGoToLane={work.selectLane}
      />
    ),
    [
      sortedLanes,
      active,
      work.gridLayoutId,
      work.sessions,
      work.visibleSessions,
      work.tabGroups,
      work.tabVisibleSessionIds,
      work.activeItemId,
      work.viewMode,
      work.draftKind,
      work.draftLaneId,
      work.setDraftLaneId,
      work.showDraftKind,
      work.setViewMode,
      work.setActiveItemId,
      work.closeTab,
      work.launchPtySession,
      work.toggleWorkTabGroupCollapsed,
      work.closingPtyIds,
      work.filtered.length,
      work.runningSessions.length,
      work.loading,
      work.workFocusSessionsHidden,
      work.workSidebarOpen,
      expandSessionsPane,
      toggleWorkSidebar,
      handleOpenChatSession,
      handleContinueCliSession,
      handleContextMenu,
      handleInfoClick,
      handleStopRunningSession,
      work.reorderLaneSessions,
      work.openSessionTab,
      work.selectLane,
    ],
  );

  const workViewWithSidebar = useMemo(
    () => (
      <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
        <div
          ref={workContentPaneRef}
          className="min-h-0 min-w-0 flex-1 basis-0 overflow-hidden"
          style={workSidebarVisible ? { flexGrow: 100 - work.workSidebarWidthPct } : undefined}
        >
          {workViewArea}
        </div>
        {workSidebarVisible ? (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              onMouseDown={handleWorkSidebarResizeMouseDown}
              className="relative w-[5px] shrink-0 cursor-col-resize bg-white/[0.06] transition-colors hover:bg-[var(--color-accent)]/25 active:bg-[var(--color-accent)]/40"
            />
            <div
              ref={workSidebarPaneRef}
              className="min-h-0 min-w-[280px] basis-0 overflow-hidden"
              style={{ flexGrow: work.workSidebarWidthPct, maxWidth: "55%" }}
            >
              <WorkSidebar
                active={active}
                laneId={activeLaneId}
                lanes={sortedLanes}
                activeSession={activeWorkSession}
                tab={work.workSidebarTab}
                onTabChange={work.setWorkSidebarTab}
                onClose={closeWorkSidebar}
                contextTarget={contextTarget}
                contextDisabledReason={contextDisabledReason}
              />
            </div>
          </>
        ) : null}
      </div>
    ),
    [
      activeLaneId,
      activeWorkSession,
      active,
      contextTarget,
      contextDisabledReason,
      handleWorkSidebarResizeMouseDown,
      closeWorkSidebar,
      sortedLanes,
      work.setWorkSidebarTab,
      work.workSidebarTab,
      work.workSidebarWidthPct,
      workSidebarVisible,
      workViewArea,
    ],
  );

  const runningCount = work.runningSessions.length;
  const setFocusHidden = work.setWorkFocusSessionsHidden;

  const sessionsHeaderActions = useMemo(
    () => (
      <span data-tour="work.sessionsHeader" className="inline-flex items-center gap-1.5">
        {runningCount > 0 ? (
          <span
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            style={{ color: "var(--color-success)", background: "rgba(34, 197, 94, 0.08)" }}
            title={`${runningCount} running`}
          >
            <span className="ade-status-dot ade-status-dot-active" style={{ width: 4, height: 4 }} />
            {runningCount}
          </span>
        ) : null}
        <button
          type="button"
          className="ade-shell-control rounded p-0.5"
          data-variant="ghost"
          title="Hide sidebar"
          onClick={() => setFocusHidden(true)}
        >
          <SidebarSimple size={13} weight="regular" />
        </button>
      </span>
    ),
    [runningCount, setFocusHidden],
  );

  const paneConfigs: Record<string, PaneConfig> = useMemo(
    () => ({
      sessions: {
        title: "Work",
        headerActions: sessionsHeaderActions,
        // tour anchor: wraps the sessions panel so the Work tour anchors
        // at the whole pane, not just an inner element.
        children: (
          <div className="h-full min-h-0 flex flex-col" data-tour="work.sessionsPane">
          <SessionListPane
            lanes={sortedLanes}
            runningFiltered={work.runningFiltered}
            awaitingInputFiltered={work.awaitingInputFiltered}
            endedFiltered={work.endedFiltered}
            loading={work.loading}
            filterLaneId={work.filterLaneId}
            setFilterLaneId={work.setFilterLaneId}
            filterStatus={work.filterStatus}
            setFilterStatus={work.setFilterStatus}
            q={work.q}
            setQ={work.setQ}
            selectedSessionId={work.selectedSessionId}
            selectedSessionIds={selectedSessionIds}
            draftKind={work.draftKind}
            showingDraft={work.activeItemId == null}
            onShowDraftKind={work.showDraftKind}
            onSelectSession={handleSelectSession}
            onClearSelection={() => {
              setSelectedSessionIds(new Set());
              setSelectionAnchorId(null);
            }}
            onBulkClose={handleBulkCloseSelected}
            onBulkDelete={handleBulkDeleteSelected}
            onInfoClick={handleInfoClick}
            onContextMenu={handleContextMenu}
            sessionListOrganization={work.sessionListOrganization}
            setSessionListOrganization={work.setSessionListOrganization}
            workCollapsedLaneIds={work.workCollapsedLaneIds}
            toggleWorkLaneCollapsed={work.toggleWorkLaneCollapsed}
            workCollapsedSectionIds={work.workCollapsedSectionIds}
            toggleWorkSectionCollapsed={work.toggleWorkSectionCollapsed}
            sessionsGroupedByLane={work.sessionsGroupedByLane}
          />
          </div>
        ),
      },

      view: {
        title: "",
        bodyClassName: "overflow-hidden",
        // tour anchor: wraps the view area so the Work tour can target it.
        children: (
          <div className="h-full min-h-0" data-tour="work.viewArea">
            {workViewWithSidebar}
          </div>
        ),
      },
    }),
    [
      work,
      sortedLanes,
      handleSelectSession,
      selectedSessionIds,
      handleBulkCloseSelected,
      handleBulkDeleteSelected,
      handleInfoClick,
      handleContextMenu,
      sessionsHeaderActions,
      workViewWithSidebar,
    ],
  );

  return (
    <div className="flex h-full min-w-0 flex-col" style={{ background: "var(--color-bg)" }}>
      {sessionActionError ? (
        <div
          className="shrink-0 border-b border-red-500/25 px-4 py-2 text-[12px] text-red-300/95"
          style={{ background: "rgba(239, 68, 68, 0.08)" }}
          role="status"
        >
          {sessionActionError}
        </div>
      ) : null}
      {work.workFocusSessionsHidden ? (
        <div className="min-h-0 flex-1 overflow-hidden" data-tour="work.viewArea">
          {workViewWithSidebar}
        </div>
      ) : (
        <PaneTilingLayout
          layoutId="work:tiling:v3"
          tree={TERMINALS_TILING_TREE}
          panes={paneConfigs}
          className="ade-work-surface min-h-0 flex-1"
        />
      )}

      <SessionContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onStopRuntime={({ ptyId, sessionId }) => work.stopRuntime(ptyId, sessionId).catch(() => {})}
        onDeleteChat={handleDeleteChat}
        onDeleteSession={handleDeleteSession}
        deletingSessionId={deletingSessionId}
        onGoToLane={handleGoToLane}
        onCopySessionId={(id) => navigator.clipboard.writeText(id).catch(() => {})}
        onCopySessionDeepLink={(session) => {
          const href = `/work?laneId=${encodeURIComponent(session.laneId)}&sessionId=${encodeURIComponent(session.id)}`;
          navigator.clipboard.writeText(href).catch(() => {});
        }}
        onTogglePinned={(session) => work.togglePinnedSession(session.id)}
        pinnedSessionIds={work.pinnedSessionIds}
        onRename={(session, newTitle) => {
          setSessionActionError(null);
          const renamePromise = isChatToolType(session.toolType)
            ? window.ade.agentChat.updateSession({ sessionId: session.id, title: newTitle, manuallyNamed: true })
            : window.ade.sessions.updateMeta({ sessionId: session.id, title: newTitle, manuallyNamed: true });
          renamePromise
            .then(() => {
              invalidateSessionListCache();
              work.refresh({ showLoading: false, force: true }).catch((refreshErr: unknown) => {
                console.error("[TerminalsPage] refresh after rename failed", { sessionId: session.id, refreshErr });
              });
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error("[TerminalsPage] rename session failed", { sessionId: session.id, err });
              setSessionActionError(`Rename failed: ${message}`);
              window.setTimeout(() => setSessionActionError(null), 6000);
            });
        }}
      />

      <SessionInfoPopover
        popover={infoPopover}
        onClose={() => setInfoPopover(null)}
        onStopRuntime={({ ptyId, sessionId }) => work.stopRuntime(ptyId, sessionId).catch(() => {})}
        onDeleteChat={handleDeleteChat}
        onDeleteSession={handleDeleteSession}
        onGoToLane={handleGoToLane}
        closingPtyIds={work.closingPtyIds}
        deletingSessionId={deletingSessionId}
      />
    </div>
  );
}
