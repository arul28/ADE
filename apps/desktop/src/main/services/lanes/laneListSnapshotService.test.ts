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
  it("does not infer awaiting input from an idle AI CLI", async () => {
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
      bucket: "running",
      runningCount: 1,
      awaitingInputCount: 0,
      pendingInputCount: 0,
      endedCount: 0,
      sessionCount: 1,
    });
  });

  // Shipped iOS builds decode LaneListSnapshot with `adoptableAttached` as a
  // non-optional Bool, and the host updates before the phone does. The field is
  // deprecated and always false, but an emitter that stops sending the KEY
  // blanks the lane list on every not-yet-updated device. It stays REQUIRED on
  // the TypeScript type for exactly that reason; since no TypeScript surface
  // reads it, a cleanup pass could still drop type and emitters together in one
  // green step, so assert on the serialized payload by literal key name.
  it("still emits the deprecated adoptableAttached key for older clients", async () => {
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

    const wire = JSON.parse(JSON.stringify(snapshot));
    expect(Object.keys(wire)).toContain("adoptableAttached");
    expect(wire.adoptableAttached).toBe(false);
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

  it("counts provider-structured awaiting state without an item id", async () => {
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

  it("degrades persisted chat running state when chat projection fails", async () => {
    const services = {
      ...makeHarness({
        id: "chat-1",
        laneId: "lane-1",
        status: "running",
        runtimeState: "running",
        toolType: "codex-chat",
        lastOutputPreview: "Earlier output",
      }),
      agentChatService: {
        listSessions: vi.fn(async () => {
          throw new Error("chat runtime unavailable");
        }),
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
      bucket: "running",
      runningCount: 1,
      awaitingInputCount: 0,
    });
  });

  it("keeps active automation chats in the running lane bucket", async () => {
    const listSessions = vi.fn(() => [{
      sessionId: "automation-chat-1",
      laneId: "lane-1",
      surface: "automation",
      status: "active",
      awaitingInput: false,
    }]);
    const services = {
      ...makeHarness({
        id: "automation-chat-1",
        laneId: "lane-1",
        status: "running",
        runtimeState: "idle",
        toolType: "codex-chat",
        lastOutputPreview: "Earlier output",
      }),
      agentChatService: {
        listSessions,
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
      bucket: "running",
      runningCount: 1,
      awaitingInputCount: 0,
    });
    expect(listSessions).toHaveBeenCalledWith(undefined, {
      includeIdentity: true,
      includeAutomation: true,
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

  it("returns core lane rows when optional rebase enrichment exceeds its budget", async () => {
    vi.useFakeTimers();
    try {
      const services = {
        ...makeHarness({
          id: "session-1",
          laneId: "lane-1",
          status: "running",
          runtimeState: "running",
          toolType: "shell",
          lastOutputPreview: "working",
        }),
        rebaseSuggestionService: {
          listSuggestions: vi.fn(() => new Promise(() => {})),
        },
      };

      const pending = buildLaneListSnapshots(
        services as any,
        [{ id: "lane-1", name: "Lane 1", laneType: "worktree", archivedAt: null }] as any,
        {
          includeConflictStatus: false,
          includeRebaseSuggestions: true,
          includeAutoRebaseStatus: false,
          optionalEnrichmentBudgetMs: 25,
        },
      );
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toEqual([
        expect.objectContaining({
          lane: expect.objectContaining({ id: "lane-1" }),
          runtime: expect.objectContaining({ bucket: "running", sessionCount: 1 }),
          rebaseSuggestion: null,
        }),
      ]);
      expect(services.rebaseSuggestionService.listSuggestions).toHaveBeenCalledTimes(1);
      expect(services.logger.info).toHaveBeenCalledWith(
        "lanes.listSnapshots.optional_enrichment_deferred",
        expect.objectContaining({ budgetMs: 25, laneCount: 1 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves last-known decorations while a newer enrichment is still pending", async () => {
    vi.useFakeTimers();
    try {
      let resolveRefresh!: (value: any[]) => void;
      const rebaseSuggestions = vi.fn()
        .mockResolvedValueOnce([{ laneId: "lane-1", behindCount: 1 }])
        .mockImplementationOnce(() => new Promise<any[]>((resolve) => {
          resolveRefresh = resolve;
        }))
        .mockImplementation(() => new Promise(() => {}));
      const services = {
        ...makeHarness({
          id: "session-1",
          laneId: "lane-1",
          status: "running",
          runtimeState: "running",
          toolType: "shell",
          lastOutputPreview: "working",
        }),
        rebaseSuggestionService: { listSuggestions: rebaseSuggestions },
      };
      const lanes = [{ id: "lane-1", name: "Lane 1", laneType: "worktree", archivedAt: null }] as any;
      const options = {
        includeConflictStatus: false,
        includeRebaseSuggestions: true,
        includeAutoRebaseStatus: false,
        optionalEnrichmentBudgetMs: 25,
      };

      const first = await buildLaneListSnapshots(services as any, lanes, options);
      expect(first[0]?.rebaseSuggestion).toEqual(expect.objectContaining({ behindCount: 1 }));

      const secondPending = buildLaneListSnapshots(services as any, lanes, options);
      await vi.advanceTimersByTimeAsync(25);
      const second = await secondPending;
      expect(second[0]?.rebaseSuggestion).toEqual(expect.objectContaining({ behindCount: 1 }));

      resolveRefresh([{ laneId: "lane-1", behindCount: 2 }]);
      await Promise.resolve();
      const thirdPending = buildLaneListSnapshots(services as any, lanes, options);
      await vi.advanceTimersByTimeAsync(25);
      const third = await thirdPending;
      expect(third[0]?.rebaseSuggestion).toEqual(expect.objectContaining({ behindCount: 2 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes completed decorations when another optional enrichment hangs", async () => {
    vi.useFakeTimers();
    try {
      const services = {
        ...makeHarness({
          id: "session-1",
          laneId: "lane-1",
          status: "running",
          runtimeState: "running",
          toolType: "shell",
          lastOutputPreview: "working",
        }),
        rebaseSuggestionService: {
          listSuggestions: vi.fn().mockResolvedValue([{ laneId: "lane-1", behindCount: 3 }]),
        },
        conflictService: {
          getBatchAssessment: vi.fn(() => new Promise(() => {})),
        },
      };
      const pending = buildLaneListSnapshots(
        services as any,
        [{ id: "lane-1", name: "Lane 1", laneType: "worktree", archivedAt: null }] as any,
        {
          includeConflictStatus: true,
          includeRebaseSuggestions: true,
          includeAutoRebaseStatus: false,
          optionalEnrichmentBudgetMs: 25,
        },
      );

      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toEqual([
        expect.objectContaining({
          rebaseSuggestion: expect.objectContaining({ behindCount: 3 }),
          conflictStatus: null,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces repeated snapshot calls onto one optional enrichment per lane set", async () => {
    vi.useFakeTimers();
    try {
      const never = () => new Promise<never>(() => {});
      const services = {
        ...makeHarness({
          id: "session-1",
          laneId: "lane-1",
          status: "running",
          runtimeState: "running",
          toolType: "shell",
          lastOutputPreview: "working",
        }),
        rebaseSuggestionService: { listSuggestions: vi.fn(never) },
        autoRebaseService: { listStatuses: vi.fn(never) },
        conflictService: { getBatchAssessment: vi.fn(never) },
      };
      const lanes = [{ id: "lane-1", name: "Lane 1", laneType: "worktree", archivedAt: null }] as any;
      const options = { optionalEnrichmentBudgetMs: 25 };

      const first = buildLaneListSnapshots(services as any, lanes, options);
      const second = buildLaneListSnapshots(services as any, lanes, options);
      const otherLaneSet = buildLaneListSnapshots(services as any, [
        { id: "lane-2", name: "Lane 2", laneType: "worktree", archivedAt: null },
      ] as any, options);
      await vi.advanceTimersByTimeAsync(25);
      await Promise.all([first, second, otherLaneSet]);

      expect(services.rebaseSuggestionService.listSuggestions).toHaveBeenCalledTimes(2);
      expect(services.autoRebaseService.listStatuses).toHaveBeenCalledTimes(2);
      expect(services.conflictService.getBatchAssessment).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
