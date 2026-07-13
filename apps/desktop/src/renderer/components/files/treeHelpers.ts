import type {
  FileTreeChangeStatus,
  FileTreeNode,
  FilesGitStatusEvent,
  FilesWorkspace,
} from "../../../shared/types";

/** Per-(project, lane) session key — legacy; used only for migration. */
export function filesSessionKey(projectRoot: string, laneId: string | null): string {
  return `${projectRoot}::${laneId ?? "__primary__"}`;
}

/** Project-level session key — unified tab store across all lanes. */
export function filesProjectSessionKey(projectRoot: string): string {
  return JSON.stringify({ kind: "files-project-session", projectRoot });
}

/**
 * Resolve which workspace a lane should show: the lane's own worktree first,
 * then any workspace bound to that lane, then the first available, then any.
 */
export function defaultFilesWorkspaceId(
  workspaces: FilesWorkspace[],
  preferredLaneId: string | null,
  unavailableWorkspaceIds: ReadonlySet<string> = new Set(),
): string {
  const available = workspaces.filter((w) => !unavailableWorkspaceIds.has(w.id));
  if (preferredLaneId) {
    const laneWorkspace =
      available.find((w) => w.kind !== "primary" && w.laneId === preferredLaneId) ??
      available.find((w) => w.laneId === preferredLaneId);
    if (laneWorkspace) return laneWorkspace.id;
  }
  return available[0]?.id ?? workspaces[0]?.id ?? "";
}

export function formatFilesError(err: unknown, fallback = "File operation failed."): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  return (
    raw
      .replace(/^Error invoking remote method '[^']+':\s*/i, "")
      .replace(/^Error:\s*/i, "")
      .trim() || fallback
  );
}

export function isUnavailableGitDecorationsError(err: unknown): boolean {
  const message = formatFilesError(err);
  return /file\.refreshGitDecorations/i.test(message)
    && /not callable|not exposed|unavailable|not a function|not implemented|not found|no .*handler|missing .*handler|handler missing|does not exist/i.test(message);
}

export function isMissingWorkspaceRootError(message: string): boolean {
  return /(?:ENOENT|no such file or directory|worktree is missing|workspace is missing)/i.test(message);
}

function findFileTreeNodeByPath(nodes: FileTreeNode[], nodePath: string): FileTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === nodePath) return node;
    if (node.children?.length) {
      const child = findFileTreeNodeByPath(node.children, nodePath);
      if (child) return child;
    }
  }
  return undefined;
}

export function parentPathForFileChange(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  if (!normalized) return "";
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function isAncestorDirectoryPath(ancestorPath: string, childPath: string): boolean {
  if (ancestorPath === childPath) return false;
  if (!ancestorPath) return Boolean(childPath);
  return childPath.startsWith(`${ancestorPath}/`);
}

export function hasAncestorDirectoryPath(directoryPath: string, paths: readonly string[]): boolean {
  return paths.some((path) => isAncestorDirectoryPath(path, directoryPath));
}

export function hasLoadedDirectoryChildren(nodes: FileTreeNode[], directoryPath: string): boolean {
  if (!directoryPath) return true;
  const node = findFileTreeNodeByPath(nodes, directoryPath);
  return node?.type === "directory" && Array.isArray(node.children);
}

export function nearestLoadedAncestorDirectoryPath(nodes: FileTreeNode[], directoryPath: string): string {
  let current = directoryPath.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  for (;;) {
    if (hasLoadedDirectoryChildren(nodes, current)) return current;
    if (!current) return "";
    const index = current.lastIndexOf("/");
    current = index > 0 ? current.slice(0, index) : "";
  }
}

export function loadedDirectoryChildrenCount(nodes: FileTreeNode[], directoryPath: string): number {
  if (!directoryPath) return nodes.length;
  const node = findFileTreeNodeByPath(nodes, directoryPath);
  return node?.type === "directory" && Array.isArray(node.children) ? node.children.length : 0;
}

/** Current "Load more" cursor for a directory, or undefined when not truncated. */
export function directoryLoadMoreOffset(nodes: FileTreeNode[], directoryPath: string): number | undefined {
  const node = findFileTreeNodeByPath(nodes, directoryPath);
  return node?.type === "directory" && node.loadMoreOffset != null ? node.loadMoreOffset : undefined;
}

/** Merge a freshly-fetched root listing while keeping already-loaded subtrees. */
export function mergeTreePreservingLoadedChildren(
  nextNodes: FileTreeNode[],
  previousNodes: FileTreeNode[],
): FileTreeNode[] {
  // Only direct roots are looked up, so a shallow map is enough — walking every
  // loaded descendant here made each root refresh O(total loaded nodes).
  const previousByPath = new Map(previousNodes.map((node) => [node.path, node]));
  return nextNodes.map((node) => {
    if (node.type !== "directory") return node;
    const previous = previousByPath.get(node.path);
    if (!previous?.children || node.children) return node;
    return {
      ...node,
      children: previous.children,
      childrenTruncated: previous.childrenTruncated,
      loadMoreOffset: previous.loadMoreOffset,
    };
  });
}

function mergeChildrenPreservingLoadedDescendants(
  nextChildren: FileTreeNode[],
  previousChildren: FileTreeNode[] = [],
): FileTreeNode[] {
  const previousByPath = new Map(previousChildren.map((child) => [child.path, child]));
  return nextChildren.map((child) => {
    if (child.type !== "directory" || child.children) return child;
    const previous = previousByPath.get(child.path);
    if (!previous?.children) return child;
    return {
      ...child,
      children: previous.children,
      childrenTruncated: previous.childrenTruncated,
      loadMoreOffset: previous.loadMoreOffset,
    };
  });
}

/**
 * Clone only the branch that leads to `targetPath` and apply `update` to the
 * matching directory node. Every sibling branch keeps its identity so React
 * (and cache accounting) can skip untouched subtrees; previously these
 * helpers cloned every loaded directory in the tree on each refresh.
 */
function updateTreeNodeAtPath(
  nodes: FileTreeNode[],
  targetPath: string,
  update: (node: FileTreeNode) => FileTreeNode,
): FileTreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.path === targetPath) {
      changed = true;
      return update(node);
    }
    if (node.children?.length && targetPath.startsWith(`${node.path}/`)) {
      const nextChildren = updateTreeNodeAtPath(node.children, targetPath, update);
      if (nextChildren !== node.children) {
        changed = true;
        return { ...node, children: nextChildren };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

/** Replace a directory node's children (used by paginated lazy expansion). */
export function replaceTreeNodeChildren(
  nodes: FileTreeNode[],
  parentPath: string,
  children: FileTreeNode[],
  loadMoreOffset: number | null = null,
): FileTreeNode[] {
  return updateTreeNodeAtPath(nodes, parentPath, (node) => ({
    ...node,
    children: mergeChildrenPreservingLoadedDescendants(children, node.children),
    loadMoreOffset,
    childrenTruncated: loadMoreOffset != null,
  }));
}

/** Append another page of children to a directory node. */
export function appendTreeNodeChildren(
  nodes: FileTreeNode[],
  parentPath: string,
  children: FileTreeNode[],
  loadMoreOffset: number | null = null,
): FileTreeNode[] {
  return updateTreeNodeAtPath(nodes, parentPath, (node) => {
    const existing = node.children ?? [];
    const seen = new Set(existing.map((child) => child.path));
    const merged = [...existing];
    for (const child of children) {
      if (seen.has(child.path)) continue;
      seen.add(child.path);
      merged.push(child);
    }
    return { ...node, children: merged, loadMoreOffset, childrenTruncated: loadMoreOffset != null };
  });
}

/**
 * Apply a resolved Git decoration snapshot onto the loaded tree without
 * refetching structure. `directories` already includes every ancestor of a
 * changed file, so a flat lookup is sufficient. Node identity is preserved when
 * a node's status is unchanged so React can skip re-rendering it.
 */
export function applyGitStatusToTree(nodes: FileTreeNode[], event: FilesGitStatusEvent): FileTreeNode[] {
  const fileStatus = new Map<string, FileTreeChangeStatus>();
  for (const entry of event.files) fileStatus.set(entry.path, entry.changeStatus);
  const dirStatus = new Map<string, FileTreeChangeStatus>();
  for (const entry of event.directories) dirStatus.set(entry.path, entry.changeStatus);

  const walk = (items: FileTreeNode[]): FileTreeNode[] => {
    let changed = false;
    const next = items.map((node) => {
      const nextStatus: FileTreeChangeStatus =
        node.type === "directory"
          ? fileStatus.get(node.path) ?? dirStatus.get(node.path) ?? null
          : fileStatus.get(node.path) ?? null;
      const nextChildren = node.children?.length ? walk(node.children) : node.children;
      if (node.changeStatus === nextStatus && nextChildren === node.children) return node;
      changed = true;
      return { ...node, changeStatus: nextStatus, children: nextChildren };
    });
    return changed ? next : items;
  };

  return walk(nodes);
}
