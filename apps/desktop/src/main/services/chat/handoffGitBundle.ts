import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentChatCrossMachineGitBundle } from "../../../shared/types/chat";
import { runGit, runGitOrThrow } from "../git/git";

/**
 * Moves a branch's unpublished work between machines as one `git bundle`: the
 * commits no remote has, plus a snapshot commit of the working tree built in a
 * private index (the user's staging and refs are never touched). Applying it
 * moves an existing branch only forward, never writes into a path it did not
 * create (except a clean ADE lane the caller hands it), and undoes every step
 * it took when a later one fails.
 */

/** Raw bundle cap. Past this the branch should simply be pushed. */
export const HANDOFF_GIT_BUNDLE_MAX_BYTES = 50 * 1024 * 1024;
export const HANDOFF_GIT_BUNDLE_TOO_LARGE_MESSAGE =
  "This branch's changes are over 50 MB. Push the branch, then hand off again.";

const GIT_TIMEOUT_MS = 120_000;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

const SNAPSHOT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "ADE",
  GIT_AUTHOR_EMAIL: "handoff@ade.invalid",
  GIT_COMMITTER_NAME: "ADE",
  GIT_COMMITTER_EMAIL: "handoff@ade.invalid",
};

export class HandoffGitBundleError extends Error {
  constructor(
    readonly reason:
      | "too_large"
      | "diverged"
      | "missing_base"
      | "checked_out_elsewhere"
      | "dirty_destination"
      | "path_collision"
      | "invalid_bundle"
      | "git_failed",
    message: string,
  ) {
    super(message);
    this.name = "HandoffGitBundleError";
  }
}

/** Handoff ids may contain `:`, which a ref name cannot; key refs by a hash. */
function handoffRefPrefix(handoffId: string): string {
  return `refs/ade-handoff/${createHash("sha256").update(handoffId, "utf8").digest("hex").slice(0, 32)}`;
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-handoff-"));
}

function removeTempDir(dir: string): void {
  try {
    // maxRetries covers Windows handles that close a moment after git exits.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best effort: a leftover temp dir holds no user data.
  }
}

async function gitOut(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return (await runGitOrThrow(args, { cwd, timeoutMs: GIT_TIMEOUT_MS, ...(env ? { env } : {}) })).trim();
}

async function gitOk(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
  return (await runGit(args, { cwd, timeoutMs: GIT_TIMEOUT_MS, ...(env ? { env } : {}) })).exitCode === 0;
}

async function resolveCommit(cwd: string, ref: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, timeoutMs: 15_000 });
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

/** 0 = ancestor, 1 = not an ancestor, null = undecidable (object missing). */
async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean | null> {
  const result = await runGit(["merge-base", "--is-ancestor", ancestor, descendant], { cwd, timeoutMs: 30_000 });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return null;
}

/**
 * The tree the working tree would commit as, untracked files included and
 * ignored files excluded. Built in a private copy of the index so the user's
 * staging is untouched; copying (rather than `read-tree HEAD`) keeps the stat
 * cache and sparse-checkout bits.
 */
export async function readHandoffWorkingTreeSha(args: { worktreePath: string }): Promise<string> {
  const topLevel = await gitOut(args.worktreePath, ["rev-parse", "--show-toplevel"]);
  const realIndex = path.resolve(topLevel, await gitOut(topLevel, ["rev-parse", "--git-path", "index"]));
  const tempDir = makeTempDir();
  try {
    const indexPath = path.join(tempDir, "index");
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexPath };
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, indexPath);
    else await gitOut(topLevel, ["read-tree", "HEAD"], env);
    await gitOut(topLevel, ["add", "--all", "--", "."], env);
    return await gitOut(topLevel, ["write-tree"], env);
  } finally {
    removeTempDir(tempDir);
  }
}

/**
 * Packs what no remote has on `branchRef` in `worktreePath`. Returns null when
 * the tree is clean and every commit is already on a remote.
 *
 * Throws `diverged` when the upstream (or `remoteBranchSha`, the branch as the
 * caller just read it from origin) has commits HEAD lacks, and `too_large`
 * over 50 MiB raw or when the base64 would exceed `maxEncodedBytes`.
 */
export async function packHandoffGitBundle(args: {
  worktreePath: string;
  branchRef: string;
  handoffId: string;
  remoteBranchSha?: string | null;
  maxEncodedBytes?: number;
}): Promise<AgentChatCrossMachineGitBundle | null> {
  const cwd = await gitOut(args.worktreePath, ["rev-parse", "--show-toplevel"]);
  const branch = args.branchRef.replace(/^refs\/heads\//, "");
  const tip = await resolveCommit(cwd, "HEAD");
  if (!tip) throw new HandoffGitBundleError("git_failed", "The source lane has no commit to hand off.");
  const current = await runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd, timeoutMs: 15_000 });
  if (current.exitCode !== 0 || current.stdout.trim() !== `refs/heads/${branch}`) {
    throw new HandoffGitBundleError("git_failed", `The source lane is not on branch '${branch}'.`);
  }

  const divergedMessage = `'${branch}' on origin has commits this lane doesn't. Pull or rebase, then hand off again.`;
  const upstream = await resolveCommit(cwd, "@{upstream}");
  if (upstream && upstream !== tip && (await isAncestor(cwd, upstream, tip)) !== true) {
    throw new HandoffGitBundleError("diverged", divergedMessage);
  }
  const remoteSha = args.remoteBranchSha?.trim() || null;
  if (remoteSha && remoteSha !== tip && (await isAncestor(cwd, remoteSha, tip)) !== true) {
    // Missing object counts too: origin moved to something this lane never saw.
    throw new HandoffGitBundleError("diverged", divergedMessage);
  }

  const workingTree = await readHandoffWorkingTreeSha({ worktreePath: cwd });
  const tipTree = await gitOut(cwd, ["rev-parse", `${tip}^{tree}`]);
  const snapshotSha = workingTree === tipTree
    ? null
    : await gitOut(
        cwd,
        ["commit-tree", workingTree, "-p", tip, "-m", `ADE handoff ${args.handoffId}`],
        SNAPSHOT_IDENTITY,
      );
  const head = snapshotSha ?? tip;

  const toCarry = Number.parseInt(await gitOut(cwd, ["rev-list", "--count", head, "--not", "--remotes"]), 10);
  if (!Number.isSafeInteger(toCarry) || toCarry <= 0) return null;
  const unpushedCommitCount = Number.parseInt(
    await gitOut(cwd, ["rev-list", "--count", tip, "--not", "--remotes"]),
    10,
  );
  const changedFileCount = snapshotSha
    ? (await gitOut(cwd, ["diff", "--no-renames", "--name-only", "-z", tip, snapshotSha]))
        .split("\0")
        .filter(Boolean).length
    : 0;

  const ref = `${handoffRefPrefix(args.handoffId)}/head`;
  const tempDir = makeTempDir();
  try {
    await gitOut(cwd, ["update-ref", ref, head]);
    const bundlePath = path.join(tempDir, "handoff.bundle");
    await gitOut(cwd, ["bundle", "create", bundlePath, ref, "--not", "--remotes"]);
    const bytes = fs.statSync(bundlePath).size;
    if (bytes > HANDOFF_GIT_BUNDLE_MAX_BYTES) {
      throw new HandoffGitBundleError("too_large", HANDOFF_GIT_BUNDLE_TOO_LARGE_MESSAGE);
    }
    const encodedBytes = Math.ceil(bytes / 3) * 4;
    if (args.maxEncodedBytes !== undefined && encodedBytes > args.maxEncodedBytes) {
      throw new HandoffGitBundleError("too_large", HANDOFF_GIT_BUNDLE_TOO_LARGE_MESSAGE);
    }
    return {
      contentBase64: fs.readFileSync(bundlePath).toString("base64"),
      bytes,
      branchHeadSha: tip,
      snapshotSha,
      unpushedCommitCount: Number.isSafeInteger(unpushedCommitCount) ? unpushedCommitCount : 0,
      changedFileCount,
    };
  } finally {
    await runGit(["update-ref", "-d", ref], { cwd, timeoutMs: 15_000 });
    removeTempDir(tempDir);
  }
}

export type HandoffGitBundleTarget =
  /** `git worktree add` at a path that must not already hold files. */
  | { kind: "new_worktree"; worktreePath: string }
  /**
   * The caller creates the checkout for the (now present) branch, e.g. ADE's
   * lane import, and returns how to undo it.
   */
  | {
      kind: "attach";
      attach: (branchRef: string) => Promise<{ worktreePath: string; undo: () => Promise<void> }>;
    }
  /**
   * A worktree already on `branchRef`. Must be clean and at or behind the
   * handed-off tip; it is fast-forwarded. A worktree that already holds this
   * exact handoff is reported as `alreadyApplied` (retry after success).
   */
  | { kind: "existing_worktree"; worktreePath: string };

export type ApplyHandoffGitBundleResult = {
  worktreePath: string;
  /** Null when the work landed on a detached checkout. */
  branchRef: string | null;
  alreadyApplied: boolean;
};

/**
 * Applies a bundle so `branchRef` ends at `bundle.branchHeadSha` and the
 * snapshot's changes are uncommitted (unstaged) in the worktree. Any failing
 * step undoes the earlier ones; temporary refs and files never outlive it.
 */
export async function applyHandoffGitBundle(args: {
  projectRoot: string;
  handoffId: string;
  branchRef: string;
  bundle: AgentChatCrossMachineGitBundle;
  target: HandoffGitBundleTarget;
  /** Env for `git fetch origin` (destination credentials, no prompts). */
  fetchEnv?: NodeJS.ProcessEnv;
}): Promise<ApplyHandoffGitBundleResult> {
  const { projectRoot, bundle } = args;
  const branch = args.branchRef.replace(/^refs\/heads\//, "");
  const tip = bundle.branchHeadSha;
  const snapshot = bundle.snapshotSha;
  if (!SHA_PATTERN.test(tip) || (snapshot !== null && !SHA_PATTERN.test(snapshot))) {
    throw new HandoffGitBundleError("invalid_bundle", "The handed-off changes name an invalid commit.");
  }
  const content = Buffer.from(bundle.contentBase64, "base64");
  if (content.length !== bundle.bytes || content.length > HANDOFF_GIT_BUNDLE_MAX_BYTES) {
    throw new HandoffGitBundleError("invalid_bundle", "The handed-off changes arrived damaged. Hand off again.");
  }

  const tempRef = `${handoffRefPrefix(args.handoffId)}/head`;
  const tempDir = makeTempDir();
  const undo: Array<() => Promise<void>> = [];
  const ignore = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch {
      // Rollback is best effort per step; keep undoing the rest.
    }
  };
  try {
    const bundlePath = path.join(tempDir, "handoff.bundle");
    fs.writeFileSync(bundlePath, content);

    // The bundle builds on commits a remote has; fetch them when missing here.
    if (!(await gitOk(projectRoot, ["bundle", "verify", bundlePath]))) {
      await runGit(["fetch", "--quiet", "origin"], {
        cwd: projectRoot,
        timeoutMs: GIT_TIMEOUT_MS,
        ...(args.fetchEnv ? { env: args.fetchEnv } : {}),
      });
      if (!(await gitOk(projectRoot, ["bundle", "verify", bundlePath]))) {
        throw new HandoffGitBundleError(
          "missing_base",
          "This machine lacks the commits the handed-off changes build on, even after fetching origin. Push the branch on the source machine, then hand off again.",
        );
      }
    }
    const heads = (await gitOut(projectRoot, ["bundle", "list-heads", bundlePath]))
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 2 && SHA_PATTERN.test(parts[0]!));
    const expectedHead = snapshot ?? tip;
    if (heads.length !== 1 || heads[0]![0] !== expectedHead) {
      throw new HandoffGitBundleError("invalid_bundle", "The handed-off changes don't match what was sent.");
    }
    // Deleted in `finally`, success or not.
    await gitOut(projectRoot, ["fetch", "--quiet", "--no-tags", bundlePath, `+${heads[0]![1]}:${tempRef}`]);
    if ((await resolveCommit(projectRoot, tempRef)) !== expectedHead) {
      throw new HandoffGitBundleError("invalid_bundle", "The handed-off changes don't match what was sent.");
    }
    if (snapshot !== null) {
      const parents = (await gitOut(projectRoot, ["rev-list", "--parents", "-n", "1", snapshot])).split(/\s+/).slice(1);
      if (parents.length !== 1 || parents[0] !== tip) {
        throw new HandoffGitBundleError("invalid_bundle", "The handed-off snapshot is not on top of the branch tip.");
      }
    }

    let worktreePath: string;
    let landedBranch: string | null = branch;
    let rollbackLandingTo: string | null = null;

    if (args.target.kind === "existing_worktree") {
      worktreePath = args.target.worktreePath;
      const onBranch = await runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: worktreePath, timeoutMs: 15_000 });
      if (onBranch.exitCode !== 0 || onBranch.stdout.trim() !== `refs/heads/${branch}`) {
        throw new HandoffGitBundleError("checked_out_elsewhere", `The destination lane is not on '${branch}'.`);
      }
      const current = await resolveCommit(worktreePath, "HEAD");
      const status = await gitOut(worktreePath, ["status", "--porcelain=v1"]);
      if (status) {
        const alreadyApplied = current === tip
          && (await readHandoffWorkingTreeSha({ worktreePath }))
            === (await gitOut(worktreePath, ["rev-parse", `${expectedHead}^{tree}`]));
        if (alreadyApplied) return { worktreePath, branchRef: branch, alreadyApplied: true };
        throw new HandoffGitBundleError(
          "dirty_destination",
          `The destination lane on '${branch}' has uncommitted changes. Commit or discard them there, then hand off again.`,
        );
      }
      if (!current) throw new HandoffGitBundleError("git_failed", "The destination lane has no readable commit.");
      if (current !== tip) {
        if ((await isAncestor(worktreePath, current, tip)) !== true) {
          throw new HandoffGitBundleError(
            "diverged",
            `'${branch}' on this machine has commits the handed-off work lacks. Reconcile the branches, then hand off again.`,
          );
        }
        await gitOut(worktreePath, ["merge", "--ff-only", "--quiet", tip]);
      }
      // The lane was clean, so a hard reset back loses nothing of the user's.
      rollbackLandingTo = current;
      undo.push(() => ignore(() => runGit(["reset", "--hard", "--quiet", current], { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS })));
    } else {
      const ref = `refs/heads/${branch}`;
      const existing = await resolveCommit(projectRoot, ref);
      if (existing) {
        const worktrees = await gitOut(projectRoot, ["worktree", "list", "--porcelain"]);
        const checkedOut = worktrees.split(/\r?\n/).some((line) => line.trim() === `branch ${ref}`);
        if (checkedOut && (existing !== tip || args.target.kind === "attach")) {
          throw new HandoffGitBundleError(
            "checked_out_elsewhere",
            `'${branch}' is checked out in another worktree on this machine. Switch that checkout off it, then hand off again.`,
          );
        }
        if (existing !== tip) {
          if ((await isAncestor(projectRoot, existing, tip)) !== true) {
            throw new HandoffGitBundleError(
              "diverged",
              `'${branch}' on this machine has commits the handed-off work lacks. Reconcile the branches, then hand off again.`,
            );
          }
          // Compare-and-swap: fails if the branch moved since it was read.
          await gitOut(projectRoot, ["update-ref", ref, tip, existing]);
          undo.push(() => ignore(() => runGit(["update-ref", ref, existing, tip], { cwd: projectRoot, timeoutMs: 15_000 })));
        }
        if (checkedOut) landedBranch = null;
      } else {
        // Empty old value: create only, never clobber a branch that just appeared.
        await gitOut(projectRoot, ["update-ref", ref, tip, ""]);
        undo.push(() => ignore(() => runGit(["update-ref", "-d", ref, tip], { cwd: projectRoot, timeoutMs: 15_000 })));
        // Track origin's copy when it has one, so nothing tries to publish it again.
        if (await resolveCommit(projectRoot, `refs/remotes/origin/${branch}`)) {
          await ignore(() => runGit(["branch", "--set-upstream-to", `origin/${branch}`, branch], { cwd: projectRoot, timeoutMs: 15_000 }));
          undo.push(() => ignore(() => runGit(["branch", "--unset-upstream", branch], { cwd: projectRoot, timeoutMs: 15_000 })));
        }
      }

      if (args.target.kind === "attach") {
        const attached = await args.target.attach(branch);
        worktreePath = attached.worktreePath;
        undo.push(() => ignore(attached.undo));
      } else {
        const target = args.target.worktreePath;
        // `worktree add` refuses a non-empty path, so a user's files there are never touched.
        await gitOut(
          projectRoot,
          landedBranch === null
            ? ["worktree", "add", "--detach", target, tip]
            : ["worktree", "add", target, landedBranch],
        );
        worktreePath = target;
        undo.push(() => ignore(() => runGit(["worktree", "remove", "--force", target], { cwd: projectRoot, timeoutMs: GIT_TIMEOUT_MS })));
      }
      if ((await resolveCommit(worktreePath, "HEAD")) !== tip) {
        throw new HandoffGitBundleError("git_failed", "The new checkout is not at the handed-off commit.");
      }
    }

    if (snapshot !== null) {
      // Never overwrite a file that exists only on this machine (ignored or stray).
      const added = (await gitOut(worktreePath, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=A", tip, snapshot]))
        .split("\0")
        .filter(Boolean);
      const collision = added.find((relative) => fs.existsSync(path.join(worktreePath, relative)));
      if (collision) {
        throw new HandoffGitBundleError(
          "path_collision",
          `'${collision}' already exists in the destination lane and would be overwritten. Move it aside, then hand off again.`,
        );
      }
      if (rollbackLandingTo !== null) {
        undo.push(async () => {
          for (const relative of added) {
            await ignore(async () => fs.rmSync(path.join(worktreePath, relative), { force: true }));
          }
        });
      }
      // The working tree as it was, then the index back on the tip so every
      // change shows as uncommitted.
      await gitOut(worktreePath, ["checkout", "--no-overlay", snapshot, "--", "."]);
      await gitOut(worktreePath, ["reset", "--quiet", tip]);
    }
    undo.length = 0;
    return { worktreePath, branchRef: landedBranch, alreadyApplied: false };
  } catch (error) {
    for (const step of undo.reverse()) await step();
    undo.length = 0;
    throw error;
  } finally {
    await runGit(["update-ref", "-d", tempRef], { cwd: projectRoot, timeoutMs: 15_000 });
    removeTempDir(tempDir);
  }
}
