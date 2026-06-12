import { describe, expect, it } from "vitest";
import type { OperationRecord, RebaseNeed } from "../../../../shared/types";
import {
  getActiveRebaseNeeds,
  getRebaseHistoryOperations,
  getRebaseOperationLabel,
  parseRebaseOperationMetadata,
  sortRebaseHistoryOperations,
} from "./rebaseWorkflowModel";

function makeNeed(overrides: Partial<RebaseNeed> = {}): RebaseNeed {
  return {
    laneId: overrides.laneId ?? "lane-1",
    laneName: overrides.laneName ?? "Feature Lane",
    kind: overrides.kind ?? "lane_base",
    baseBranch: overrides.baseBranch ?? "main",
    behindBy: overrides.behindBy ?? 3,
    conflictPredicted: overrides.conflictPredicted ?? false,
    conflictingFiles: overrides.conflictingFiles ?? [],
    prId: overrides.prId ?? null,
    groupContext: overrides.groupContext ?? null,
    dismissedAt: overrides.dismissedAt ?? null,
    deferredUntil: overrides.deferredUntil ?? null,
  };
}

function makeOperation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: overrides.id ?? "op-1",
    laneId: overrides.laneId ?? "lane-1",
    laneName: overrides.laneName ?? "Feature Lane",
    kind: overrides.kind ?? "lane_rebase",
    startedAt: overrides.startedAt ?? "2026-06-09T12:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-06-09T12:01:00.000Z",
    status: overrides.status ?? "succeeded",
    preHeadSha: overrides.preHeadSha ?? "1111111111111111111111111111111111111111",
    postHeadSha: overrides.postHeadSha ?? "2222222222222222222222222222222222222222",
    metadataJson: overrides.metadataJson ?? null,
  };
}

describe("getActiveRebaseNeeds", () => {
  it("keeps dismissed and deferred still-behind needs actionable", () => {
    const needs = [
      makeNeed({ laneId: "dismissed", behindBy: 42, dismissedAt: "2026-06-07T21:50:22.774Z" }),
      makeNeed({ laneId: "deferred", behindBy: 2, deferredUntil: "2999-01-01T00:00:00.000Z" }),
      makeNeed({ laneId: "resolved", behindBy: 0 }),
    ];

    expect(getActiveRebaseNeeds(needs).map((need) => need.laneId)).toEqual(["dismissed", "deferred"]);
  });
});

describe("getRebaseHistoryOperations", () => {
  it("includes ADE rebase operations and pull --rebase operations only", () => {
    const operations = [
      makeOperation({ id: "lane", kind: "lane_rebase" }),
      makeOperation({ id: "sync", kind: "git_sync_rebase" }),
      makeOperation({ id: "pull-rebase", kind: "git_pull", metadataJson: JSON.stringify({ mode: "rebase" }) }),
      makeOperation({ id: "pull-merge", kind: "git_pull", metadataJson: JSON.stringify({ mode: "merge" }) }),
      makeOperation({ id: "fetch", kind: "git_fetch" }),
    ];

    expect(getRebaseHistoryOperations(operations).map((operation) => operation.id)).toEqual([
      "lane",
      "sync",
      "pull-rebase",
    ]);
  });

  it("parses metadata defensively and labels known operation kinds", () => {
    const operation = makeOperation({
      kind: "git_pull",
      metadataJson: JSON.stringify({ mode: "rebase", actor: "user" }),
    });

    expect(parseRebaseOperationMetadata(operation)).toEqual({ mode: "rebase", actor: "user" });
    expect(parseRebaseOperationMetadata(makeOperation({ metadataJson: "{" }))).toEqual({});
    expect(getRebaseOperationLabel(operation)).toBe("Pull --rebase");
  });

  it("sorts history operations newest first", () => {
    const older = makeOperation({ id: "older", startedAt: "2026-06-09T12:00:00.000Z" });
    const newer = makeOperation({ id: "newer", startedAt: "2026-06-09T12:05:00.000Z" });

    expect(sortRebaseHistoryOperations([older, newer]).map((operation) => operation.id)).toEqual(["newer", "older"]);
  });
});
