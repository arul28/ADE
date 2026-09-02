export type SubagentTreeIdentity = {
  taskId: string;
  agentId?: string;
  parentAgentId?: string | null;
  spawnDepth?: number;
  status?: "running" | "completed" | "failed" | "stopped";
  startTimestamp?: string;
  startedAt?: string;
};

export type SubagentTreeAnnotation = {
  depth: number;
  isLastSibling: boolean;
  /** Visible connector prefix such as `│  └ `. Empty for roots. */
  prefix: string;
  glyph: "├" | "└" | "";
  childIds: string[];
  descendantIds: string[];
};

const DEFAULT_TREE_CAP = 3;

function identityKey(node: SubagentTreeIdentity): string {
  return node.agentId?.trim() || node.taskId;
}

function parentKey(node: SubagentTreeIdentity): string | null {
  const parent = node.parentAgentId?.trim();
  return parent || null;
}

function spawnOrder(node: SubagentTreeIdentity): number {
  const stamp = node.startedAt ?? node.startTimestamp;
  if (!stamp) return 0;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function computedDepth(
  node: SubagentTreeIdentity,
  byId: Map<string, SubagentTreeIdentity>,
  cap: number,
): number {
  if (typeof node.spawnDepth === "number" && Number.isFinite(node.spawnDepth)) {
    return Math.max(0, Math.min(cap, Math.floor(node.spawnDepth)));
  }
  const seen = new Set<string>();
  let depth = 0;
  let current: SubagentTreeIdentity | undefined = node;
  while (current) {
    const parentId = parentKey(current);
    if (!parentId) break;
    const id = identityKey(current);
    if (seen.has(id)) break;
    seen.add(id);
    const parent = byId.get(parentId);
    if (!parent || parent === current) break;
    depth += 1;
    if (depth >= cap) break;
    current = parent;
  }
  return depth;
}

function collectDescendants(rootId: string, childrenByParent: Map<string, string[]>): string[] {
  const out: string[] = [];
  const stack = [...(childrenByParent.get(rootId) ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const children = childrenByParent.get(id);
    if (children) stack.push(...children);
  }
  return out;
}

function isFinished(status: SubagentTreeIdentity["status"] | undefined): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

/**
 * Preorder tree walk: newest roots first, children immediately under their
 * parent (newest sibling first). Connector glyphs are computed against that
 * visible order. SDK `spawn_depth` wins over a parentAgentId walk when present.
 */
export function annotateSubagentTree<T extends SubagentTreeIdentity>(
  snapshots: readonly T[],
  cap = DEFAULT_TREE_CAP,
): Array<{ node: T; tree: SubagentTreeAnnotation }> {
  const byId = new Map<string, T>();
  for (const snapshot of snapshots) {
    byId.set(identityKey(snapshot), snapshot);
  }
  const childrenByParent = new Map<string, string[]>();
  const roots: T[] = [];
  for (const snapshot of snapshots) {
    const parentId = parentKey(snapshot);
    if (parentId && byId.has(parentId) && parentId !== identityKey(snapshot)) {
      const children = childrenByParent.get(parentId) ?? [];
      children.push(identityKey(snapshot));
      childrenByParent.set(parentId, children);
    } else {
      roots.push(snapshot);
    }
  }
  const newestFirst = (leftId: string, rightId: string): number => {
    const left = byId.get(leftId);
    const right = byId.get(rightId);
    if (!left || !right) return 0;
    return spawnOrder(right) - spawnOrder(left);
  };
  for (const children of childrenByParent.values()) {
    children.sort(newestFirst);
  }
  roots.sort((left, right) => spawnOrder(right) - spawnOrder(left));

  const ordered: T[] = [];
  const visit = (node: T): void => {
    ordered.push(node);
    const children = childrenByParent.get(identityKey(node)) ?? [];
    for (const childId of children) {
      const child = byId.get(childId);
      if (child) visit(child);
    }
  };
  for (const root of roots) visit(root);

  const lastChildByParent = new Map<string, string>();
  for (const [parentId, children] of childrenByParent) {
    const last = children[children.length - 1];
    if (last) lastChildByParent.set(parentId, last);
  }

  return ordered.map((node) => {
    const id = identityKey(node);
    const parentId = parentKey(node);
    const depth = computedDepth(node, byId, cap);
    const isLastSibling = Boolean(parentId && lastChildByParent.get(parentId) === id);
    const glyph: SubagentTreeAnnotation["glyph"] = depth <= 0 ? "" : isLastSibling ? "└" : "├";
    const ancestorBars: string[] = [];
    if (depth > 0) {
      let current: T | undefined = node;
      const chain: boolean[] = [];
      while (current) {
        const currentParentId = parentKey(current);
        if (!currentParentId) break;
        const parent = byId.get(currentParentId);
        if (!parent) break;
        chain.push(lastChildByParent.get(currentParentId) === identityKey(current));
        current = parent;
      }
      chain.reverse();
      for (let index = 0; index < chain.length - 1; index += 1) {
        ancestorBars.push(chain[index] ? "   " : "│  ");
      }
    }
    const prefix = depth <= 0 ? "" : `${ancestorBars.join("")}${glyph} `;
    const childIds = childrenByParent.get(id) ?? [];
    return {
      node,
      tree: {
        depth,
        isLastSibling: depth > 0 && isLastSibling,
        prefix,
        glyph,
        childIds,
        descendantIds: collectDescendants(id, childrenByParent),
      },
    };
  });
}

/** Finished parent whose descendants are all finished: collapse the subtree. */
export function shouldAutoCollapseFinishedSubtree(node: SubagentTreeIdentity, descendantStatuses: SubagentTreeIdentity["status"][]): boolean {
  if (!isFinished(node.status)) return false;
  if (descendantStatuses.length === 0) return false;
  return descendantStatuses.every((status) => isFinished(status));
}
