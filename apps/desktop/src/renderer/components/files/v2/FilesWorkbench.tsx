import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, Copy, FilePlus, FolderPlus, PencilSimple, Trash } from "@phosphor-icons/react";
import type { FileChangeEvent, FileContent, FilesWorkspace } from "../../../../shared/types";
import type { OpenProjectBinding } from "../../../../shared/types/core";
import { useAppStore, useRootAppStore } from "../../../state/appStore";
import type { CrossMachineLaneMarker } from "../../../state/crossMachineLanes";
import { createMonacoModelRegistry } from "../monacoModelRegistry";
import { resolveLanguageId } from "../filePresentation";
import { FilesExplorer, type FilesExplorerContextMenuEvent } from "../FilesExplorer";
import { clearDirtyBuffersForWorkspace, replaceDirtyBufferValuesForWorkspace } from "../../../lib/dirtyWorkspaceBuffers";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  defaultFilesWorkspaceId,
  filesProjectSessionKey,
  filesSessionKey,
  formatFilesError,
  hasAncestorDirectoryPath,
  hasLoadedDirectoryChildren,
  nearestLoadedAncestorDirectoryPath,
  parentPathForFileChange,
} from "../treeHelpers";
import {
  type EditorTab,
  activateTab,
  closeOtherTabs,
  closeTab,
  createInitialGroupsState,
  editorTabId,
  isExternalFilesWorkspaceId,
  isTabOpenInGroups,
  mergeLegacyLaneSessions,
  moveTabToGroup,
  openInGroup,
  pinTab,
  promoteFromPreview,
  splitGroup,
  splitTabToNewGroup,
  upgradeLegacySession,
  useEditorGroupsStore,
} from "./editorGroupsStore";
import { getFilesTabScope, toggleFilesTabScope, type FilesTabScope } from "./filesTabScope";
import {
  filesProjectCacheKey,
  readCachedWorkspaces,
  releaseFilesProjectCaches,
  writeCachedWorkspaces,
} from "./filesTreeCache";
import { resolveViewerKind } from "./viewerRegistry";
import { getCachedFileContent, invalidateFileContent, primeFileContent, sameFileContent } from "./useFileContent";
import { forgetRecentFilesUnder, getRecentFiles, isNestedFilePath, pruneMissingRootRecentFiles, recordRecentFile } from "./recentFiles";
import { EditorGroups } from "./EditorGroups";
import { StatusBar } from "./StatusBar";
import { WarmEmptyState } from "./WarmEmptyState";
import { WorkspacePicker } from "./WorkspacePicker";
import { CreatePromptModal } from "./overlays";
import { FilesSearchPanel } from "./FilesSearchPanel";
import { setPendingReveal } from "./pendingReveals";
import { pathAncestors, useFilesTree } from "./useFilesTree";
import { createPinnedFilesApi } from "./pinnedFilesApi";
import {
  clearPendingFilesOpenRequest,
  subscribeFilesOpenInTools,
  takePendingFilesOpenRequest,
  type FilesOpenRequest,
} from "./filesOpenRequests";
import { LaneMachineMarker } from "../../terminals/LaneMachineMarker";
import { COLORS } from "../../lanes/laneDesignTokens";
import { modifierKeyLabel, revealLabel } from "../../../lib/platform";
import type { EditorThemeMode } from "./viewers/types";
import { joinDisplayPath } from "./pathDisplay";

const MAX_QUEUED_TREE_PARENT_REFRESHES = 24;
// Open-request keys remembered for dedup. Far above any real burst; exists so a
// long-lived session cannot grow the set without bound.
const MAX_REMEMBERED_OPEN_REQUEST_KEYS = 64;
const WORKSPACE_LIST_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;
const FILES_REFRESH_DEBOUNCE_MS = 200;
// Ceiling for unscoped ("something changed") refreshes: they cost a workspace
// list + root listing + git status, and arrive as bursts.
const FULL_REFRESH_MIN_INTERVAL_MS = 5_000;


// Stable no-tabs fallback: a fresh object per render would give every derived
// memo (open tabs, watched workspace ids) a new identity each render, forcing
// the file-watcher effect to re-subscribe and drop its pending debounced
// refreshes. Reducers never mutate state, so sharing one instance is safe.
const EMPTY_GROUPS_STATE = createInitialGroupsState();

export type FilesNavigationOpenRequest = {
  /** Null when the request carries a `searchQuery` instead of a file. */
  path: string | null;
  laneId: string | null;
  nonce: string;
  line?: number;
  column?: number;
  /** Directories reveal in the tree; files open in an editor tab. */
  pathType?: "file" | "directory";
  /**
   * Machine that owns the file. Null means the machine this project tab is
   * bound to. Set when a chat on another machine reported the path: the file
   * only exists over there, so every files call this workbench makes has to be
   * addressed to that machine rather than rebinding the whole window.
   */
  pin?: OpenProjectBinding | null;
  /** Open the search panel with this query instead of a file (ambiguous name). */
  searchQuery?: string;
};

// Cross-mount caches survive remounts (the route unmounts FilesWorkbench when
// you switch tabs), so re-opening Files shows the workspace + tree instantly
// instead of flashing a loading/empty state while listWorkspaces / listTree
// refetch. They are bounded and pinned via filesTreeCache — see that module.

function recentScopeIdForWorkspace(workspace: FilesWorkspace | null | undefined, fallbackLaneId: string | null): string | null {
  if (!workspace) return fallbackLaneId;
  if (workspace.kind === "worktree") return workspace.laneId ?? workspace.id;
  if (workspace.kind === "primary") return workspace.laneId ?? fallbackLaneId;
  return workspace.id;
}

function mergeExternalWorkspaces(next: FilesWorkspace[], previous: FilesWorkspace[]): FilesWorkspace[] {
  const seen = new Set(next.map((workspace) => workspace.id));
  const preserved = previous.filter((workspace) => workspace.kind === "external" && !seen.has(workspace.id));
  return [...next, ...preserved];
}


function pathIsAtOrUnder(path: string, target: string): boolean {
  return path === target || path.startsWith(`${target}/`) || path.startsWith(`${target}\\`);
}

/**
 * Files workbench: the VS Code-like shell for the main Files route and the
 * embedded Work sidebar. Reuses the proven IPC + FilesExplorer + Monaco model
 * registry, the streaming/decoration backend, and the editor-groups store.
 */
export function FilesWorkbench({
  preferredLaneId,
  embedded,
  active = true,
  externalOpenPath,
  externalOpenNonce,
  externalOpenLine,
  navigationOpenRequest,
  pin: seedPin = null,
}: {
  preferredLaneId?: string | null;
  embedded?: boolean;
  active?: boolean;
  externalOpenPath?: string | null;
  externalOpenNonce?: string | null;
  externalOpenLine?: string | null;
  navigationOpenRequest?: FilesNavigationOpenRequest | null;
  /**
   * Machine this workbench should start on, for hosts that already know it —
   * the Work tools pane, whose chat may live on another machine. Navigation
   * requests still repin as before; this only supplies the starting machine.
   */
  pin?: OpenProjectBinding | null;
}) {
  const project = useAppStore((s) => s.project);
  const boundProjectRootPath = project?.rootPath ?? "";
  const boundProjectBinding = useAppStore((s) => s.projectBinding);
  /**
   * The machine this workbench is currently reading from, when that is NOT the
   * machine the project tab is bound to. Set by a navigation request that came
   * from a chat on another machine. The banner's "Back to this computer" is the
   * only exit: `selectWorkspace` does not clear it, and could not usefully —
   * while pinned, the picker is listing the pinned machine's workspaces.
   *
   * Everything downstream keys off `projectBinding`/`projectRootPath` below
   * rather than the bound pair, so the workspace roster, the tree caches, and
   * every file read/write follow the pin without the window rebinding — the
   * same per-call routing chats and PR reads already use.
   */
  const [machinePin, setMachinePin] = useState<OpenProjectBinding | null>(seedPin);
  // The Files API with this machine already bound to it. Identity changes only
  // when the machine does, so every callback and effect below can depend on it
  // honestly — see `pinnedFilesApi.ts` for why a ref could not.
  const files = useMemo(() => createPinnedFilesApi(machinePin), [machinePin]);
  const projectBinding = machinePin ?? boundProjectBinding;
  const projectRootPath = machinePin?.rootPath ?? boundProjectRootPath;
  const isRemoteProject = projectBinding?.kind === "remote";
  const projectCacheKey = filesProjectCacheKey(projectBinding, projectRootPath);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const lanes = useAppStore((s) => s.lanes);
  const globalLaneId = preferredLaneId ?? selectedLaneId ?? null;

  // Seed from the cross-mount cache so a repeat visit renders immediately.
  const cachedWorkspaces = readCachedWorkspaces(projectCacheKey);
  const initialWorkspaceId = defaultFilesWorkspaceId(cachedWorkspaces, globalLaneId);
  const [workspaces, setWorkspaces] = useState<FilesWorkspace[]>(cachedWorkspaces);
  const [workspacesLoaded, setWorkspacesLoaded] = useState<boolean>(cachedWorkspaces.length > 0);
  const [workspacesListedCacheKey, setWorkspacesListedCacheKey] = useState<string | null>(null);
  // Bumped by unscoped host change hints to re-list workspaces; throttled to
  // FULL_REFRESH_MIN_INTERVAL_MS by the watcher effect below.
  const [workspacesRefreshToken, setWorkspacesRefreshToken] = useState(0);
  const lastFullRefreshAtRef = useRef(0);
  const [workspaceId, setWorkspaceId] = useState<string>(initialWorkspaceId);
  const workspace = useMemo(() => workspaces.find((w) => w.id === workspaceId) ?? null, [workspaces, workspaceId]);
  const rootPath = workspace?.rootPath ?? projectRootPath;
  const canRevealInFinder = workspace != null && (workspace.kind === "external" || !isRemoteProject);
  const branch = workspace?.branchRef?.replace("refs/heads/", "") ?? null;
  const theme: EditorThemeMode = "dark";
  const sessionKey = filesProjectSessionKey(projectRootPath);
  const recentSessionKey = filesSessionKey(
    projectRootPath,
    recentScopeIdForWorkspace(workspace, globalLaneId),
  );
  const [tabScope, setTabScope] = useState<FilesTabScope>(() => getFilesTabScope(projectRootPath));

  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [dirtyTabIds, setDirtyTabIds] = useState<Set<string>>(new Set());
  const [dirtyBufferRevision, setDirtyBufferRevision] = useState(0);
  const [reloadTokensByTabId, setReloadTokensByTabId] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<
    | null
    | { kind: "search" }
    | { kind: "create"; create: "file" | "directory"; baseDir: string }
  >(null);

  // Held between the chat click and the panel being able to serve it: the
  // workspace roster may still be loading when the request arrives.
  const [pendingToolsOpen, setPendingToolsOpen] = useState<FilesOpenRequest | null>(null);
  const searchOverlayOpen = overlay?.kind === "search";
  const [draggingTab, setDraggingTab] = useState(false);
  const [treeMenu, setTreeMenu] = useState<FilesExplorerContextMenuEvent | null>(null);
  const [inlineRename, setInlineRename] = useState<{ path: string; nonce: number } | null>(null);
  const [pendingWorkspaceOpen, setPendingWorkspaceOpen] = useState<{
    workspaceId: string;
    path: string | null;
    pathType: "file" | "directory";
    nonce: string;
    line?: number;
    column?: number;
  } | null>(null);
  /**
   * Open-requests already served, by key.
   *
   * Two producers share this — the external-path query param and a router
   * navigation (which has both a file and a search form) — each namespacing its
   * own keys. The tools-pane channel dedups differently, by clearing its own
   * pending state.
   * A single last-key-wins slot could not hold them: an external open followed
   * by a navigation left the slot holding the navigation key, so the external
   * effect's next run no longer recognised its own key and re-opened the file.
   * Bounded so a long session cannot grow it without limit; requests are
   * consumed in order, so dropping the oldest can only ever forget something
   * already resolved.
   */
  const handledOpenKeysRef = useRef<Set<string>>(new Set());
  const markOpenRequestHandled = useCallback((key: string) => {
    const handled = handledOpenKeysRef.current;
    handled.add(key);
    if (handled.size > MAX_REMEMBERED_OPEN_REQUEST_KEYS) {
      const oldest = handled.values().next().value;
      if (typeof oldest === "string") handled.delete(oldest);
    }
  }, []);
  // The consuming effect below clears `pendingWorkspaceOpen`, but that clear is
  // a React state update while `openFile` can commit the editor-groups store
  // synchronously (cache hit). The store re-render is a higher-priority
  // (sync-lane) pass, so it can re-run this effect before the clear lands and
  // hand it the same request again. Identity is the durable "already handled"
  // record — every request is a fresh object.
  const consumedWorkspaceOpenRef = useRef<unknown>(null);
  const lastGlobalLaneIdRef = useRef(globalLaneId);
  const workspacesProjectRootRef = useRef(projectRootPath);
  const workspacesCacheKeyRef = useRef(projectCacheKey);
  const renameNonceRef = useRef(0);
  const registryRef = useRef(createMonacoModelRegistry());
  const dragRef = useRef<{ groupId: string; tabId: string } | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  const {
    tree,
    treeRef,
    expanded,
    setExpanded,
    loadingDirs,
    decorationsTruncated,
    refreshRoot,
    refreshLoadedDirectory,
    refreshTreeGitDecorations,
    loadDirectoryPath,
    loadMoreChildren,
    toggleDirectory,
  } = useFilesTree({
    active,
    files,
    workspaceId,
    workspaceIdRef,
    projectCacheKey,
    initialWorkspaceId,
    onError: setError,
  });
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;
  const dirtyTabIdsRef = useRef(dirtyTabIds);
  dirtyTabIdsRef.current = dirtyTabIds;

  const store = useEditorGroupsStore();
  const groupsState = store.sessions[sessionKey] ?? EMPTY_GROUPS_STATE;
  const applyGroups = useCallback(
    (reducer: Parameters<typeof store.apply>[1]) => store.apply(sessionKey, reducer),
    [store, sessionKey],
  );
  const upsertWorkspace = useCallback(
    (nextWorkspace: FilesWorkspace) => {
      setWorkspaces((prev) => {
        const next = [
          ...prev.filter((candidate) => candidate.id !== nextWorkspace.id),
          nextWorkspace,
        ];
        writeCachedWorkspaces(projectCacheKey, next);
        return next;
      });
    },
    [projectCacheKey],
  );

  const activeGroup = groupsState.groups[groupsState.activeGroupId];
  const activeTab = activeGroup?.tabs.find((t) => t.id === activeGroup.activeTabId) ?? null;
  const allOpenTabs = useMemo(
    () => Object.values(groupsState.groups).flatMap((g) => g.tabs),
    [groupsState.groups],
  );
  const openCount = allOpenTabs.length;
  const openWorkspaceIds = useMemo(() => new Set(allOpenTabs.map((t) => t.workspaceId)), [allOpenTabs]);
  const resolveTabContext = useCallback(
    (tab: EditorTab) => {
      const ws = workspaces.find((candidate) => candidate.id === tab.workspaceId);
      const wsRoot = ws?.rootPath ?? projectRootPath;
      return {
        workspaceId: tab.workspaceId,
        rootPath: wsRoot,
        laneId: tab.laneId,
        canRevealInFinder: ws != null && (ws.kind === "external" || !isRemoteProject),
      };
    },
    [isRemoteProject, projectRootPath, workspaces],
  );

  const migratedSessionsRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectRootPath || workspaces.length === 0 || workspacesListedCacheKey !== projectCacheKey) return;
    if (migratedSessionsRef.current === projectRootPath) return;
    migratedSessionsRef.current = projectRootPath;
    const projectKey = filesProjectSessionKey(projectRootPath);
    const existing = store.getSession(projectKey);
    const hasProjectTabs = existing && Object.values(existing.groups).some((g) => g.tabs.length > 0);
    if (hasProjectTabs) return;

    const legacySessions: ReturnType<typeof createInitialGroupsState>[] = [];
    for (const ws of workspaces) {
      if (ws.kind === "external") continue;
      const laneKey = filesSessionKey(projectRootPath, ws.laneId);
      const legacy = store.getSession(laneKey);
      if (legacy && Object.values(legacy.groups).some((g) => g.tabs.length > 0)) {
        legacySessions.push(upgradeLegacySession(legacy, ws.id, ws.laneId));
      }
    }
    if (legacySessions.length > 0) {
      store.apply(projectKey, () => mergeLegacyLaneSessions(legacySessions));
    }
  }, [projectCacheKey, projectRootPath, store, workspaces, workspacesListedCacheKey]);

  useEffect(() => {
    if (!projectRootPath || workspaces.length === 0 || workspacesListedCacheKey !== projectCacheKey) return;
    const hostWorkspaces = workspaces.filter((candidate) => candidate.kind !== "external");
    const workspaceIds = new Set(workspaces.map((candidate) => candidate.id));
    const primaryWorkspace = hostWorkspaces.find((candidate) => candidate.kind === "primary");
    const fallbackWorkspace = primaryWorkspace ?? hostWorkspaces[0];
    if (!fallbackWorkspace) return;

    const tabIdChanges = store.remapTabWorkspaces(sessionKey, (tab) => {
      if (workspaceIds.has(tab.workspaceId) || isExternalFilesWorkspaceId(tab.workspaceId)) {
        return tab.workspaceId;
      }
      const laneWorkspace = tab.laneId
        ? hostWorkspaces.find((candidate) => candidate.laneId === tab.laneId)
        : null;
      return (laneWorkspace ?? fallbackWorkspace).id;
    });
    if (tabIdChanges.size === 0) return;

    // Move live Monaco models to their remapped tab ids so unsaved buffers,
    // undo stacks, and dirty baselines survive the workspace-identity change.
    for (const [oldTabId, newTabId] of tabIdChanges) {
      registryRef.current.rekey(oldTabId, newTabId);
    }

    setDirtyTabIds((prev) => {
      const next = new Set<string>();
      for (const tabId of prev) next.add(tabIdChanges.get(tabId) ?? tabId);
      return next;
    });
    setReloadTokensByTabId((prev) => {
      const next: Record<string, number> = {};
      for (const [tabId, token] of Object.entries(prev)) {
        const nextTabId = tabIdChanges.get(tabId) ?? tabId;
        next[nextTabId] = Math.max(next[nextTabId] ?? 0, token);
      }
      return next;
    });
    setDirtyBufferRevision((revision) => revision + 1);
  }, [projectCacheKey, projectRootPath, sessionKey, store, workspaces, workspacesListedCacheKey]);

  const allOpenTabsRef = useRef(allOpenTabs);
  allOpenTabsRef.current = allOpenTabs;

  useEffect(() => {
    if (tabScope !== "lane") return;
    const explorerLane = workspace?.laneId ?? null;
    const inCurrentScope = (tab: EditorTab): boolean =>
      explorerLane != null ? tab.laneId === explorerLane : tab.workspaceId === workspaceId;
    for (const groupId of groupsState.groupOrder) {
      const group = groupsState.groups[groupId];
      if (!group?.activeTabId) continue;
      const active = group.tabs.find((tab) => tab.id === group.activeTabId);
      if (!active || inCurrentScope(active)) continue;
      const fallback = group.tabs.find(inCurrentScope);
      if (fallback) {
        applyGroups((s) => activateTab(s, groupId, fallback.id));
      }
    }
  }, [applyGroups, groupsState.groupOrder, groupsState.groups, tabScope, workspace?.laneId, workspaceId]);

  useEffect(() => {
    setTabScope(getFilesTabScope(projectRootPath));
  }, [projectRootPath]);

  const knownRootPaths = useMemo(() => new Set(tree.map((node) => node.path)), [tree]);
  const recentFiles = getRecentFiles(recentSessionKey);
  const visibleRecentFiles = useMemo(
    () => (
      tree.length > 0
        ? recentFiles.filter((path) => isNestedFilePath(path) || knownRootPaths.has(path))
        : recentFiles
    ),
    [knownRootPaths, recentFiles, tree.length],
  );

  useEffect(() => {
    if (tree.length === 0) return;
    pruneMissingRootRecentFiles(recentSessionKey, knownRootPaths);
  }, [knownRootPaths, recentSessionKey, tree.length]);

  const dirtyTabsUnder = useCallback(
    (wsId: string, target: string): string[] =>
      [...dirtyTabIds].filter((tabId) => {
        const candidate = allOpenTabs.find((entry) => entry.id === tabId);
        return candidate?.workspaceId === wsId && pathIsAtOrUnder(candidate.path, target);
      }),
    [allOpenTabs, dirtyTabIds],
  );

  const confirmDiscardDirtyTabIds = useCallback((tabIds: readonly string[], action: string): boolean => {
    if (tabIds.length === 0) return true;
    const labels = tabIds.map((tabId) => allOpenTabs.find((tab) => tab.id === tabId)?.path ?? tabId);
    const label = labels.length === 1 ? `"${labels[0]}" has` : `${labels.length} files have`;
    return window.confirm(`${label} unsaved changes. ${action} anyway?`);
  }, [allOpenTabs]);

  const pruneClosedTabState = useCallback((shouldPrune: (tabId: string) => boolean) => {
    setDirtyTabIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const tabId of prev) {
        if (shouldPrune(tabId)) {
          changed = true;
        } else {
          next.add(tabId);
        }
      }
      return changed ? next : prev;
    });
    setReloadTokensByTabId((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [tabId, token] of Object.entries(prev)) {
        if (shouldPrune(tabId)) {
          changed = true;
        } else {
          next[tabId] = token;
        }
      }
      return changed ? next : prev;
    });
    setDirtyBufferRevision((revision) => revision + 1);
  }, []);

  const selectWorkspace = useCallback(
    (nextWorkspaceId: string) => {
      if (!nextWorkspaceId || nextWorkspaceId === workspaceId) return;
      setWorkspaceId(nextWorkspaceId);
    },
    [workspaceId],
  );

  /**
   * Leave the pinned machine and go back to the one this tab is bound to.
   * Offered wherever the machine chip is, because a pin is entered by clicking
   * a file in a chat — the user never asked to be on another machine's disk and
   * needs one obvious way back.
   */
  const clearMachinePin = useCallback(() => {
    setMachinePin(null);
    setError(null);
  }, []);

  /**
   * Release the roster/tree caches this workbench wrote under a pinned key.
   *
   * `App.tsx` releases Files caches for a project surface using the key derived
   * from that surface's OWN binding, so it cannot see a key produced by a pin
   * chosen in here. Without this, every distinct machine ever pinned leaves an
   * entry behind for the life of the process.
   */
  useEffect(() => {
    if (!machinePin) return undefined;
    const pinnedCacheKey = filesProjectCacheKey(machinePin, machinePin.rootPath);
    return () => {
      // Deferred as ordering insurance. `useFilesTree` is called above this
      // effect, so its `unpinCachedTree` cleanup already runs first and a
      // synchronous release would work today — but that is a fact about where
      // one hook call sits, and releasing a still-pinned key silently skips it
      // (`filesTreeCache` refuses pinned entries). A microtask lands after
      // every cleanup in the commit and cannot be broken by a reorder.
      queueMicrotask(() => releaseFilesProjectCaches(pinnedCacheKey));
    };
  }, [machinePin]);

  // Liveness for the pinned machine, read from the same cross-machine slices
  // the Work sidebar uses. A machine that has gone away keeps its chip and says
  // so; nothing else in here can explain why the tree stopped answering.
  const pinnedMachineOnline = useRootAppStore((state) => {
    if (!machinePin || machinePin.kind !== "remote") return true;
    return state.crossMachineLanesByMachineId[machinePin.targetId]?.online ?? true;
  });
  const pinnedMachineMarker = useMemo<CrossMachineLaneMarker | null>(() => {
    if (!machinePin) return null;
    const machineName = machinePin.kind === "remote" ? machinePin.runtimeName : machinePin.displayName;
    return {
      machineId: machinePin.kind === "remote" ? machinePin.targetId : "local",
      machineName,
      online: pinnedMachineOnline,
      mode: "name",
      title: machineName,
      sameBranchElsewhere: false,
    };
  }, [machinePin, pinnedMachineOnline]);

  useEffect(() => {
    if (!active || dirtyTabIds.size === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active, dirtyTabIds.size]);

  useEffect(() => {
    // The dirty-buffer map is keyed by ABSOLUTE PATH with no machine in the key,
    // and the main process reads it to serve agent file reads on THIS machine.
    // While pinned, these buffers belong to another machine's disk — and one
    // user's laptop and desktop routinely check the same repo out at the same
    // absolute path, so publishing them would hand a local agent the remote
    // machine's unsaved text and let it write that back. Nothing is published
    // while a pin is active; the tabs stay editable and save over the wire as
    // normal.
    if (machinePin) return;
    // Clearing the pin does not clear the roster in the same commit: `workspaces`
    // still describes the machine we just left, so `resolveTabContext` would
    // resolve a remote root — and when both machines check the repo out at the
    // same absolute path, that root IS the local one. Wait until the roster has
    // been re-listed for the machine this tab is actually bound to.
    if (workspacesListedCacheKey !== projectCacheKey) return;
    const dirtyByWorkspace = new Map<string, Array<{ path: string; content: string }>>();
    for (const tabId of dirtyTabIds) {
      const tab = allOpenTabs.find((candidate) => candidate.id === tabId);
      if (!tab) continue;
      const content = registryRef.current.getValue(tabId);
      if (content == null) continue;
      const ctx = resolveTabContext(tab);
      const list = dirtyByWorkspace.get(ctx.rootPath) ?? [];
      list.push({ path: tab.path, content });
      dirtyByWorkspace.set(ctx.rootPath, list);
    }
    for (const [wsRoot, buffers] of dirtyByWorkspace) {
      replaceDirtyBufferValuesForWorkspace(wsRoot, buffers);
    }
    return () => {
      for (const wsRoot of dirtyByWorkspace.keys()) {
        clearDirtyBuffersForWorkspace(wsRoot);
      }
    };
  }, [allOpenTabs, dirtyBufferRevision, dirtyTabIds, machinePin, projectCacheKey, resolveTabContext, workspacesListedCacheKey]);

  /* ---- Workspace resolution ---- */
  useEffect(() => {
    if (!active) return;
    // An offline pinned machine cannot answer, and retrying only replaces the
    // honest "it's offline" chip with a generic timeout error. Stop there.
    if (machinePin && !pinnedMachineOnline) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryIndex = 0;
    const projectChanged = workspacesProjectRootRef.current !== projectRootPath;
    const cacheKeyChanged = workspacesCacheKeyRef.current !== projectCacheKey;
    workspacesProjectRootRef.current = projectRootPath;
    workspacesCacheKeyRef.current = projectCacheKey;
    if (cacheKeyChanged) {
      const cachedForProject = readCachedWorkspaces(projectCacheKey).filter((workspace) => workspace.kind !== "external");
      setWorkspaces((prev) => (
        projectChanged ? cachedForProject : mergeExternalWorkspaces(cachedForProject, prev)
      ));
      setWorkspacesLoaded(cachedForProject.length > 0);
      setWorkspacesListedCacheKey(null);
    }

    const listWorkspaces = async (): Promise<void> => {
      try {
        const ws = await files.listWorkspaces();
        if (cancelled) return;
        setWorkspaces((prev) => {
          const merged = projectChanged ? ws : mergeExternalWorkspaces(ws, prev);
          writeCachedWorkspaces(projectCacheKey, merged);
          return merged;
        });
        setWorkspacesLoaded(true);
        setWorkspacesListedCacheKey(projectCacheKey);
      } catch {
        if (cancelled) return;
        setWorkspacesLoaded(true);
        const delay = WORKSPACE_LIST_RETRY_DELAYS_MS[
          Math.min(retryIndex, WORKSPACE_LIST_RETRY_DELAYS_MS.length - 1)
        ];
        retryIndex += 1;
        retryTimer = setTimeout(() => void listWorkspaces(), delay);
      }
    };

    void listWorkspaces();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [active, files, machinePin, pinnedMachineOnline, projectCacheKey, projectRootPath, workspacesRefreshToken]);

  // Resolve the explorer workspace from the global lane on mount + lane changes.
  useEffect(() => {
    if (!workspaces.length) return;
    const laneChanged = lastGlobalLaneIdRef.current !== globalLaneId;
    lastGlobalLaneIdRef.current = globalLaneId;
    const current = workspaceIdRef.current;
    if (!laneChanged && current && workspaces.some((candidate) => candidate.id === current)) return;
    const next = defaultFilesWorkspaceId(workspaces, globalLaneId) || current;
    if (next && next !== current) {
      setWorkspaceId(next);
    }
  }, [workspaces, globalLaneId]);

  /* ---- Editor model lifetime ---- */

  // Monaco models outlive individual tabs; drop them all when this workbench
  // goes away. Editor lifetime, deliberately not part of the tree hook.
  useEffect(() => {
    if (!active) return;
    const registry = registryRef.current;
    return () => {
      registry.disposeAll();
    };
  }, [active]);

  /* ---- File watching: refresh the tree on disk changes (debounced) ---- */
  useEffect(() => {
    if (!active || !workspaceId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const queuedParentPaths = new Set<string>();
    let rootRefreshQueued = false;
    let fullRootRefreshQueued = false;
    let decorationsRefreshQueued = false;
    let fullRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleFlush = (delayMs = FILES_REFRESH_DEBOUNCE_MS) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => flushQueuedRefreshes(), delayMs);
    };

    /**
     * Handle a path-less change hint: the host says something under this
     * workspace moved but not what. Re-list the workspaces and the root level
     * (which also re-reads decorations) at most once per
     * FULL_REFRESH_MIN_INTERVAL_MS — the hints arrive in bursts, and without a
     * floor each one would cost a full listing plus a git-status sweep.
     */
    const queueFullRefresh = () => {
      if (fullRefreshTimer) return;
      const sinceLastFullRefresh = Date.now() - lastFullRefreshAtRef.current;
      const delayMs = Math.max(FILES_REFRESH_DEBOUNCE_MS, FULL_REFRESH_MIN_INTERVAL_MS - sinceLastFullRefresh);
      fullRefreshTimer = setTimeout(() => {
        fullRefreshTimer = null;
        lastFullRefreshAtRef.current = Date.now();
        if (!workspaceIdRef.current) return;
        setWorkspacesRefreshToken((token) => token + 1);
        void refreshRoot();
      }, delayMs);
    };

    const enqueuePathRefresh = (path: string | undefined) => {
      // `undefined` means the event had no such path (no `oldPath` on a
      // non-rename). An empty string is different: it names the workspace root,
      // and dropping it silently left a root-level change unrefreshed.
      if (path === undefined) return;
      decorationsRefreshQueued = true;
      if (!path) {
        rootRefreshQueued = true;
        return;
      }
      if (fullRootRefreshQueued) return;
      const parentPath = parentPathForFileChange(path);
      if (!parentPath) {
        rootRefreshQueued = true;
        return;
      }
      const refreshPath = hasLoadedDirectoryChildren(treeRef.current, parentPath)
        ? parentPath
        : nearestLoadedAncestorDirectoryPath(treeRef.current, parentPath);
      if (!refreshPath) {
        rootRefreshQueued = true;
        return;
      }
      queuedParentPaths.add(refreshPath);
      if (queuedParentPaths.size > MAX_QUEUED_TREE_PARENT_REFRESHES) {
        fullRootRefreshQueued = true;
        queuedParentPaths.clear();
      }
    };

    const flushQueuedRefreshes = () => {
      const reqId = workspaceIdRef.current;
      const parentPaths = [...queuedParentPaths];
      queuedParentPaths.clear();
      const shouldRefreshRoot = rootRefreshQueued;
      const shouldRefreshFullRoot = fullRootRefreshQueued;
      const shouldRefreshDecorations = decorationsRefreshQueued;
      rootRefreshQueued = false;
      fullRootRefreshQueued = false;
      decorationsRefreshQueued = false;

      if (!reqId) return;
      if (shouldRefreshFullRoot) {
        setExpanded(new Set());
        void refreshRoot({ preserveLoadedChildren: false });
        return;
      }
      if (shouldRefreshRoot) {
        void refreshRoot();
      }
      if (parentPaths.length > 0) {
        const directoryRefreshes = parentPaths.map((parentPath) => (
          refreshLoadedDirectory(parentPath, reqId, {
            suppressMissingError: shouldRefreshRoot || hasAncestorDirectoryPath(parentPath, parentPaths),
          })
        ));
        void Promise.allSettled(directoryRefreshes)
          .then(() => refreshTreeGitDecorations(reqId))
          .catch((err) => {
            if (workspaceIdRef.current === reqId) setError(formatFilesError(err));
          });
      } else if (shouldRefreshDecorations && !shouldRefreshRoot) {
        void refreshTreeGitDecorations(reqId).catch((err) => {
          if (workspaceIdRef.current === reqId) setError(formatFilesError(err));
        });
      }
    };

    const unsub = window.ade.files.onChange((event) => {
      const ev = event as FileChangeEvent;
      // `*` is the web adapter's stand-in when it has not learned any workspace
      // id yet; it still means "this project's files moved".
      const isExplorerWorkspace = ev.workspaceId === workspaceIdRef.current || ev.workspaceId === "*";
      if (!ev.path && !ev.oldPath) {
        if (isExplorerWorkspace) queueFullRefresh();
        return;
      }
      // Our own save echoes back as `modified`. The editor already holds those
      // bytes (and primed the content cache with them), so reloading the tab
      // would re-read what we just wrote.
      const isSelfSave = ev.origin === "self" && ev.type === "modified";
      if (!isSelfSave) {
        const openTab = allOpenTabsRef.current.find((tab) => tab.workspaceId === ev.workspaceId && tab.path === ev.path);
        const openTabOld = ev.oldPath
          ? allOpenTabsRef.current.find((tab) => tab.workspaceId === ev.workspaceId && tab.path === ev.oldPath)
          : undefined;
        invalidateFileContent(ev.workspaceId, ev.path);
        if (ev.oldPath) invalidateFileContent(ev.workspaceId, ev.oldPath);
        if (openTab && !dirtyTabIdsRef.current.has(openTab.id)) {
          setReloadTokensByTabId((prev) => ({ ...prev, [openTab.id]: (prev[openTab.id] ?? 0) + 1 }));
        }
        if (openTabOld && !dirtyTabIdsRef.current.has(openTabOld.id)) {
          setReloadTokensByTabId((prev) => ({ ...prev, [openTabOld.id]: (prev[openTabOld.id] ?? 0) + 1 }));
        }
      }
      if (!isExplorerWorkspace) return;
      if (ev.type === "modified") {
        // Content-only: the listing is unchanged, only the git decorations are.
        decorationsRefreshQueued = true;
      } else {
        enqueuePathRefresh(ev.path);
        enqueuePathRefresh(ev.oldPath);
      }
      scheduleFlush();
    });
    const watchedIds = new Set([workspaceId, ...openWorkspaceIds]);
    for (const watchedId of watchedIds) {
      void files.watchChanges({ workspaceId: watchedId, includeIgnored: true }).catch(() => {});
    }
    return () => {
      if (timer) clearTimeout(timer);
      if (fullRefreshTimer) clearTimeout(fullRefreshTimer);
      unsub();
      for (const watchedId of watchedIds) {
        void files.stopWatching({ workspaceId: watchedId, includeIgnored: true }).catch(() => {});
      }
    };
  }, [active, files, openWorkspaceIds, refreshLoadedDirectory, refreshRoot, refreshTreeGitDecorations, setExpanded, treeRef, workspaceId]);

  /* ---- Open file ---- */
  const revalidateOpenedFile = useCallback(
    async (revalidateWorkspaceId: string, path: string, painted: FileContent) => {
      // Never discard unsaved edits, and never overwrite the cached payload
      // behind them — this runs before the read so a dirty tab costs nothing.
      const tabId = editorTabId(revalidateWorkspaceId, path);
      if (dirtyTabIdsRef.current.has(tabId)) return;
      let fresh: FileContent;
      try {
        fresh = await files.readFile({ workspaceId: revalidateWorkspaceId, path });
      } catch {
        // No answer is not an answer: keep the cached bytes rather than priming
        // the cache with a failure. The next explicit read surfaces the error.
        return;
      }
      if (sameFileContent(painted, fresh)) return;
      primeFileContent(revalidateWorkspaceId, path, fresh);
      if (dirtyTabIdsRef.current.has(tabId)) return; // Dirtied while we waited.
      setReloadTokensByTabId((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
    },
    [files],
  );

  const openFile = useCallback(
    async (path: string, opts: { preview?: boolean; line?: number; column?: number } = {}) => {
      if (!workspaceId) return;
      setSelectedNodePath(path);
      if (opts.line && opts.line > 0) {
        setPendingReveal(path, { line: opts.line, column: opts.column });
      }
      try {
        // The viewer reads the same LRU through useFileContent, so a cached
        // payload makes opening a recently visited file a zero round-trip
        // action instead of re-reading bytes we already hold.
        const cached = getCachedFileContent(workspaceId, path);
        const content = cached ?? await files.readFile({ workspaceId, path });
        if (workspaceIdRef.current !== workspaceId) return;
        primeFileContent(workspaceId, path, content);
        // Painting from the LRU costs zero round trips, but nothing invalidates
        // it on the web client (no host watcher over the relay) and the desktop
        // watcher only runs while the tab is active. Re-read in the background
        // and reload the tab if the bytes moved under us.
        if (cached) void revalidateOpenedFile(workspaceId, path, cached);
        const viewerKind = resolveViewerKind({
          path,
          previewKind: content.previewKind,
          mimeType: content.mimeType,
          isBinary: content.isBinary,
          isPartial: content.isPartial,
        });
        const tab: EditorTab = {
          id: editorTabId(workspaceId, path),
          workspaceId,
          laneId: workspace?.laneId ?? null,
          path,
          title: path.split("/").pop() ?? path,
          viewerKind,
          languageId: resolveLanguageId(path, content.languageId),
          preview: opts.preview ?? true,
          pinned: false,
        };
        applyGroups((s) => openInGroup(s, s.activeGroupId, tab, { preview: opts.preview ?? true }));
        recordRecentFile(recentSessionKey, path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [files, workspace, workspaceId, applyGroups, recentSessionKey, revalidateOpenedFile],
  );

  const handleActivateTab = useCallback(
    (groupId: string, tabId: string) => {
      const tab = allOpenTabs.find((candidate) => candidate.id === tabId);
      applyGroups((s) => activateTab(s, groupId, tabId));
      if (tab && tab.workspaceId !== workspaceIdRef.current) {
        setWorkspaceId(tab.workspaceId);
        setSelectedNodePath(tab.path);
      }
    },
    [allOpenTabs, applyGroups],
  );

  const openExternalPathRequest = useCallback(
    async (absolutePath: string, nonce: string, line?: number) => {
      try {
        const result = await window.ade.files.openExternalPath({ path: absolutePath });
        if (result.workspace.kind === "external") {
          upsertWorkspace(result.workspace);
        }
        setWorkspaceId(result.workspace.id);
        setPendingWorkspaceOpen({
          workspaceId: result.workspace.id,
          path: result.openPath,
          pathType: result.pathType,
          nonce,
          line,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [upsertWorkspace],
  );

  useEffect(() => {
    if (!active || !externalOpenPath) return;
    const key = `external:${externalOpenNonce ?? ""}:${externalOpenPath}:${externalOpenLine ?? ""}`;
    if (handledOpenKeysRef.current.has(key)) return;
    markOpenRequestHandled(key);
    const line = externalOpenLine && /^\d+$/.test(externalOpenLine)
      ? Number(externalOpenLine)
      : undefined;
    void openExternalPathRequest(externalOpenPath, key, line);
  }, [active, externalOpenPath, externalOpenLine, externalOpenNonce, markOpenRequestHandled, openExternalPathRequest]);

  /**
   * Which workspace serves an open request, or why it cannot be answered yet.
   *
   * The router path, the tools-pane channel and the ambiguous-search path all
   * asked this same question with their own copy of the logic — including their
   * own copy of the "the cached roster may predate a just-created lane, wait for
   * the authoritative list" rule. Three copies of a rule is three chances for
   * them to disagree about what a missing lane means.
   */
  const resolveOpenTargetWorkspace = useCallback((
    laneId: string | null,
    options?: { allowFallback?: boolean },
  ): { kind: "ready"; workspace: FilesWorkspace } | { kind: "wait" } | { kind: "unknown" } => {
    if (laneId) {
      const owned = workspaces.find((candidate) => candidate.laneId === laneId);
      if (owned) return { kind: "ready", workspace: owned };
      return workspacesListedCacheKey === projectCacheKey ? { kind: "unknown" } : { kind: "wait" };
    }
    if (options?.allowFallback === false) return { kind: "unknown" };
    const fallback = workspace
      ?? workspaces.find((candidate) => candidate.id === defaultFilesWorkspaceId(workspaces, globalLaneId))
      ?? workspaces[0];
    if (fallback) return { kind: "ready", workspace: fallback };
    return workspacesListedCacheKey === projectCacheKey ? { kind: "unknown" } : { kind: "wait" };
  }, [globalLaneId, projectCacheKey, workspace, workspaces, workspacesListedCacheKey]);

  // A request that names another machine has to switch this workbench over
  // BEFORE the workspace lookup below runs — the roster it is searching for the
  // lane in is that machine's, not this one's. Kept as its own effect so the
  // pin lands in one render and the open resolves against the right roster on
  // the next, rather than racing inside a single pass.
  // A host-supplied pin (the Work tools pane following its chat's machine)
  // wins whenever it changes. Identity is compared by key so an equal binding
  // rebuilt each render does not thrash the roster.
  const seedPinKey = seedPin?.key ?? null;
  useEffect(() => {
    setMachinePin((current) => (current?.key === seedPinKey ? current : seedPin ?? null));
    // Only the machine identity should retrigger this, not a new object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedPinKey]);

  useEffect(() => {
    if (!active || !navigationOpenRequest) return;
    const requestedPin = navigationOpenRequest.pin ?? null;
    setMachinePin((current) => (current?.key === requestedPin?.key ? current : requestedPin));
  }, [active, navigationOpenRequest]);

  useEffect(() => {
    if (!active || !navigationOpenRequest?.searchQuery || !workspacesLoaded) return;
    const key = `navigation-search:${navigationOpenRequest.nonce}:${navigationOpenRequest.searchQuery}`;
    if (handledOpenKeysRef.current.has(key)) return;
    // The search runs against ONE workspace, so it has to be the lane the click
    // came from. Without this the query ran against whichever lane the Files tab
    // happened to be showing and found nothing.
    const resolved = resolveOpenTargetWorkspace(navigationOpenRequest.laneId, { allowFallback: false });
    if (resolved.kind === "wait") return;
    markOpenRequestHandled(key);
    if (resolved.kind === "ready") setWorkspaceId(resolved.workspace.id);
    // Several files share the clicked name. Opening one at random would be
    // worse than asking: the user picks from the same search they would have
    // typed themselves.
    setSearchQuery(navigationOpenRequest.searchQuery);
    setOverlay({ kind: "search" });
  }, [active, markOpenRequestHandled, navigationOpenRequest, resolveOpenTargetWorkspace, workspacesLoaded]);

  useEffect(() => {
    if (!active || !navigationOpenRequest?.path || navigationOpenRequest.searchQuery || !workspacesLoaded) return;
    // Still on the previous machine's roster; the pin effect above re-runs this
    // once the switch has landed.
    if ((navigationOpenRequest.pin?.key ?? null) !== (machinePin?.key ?? null)) return;
    const key = `navigation:${navigationOpenRequest.nonce}:${navigationOpenRequest.laneId ?? ""}:${navigationOpenRequest.path}:${navigationOpenRequest.line ?? ""}:${navigationOpenRequest.column ?? ""}`;
    if (handledOpenKeysRef.current.has(key)) return;

    const resolved = resolveOpenTargetWorkspace(navigationOpenRequest.laneId);
    if (resolved.kind === "wait") return;
    if (resolved.kind === "unknown") {
      markOpenRequestHandled(key);
      setError(
        navigationOpenRequest.laneId
          ? "The file's lane workspace is no longer available."
          : "The file's workspace is no longer available.",
      );
      return;
    }
    const targetWorkspace = resolved.workspace;

    markOpenRequestHandled(key);
    setWorkspaceId(targetWorkspace.id);
    setPendingWorkspaceOpen({
      workspaceId: targetWorkspace.id,
      path: navigationOpenRequest.path,
      // A folder reveals in the tree. Opening one as a file only ever produced
      // a read error, which is what clicking a directory name in chat did.
      pathType: navigationOpenRequest.pathType ?? "file",
      nonce: key,
      line: navigationOpenRequest.line,
      column: navigationOpenRequest.column,
    });
  }, [
    active,
    machinePin,
    markOpenRequestHandled,
    navigationOpenRequest,
    resolveOpenTargetWorkspace,
    workspacesLoaded,
  ]);

  // The tools-pane panel is the destination for a filename clicked in a chat on
  // this machine, in this chat's own lane — the common case, and the one where
  // being thrown into the Files tab loses the conversation. Only the embedded
  // mount listens; the routed Files tab is reached by navigation instead.
  useEffect(() => {
    if (!embedded) return undefined;
    const apply = (request: FilesOpenRequest) => {
      // This mount owns the request now; drop the channel's hold so a later
      // mount cannot drain it again and re-open the file unprompted.
      clearPendingFilesOpenRequest();
      setPendingToolsOpen(request);
    };
    const queued = takePendingFilesOpenRequest();
    if (queued) apply(queued);
    return subscribeFilesOpenInTools(apply);
  }, [embedded]);

  useEffect(() => {
    if (!embedded || !pendingToolsOpen || !workspacesLoaded) return;
    const request = pendingToolsOpen;
    const resolved = resolveOpenTargetWorkspace(request.laneId);
    if (resolved.kind === "wait") return;
    if (resolved.kind === "unknown") {
      // Every mounted project surface hears this channel, and only one of them
      // owns the lane. Planting an error banner in the others turned one click
      // into a complaint on every other open project. The chat opener has
      // already resolved the lane against the live roster before asking, so a
      // miss here means "not my project", not "gone".
      setPendingToolsOpen(null);
      return;
    }
    const targetWorkspace = resolved.workspace;
    setPendingToolsOpen(null);
    setWorkspaceId(targetWorkspace.id);
    setPendingWorkspaceOpen({
      workspaceId: targetWorkspace.id,
      path: request.path,
      pathType: request.pathType,
      nonce: `tools:${request.nonce}`,
      line: request.line,
      column: request.column,
    });
  }, [
    embedded,
    pendingToolsOpen,
    resolveOpenTargetWorkspace,
    workspacesLoaded,
  ]);

  useEffect(() => {
    if (!active || !pendingWorkspaceOpen || workspaceId !== pendingWorkspaceOpen.workspaceId) return;
    if (consumedWorkspaceOpenRef.current === pendingWorkspaceOpen) return;
    consumedWorkspaceOpenRef.current = pendingWorkspaceOpen;
    const pending = pendingWorkspaceOpen;
    setPendingWorkspaceOpen(null);
    if (pending.pathType === "file" && pending.path) {
      void openFile(pending.path, {
        preview: false,
        line: pending.line,
        column: pending.column,
      });
      return;
    }
    setSelectedNodePath(pending.path);
    if (pending.path) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const ancestor of pathAncestors(pending.path ?? "")) next.add(ancestor);
        return next;
      });
      void (async () => {
        await refreshRoot({ preserveLoadedChildren: true });
        await loadDirectoryPath(pending.path ?? "");
      })().catch((err) => setError(formatFilesError(err)));
    } else {
      void refreshRoot({ preserveLoadedChildren: false });
    }
  }, [active, loadDirectoryPath, openFile, pendingWorkspaceOpen, refreshRoot, setExpanded, workspaceId]);

  /* ---- Group/tab handlers ---- */
  const handleCloseTab = useCallback(
    (groupId: string, tabId: string) => {
      const tab = allOpenTabs.find((candidate) => candidate.id === tabId);
      if (dirtyTabIds.has(tabId)) {
        const label = tab?.path ?? tabId;
        const ok = window.confirm(`"${label}" has unsaved changes. Close anyway?`);
        if (!ok) return;
      }
      const nextState = closeTab(groupsState, groupId, tabId);
      if (!isTabOpenInGroups(nextState, tabId)) {
        registryRef.current.dispose(tabId);
        pruneClosedTabState((candidate) => candidate === tabId);
      }
      applyGroups(() => nextState);
    },
    [allOpenTabs, applyGroups, dirtyTabIds, groupsState, pruneClosedTabState],
  );

  const handleDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    setDirtyBufferRevision((revision) => revision + 1);
    setDirtyTabIds((prev) => {
      const has = prev.has(tabId);
      if (has === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  }, []);

  const handleTabDragStart = useCallback((groupId: string, tabId: string) => {
    dragRef.current = { groupId, tabId };
    setDraggingTab(true);
  }, []);
  const handleTabDragEnd = useCallback(() => {
    dragRef.current = null;
    setDraggingTab(false);
  }, []);
  const handleTabDrop = useCallback(
    (toGroupId: string) => {
      const drag = dragRef.current;
      if (!drag || drag.groupId === toGroupId) return;
      applyGroups((s) => moveTabToGroup(s, drag.groupId, toGroupId, drag.tabId));
    },
    [applyGroups],
  );
  // Drop onto an editor body: center moves the tab into that group; an edge
  // splits a new group off to that side (VSCode-style drag-to-split).
  const handleBodyDrop = useCallback(
    (targetGroupId: string, side: "left" | "right" | "center") => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDraggingTab(false);
      if (!drag) return;
      if (side === "center") {
        if (drag.groupId !== targetGroupId) {
          applyGroups((s) => moveTabToGroup(s, drag.groupId, targetGroupId, drag.tabId));
        }
        return;
      }
      applyGroups((s) => splitTabToNewGroup(s, drag.groupId, drag.tabId, targetGroupId, side));
    },
    [applyGroups],
  );

  // Close any open tabs at (or under) a path that was renamed/deleted, disposing
  // their models. Matching paths are computed from the current snapshot before
  // applying, so dispose isn't run inside a reducer.
  const closeOpenTabsUnder = useCallback(
    (targetWorkspaceId: string, target: string) => {
      const toClose: Array<{ gid: string; tabId: string }> = [];
      for (const gid of groupsState.groupOrder) {
        const g = groupsState.groups[gid];
        if (!g) continue;
        for (const t of g.tabs) {
          if (t.workspaceId === targetWorkspaceId && pathIsAtOrUnder(t.path, target)) {
            toClose.push({ gid, tabId: t.id });
          }
        }
      }
      if (toClose.length === 0) return;
      let nextState = groupsState;
      for (const { gid, tabId } of toClose) {
        nextState = closeTab(nextState, gid, tabId);
      }
      const closedTabIds = new Set(toClose.map((entry) => entry.tabId));
      for (const tabId of closedTabIds) {
        if (!isTabOpenInGroups(nextState, tabId)) {
          registryRef.current.dispose(tabId);
        }
      }
      pruneClosedTabState((tabId) => closedTabIds.has(tabId) && !isTabOpenInGroups(nextState, tabId));
      applyGroups(() => nextState);
    },
    [groupsState, pruneClosedTabState, applyGroups],
  );

  const handleCloseOthers = useCallback(
    (groupId: string, keepTabId: string) => {
      const group = groupsState.groups[groupId];
      if (!group) return;
      const closing = group.tabs
        .filter((tab) => tab.id !== keepTabId && !tab.pinned)
        .map((tab) => tab.id);
      const dirtyClosing = closing.filter((tabId) => dirtyTabIds.has(tabId));
      if (!confirmDiscardDirtyTabIds(dirtyClosing, "Close them")) return;
      const nextState = closeOtherTabs(groupsState, groupId, keepTabId);
      for (const tabId of closing) {
        if (!isTabOpenInGroups(nextState, tabId)) {
          registryRef.current.dispose(tabId);
        }
      }
      if (closing.length > 0) {
        const closingSet = new Set(closing);
        pruneClosedTabState((tabId) => closingSet.has(tabId) && !isTabOpenInGroups(nextState, tabId));
      }
      applyGroups(() => nextState);
    },
    [applyGroups, confirmDiscardDirtyTabIds, dirtyTabIds, groupsState, pruneClosedTabState],
  );

  const renamePath = useCallback(
    async (sourcePath: string, destinationPath: string) => {
      if (!workspaceId) return;
      if (!confirmDiscardDirtyTabIds(dirtyTabsUnder(workspaceId, sourcePath), "Rename it")) return;
      try {
        await files.rename({ workspaceId, oldPath: sourcePath, newPath: destinationPath });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      forgetRecentFilesUnder(recentSessionKey, sourcePath);
      closeOpenTabsUnder(workspaceId, sourcePath);
      await refreshRoot();
    },
    [closeOpenTabsUnder, confirmDiscardDirtyTabIds, dirtyTabsUnder, files, recentSessionKey, refreshRoot, workspaceId],
  );

  const deletePath = useCallback(
    async (path: string) => {
      if (!workspaceId) return;
      const ok = window.confirm(`Delete "${path}"? This cannot be undone.`);
      if (!ok) return;
      if (!confirmDiscardDirtyTabIds(dirtyTabsUnder(workspaceId, path), "Delete it")) return;
      try {
        await files.delete({ workspaceId, path });
        forgetRecentFilesUnder(recentSessionKey, path);
        closeOpenTabsUnder(workspaceId, path);
        await refreshRoot();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [closeOpenTabsUnder, confirmDiscardDirtyTabIds, dirtyTabsUnder, files, recentSessionKey, refreshRoot, workspaceId],
  );

  const dirForNode = (menu: FilesExplorerContextMenuEvent): string =>
    menu.nodeType === "directory" ? menu.nodePath : menu.nodePath.includes("/") ? menu.nodePath.slice(0, menu.nodePath.lastIndexOf("/")) : "";

  const treeMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!treeMenu) return [];
    const path = treeMenu.nodePath;
    const baseDir = dirForNode(treeMenu);
    const fullPath = joinDisplayPath(rootPath, path);
    const name = path.split("/").filter(Boolean).pop() ?? path;
    const items: ContextMenuItem[] = [];
    if (treeMenu.nodeType === "file") {
      items.push({ type: "item", label: "Open", onClick: () => void openFile(path, { preview: false }) });
      items.push({ type: "separator" });
    }
    items.push({ type: "item", label: "New File…", icon: <FilePlus size={14} />, onClick: () => setOverlay({ kind: "create", create: "file", baseDir }) });
    items.push({ type: "item", label: "New Folder…", icon: <FolderPlus size={14} />, onClick: () => setOverlay({ kind: "create", create: "directory", baseDir }) });
    items.push({ type: "separator" });
    items.push({ type: "item", label: "Rename…", icon: <PencilSimple size={14} />, onClick: () => setInlineRename({ path, nonce: ++renameNonceRef.current }) });
    items.push({ type: "item", label: "Delete", icon: <Trash size={14} />, danger: true, onClick: () => void deletePath(path) });
    items.push({ type: "separator" });
    items.push({ type: "item", label: "Copy Full Path", icon: <Copy size={14} />, onClick: () => void window.ade.app.writeClipboardText?.(fullPath) });
    items.push({ type: "item", label: "Copy Relative Path", icon: <Copy size={14} />, onClick: () => void window.ade.app.writeClipboardText?.(path) });
    items.push({ type: "item", label: "Copy Name", icon: <Copy size={14} />, onClick: () => void window.ade.app.writeClipboardText?.(name) });
    items.push({
      type: "item",
      label: revealLabel,
      icon: <ArrowSquareOut size={14} />,
      onClick: () => void window.ade.app.openPathInEditor?.({ rootPath, relativePath: path, target: "finder" }).catch(() => {}),
      disabled: !canRevealInFinder,
    });
    return items;
  }, [treeMenu, openFile, deletePath, rootPath, canRevealInFinder]);

  const createInWorkspace = useCallback(
    async (kind: "file" | "directory", baseDir: string, name: string) => {
      if (!workspaceId) return;
      const rel = baseDir ? `${baseDir}/${name}` : name;
      try {
        if (kind === "file") await files.createFile({ workspaceId, path: rel });
        else await files.createDirectory({ workspaceId, path: rel });
        await refreshRoot();
        if (kind === "file") void openFile(rel, { preview: false });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [files, workspaceId, refreshRoot, openFile],
  );

  // Files-scoped keybindings: ⌘P / ⌘⇧F both open the unified in-depth search.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const isP = mod && !e.shiftKey && (e.key === "p" || e.key === "P");
      const isShiftF = mod && e.shiftKey && (e.key === "f" || e.key === "F");
      if (isP || isShiftF) {
        e.preventDefault();
        setOverlay({ kind: "search" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const handleNativeDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (draggingTab || !Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [draggingTab],
  );

  const handleNativeDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (draggingTab || event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      const firstFile = event.dataTransfer.files.item(0);
      const droppedPath = firstFile ? window.ade.project.getDroppedPath(firstFile) : null;
      if (!droppedPath) return;
      void openExternalPathRequest(droppedPath, `drop:${Date.now()}:0:${droppedPath}`);
    },
    [draggingTab, openExternalPathRequest],
  );

  if (!workspaceId) {
    // Only call it "empty" once the workspace list has actually loaded; while it's
    // still in flight show a quiet loading state on the purple surface (no alarming
    // "No workspace available" flash). Repeat visits skip this entirely via the cache.
    const settledEmpty = workspacesLoaded && workspaces.length === 0;
    return (
      <div
        className="flex h-full items-center justify-center text-sm"
        style={{ color: COLORS.textMuted, background: "color-mix(in srgb, var(--color-card) 76%, var(--color-accent) 18%)" }}
      >
        {settledEmpty ? "No files workspace for this project." : "Loading files workspace…"}
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="files-workbench-v2"
      onDragOver={handleNativeDragOver}
      onDrop={handleNativeDrop}
    >
      {pinnedMachineMarker ? (
        /* Whose disk am I looking at. Amber is machine identity everywhere else
           in ADE, so the same marker is reused rather than inventing a second
           visual language for the same fact. Files here are fully editable —
           the machine is connected and saves go straight to it — so this says
           where you are, not that you are limited. */
        <div
          className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
          style={{ borderColor: COLORS.border, background: "rgba(251, 191, 36, 0.04)" }}
        >
          <LaneMachineMarker marker={pinnedMachineMarker} />
          <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: COLORS.textSecondary }}>
            {pinnedMachineMarker.online
              ? "Files on this machine. Edits save there."
              : "This machine is offline, so its files can't be opened."}
          </span>
          <button
            type="button"
            onClick={clearMachinePin}
            className="shrink-0 text-[11px] underline-offset-2 hover:underline"
            style={{ color: COLORS.textMuted }}
          >
            Back to this computer
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="shrink-0 px-3 py-1 text-xs" style={{ color: COLORS.danger, background: "rgba(255,0,0,0.06)" }}>
          {error}
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: embedded ? "220px 1fr" : "260px 1fr" }}>
        {/* Explorer column — purple card surface to match the rest of ADE's chrome */}
        <div
          className="flex min-h-0 flex-col border-r"
          style={{ borderColor: COLORS.border, background: "color-mix(in srgb, var(--color-card) 80%, var(--color-bg) 20%)" }}
        >
          {!embedded ? (
            <WorkspacePicker workspaces={workspaces} workspaceId={workspaceId} onChange={selectWorkspace} />
          ) : null}
          <div className="min-h-0 flex-1">
            <FilesExplorer
              tree={tree}
              expanded={expanded}
              loadingDirectories={loadingDirs}
              selectedNodePath={selectedNodePath}
              activeTabPath={
                activeTab && activeTab.workspaceId === workspaceId ? activeTab.path : null
              }
              activeContextDir=""
              workspaceComparisonRoot={null}
              searchQuery={searchQuery}
              inlineRenameRequest={inlineRename}
              onSearchQueryChange={setSearchQuery}
              /* Same search as the centre overlay, in the sidebar column: names
                 from the index plus content hits, rather than the old filter
                 over whatever slice of the tree happened to be loaded. */
              searchResults={searchOverlayOpen ? (
                /* The modal owns the search while it is open. Mounting the
                   sidebar copy too would fire every name+content request twice
                   against the same workspace, and it is behind a backdrop. */
                <div className="min-h-0 flex-1" />
              ) : (
                <FilesSearchPanel
                  workspaceId={workspaceId}
                  pin={machinePin}
                  query={searchQuery}
                  onQueryChange={setSearchQuery}
                  onOpen={(path, line) => void openFile(path, { preview: false, line })}
                  onDismiss={() => setSearchQuery("")}
                  variant="sidebar"
                />
              )}
              onCreateFile={(basePath) => setOverlay({ kind: "create", create: "file", baseDir: basePath })}
              onCreateDirectory={(basePath) => setOverlay({ kind: "create", create: "directory", baseDir: basePath })}
              onToggleDirectory={toggleDirectory}
              onLoadMoreChildren={(path, offset) => { loadMoreChildren(path, offset).catch(() => {}); }}
              onOpenFile={(path) => void openFile(path, { preview: true })}
              onActivateFile={(path) => void openFile(path, { preview: false })}
              onSelectNode={setSelectedNodePath}
              onContextMenu={setTreeMenu}
              onRenamePath={renamePath}
              onInlineRenameSettled={() => setInlineRename(null)}
              compact={embedded}
            />
          </div>
          {decorationsTruncated ? (
            <div
              className="shrink-0 border-t px-3 py-1.5 text-[10px] leading-4"
              style={{ borderColor: COLORS.border, color: COLORS.textMuted }}
              title="This workspace has more changed files than the git-status response can carry, so the deepest ones are shown without a status colour."
            >
              Some git decorations hidden (large change set)
            </div>
          ) : null}
        </div>
        <div className="min-h-0 min-w-0">
          {openCount === 0 ? (
            <WarmEmptyState
              workspaceName={workspace?.name ?? null}
              branch={branch}
              dirtyCount={dirtyTabIds.size}
              recents={visibleRecentFiles}
              onOpen={(path) => void openFile(path, { preview: false })}
              onSearch={() => setOverlay({ kind: "search" })}
              modifierKey={modifierKeyLabel}
            />
          ) : (
          <EditorGroups
            files={files}
            sessionKey={sessionKey}
            state={groupsState}
            explorerWorkspaceId={workspaceId}
            explorerLaneId={workspace?.laneId ?? null}
            lanes={lanes}
            tabScope={tabScope}
            onTabScopeChange={() => {
              const next = toggleFilesTabScope(projectRootPath);
              setTabScope(next);
            }}
            resolveTabContext={resolveTabContext}
            theme={theme}
            registry={registryRef.current}
            dirtyTabIds={dirtyTabIds}
            reloadTokensByTabId={reloadTokensByTabId}
            onActivateTab={handleActivateTab}
            onCloseTab={handleCloseTab}
            onCloseOthers={handleCloseOthers}
            onPinTab={(groupId, tabId) => applyGroups((s) => pinTab(s, groupId, tabId))}
            onSplitTab={(groupId, tabId) => applyGroups((s) => splitTabToNewGroup(s, groupId, tabId, groupId, "right"))}
            onPromoteTab={(groupId, tabId) => applyGroups((s) => promoteFromPreview(s, groupId, tabId))}
            onFocusGroup={(groupId) => applyGroups((s) => ({ ...s, activeGroupId: groupId }))}
            onSplit={(groupId) => applyGroups((s) => splitGroup(s, groupId))}
            onDirtyChange={handleDirtyChange}
            onError={setError}
            onTabDragStart={handleTabDragStart}
            onTabDragEnd={handleTabDragEnd}
            onTabDrop={handleTabDrop}
            isTabDragging={draggingTab}
            onBodyDrop={handleBodyDrop}
          />
          )}
        </div>
      </div>
      <StatusBar
        activeTab={activeTab}
        activeFullPath={
          activeTab ? joinDisplayPath(resolveTabContext(activeTab).rootPath, activeTab.path) : null
        }
        branch={branch}
        groupCount={groupsState.groupOrder.length}
        openCount={openCount}
        dirtyCount={dirtyTabIds.size}
      />

      {treeMenu ? (
        <ContextMenu x={treeMenu.x} y={treeMenu.y} items={treeMenuItems} onClose={() => setTreeMenu(null)} />
      ) : null}
      {overlay?.kind === "search" ? (
        <FilesSearchPanel
          workspaceId={workspaceId}
          /* Searching a pinned machine's workspace has to run on that machine —
             otherwise the overlay searches this computer and reports nothing. */
          pin={machinePin}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onOpen={(path, line) => void openFile(path, { preview: false, line })}
          onDismiss={() => {
            // The query is shared with the sidebar panel now, so leaving it set
            // would drop the tree and re-run the same search behind the closed
            // modal. Every exit from the modal ends the search.
            setSearchQuery("");
            setOverlay(null);
          }}
          variant="overlay"
        />
      ) : null}
      {overlay?.kind === "create" ? (
        <CreatePromptModal
          kind={overlay.create}
          baseDir={overlay.baseDir}
          onClose={() => setOverlay(null)}
          onSubmit={(name) => void createInWorkspace(overlay.create, overlay.baseDir, name)}
        />
      ) : null}
    </div>
  );
}
