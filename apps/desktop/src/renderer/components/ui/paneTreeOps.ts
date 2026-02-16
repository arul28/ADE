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

/* ---- Split a pane at an edge ---- */

export function splitPaneAtEdge(
  tree: PaneSplit,
  targetId: string,
  draggedId: string,
  edge: Exclude<DropEdge, "center">
): PaneSplit {
  // Step 1: Remove dragged pane from the tree
  const pruned = removePaneFromTree(tree, draggedId);
  if (pruned == null || pruned.type === "pane") return tree;
  const cleanTree = flattenSingleChildSplits(pruned) as PaneSplit;

  // Step 2: Replace target leaf with a new split containing both panes
  const direction: "horizontal" | "vertical" =
    edge === "left" || edge === "right" ? "horizontal" : "vertical";

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
    return node.id === targetId ? replacement : { type: "split", direction: "horizontal", children: [{ node }] };
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
