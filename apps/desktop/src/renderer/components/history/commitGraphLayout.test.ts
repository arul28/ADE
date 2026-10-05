import { describe, expect, it } from "vitest";
import {
  assignCommitOwners,
  branchTipKeep,
  buildCommitGraphLayout,
  columnCenterX,
  computeDividerAfterRow,
  contractCommitGraph,
  laneForkWaitsForStatus,
  toGraphCommits,
} from "./commitGraphLayout";
import type { GitCommitSummary } from "../../../shared/types";

function commit(
  sha: string,
  parents: string[],
  subject = "msg",
): GitCommitSummary {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents,
    authorName: "Author",
    authoredAt: "2024-01-01T00:00:00Z",
    subject,
    pushed: false,
  };
}

const layoutOf = (commits: readonly GitCommitSummary[]) =>
  buildCommitGraphLayout(toGraphCommits(commits));

describe("buildCommitGraphLayout", () => {
  it("returns empty layout for no commits", () => {
    const layout = buildCommitGraphLayout([]);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.columnCount).toBe(0);
  });

  it("assigns a single column for linear history", () => {
    const c3 = commit("c3", ["c2"]);
    const c2 = commit("c2", ["c1"]);
    const c1 = commit("c1", []);
    const layout = layoutOf([c3, c2, c1]);
    expect(layout.columnCount).toBe(1);
    expect(layout.nodes.every((n) => n.column === 0)).toBe(true);
    expect(layout.edges).toHaveLength(2);
  });

  it("creates edges for merge commits", () => {
    const merge = commit("m", ["main", "feature"]);
    const main = commit("main", []);
    const feature = commit("feature", []);
    const layout = layoutOf([merge, main, feature]);
    const mergeEdges = layout.edges.filter((e) => e.fromSha === "m");
    const mainNode = layout.nodes.find((node) => node.sha === "main");
    const featureNode = layout.nodes.find((node) => node.sha === "feature");

    expect(mergeEdges.length).toBeGreaterThanOrEqual(2);
    expect(mainNode?.column).not.toBe(featureNode?.column);
  });

  it("keeps forked siblings in separate columns until they merge", () => {
    const merge = commit("m", ["a", "b"]);
    const branchA = commit("a", ["root"]);
    const branchB = commit("b", ["root"]);
    const root = commit("root", []);
    const layout = layoutOf([merge, branchA, branchB, root]);
    const colA = layout.nodes.find((node) => node.sha === "a")?.column;
    const colB = layout.nodes.find((node) => node.sha === "b")?.column;

    expect(colA).toBeDefined();
    expect(colB).toBeDefined();
    expect(colA).not.toBe(colB);
    expect(layout.columnCount).toBeGreaterThanOrEqual(2);
  });

  it("reuses columns that merges make inactive", () => {
    const independent = commit("independent", []);
    const tip = commit("tip", ["m"]);
    const merge = commit("m", ["a", "b"]);
    const branchA = commit("a", ["root"]);
    const branchB = commit("b", ["root"]);
    const root = commit("root", []);
    const layout = layoutOf([independent, tip, merge, branchA, branchB, root]);

    // Two branches are open at once (columns 0 and 1); once they merge into
    // `root`, the columns freed by the merge are reused instead of the graph
    // growing wider with every root.
    expect(layout.nodes.map((node) => node.sha)).toEqual([
      "independent",
      "tip",
      "m",
      "a",
      "b",
      "root",
    ]);
    expect(layout.columnCount).toBe(2);
  });

  it("maps row indices for positioning helpers", () => {
    const c2 = commit("c2", ["c1"]);
    const c1 = commit("c1", []);
    const layout = layoutOf([c2, c1]);
    expect(layout.shaToRow.get("c2")).toBe(0);
    expect(layout.rowCenter(0)).toBeGreaterThan(0);
    expect(columnCenterX(0)).toBeGreaterThan(0);
  });
});

describe("contractCommitGraph", () => {
  // Newest first: d(merge of c,e) <- c <- b <- a(root); e <- b
  const history = [
    commit("d", ["c", "e"]),
    commit("e", ["b"]),
    commit("c", ["b"]),
    commit("b", ["a"]),
    commit("a", []),
  ];

  it("rewrites edges to the nearest kept ancestor and counts what they skip", () => {
    const linear = [commit("w", ["x"]), commit("x", ["y"]), commit("y", ["z"]), commit("z", [])];
    const out = contractCommitGraph(linear, (c) => c.sha === "w" || c.sha === "z");
    expect(out.map((row) => [row.commit.sha, row.parents, row.folded])).toEqual([
      ["w", ["z"], [2]],
      ["z", [], []],
    ]);
  });

  it("fans a hidden merge out to every kept ancestor", () => {
    const out = contractCommitGraph(history, (c) => c.sha === "e" || c.sha === "c" || c.sha === "a" || c.sha === "x");
    // d is hidden: nothing points at it. c and e both reach a through hidden b.
    expect(out.map((row) => [row.commit.sha, row.parents])).toEqual([
      ["e", ["a"]],
      ["c", ["a"]],
      ["a", []],
    ]);
  });

  it("keeps parents outside the loaded window so the edge stays open", () => {
    const page = [commit("p", ["q"]), commit("q", ["beyond"])];
    const out = contractCommitGraph(page, (c) => c.sha === "p");
    expect(out[0]?.parents).toEqual(["beyond"]);
    const layout = buildCommitGraphLayout(out);
    expect(layout.edges[0]?.open).toBe(true);
  });

  it.each([
    ["everything kept", () => true, ["d", "e", "c", "b", "a"]],
    ["branch tips only", null, ["d", "b", "a"]],
  ])("%s", (_label, keep, expected) => {
    const predicate = keep ?? branchTipKeep(history, new Set(["d"]), new Set());
    expect(contractCommitGraph(history, predicate).map((row) => row.commit.sha)).toEqual(expected);
  });
});

describe("buildCommitGraphLayout lane invariants", () => {
  // A busy history: three branches off a trunk, one merged back, one open.
  const busy = [
    commit("m2", ["t3", "f2"]),
    commit("g2", ["g1"]),
    commit("t3", ["t2"]),
    commit("f2", ["f1"]),
    commit("g1", ["t1"]),
    commit("t2", ["t1"]),
    commit("f1", ["t1"]),
    commit("t1", ["t0"]),
    commit("t0", ["older"]),
  ];

  it("never runs an edge through another commit's node", () => {
    const layout = layoutOf(busy);
    const nodeAt = new Map(layout.nodes.map((n) => [`${n.rowIndex}:${n.column}`, n.sha]));
    for (const edge of layout.edges) {
      for (let row = edge.fromRow + 1; row < edge.toRow; row += 1) {
        expect(nodeAt.get(`${row}:${edge.laneCol}`), `${edge.id} crosses row ${row}`).toBeUndefined();
      }
      if (!edge.open) expect(edge.toRow).toBeGreaterThan(edge.fromRow);
    }
  });

  it("keeps the trunk in one column and frees branch columns when they join", () => {
    // Two late tips below the fork reuse the columns the joined branches freed.
    const withLateTips = [
      ...busy.slice(0, 8),
      commit("h1", ["t-1"]),
      commit("h2", ["t-1"]),
      commit("t0", ["t-1"]),
      commit("t-1", []),
    ];
    const layout = layoutOf(withLateTips);
    const trunk = ["m2", "t3", "t2", "t1", "t0", "t-1"];
    expect(layout.nodes.filter((n) => trunk.includes(n.sha)).map((n) => n.column)).toEqual(trunk.map(() => 0));
    expect(layout.columnCount).toBe(3);
    expect(layout.edges.filter((e) => trunk.includes(e.fromSha)).every((e) => e.laneCol === 0 || e.kind === "merge")).toBe(true);
  });

  it("puts a commit in the column its children wait in", () => {
    const layout = layoutOf(busy);
    for (const edge of layout.edges.filter((e) => !e.open)) {
      const parent = layout.nodes[edge.toRow]!;
      expect(parent.sha).toBe(edge.toSha);
      expect(edge.toCol).toBe(parent.column);
    }
    expect(layout.edges.find((e) => e.toSha === "older")?.open).toBe(true);
  });
});

describe("computeDividerAfterRow", () => {
  // Newest first. main was merged into the lane: base commits sit above the
  // lane's own older commits, and the lane's own run ends at "own-a".
  const rows = toGraphCommits([
    commit("own-c", ["merge"]),
    commit("merge", ["own-b", "base-2"]),
    commit("base-2", ["base-1"]),
    commit("base-1", ["own-a"]),
    commit("own-b", ["own-a"]),
    commit("own-a", ["base-0"]),
    commit("base-0", []),
  ]);
  const owners = new Map<string, string>([
    ["own-c", "L"],
    ["merge", "L"],
    ["own-b", "L"],
    ["own-a", "L"],
    ["base-2", "main"],
    ["base-1", "main"],
    ["base-0", "main"],
  ]);

  it("sits under the lane's oldest own commit when base was merged in", () => {
    // The oldest own commit is row 5; base-2/base-1 above it are main's.
    expect(computeDividerAfterRow({ rows, owners, ownLaneId: "L", searching: false })).toBe(5);
  });

  it("sits above row 0 for a lane with no commits of its own", () => {
    expect(computeDividerAfterRow({
      rows: toGraphCommits([commit("base-1", ["base-0"]), commit("base-0", [])]),
      owners: new Map([["base-1", "main"], ["base-0", "main"]]),
      ownLaneId: "L",
      searching: false,
    })).toBe(-1);
  });

  it.each([
    ["while searching", { ownLaneId: "L", searching: true }],
    ["in All lanes or on Primary", { ownLaneId: null, searching: false }],
  ])("draws no divider %s", (_label, overrides) => {
    expect(computeDividerAfterRow({ rows, owners, ...overrides })).toBeNull();
  });

  it("draws no divider when the lane's own run reaches the last row", () => {
    expect(computeDividerAfterRow({
      rows: toGraphCommits([commit("own-b", ["own-a"]), commit("own-a", [])]),
      owners: new Map([["own-b", "L"], ["own-a", "L"]]),
      ownLaneId: "L",
      searching: false,
    })).toBeNull();
  });
});

describe("laneForkWaitsForStatus", () => {
  // A lane behind its base whose base tip is not in the loaded rows gets its
  // fork point from `ahead`. An unmeasured `ahead` must not place the divider.
  it.each([
    ["an unmeasured status with the base tip off-screen waits", { statusStale: true, baseTipLoaded: false, hasLane: true, baseLinePrimary: false }, true],
    ["a measured status never waits", { statusStale: false, baseTipLoaded: false, hasLane: true, baseLinePrimary: false }, false],
    ["a loaded base tip is a commit, not a count, so it never waits", { statusStale: true, baseTipLoaded: true, hasLane: true, baseLinePrimary: false }, false],
    ["the base line has no band or divider to wait for", { statusStale: true, baseTipLoaded: false, hasLane: true, baseLinePrimary: true }, false],
    ["no focused lane never waits", { statusStale: true, baseTipLoaded: false, hasLane: false, baseLinePrimary: false }, false],
  ])("%s", (_label, args, expected) => {
    expect(laneForkWaitsForStatus(args as Parameters<typeof laneForkWaitsForStatus>[0])).toBe(expected);
  });
});

describe("assignCommitOwners", () => {
  // main: t2 <- t1 <- t0. lane A: a2 <- a1 <- t1. lane B stacked on A: b1 <- a2.
  const commits = [
    commit("b1", ["a2"]),
    commit("a2", ["a1"]),
    commit("t2", ["t1"]),
    commit("a1", ["t1"]),
    commit("t1", ["t0"]),
    commit("t0", []),
  ];

  it("gives base history to the base and each lane its own run", () => {
    const owners = assignCommitOwners({
      commitsNewestFirst: commits,
      base: { key: "main", sha: "t2" },
      // B is listed first: it must still stop where A's tip begins.
      tips: [{ key: "B", sha: "b1" }, { key: "A", sha: "a2" }],
    });
    expect(Object.fromEntries(owners)).toEqual({
      b1: "B",
      a2: "A",
      a1: "A",
      t2: "main",
      t1: "main",
      t0: "main",
    });
  });

  it("does not let a lane with nothing ahead claim base history", () => {
    const owners = assignCommitOwners({
      commitsNewestFirst: commits,
      base: { key: "main", sha: "t2" },
      tips: [{ key: "idle", sha: "t2" }],
    });
    expect(owners.get("t2")).toBe("main");
    expect(owners.has("a1")).toBe(false);
  });
});
