import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionDeltaService } from "./sessionDeltaService";

const gitMocks = vi.hoisted(() => ({
  runGit: vi.fn(),
}));

vi.mock("../git/git", () => ({
  runGit: (...args: unknown[]) => gitMocks.runGit(...args),
}));

function createHarness(session: Record<string, unknown>) {
  const db = {
    get: vi.fn((sql: string) => {
      if (sql.includes("from terminal_sessions")) return session;
      return null;
    }),
    all: vi.fn(() => []),
    run: vi.fn(),
  };
  const laneService = {
    getLaneBaseAndBranch: vi.fn(() => ({ worktreePath: "/tmp/ade-test-worktree" })),
  };
  const sessionService = {
    readTranscriptTail: vi.fn(async () => ""),
  };
  const service = createSessionDeltaService({
    db: db as any,
    projectId: "project-1",
    laneService: laneService as any,
    sessionService: sessionService as any,
  });
  return { db, laneService, service, sessionService };
}

describe("createSessionDeltaService", () => {
  beforeEach(() => {
    gitMocks.runGit.mockReset();
  });

  it("skips ended sessions that do not have an end SHA", async () => {
    const { db, laneService, service, sessionService } = createHarness({
      id: "session-1",
      lane_id: "lane-1",
      tracked: 1,
      started_at: "2026-05-29T12:00:00.000Z",
      ended_at: "2026-05-29T12:10:00.000Z",
      head_sha_start: "abc123",
      head_sha_end: null,
      transcript_path: "/tmp/session.log",
    });

    await expect(service.computeSessionDelta("session-1")).resolves.toBeNull();

    expect(laneService.getLaneBaseAndBranch).not.toHaveBeenCalled();
    expect(gitMocks.runGit).not.toHaveBeenCalled();
    expect(sessionService.readTranscriptTail).not.toHaveBeenCalled();
    expect(db.run).not.toHaveBeenCalled();
  });

  it("records a zero diff for completed sessions whose start and end SHA match", async () => {
    const { db, service } = createHarness({
      id: "session-2",
      lane_id: "lane-1",
      tracked: 1,
      started_at: "2026-05-29T12:00:00.000Z",
      ended_at: "2026-05-29T12:10:00.000Z",
      head_sha_start: "abc123",
      head_sha_end: "abc123",
      transcript_path: "/tmp/session.log",
    });

    const delta = await service.computeSessionDelta("session-2");

    expect(gitMocks.runGit).not.toHaveBeenCalled();
    expect(delta).toMatchObject({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      touchedFiles: [],
    });
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into session_deltas"),
      expect.arrayContaining(["session-2", "project-1", "lane-1", 0, 0, 0]),
    );
  });
});
