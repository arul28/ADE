import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AppWindow,
  ArrowCounterClockwise,
  ChatCircleDots,
  FolderOpen,
  FolderSimple,
  GitMerge,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { cloneTargetFor, projectMenuSections } from "./projectMenuEntries";
import {
  ContextMenu,
  type ContextMenuEntry,
  type ContextMenuState,
} from "../ui/ContextMenu";
import { ProjectIconDialog, type ProjectIconDialogTarget } from "./ProjectIconDialog";
import { CloneLocallyDialog, type CloneLocallyTarget } from "./CloneLocallyDialog";
import { useAppStore } from "../../state/appStore";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";
import { COLORS } from "../lanes/laneDesignTokens";
import { CommandPalette } from "../app/CommandPalette";
import { Banner } from "../ui/notice";
import { dismissToast, showToast } from "../app/toast/toastStore";
import {
  groupRecentProjects,
  recentProjectLocationKey,
  localBindingFromRecent,
  remoteBindingFromRecent,
  type RecentProjectGroup,
} from "../app/projectTabGrouping";
import { isWebClientMode } from "../../lib/webClientMode";
import { useOptionalWebWorkspace, useWebMachines } from "../../webclient/workspace/WebWorkspaceContext";
import { webRecentProjects } from "../../webclient/workspace/webWorkspaceModel";
import {
  RecentProjectRow,
  type WebRowChrome,
} from "./ProjectWelcomeWebRows";
import { WelcomeCardHead, useRunningChats } from "./ProjectWelcomeSidePanels";
import {
  ActivityUsageCard,
  HomeAction,
  LimitsMachinesCard,
  PullRequestsCard,
  RunningCard,
  WelcomeHero,
  useMachineRows,
  useRecentStats,
} from "./ProjectWelcomeHome";
import { activityBoardColumn } from "../../../shared/attention/activityBoardColumn";
import { useBackgroundContextMenu } from "../../scene/BackgroundContextMenu";
import {
  WebAddProjectNotice,
  WebZeroMachines,
  webZeroMachinesNotice,
} from "./ProjectWelcomeWebNotices";
import { MergeWorktreeProjectDialog } from "./MergeWorktreeProjectDialog";
import type {
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionState,
} from "../../../shared/types";
import "./ProjectWelcomePage.css";

function recentKey(rp: RecentProjectSummary): string {
  return recentProjectLocationKey(rp);
}
// How long the "Removed — Undo" toast stays before the forget is committed.
const FORGET_UNDO_WINDOW_MS = 5_000;
const FORGET_TOAST_ID = "welcome-forget-recent";


export function ProjectWelcomePage() {
  const navigate = useNavigate();
  const workspace = useOptionalWebWorkspace();
  const webMode = isWebClientMode() && workspace != null;
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const switchRemoteProject = useAppStore((s) => s.switchRemoteProject);
  const project = useAppStore((s) => s.project);
  const theme = useAppStore((s) => s.theme);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const cancelNewTab = useAppStore((s) => s.cancelNewTab);
  const [recentProjects, setRecentProjects] = useState<RecentProjectSummary[]>(
    [],
  );
  const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);
  const [webAddProjectNoticeOpen, setWebAddProjectNoticeOpen] = useState(false);
  const [remoteSnapshot, setRemoteSnapshot] =
    useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const applyRemoteSnapshot = useCallback(
    (snapshot: RemoteRuntimeConnectionSnapshot) => {
      setRemoteSnapshot((current) =>
        current && current.updatedAt > snapshot.updatedAt ? current : snapshot,
      );
    },
    [],
  );
  // Keys hidden by a pending deferred forget (committed only after the undo
  // window expires). Reconnect/open state is keyed the same way.
  const [pendingForgetKeys, setPendingForgetKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [forgetToast, setForgetToast] = useState<{
    key: string;
    name: string;
    recentKeys: string[];
  } | null>(null);
  const [connectingKeys, setConnectingKeys] = useState<Set<string>>(
    () => new Set(),
  );
  /**
   * The one recents row being opened on the hosted client, by row key.
   *
   * Not a machine key: every row on a machine shares that machine's connection state,
   * so keying the "Reconnecting…" chrome off the machine lit up every card that
   * happened to live on it. Which repo you clicked is the thing the spinner is
   * reporting, and only the row knows that.
   */
  const [openingRowKey, setOpeningRowKey] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  // Kept apart from rowError: the recents-list error banner only renders when
  // there are rows, and a directory retry fails precisely when there are none.
  const [directoryRetryError, setDirectoryRetryError] = useState<string | null>(
    null,
  );
  const [mergeTarget, setMergeTarget] = useState<RecentProjectSummary | null>(
    null,
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  // The side column folds into a tabbed strip when the page itself is narrow
  // (the page can sit in a pane, so this is the page's width, not the window's).
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    // Measure the page, not the body: the body narrows itself in the
    // one-column layout, which would latch this state on.
    const element = pageRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth;
      setNarrow(width < 880);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const running = useRunningChats();
  const recentStats = useRecentStats();
  const needsYouCount = running.filter((item) => activityBoardColumn(item) === "needs_you").length;
  const forgetTimerRef = useRef<number | null>(null);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    if (webMode) return;
    window.ade.project
      .listRecent()
      .then(setRecentProjects)
      .catch(() => {});
  }, [webMode]);

  useEffect(() => {
    if (webMode) return;
    const remoteRuntime = window.ade.remoteRuntime;
    if (!remoteRuntime?.getConnectionSnapshot) return;
    let cancelled = false;
    void remoteRuntime
      .getConnectionSnapshot()
      .then((snapshot) => {
        if (!cancelled) applyRemoteSnapshot(snapshot);
      })
      .catch(() => {});
    const unsubscribe =
      remoteRuntime.onConnectionSnapshotChanged?.((snapshot) => {
        if (!cancelled) applyRemoteSnapshot(snapshot);
      }) ?? (() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyRemoteSnapshot, webMode]);

  useEffect(
    () => () => {
      if (forgetTimerRef.current != null) {
        window.clearTimeout(forgetTimerRef.current);
      }
    },
    [],
  );

  // Live connection state per remote target, used to pick the dot color and
  // decide whether a remote row needs a reconnect before opening.
  const connectionByTarget = useMemo(() => {
    const map = new Map<string, RemoteRuntimeConnectionState>();
    for (const connection of remoteSnapshot?.connections ?? []) {
      map.set(connection.target.id, connection.state);
    }
    return map;
  }, [remoteSnapshot]);

  // ---------------------------------------------------------------------
  // Hosted client: recents are the union of every machine's project catalog,
  // live where a session exists and cached everywhere else, so the list paints
  // before the first relay dial and fills in as machines come up.
  // ---------------------------------------------------------------------
  const webMachines = useWebMachines();
  const machineRows = useMachineRows(webMode, remoteSnapshot, webMachines);
  const machinesOnline = machineRows.filter((row) => row.dot === "online").length;
  const webMachineByKey = useMemo(
    () => new Map(webMachines.map((machine) => [machine.key, machine])),
    [webMachines],
  );
  const webRecents = useMemo(() => webRecentProjects(webMachines), [webMachines]);
  const activeWebMachine = useMemo(() => (
    webMachines.find((machine) => machine.status === "live")
    ?? webMachines.find((machine) => machine.key === workspace?.snapshot.lastActiveMachineKey)
    ?? webMachines.find((machine) => machine.status === "available")
    ?? webMachines[0]
    ?? null
  ), [webMachines, workspace?.snapshot.lastActiveMachineKey]);

  useEffect(() => {
    if (!webMode || !workspace) return;
    // Point the federated adapter back at its machine-less fallback while the
    // welcome surface is up, unless a project tab is still bound behind it.
    if (!workspace.adapter.getActiveBinding()) workspace.adapter.activateHub();
  }, [webMode, workspace]);

  const visibleProjectGroups = useMemo(() => {
    const kept = (webMode ? webRecents : recentProjects).filter((rp) => {
      if (rp.kind === "remote") return true;
      return rp.exists && !rp.rootPath.includes("ade-project");
    });
    return groupRecentProjects({
      recentProjects: kept,
      remoteSnapshot: webMode ? null : remoteSnapshot,
    }).filter((group) => !pendingForgetKeys.has(group.id));
  }, [pendingForgetKeys, recentProjects, remoteSnapshot, webMode, webRecents]);

  const connectedRemoteCount = remoteSnapshot?.connectedCount ?? 0;

  // Selecting anything on the hosted client connects its machine first — a
  // machine the account can reach is never a dead end (bug-ledger C2d).
  const openWebProject = useCallback(
    (machineKey: string, projectId: string, rowKey: string) => {
      if (!workspace) return;
      const machine = webMachineByKey.get(machineKey);
      if (!machine) return;
      setRowError(null);
      setOpeningRowKey(rowKey);
      void (async () => {
        try {
          const targetId = await workspace.connectMachineEntry(machine);
          await workspace.adapter.openProject(targetId, projectId);
          navigate(workspace.consumePendingProjectPath() ?? "/work");
        } catch (error) {
          setRowError(error instanceof Error ? error.message : String(error));
        } finally {
          setOpeningRowKey((current) => (current === rowKey ? null : current));
        }
      })();
    },
    [navigate, webMachineByKey, workspace],
  );

  // Why the hosted client is showing no machines, in the account's own words.
  // Only computed when there is nothing to list — a populated list speaks for
  // itself even when the last directory read failed.
  const webZeroMachines = useMemo(() => (
    webMode && workspace && webMachines.length === 0
      ? webZeroMachinesNotice({
          account: workspace.account,
          directoryLoading: workspace.directoryLoading,
          retryError: directoryRetryError,
          onRetry: () => {
            setDirectoryRetryError(null);
            void workspace.retryDirectory().catch((error) => {
              setDirectoryRetryError(
                error instanceof Error ? error.message : String(error),
              );
            });
          },
          onSignIn: () => {
            setDirectoryRetryError(null);
            workspace.signIn();
          },
        })
      : null
  ), [directoryRetryError, webMachines.length, webMode, workspace]);

  const openWebChats = useCallback(() => {
    if (!workspace || !activeWebMachine) return;
    setRowError(null);
    // No row chrome to drive: this button is not a recents row, and marking its
    // machine busy is what used to spin every card that machine happened to own.
    void (async () => {
      try {
        const targetId = await workspace.connectMachineEntry(activeWebMachine);
        await workspace.adapter.activateChats(targetId);
        navigate("/chats");
      } catch (error) {
        setRowError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [activeWebMachine, navigate, workspace]);

  const handleOpen = useCallback(
    (rp: RecentProjectSummary) => {
      setRowError(null);
      if (webMode && rp.kind === "remote" && rp.remote) {
        openWebProject(rp.remote.targetId, rp.remote.projectId, recentKey(rp));
        return;
      }
      if (rp.kind === "remote" && rp.remote) {
        const key = recentKey(rp);
        const targetId = rp.remote.targetId;
        const projectId = rp.remote.projectId;
        const state = connectionByTarget.get(targetId) ?? null;
        if (state === "connected") {
          void switchRemoteProject(targetId, projectId).catch((error) => {
            setRowError(
              error instanceof Error ? error.message : String(error),
            );
          });
          return;
        }
        // Offline: establish the SSH connection first, then bind the project.
        setConnectingKeys((prev) => new Set(prev).add(key));
        void (async () => {
          try {
            await window.ade.remoteRuntime.connect(targetId);
            await switchRemoteProject(targetId, projectId);
          } catch (error) {
            setRowError(
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            setConnectingKeys((prev) => {
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
          }
        })();
        return;
      }
      if (project?.rootPath === rp.rootPath) {
        cancelNewTab();
        return;
      }
      void switchProjectToPath(rp.rootPath);
    },
    [
      cancelNewTab,
      connectionByTarget,
      openWebProject,
      project?.rootPath,
      switchProjectToPath,
      switchRemoteProject,
      webMode,
    ],
  );

  const handleTogglePin = useCallback(async (group: RecentProjectGroup) => {
    try {
      let next = recentProjects;
      for (const key of group.recentKeys) {
        next = await window.ade.project.setRecentPinned(key, !group.pinned);
      }
      setRecentProjects(next);
    } catch (error) {
      setRowError(error instanceof Error ? error.message : String(error));
    }
  }, [recentProjects]);

  // Deferred-commit forget: hide the row immediately and show an undo toast.
  // Only after the window elapses do we call the backend forget. Undo cancels
  // the timer and unhides the row, with no backend call.
  const commitForget = useCallback((key: string, recentKeys: string[]) => {
    if (forgetTimerRef.current != null) {
      window.clearTimeout(forgetTimerRef.current);
      forgetTimerRef.current = null;
    }
    void (async () => {
      let next = recentProjects;
      for (const recentKey of recentKeys) {
        next = await window.ade.project.forgetRecent(recentKey);
      }
      setRecentProjects(next);
    })().catch(() => {});
    setPendingForgetKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setForgetToast(null);
  }, [recentProjects]);

  const handleForget = useCallback(
    (group: RecentProjectGroup) => {
      const key = group.id;
      // Flush any prior pending forget so we never stack timers.
      const previousKey = forgetToast?.key ?? null;
      if (previousKey && previousKey !== key) {
        commitForget(previousKey, forgetToast?.recentKeys ?? []);
      } else if (forgetTimerRef.current != null) {
        window.clearTimeout(forgetTimerRef.current);
        forgetTimerRef.current = null;
      }
      setForgetToast({
        key,
        name: group.displayName,
        recentKeys: group.recentKeys,
      });
      setPendingForgetKeys((prev) => new Set(prev).add(key));
      forgetTimerRef.current = window.setTimeout(() => {
        forgetTimerRef.current = null;
        commitForget(key, group.recentKeys);
      }, FORGET_UNDO_WINDOW_MS);
    },
    [commitForget, forgetToast],
  );

  const handleUndoForget = useCallback(() => {
    if (forgetTimerRef.current != null) {
      window.clearTimeout(forgetTimerRef.current);
      forgetTimerRef.current = null;
    }
    setForgetToast((current) => {
      if (current) {
        setPendingForgetKeys((prev) => {
          const next = new Set(prev);
          next.delete(current.key);
          return next;
        });
      }
      return null;
    });
  }, []);

  // The undo offer is a shared toast; this page's own timer decides when the
  // forget commits (and clears `forgetToast`), so the toast itself is sticky.
  useEffect(() => {
    if (!forgetToast) {
      dismissToast(FORGET_TOAST_ID);
      return;
    }
    showToast({
      id: FORGET_TOAST_ID,
      tone: "neutral",
      icon: <Trash size={15} weight="fill" />,
      title: `Removed ${forgetToast.name}`,
      actions: [
        {
          label: "Undo",
          variant: "primary",
          icon: <ArrowCounterClockwise size={12} weight="bold" />,
          onClick: handleUndoForget,
        },
      ],
      dismissible: false,
      durationMs: 0,
    });
  }, [forgetToast, handleUndoForget]);
  useEffect(() => () => dismissToast(FORGET_TOAST_ID), []);

  const handleDropFolder = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      try {
        const path = window.ade.project.getDroppedPath(file);
        if (path) {
          setRowError(null);
          void switchProjectToPath(path);
        }
      } catch (error) {
        setRowError(error instanceof Error ? error.message : String(error));
      }
    },
    [switchProjectToPath],
  );

  const rows = useMemo(() => visibleProjectGroups.map((group) => {
    const primary = group.primary;
    const rp = {
      ...primary.summary,
      pinned: group.pinned,
    };
    return { group, rp, key: recentKey(rp) };
  }), [visibleProjectGroups]);

  const [rowMenu, setRowMenu] = useState<(NonNullable<ContextMenuState> & { key: string }) | null>(null);
  const closeRowMenu = useCallback(() => setRowMenu(null), []);
  const [iconDialogTarget, setIconDialogTarget] = useState<ProjectIconDialogTarget | null>(null);
  const closeIconDialog = useCallback(() => setIconDialogTarget(null), []);
  const [cloneLocallyTarget, setCloneLocallyTarget] = useState<CloneLocallyTarget | null>(null);

  const rowMenuEntries = useMemo((): ContextMenuEntry[] => {
    if (!rowMenu) return [];
    const row = rows.find((entry) => entry.key === rowMenu.key);
    if (!row) return [];
    const { group, rp } = row;
    const remoteBinding = remoteBindingFromRecent(rp);
    const connected = remoteBinding
      ? connectionByTarget.get(remoteBinding.targetId) === "connected"
      : false;
    const localReady = !remoteBinding && rp.exists !== false;
    const sections = projectMenuSections(
      {
        rootPath: rp.rootPath,
        displayName: rp.displayName,
        binding: remoteBinding ?? localBindingFromRecent(rp),
        available: localReady || remoteBinding != null,
        pinned: Boolean(group.pinned),
        hostIconDataUrl: remoteBinding?.iconDataUrl ?? null,
        cloneTarget: cloneTargetFor({
          binding: remoteBinding,
          hasLocalCheckout: group.locations.some((location) => location.summary.kind !== "remote"),
          gitOriginUrl: rp.gitOriginUrl ?? rp.remote?.gitOriginUrl,
        }),
      },
      { webMode },
      {
        onChangeIcon: setIconDialogTarget,
        onClone: setCloneLocallyTarget,
        onTogglePin: () => void handleTogglePin(group),
      },
    );
    const canMerge = !remoteBinding && Boolean(rp.worktreeOf) && rp.exists;
    const entries: Array<ContextMenuEntry | null> = [
      { kind: "item", key: "open", label: "Open", icon: FolderOpen, onSelect: () => handleOpen(rp) },
      !webMode && (localReady || connected)
        ? {
            kind: "item",
            key: "new-window",
            label: "Open in new window",
            icon: AppWindow,
            onSelect: () => {
              void window.ade.app
                .openProjectInNewWindow(remoteBinding ?? localBindingFromRecent(rp))
                .catch((error: unknown) =>
                  setRowError(error instanceof Error ? error.message : String(error)),
                );
            },
          }
        : null,
      ...sections.open,
      { kind: "separator", key: "sep-project" },
      ...sections.project,
      !webMode && canMerge && rp.worktreeOf
        ? {
            kind: "item",
            key: "merge",
            label: `Merge into ${rp.worktreeOf.displayName} as a lane…`,
            icon: GitMerge,
            onSelect: () => setMergeTarget(rp),
          }
        : null,
      { kind: "separator", key: "sep-copy" },
      ...sections.copy,
      !webMode ? { kind: "separator", key: "sep-remove" } : null,
      !webMode
        ? {
            kind: "item",
            key: "forget",
            label: "Remove from recents",
            icon: Trash,
            danger: true,
            onSelect: () => handleForget(group),
          }
        : null,
    ];
    return entries.filter((entry): entry is ContextMenuEntry => entry != null);
  }, [connectionByTarget, handleForget, handleOpen, handleTogglePin, rowMenu, rows, webMode]);

  const focusRowButton = useCallback((index: number) => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-welcome-row="true"]');
    buttons?.[index]?.focus();
  }, []);

  // Arrow keys walk the rows once focus is on one of them.
  const handleListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target as HTMLElement;
    if (target.dataset.welcomeRow !== "true") return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-welcome-row="true"]') ?? [])];
    const index = buttons.indexOf(target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "ArrowDown"
      ? Math.min(index + 1, buttons.length - 1)
      : Math.max(index - 1, 0);
    focusRowButton(next);
  }, [focusRowButton]);

  const hasProjects = visibleProjectGroups.length > 0;
  const showSide = !webMode || webMachines.length > 0;
  const hasRunning = running.length > 0;
  const backgroundPageEntries = useMemo((): ContextMenuEntry[] => [
    {
      kind: "item",
      key: "add-project",
      label: "Add project…",
      icon: Plus,
      disabled: webMode && !activeWebMachine,
      onSelect: () => (webMode ? setWebAddProjectNoticeOpen(true) : setProjectBrowserOpen(true)),
    },
    {
      kind: "item",
      key: "chat",
      label: "Chat without a project",
      icon: ChatCircleDots,
      disabled: webMode && !activeWebMachine,
      onSelect: () => (webMode ? openWebChats() : navigate("/chats")),
    },
  ], [activeWebMachine, navigate, openWebChats, webMode]);
  const backgroundMenu = useBackgroundContextMenu(backgroundPageEntries);

  return (
    <div
      ref={pageRef}
      className="ade-welcome"
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        setIsDragOver(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDragOver(false);
      }}
      onDrop={handleDropFolder}
      onContextMenu={backgroundMenu.onContextMenu}
      data-ade-web-welcome={webMode ? "true" : undefined}
      style={{
        // The window gradient paints over this base; see the backdrop below.
        background: COLORS.pageBg,
        outline: isDragOver
          ? "2px dashed color-mix(in srgb, var(--color-accent) 70%, transparent)"
          : "none",
        outlineOffset: -8,
        transition: "outline-color 0.15s ease",
      }}
    >
      {/* The welcome screen is one field with the top bar's gradient. */}
      <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: -1, pointerEvents: "none" }}>
        <WorkToolPickerBackdrop theme={theme} field="window" />
      </div>
      <style>
        {`@keyframes ade-welcome-mark {
            from { opacity: 0; transform: translateY(8px) scale(0.985); }
            to { opacity: 1; transform: none; }
          }
          @media (prefers-reduced-motion: reduce) {
            [data-ade-welcome-motion] { animation: none !important; }
          }`}
      </style>
      {isDragOver ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 16,
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background:
              "color-mix(in srgb, var(--color-accent) 10%, transparent)",
            color: COLORS.accent,
            fontSize: 14,
            fontWeight: 600,
            zIndex: 30,
            pointerEvents: "none",
          }}
        >
          Drop a folder to open it
        </div>
      ) : null}

      <div className="ade-home" data-narrow={narrow ? "true" : undefined}>
        <WelcomeHero
          runningCount={running.length}
          needsYouCount={needsYouCount}
          machinesOnline={machinesOnline}
          machinesTotal={machineRows.length}
          actions={(
            <>
              <HomeAction
                icon={Plus}
                primary
                label="Add project"
                tour="project.welcomeAddButton"
                disabled={webMode && !activeWebMachine}
                title={
                  webMode && !activeWebMachine
                    ? "Connect a machine first — projects are added on the machine that hosts them."
                    : undefined
                }
                onClick={() => {
                  if (!webMode) {
                    setProjectBrowserOpen(true);
                    return;
                  }
                  setWebAddProjectNoticeOpen(true);
                }}
              />
              <HomeAction
                icon={ChatCircleDots}
                label={webMode && activeWebMachine ? `Chat on ${activeWebMachine.name}` : "Chat without a project"}
                disabled={webMode && !activeWebMachine}
                onClick={() => (webMode ? openWebChats() : navigate("/chats"))}
              />
            </>
          )}
        />

        {webMode && webAddProjectNoticeOpen && activeWebMachine ? (
          <WebAddProjectNotice
            machineName={activeWebMachine.name}
            onDismiss={() => setWebAddProjectNoticeOpen(false)}
          />
        ) : null}
        {/* Above the recents list, not inside it: "Chat without a project"
            reports its failures here too, and that button works with zero
            recents — where a banner scoped to the list rendered nothing. */}
        {rowError ? (
          <Banner
            layout="inline"
            style={{ maxWidth: 520, width: "100%" }}
            model={{
              id: "welcome-row-error",
              tone: "error",
              title: <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{rowError}</span>,
              ariaLabel: rowError,
            }}
          />
        ) : null}
        {webZeroMachines ? <WebZeroMachines notice={webZeroMachines} /> : null}

        <div
          className="ade-home-grid"
          data-single={showSide ? undefined : "true"}
          data-running={hasRunning ? "true" : undefined}
        >
          <div className="ade-home-col">
          <section className="kit-card ade-home-card ade-home-projects" aria-label="Recent projects">
            <WelcomeCardHead
              icon={FolderSimple}
              title="Projects"
              count={hasProjects ? visibleProjectGroups.length : null}
            />
            {hasProjects ? (
              <div
                id="ade-welcome-project-list"
                ref={listRef}
                className="kit-card-body ade-welcome-list ade-home-scroll"
                data-flush="true"
                onKeyDown={handleListKeyDown}
              >
              {rows.map(({ group, rp, key }) => {
                const primary = group.primary;
                const isRemote = rp.kind === "remote" && Boolean(rp.remote);
                const targetId = rp.remote?.targetId;
                const baseState = isRemote && targetId
                  ? (connectionByTarget.get(targetId) ?? "idle")
                  : null;
                const connectionState: RemoteRuntimeConnectionState | null =
                  connectingKeys.has(key) ? "connecting" : baseState;
                const isOpenLocal =
                  !isRemote && project?.rootPath === rp.rootPath;
                const isOpenRemote =
                  isRemote
                  && projectBinding?.kind === "remote"
                  && projectBinding.targetId === rp.remote?.targetId
                  && projectBinding.projectId === rp.remote?.projectId;
                const canMerge = !isRemote && Boolean(rp.worktreeOf) && rp.exists;
                const machine = webMode && targetId ? webMachineByKey.get(targetId) ?? null : null;
                // The connect/open stages belong to the row that was clicked.
                // Every other row on the same machine sees the same machine-level
                // "connecting", so it has to be suppressed there explicitly —
                // otherwise one click spins the whole list.
                const isOpeningRow = openingRowKey === key;
                const web: WebRowChrome | null = machine
                  ? {
                      status: isOpeningRow
                        ? "connecting"
                        : machine.status === "connecting"
                          ? "available"
                          : machine.status,
                      connectStage: isOpeningRow
                        ? machine.connectStage ?? "Dialing relay…"
                        : null,
                      stale: machine.stale,
                    }
                  : null;
                return (
                  <RecentProjectRow
                    key={group.id}
                    rp={rp}
                    connectionState={connectionState}
                    isOpen={isOpenLocal || isOpenRemote}
                    isForgetting={pendingForgetKeys.has(group.id)}
                    busy={openingRowKey != null && !isOpeningRow}
                    onOpen={() => handleOpen(rp)}
                    onTogglePin={() => void handleTogglePin(group)}
                    onForget={() => handleForget(group)}
                    onMerge={canMerge ? () => setMergeTarget(rp) : undefined}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setRowMenu({ x: event.clientX, y: event.clientY, key });
                    }}
                    primary={primary}
                    locations={group.locations}
                    onSelectMachine={(location) => handleOpen(location.summary)}
                    lastActiveAt={group.lastOpenedAt}
                    web={web}
                  />
                );
              })}
              </div>
            ) : (
              <div className="ade-welcome-empty">
                <strong>No projects yet</strong>
                {webMode
                  ? "Projects you open on your machines show up here."
                  : "Add a folder or clone a repository to get started. You can also drop a folder anywhere on this page."}
              </div>
            )}
          </section>
          {showSide ? <RunningCard onOpenActivity={() => navigate("/activity")} /> : null}
          </div>

          {showSide ? (
            <>
              <ActivityUsageCard stats={recentStats} />
              <LimitsMachinesCard machineRows={machineRows} webMode={webMode} />
              <PullRequestsCard
                projectName={project?.displayName ?? null}
                projectRoot={project?.rootPath ?? null}
                onOpenPrs={project ? () => navigate("/prs") : undefined}
              />
            </>
          ) : null}
        </div>
      </div>

      {backgroundMenu.menu}
      <ContextMenu
        menu={rowMenu}
        entries={rowMenuEntries}
        onClose={closeRowMenu}
        label="Project"
      />
      <ProjectIconDialog target={iconDialogTarget} onClose={closeIconDialog} />
      <CloneLocallyDialog
        target={cloneLocallyTarget}
        onClose={() => setCloneLocallyTarget(null)}
        onCloned={(result) => {
          void switchProjectToPath(result.rootPath).catch(() => {});
        }}
      />

      {mergeTarget ? (
        <MergeWorktreeProjectDialog
          recent={mergeTarget}
          recentKey={recentKey(mergeTarget)}
          onClose={() => setMergeTarget(null)}
          onRecentsUpdated={(next) => {
            setRecentProjects(next);
            setMergeTarget(null);
          }}
        />
      ) : null}

      <CommandPalette
        open={projectBrowserOpen}
        onOpenChange={setProjectBrowserOpen}
        intent="project-add"
      />
    </div>
  );
}
