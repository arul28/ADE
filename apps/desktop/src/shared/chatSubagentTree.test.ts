import { describe, expect, it } from "vitest";
import { annotateSubagentTree, shouldAutoCollapseFinishedSubtree } from "./chatSubagentTree";

describe("subagent tree connectors", () => {
  it("indents children with ├ / └ and prefers SDK spawn_depth when present", () => {
    const annotated = annotateSubagentTree([
      { taskId: "root", agentId: "root", description: "typecheck desktop", status: "running", startedAt: "2026-05-01T00:00:02.000Z" },
      { taskId: "child", agentId: "child", parentAgentId: "root", status: "running", startedAt: "2026-05-01T00:00:01.000Z" },
      { taskId: "leaf", agentId: "leaf", parentAgentId: "child", spawnDepth: 2, status: "completed", startedAt: "2026-05-01T00:00:00.000Z" },
    ] as const);

    expect(annotated.map((entry) => identity(entry))).toEqual(["root", "child", "leaf"]);
    expect(annotated[0]?.tree).toMatchObject({ depth: 0, glyph: "", prefix: "" });
    expect(annotated[1]?.tree).toMatchObject({ depth: 1, glyph: "└", prefix: "└ " });
    expect(annotated[2]?.tree).toMatchObject({ depth: 2, glyph: "└", prefix: "   └ " });
  });

  it("caps connector ancestors to the displayed spawn_depth", () => {
    const annotated = annotateSubagentTree([
      { taskId: "root", agentId: "root", startedAt: "2026-05-01T00:00:03.000Z" },
      { taskId: "child", agentId: "child", parentAgentId: "root", startedAt: "2026-05-01T00:00:02.000Z" },
      { taskId: "leaf", agentId: "leaf", parentAgentId: "child", spawnDepth: 1, startedAt: "2026-05-01T00:00:01.000Z" },
    ]);
    expect(annotated.find((entry) => entry.node.taskId === "leaf")?.tree).toMatchObject({
      depth: 1,
      glyph: "└",
      prefix: "└ ",
    });
  });

  it("uses ├ for a non-last sibling", () => {
    const annotated = annotateSubagentTree([
      { taskId: "root", agentId: "root", startedAt: "2026-05-01T00:00:02.000Z" },
      { taskId: "older", agentId: "older", parentAgentId: "root", startedAt: "2026-05-01T00:00:00.000Z" },
      { taskId: "newer", agentId: "newer", parentAgentId: "root", startedAt: "2026-05-01T00:00:01.000Z" },
    ]);
    const older = annotated.find((entry) => entry.node.taskId === "older")?.tree;
    const newer = annotated.find((entry) => entry.node.taskId === "newer")?.tree;
    expect(newer).toMatchObject({ glyph: "├", prefix: "├ " });
    expect(older).toMatchObject({ glyph: "└", prefix: "└ " });
  });

  it("auto-collapses a finished parent whose descendants are also finished", () => {
    expect(shouldAutoCollapseFinishedSubtree(
      { taskId: "root", status: "completed" },
      ["completed", "failed"],
    )).toBe(true);
    expect(shouldAutoCollapseFinishedSubtree(
      { taskId: "root", status: "completed" },
      ["running"],
    )).toBe(false);
    expect(shouldAutoCollapseFinishedSubtree(
      { taskId: "root", status: "running" },
      ["completed"],
    )).toBe(false);
    expect(shouldAutoCollapseFinishedSubtree(
      { taskId: "root", status: "completed" },
      [],
    )).toBe(false);
  });
});

function identity(entry: { node: { agentId?: string; taskId: string } }): string {
  return entry.node.agentId ?? entry.node.taskId;
}
