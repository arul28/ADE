import type {
  FileTreeChangeStatus,
  FileTreeNode,
  FilesGitStatusEvent,
  FilesWorkspace,
} from "../../../shared/types";

/** Per-(project, lane) session key — the unit of tab/layout restore. */
export function filesSessionKey(projectRoot: string, laneId: string | null): string {
  return `${projectRoot}::${laneId ?? "__primary__"}`;
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

export function fileTreeNodeByPath(nodes: FileTreeNode[]): Map<string, FileTreeNode> {
  const out = new Map<string, FileTreeNode>();
  const walk = (items: FileTreeNode[]) => {
    for (const item of items) {
      out.set(item.path, item);
      if (item.children?.length) walk(item.children);
    }
  };
  walk(nodes);
  return out;
}

export function parentPathForFileChange(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  if (!normalized) return "";
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

export function hasLoadedDirectoryChildren(nodes: FileTreeNode[], directoryPath: string): boolean {
  if (!directoryPath) return true;
  const node = fileTreeNodeByPath(nodes).get(directoryPath);
  return node?.type === "directory" && Array.isArray(node.children);
}

export function loadedDirectoryChildrenCount(nodes: FileTreeNode[], directoryPath: string): number {
  if (!directoryPath) return nodes.length;
  const node = fileTreeNodeByPath(nodes).get(directoryPath);
  return node?.type === "directory" && Array.isArray(node.children) ? node.children.length : 0;
}

/** Merge a freshly-fetched root listing while keeping already-loaded subtrees. */
export function mergeTreePreservingLoadedChildren(
  nextNodes: FileTreeNode[],
  previousNodes: FileTreeNode[],
): FileTreeNode[] {
  const previousByPath = fileTreeNodeByPath(previousNodes);
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

/** Replace a directory node's children (used by paginated lazy expansion). */
export function replaceTreeNodeChildren(
  nodes: FileTreeNode[],
  parentPath: string,
  children: FileTreeNode[],
  loadMoreOffset: number | null = null,
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.path === parentPath) {
      return { ...node, children, loadMoreOffset, childrenTruncated: loadMoreOffset != null };
    }
    if (node.children?.length) {
      return { ...node, children: replaceTreeNodeChildren(node.children, parentPath, children, loadMoreOffset) };
    }
    return node;
  });
}

/** Append another page of children to a directory node. */
export function appendTreeNodeChildren(
  nodes: FileTreeNode[],
  parentPath: string,
  children: FileTreeNode[],
  loadMoreOffset: number | null = null,
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.path === parentPath) {
      const existing = node.children ?? [];
      const seen = new Set(existing.map((child) => child.path));
      const merged = [...existing];
      for (const child of children) {
        if (seen.has(child.path)) continue;
        seen.add(child.path);
        merged.push(child);
      }
      return { ...node, children: merged, loadMoreOffset, childrenTruncated: loadMoreOffset != null };
    }
    if (node.children?.length) {
      return { ...node, children: appendTreeNodeChildren(node.children, parentPath, children, loadMoreOffset) };
    }
    return node;
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
