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
    expect(mergeEdges.length).toBeGreaterThanOrEqual(2);
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
