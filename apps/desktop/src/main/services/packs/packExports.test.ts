import { describe, expect, it } from "vitest";
import type { ConflictLineageV1, LaneExportManifestV1, PackSummary } from "../../../shared/types";
import {
  ADE_INTENT_END,
  ADE_INTENT_START,
  ADE_NARRATIVE_END,
  ADE_NARRATIVE_START,
  ADE_TASK_SPEC_END,
  ADE_TASK_SPEC_START,
  ADE_TODOS_END,
  ADE_TODOS_START
} from "../../../shared/contextContract";
import type { PackGraphEnvelopeV1 } from "../../../shared/contextContract";
import { buildConflictExport, buildLaneExport } from "./packExports";

function makeLanePackBody(args: { taskSpec: string; intent: string; todos?: string; narrative?: string }): string {
  return [
    "# Lane: Test Lane",
    "",
    "## Why",
    ADE_INTENT_START,
    args.intent,
    ADE_INTENT_END,
    "",
    "## Task Spec",
    ADE_TASK_SPEC_START,
    args.taskSpec,
    ADE_TASK_SPEC_END,
    "",
    "## What Changed",
    "- src/foo.ts (+10/-2)",
    "",
    "## Validation",
    "- Tests: PASS",
    "",
    "## Key Files",
    "| File | Change |",
    "|------|--------|",
    "| `src/foo.ts` | +10/-2 |",
    "",
    "## Errors & Issues",
    "- none",
    "",
    "## Sessions",
    "| When | Tool | Goal | Result | Delta |",
    "|------|------|------|--------|-------|",
    "| 12:00 | Shell | npm test | ok | +10/-2 |",
    "",
    "## Open Questions / Next Steps",
    "- ship it",
    "",
    "## Notes / Todos",
    ADE_TODOS_START,
    args.todos ?? "",
    ADE_TODOS_END,
    "",
    "## Narrative",
    ADE_NARRATIVE_START,
    args.narrative ?? "",
    ADE_NARRATIVE_END,
    "",
    "---",
    "*footer*",
    ""
  ].join("\n");
}

function makeLaneManifest(args: {
  projectId: string;
  laneId: string;
  laneName: string;
  branchRef: string;
  baseRef: string;
  headSha: string | null;
}): LaneExportManifestV1 {
  return {
    schema: "ade.manifest.lane.v1",
    projectId: args.projectId,
    laneId: args.laneId,
    laneName: args.laneName,
    laneType: "worktree",
    worktreePath: "/tmp/worktree",
    branchRef: args.branchRef,
    baseRef: args.baseRef,
    lineage: {
      laneId: args.laneId,
      parentLaneId: null,
      baseLaneId: args.laneId,
      stackDepth: 0
    },
    mergeConstraints: {
      requiredMerges: [],
      blockedByLanes: [],
      mergeReadiness: "unknown"
    },
    branchState: {
      baseRef: args.baseRef,
      headRef: args.branchRef,
      headSha: args.headSha,
      lastPackRefreshAt: null,
      isEditProtected: false,
      packStale: null
    },
    conflicts: {
      activeConflictPackKeys: [],
      unresolvedPairCount: 0,
      lastConflictRefreshAt: null,
      lastConflictRefreshAgeMs: null
    }
  };
}

function parseHeaderFromExport(content: string): any {
  const start = content.indexOf("```json");
  if (start < 0) return null;
  const end = content.indexOf("```", start + "```json".length);
  if (end < 0) return null;
  const json = content.slice(start + "```json".length, end).trim();
  return JSON.parse(json);
}

describe("packExports", () => {
  it("buildLaneExport(lite) stays within budget and preserves required markers even with huge user sections", () => {
    const projectId = "proj-1";
    const huge = "x".repeat(20_000);
    const pack: PackSummary = {
      packKey: "lane:lane-1",
      packType: "lane",
      path: "/tmp/lane_pack.md",
      exists: true,
      deterministicUpdatedAt: "2026-02-14T00:00:00.000Z",
      narrativeUpdatedAt: "2026-02-14T00:00:00.000Z",
      lastHeadSha: "0123456789abcdef",
      versionId: "ver-1",
      versionNumber: 1,
      contentHash: "hash",
      metadata: null,
      body: makeLanePackBody({
        taskSpec: huge,
        intent: huge,
        todos: huge,
        narrative: huge
      })
    };

    const manifest = makeLaneManifest({
      projectId,
      laneId: "lane-1",
      laneName: "Test Lane",
      branchRef: "feature/test",
      baseRef: "main",
      headSha: pack.lastHeadSha ?? null
    });
    const graph: PackGraphEnvelopeV1 = {
      schema: "ade.packGraph.v1",
      relations: [
        {
          relationType: "depends_on",
          targetPackKey: "project",
          rationale: "test"
        }
      ]
    };

    const exp = buildLaneExport({
      level: "lite",
      projectId,
      laneId: "lane-1",
      laneName: "Test Lane",
      branchRef: "feature/test",
      baseRef: "main",
      headSha: pack.lastHeadSha,
      pack,
      providerMode: "guest",
      apiBaseUrl: null,
      remoteProjectId: null,
      graph,
      manifest,
      markers: {
        taskSpecStart: ADE_TASK_SPEC_START,
        taskSpecEnd: ADE_TASK_SPEC_END,
        intentStart: ADE_INTENT_START,
        intentEnd: ADE_INTENT_END,
        todosStart: ADE_TODOS_START,
        todosEnd: ADE_TODOS_END,
        narrativeStart: ADE_NARRATIVE_START,
        narrativeEnd: ADE_NARRATIVE_END
      },
      conflictRiskSummaryLines: ["- Conflict status: `unknown`"]
    });

    expect(exp.approxTokens).toBeLessThanOrEqual(exp.maxTokens);
    expect(exp.content).toContain("```json");
    expect(exp.content).toContain("## Task Spec");
    expect(exp.content).toContain(ADE_TASK_SPEC_START);
    expect(exp.content).toContain(ADE_TASK_SPEC_END);
    expect(exp.content).toContain("## Intent");
    expect(exp.content).toContain(ADE_INTENT_START);
    expect(exp.content).toContain(ADE_INTENT_END);
    expect(exp.content).toContain("## Conflict Risk Summary");
    expect(exp.content).toContain("...(truncated)...");
    expect(exp.content).toContain("## Manifest");
    expect(exp.clipReason).toBe("budget_clipped");
    expect((exp.omittedSections ?? []).length).toBeGreaterThan(0);
    const header = parseHeaderFromExport(exp.content);
    expect(header.projectId).toBe(projectId);
    expect(header.graph?.schema).toBe("ade.packGraph.v1");
  });

  it("buildLaneExport(deep) can include narrative markers, while standard omits narrative by default", () => {
    const projectId = "proj-1";
    const pack: PackSummary = {
      packKey: "lane:lane-2",
      packType: "lane",
      path: "/tmp/lane_pack.md",
      exists: true,
      deterministicUpdatedAt: "2026-02-14T00:00:00.000Z",
      narrativeUpdatedAt: "2026-02-14T00:00:00.000Z",
      lastHeadSha: "abcdef0123456789",
      body: makeLanePackBody({
        taskSpec: "- do the thing",
        intent: "because reasons",
        narrative: "narrative text"
      })
    };

    const commonArgs: Omit<Parameters<typeof buildLaneExport>[0], "level"> = {
      projectId,
      laneId: "lane-2",
      laneName: "Test Lane 2",
      branchRef: "feature/test2",
      baseRef: "main",
      headSha: pack.lastHeadSha,
      pack,
      providerMode: "guest",
      apiBaseUrl: null,
      remoteProjectId: null,
      manifest: makeLaneManifest({
        projectId,
        laneId: "lane-2",
        laneName: "Test Lane 2",
        branchRef: "feature/test2",
        baseRef: "main",
        headSha: pack.lastHeadSha ?? null
      }),
      markers: {
        taskSpecStart: ADE_TASK_SPEC_START,
        taskSpecEnd: ADE_TASK_SPEC_END,
        intentStart: ADE_INTENT_START,
        intentEnd: ADE_INTENT_END,
        todosStart: ADE_TODOS_START,
        todosEnd: ADE_TODOS_END,
        narrativeStart: ADE_NARRATIVE_START,
        narrativeEnd: ADE_NARRATIVE_END
      },
      conflictRiskSummaryLines: [] as string[]
    };

    const standard = buildLaneExport({
      ...commonArgs,
      level: "standard"
    });

    expect(standard.approxTokens).toBeLessThanOrEqual(standard.maxTokens);
    expect(standard.content).not.toContain("## Narrative (Deep)");
    expect(standard.content).not.toContain(ADE_NARRATIVE_START);

    const deep = buildLaneExport({
      ...commonArgs,
      level: "deep"
    });

    expect(deep.approxTokens).toBeLessThanOrEqual(deep.maxTokens);
    expect(deep.content).toContain("## Narrative (Deep)");
    expect(deep.content).toContain(ADE_NARRATIVE_START);
    expect(deep.content).toContain(ADE_NARRATIVE_END);
  });

  it("buildConflictExport includes conflict lineage JSON when provided", () => {
    const projectId = "proj-1";
    const pack: PackSummary = {
      packKey: "conflict:lane-1:main",
      packType: "conflict",
      path: "/tmp/conflict_pack.md",
      exists: true,
      deterministicUpdatedAt: "2026-02-14T00:00:00.000Z",
      narrativeUpdatedAt: null,
      lastHeadSha: "abcdef0123456789",
      body: "# Conflict Pack\n\n## Overlapping Files\n- a\n"
    };

    const lineage: ConflictLineageV1 = {
      schema: "ade.conflictLineage.v1",
      laneId: "lane-1",
      peerKey: "main",
      predictionAt: null,
      lastRecomputedAt: null,
      truncated: null,
      strategy: null,
      pairwisePairsComputed: null,
      pairwisePairsTotal: null,
      stalePolicy: { ttlMs: 300000 },
      openConflictSummaries: [],
      unresolvedResolutionState: null
    };

    const exp = buildConflictExport({
      level: "standard",
      projectId,
      packKey: pack.packKey,
      laneId: "lane-1",
      peerLabel: "base:main",
      pack,
      providerMode: "guest",
      apiBaseUrl: null,
      remoteProjectId: null,
      lineage
    });

    expect(exp.content).toContain("## Conflict Lineage");
    expect(exp.content).toContain("\"schema\": \"ade.conflictLineage.v1\"");
    const header = parseHeaderFromExport(exp.content);
    expect(header.projectId).toBe(projectId);
  });
});
