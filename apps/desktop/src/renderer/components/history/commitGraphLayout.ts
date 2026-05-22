import type { GitCommitSummary } from "../../../shared/types";

/** Graph row height in px (matches CommitHistoryView). */
export const COMMIT_ROW_HEIGHT = 36;
export const COMMIT_GRAPH_COL_WIDTH = 14;
export const COMMIT_GRAPH_PAD_LEFT = 8;

export type CommitGraphNode = {
  sha: string;
  rowIndex: number;
  column: number;
  isMerge: boolean;
  isHead: boolean;
  commit: GitCommitSummary;
};

export type CommitGraphEdge = {
  id: string;
  fromSha: string;
  toSha: string;
  /** Parent column at child row */
  fromCol: number;
  toCol: number;
  fromRow: number;
  toRow: number;
  kind: "parent" | "merge";
};

export type CommitGraphLayout = {
  nodes: CommitGraphNode[];
  edges: CommitGraphEdge[];
  columnCount: number;
  graphWidth: number;
  totalHeight: number;
  shaToRow: Map<string, number>;
};

/**
 * Assign DAG columns for a newest-first commit list (git log order).
 * Follows first-parent on the main line; branches and merges get extra columns.
 */
export function buildCommitGraphLayout(
  commitsNewestFirst: GitCommitSummary[],
): CommitGraphLayout {
  if (commitsNewestFirst.length === 0) {
    return {
      nodes: [],
      edges: [],
      columnCount: 0,
      graphWidth: 0,
      totalHeight: 0,
      shaToRow: new Map(),
    };
  }

  const oldestFirst = [...commitsNewestFirst].reverse();
  const shaToCommit = new Map(commitsNewestFirst.map((c) => [c.sha, c]));
  const shaToCol = new Map<string, number>();
  const activeCols = new Set<number>();
  let nextFreeCol = 0;

  function allocCol(): number {
    while (activeCols.has(nextFreeCol)) nextFreeCol += 1;
    const col = nextFreeCol;
    activeCols.add(col);
    nextFreeCol += 1;
    return col;
  }

  for (const commit of oldestFirst) {
    const parents = commit.parents.filter((p) => shaToCommit.has(p));
    let col: number;

    if (parents.length === 0) {
      col = allocCol();
    } else if (parents.length === 1) {
      const parentCol = shaToCol.get(parents[0]);
      col = parentCol ?? allocCol();
    } else {
      const parentCols = parents
        .map((p) => shaToCol.get(p))
        .filter((c): c is number => c !== undefined);
      col = parentCols.length > 0 ? Math.min(...parentCols) : allocCol();
      for (const pCol of parentCols) {
        if (pCol !== col) activeCols.delete(pCol);
      }
    }

    shaToCol.set(commit.sha, col);
  }

  const maxCol = Math.max(0, ...shaToCol.values());
  const columnCount = maxCol + 1;
  const graphWidth =
    COMMIT_GRAPH_PAD_LEFT + columnCount * COMMIT_GRAPH_COL_WIDTH + 8;

  const shaToRow = new Map<string, number>();
  const nodes: CommitGraphNode[] = commitsNewestFirst.map((commit, rowIndex) => {
    shaToRow.set(commit.sha, rowIndex);
    return {
      sha: commit.sha,
      rowIndex,
      column: shaToCol.get(commit.sha) ?? 0,
      isMerge: commit.parents.length > 1,
      isHead: rowIndex === 0,
      commit,
    };
  });

  const edges: CommitGraphEdge[] = [];
  for (const node of nodes) {
    for (let pi = 0; pi < node.commit.parents.length; pi += 1) {
      const parentSha = node.commit.parents[pi];
      const parentRow = shaToRow.get(parentSha);
      if (parentRow === undefined) continue;
      const parentCol = shaToCol.get(parentSha) ?? 0;
      edges.push({
        id: `${node.sha}-${parentSha}-${pi}`,
        fromSha: node.sha,
        toSha: parentSha,
        fromCol: node.column,
        toCol: parentCol,
        fromRow: node.rowIndex,
        toRow: parentRow,
        kind: pi === 0 ? "parent" : "merge",
      });
    }
  }

  return {
    nodes,
    edges,
    columnCount,
    graphWidth,
    totalHeight: commitsNewestFirst.length * COMMIT_ROW_HEIGHT,
    shaToRow,
  };
}

/** SVG path from child row to parent row between two columns. */
export function commitEdgePath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): string {
  if (fromX === toX) {
    return `M${fromX} ${fromY} L${toX} ${toY}`;
  }
  const midY = (fromY + toY) / 2;
  return `M${fromX} ${fromY} C${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`;
}

export function columnCenterX(column: number): number {
  return COMMIT_GRAPH_PAD_LEFT + column * COMMIT_GRAPH_COL_WIDTH + COMMIT_GRAPH_COL_WIDTH / 2;
}

export function rowCenterY(rowIndex: number): number {
  return rowIndex * COMMIT_ROW_HEIGHT + COMMIT_ROW_HEIGHT / 2;
}
