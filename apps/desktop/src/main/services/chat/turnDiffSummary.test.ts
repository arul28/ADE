import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGit } from "../git/git";
import {
  collectTurnDiffSummary,
  countAddedLines,
  parseNameStatusZ,
  parseNumstatZ,
  parseUntrackedPorcelainZ,
  captureWorkingTreeFingerprint,
} from "./turnDiffSummary";

const repos: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runGit(args, { cwd, timeoutMs: 20_000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

async function headSha(cwd: string): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], { cwd, timeoutMs: 20_000 });
  return result.stdout.trim();
}

async function makeRepo(): Promise<string> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ade-turn-diff-"));
  repos.push(cwd);
  await git(cwd, ["init", "--initial-branch=main"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "ADE Test"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(cwd, "kept.txt"), "one\ntwo\nthree\n", "utf8");
  fs.writeFileSync(path.join(cwd, ".gitignore"), "ignored/\n", "utf8");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "base"]);
  return cwd;
}

describe("turnDiffSummary parsers", () => {
  it("reads NUL-delimited numstat records, including renames", () => {
    expect(parseNumstatZ("3\t1\tsrc/a.ts\0")).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1, status: "M" },
    ]);
    expect(parseNumstatZ("0\t0\t\0old/name.ts\0new/name.ts\0")).toEqual([
      { path: "new/name.ts", additions: 0, deletions: 0, status: "M" },
    ]);
    expect(parseNumstatZ("-\t-\timage.png\0")).toEqual([
      { path: "image.png", additions: 0, deletions: 0, status: "M" },
    ]);
  });

  it("keeps a path containing a tab intact", () => {
    expect(parseNumstatZ("1\t0\tweird\tname.ts\0")).toEqual([
      { path: "weird\tname.ts", additions: 1, deletions: 0, status: "M" },
    ]);
  });

  it("keys name-status by the destination of a rename", () => {
    const statuses = parseNameStatusZ("M\0src/a.ts\0R100\0old.ts\0new.ts\0D\0gone.ts\0");
    expect(statuses.get("src/a.ts")).toBe("M");
    expect(statuses.get("new.ts")).toBe("R");
    expect(statuses.get("old.ts")).toBeUndefined();
    expect(statuses.get("gone.ts")).toBe("D");
  });

  it("takes only untracked entries from porcelain output", () => {
    expect(parseUntrackedPorcelainZ("?? new.ts\0 M tracked.ts\0?? also/new.ts\0")).toEqual([
      "new.ts",
      "also/new.ts",
    ]);
    // A rename record carries its source in the following token; it is not untracked.
    expect(parseUntrackedPorcelainZ("R  dest.ts\0source.ts\0?? real.ts\0")).toEqual(["real.ts"]);
  });

  it("counts a new file's lines the way git would", () => {
    expect(countAddedLines(Buffer.from("a\nb\n"))).toBe(2);
    expect(countAddedLines(Buffer.from("a\nb"))).toBe(2);
    expect(countAddedLines(Buffer.from(""))).toBe(0);
    expect(countAddedLines(Buffer.from([0x61, 0x00, 0x62]))).toBe(0);
  });
});

describe("collectTurnDiffSummary", () => {
  let repo: string;
  let base: string;

  beforeAll(async () => {
    repo = await makeRepo();
    base = await headSha(repo);
  });

  afterAll(() => {
    for (const cwd of repos.splice(0)) {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("summarizes a committed turn as a range", async () => {
    fs.writeFileSync(path.join(repo, "kept.txt"), "one\ntwo\nthree\nfour\n", "utf8");
    await git(repo, ["commit", "-am", "turn"]);
    const after = await headSha(repo);

    const summary = await collectTurnDiffSummary({ cwd: repo, beforeSha: base, afterSha: after });

    expect(summary).toEqual({
      files: [{ path: "kept.txt", additions: 1, deletions: 0, status: "M" }],
      totalAdditions: 1,
      totalDeletions: 0,
    });
  });

  // The bug: an uncommitted turn reports the same sha on both sides, and the
  // caller returned early on that, so edit-and-wait-for-review turns — the most
  // common shape — showed no files-changed row at all.
  it("summarizes an uncommitted turn against the working tree", async () => {
    const head = await headSha(repo);
    fs.writeFileSync(path.join(repo, "kept.txt"), "one\ntwo\n", "utf8");
    fs.writeFileSync(path.join(repo, "brand-new.ts"), "export const a = 1;\nexport const b = 2;\n", "utf8");

    const summary = await collectTurnDiffSummary({ cwd: repo, beforeSha: head, afterSha: head });

    expect(summary).not.toBeNull();
    const byPath = new Map(summary!.files.map((file) => [file.path, file]));
    expect(byPath.get("kept.txt")).toEqual({
      path: "kept.txt",
      additions: 0,
      deletions: 2,
      status: "M",
    });
    expect(byPath.get("brand-new.ts")).toEqual({
      path: "brand-new.ts",
      additions: 2,
      deletions: 0,
      status: "A",
    });
    expect(summary!.totalAdditions).toBe(2);
    expect(summary!.totalDeletions).toBe(2);
  });

  it("counts a staged edit as part of the same uncommitted turn", async () => {
    const head = await headSha(repo);
    await git(repo, ["add", "brand-new.ts"]);

    const summary = await collectTurnDiffSummary({ cwd: repo, beforeSha: head, afterSha: head });

    const staged = summary!.files.find((file) => file.path === "brand-new.ts");
    expect(staged).toEqual({ path: "brand-new.ts", additions: 2, deletions: 0, status: "A" });
  });

  it("leaves gitignored files out of an uncommitted turn", async () => {
    const head = await headSha(repo);
    fs.mkdirSync(path.join(repo, "ignored"), { recursive: true });
    fs.writeFileSync(path.join(repo, "ignored", "build.log"), "noise\n", "utf8");

    const summary = await collectTurnDiffSummary({ cwd: repo, beforeSha: head, afterSha: head });

    expect(summary!.files.some((file) => file.path.startsWith("ignored/"))).toBe(false);
  });

  it("lists every file of a newly created directory, not the directory", async () => {
    const head = await headSha(repo);
    fs.mkdirSync(path.join(repo, "fresh"), { recursive: true });
    fs.writeFileSync(path.join(repo, "fresh", "one.ts"), "a\n", "utf8");
    fs.writeFileSync(path.join(repo, "fresh", "two.ts"), "b\n", "utf8");

    const summary = await collectTurnDiffSummary({ cwd: repo, beforeSha: head, afterSha: head });

    const fresh = summary!.files.filter((file) => file.path.startsWith("fresh/")).map((file) => file.path);
    expect(fresh.sort()).toEqual(["fresh/one.ts", "fresh/two.ts"]);
  });

  it("scopes an uncommitted turn to the files the turn touched when a fingerprint is given", async () => {
    const head = await headSha(repo);
    // Dirt that predates the turn: it must not be reported as the turn's work.
    fs.writeFileSync(path.join(repo, "kept.txt"), "older dirt\n", "utf8");
    fs.writeFileSync(path.join(repo, "pre-existing.ts"), "export const stale = true;\n", "utf8");
    const beforeTree = await captureWorkingTreeFingerprint(repo);
    expect(beforeTree).not.toBeNull();
    // The turn itself: one new file and one edit to a file that was already dirty.
    await new Promise((resolve) => setTimeout(resolve, 5));
    fs.writeFileSync(path.join(repo, "turn-new.ts"), "export const fresh = 1;\n", "utf8");
    fs.writeFileSync(path.join(repo, "kept.txt"), "older dirt\nplus the turn's line\n", "utf8");

    const summary = await collectTurnDiffSummary({ cwd: repo, beforeSha: head, afterSha: head, beforeTree });

    const paths = summary!.files.map((file) => file.path).sort();
    expect(paths).toEqual(["kept.txt", "turn-new.ts"]);
    expect(paths).not.toContain("pre-existing.ts");
  });

  it("reports nothing rather than the whole tree when the fingerprint could not be taken", async () => {
    const head = await headSha(repo);
    fs.writeFileSync(path.join(repo, "another-new.ts"), "x\n", "utf8");

    const summary = await collectTurnDiffSummary({ cwd: repo, beforeSha: head, afterSha: head, beforeTree: null });

    expect(summary).toBeNull();
  });

  it("reports a clean tree as an empty summary, not a failure", async () => {
    const clean = await makeRepo();
    const head = await headSha(clean);

    const summary = await collectTurnDiffSummary({ cwd: clean, beforeSha: head, afterSha: head });

    expect(summary).toEqual({ files: [], totalAdditions: 0, totalDeletions: 0 });
  });

  it("returns null when the before sha is not a commit git knows", async () => {
    const head = await headSha(repo);

    const summary = await collectTurnDiffSummary({
      cwd: repo,
      beforeSha: "0000000000000000000000000000000000000000",
      afterSha: head,
    });

    expect(summary).toBeNull();
  });
});
