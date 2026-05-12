import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQueueTargetTrackingBranches } from "./queueRebase";

const mockGit = vi.hoisted(() => ({
  runGit: vi.fn(),
  runGitOrThrow: vi.fn(),
}));

vi.mock("../git/git", () => ({
  runGit: (...args: unknown[]) => mockGit.runGit(...args),
  runGitOrThrow: (...args: unknown[]) => mockGit.runGitOrThrow(...args),
}));

function makeDb(branches: string[]) {
  return {
    all: vi.fn(() => branches.map((targetBranch) => ({ target_branch: targetBranch }))),
  } as any;
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
    const branches = Array.from({ length: 300 }, (_, index) => `queue-${index}`);

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
});
