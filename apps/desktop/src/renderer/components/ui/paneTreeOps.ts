/* ---- Layout tree types ---- */

export type PaneLeaf = {
  type: "pane";
  id: string;
};

export type PaneSplit = {
  type: "split";
  direction: "horizontal" | "vertical";
  children: PaneLayoutEntry[];
};

export type PaneLayoutEntry = {
  node: PaneLeaf | PaneSplit;
  defaultSize?: number;
  minSize?: number;
};

export type DropEdge = "top" | "bottom" | "left" | "right" | "center";

/* ---- Collect all leaf IDs from a tree ---- */

export function collectLeafIds(node: PaneLeaf | PaneSplit): string[] {
  if (node.type === "pane") return [node.id];
  return node.children.flatMap((c) => collectLeafIds(c.node));
}

/* ---- Drop edge detection ---- */

export function detectDropEdge(
  rect: DOMRect,
  clientX: number,
  clientY: number
): DropEdge {
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  const threshold = 0.25;

  if (relY < threshold) return "top";
  if (relY > 1 - threshold) return "bottom";
  if (relX < threshold) return "left";
  if (relX > 1 - threshold) return "right";
  return "center";
}

/* ---- Remove a leaf from the tree ---- */

export function removePaneFromTree(
  node: PaneLeaf | PaneSplit,
  paneId: string
): PaneLeaf | PaneSplit | null {
  if (node.type === "pane") {
    return node.id === paneId ? null : node;
  }

  const filtered: PaneLayoutEntry[] = [];
  for (const child of node.children) {
    const result = removePaneFromTree(child.node, paneId);
    if (result != null) {
      filtered.push({ ...child, node: result });
    }
  }

  if (filtered.length === 0) return null;
  if (filtered.length === 1) return filtered[0]!.node;
  return { ...node, children: filtered };
}

/* ---- Flatten single-child splits ---- */

export function flattenSingleChildSplits(
  node: PaneLeaf | PaneSplit
): PaneLeaf | PaneSplit {
  if (node.type === "pane") return node;

  const simplified = node.children.map((child) => ({
    ...child,
    node: flattenSingleChildSplits(child.node)
  }));

  if (simplified.length === 1) return simplified[0]!.node;
  return { ...node, children: simplified };
}

function coercePaneNodeToSplit(
  node: PaneLeaf | PaneSplit,
  direction: PaneSplit["direction"]
): PaneSplit {
  if (node.type === "split") return node;
  return {
    type: "split",
    direction,
    children: [{ node, defaultSize: 100, minSize: 5 }]
  };
}

function perpendicular(direction: PaneSplit["direction"]): PaneSplit["direction"] {
  return direction === "horizontal" ? "vertical" : "horizontal";
}

type LeafCandidate = {
  id: string;
  parentDirection: PaneSplit["direction"] | null;
  weight: number;
};

function collectLeafCandidates(
  node: PaneLeaf | PaneSplit,
  parentDirection: PaneSplit["direction"] | null,
  weight: number
): LeafCandidate[] {
  if (node.type === "pane") {
    return [{ id: node.id, parentDirection, weight }];
  }

  const defaultWeight = weight / Math.max(1, node.children.length);
  return node.children.flatMap((child) => {
    const nextWeight = child.defaultSize != null ? (weight * child.defaultSize) / 100 : defaultWeight;
    return collectLeafCandidates(child.node, node.direction, nextWeight);
  });
}

function insertPaneIntoLargestLeaf(
  tree: PaneSplit,
  paneId: string,
  fallbackDirection: PaneSplit["direction"]
): PaneSplit {
  let target: LeafCandidate | null = null;
  for (const candidate of collectLeafCandidates(tree, null, 100)) {
    if (target == null || candidate.weight > target.weight) target = candidate;
  }
  if (!target) return tree;

  const direction = target.parentDirection == null
    ? fallbackDirection
    : perpendicular(target.parentDirection);

  return replaceLeaf(tree, target.id, {
    type: "split",
    direction,
    children: [
      { node: { type: "pane", id: target.id }, defaultSize: 50, minSize: 5 },
      { node: { type: "pane", id: paneId }, defaultSize: 50, minSize: 5 },
    ],
  });
}

export function reconcilePaneTree(
  tree: PaneLeaf | PaneSplit,
  expectedPaneIds: string[],
  fallback: PaneSplit
): PaneSplit {
  const expected = new Set(expectedPaneIds);
  let pruned: PaneLeaf | PaneSplit | null = tree;
  for (const paneId of collectLeafIds(tree)) {
    if (pruned == null) break;
    if (!expected.has(paneId)) pruned = removePaneFromTree(pruned, paneId);
  }
  if (pruned == null) return fallback;

  const flattened = flattenSingleChildSplits(pruned);
  const present = new Set<string>();
  for (const paneId of collectLeafIds(flattened)) {
    if (!expected.has(paneId) || present.has(paneId)) return fallback;
    present.add(paneId);
  }

  const missing = expectedPaneIds.filter((paneId) => !present.has(paneId));
  const base = coercePaneNodeToSplit(flattened, fallback.direction);
  if (missing.length === 0) return base;

  const withInserts = missing.reduce(
    (current, paneId) => insertPaneIntoLargestLeaf(current, paneId, fallback.direction),
    base,
  );
  return coercePaneNodeToSplit(flattenSingleChildSplits(withInserts), fallback.direction);
}

/* ---- Split a pane at an edge ---- */

export function splitPaneAtEdge(
  tree: PaneSplit,
  targetId: string,
  draggedId: string,
  edge: Exclude<DropEdge, "center">
): PaneSplit {
  const direction: PaneSplit["direction"] =
    edge === "left" || edge === "right" ? "horizontal" : "vertical";

  // Step 1: Remove dragged pane from the tree
  const pruned = removePaneFromTree(tree, draggedId);
  if (pruned == null) return tree;
  const cleanTree = coercePaneNodeToSplit(flattenSingleChildSplits(pruned), direction);

  // Step 2: Replace target leaf with a new split containing both panes
  const draggedEntry: PaneLayoutEntry = {
    node: { type: "pane", id: draggedId },
    defaultSize: 50,
    minSize: 5
  };

  const targetEntry: PaneLayoutEntry = {
    node: { type: "pane", id: targetId },
    defaultSize: 50,
    minSize: 5
  };

  const firstIsTarget = edge === "bottom" || edge === "right";
  const children = firstIsTarget
    ? [targetEntry, draggedEntry]
    : [draggedEntry, targetEntry];

  const newSplit: PaneSplit = { type: "split", direction, children };

  return replaceLeaf(cleanTree, targetId, newSplit);
}

/* ---- Replace a leaf node by id ---- */

function replaceLeaf(
  node: PaneLeaf | PaneSplit,
  targetId: string,
  replacement: PaneSplit
): PaneSplit {
  if (node.type === "pane") {
    // This shouldn't normally be the root call, but handle it gracefully
    return node.id === targetId
      ? replacement
      : {
          type: "split",
          direction: "horizontal",
          children: [{ node, defaultSize: 100, minSize: 5 }],
        };
  }

  return {
    ...node,
    children: node.children.map((child) => {
      if (child.node.type === "pane" && child.node.id === targetId) {
        return { ...child, node: replacement };
      }
      if (child.node.type === "split") {
        return { ...child, node: replaceLeaf(child.node, targetId, replacement) };
      }
      return child;
    })
  };
}

/* ---- Swap two pane IDs ---- */

export function swapPanes(
  node: PaneLeaf | PaneSplit,
  idA: string,
  idB: string
): PaneLeaf | PaneSplit {
  if (node.type === "pane") {
    if (node.id === idA) return { ...node, id: idB };
    if (node.id === idB) return { ...node, id: idA };
    return node;
  }

  return {
    ...node,
    children: node.children.map((child) => ({
      ...child,
      node: swapPanes(child.node, idA, idB)
    }))
  };
}

/* ---- Validate a persisted tree against expected pane IDs ---- */

export function isValidTree(
  tree: PaneSplit,
  expectedPaneIds: string[]
): boolean {
  const leafIds = collectLeafIds(tree);
  if (leafIds.length !== expectedPaneIds.length) return false;
  const expected = new Set(expectedPaneIds);
  const actual = new Set(leafIds);
  if (actual.size !== expected.size) return false;
  for (const id of expected) {
    if (!actual.has(id)) return false;
  }
  return true;
}
