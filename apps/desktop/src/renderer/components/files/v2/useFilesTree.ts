import { useCallback, useEffect, useRef, useState } from "react";
import type { FileTreeNode } from "../../../../shared/types";
import {
  appendTreeNodeChildren,
  applyGitStatusToTree,
  directoryLoadMoreOffset,
  formatFilesError,
  isMissingWorkspaceRootError,
  isUnavailableGitDecorationsError,
  loadedDirectoryChildrenCount,
  mergeTreePreservingLoadedChildren,
  replaceTreeNodeChildren,
} from "../treeHelpers";
import {
  filesTreeCacheKey,
  pinCachedTree,
  readCachedTree,
  unpinCachedTree,
  writeCachedTree,
} from "./filesTreeCache";
import type { PinnedFilesApi } from "./pinnedFilesApi";

const TREE_PAGE_SIZE = 2_000;
// The root listing is the first thing every visit needs. Fetching two levels
// costs one host walk but saves a `listTreeChildren` round trip on the first
// folder the user expands (the host clamps depth to 1..8).
const ROOT_TREE_DEPTH = 2;
// Path reveals (external opens) may need entries beyond the first page; they
// page up to this bound instead of the single visible page expansion uses.
const REVEAL_MAX_CHILDREN = 10_000;

/** Every ancestor directory of a path, shallowest first. */
export function pathAncestors(path: string): string[] {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i <= segments.length; i++) {
    out.push(segments.slice(0, i).join("/"));
  }
  return out;
}

export type FilesTreeArgs = {
  /** False while this workbench is mounted but not the visible surface. */
  active: boolean;
  /** Files API already bound to the machine that owns this workspace. */
  files: PinnedFilesApi;
  workspaceId: string;
  /** Live workspace id, so an in-flight listing can drop a stale response. */
  workspaceIdRef: React.MutableRefObject<string>;
  projectCacheKey: string;
  initialWorkspaceId: string;
  /**
   * Surface a listing failure. Held in a ref inside, so an inline callback from
   * the caller cannot change any callback identity below — those gate the file
   * watcher's subscription, and churning them would re-subscribe every render.
   */
  onError: (message: string | null) => void;
};

/**
 * The Files explorer tree: listing, paging, expansion, and git decorations.
 *
 * Extracted from `FilesWorkbench` because it is the one genuinely closed unit in
 * that file — nothing outside writes tree state, and everything here is driven
 * by (workspace, machine) alone.
 *
 * The file watcher deliberately did NOT come with it. That effect refreshes this
 * tree *and* reloads open editor tabs, so it is coordination between two layers
 * rather than a part of either; pulling it in here would force the tree to know
 * about tabs.
 *
 * Callback identities are preserved exactly as they were inline. They gate the
 * watcher subscription, so a widened dependency here costs a real tear-down and
 * re-subscribe cycle, not just a re-render.
 */
export function useFilesTree(args: FilesTreeArgs) {
  const {
    active,
    files,
    workspaceId,
    workspaceIdRef,
    projectCacheKey,
    initialWorkspaceId,
    onError,
  } = args;

  const [tree, setTree] = useState<FileTreeNode[]>(
    () => readCachedTree(filesTreeCacheKey(projectCacheKey, initialWorkspaceId)) ?? [],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  // The host caps the git-status entry lists on a very large dirty tree, so deep
  // files come back undecorated. Without saying so, an undecorated file is
  // indistinguishable from a clean one.
  const [decorationsTruncated, setDecorationsTruncated] = useState(false);
  const treeRef = useRef(tree);
  treeRef.current = tree;

  // Stable forever, whatever the caller passes. Every callback below lists it
  // as a dependency, and the watcher effect in the workbench is keyed on those
  // callbacks — so an unstable `onError` would mean a tear-down and re-subscribe
  // of the chokidar watcher on every single render.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const setError = useCallback((message: string | null) => onErrorRef.current(message), []);

  const fetchGitDecorations = useCallback(async (reqId: string, forceFresh: boolean) => {
    try {
      const decorations = await files.refreshGitDecorations({ workspaceId: reqId, forceFresh });
      // Both decoration paths come through here, so recording the cap in one
      // place keeps the hint in step with whatever was last applied to the tree.
      if (workspaceIdRef.current === reqId) {
        setDecorationsTruncated(decorations?.truncated === true);
      }
      return decorations;
    } catch (decorationError) {
      if (!isUnavailableGitDecorationsError(decorationError)) throw decorationError;
      if (workspaceIdRef.current === reqId) setDecorationsTruncated(false);
      return null;
    }
  }, [files, workspaceIdRef]);

  const refreshTreeGitDecorations = useCallback(
    async (reqId = workspaceId) => {
      if (!reqId) return;
      const decorations = await fetchGitDecorations(reqId, true);
      if (!decorations) return;
      if (workspaceIdRef.current !== reqId) return;
      setTree((prev) => {
        const decorated = applyGitStatusToTree(prev, decorations);
        writeCachedTree(filesTreeCacheKey(projectCacheKey, reqId), decorated);
        return decorated;
      });
    },
    [fetchGitDecorations, projectCacheKey, workspaceId, workspaceIdRef],
  );

  const refreshRoot = useCallback(async (options: { preserveLoadedChildren?: boolean } = {}) => {
    if (!workspaceId) return;
    const reqId = workspaceId;
    const preserveLoadedChildren = options.preserveLoadedChildren !== false;
    try {
      // Listing and decorations are independent host reads: issuing them
      // together turns the tree refresh into one round trip instead of two,
      // which is the whole mount cost on the relay transport. Decorations skip
      // `forceFresh` so they can be served by the host's short git-status SWR
      // cache — a structure refresh does not need a fresh `git status` sweep.
      const [nodes, decorations] = await Promise.all([
        files.listTree({ workspaceId: reqId, depth: ROOT_TREE_DEPTH, includeIgnored: true }),
        fetchGitDecorations(reqId, false),
      ]);
      if (workspaceIdRef.current !== reqId) return;
      setTree((prev) => {
        const merged = preserveLoadedChildren ? mergeTreePreservingLoadedChildren(nodes, prev) : nodes;
        const decorated = decorations ? applyGitStatusToTree(merged, decorations) : merged;
        writeCachedTree(filesTreeCacheKey(projectCacheKey, reqId), decorated);
        return decorated;
      });
      setError(null);
    } catch (err) {
      if (workspaceIdRef.current === reqId) setError(err instanceof Error ? err.message : String(err));
    }
  }, [files, workspaceId, fetchGitDecorations, projectCacheKey, setError, workspaceIdRef]);

  // Pin the rendered tree while this workbench is mounted: the React state
  // below holds the same nodes, so evicting the cache copy would only create
  // a stale-cache/live-tree split without freeing memory.
  useEffect(() => {
    if (!workspaceId) return;
    const treeKey = filesTreeCacheKey(projectCacheKey, workspaceId);
    pinCachedTree(treeKey);
    return () => unpinCachedTree(treeKey);
  }, [projectCacheKey, workspaceId]);

  // Reload explorer tree when the selected workspace changes (tabs stay open).
  useEffect(() => {
    if (!active || !workspaceId) return;
    setTree(readCachedTree(filesTreeCacheKey(projectCacheKey, workspaceId)) ?? []);
    setExpanded(new Set());
    setLoadingDirs(new Set());
    setDecorationsTruncated(false);
    setError(null);
    void refreshRoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspaceId, refreshRoot, projectCacheKey]);

  // Fetch a directory's children starting from the first page. Expansion asks
  // for one page (a single IPC round trip renders immediately with a
  // "Load more…" row); refresh passes the already-loaded count so a
  // user-grown window stays fully populated across watcher refreshes.
  const fetchDirectoryChildren = useCallback(async (reqId: string, parentPath: string, minChildren = TREE_PAGE_SIZE) => {
    const children: FileTreeNode[] = [];
    let offset = 0;
    let loadMoreOffset: number | null = null;
    const targetChildren = Math.max(TREE_PAGE_SIZE, minChildren);
    for (;;) {
      const page = await files.listTreeChildren({
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
  }, [files, workspaceIdRef]);

  // Directory operations (watcher refresh, load-more) are serialized per path:
  // a refresh that snapshots the loaded count while a load-more is in flight
  // would otherwise resolve last and shrink the freshly grown window (or a late
  // load-more would append at a stale offset). Each op reads the tree only
  // after every earlier op on the same path has settled. Distinct paths still
  // run concurrently.
  const treeOpQueueRef = useRef(new Map<string, Promise<void>>());
  const runSerializedTreeOp = useCallback(async (parentPath: string, op: () => Promise<void>) => {
    const queue = treeOpQueueRef.current;
    const prev = queue.get(parentPath) ?? Promise.resolve();
    const next = prev.then(op, op);
    queue.set(parentPath, next);
    try {
      await next;
    } finally {
      if (queue.get(parentPath) === next) queue.delete(parentPath);
    }
  }, []);

  const refreshLoadedDirectory = useCallback(
    (
      parentPath: string,
      reqId = workspaceId,
      options: { suppressMissingError?: boolean; minChildren?: number } = {},
    ) => {
      if (!reqId) return Promise.resolve();
      return runSerializedTreeOp(parentPath, async () => {
        setLoadingDirs((prev) => new Set(prev).add(parentPath));
        try {
          const loadedCount = loadedDirectoryChildrenCount(treeRef.current, parentPath);
          const result = await fetchDirectoryChildren(
            reqId,
            parentPath,
            Math.max(loadedCount, options.minChildren ?? 0),
          );
          if (!result || workspaceIdRef.current !== reqId) return;
          setTree((prev) => {
            const nextTree = replaceTreeNodeChildren(prev, parentPath, result.children, result.loadMoreOffset);
            writeCachedTree(filesTreeCacheKey(projectCacheKey, reqId), nextTree);
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
      });
    },
    [fetchDirectoryChildren, projectCacheKey, runSerializedTreeOp, setError, workspaceId, workspaceIdRef],
  );

  const loadDirectory = useCallback(
    async (parentPath: string) => {
      await refreshLoadedDirectory(parentPath);
    },
    [refreshLoadedDirectory],
  );

  const loadDirectoryPath = useCallback(
    async (directoryPath: string) => {
      // Reveals must materialize the revealed entries even when they sit past
      // the first page, so page deeper than a plain expansion.
      for (const ancestor of pathAncestors(directoryPath)) {
        await refreshLoadedDirectory(ancestor, workspaceIdRef.current, { minChildren: REVEAL_MAX_CHILDREN });
      }
    },
    [refreshLoadedDirectory, workspaceIdRef],
  );

  const loadMoreChildren = useCallback(
    (parentPath: string, startOffset: number) => {
      if (!workspaceId) return Promise.resolve();
      const reqId = workspaceId;
      return runSerializedTreeOp(parentPath, async () => {
        setLoadingDirs((prev) => new Set(prev).add(parentPath));
        try {
          // One page per click: a single IPC round trip appends immediately and
          // the "Load more…" row persists while nextOffset remains. Re-read the
          // cursor from the tree in case an earlier serialized op moved it.
          const offset = directoryLoadMoreOffset(treeRef.current, parentPath) ?? startOffset;
          const page = await files.listTreeChildren({
            workspaceId: reqId,
            parentPath,
            offset,
            limit: TREE_PAGE_SIZE,
            includeIgnored: true,
          });
          if (workspaceIdRef.current !== reqId) return;
          setTree((prev) => {
            const nextTree = appendTreeNodeChildren(prev, parentPath, page.children, page.nextOffset);
            writeCachedTree(filesTreeCacheKey(projectCacheKey, reqId), nextTree);
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
      });
    },
    [files, projectCacheKey, runSerializedTreeOp, setError, workspaceId, workspaceIdRef],
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

  return {
    tree,
    treeRef,
    setTree,
    expanded,
    setExpanded,
    loadingDirs,
    setLoadingDirs,
    decorationsTruncated,
    setDecorationsTruncated,
    refreshRoot,
    refreshLoadedDirectory,
    refreshTreeGitDecorations,
    loadDirectoryPath,
    loadMoreChildren,
    toggleDirectory,
  };
}
