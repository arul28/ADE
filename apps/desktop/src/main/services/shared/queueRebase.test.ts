import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdeDb } from "../state/kvDb";
import { fetchQueueTargetTrackingBranches, fetchRemoteTrackingBranch } from "./queueRebase";

const mockGit = vi.hoisted(() => ({
  runGit: vi.fn(),
  runGitOrThrow: vi.fn(),
}));

vi.mock("../git/git", () => ({
  runGit: (...args: unknown[]) => mockGit.runGit(...args),
  runGitOrThrow: (...args: unknown[]) => mockGit.runGitOrThrow(...args),
}));

const TEST_QUEUE_TARGET_FETCH_TTL_MS = 5 * 60_000;
const CACHE_BOUND_TEST_BRANCH_COUNT = 300;

type QueueTargetDb = Pick<AdeDb, "all">;

function makeDb(branches: string[]): AdeDb {
  const rows = branches.map((target_branch) => ({ target_branch }));
  const all: QueueTargetDb["all"] = <T extends Record<string, unknown> = Record<string, unknown>>(
    _sql: string,
  ) => rows as unknown as T[];
  const db: QueueTargetDb = {
    all,
  };
  return {
    ...db,
  } as AdeDb;
}

describe("fetchQueueTargetTrackingBranches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    mockGit.runGitOrThrow.mockResolvedValue(undefined);
    mockGit.runGit.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bounds the queue target fetch TTL cache while preserving recent entries", async () => {
    // Exceeds the production 256-entry cache cap so old queue-target fetches are evicted.
    const branches = Array.from({ length: CACHE_BOUND_TEST_BRANCH_COUNT }, (_, index) => `queue-${index}`);

    await fetchQueueTargetTrackingBranches({
      db: makeDb(branches),
      projectId: "project-1",
      projectRoot: "/tmp/ade",
    });
    expect(mockGit.runGitOrThrow).toHaveBeenCalledTimes(300);

    mockGit.runGitOrThrow.mockClear();
    await fetchQueueTargetTrackingBranches({
      db: makeDb(["queue-0", "queue-299"]),
      projectId: "project-1",
      projectRoot: "/tmp/ade",
    });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledTimes(1);
    expect(mockGit.runGitOrThrow).toHaveBeenCalledWith(
      ["fetch", "--prune", "origin", "+refs/heads/queue-0:refs/remotes/origin/queue-0"],
      { cwd: "/tmp/ade", timeoutMs: 120_000 },
    );
  });

  it("refetches queue target branches after the TTL expires", async () => {
    const initialNow = 2_000_000;
    vi.mocked(Date.now).mockReturnValue(initialNow);

    await fetchQueueTargetTrackingBranches({
      db: makeDb(["queue-ttl"]),
      projectId: "project-ttl",
      projectRoot: "/tmp/ade-ttl",
    });
    expect(mockGit.runGitOrThrow).toHaveBeenCalledTimes(1);

    mockGit.runGitOrThrow.mockClear();
    vi.mocked(Date.now).mockReturnValue(initialNow + TEST_QUEUE_TARGET_FETCH_TTL_MS + 1);

    await fetchQueueTargetTrackingBranches({
      db: makeDb(["queue-ttl"]),
      projectId: "project-ttl",
      projectRoot: "/tmp/ade-ttl",
    });

    expect(mockGit.runGitOrThrow).toHaveBeenCalledTimes(1);
  });

  it("throttles failed queue target fetch attempts", async () => {
    mockGit.runGitOrThrow
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(undefined);
    mockGit.runGit.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "network down" });

    await fetchQueueTargetTrackingBranches({
      db: makeDb(["queue-fail"]),
      projectId: "project-fail",
      projectRoot: "/tmp/ade-fail",
    });
    expect(mockGit.runGitOrThrow).toHaveBeenCalledTimes(1);

    mockGit.runGitOrThrow.mockClear();

    await fetchQueueTargetTrackingBranches({
      db: makeDb(["queue-fail"]),
      projectId: "project-fail",
      projectRoot: "/tmp/ade-fail",
    });

    expect(mockGit.runGitOrThrow).not.toHaveBeenCalled();
  });

  it("reports a miss when only the broad fallback fetch succeeds", async () => {
    mockGit.runGitOrThrow.mockRejectedValueOnce(new Error("branch refspec failed"));
    mockGit.runGit.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    await expect(fetchRemoteTrackingBranch({
      projectRoot: "/tmp/ade-fallback",
      targetBranch: "queue-fallback",
    })).resolves.toBe(false);

    expect(mockGit.runGit).toHaveBeenCalledWith(
      ["fetch", "--prune", "origin"],
      { cwd: "/tmp/ade-fallback", timeoutMs: 120_000 },
    );
  });
});
