import { describe, expect, it } from "vitest";
import { buildCommitGraphLayout, columnCenterX, rowCenterY } from "./commitGraphLayout";
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
    const layout = buildCommitGraphLayout([c3, c2, c1]);
    expect(layout.columnCount).toBe(1);
    expect(layout.nodes.every((n) => n.column === 0)).toBe(true);
    expect(layout.edges).toHaveLength(2);
  });

  it("creates edges for merge commits", () => {
    const merge = commit("m", ["main", "feature"]);
    const main = commit("main", []);
    const feature = commit("feature", []);
    const layout = buildCommitGraphLayout([merge, main, feature]);
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
    const layout = buildCommitGraphLayout([merge, branchA, branchB, root]);
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
    const layout = buildCommitGraphLayout([independent, tip, merge, branchA, branchB, root]);
    const independentCol = layout.nodes.find((node) => node.sha === "independent")?.column;
    const tipCol = layout.nodes.find((node) => node.sha === "tip")?.column;

    expect(independentCol).toBe(1);
    expect(tipCol).toBe(0);
    expect(layout.columnCount).toBe(2);
  });

  it("maps row indices for positioning helpers", () => {
    const c2 = commit("c2", ["c1"]);
    const c1 = commit("c1", []);
    const layout = buildCommitGraphLayout([c2, c1]);
    expect(layout.shaToRow.get("c2")).toBe(0);
    expect(rowCenterY(0)).toBeGreaterThan(0);
    expect(columnCenterX(0)).toBeGreaterThan(0);
  });
});
