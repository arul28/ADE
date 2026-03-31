import { describe, expect, it, vi } from "vitest";
import { mapPermissionMode, readRecentCommits } from "./resolverUtils";

vi.mock("../git/git", () => ({
  runGit: vi.fn(),
}));

import { runGit } from "../git/git";

const mockRunGit = vi.mocked(runGit);

describe("mapPermissionMode", () => {
  it("maps full_edit to full-auto", () => {
    expect(mapPermissionMode("full_edit")).toBe("full-auto");
  });

  it("maps read_only to plan", () => {
    expect(mapPermissionMode("read_only")).toBe("plan");
  });

  it("maps guarded_edit to edit", () => {
    expect(mapPermissionMode("guarded_edit")).toBe("edit");
  });

  it("maps undefined to edit", () => {
    expect(mapPermissionMode(undefined)).toBe("edit");
  });

  it("maps an unrecognized value to edit", () => {
    expect(mapPermissionMode("some_other_value" as any)).toBe("edit");
  });
});

describe("readRecentCommits", () => {
  it("parses git log output into sha/subject pairs", async () => {
    mockRunGit.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "abc123def456\tAdd feature X\nbbb222ccc333\tFix tests\n",
      stderr: "",
    } as any);

    const commits = await readRecentCommits("/tmp/worktree", 8);

    expect(mockRunGit).toHaveBeenCalledWith(
      ["log", "--format=%H%x09%s", "-n", "8", "HEAD"],
      { cwd: "/tmp/worktree", timeoutMs: 10_000 },
    );
    expect(commits).toEqual([
      { sha: "abc123def456", subject: "Add feature X" },
      { sha: "bbb222ccc333", subject: "Fix tests" },
    ]);
  });

  it("defaults to 8 commits and HEAD ref", async () => {
    mockRunGit.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "aaa111bbb222\tFirst commit\n",
      stderr: "",
    } as any);

    await readRecentCommits("/tmp/worktree");

    expect(mockRunGit).toHaveBeenCalledWith(
      ["log", "--format=%H%x09%s", "-n", "8", "HEAD"],
      expect.objectContaining({ cwd: "/tmp/worktree" }),
    );
  });

  it("uses a custom ref when provided", async () => {
    mockRunGit.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "aaa111bbb222\tRemote commit\n",
      stderr: "",
    } as any);

    await readRecentCommits("/tmp/worktree", 5, "origin/main");

    expect(mockRunGit).toHaveBeenCalledWith(
      ["log", "--format=%H%x09%s", "-n", "5", "origin/main"],
      expect.objectContaining({ cwd: "/tmp/worktree" }),
    );
  });

  it("returns empty array when git exits with non-zero", async () => {
    mockRunGit.mockResolvedValueOnce({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: bad default revision 'HEAD'",
    } as any);

    const commits = await readRecentCommits("/tmp/worktree");

    expect(commits).toEqual([]);
  });

  it("filters out empty lines and entries with no sha or subject", async () => {
    mockRunGit.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "abc123\tGood commit\n\n  \n\t\n",
      stderr: "",
    } as any);

    const commits = await readRecentCommits("/tmp/worktree");

    expect(commits).toEqual([{ sha: "abc123", subject: "Good commit" }]);
  });

  it("handles tab characters in the commit subject", async () => {
    mockRunGit.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "abc123\tSubject\twith\ttabs\n",
      stderr: "",
    } as any);

    const commits = await readRecentCommits("/tmp/worktree");

    expect(commits).toEqual([{ sha: "abc123", subject: "Subject\twith\ttabs" }]);
  });
});
