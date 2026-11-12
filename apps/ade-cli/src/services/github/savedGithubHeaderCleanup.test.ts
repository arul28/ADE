import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeSavedGithubHeaders } from "./savedGithubHeaderCleanup";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
}

function basicHeader(credential: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(credential, "utf8").toString("base64")}`;
}

describe("removeSavedGithubHeaders", () => {
  it("removes only ADE's saved GitHub header, from a linked worktree too, and never logs the value", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ade-saved-header-"));
    dirs.push(base);
    const repo = path.join(base, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
    const githubKey = "http.https://github.com/.extraheader";
    const adeHeader = basicHeader("x-access-token:ghu_notarealtoken");
    // What a person set: another credential on the same key, and another host.
    const personHeader = basicHeader("alice:personal-pat");
    git(repo, "config", "--local", "--add", githubKey, adeHeader);
    git(repo, "config", "--local", "--add", githubKey, personHeader);
    git(repo, "config", "--local", "--add", "http.https://git.example.com/.extraheader", basicHeader("x-access-token:other-host"));
    const worktree = path.join(base, "linked");
    git(repo, "worktree", "add", "-q", worktree);

    const warnings: unknown[] = [];
    const logger = { info: () => {}, warn: (...args: unknown[]) => { warnings.push(args); } };
    // The real git, with every argument kept: the process list is readable by other users.
    const argv: string[][] = [];
    const runGit = async (cwd: string, args: string[]) => {
      argv.push(args);
      const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
      return { code: result.status ?? 1, stdout: result.stdout };
    };

    // The project ADE opens is the linked worktree; the header lives in the main config.
    expect(await removeSavedGithubHeaders([worktree], { logger, runGit })).toBe(1);
    expect(argv.some((args) => args.includes("--unset-all"))).toBe(true);
    expect(JSON.stringify(argv)).not.toContain(adeHeader.split(" ").pop());

    expect(git(repo, "config", "--local", "--get-all", githubKey).trim().split("\n")).toEqual([personHeader]);
    // A header for a different host is not ADE's GitHub sign-in, even in the same form.
    expect(git(repo, "config", "--local", "--get-all", "http.https://git.example.com/.extraheader").trim()).not.toBe("");
    const logged = JSON.stringify(warnings);
    expect(logged).toContain("github.saved_header_removed");
    expect(logged).not.toContain("ghu_notarealtoken");
    expect(logged).not.toContain(adeHeader.split(" ").pop());

    // Once removed, the next open finds nothing to do.
    expect(await removeSavedGithubHeaders([repo, path.join(base, "not-a-repo")], { logger })).toBe(0);
  });
});
