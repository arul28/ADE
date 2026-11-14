import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLaneShareHomeRows } from "../laneShare/guest/LaneShareHomeRows";
import { useNavigate } from "react-router-dom";
import { BROWSER_TAB_ROUTE, browserTabAvailable } from "../browser/browserTab";
import { HomeAppButton, openMusicApp } from "../music/musicApps";
import { musicTabAvailable } from "../music/musicTab";
import {
  AppWindow,
  ChatCircleDots,
  Eye,
  FolderOpen,
  GitMerge,
  Globe,
  MusicNotes,
  Plus,
  SlidersHorizontal,
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
import { openProjectCopy } from "./AddProjectForm";
import { useAppStore } from "../../state/appStore";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";
import { COLORS } from "../lanes/laneDesignTokens";
import { CommandPalette } from "../app/CommandPalette";
import { Banner } from "../ui/notice";
import {
  ACCOUNT_MACHINE_TARGET_PREFIX,
  recentProjectLocationKey,
  localBindingFromRecent,
  remoteBindingFromRecent,
  type RecentProjectGroup,
} from "../app/projectTabGrouping";
import { isWebClientMode } from "../../lib/webClientMode";
import { useOptionalWebWorkspace, useWebMachines } from "../../webclient/workspace/WebWorkspaceContext";
import { webRecentProjects } from "../../webclient/workspace/webWorkspaceModel";
import { ProjectsCard } from "./ProjectWelcomeProjectsCard";
import { HomeAction, WelcomeHero, useMachineRows } from "./ProjectWelcomeHome";
import { HomeWidgetGrid, useHomeGridMetrics } from "../home/HomeWidgetGrid";
import { gridMetrics } from "../home/homeGridPack";
import { HomeDataContext, HomeRenderWidgetContext } from "../home/homeData";
import { useHomeLayoutStore } from "../home/homeLayout";
import { useHomePageWiring } from "../home/useHomePageWiring";
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
import { RECENT_PROJECTS_CHANGED_EVENT } from "../../lib/recentProjectsEvents";
import { useHomeAccountProjects } from "./useHomeAccountProjects";
import type { HomeWebComputer } from "./homeProjectRows";
import { useHomeRowRemoval } from "./useHomeRowRemoval";

// Edit mode's toolbar, gallery and appearance sliders: loaded the first time
// someone customizes the page, never on the boot path.
const HomeEditTools = lazy(() => import("../home/HomeEditTools"));

function recentKey(rp: RecentProjectSummary): string {
  return recentProjectLocationKey(rp);
}
/** Where a web user with no computer gets ADE. */
const ADE_DOWNLOAD_PAGE_URL = "https://ade-app.dev/";


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
  // The first recents read finished (or failed): Home's catalog read waits for it.
  const [recentsLoaded, setRecentsLoaded] = useState(false);
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
  // A row action's failure (open, pin, forget).
  const [rowError, setRowError] = useState<string | null>(null);
  // A failed recents read must not look like "no projects yet".
  const [recentListError, setRecentListError] = useState<string | null>(null);
  // Kept apart from both: a hosted directory retry fails precisely when the
  // recents list has no rows, which is when the other banners are least useful.
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
  // The grid's width: as many columns as the page holds (homeGridPack), so
  // the hero lines up with the grid at every window size.
  const [gridWidth, setGridWidth] = useState<number | null>(null);
  useEffect(() => {
    // Measure the page, not the body: the body narrows itself in the
    // one-column layout, which would latch this state on.
    const element = pageRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth;
      setNarrow(width < 880);
      setGridWidth(gridMetrics(Math.max(0, width - 40), 0).width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The width the grid actually packed to (fewer, centred columns on a wide
  // window), so the hero's buttons end where the cards end.
  const packedGridWidth = useHomeGridMetrics((s) => s.packedWidth);
  const editingHome = useHomeLayoutStore((s) => s.editing);
  const hiddenApps = useHomeLayoutStore((s) => s.layout.hiddenApps);
  const setEditingHome = useHomeLayoutStore((s) => s.setEditing);
  const homeAppearance = useHomeLayoutStore((s) => s.layout.appearance);
  useEffect(() => {
    if (!editingHome) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setEditingHome(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingHome, setEditingHome]);
  useEffect(() => () => setEditingHome(false), [setEditingHome]);
  const dragDepthRef = useRef(0);

  const recentReadRef = useRef(0);
  const loadRecentProjects = useCallback(() => {
    const request = ++recentReadRef.current;
    window.ade.project
      .listRecent()
      .then((rows) => {
        if (recentReadRef.current !== request) return;
        setRecentProjects(rows);
        setRecentListError(null);
        setRecentsLoaded(true);
      })
      .catch((error: unknown) => {
        if (recentReadRef.current !== request) return;
        setRecentListError(error instanceof Error ? error.message : String(error));
        setRecentsLoaded(true);
      });
  }, []);

  useEffect(() => {
    if (webMode) return;
    loadRecentProjects();
    // First-run setup can add projects while Home is already showing (a
    // replay from the help menu).
    window.addEventListener(RECENT_PROJECTS_CHANGED_EVENT, loadRecentProjects);
    return () => window.removeEventListener(RECENT_PROJECTS_CHANGED_EVENT, loadRecentProjects);
  }, [webMode, loadRecentProjects]);

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
  // The same machines by account machine key, the key the account's project
  // list names a copy's computer by.
  const webMachineByAccountKey = useMemo(
    () => new Map(webMachines.flatMap((machine) => (
      machine.accountMachine?.machineKey ? [[machine.accountMachine.machineKey, machine] as const] : []
    ))),
    [webMachines],
  );
  const webRecents = useMemo(() => webRecentProjects(webMachines), [webMachines]);
  // The computers as Home's list reads them on the web: by account machine
  // key (the account list's name for a computer), and by web machine row key
  // and browser environment id (a catalog row's and a connection's names).
  const { webComputers, webComputersByKey } = useMemo(() => {
    const byAccount = new Map<string, HomeWebComputer>();
    const byKey = new Map<string, HomeWebComputer>();
    for (const machine of webMachines) {
      const computer: HomeWebComputer = {
        key: machine.key,
        name: machine.name,
        live: machine.status === "live",
        reachable: machine.status === "live" || machine.status === "available" || machine.status === "connecting",
      };
      byKey.set(machine.key, computer);
      if (machine.environment?.envId) byKey.set(machine.environment.envId, computer);
      if (machine.accountMachine?.machineKey) byAccount.set(machine.accountMachine.machineKey, computer);
    }
    return { webComputers: byAccount, webComputersByKey: byKey };
  }, [webMachines]);
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

  // One source: the account's projects decide the rows and the count, on
  // every client; a project with no computer online opens as its repository
  // tab with no machine (0M). This computer's other folders follow.
  const { pendingForgetKeys, handleRemoveRow, handleShowAgain } = useHomeRowRemoval({ recentProjects, setRecentProjects, setRowError });
  const { list: homeList, openNoMachineTab } = useHomeAccountProjects({
    webMode,
    recentProjects,
    recentsLoaded,
    webRecents,
    webComputers,
    webComputersByKey,
    remoteSnapshot,
    pendingForgetKeys,
  });
  const accountProjectCount = homeList.accountCount ?? 0;
  const homeRows = useMemo(
    () => [...homeList.accountRows, ...homeList.localGroups.flatMap((group) => group.rows)],
    [homeList],
  );
  const visibleProjectGroups = useMemo(() => homeRows.map((row) => row.group), [homeRows]);

  // Selecting anything on the hosted client connects its machine first — a
  // machine the account can reach is never a dead end (bug-ledger C2d).
  const openWebProject = useCallback(
    (machineKey: string, projectId: string, rowKey: string, onUnreachable?: () => boolean) => {
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
          // An account row whose computer did not answer opens with no machine.
          if (onUnreachable?.()) return;
          setRowError(error instanceof Error ? error.message : String(error));
        } finally {
          setOpeningRowKey((current) => (current === rowKey ? null : current));
        }
      })();
    },
    [navigate, webMachineByKey, workspace],
  );

  // Lanes shared with this account: they need no computer of its own.
  const sharedRows = useLaneShareHomeRows();
  // Why the hosted client is showing no machines, in the account's own words.
  // Only computed when there is nothing to list — a populated list speaks for
  // itself even when the last directory read failed.
  const webZeroMachines = useMemo(() => (
    webMode && workspace && webMachines.length === 0
      ? webZeroMachinesNotice({
          account: workspace.account,
          directoryLoading: workspace.directoryLoading,
          retryError: directoryRetryError,
          accountProjectCount,
          sharedLaneCount: sharedRows.length,
          onGetAde: () => {
            void window.ade.app.openExternal(ADE_DOWNLOAD_PAGE_URL).catch(() => undefined);
          },
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
  ), [accountProjectCount, directoryRetryError, sharedRows.length, webMachines.length, webMode, workspace]);

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
        const targetId = rp.remote.targetId;
        if (targetId.startsWith(ACCOUNT_MACHINE_TARGET_PREFIX)) {
          // A row from the account list: its copy's computer by its account
          // machine key, or no copy at all. A computer this browser can
          // connect to opens the copy there; otherwise the repository opens
          // with no machine, as on the desktop.
          const machineKey = targetId.slice(ACCOUNT_MACHINE_TARGET_PREFIX.length);
          const machine = machineKey ? webMachineByAccountKey.get(machineKey) ?? null : null;
          if (machine) {
            openWebProject(machine.key, rp.remote.projectId, recentKey(rp), () => openNoMachineTab(rp));
            return;
          }
          if (!openNoMachineTab(rp)) setRowError("No computer with this project is online.");
          return;
        }
        // A computer that no longer answers opens the repository with no machine, as above.
        openWebProject(targetId, rp.remote.projectId, recentKey(rp), () => openNoMachineTab(rp));
        return;
      }
      if (rp.kind === "remote" && rp.remote) {
        const key = recentKey(rp);
        const targetId = rp.remote.targetId;
        const projectId = rp.remote.projectId;
        // A copy on a machine this computer has no connection to: the
        // repository opens with no machine, and that page connects the
        // computer and opens the copy (no pick).
        if (targetId.startsWith(ACCOUNT_MACHINE_TARGET_PREFIX)) {
          if (!openNoMachineTab(rp)) setRowError("No computer with this project is online.");
          return;
        }
        const state = connectionByTarget.get(targetId) ?? null;
        if (state === "connected") {
          void switchRemoteProject(targetId, projectId).catch((error) => {
            setRowError(error instanceof Error ? error.message : String(error));
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
            // The machine did not come online: the repository still opens, as
            // a tab with no machine that opens a copy when one is online.
            if (!openNoMachineTab(rp)) setRowError(error instanceof Error ? error.message : String(error));
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
      openNoMachineTab,
      openWebProject,
      project?.rootPath,
      switchProjectToPath,
      switchRemoteProject,
      webMachineByAccountKey,
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

  const handleDropFolder = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      if (isWebClientMode()) return;
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

  const [rowMenu, setRowMenu] = useState<(NonNullable<ContextMenuState> & { key: string }) | null>(null);
  const closeRowMenu = useCallback(() => setRowMenu(null), []);
  const [iconDialogTarget, setIconDialogTarget] = useState<ProjectIconDialogTarget | null>(null);
  const closeIconDialog = useCallback(() => setIconDialogTarget(null), []);
  const [cloneLocallyTarget, setCloneLocallyTarget] = useState<CloneLocallyTarget | null>(null);

  const rowMenuEntries = useMemo((): ContextMenuEntry[] => {
    if (!rowMenu) return [];
    const hiddenRow = homeList.hiddenRows.find((entry) => entry.key === rowMenu.key);
    const row = homeRows.find((entry) => entry.key === rowMenu.key) ?? hiddenRow;
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
        // Pinning is a recents action: a project this computer never opened has no pin.
        pinned: group.recentKeys.length > 0 ? Boolean(group.pinned) : null,
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
            label: row.kind === "account" ? "Remove…" : "Remove from this list",
            icon: Trash,
            danger: true,
            onSelect: () => handleRemoveRow(row),
          }
        : null,
      hiddenRow
        ? { kind: "item", key: "show-again", label: "Show on this list", icon: Eye, onSelect: () => handleShowAgain(hiddenRow) }
        : null,
    ];
    return entries.filter((entry): entry is ContextMenuEntry => entry != null);
  }, [connectionByTarget, handleOpen, handleRemoveRow, handleShowAgain, handleTogglePin, homeList.hiddenRows, homeRows, rowMenu, webMode]);

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

  const browserAvailable = !webMode && browserTabAvailable();
  const musicAvailable = !webMode && musicTabAvailable();
  const showSide = !webMode || webMachines.length > 0;



  // The page's own card look, when the user set one in edit mode. Scoped to
  // this page: the same tokens drive every other kit card in the app.
  const appearanceStyle = useMemo((): CSSProperties | undefined => {
    const style: Record<string, string> = {};
    if (homeAppearance.cardOpacity != null) {
      style["--kit-card-bg"] = `color-mix(in srgb, var(--color-bg) ${homeAppearance.cardOpacity}%, transparent)`;
    }
    if (homeAppearance.cardBlur != null) {
      style["--kit-card-blur"] = homeAppearance.cardBlur > 0 ? `blur(${homeAppearance.cardBlur}px) saturate(1.25)` : "none";
    }
    return Object.keys(style).length > 0 ? (style as CSSProperties) : undefined;
  }, [homeAppearance.cardBlur, homeAppearance.cardOpacity]);
  // Memoized, so the widget renderer (and the gallery's previews) stay stable between page renders.
  const projectsCard = useCallback((preview: boolean) => (
    <ProjectsCard
      preview={preview}
      rows={homeList.accountRows}
      hiddenRows={homeList.hiddenRows}
      localGroups={homeList.localGroups}
      // The account's count, hidden rows included; this computer's recents when there is no account list.
      count={homeList.accountCount ?? homeRows.length}
      webMode={webMode}
      listRef={listRef}
      onListKeyDown={handleListKeyDown}
      sharedRows={sharedRows}
      connectionByTarget={connectionByTarget}
      connectingKeys={connectingKeys}
      pendingForgetKeys={pendingForgetKeys}
      openingRowKey={openingRowKey}
      openRootPath={project?.rootPath ?? null}
      projectBinding={projectBinding}
      webMachineByKey={webMachineByKey}
      webMachineByAccountKey={webMachineByAccountKey}
      onOpen={handleOpen}
      onTogglePin={handleTogglePin}
      onRemove={handleRemoveRow}
      onShowAgain={handleShowAgain}
      onMerge={setMergeTarget}
      onRowMenu={setRowMenu}
    />
  ), [
    connectingKeys,
    connectionByTarget,
    handleRemoveRow,
    handleShowAgain,
    handleListKeyDown,
    handleOpen,
    handleTogglePin,
    openingRowKey,
    pendingForgetKeys,
    project?.rootPath,
    projectBinding,
    homeList,
    homeRows.length,
    sharedRows,
    webMachineByAccountKey,
    webMachineByKey,
    webMode,
  ]);


  const { homeData, headline, openHeadlineTarget, renderWidget } = useHomePageWiring({
    navigate,
    project,
    webMode,
    machineRows,
    remoteSnapshot,
    visibleProjectGroups,
    renderProjects: projectsCard,
  });

  const backgroundPageEntries = useMemo((): ContextMenuEntry[] => {
    const entries: ContextMenuEntry[] = [
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
    ];
    entries.push({
      kind: "item",
      key: "customize-home",
      label: "Customize home page",
      icon: SlidersHorizontal,
      onSelect: () => setEditingHome(true),
    });
    if (musicAvailable) {
      entries.push(
        { kind: "item", key: "apple-music", label: "Open Apple Music", icon: MusicNotes, onSelect: () => openMusicApp("appleMusic") },
        { kind: "item", key: "spotify", label: "Open Spotify", icon: MusicNotes, onSelect: () => openMusicApp("spotify") },
      );
    }
    if (browserAvailable) {
      entries.push({
        kind: "item",
        key: "browser",
        label: "Open the browser",
        icon: Globe,
        onSelect: () => navigate(BROWSER_TAB_ROUTE),
      });
    }
    return entries;
  }, [activeWebMachine, browserAvailable, musicAvailable, navigate, openWebChats, setEditingHome, webMode]);
  const backgroundMenu = useBackgroundContextMenu(backgroundPageEntries);

  return (
    <div
      ref={pageRef}
      className="ade-welcome"
      onDragEnter={(event) => {
        // Only a folder from outside; a widget being moved in edit mode is not one.
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        // The web client cannot turn a dropped folder into a path on the
        // connected machine, so it shows no drop target.
        if (isWebClientMode()) return;
        dragDepthRef.current += 1;
        setIsDragOver(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        // Accept the drop so its handler can cancel browser navigation. Web
        // mode leaves the folder untouched because it cannot resolve a host path.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDragOver(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        handleDropFolder(event);
      }}
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

      <HomeDataContext.Provider value={homeData}>
      <HomeRenderWidgetContext.Provider value={renderWidget}>
      <div
        className="ade-home"
        data-narrow={narrow ? "true" : undefined}
        data-editing={editingHome ? "true" : undefined}
        style={{
          ...(gridWidth ? { "--welcome-grid-max": `${gridWidth}px` } : {}),
          ...(packedGridWidth ? { "--welcome-hero-max": `${packedGridWidth}px` } : {}),
        } as CSSProperties}
      >
        <WelcomeHero
          headline={headline}
          onHeadline={openHeadlineTarget}
          machinesOnline={machinesOnline}
          machinesTotal={machineRows.length}
          actions={editingHome ? (
            <Suspense fallback={null}>
              <HomeEditTools onDone={() => setEditingHome(false)} />
            </Suspense>
          ) : (
            <>
              <HomeAction
                icon={Plus}
                primary
                label="Add project"
                tour="project.welcomeAddButton"
                onboardingAnchor="add-project"
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
              {/* The desktop's own browser and Apple Music, each a tab of its
                  own, as square app-icon buttons beside the text actions. */}
              {browserAvailable ? (
                <button
                  type="button"
                  className="ade-home-action ade-home-icon-action"
                  aria-label="Browser"
                  title="Browser"
                  onClick={() => navigate(BROWSER_TAB_ROUTE)}
                >
                  <Globe size={17} aria-hidden />
                </button>
              ) : null}
              {musicAvailable && !hiddenApps.includes("appleMusic") ? <HomeAppButton app="appleMusic" /> : null}
              {musicAvailable && !hiddenApps.includes("spotify") ? <HomeAppButton app="spotify" /> : null}
              {showSide ? (
                <button
                  type="button"
                  className="ade-home-action ade-home-customize"
                  data-onboarding-anchor="home-customize"
                  aria-label="Customize home page"
                  title="Customize home page"
                  onClick={() => setEditingHome(true)}
                >
                  <SlidersHorizontal size={15} aria-hidden />
                </button>
              ) : null}
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
        {recentListError ? (
          <Banner
            layout="inline"
            style={{ maxWidth: 520, width: "100%" }}
            model={{
              id: "welcome-recents-load-error",
              tone: "warning",
              title: "ADE couldn't read your recent projects",
              detail: recentListError,
              actions: [{ label: "Retry", onClick: loadRecentProjects }],
              dismiss: { onDismiss: () => setRecentListError(null) },
            }}
          />
        ) : null}
        {webZeroMachines ? <WebZeroMachines notice={webZeroMachines} /> : null}

        <HomeWidgetGrid
          single={!showSide}
          style={appearanceStyle}
          renderWidget={renderWidget}
        />
      </div>
      </HomeRenderWidgetContext.Provider>
      </HomeDataContext.Provider>

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
        onOpenProject={openProjectCopy}
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
