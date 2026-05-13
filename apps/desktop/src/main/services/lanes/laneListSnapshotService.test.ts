import { describe, expect, it, vi } from "vitest";
import { buildLaneListSnapshots } from "./laneListSnapshotService";

function makeHarness(session: Record<string, unknown>) {
  return {
    laneService: {
      listStateSnapshots: vi.fn(() => []),
    },
    sessionService: {
      list: vi.fn(() => [session]),
    },
    ptyService: {
      enrichSessions: vi.fn((rows) => rows),
    },
    logger: {
      info: vi.fn(),
    },
  };
}

describe("laneListSnapshotService", () => {
  it("buckets idle AI CLI sessions as awaiting input", async () => {
    const services = makeHarness({
      laneId: "lane-1",
      status: "running",
      runtimeState: "idle",
      toolType: "codex",
      lastOutputPreview: "Turn completed",
    });

    const [snapshot] = await buildLaneListSnapshots(
      services as any,
      [{ id: "lane-1", name: "Lane 1", laneType: "worktree", archivedAt: null }] as any,
      {
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      },
    );

    expect(snapshot?.runtime).toMatchObject({
      bucket: "awaiting-input",
      runningCount: 0,
      awaitingInputCount: 1,
      endedCount: 0,
      sessionCount: 1,
    });
  });

  it("keeps idle shell sessions in the running bucket", async () => {
    const services = makeHarness({
      laneId: "lane-1",
      status: "running",
      runtimeState: "idle",
      toolType: "shell",
      lastOutputPreview: "admin@Mac project %",
    });

    const [snapshot] = await buildLaneListSnapshots(
      services as any,
      [{ id: "lane-1", name: "Lane 1", laneType: "worktree", archivedAt: null }] as any,
      {
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      },
    );

    expect(snapshot?.runtime).toMatchObject({
      bucket: "running",
      runningCount: 1,
      awaitingInputCount: 0,
      endedCount: 0,
      sessionCount: 1,
    });
  });
});
