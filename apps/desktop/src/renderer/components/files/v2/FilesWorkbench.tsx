import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, Copy, FilePlus, FolderPlus, PencilSimple, Trash } from "@phosphor-icons/react";
import type { FileTreeNode, FilesWorkspace } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";
import { createMonacoModelRegistry } from "../monacoModelRegistry";
import { resolveLanguageId } from "../filePresentation";
import { FilesExplorer, type FilesExplorerContextMenuEvent } from "../FilesExplorer";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  applyGitStatusToTree,
  appendTreeNodeChildren,
  defaultFilesWorkspaceId,
  filesSessionKey,
  formatFilesError,
  mergeTreePreservingLoadedChildren,
  replaceTreeNodeChildren,
} from "../treeHelpers";
import {
  type EditorTab,
  activateTab,
  closeOtherTabs,
  closeTab,
  createInitialGroupsState,
  moveTabToGroup,
  openInGroup,
  pinTab,
  promoteFromPreview,
  splitGroup,
  splitTabToNewGroup,
  useEditorGroupsStore,
} from "./editorGroupsStore";
import { resolveViewerKind } from "./viewerRegistry";
import { invalidateFileContent, primeFileContent } from "./useFileContent";
import { getRecentFiles, recordRecentFile } from "./recentFiles";
import { EditorGroups } from "./EditorGroups";
import { StatusBar } from "./StatusBar";
import { WarmEmptyState } from "./WarmEmptyState";
import { WorkspacePicker } from "./WorkspacePicker";
import { CreatePromptModal, SearchOverlay } from "./overlays";
import { setPendingReveal } from "./pendingReveals";
import { COLORS } from "../../lanes/laneDesignTokens";
import { modifierKeyLabel } from "../../../lib/platform";
import type { EditorThemeMode } from "./viewers/types";

const TREE_PAGE_SIZE = 2_000;
const MAX_AUTO_LOADED_CHILDREN = 10_000;

// Module-level caches survive remounts (the route unmounts FilesWorkbench when you
// switch tabs), so re-opening Files shows the workspace + tree instantly instead of
// flashing a loading/empty state while listWorkspaces / listTree refetch.
const workspacesCacheByProject = new Map<string, FilesWorkspace[]>();
const rootTreeCacheByKey = new Map<string, FileTreeNode[]>();
const readCachedWorkspaces = (projectRoot: string): FilesWorkspace[] => workspacesCacheByProject.get(projectRoot) ?? [];
const rootTreeCacheKey = (projectRoot: string, workspaceId: string): string => `${projectRoot}::${workspaceId}`;

/**
 * Files workbench: the VS Code-like shell for the main Files route and the
 * embedded Work sidebar. Reuses the proven IPC + FilesExplorer + Monaco model
 * registry, the streaming/decoration backend, and the editor-groups store.
 */
export function FilesWorkbench({
  preferredLaneId,
  embedded,
  active = true,
}: {
  preferredLaneId?: string | null;
  embedded?: boolean;
  active?: boolean;
}) {
  const project = useAppStore((s) => s.project);
  const projectRootPath = project?.rootPath ?? "";
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const globalLaneId = preferredLaneId ?? selectedLaneId ?? null;

  // Seed from the cross-mount cache so a repeat visit renders immediately.
  const cachedWorkspaces = readCachedWorkspaces(projectRootPath);
  const initialWorkspaceId = defaultFilesWorkspaceId(cachedWorkspaces, globalLaneId);
  const [workspaces, setWorkspaces] = useState<FilesWorkspace[]>(cachedWorkspaces);
  const [workspacesLoaded, setWorkspacesLoaded] = useState<boolean>(cachedWorkspaces.length > 0);
  const [workspaceId, setWorkspaceId] = useState<string>(initialWorkspaceId);
  const workspace = useMemo(() => workspaces.find((w) => w.id === workspaceId) ?? null, [workspaces, workspaceId]);
  const rootPath = workspace?.rootPath ?? projectRootPath;
  const canEdit = workspace ? !workspace.isReadOnlyByDefault : false;
  const branch = workspace?.branchRef?.replace("refs/heads/", "") ?? null;
  const theme: EditorThemeMode = "dark";
  // Session (tabs/layout) follows the ACTIVE workspace's lane, so switching the
  // workspace picker switches the tab set; falls back to the global lane until resolved.
  const sessionKey = filesSessionKey(projectRootPath, workspace?.laneId ?? globalLaneId);

  const [tree, setTree] = useState<FileTreeNode[]>(
    () => rootTreeCacheByKey.get(rootTreeCacheKey(projectRootPath, initialWorkspaceId)) ?? [],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<
    | null
    | { kind: "search"; query: string }
    | { kind: "create"; create: "file" | "directory"; baseDir: string }
  >(null);

  const [draggingTab, setDraggingTab] = useState(false);
  const [treeMenu, setTreeMenu] = useState<FilesExplorerContextMenuEvent | null>(null);
  const [inlineRename, setInlineRename] = useState<{ path: string; nonce: number } | null>(null);
  const renameNonceRef = useRef(0);
  const registryRef = useRef(createMonacoModelRegistry());
  const dragRef = useRef<{ groupId: string; path: string } | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  const store = useEditorGroupsStore();
  const groupsState = store.sessions[sessionKey] ?? createInitialGroupsState();
  const applyGroups = useCallback(
    (reducer: Parameters<typeof store.apply>[1]) => store.apply(sessionKey, reducer),
    [store, sessionKey],
  );

  const activeGroup = groupsState.groups[groupsState.activeGroupId];
  const activeTab = activeGroup?.tabs.find((t) => t.path === activeGroup.activeTabId) ?? null;
  const openCount = useMemo(
    () => new Set(Object.values(groupsState.groups).flatMap((g) => g.tabs.map((t) => t.path))).size,
    [groupsState.groups],
  );

  /* ---- Workspace resolution ---- */
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    window.ade.files
      .listWorkspaces()
      .then((ws) => {
        if (cancelled) return;
        workspacesCacheByProject.set(projectRootPath, ws);
        setWorkspaces(ws);
        setWorkspacesLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setWorkspacesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [active, projectRootPath]);

  // Resolve the workspace from the global lane on mount + when the global lane
  // (or workspace list) changes. A manual pick via the picker persists because
  // workspaceId is intentionally NOT a dependency here.
  useEffect(() => {
    if (!workspaces.length) return;
    const next = defaultFilesWorkspaceId(workspaces, globalLaneId);
    if (next) setWorkspaceId(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, globalLaneId]);

  /* ---- Tree loading ---- */
  const refreshRoot = useCallback(async () => {
    if (!workspaceId) return;
    const reqId = workspaceId;
    try {
      const nodes = await window.ade.files.listTree({ workspaceId: reqId, depth: 1, includeIgnored: true });
      if (workspaceIdRef.current !== reqId) return;
      setTree((prev) => {
        const merged = mergeTreePreservingLoadedChildren(nodes, prev);
        rootTreeCacheByKey.set(rootTreeCacheKey(projectRootPath, reqId), merged);
        return merged;
      });
      setError(null);
      const decorations = await window.ade.files.refreshGitDecorations({ workspaceId: reqId, forceFresh: true });
      if (workspaceIdRef.current !== reqId) return;
      setTree((prev) => {
        const decorated = applyGitStatusToTree(prev, decorations);
        rootTreeCacheByKey.set(rootTreeCacheKey(projectRootPath, reqId), decorated);
        return decorated;
      });
    } catch (err) {
      if (workspaceIdRef.current === reqId) setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId, projectRootPath]);

  // Reset + load when the workspace changes; dispose models from the old lane.
  useEffect(() => {
    if (!active || !workspaceId) return;
    // Seed from cache (instant) rather than clearing to empty, then refresh.
    setTree(rootTreeCacheByKey.get(rootTreeCacheKey(projectRootPath, workspaceId)) ?? []);
    setExpanded(new Set());
    setLoadingDirs(new Set());
    setError(null);
    void refreshRoot();
    const registry = registryRef.current;
    return () => {
      registry.disposeAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspaceId, refreshRoot, projectRootPath]);

  const loadDirectory = useCallback(
    async (parentPath: string) => {
      if (!workspaceId) return;
      const reqId = workspaceId;
      setLoadingDirs((prev) => new Set(prev).add(parentPath));
      try {
        const children: FileTreeNode[] = [];
        let offset = 0;
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
        setTree((prev) => replaceTreeNodeChildren(prev, parentPath, children, loadMoreOffset));
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
    [workspaceId],
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
    const unsub = window.ade.files.onChange((ev) => {
      if (ev.workspaceId !== workspaceIdRef.current) return;
      // Drop the cached content for the changed path so a reopen re-reads disk.
      invalidateFileContent(ev.workspaceId, ev.path);
      if (ev.oldPath) invalidateFileContent(ev.workspaceId, ev.oldPath);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshRoot();
      }, 200);
    });
    void window.ade.files.watchChanges({ workspaceId, includeIgnored: true }).catch(() => {});
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
      void window.ade.files.stopWatching({ workspaceId, includeIgnored: true }).catch(() => {});
    };
  }, [active, workspaceId, refreshRoot]);

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
          isBinary: content.isBinary,
          isPartial: content.isPartial,
        });
        const tab: EditorTab = {
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
    [workspaceId, applyGroups, sessionKey],
  );

  /* ---- Group/tab handlers ---- */
  const handleCloseTab = useCallback(
    (groupId: string, path: string) => {
      if (dirtyPaths.has(path)) {
        const ok = window.confirm(`"${path}" has unsaved changes. Close anyway?`);
        if (!ok) return;
      }
      registryRef.current.dispose(path);
      setDirtyPaths((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      applyGroups((s) => closeTab(s, groupId, path));
    },
    [applyGroups, dirtyPaths],
  );

  const handleDirtyChange = useCallback((path: string, dirty: boolean) => {
    setDirtyPaths((prev) => {
      const has = prev.has(path);
      if (has === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const handleTabDragStart = useCallback((groupId: string, path: string) => {
    dragRef.current = { groupId, path };
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
      applyGroups((s) => moveTabToGroup(s, drag.groupId, toGroupId, drag.path));
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
          applyGroups((s) => moveTabToGroup(s, drag.groupId, targetGroupId, drag.path));
        }
        return;
      }
      applyGroups((s) => splitTabToNewGroup(s, drag.groupId, drag.path, targetGroupId, side));
    },
    [applyGroups],
  );

  // Close any open tabs at (or under) a path that was renamed/deleted, disposing
  // their models. Matching paths are computed from the current snapshot before
  // applying, so dispose isn't run inside a reducer.
  const closeOpenTabsUnder = useCallback(
    (target: string) => {
      const matches = (p: string) => p === target || p.startsWith(`${target}/`);
      const toClose: Array<{ gid: string; path: string }> = [];
      for (const gid of groupsState.groupOrder) {
        const g = groupsState.groups[gid];
        if (!g) continue;
        for (const t of g.tabs) if (matches(t.path)) toClose.push({ gid, path: t.path });
      }
      if (toClose.length === 0) return;
      for (const { path } of toClose) registryRef.current.dispose(path);
      applyGroups((s) => toClose.reduce((acc, { gid, path }) => closeTab(acc, gid, path), s));
    },
    [groupsState, applyGroups],
  );

  const renamePath = useCallback(
    async (sourcePath: string, destinationPath: string) => {
      if (!workspaceId) return;
      await window.ade.files.rename({ workspaceId, oldPath: sourcePath, newPath: destinationPath }).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
      closeOpenTabsUnder(sourcePath); // old path/tabs are stale after rename
      await refreshRoot();
    },
    [workspaceId, refreshRoot, closeOpenTabsUnder],
  );

  const deletePath = useCallback(
    async (path: string) => {
      if (!workspaceId) return;
      const ok = window.confirm(`Delete "${path}"? This cannot be undone.`);
      if (!ok) return;
      try {
        await window.ade.files.delete({ workspaceId, path });
        closeOpenTabsUnder(path);
        await refreshRoot();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspaceId, refreshRoot, closeOpenTabsUnder],
  );

  const dirForNode = (menu: FilesExplorerContextMenuEvent): string =>
    menu.nodeType === "directory" ? menu.nodePath : menu.nodePath.includes("/") ? menu.nodePath.slice(0, menu.nodePath.lastIndexOf("/")) : "";

  const treeMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!treeMenu) return [];
    const path = treeMenu.nodePath;
    const baseDir = dirForNode(treeMenu);
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
    items.push({ type: "item", label: "Copy Path", icon: <Copy size={14} />, onClick: () => void window.ade.app.writeClipboardText?.(path) });
    items.push({ type: "item", label: "Reveal in Finder", icon: <ArrowSquareOut size={14} />, onClick: () => void window.ade.app.openPathInEditor?.({ rootPath, relativePath: path, target: "finder" }).catch(() => {}) });
    return items;
  }, [treeMenu, openFile, deletePath, rootPath]);

  const createInWorkspace = useCallback(
    async (kind: "file" | "directory", baseDir: string, name: string) => {
      if (!workspaceId) return;
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
    [workspaceId, refreshRoot, openFile],
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

  const noop = useCallback(() => {}, []);

  if (!workspaceId) {
    // Only call it "empty" once the workspace list has actually loaded; while it's
    // still in flight show a quiet loading state on the purple surface (no alarming
    // "No workspace available" flash). Repeat visits skip this entirely via the cache.
    const settledEmpty = workspacesLoaded && workspaces.length === 0;
    return (
      <div
        className="flex h-full items-center justify-center text-sm"
        style={{ color: COLORS.textDim, background: "color-mix(in srgb, var(--color-card) 80%, var(--color-accent) 16%)" }}
      >
        {settledEmpty ? "No files workspace for this project." : "Loading files…"}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="files-workbench-v2">
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
            <WorkspacePicker workspaces={workspaces} workspaceId={workspaceId} onChange={setWorkspaceId} />
          ) : null}
          <div className="min-h-0 flex-1">
            <FilesExplorer
              tree={tree}
              expanded={expanded}
              loadingDirectories={loadingDirs}
              selectedNodePath={selectedNodePath}
              activeTabPath={activeTab?.path ?? null}
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
              compact={embedded}
            />
          </div>
        </div>
        <div className="min-h-0 min-w-0">
          {openCount === 0 ? (
            <WarmEmptyState
              workspaceName={workspace?.name ?? null}
              branch={branch}
              dirtyCount={dirtyPaths.size}
              recents={getRecentFiles(sessionKey)}
              onOpen={(path) => void openFile(path, { preview: false })}
              onSearch={() => setOverlay({ kind: "search", query: "" })}
              modifierKey={modifierKeyLabel}
            />
          ) : (
          <EditorGroups
            sessionKey={sessionKey}
            state={groupsState}
            workspaceId={workspaceId}
            rootPath={rootPath}
            laneId={workspace?.laneId ?? null}
            canEdit={canEdit}
            theme={theme}
            registry={registryRef.current}
            dirtyPaths={dirtyPaths}
            onActivateTab={(groupId, path) => applyGroups((s) => activateTab(s, groupId, path))}
            onCloseTab={handleCloseTab}
            onCloseOthers={(groupId, path) => applyGroups((s) => closeOtherTabs(s, groupId, path))}
            onPinTab={(groupId, path) => applyGroups((s) => pinTab(s, groupId, path))}
            onSplitTab={(groupId, path) => applyGroups((s) => splitTabToNewGroup(s, groupId, path, groupId, "right"))}
            onPromoteTab={(groupId, path) => applyGroups((s) => promoteFromPreview(s, groupId, path))}
            onFocusGroup={(groupId) => applyGroups((s) => ({ ...s, activeGroupId: groupId }))}
            onSplit={(groupId) => applyGroups((s) => splitGroup(s, groupId))}
            onDirtyChange={handleDirtyChange}
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
        branch={branch}
        groupCount={groupsState.groupOrder.length}
        openCount={openCount}
        dirtyCount={dirtyPaths.size}
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
