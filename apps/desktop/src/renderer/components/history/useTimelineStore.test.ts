import { describe, expect, it } from "vitest";
import type { GitCommitSummary, OperationRecord } from "../../../shared/types";
import { createTimelineStore } from "./useTimelineStore";

const commit: GitCommitSummary = {
  sha: "abc123456789",
  shortSha: "abc1234",
  parents: ["parent1"],
  authorName: "Ari",
  authoredAt: "2026-05-22T00:00:00Z",
  subject: "Update history state",
  pushed: false,
};

const operation = (overrides: Partial<OperationRecord> = {}): OperationRecord => ({
  id: overrides.id ?? "op-1",
  laneId: "laneId" in overrides ? overrides.laneId ?? null : "lane-1",
  laneName: "laneName" in overrides ? overrides.laneName ?? null : "History lane",
  kind: overrides.kind ?? "chat.session",
  startedAt: overrides.startedAt ?? "2026-05-22T00:00:00Z",
  endedAt: overrides.endedAt ?? "2026-05-22T00:00:01Z",
  status: overrides.status ?? "succeeded",
  preHeadSha: overrides.preHeadSha ?? null,
  postHeadSha: overrides.postHeadSha ?? null,
  metadataJson: overrides.metadataJson ?? JSON.stringify({
    eventLabel: "Chat: fix checkout",
    provider: "codex",
    taskKey: "task-17",
  }),
});

describe("timeline store", () => {
  it("clears commit selection when switching to activity", () => {
    const store = createTimelineStore();

    store.getState().setSelectedCommit(commit);
    store.getState().setSurface("activity");

    expect(store.getState().surface).toBe("activity");
    expect(store.getState().selectedCommit).toBeNull();
    expect(store.getState().selectedCommitSha).toBeNull();
  });

  it("clears event selection when switching back to commits", () => {
    const store = createTimelineStore();

    store.getState().setSelectedEventId("event-1");
    store.getState().setSurface("commits");

    expect(store.getState().surface).toBe("commits");
    expect(store.getState().selectedEventId).toBeNull();
  });

  it("searches supplemental metadata fields, not only visible labels", () => {
    const store = createTimelineStore();

    store.getState().setRawEvents([operation()]);
    store.getState().setSearchQuery("task-17");

    expect(store.getState().events.map((event) => event.id)).toEqual(["op-1"]);
  });

  it("keeps project-level records when a lane filter is active", () => {
    const store = createTimelineStore();

    store.getState().setRawEvents([
      operation({ id: "lane-op", laneId: "lane-1", laneName: "History lane" }),
      operation({ id: "project-op", laneId: null, laneName: null }),
    ]);
    store.getState().setLaneFilter(["lane-1"]);

    expect(store.getState().events.map((event) => event.id)).toEqual(["lane-op", "project-op"]);
  });
});
