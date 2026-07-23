import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
import { useWorkSessions } from "./useWorkSessions";
import { SessionListPane } from "./SessionListPane";
import { WorkViewArea } from "./WorkViewArea";
import { WorkSidebar, type WorkSidebarContextTarget } from "./WorkSidebar";
import { SessionContextMenu, type SessionContextMenuState } from "./SessionContextMenu";
import { SessionInfoPopover, type InfoPopoverState } from "./SessionInfoPopover";
import { ConfirmDialog, useConfirmDialog } from "../shared/InlineDialogs";
import type { AgentChatSession, TerminalResumeLaunchConfig, TerminalSessionSummary } from "../../../shared/types";
import { buildDeeplink } from "../../../shared/deeplinks";
import { parseGithubRemoteUrl } from "../../../shared/githubRemote";
import { buildWebClientUrl } from "../../../shared/webClientUrl";
import type { AgentChatSessionCreatedOptions } from "../chat/AgentChatPane";
import { canBulkDeleteSession, canBulkStopSession, formatToolTypeLabel, isChatToolType } from "../../lib/sessions";
import { addSessionBesideTarget, removeSessionFromGrids } from "../../lib/workGrid";
import { buildWorkSessionTilingTree } from "./workSessionTiling";
import type { DropEdge } from "../ui/paneTreeOps";
import { sortLanesForTabs } from "../lanes/laneUtils";
import { invalidateSessionListCache } from "../../lib/sessionListCache";
import { selectActiveProjectRoot, useAppStore, useRootAppStore, type WorkDraftKind } from "../../state/appStore";
import { ADE_OPEN_BUILT_IN_BROWSER_EVENT, openExternalUrl } from "../../lib/openExternal";
import {
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT,
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import { openLaneInLanesTabPath } from "../../lib/laneNavigation";
import {
  buildHandoffLaunchJobsScopeKey,
  type HandoffLaunchJob,
} from "../../lib/handoffLaunchJobs";
import { getLaneDeleteStatusLabel } from "../../lib/laneDeleteProgress";
import { useWorkLaneDeleteProgress } from "./useWorkLaneDeleteProgress";
import { buildPtyContinuationLaunchFields } from "./cliLaunch";
import { canonicalInputFromSummary, sessionNeedsYou } from "../../lib/terminalAttention";

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
const EMPTY_HANDOFF_LAUNCH_JOBS: HandoffLaunchJob[] = [];

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

function browserEventProjectRoot(value: unknown): string | null | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if ("collectionProjectRoot" in record) {
    const root = record.collectionProjectRoot;
    return typeof root === "string" && root.trim().length > 0 ? root : null;
  }
  return browserEventProjectRoot(record.status);
}

function browserEventMatchesProject(event: unknown, projectRoot: string | null): boolean {
  const root = browserEventProjectRoot(event);
  if (root === undefined) return projectRoot == null;
  if (!projectRoot) return root === null;
  return root === projectRoot;
}

function isPtyContextInsertableToolType(toolType: TerminalSessionSummary["toolType"]): boolean {
  return toolType === "claude"
    || toolType === "codex"
    || toolType === "cursor-cli"
    || toolType === "droid"
    || toolType === "opencode";
}

function buildDraftContextTargetId(laneId: string, draftKind: WorkDraftKind): string {
  return `work:draft:${laneId}:${draftKind}`;
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
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const sortedLanes = useMemo(() => sortLanesForTabs(work.lanes), [work.lanes]);
  const handoffLaunchJobsScopeKey = useMemo(
    () => buildHandoffLaunchJobsScopeKey({ projectBinding, projectRoot }),
    [projectBinding, projectRoot],
  );
  const handoffLaunchJobs = useRootAppStore((s) => (
    s.handoffLaunchJobsByScope[handoffLaunchJobsScopeKey] ?? EMPTY_HANDOFF_LAUNCH_JOBS
  ));

  const [contextMenu, setContextMenu] = useState<SessionContextMenuState>(null);
  const [infoPopover, setInfoPopover] = useState<InfoPopoverState>(null);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const stopAndDeleteConfirm = useConfirmDialog();
  const workContentPaneRef = useRef<HTMLDivElement | null>(null);
  const workSidebarPaneRef = useRef<HTMLDivElement | null>(null);
  const unifiedChromeRef = useRef<HTMLDivElement | null>(null);
  const sessionsPaneRoRef = useRef<ResizeObserver | null>(null);

  const refreshWorkSessionsAfterLaneDelete = useCallback(
    () => work.refresh({ showLoading: false, force: true }),
    [work.refresh],
  );
  useWorkLaneDeleteProgress({
    active,
    projectRoot,
    lanes: work.lanes,
    refreshSessions: refreshWorkSessionsAfterLaneDelete,
  });

  const sessionsPaneRefCb = useCallback((el: HTMLDivElement | null) => {
    if (sessionsPaneRoRef.current) {
      sessionsPaneRoRef.current.disconnect();
      sessionsPaneRoRef.current = null;
    }
    if (!el) {
      unifiedChromeRef.current?.style.removeProperty("--ade-sessions-pane-w");
      return;
    }
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      unifiedChromeRef.current?.style.setProperty("--ade-sessions-pane-w", `${entry.contentRect.width}px`);
    });
    ro.observe(el);
    sessionsPaneRoRef.current = ro;
  }, []);

  const selectableSessions = useMemo(
    () => [
      ...work.runningFiltered,
      ...work.awaitingInputFiltered,
      ...work.endedFiltered,
      ...work.settledFiltered,
    ],
    [work.awaitingInputFiltered, work.endedFiltered, work.runningFiltered, work.settledFiltered],
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

  // Jump-to-session bridge for the orchestration panel (and the worker→lead
  // button): `onOpenSession` dispatches `ade:work:select-session`; this is the
  // listener that actually focuses the target chat in the Work tab. Without it
  // the buttons are dead (the event had no subscriber).
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; laneId?: string }>).detail;
      const sessionId = detail?.sessionId;
      if (!sessionId) return;
      // Callers (spawn cards, subagents pane) often don't know the target's
      // lane. Resolve it from the loaded session list so cross-lane jumps
      // land on the right lane instead of focusing an off-lane session.
      const laneId = detail.laneId ?? work.sessions.find((s) => s.id === sessionId)?.laneId ?? null;
      if (laneId) work.selectLane(laneId);
      work.focusSession(sessionId);
      work.openSessionTab(sessionId);
      work.setSelectedSessionId(sessionId);
    };
    window.addEventListener("ade:work:select-session", handler as EventListener);
    return () => window.removeEventListener("ade:work:select-session", handler as EventListener);
  }, [work]);

  const handleGoToLane = useCallback(
    (session: TerminalSessionSummary) => {
      work.selectLane(session.laneId);
      work.focusSession(session.id);
      const params = new URLSearchParams({
        laneId: session.laneId,
        focus: "single",
        sessionId: session.id,
      });
      work.navigate(`/lanes?${params.toString()}`);
    },
    [work],
  );

  const handleGoToLaneById = useCallback(
    (laneId: string) => {
      work.selectLane(laneId);
      work.navigate(openLaneInLanesTabPath(laneId));
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

  const handleSettleSession = useCallback((session: TerminalSessionSummary) => {
    setSessionActionError(null);
    void (async () => {
      try {
        const dismissPendingInput = sessionNeedsYou(canonicalInputFromSummary(session));
        await window.ade.sessions.settle(
          session.id,
          dismissPendingInput ? { dismissPendingInput: true } : undefined,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSessionActionError(`Settle failed: ${message}`);
        window.setTimeout(() => setSessionActionError(null), 6000);
      }
    })();
  }, []);

  const handleUnsettleSession = useCallback((session: TerminalSessionSummary) => {
    setSessionActionError(null);
    void window.ade.sessions.unsettle(session.id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setSessionActionError(`Unsettle failed: ${message}`);
      window.setTimeout(() => setSessionActionError(null), 6000);
    });
  }, []);

  const handleStopAndDeleteSession = useCallback(
    (session: TerminalSessionSummary) => {
      void (async () => {
        const label = (session.goal ?? session.title).trim() || "this session";
        const confirmed = await stopAndDeleteConfirm.confirmAsync({
          title: "Stop and delete session",
          message: `Stop the runtime for "${label}" and permanently delete it?\n\nThis terminates the running process and removes the saved session from ADE.`,
          confirmLabel: "Stop & delete",
          danger: true,
        });
        if (!confirmed) return;

        setSessionActionError(null);
        setDeletingSessionId(session.id);
        // The session-delete service stops a running runtime before removing the
        // record, so a single call covers both steps for CLI and shell sessions.
        try {
          await window.ade.sessions.delete({ sessionId: session.id });
          invalidateSessionListCache();
          work.removeSessionFromList(session.id);
          work.closeTab(session.id);
          setContextMenu((current) => (current?.session.id === session.id ? null : current));
          setInfoPopover((current) => (current?.session.id === session.id ? null : current));
          await work.refresh({ showLoading: false, force: true }).catch((refreshErr: unknown) => {
            console.error("[TerminalsPage] refresh after stop-and-delete failed", { sessionId: session.id, refreshErr });
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[TerminalsPage] stop-and-delete session failed", { sessionId: session.id, err });
          setSessionActionError(`Stop and delete failed: ${message}`);
          window.setTimeout(() => setSessionActionError(null), 6000);
        } finally {
          setDeletingSessionId((current) => (current === session.id ? null : current));
        }
      })();
    },
    [stopAndDeleteConfirm, work],
  );

  const selectedSessions = useMemo(
    () => selectableSessions.filter((session) => selectedSessionIds.has(session.id)),
    [selectableSessions, selectedSessionIds],
  );

  const handleBulkCloseSelected = useCallback(() => {
    const running = selectedSessions.filter(canBulkStopSession);
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
    const deletable = selectedSessions.filter(canBulkDeleteSession);
    if (!deletable.length) return;
    const confirmed = window.confirm(
      `Delete ${deletable.length} selected session${deletable.length === 1 ? "" : "s"}?\n\nThis permanently removes the selected saved session history from ADE.`,
    );
    if (!confirmed) return;

    setSessionActionError(null);
    setDeletingSessionId("bulk");
    void allSettledWithConcurrency(
      deletable,
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
        const succeededIds = deletable
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

  const handleBulkStopAndDeleteSelected = useCallback(() => {
    void (async () => {
      // Operates on the entire selection: chats delete directly, while running
      // CLI/shell sessions are stopped and then deleted by the session-delete
      // service. This is what makes a mixed selection deletable in one action.
      const targets = selectedSessions;
      if (!targets.length) return;
      const runningCount = targets.filter(canBulkStopSession).length;
      const confirmed = await stopAndDeleteConfirm.confirmAsync({
        title: "Stop and delete sessions",
        message: `Stop ${runningCount} running runtime${runningCount === 1 ? "" : "s"} and permanently delete ${targets.length} selected session${targets.length === 1 ? "" : "s"}?\n\nThis terminates running CLI and shell processes, then removes every selected session from ADE.`,
        confirmLabel: "Stop & delete",
        danger: true,
      });
      if (!confirmed) return;

      setSessionActionError(null);
      setDeletingSessionId("bulk");
      try {
        const results = await allSettledWithConcurrency(
          targets,
          BULK_SESSION_DELETE_CONCURRENCY,
          async (session) => {
            if (isChatToolType(session.toolType)) {
              await window.ade.agentChat.delete({ sessionId: session.id });
              return;
            }
            await window.ade.sessions.delete({ sessionId: session.id });
          },
        );
        const failed = results.filter((result) => result.status === "rejected").length;
        const succeededIds = targets
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
          console.error("[TerminalsPage] refresh after bulk stop-and-delete failed", { refreshErr });
        });
        if (failed > 0) {
          setSessionActionError(`Stop and delete failed for ${failed} selected session${failed === 1 ? "" : "s"}.`);
          window.setTimeout(() => setSessionActionError(null), 6000);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setSessionActionError(`Stop and delete failed: ${message}`);
        window.setTimeout(() => setSessionActionError(null), 6000);
      } finally {
        setDeletingSessionId((current) => (current === "bulk" ? null : current));
      }
    })();
  }, [selectedSessions, stopAndDeleteConfirm, work]);

  const handleContinueCliSession = useCallback(
    async (session: TerminalSessionSummary, text: string, launch: TerminalResumeLaunchConfig | null) => {
      setSessionActionError(null);
      try {
        const result = await window.ade.pty.sendToSession({
          sessionId: session.id,
          text,
          cols: 100,
          rows: 30,
          ...buildPtyContinuationLaunchFields(launch),
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

  const handleResumeCliSession = useCallback(
    async (session: TerminalSessionSummary) => {
      setSessionActionError(null);
      try {
        const result = await window.ade.pty.resumeSession({
          sessionId: session.id,
          cols: 100,
          rows: 30,
        });
        invalidateSessionListCache();
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
        setSessionActionError(`Resume failed: ${message}`);
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
    if (work.draftLaneId && sortedLanes.some((lane) => lane.id === work.draftLaneId)) return work.draftLaneId;
    if (selectedLaneId && sortedLanes.some((lane) => lane.id === selectedLaneId)) return selectedLaneId;
    return sortedLanes.find((lane) => lane.laneType === "primary")?.id ?? sortedLanes[0]?.id ?? null;
  }, [activeWorkSession?.laneId, selectedLaneId, sortedLanes, work.draftLaneId]);
  const activeLaneDeleteProgress = useAppStore((state) => (
    activeLaneId ? state.laneDeleteProgressByLaneId[activeLaneId] ?? null : null
  ));

  const draftContextTargetId = useMemo(() => (
    !activeWorkSession && activeLaneId
      ? buildDraftContextTargetId(activeLaneId, work.draftKind)
      : null
  ), [activeLaneId, activeWorkSession, work.draftKind]);

  const contextTarget = useMemo<WorkSidebarContextTarget | null>(() => {
    if (!activeWorkSession) {
      return draftContextTargetId && activeLaneId
        ? {
            kind: "draft",
            draftTargetId: draftContextTargetId,
            laneId: activeLaneId,
            draftKind: work.draftKind,
          }
        : null;
    }
    if (activeWorkSession.laneId !== activeLaneId) return null;
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
  }, [activeLaneId, activeWorkSession, draftContextTargetId, work.draftKind]);

  let contextDisabledReason: string | null;
  if (!activeWorkSession && contextTarget) {
    // Draft context target is available -- no session needed.
    contextDisabledReason = null;
  } else if (!activeWorkSession) {
    contextDisabledReason = "Select a lane before inserting tool context.";
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

  const workSidebarVisible = active && work.workSidebarOpen;
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const { setWorkSidebarTab, setOrchestratorEnabled } = work;
  useEffect(() => {
    if (!active) return;
    const openBrowserSidebar = () => {
      // Remote projects don't host the built-in browser, so ignore open-requests
      // (preserves main's remote-runtime hardening; the old viewMode switch is
      // dropped with the work-tab grid).
      if (isRemoteProject) return;
      setWorkSidebarTab("browser");
    };
    window.addEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, openBrowserSidebar);
    const unsubscribeBrowserEvents = window.ade?.builtInBrowser?.onEvent?.((event) => {
      if (event.type === "open-request" && browserEventMatchesProject(event, projectRoot)) openBrowserSidebar();
    }) ?? null;
    // The composer's "+" menu fires `ade:work:start-orchestrator-chat` to flip
    // the orthogonal orchestrator flag on the shared chat draft (keeps prompt /
    // model / lane intact); the stop event clears it back to a normal chat.
    const startOrchestratorChat = () => {
      setOrchestratorEnabled(true);
    };
    const stopOrchestratorChat = () => {
      setOrchestratorEnabled(false);
    };
    window.addEventListener("ade:work:start-orchestrator-chat", startOrchestratorChat);
    window.addEventListener("ade:work:stop-orchestrator-chat", stopOrchestratorChat);
    return () => {
      window.removeEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, openBrowserSidebar);
      window.removeEventListener("ade:work:start-orchestrator-chat", startOrchestratorChat);
      window.removeEventListener("ade:work:stop-orchestrator-chat", stopOrchestratorChat);
      unsubscribeBrowserEvents?.();
    };
  }, [active, isRemoteProject, projectRoot, setWorkSidebarTab, setOrchestratorEnabled]);

  const toggleSessionsPane = useCallback(() => {
    work.setWorkFocusSessionsHidden(!work.workFocusSessionsHidden);
  }, [work]);
  const toggleWorkSidebar = useCallback(() => {
    work.setWorkSidebarOpen(!work.workSidebarOpen);
  }, [work]);
  const terminalPaneOpen = work.workSidebarOpen && work.workSidebarTab === "terminal";
  const toggleTerminalPane = useCallback(() => {
    if (work.workSidebarOpen && work.workSidebarTab === "terminal") {
      work.setWorkSidebarOpen(false);
    } else {
      work.setWorkSidebarTab("terminal");
    }
  }, [work]);
  const openTerminalPane = useCallback(() => {
    if (!work.workSidebarOpen || work.workSidebarTab !== "terminal") {
      work.setWorkSidebarTab("terminal");
    }
  }, [work]);
  const closeWorkSidebar = useCallback(() => {
    work.setWorkSidebarOpen(false);
  }, [work]);

  // --- Cursor-style work grid: membership mutations ---
  // A session card dropped onto an existing grid tile. PaneTilingLayout already
  // spliced the dragged session into the tree at the hovered edge; here we only
  // update the grid set's membership and focus the dropped session.
  const handleAddSessionToGrid = useCallback((draggedId: string, targetId: string, _edge: DropEdge) => {
    if (draggedId === targetId) return;
    work.setGridSets((prev) => addSessionBesideTarget(prev, {
      sessionId: draggedId,
      targetSessionId: targetId,
      projectRoot,
    }).gridSets);
    work.openSessionTab(draggedId);
    work.setActiveItemId(draggedId);
  }, [work, projectRoot]);

  // A session card dropped onto a single (non-grid) session — create a new grid
  // from the pair, seeding the split tree to honor the drop edge.
  const handleCreateGridFromSingle = useCallback((draggedId: string, targetId: string, edge: DropEdge) => {
    if (draggedId === targetId) return;
    const placeAfter = edge === "right" || edge === "bottom";
    const { gridSets: next, gridSetId } = addSessionBesideTarget(work.gridSets, {
      sessionId: draggedId,
      targetSessionId: targetId,
      projectRoot,
      placeAfterTarget: placeAfter,
    });
    const set = next.find((entry) => entry.id === gridSetId);
    if (set) {
      const preset = edge === "left" || edge === "right" ? "columns" : "rows";
      const tree: PaneSplit = buildWorkSessionTilingTree(set.sessionIds, preset);
      window.ade.tilingTree.set(set.layoutId, tree).catch(() => {});
    }
    work.setGridSets(next);
    work.openSessionTab(draggedId);
    work.setActiveItemId(draggedId);
  }, [work, projectRoot]);

  // Remove a session from any grid it belongs to (right-click / drag-out) and
  // open it as a single session.
  const handleRemoveSessionFromGrid = useCallback((sessionId: string) => {
    work.setGridSets((prev) => removeSessionFromGrids(prev, sessionId));
    work.openSessionTab(sessionId);
    work.setActiveItemId(sessionId);
  }, [work]);

  const gridSessionIds = useMemo(
    () => work.gridSets.flatMap((set) => set.sessionIds),
    [work.gridSets],
  );

  // Keep grid membership in sync with live sessions: drop members that no longer
  // exist (closed/deleted) and dissolve any set that falls below two tiles.
  const setGridSets = work.setGridSets;
  useEffect(() => {
    if (work.loading || work.sessions.length === 0) return;
    const liveIds = new Set(work.sessions.map((s) => s.id));
    setGridSets((prev) => {
      let changed = false;
      const next = prev
        .map((set) => {
          const filtered = set.sessionIds.filter((id) => liveIds.has(id));
          if (filtered.length !== set.sessionIds.length) changed = true;
          return { ...set, sessionIds: filtered };
        })
        .filter((set) => set.sessionIds.length >= 2);
      if (next.length !== prev.length) changed = true;
      return changed ? next : prev;
    });
  }, [work.sessions, work.loading, setGridSets]);
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
        lanes={sortedLanes}
        sessions={work.sessions}
        visibleSessions={work.visibleSessions}
        activeItemId={work.activeItemId}
        draftKind={work.draftKind}
        orchestratorEnabled={work.orchestratorEnabled}
        draftLaneId={work.draftLaneId}
        draftContextTargetId={draftContextTargetId}
        onSelectItem={work.setActiveItemId}
        onCloseItem={work.closeTab}
        onOpenChatSession={handleOpenChatSession}
        onLaunchPtySession={work.launchPtySession}
        onImportedSession={work.adoptImportedSession}
        onOpenExistingImportedSession={work.openExistingImportedSession}
        onDraftLaneChange={work.setDraftLaneId}
        onShowDraftKind={work.showDraftKind}
        closingPtyIds={work.closingPtyIds}
        onContextMenu={handleContextMenu}
        onContinueCliSession={handleContinueCliSession}
        onResumeCliSession={handleResumeCliSession}
        sessionsPaneCollapsed={work.workFocusSessionsHidden}
        onToggleSessionsPane={toggleSessionsPane}
        sessionsPaneListCount={work.filtered.length}
        workSidebarOpen={work.workSidebarOpen}
        onToggleWorkSidebar={toggleWorkSidebar}
        terminalPaneOpen={terminalPaneOpen}
        onToggleTerminalPane={toggleTerminalPane}
        onOpenTerminalPane={openTerminalPane}
        onInfoClick={handleInfoClick}
        onStopRunningSession={handleStopRunningSession}
        onGoToLane={handleGoToLaneById}
        gridSets={work.gridSets}
        onAddSessionToGrid={handleAddSessionToGrid}
        onCreateGridFromSingle={handleCreateGridFromSingle}
        onRemoveSessionFromGrid={handleRemoveSessionFromGrid}
      />
    ),
    [
      sortedLanes,
      active,
      work.gridSets,
      handleAddSessionToGrid,
      handleCreateGridFromSingle,
      handleRemoveSessionFromGrid,
      work.sessions,
      work.visibleSessions,
      work.activeItemId,
      work.draftKind,
      work.orchestratorEnabled,
      work.draftLaneId,
      draftContextTargetId,
      work.setDraftLaneId,
      work.showDraftKind,
      work.setActiveItemId,
      work.closeTab,
      work.launchPtySession,
      work.adoptImportedSession,
      work.openExistingImportedSession,
      work.closingPtyIds,
      work.filtered.length,
      work.workFocusSessionsHidden,
      work.workSidebarOpen,
      work.workSidebarTab,
      terminalPaneOpen,
      toggleSessionsPane,
      toggleWorkSidebar,
      toggleTerminalPane,
      openTerminalPane,
      handleOpenChatSession,
      handleContinueCliSession,
      handleResumeCliSession,
      handleContextMenu,
      handleInfoClick,
      handleStopRunningSession,
      handleGoToLaneById,
    ],
  );

  const workViewWithSidebar = useMemo(
    () => (
      <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden">
        <div
          ref={workContentPaneRef}
          className="min-h-0 min-w-0 flex-1 basis-0 overflow-hidden"
          style={{ flexGrow: 100 - work.workSidebarWidthPct }}
        >
          {workViewArea}
        </div>
        {/* Resize handle stays a row-level sibling so its width math is correct. */}
        {workSidebarVisible ? (
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={handleWorkSidebarResizeMouseDown}
            className="relative w-[5px] shrink-0 cursor-col-resize bg-white/[0.06] transition-colors hover:bg-[var(--color-accent)]/25 active:bg-[var(--color-accent)]/40"
          />
        ) : null}
        <AnimatePresence initial={false}>
          {workSidebarVisible ? (
            // The panel slides via animated flex-grow so the content pane grows/
            // shrinks smoothly with it — no instant reflow / black flash on close.
            <motion.div
              key="work-tools-sidebar"
              ref={workSidebarPaneRef}
              className="min-h-0 min-w-0 basis-0 overflow-hidden"
              style={{ maxWidth: "55%" }}
              initial={{ flexGrow: 0 }}
              animate={{ flexGrow: work.workSidebarWidthPct }}
              exit={{ flexGrow: 0 }}
              transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
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
            </motion.div>
          ) : null}
        </AnimatePresence>
        {activeLaneDeleteProgress ? (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-bg/75 backdrop-blur-[2px]"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-card/95 px-3 py-2 text-[12px] font-medium text-muted-fg shadow-xl">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border border-muted-fg/35 border-t-accent" />
              {getLaneDeleteStatusLabel(activeLaneDeleteProgress)} lane
            </div>
          </div>
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
      activeLaneDeleteProgress,
    ],
  );

  const paneConfigs: Record<string, PaneConfig> = useMemo(
    () => ({
      sessions: {
        title: "",
        minimizable: false,
        // Stable automation anchor for the whole sessions pane.
        children: (
          <div ref={sessionsPaneRefCb} className="h-full min-h-0 flex flex-col" data-tour="work.sessionsPane">
          <SessionListPane
            lanes={sortedLanes}
            runningFiltered={work.runningFiltered}
            awaitingInputFiltered={work.awaitingInputFiltered}
            endedFiltered={work.endedFiltered}
            settledFiltered={work.settledFiltered}
            allSessionsUnfiltered={work.sessions}
            loading={work.loading}
            filterLaneId={work.filterLaneId}
            setFilterLaneId={work.setFilterLaneId}
            q={work.q}
            setQ={work.setQ}
            selectedSessionId={work.selectedSessionId}
            selectedSessionIds={selectedSessionIds}
            gridSets={work.gridSets}
            activeItemId={work.activeItemId}
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
            onBulkStopAndDelete={handleBulkStopAndDeleteSelected}
            onContextMenu={handleContextMenu}
            sessionListOrganization={work.sessionListOrganization}
            setSessionListOrganization={work.setSessionListOrganization}
            workCollapsedLaneIds={work.workCollapsedLaneIds}
            toggleWorkLaneCollapsed={work.toggleWorkLaneCollapsed}
            workCollapsedSectionIds={work.workCollapsedSectionIds}
            toggleWorkSectionCollapsed={work.toggleWorkSectionCollapsed}
            sessionsGroupedByLane={work.sessionsGroupedByLane}
            handoffJobs={handoffLaunchJobs}
          />
          </div>
        ),
      },

      view: {
        title: "",
        bodyClassName: "overflow-hidden",
        // Stable automation anchor for the whole view area.
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
      handleBulkStopAndDeleteSelected,
      handleInfoClick,
      handleContextMenu,
      handoffLaunchJobs,
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
        <div ref={unifiedChromeRef} className="ade-work-unified-chrome flex min-h-0 flex-1 flex-col">
          {/* Legacy top tab/grid bar removed — each chat/CLI surface owns its own
              header (far-left sessions toggle + far-right Tools toggle). */}
          <PaneTilingLayout
            layoutId="work:tiling:v3"
            tree={TERMINALS_TILING_TREE}
            panes={paneConfigs}
            className="ade-work-surface min-h-0 flex-1"
          />
        </div>
      )}

      <SessionContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onStopRuntime={({ ptyId, sessionId }) => work.stopRuntime(ptyId, sessionId).catch(() => {})}
        onStopAndDelete={handleStopAndDeleteSession}
        onDeleteChat={handleDeleteChat}
        onDeleteSession={handleDeleteSession}
        deletingSessionId={deletingSessionId}
        onGoToLane={handleGoToLane}
        onCopySessionId={(id) => navigator.clipboard.writeText(id).catch(() => {})}
        onSettle={handleSettleSession}
        onUnsettle={handleUnsettleSession}
        onCopySessionDeepLink={(session) => {
          void (async () => {
            const lane = work.lanes.find((candidate) => candidate.id === session.laneId) ?? null;
            const remote = session.laneId
              ? await window.ade.git.getOriginRemote({ laneId: session.laneId }).catch(() => null)
              : null;
            const repo = parseGithubRemoteUrl(remote?.remoteUrl ?? null);
            const branch = lane?.branchRef?.replace(/^refs\/heads\//, "") || remote?.branch || null;
            const href = buildDeeplink(
              {
                kind: "session",
                sessionId: session.id,
                laneId: session.laneId || undefined,
                ...(repo
                  ? {
                      envelope: {
                        repoOwner: repo.owner,
                        repoName: repo.repo,
                        ...(branch ? { branch } : {}),
                      },
                    }
                  : {}),
              },
              { form: "ade" },
            );
            await navigator.clipboard.writeText(href).catch(() => {});
          })();
        }}
        onOpenSessionInWeb={(session) => {
          openExternalUrl(buildWebClientUrl({ kind: "session", sessionId: session.id, laneId: session.laneId }));
        }}
        onTogglePinned={(session) => work.togglePinnedSession(session.id)}
        pinnedSessionIds={work.pinnedSessionIds}
        gridSessionIds={gridSessionIds}
        onRemoveFromGrid={(session) => handleRemoveSessionFromGrid(session.id)}
        onSetChatTag={(session, tag) => {
          setSessionActionError(null);
          window.ade.agentChat.updateSession({ sessionId: session.id, tag })
            .then(() => {
              invalidateSessionListCache();
              work.refresh({ showLoading: false, force: true }).catch((refreshErr: unknown) => {
                console.error("[TerminalsPage] refresh after tag failed", { sessionId: session.id, refreshErr });
              });
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error("[TerminalsPage] set session tag failed", { sessionId: session.id, err });
              setSessionActionError(`Set tag failed: ${message}`);
              window.setTimeout(() => setSessionActionError(null), 6000);
            });
        }}
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
        onStopAndDelete={handleStopAndDeleteSession}
        onDeleteChat={handleDeleteChat}
        onDeleteSession={handleDeleteSession}
        onGoToLane={handleGoToLane}
        closingPtyIds={work.closingPtyIds}
        deletingSessionId={deletingSessionId}
      />

      <ConfirmDialog state={stopAndDeleteConfirm.state} onClose={stopAndDeleteConfirm.close} />
    </div>
  );
}
