import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, Copy, FilePlus, FolderPlus, PencilSimple, Trash } from "@phosphor-icons/react";
import type { FileTreeNode, FilesWorkspace } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";
import { createMonacoModelRegistry } from "../monacoModelRegistry";
import { resolveLanguageId } from "../filePresentation";
import { FilesExplorer, type FilesExplorerContextMenuEvent } from "../FilesExplorer";
import { clearDirtyBuffersForWorkspace, replaceDirtyBufferValuesForWorkspace } from "../../../lib/dirtyWorkspaceBuffers";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  applyGitStatusToTree,
  appendTreeNodeChildren,
  defaultFilesWorkspaceId,
  filesProjectSessionKey,
  filesSessionKey,
  formatFilesError,
  hasAncestorDirectoryPath,
  hasLoadedDirectoryChildren,
  isMissingWorkspaceRootError,
  isUnavailableGitDecorationsError,
  loadedDirectoryChildrenCount,
  mergeTreePreservingLoadedChildren,
  nearestLoadedAncestorDirectoryPath,
  parentPathForFileChange,
  replaceTreeNodeChildren,
} from "../treeHelpers";
import {
  type EditorTab,
  activateTab,
  closeOtherTabs,
  closeTab,
  createInitialGroupsState,
  editorTabId,
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
import { resolveViewerKind } from "./viewerRegistry";
import { invalidateFileContent, primeFileContent } from "./useFileContent";
import { forgetRecentFilesUnder, getRecentFiles, isNestedFilePath, pruneMissingRootRecentFiles, recordRecentFile } from "./recentFiles";
import { EditorGroups } from "./EditorGroups";
import { StatusBar } from "./StatusBar";
import { WarmEmptyState } from "./WarmEmptyState";
import { WorkspacePicker } from "./WorkspacePicker";
import { CreatePromptModal, SearchOverlay } from "./overlays";
import { setPendingReveal } from "./pendingReveals";
import { COLORS } from "../../lanes/laneDesignTokens";
import { modifierKeyLabel } from "../../../lib/platform";
import type { EditorThemeMode } from "./viewers/types";
import { joinDisplayPath } from "./pathDisplay";

const TREE_PAGE_SIZE = 2_000;
const MAX_AUTO_LOADED_CHILDREN = 10_000;
const MAX_QUEUED_TREE_PARENT_REFRESHES = 24;

// Module-level caches survive remounts (the route unmounts FilesWorkbench when you
// switch tabs), so re-opening Files shows the workspace + tree instantly instead of
// flashing a loading/empty state while listWorkspaces / listTree refetch.
const workspacesCacheByProject = new Map<string, FilesWorkspace[]>();
const rootTreeCacheByKey = new Map<string, FileTreeNode[]>();
const readCachedWorkspaces = (projectRoot: string): FilesWorkspace[] => workspacesCacheByProject.get(projectRoot) ?? [];
const rootTreeCacheKey = (projectRoot: string, workspaceId: string): string => `${projectRoot}::${workspaceId}`;

function canEditWorkspace(workspace: FilesWorkspace | null | undefined): boolean {
  return workspace != null && !workspace.isReadOnlyByDefault;
}

function mergeExternalWorkspaces(next: FilesWorkspace[], previous: FilesWorkspace[]): FilesWorkspace[] {
  const seen = new Set(next.map((workspace) => workspace.id));
  const preserved = previous.filter((workspace) => workspace.kind === "external" && !seen.has(workspace.id));
  return [...next, ...preserved];
}

function pathAncestors(path: string): string[] {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i <= segments.length; i++) {
    out.push(segments.slice(0, i).join("/"));
  }
  return out;
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
}: {
  preferredLaneId?: string | null;
  embedded?: boolean;
  active?: boolean;
  externalOpenPath?: string | null;
  externalOpenNonce?: string | null;
}) {
  const project = useAppStore((s) => s.project);
  const projectRootPath = project?.rootPath ?? "";
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const lanes = useAppStore((s) => s.lanes);
  const globalLaneId = preferredLaneId ?? selectedLaneId ?? null;

  // Seed from the cross-mount cache so a repeat visit renders immediately.
  const cachedWorkspaces = readCachedWorkspaces(projectRootPath);
  const initialWorkspaceId = defaultFilesWorkspaceId(cachedWorkspaces, globalLaneId);
  const [workspaces, setWorkspaces] = useState<FilesWorkspace[]>(cachedWorkspaces);
  const [workspacesLoaded, setWorkspacesLoaded] = useState<boolean>(cachedWorkspaces.length > 0);
  const [workspacesListedProjectRoot, setWorkspacesListedProjectRoot] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>(initialWorkspaceId);
  const workspace = useMemo(() => workspaces.find((w) => w.id === workspaceId) ?? null, [workspaces, workspaceId]);
  const rootPath = workspace?.rootPath ?? projectRootPath;
  const canEdit = canEditWorkspace(workspace);
  const canRevealInFinder = workspace != null && (workspace.kind === "external" || !isRemoteProject);
  const branch = workspace?.branchRef?.replace("refs/heads/", "") ?? null;
  const theme: EditorThemeMode = "dark";
  const sessionKey = filesProjectSessionKey(projectRootPath);
  const [tabScope, setTabScope] = useState<FilesTabScope>(() => getFilesTabScope(projectRootPath));

  const [tree, setTree] = useState<FileTreeNode[]>(
    () => rootTreeCacheByKey.get(rootTreeCacheKey(projectRootPath, initialWorkspaceId)) ?? [],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [dirtyTabIds, setDirtyTabIds] = useState<Set<string>>(new Set());
  const [dirtyBufferRevision, setDirtyBufferRevision] = useState(0);
  const [reloadTokensByTabId, setReloadTokensByTabId] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<
    | null
    | { kind: "search"; query: string }
    | { kind: "create"; create: "file" | "directory"; baseDir: string }
  >(null);

  const [draggingTab, setDraggingTab] = useState(false);
  const [treeMenu, setTreeMenu] = useState<FilesExplorerContextMenuEvent | null>(null);
  const [inlineRename, setInlineRename] = useState<{ path: string; nonce: number } | null>(null);
  const [pendingWorkspaceOpen, setPendingWorkspaceOpen] = useState<{
    workspaceId: string;
    path: string | null;
    pathType: "file" | "directory";
    nonce: string;
  } | null>(null);
  const handledExternalOpenRef = useRef<string | null>(null);
  const lastGlobalLaneIdRef = useRef(globalLaneId);
  const workspacesProjectRootRef = useRef(projectRootPath);
  const renameNonceRef = useRef(0);
  const registryRef = useRef(createMonacoModelRegistry());
  const dragRef = useRef<{ groupId: string; tabId: string } | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;
  const dirtyTabIdsRef = useRef(dirtyTabIds);
  dirtyTabIdsRef.current = dirtyTabIds;

  const store = useEditorGroupsStore();
  const groupsState = store.sessions[sessionKey] ?? createInitialGroupsState();
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
        workspacesCacheByProject.set(projectRootPath, next);
        return next;
      });
    },
    [projectRootPath],
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
        canEdit: canEditWorkspace(ws),
        canRevealInFinder: ws != null && (ws.kind === "external" || !isRemoteProject),
      };
    },
    [isRemoteProject, projectRootPath, workspaces],
  );

  const migratedSessionsRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectRootPath || workspaces.length === 0 || workspacesListedProjectRoot !== projectRootPath) return;
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
  }, [projectRootPath, store, workspaces, workspacesListedProjectRoot]);

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
  const recentFiles = getRecentFiles(sessionKey);
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
    pruneMissingRootRecentFiles(sessionKey, knownRootPaths);
  }, [knownRootPaths, sessionKey, tree.length]);

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
  }, [allOpenTabs, dirtyBufferRevision, dirtyTabIds, resolveTabContext]);

  /* ---- Workspace resolution ---- */
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const projectChanged = workspacesProjectRootRef.current !== projectRootPath;
    workspacesProjectRootRef.current = projectRootPath;
    if (projectChanged) {
      const cachedForProject = readCachedWorkspaces(projectRootPath).filter((workspace) => workspace.kind !== "external");
      setWorkspaces(cachedForProject);
      setWorkspacesLoaded(cachedForProject.length > 0);
      setWorkspacesListedProjectRoot(null);
    }
    window.ade.files
      .listWorkspaces()
      .then((ws) => {
        if (cancelled) return;
        setWorkspaces((prev) => {
          const merged = projectChanged ? ws : mergeExternalWorkspaces(ws, prev);
          workspacesCacheByProject.set(projectRootPath, merged);
          return merged;
        });
        setWorkspacesLoaded(true);
        setWorkspacesListedProjectRoot(projectRootPath);
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspacesLoaded(true);
          setWorkspacesListedProjectRoot(projectRootPath);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, projectRootPath]);

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

  /* ---- Tree loading ---- */
  const refreshTreeGitDecorations = useCallback(
    async (reqId = workspaceId) => {
      if (!reqId) return;
      let decorations = null;
      try {
        decorations = await window.ade.files.refreshGitDecorations({ workspaceId: reqId, forceFresh: true });
      } catch (decorationError) {
        if (!isUnavailableGitDecorationsError(decorationError)) throw decorationError;
      }
      if (!decorations) return;
      if (workspaceIdRef.current !== reqId) return;
      setTree((prev) => {
        const decorated = applyGitStatusToTree(prev, decorations);
        rootTreeCacheByKey.set(rootTreeCacheKey(projectRootPath, reqId), decorated);
        return decorated;
      });
    },
    [projectRootPath, workspaceId],
  );

  const refreshRoot = useCallback(async (options: { preserveLoadedChildren?: boolean } = {}) => {
    if (!workspaceId) return;
    const reqId = workspaceId;
    const preserveLoadedChildren = options.preserveLoadedChildren !== false;
    try {
      const nodes = await window.ade.files.listTree({ workspaceId: reqId, depth: 1, includeIgnored: true });
      if (workspaceIdRef.current !== reqId) return;
      setTree((prev) => {
        const merged = preserveLoadedChildren ? mergeTreePreservingLoadedChildren(nodes, prev) : nodes;
        rootTreeCacheByKey.set(rootTreeCacheKey(projectRootPath, reqId), merged);
        return merged;
      });
      setError(null);
      await refreshTreeGitDecorations(reqId);
    } catch (err) {
      if (workspaceIdRef.current === reqId) setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId, projectRootPath, refreshTreeGitDecorations]);

  // Reload explorer tree when the selected workspace changes (tabs stay open).
  useEffect(() => {
    if (!active || !workspaceId) return;
    setTree(rootTreeCacheByKey.get(rootTreeCacheKey(projectRootPath, workspaceId)) ?? []);
    setExpanded(new Set());
    setLoadingDirs(new Set());
    setError(null);
    void refreshRoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspaceId, refreshRoot, projectRootPath]);

  useEffect(() => {
    if (!active) return;
    const registry = registryRef.current;
    return () => {
      registry.disposeAll();
    };
  }, [active]);

  const fetchDirectoryChildren = useCallback(async (reqId: string, parentPath: string, minChildren = MAX_AUTO_LOADED_CHILDREN) => {
    const children: FileTreeNode[] = [];
    let offset = 0;
    let loadMoreOffset: number | null = null;
    const targetChildren = Math.max(MAX_AUTO_LOADED_CHILDREN, minChildren);
    for (;;) {
      const page = await window.ade.files.listTreeChildren({
        workspaceId: reqId,
        parentPath,
        offset,
        limit: TREE_PAGE_SIZE,
        includeIgnored: true,
      });
      if (workspaceIdRef.current !== reqId) return null;
      children.push(...page.children);
      if (page.nextOffset == null) break;
      if (children.length >= targetChildren) {
        loadMoreOffset = page.nextOffset;
        break;
      }
      offset = page.nextOffset;
    }
    return { children, loadMoreOffset };
  }, []);

  const refreshLoadedDirectory = useCallback(
    async (parentPath: string, reqId = workspaceId, options: { suppressMissingError?: boolean } = {}) => {
      if (!reqId) return;
      setLoadingDirs((prev) => new Set(prev).add(parentPath));
      try {
        const loadedCount = loadedDirectoryChildrenCount(treeRef.current, parentPath);
        const result = await fetchDirectoryChildren(reqId, parentPath, loadedCount);
        if (!result || workspaceIdRef.current !== reqId) return;
        setTree((prev) => {
          const nextTree = replaceTreeNodeChildren(prev, parentPath, result.children, result.loadMoreOffset);
          rootTreeCacheByKey.set(rootTreeCacheKey(projectRootPath, reqId), nextTree);
          return nextTree;
        });
      } catch (err) {
        const message = formatFilesError(err);
        if (options.suppressMissingError && isMissingWorkspaceRootError(message)) return;
        if (workspaceIdRef.current === reqId) setError(message);
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(parentPath);
          return next;
        });
      }
    },
    [fetchDirectoryChildren, projectRootPath, workspaceId],
  );

  const loadDirectory = useCallback(
    async (parentPath: string) => {
      await refreshLoadedDirectory(parentPath);
    },
    [refreshLoadedDirectory],
  );

  const loadDirectoryPath = useCallback(
    async (directoryPath: string) => {
      for (const ancestor of pathAncestors(directoryPath)) {
        await refreshLoadedDirectory(ancestor);
      }
    },
    [refreshLoadedDirectory],
  );

  const loadMoreChildren = useCallback(
    async (parentPath: string, startOffset: number) => {
      if (!workspaceId) return;
      const reqId = workspaceId;
      setLoadingDirs((prev) => new Set(prev).add(parentPath));
      try {
        const children: FileTreeNode[] = [];
        let offset = startOffset;
        let loadMoreOffset: number | null = null;
        for (;;) {
          const page = await window.ade.files.listTreeChildren({
            workspaceId: reqId,
            parentPath,
            offset,
            limit: TREE_PAGE_SIZE,
            includeIgnored: true,
          });
          if (workspaceIdRef.current !== reqId) return;
          children.push(...page.children);
          if (page.nextOffset == null) break;
          if (children.length >= MAX_AUTO_LOADED_CHILDREN) {
            loadMoreOffset = page.nextOffset;
            break;
          }
          offset = page.nextOffset;
        }
        setTree((prev) => {
          const nextTree = appendTreeNodeChildren(prev, parentPath, children, loadMoreOffset);
          rootTreeCacheByKey.set(rootTreeCacheKey(projectRootPath, reqId), nextTree);
          return nextTree;
        });
      } catch (err) {
        if (workspaceIdRef.current === reqId) setError(formatFilesError(err));
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(parentPath);
          return next;
        });
      }
    },
    [projectRootPath, workspaceId],
  );

  const toggleDirectory = useCallback(
    (nodePath: string, isExpanded: boolean, hasLoadedChildren: boolean) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(nodePath)) next.delete(nodePath);
        else next.add(nodePath);
        return next;
      });
      if (!isExpanded && !hasLoadedChildren) void loadDirectory(nodePath);
    },
    [loadDirectory],
  );

  /* ---- File watching: refresh the tree on disk changes (debounced) ---- */
  useEffect(() => {
    if (!active || !workspaceId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const queuedParentPaths = new Set<string>();
    let rootRefreshQueued = false;
    let fullRootRefreshQueued = false;
    let decorationsRefreshQueued = false;

    const enqueuePathRefresh = (path: string | undefined) => {
      if (!path) return;
      decorationsRefreshQueued = true;
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

    const unsub = window.ade.files.onChange((ev) => {
      const isExplorerWorkspace = ev.workspaceId === workspaceIdRef.current;
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
      if (!isExplorerWorkspace) return;
      enqueuePathRefresh(ev.path);
      enqueuePathRefresh(ev.oldPath);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        flushQueuedRefreshes();
      }, 200);
    });
    const watchedIds = new Set([workspaceId, ...openWorkspaceIds]);
    for (const watchedId of watchedIds) {
      void window.ade.files.watchChanges({ workspaceId: watchedId, includeIgnored: true }).catch(() => {});
    }
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
      for (const watchedId of watchedIds) {
        void window.ade.files.stopWatching({ workspaceId: watchedId, includeIgnored: true }).catch(() => {});
      }
    };
  }, [active, openWorkspaceIds, refreshLoadedDirectory, refreshRoot, refreshTreeGitDecorations, workspaceId]);

  /* ---- Open file ---- */
  const openFile = useCallback(
    async (path: string, opts: { preview?: boolean; line?: number } = {}) => {
      if (!workspaceId) return;
      setSelectedNodePath(path);
      if (opts.line && opts.line > 0) setPendingReveal(path, opts.line);
      try {
        const content = await window.ade.files.readFile({ workspaceId, path });
        if (workspaceIdRef.current !== workspaceId) return;
        primeFileContent(workspaceId, path, content);
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
        recordRecentFile(sessionKey, path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspace, workspaceId, applyGroups, sessionKey],
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
    async (absolutePath: string, nonce: string) => {
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
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [upsertWorkspace],
  );

  useEffect(() => {
    if (!active || !externalOpenPath) return;
    const key = `${externalOpenNonce ?? ""}:${externalOpenPath}`;
    if (handledExternalOpenRef.current === key) return;
    handledExternalOpenRef.current = key;
    void openExternalPathRequest(externalOpenPath, key);
  }, [active, externalOpenPath, externalOpenNonce, openExternalPathRequest]);

  useEffect(() => {
    if (!active || !pendingWorkspaceOpen || workspaceId !== pendingWorkspaceOpen.workspaceId) return;
    const pending = pendingWorkspaceOpen;
    setPendingWorkspaceOpen(null);
    if (pending.pathType === "file" && pending.path) {
      void openFile(pending.path, { preview: false });
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
  }, [active, loadDirectoryPath, openFile, pendingWorkspaceOpen, refreshRoot, workspaceId]);

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
      if (!canEdit) {
        setError("This workspace is read-only.");
        return;
      }
      if (!confirmDiscardDirtyTabIds(dirtyTabsUnder(workspaceId, sourcePath), "Rename it")) return;
      try {
        await window.ade.files.rename({ workspaceId, oldPath: sourcePath, newPath: destinationPath });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      forgetRecentFilesUnder(sessionKey, sourcePath);
      closeOpenTabsUnder(workspaceId, sourcePath);
      await refreshRoot();
    },
    [canEdit, closeOpenTabsUnder, confirmDiscardDirtyTabIds, dirtyTabsUnder, refreshRoot, sessionKey, workspaceId],
  );

  const deletePath = useCallback(
    async (path: string) => {
      if (!workspaceId) return;
      if (!canEdit) {
        setError("This workspace is read-only.");
        return;
      }
      const ok = window.confirm(`Delete "${path}"? This cannot be undone.`);
      if (!ok) return;
      if (!confirmDiscardDirtyTabIds(dirtyTabsUnder(workspaceId, path), "Delete it")) return;
      try {
        await window.ade.files.delete({ workspaceId, path });
        forgetRecentFilesUnder(sessionKey, path);
        closeOpenTabsUnder(workspaceId, path);
        await refreshRoot();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [canEdit, closeOpenTabsUnder, confirmDiscardDirtyTabIds, dirtyTabsUnder, refreshRoot, sessionKey, workspaceId],
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
    items.push({ type: "item", label: "New File…", icon: <FilePlus size={14} />, onClick: () => setOverlay({ kind: "create", create: "file", baseDir }), disabled: !canEdit });
    items.push({ type: "item", label: "New Folder…", icon: <FolderPlus size={14} />, onClick: () => setOverlay({ kind: "create", create: "directory", baseDir }), disabled: !canEdit });
    items.push({ type: "separator" });
    items.push({ type: "item", label: "Rename…", icon: <PencilSimple size={14} />, onClick: () => setInlineRename({ path, nonce: ++renameNonceRef.current }), disabled: !canEdit });
    items.push({ type: "item", label: "Delete", icon: <Trash size={14} />, danger: true, onClick: () => void deletePath(path), disabled: !canEdit });
    items.push({ type: "separator" });
    items.push({ type: "item", label: "Copy Full Path", icon: <Copy size={14} />, onClick: () => void window.ade.app.writeClipboardText?.(fullPath) });
    items.push({ type: "item", label: "Copy Relative Path", icon: <Copy size={14} />, onClick: () => void window.ade.app.writeClipboardText?.(path) });
    items.push({ type: "item", label: "Copy Name", icon: <Copy size={14} />, onClick: () => void window.ade.app.writeClipboardText?.(name) });
    items.push({
      type: "item",
      label: "Reveal in Finder",
      icon: <ArrowSquareOut size={14} />,
      onClick: () => void window.ade.app.openPathInEditor?.({ rootPath, relativePath: path, target: "finder" }).catch(() => {}),
      disabled: !canRevealInFinder,
    });
    return items;
  }, [treeMenu, openFile, canEdit, deletePath, rootPath, canRevealInFinder]);

  const createInWorkspace = useCallback(
    async (kind: "file" | "directory", baseDir: string, name: string) => {
      if (!workspaceId) return;
      if (!canEdit) {
        setError("This workspace is read-only.");
        return;
      }
      const rel = baseDir ? `${baseDir}/${name}` : name;
      try {
        if (kind === "file") await window.ade.files.createFile({ workspaceId, path: rel });
        else await window.ade.files.createDirectory({ workspaceId, path: rel });
        await refreshRoot();
        if (kind === "file") void openFile(rel, { preview: false });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [canEdit, workspaceId, refreshRoot, openFile],
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
        setOverlay({ kind: "search", query: "" });
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
              singleRowHeader
              onSearchQueryChange={setSearchQuery}
              onSearchSubmit={(query) => setOverlay({ kind: "search", query })}
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
              canMutate={canEdit}
              compact={embedded}
            />
          </div>
        </div>
        <div className="min-h-0 min-w-0">
          {openCount === 0 ? (
            <WarmEmptyState
              workspaceName={workspace?.name ?? null}
              branch={branch}
              dirtyCount={dirtyTabIds.size}
              recents={visibleRecentFiles}
              onOpen={(path) => void openFile(path, { preview: false })}
              onSearch={() => setOverlay({ kind: "search", query: "" })}
              modifierKey={modifierKeyLabel}
            />
          ) : (
          <EditorGroups
            sessionKey={sessionKey}
            state={groupsState}
            workspaces={workspaces}
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
        <SearchOverlay
          workspaceId={workspaceId}
          initialQuery={overlay.query}
          onClose={() => setOverlay(null)}
          onOpen={(path, line) => void openFile(path, { preview: false, line })}
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
