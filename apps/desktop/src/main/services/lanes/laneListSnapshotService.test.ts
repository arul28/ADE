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
      pendingInputCount: 0,
      endedCount: 0,
      sessionCount: 1,
    });
  });

  it("counts chat pending input separately from CLI attention heuristics", async () => {
    const services = {
      ...makeHarness({
        id: "chat-1",
        laneId: "lane-1",
        status: "running",
        runtimeState: "idle",
        toolType: "cursor-chat",
        lastOutputPreview: "Turn completed",
      }),
      agentChatService: {
        listSessions: vi.fn(() => [{
          sessionId: "chat-1",
          laneId: "lane-1",
          status: "active",
          awaitingInput: true,
          pendingInputItemId: "pending-1",
        }]),
      },
    };

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
      awaitingInputCount: 1,
      pendingInputCount: 1,
    });
  });

  it("does not count stale chat awaiting state without a pending item id", async () => {
    const services = {
      ...makeHarness({
        id: "chat-1",
        laneId: "lane-1",
        status: "running",
        runtimeState: "idle",
        toolType: "cursor-chat",
        lastOutputPreview: "Turn completed",
      }),
      agentChatService: {
        listSessions: vi.fn(() => [{
          sessionId: "chat-1",
          laneId: "lane-1",
          status: "active",
          awaitingInput: true,
        }]),
      },
    };

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
      awaitingInputCount: 1,
      pendingInputCount: 0,
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
      pendingInputCount: 0,
      endedCount: 0,
      sessionCount: 1,
    });
  });
});
