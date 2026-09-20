import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runGit } from "../git/git";
import { getTurnFileDiffFromGit } from "./turnFileDiff";
import { getTurnFileDiffFromGit as reExportedFromActionRegistry } from "../adeActions/registry";

describe("turn file diff is one implementation", () => {
  const repos: string[] = [];

  const git = async (cwd: string, args: string[]): Promise<void> => {
    const result = await runGit(args, { cwd, timeoutMs: 20_000 });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
  };

  const makeRepo = async (): Promise<{ cwd: string; head: string }> => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ade-turn-diff-shared-"));
    repos.push(cwd);
    await git(cwd, ["init", "--initial-branch=main"]);
    await git(cwd, ["config", "user.email", "test@example.com"]);
    await git(cwd, ["config", "user.name", "ADE Test"]);
    await git(cwd, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(cwd, "app.ts"), "before\n", "utf8");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
    const head = (await runGit(["rev-parse", "HEAD"], { cwd, timeoutMs: 20_000 })).stdout.trim();
    return { cwd, head };
  };

  afterAll(() => {
    for (const cwd of repos.splice(0)) fs.rmSync(cwd, { recursive: true, force: true });
  });

  // The bug this guards: the local `ipcMain` handler kept its own copy that read
  // BOTH sides with `git show <sha>:<path>`. Preload prefers the runtime action
  // and falls back to that channel, so fixing only the action left the fallback
  // rendering "no changes" for every file an uncommitted turn listed.
  it("the action registry re-exports this module rather than keeping a second copy", () => {
    expect(reExportedFromActionRegistry).toBe(getTurnFileDiffFromGit);
  });

  it("reads the modified side from the working tree when the turn never committed", async () => {
    const { cwd, head } = await makeRepo();
    fs.writeFileSync(path.join(cwd, "app.ts"), "uncommitted edit\n", "utf8");

    const diff = await getTurnFileDiffFromGit(cwd, {
      sessionId: "s1",
      beforeSha: head,
      afterSha: head,
      filePath: "app.ts",
    });

    expect(diff.original).toMatchObject({ exists: true, text: "before\n" });
    expect(diff.modified).toMatchObject({ exists: true, text: "uncommitted edit\n" });
  });
});
