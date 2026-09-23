import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLaneCreateRemoteBase, resolveLaneCreateRemoteBaseDetailed } from "./laneCreateRemoteBase";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repo whose local `main` tracks `origin/main`; `withRemoteRef` controls whether that ref exists. */
function setup(withRemoteRef: boolean) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-base-")));
  roots.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "config", "branch.main.remote", "origin");
  git(repo, "config", "branch.main.merge", "refs/heads/main");
  if (withRemoteRef) git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const deps = {
    laneService: {
      list: vi.fn(async () => [{ id: "primary", laneType: "primary", baseRef: "main", branchRef: "main", worktreePath: repo }]),
    } as never,
    gitService: {
      fetch: vi.fn(async () => undefined),
      // Branch listings fold `origin/main` into the local `main` row that tracks it.
      listBranches: vi.fn(async () => [{ name: "main", isCurrent: true, isRemote: false, upstream: "origin/main" }]),
    } as never,
    onWarning: vi.fn(),
  };
  return { repo, deps };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveLaneCreateRemoteBase", () => {
  it("returns the tracked upstream when it resolves, with the fetch outcome", async () => {
    const { deps } = setup(true);
    await expect(resolveLaneCreateRemoteBaseDetailed(deps)).resolves.toEqual({ baseRef: "origin/main", fetchSucceeded: true });
  });

  it("returns null (local default) when the configured upstream is gone", async () => {
    const { deps } = setup(false);
    await expect(resolveLaneCreateRemoteBase(deps)).resolves.toBeNull();
    await expect(resolveLaneCreateRemoteBaseDetailed(deps)).resolves.toEqual({ baseRef: null, fetchSucceeded: true });
    expect(deps.onWarning).toHaveBeenCalledWith(expect.stringContaining("no longer exists"));
  });

  it("reports a failed fetch structurally instead of through the warning text", async () => {
    const { deps } = setup(true);
    (deps.gitService as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch.mockRejectedValueOnce(new Error("offline"));
    await expect(resolveLaneCreateRemoteBaseDetailed(deps)).resolves.toEqual({ baseRef: "origin/main", fetchSucceeded: false });
  });
});
