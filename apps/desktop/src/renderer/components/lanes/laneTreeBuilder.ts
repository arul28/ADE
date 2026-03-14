import type { PaneLeaf, PaneSplit, PaneLayoutEntry } from "../ui/paneTreeOps";

/**
 * Recursively prune hidden pane leaves from the PaneSplit tree.
 * Collapses single-child splits so the layout stays clean.
 */
export function buildVisibleTree(
  node: PaneLeaf | PaneSplit,
  visiblePanes: Set<string>
): PaneLeaf | PaneSplit | null {
  if (node.type === "pane") {
    return visiblePanes.has(node.id) ? node : null;
  }

  const filtered: PaneLayoutEntry[] = [];
  for (const entry of node.children) {
    const pruned = buildVisibleTree(entry.node, visiblePanes);
    if (pruned) {
      filtered.push({ ...entry, node: pruned });
    }
  }

  if (filtered.length === 0) return null;

  if (filtered.length === 1) {
    const only = filtered[0]!.node;
    if (only.type === "split") return only;
    return only;
  }

  // Redistribute default sizes evenly among remaining children
  const totalSize = filtered.reduce((acc, e) => acc + (e.defaultSize ?? 50), 0);
  const redistributed = filtered.map((e) => ({
    ...e,
    defaultSize: totalSize > 0 ? ((e.defaultSize ?? 50) / totalSize) * 100 : 100 / filtered.length
  }));

  return {
    type: "split",
    direction: node.direction,
    children: redistributed
  };
}
