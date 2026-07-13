import type { FileTreeNode, FilesWorkspace } from "../../../../shared/types";

/**
 * Bounded module-level caches for the Files workbench.
 *
 * These exist so re-opening Files renders the workspace roster + explorer tree
 * instantly (cached-first, then authoritative refresh). They used to be bare
 * unbounded Maps that grew with every visited project/workspace and survived
 * project-surface eviction — the `files-tree-caches-unbounded-across-projects`
 * audit finding. This module keeps the cached-first behavior but accounts for
 * every retained tree by node count and estimated bytes, pins the trees that
 * mounted workbenches are actively rendering (so eviction can never desync a
 * live explorer), and evicts least-recently-used unpinned trees once over
 * budget. Evicted trees reload through the normal `refreshRoot` path on the
 * next visit.
 *
 * Scope note: this cache holds ONLY explorer tree structure (`FileTreeNode`)
 * and the lightweight workspace roster. Monaco models, dirty buffers, undo
 * history, editor groups, and open tabs live in the editor-groups store /
 * model registry / dirty-buffer map and are never touched by this policy.
 */

/** Total FileTreeNode objects allowed across all cached trees. */
export const FILES_TREE_CACHE_NODE_BUDGET = 150_000;
/** Estimated retained bytes allowed across all cached trees (~48 MB). */
export const FILES_TREE_CACHE_BYTE_BUDGET = 48 * 1024 * 1024;
/** Workspace rosters kept across visited projects (small, bounded LRU). */
export const FILES_ROSTER_CACHE_MAX_PROJECTS = 12;

/** Estimated fixed overhead per FileTreeNode (object header + fields). */
const PER_NODE_OVERHEAD_BYTES = 96;

type TreeCacheEntry = {
  tree: FileTreeNode[];
  nodes: number;
  bytes: number;
  lastAccess: number;
};

type SubtreeStats = { nodes: number; bytes: number };

let accessCounter = 0;
let totalNodes = 0;
let totalBytes = 0;

const rosterCache = new Map<string, FilesWorkspace[]>();
const treeCache = new Map<string, TreeCacheEntry>();
const treePins = new Map<string, number>();

// Subtree stats memoized by children-array identity. The tree helpers use
// structural sharing (unchanged branches keep their identity), so re-measuring
// a refreshed tree only walks the branches that actually changed — never a
// synchronous full recount per file event.
const subtreeStatsMemo = new WeakMap<FileTreeNode[], SubtreeStats>();

function measureSubtree(nodes: FileTreeNode[]): SubtreeStats {
  const memo = subtreeStatsMemo.get(nodes);
  if (memo) return memo;
  let nodeCount = 0;
  let bytes = 0;
  for (const node of nodes) {
    nodeCount += 1;
    bytes += PER_NODE_OVERHEAD_BYTES + 2 * (node.name.length + node.path.length);
    if (node.children?.length) {
      const child = measureSubtree(node.children);
      nodeCount += child.nodes;
      bytes += child.bytes;
    }
  }
  const stats: SubtreeStats = { nodes: nodeCount, bytes };
  subtreeStatsMemo.set(nodes, stats);
  return stats;
}

// Key components are URI-encoded so the "::" delimiter can never occur inside
// a component: keys are injective and the prefix-based project release cannot
// cross ownership boundaries (e.g. a root path that itself contains "::").
const encodeKeyPart = (part: string): string => encodeURIComponent(part);

export function filesProjectCacheKey(
  binding: { kind: "remote"; targetId: string } | { kind: string } | null | undefined,
  projectRootPath: string,
): string {
  const bindingKey = binding?.kind === "remote"
    ? `remote:${(binding as { targetId: string }).targetId}`
    : "local";
  return `${encodeKeyPart(bindingKey)}::${encodeKeyPart(projectRootPath)}`;
}

export function filesTreeCacheKey(projectCacheKey: string, workspaceId: string): string {
  return `${projectCacheKey}::${encodeKeyPart(workspaceId)}`;
}

/* ---- Workspace roster (lightweight) ---- */

export function readCachedWorkspaces(projectCacheKey: string): FilesWorkspace[] {
  const cached = rosterCache.get(projectCacheKey);
  if (!cached) return [];
  // LRU touch: re-insert so eviction drops the stalest project first.
  rosterCache.delete(projectCacheKey);
  rosterCache.set(projectCacheKey, cached);
  return cached;
}

function projectHasPinnedTrees(projectCacheKey: string): boolean {
  const prefix = `${projectCacheKey}::`;
  for (const key of treePins.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export function writeCachedWorkspaces(projectCacheKey: string, workspaces: FilesWorkspace[]): void {
  rosterCache.delete(projectCacheKey);
  rosterCache.set(projectCacheKey, workspaces);
  if (rosterCache.size <= FILES_ROSTER_CACHE_MAX_PROJECTS) return;
  for (const key of rosterCache.keys()) {
    if (rosterCache.size <= FILES_ROSTER_CACHE_MAX_PROJECTS) break;
    if (key === projectCacheKey || projectHasPinnedTrees(key)) continue;
    rosterCache.delete(key);
  }
}

/* ---- Explorer trees (heavy, node/byte-accounted) ---- */

function removeTreeEntry(key: string): void {
  const entry = treeCache.get(key);
  if (!entry) return;
  treeCache.delete(key);
  totalNodes -= entry.nodes;
  totalBytes -= entry.bytes;
}

function evictOverBudget(): void {
  if (totalNodes <= FILES_TREE_CACHE_NODE_BUDGET && totalBytes <= FILES_TREE_CACHE_BYTE_BUDGET) return;
  const candidates = [...treeCache.entries()]
    .filter(([key]) => !treePins.has(key))
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (const [key] of candidates) {
    if (totalNodes <= FILES_TREE_CACHE_NODE_BUDGET && totalBytes <= FILES_TREE_CACHE_BYTE_BUDGET) return;
    removeTreeEntry(key);
  }
  // Pinned entries may keep us over budget — they are mounted explorers whose
  // trees the renderer holds anyway, so evicting the Map copy would save
  // nothing (duplicate residency) and only break cached-first remounts.
}

export function readCachedTree(treeKey: string): FileTreeNode[] | undefined {
  const entry = treeCache.get(treeKey);
  if (!entry) return undefined;
  entry.lastAccess = ++accessCounter;
  return entry.tree;
}

export function writeCachedTree(treeKey: string, tree: FileTreeNode[]): void {
  const stats = measureSubtree(tree);
  const previous = treeCache.get(treeKey);
  if (previous) {
    totalNodes -= previous.nodes;
    totalBytes -= previous.bytes;
  }
  treeCache.set(treeKey, {
    tree,
    nodes: stats.nodes,
    bytes: stats.bytes,
    lastAccess: ++accessCounter,
  });
  totalNodes += stats.nodes;
  totalBytes += stats.bytes;
  evictOverBudget();
}

/**
 * Pin a tree key while a mounted workbench renders it. Pinned trees are never
 * evicted: the mounted React state already retains the same nodes, so evicting
 * the cache copy cannot reclaim memory — it would only leave the Map and the
 * live explorer disagreeing.
 */
export function pinCachedTree(treeKey: string): void {
  treePins.set(treeKey, (treePins.get(treeKey) ?? 0) + 1);
}

export function unpinCachedTree(treeKey: string): void {
  const count = treePins.get(treeKey);
  if (count == null) return;
  if (count <= 1) {
    treePins.delete(treeKey);
    evictOverBudget();
    return;
  }
  treePins.set(treeKey, count - 1);
}

/**
 * Drop every cache owned by an evicted project surface. Pinned trees (a
 * workbench somewhere still rendering this project) are kept.
 */
export function releaseFilesProjectCaches(projectCacheKey: string): void {
  const prefix = `${projectCacheKey}::`;
  for (const key of [...treeCache.keys()]) {
    if (key.startsWith(prefix) && !treePins.has(key)) removeTreeEntry(key);
  }
  if (!projectHasPinnedTrees(projectCacheKey)) {
    rosterCache.delete(projectCacheKey);
  }
}

/** Introspection for tests, perf probes, and audits. */
export function filesTreeCacheStats(): {
  entries: number;
  nodes: number;
  estimatedBytes: number;
  pinnedKeys: string[];
  rosterProjects: number;
} {
  return {
    entries: treeCache.size,
    nodes: totalNodes,
    estimatedBytes: totalBytes,
    pinnedKeys: [...treePins.keys()],
    rosterProjects: rosterCache.size,
  };
}

export function resetFilesTreeCachesForTests(): void {
  rosterCache.clear();
  treeCache.clear();
  treePins.clear();
  totalNodes = 0;
  totalBytes = 0;
  accessCounter = 0;
}

// Debug hook so real-app perf probes can read cache pressure without a build.
declare global {
  interface Window {
    __adeFilesTreeCacheStats?: typeof filesTreeCacheStats;
  }
}
if (typeof window !== "undefined") {
  window.__adeFilesTreeCacheStats = filesTreeCacheStats;
}
