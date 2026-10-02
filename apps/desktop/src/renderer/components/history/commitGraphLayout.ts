import type { GitCommitSummary } from "../../../shared/types";

/** Graph row height in px (matches CommitHistoryView). */
export const COMMIT_ROW_HEIGHT = 30;
export const COMMIT_GRAPH_COL_WIDTH = 14;
export const COMMIT_GRAPH_PAD_LEFT = 10;

/** A commit as the graph sees it: parents may be rewritten by `contractCommitGraph`. */
export type GraphCommit = {
  commit: GitCommitSummary;
  parents: string[];
  /** Per parent: how many hidden commits the edge to it stands for. */
  folded: number[];
};

export type CommitGraphNode = {
  sha: string;
  rowIndex: number;
  column: number;
  isMerge: boolean;
  commit: GitCommitSummary;
};

export type CommitGraphEdge = {
  id: string;
  fromSha: string;
  /** Parent sha; may be outside the loaded window (`open`). */
  toSha: string;
  fromRow: number;
  fromCol: number;
  /** The column the edge runs down between its two rows. */
  laneCol: number;
  /** Parent row, or the row count when the parent is not loaded. */
  toRow: number;
  toCol: number;
  kind: "parent" | "merge";
  /** The parent is below the loaded window: the edge runs off the bottom. */
  open: boolean;
  /** Hidden commits this edge stands for (folding or search). */
  folded: number;
};

export type CommitGraphLayout = {
  nodes: CommitGraphNode[];
  edges: CommitGraphEdge[];
  columnCount: number;
  graphWidth: number;
  totalHeight: number;
  shaToRow: Map<string, number>;
  /** A divider band below `afterRow` (-1: above the first row), where a lane meets its base; or null. */
  gap: { afterRow: number; height: number } | null;
  /** Top y of a row, the gap included. */
  rowTop: (row: number) => number;
  /** Centre y of a row, the gap included. */
  rowCenter: (row: number) => number;
};

export type CommitGraphLayoutOptions = {
  /** A commit whose line owns column 0 from the top (the base branch tip), so the trunk stays leftmost. */
  trunkSha?: string | null;
  /** Open a band of `gapHeight` px below this row (-1: above the first); lines run through it. */
  gapAfterRow?: number | null;
  gapHeight?: number;
};

function rowGeometry(gap: CommitGraphLayout["gap"]) {
  const rowTop = (row: number) => row * COMMIT_ROW_HEIGHT + (gap && row > gap.afterRow ? gap.height : 0);
  return { rowTop, rowCenter: (row: number) => rowTop(row) + COMMIT_ROW_HEIGHT / 2 };
}

export function toGraphCommits(commits: readonly GitCommitSummary[]): GraphCommit[] {
  return commits.map((commit) => ({
    commit,
    parents: commit.parents,
    folded: commit.parents.map(() => 0),
  }));
}

/**
 * Hide commits without breaking the graph: every kept commit's parents are
 * rewritten to the nearest kept ancestors through the hidden ones, and each
 * rewritten edge records how many hidden commits it skips (first-parent
 * count). Parents outside the loaded window stay as they are, so the edge
 * still runs off the bottom.
 *
 * Expects git's newest-first order where a child comes before its parents
 * (`--date-order`); a parent seen out of that order is treated as unloaded.
 */
export function contractCommitGraph(
  commitsNewestFirst: readonly GitCommitSummary[],
  keep: (commit: GitCommitSummary, index: number) => boolean,
): GraphCommit[] {
  const indexBySha = new Map<string, number>();
  commitsNewestFirst.forEach((commit, index) => indexBySha.set(commit.sha, index));
  const kept = commitsNewestFirst.map((commit, index) => keep(commit, index));

  // For each hidden commit: the kept (or unloaded) ancestors it leads to, and
  // how many hidden commits sit on its first-parent run including itself.
  // Parents come later in the list, so walking oldest-first resolves them first.
  const resolved = new Map<string, { targets: string[]; hops: number }>();
  const MAX_TARGETS = 8;
  for (let index = commitsNewestFirst.length - 1; index >= 0; index -= 1) {
    if (kept[index]) continue;
    const commit = commitsNewestFirst[index]!;
    const targets: string[] = [];
    let hops = 1;
    commit.parents.forEach((parent, parentIndex) => {
      const parentIdx = indexBySha.get(parent);
      const hidden = parentIdx != null && parentIdx > index && !kept[parentIdx];
      const via = hidden ? resolved.get(parent) : null;
      const next = via ? via.targets : [parent];
      for (const target of next) {
        if (targets.length < MAX_TARGETS && !targets.includes(target)) targets.push(target);
      }
      if (parentIndex === 0 && via) hops += via.hops;
    });
    resolved.set(commit.sha, { targets, hops });
  }

  const out: GraphCommit[] = [];
  commitsNewestFirst.forEach((commit, index) => {
    if (!kept[index]) return;
    const parents: string[] = [];
    const folded: number[] = [];
    for (const parent of commit.parents) {
      const parentIdx = indexBySha.get(parent);
      const via = parentIdx != null && parentIdx > index && !kept[parentIdx] ? resolved.get(parent) : null;
      if (!via) {
        if (!parents.includes(parent)) {
          parents.push(parent);
          folded.push(0);
        }
        continue;
      }
      via.targets.forEach((target, targetIndex) => {
        if (parents.includes(target)) return;
        parents.push(target);
        // Only the first-parent run is counted; a fan-out past a hidden merge
        // is still marked as folded.
        folded.push(targetIndex === 0 ? via.hops : 1);
      });
    }
    out.push({ commit, parents, folded });
  });
  return out;
}

/**
 * Which commits "Branch tips" keeps: branch tips (any ref), merges, roots,
 * branch points (more than one loaded child), and any sha the caller pins
 * (HEAD, the selection). Linear runs between them fold away.
 */
export function branchTipKeep(
  commitsNewestFirst: readonly GitCommitSummary[],
  refShas: ReadonlySet<string>,
  pinned: ReadonlySet<string>,
): (commit: GitCommitSummary) => boolean {
  const loaded = new Set(commitsNewestFirst.map((commit) => commit.sha));
  const childCount = new Map<string, number>();
  for (const commit of commitsNewestFirst) {
    for (const parent of commit.parents) {
      if (loaded.has(parent)) childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    }
  }
  return (commit) =>
    refShas.has(commit.sha)
    || pinned.has(commit.sha)
    || commit.parents.length !== 1
    || (childCount.get(commit.sha) ?? 0) > 1
    // The oldest loaded commit of a run keeps the edge into unloaded history.
    || !loaded.has(commit.parents[0]!);
}

/**
 * Columns for a newest-first commit list. Each column holds the sha it is
 * waiting for; a commit takes the leftmost column waiting for it (or a free
 * one when nothing is: a branch tip), its first parent continues in that
 * column, and further parents join a column already waiting for them or open
 * a new one. Columns free up when the commit they wait for arrives, and are
 * reused, so the graph stays as narrow as the history allows.
 */
export function buildCommitGraphLayout(
  rows: readonly GraphCommit[],
  options: CommitGraphLayoutOptions = {},
): CommitGraphLayout {
  const trunkSha = options.trunkSha ?? null;

  const shaToRow = new Map<string, number>();
  rows.forEach((row, index) => shaToRow.set(row.commit.sha, index));

  const lanes: Array<string | null> = trunkSha && shaToRow.has(trunkSha) ? [trunkSha] : [];
  const nodes: CommitGraphNode[] = [];
  const pending: Array<Omit<CommitGraphEdge, "toRow" | "toCol" | "open">> = [];
  let maxCols = 0;

  const freeColumn = (): number => {
    const index = lanes.indexOf(null);
    if (index >= 0) return index;
    lanes.push(null);
    return lanes.length - 1;
  };

  rows.forEach((row, rowIndex) => {
    const sha = row.commit.sha;
    let column = -1;
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] !== sha) continue;
      if (column < 0) column = i;
      lanes[i] = null;
    }
    if (column < 0) column = freeColumn();
    lanes[column] = null;

    row.parents.forEach((parent, parentIndex) => {
      const waiting = lanes.indexOf(parent);
      let laneCol: number;
      if (parentIndex === 0 && (waiting < 0 || waiting > column)) {
        // The first parent stays in this column, so a trunk stays straight;
        // a lane further right waiting for the same parent joins it there.
        laneCol = column;
        lanes[column] = parent;
      } else if (waiting >= 0) {
        laneCol = waiting;
      } else {
        laneCol = freeColumn();
        lanes[laneCol] = parent;
      }
      pending.push({
        id: `${sha}-${parent}-${parentIndex}`,
        fromSha: sha,
        toSha: parent,
        fromRow: rowIndex,
        fromCol: column,
        laneCol,
        kind: parentIndex === 0 ? "parent" : "merge",
        folded: row.folded[parentIndex] ?? 0,
      });
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] == null) lanes.pop();
    maxCols = Math.max(maxCols, column + 1, lanes.length);
    nodes.push({
      sha,
      rowIndex,
      column,
      isMerge: row.parents.length > 1,
      commit: row.commit,
    });
  });

  const edges: CommitGraphEdge[] = pending.map((edge) => {
    const parentRow = shaToRow.get(edge.toSha);
    if (parentRow == null || parentRow <= edge.fromRow) {
      return { ...edge, toRow: rows.length, toCol: edge.laneCol, open: true };
    }
    return { ...edge, toRow: parentRow, toCol: nodes[parentRow]!.column, open: false };
  });

  const columnCount = maxCols;
  const gapAfter = options.gapAfterRow;
  const gap = gapAfter != null && gapAfter >= -1 && gapAfter < rows.length - 1 && (options.gapHeight ?? 0) > 0
    ? { afterRow: gapAfter, height: options.gapHeight! }
    : null;
  const geometry = rowGeometry(gap);
  return {
    nodes,
    edges,
    columnCount,
    graphWidth: columnCount === 0 ? 0 : COMMIT_GRAPH_PAD_LEFT * 2 + columnCount * COMMIT_GRAPH_COL_WIDTH,
    totalHeight: rows.length * COMMIT_ROW_HEIGHT + (gap?.height ?? 0),
    shaToRow,
    gap,
    ...geometry,
  };
}

export function columnCenterX(column: number): number {
  return COMMIT_GRAPH_PAD_LEFT + column * COMMIT_GRAPH_COL_WIDTH + COMMIT_GRAPH_COL_WIDTH / 2;
}

/** A smooth S-bend between two points one or more rows apart. */
function bend(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `L${x2} ${y2}`;
  const midY = (y1 + y2) / 2;
  return `C${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

/**
 * SVG path for an edge: out of the child into its lane column within one row,
 * straight down the lane, then into the parent within the last row. An open
 * edge runs to the bottom of the loaded window.
 */
export function commitEdgePathD(
  edge: CommitGraphEdge,
  geometry: Pick<CommitGraphLayout, "rowTop" | "rowCenter"> = rowGeometry(null),
): string {
  const x0 = columnCenterX(edge.fromCol);
  const y0 = geometry.rowCenter(edge.fromRow);
  const xl = columnCenterX(edge.laneCol);
  if (edge.open) {
    const yEnd = geometry.rowTop(edge.toRow);
    const yTurn = Math.min(yEnd, geometry.rowCenter(edge.fromRow + 1));
    return `M${x0} ${y0} ${bend(x0, y0, xl, yTurn)} L${xl} ${yEnd}`;
  }
  const xt = columnCenterX(edge.toCol);
  const yt = geometry.rowCenter(edge.toRow);
  if (edge.toRow === edge.fromRow + 1) {
    return `M${x0} ${y0} ${bend(x0, y0, xt, yt)}`;
  }
  const yOut = geometry.rowCenter(edge.fromRow + 1);
  const yIn = geometry.rowCenter(edge.toRow - 1);
  return `M${x0} ${y0} ${bend(x0, y0, xl, yOut)} L${xl} ${yIn} ${bend(xl, yIn, xt, yt)}`;
}

/* ───────────────────────── Lane ownership ───────────────────────── */

export type LaneTip = {
  /** Owner key, usually a lane id. */
  key: string;
  sha: string;
};

/**
 * Which lane each commit belongs to. Everything reachable from the base tip
 * belongs to `base`. Each lane tip then claims its first-parent run down to
 * the base history, another lane's tip, or a commit already claimed, so a
 * stacked lane stops where its parent lane begins. Commits nobody claims map
 * to null.
 */
export function assignCommitOwners(args: {
  commitsNewestFirst: readonly GitCommitSummary[];
  base: LaneTip | null;
  tips: readonly LaneTip[];
}): Map<string, string> {
  const bySha = new Map(args.commitsNewestFirst.map((commit) => [commit.sha, commit]));
  const owners = new Map<string, string>();

  if (args.base && bySha.has(args.base.sha)) {
    const stack = [args.base.sha];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (owners.has(sha)) continue;
      const commit = bySha.get(sha);
      if (!commit) continue;
      owners.set(sha, args.base.key);
      for (const parent of commit.parents) {
        if (!owners.has(parent) && bySha.has(parent)) stack.push(parent);
      }
    }
  }

  const tipShas = new Set<string>();
  for (const tip of args.tips) {
    if (!bySha.has(tip.sha) || owners.has(tip.sha) || tipShas.has(tip.sha)) continue;
    tipShas.add(tip.sha);
    owners.set(tip.sha, tip.key);
  }
  for (const tip of args.tips) {
    if (owners.get(tip.sha) !== tip.key) continue;
    let sha = bySha.get(tip.sha)?.parents[0];
    while (sha && bySha.has(sha) && !owners.has(sha) && !tipShas.has(sha)) {
      owners.set(sha, tip.key);
      sha = bySha.get(sha)!.parents[0];
    }
  }
  return owners;
}
