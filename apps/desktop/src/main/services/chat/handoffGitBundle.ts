import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentChatCrossMachineGitBundle,
  AgentChatCrossMachineHandoffCapsule,
} from "../../../shared/types/chat";
import { runGit, runGitOrThrow } from "../git/git";
import { CROSS_MACHINE_FORK_ENCODED_BUDGET_BYTES } from "./crossMachineForkTransport";

/**
 * Moves a branch's unpublished work between machines as one `git bundle`: the
 * commits origin does not have, plus a snapshot commit of the working tree
 * built in a private index (the user's staging and refs are never touched).
 * Applying it moves an existing branch only forward, never writes into a path
 * it did not create (except a clean ADE lane the caller hands it), and undoes
 * every step it took when a later one fails.
 */

/**
 * Git environment for a headless fetch from GitHub with this machine's own
 * token: prompts off, and the token as an extraheader through Git's config
 * environment, so it stays out of command arguments, remote URLs and anything
 * persisted. extraheader is multi-valued: the empty entry first resets any
 * header a clone left in .git/config, so GitHub never sees two Authorization
 * headers ("Duplicate header"). Without a token, a credential helper may still
 * authorize Git, and a missing one fails clearly instead of hanging.
 */
export function githubExtraHeaderGitEnv(token: string | null | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" };
  const trimmed = token?.trim();
  if (!trimmed) return env;
  const basic = Buffer.from(`x-access-token:${trimmed}`, "utf8").toString("base64");
  return {
    ...env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Raw bundle cap. Past this the branch should simply be pushed. */
export const HANDOFF_GIT_BUNDLE_MAX_BYTES = 50 * 1024 * 1024;
export const HANDOFF_GIT_BUNDLE_TOO_LARGE_MESSAGE =
  "This branch's changes are over 50 MB. Push the branch, then hand off again.";

/**
 * Untracked bytes past which packing is refused before hashing anything. Files
 * compress, so this is generous; it exists so a stray build folder that isn't
 * ignored fails in a second instead of after hashing gigabytes.
 */
const UNTRACKED_PRECHECK_MAX_BYTES = 4 * HANDOFF_GIT_BUNDLE_MAX_BYTES;

const GIT_TIMEOUT_MS = 120_000;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const GITLINK_MODE = "160000";

const SNAPSHOT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "ADE",
  GIT_AUTHOR_EMAIL: "handoff@ade.invalid",
  GIT_COMMITTER_NAME: "ADE",
  GIT_COMMITTER_EMAIL: "handoff@ade.invalid",
};

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

/** Refuses before hashing when untracked files are clearly too big to carry. */
async function precheckUntrackedSize(cwd: string): Promise<void> {
  const listed = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  if (listed.exitCode !== 0) return; // The real pack reports a git failure.
  let total = 0;
  for (const relative of listed.stdout.split("\0")) {
    if (!relative) continue;
    try {
      total += fs.lstatSync(path.join(cwd, relative)).size;
    } catch {
      // Vanished since listing; the snapshot will not include it either.
    }
    if (total > UNTRACKED_PRECHECK_MAX_BYTES) throw new Error(HANDOFF_GIT_BUNDLE_TOO_LARGE_MESSAGE);
  }
}

/**
 * Paths in `git --raw -z` output (":<old mode> <new mode> <old sha> <new sha>
 * <status>\0<path>\0", possibly with empty separators between commits),
 * refusing any submodule pointer.
 */
function rawChangedPaths(raw: string): string[] {
  const fields = raw.split("\0");
  const changed: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const meta = fields[index]!;
    if (!meta.startsWith(":")) continue;
    const relative = fields[index + 1];
    index += 1;
    if (!relative) continue;
    const [oldMode, newMode] = meta.slice(1).split(" ");
    if (oldMode === GITLINK_MODE || newMode === GITLINK_MODE) {
      throw new Error("Submodule changes can't travel; commit and push them first.");
    }
    changed.push(relative);
  }
  return changed;
}

/**
 * A bundle carries Git objects only. A submodule pointer would arrive naming a
 * commit the other machine may never get, and an LFS file would arrive as a
 * pointer with no content, so both are refused instead of half-moved, whether
 * they sit in the uncommitted snapshot or in a commit origin doesn't have yet.
 * Returns the snapshot's changed paths.
 */
async function refuseUnportablePaths(cwd: string, tip: string, snapshot: string | null): Promise<string[]> {
  const snapshotPaths = snapshot
    ? rawChangedPaths(await gitOut(cwd, ["diff", "--raw", "--no-renames", "-z", tip, snapshot]))
    : [];
  const carried = await runGitOrThrow(
    ["log", "--raw", "-z", "--no-renames", "--format=", tip, "--not", "--remotes=origin"],
    { cwd, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 64 * 1024 * 1024 },
  );
  const commitPaths = rawChangedPaths(carried);
  const checked = [...new Set([...snapshotPaths, ...commitPaths])];
  if (checked.length) {
    const attrs = await runGit(["check-attr", "-z", "--stdin", "filter"], {
      cwd,
      timeoutMs: 30_000,
      stdin: `${checked.join("\0")}\0`,
    });
    if (attrs.exitCode === 0) {
      // -z: "<path>\0filter\0<value>\0" per path.
      const parts = attrs.stdout.split("\0");
      for (let index = 0; index + 2 < parts.length; index += 3) {
        if (parts[index + 2] === "lfs") throw new Error("Git LFS files can't travel; push them first.");
      }
    }
  }
  return snapshotPaths;
}

/**
 * Packs what origin does not have on `branchRef` in `worktreePath`. Returns
 * null when the tree is clean and every commit is already on origin.
 *
 * Throws when the upstream (or `remoteBranchSha`, the branch as the caller
 * just read it from origin) has commits HEAD lacks, when the changes include a
 * submodule pointer or an LFS file, and over 50 MiB raw or when the base64
 * would exceed `maxEncodedBytes`.
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
  if (!tip) throw new Error("The source lane has no commit to hand off.");
  const current = await runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd, timeoutMs: 15_000 });
  if (current.exitCode !== 0 || current.stdout.trim() !== `refs/heads/${branch}`) {
    throw new Error(`The source lane is not on branch '${branch}'.`);
  }

  const divergedMessage = `'${branch}' on origin has commits this lane doesn't. Pull or rebase, then hand off again.`;
  const upstream = await resolveCommit(cwd, "@{upstream}");
  if (upstream && upstream !== tip && (await isAncestor(cwd, upstream, tip)) !== true) {
    throw new Error(divergedMessage);
  }
  const remoteSha = args.remoteBranchSha?.trim() || null;
  if (remoteSha && remoteSha !== tip && (await isAncestor(cwd, remoteSha, tip)) !== true) {
    // Missing object counts too: origin moved to something this lane never saw.
    throw new Error(divergedMessage);
  }

  await precheckUntrackedSize(cwd);
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
  const changedFileCount = (await refuseUnportablePaths(cwd, tip, snapshotSha)).length;

  // Only origin counts: the destination fetches the bundle's base from origin,
  // so a commit that exists only on some other remote must travel too.
  const toCarry = Number.parseInt(await gitOut(cwd, ["rev-list", "--count", head, "--not", "--remotes=origin"]), 10);
  if (!Number.isSafeInteger(toCarry) || toCarry <= 0) return null;
  const unpushedCommitCount = Number.parseInt(
    await gitOut(cwd, ["rev-list", "--count", tip, "--not", "--remotes=origin"]),
    10,
  );

  const ref = `${handoffRefPrefix(args.handoffId)}/head`;
  const tempDir = makeTempDir();
  try {
    await gitOut(cwd, ["update-ref", ref, head]);
    const bundlePath = path.join(tempDir, "handoff.bundle");
    await gitOut(cwd, ["bundle", "create", bundlePath, ref, "--not", "--remotes=origin"]);
    const bytes = fs.statSync(bundlePath).size;
    if (bytes > HANDOFF_GIT_BUNDLE_MAX_BYTES) throw new Error(HANDOFF_GIT_BUNDLE_TOO_LARGE_MESSAGE);
    const encodedBytes = Math.ceil(bytes / 3) * 4;
    if (args.maxEncodedBytes !== undefined && encodedBytes > args.maxEncodedBytes) {
      throw new Error(HANDOFF_GIT_BUNDLE_TOO_LARGE_MESSAGE);
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

/**
 * Checks `capsule.gitBundle` (when present) as it arrives from another
 * machine: well-formed, sized as declared, ending at the capsule's own commit,
 * and fitting one transport frame together with any fork history.
 */
export function validateHandoffGitBundle(capsule: AgentChatCrossMachineHandoffCapsule): void {
  if (capsule.gitBundle === undefined) return;
  const bundle = capsule.gitBundle;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("The handoff capsule has malformed branch changes.");
  }
  const validCount = (value: unknown): boolean =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
  const validBytes = typeof bundle.bytes === "number"
    && Number.isSafeInteger(bundle.bytes)
    && bundle.bytes > 0
    && bundle.bytes <= HANDOFF_GIT_BUNDLE_MAX_BYTES;
  if (
    typeof bundle.contentBase64 !== "string"
    || bundle.contentBase64.length > CROSS_MACHINE_FORK_ENCODED_BUDGET_BYTES
    || !BASE64_PATTERN.test(bundle.contentBase64)
    || !validBytes
    || Math.ceil(bundle.bytes / 3) * 4 !== bundle.contentBase64.length
  ) {
    throw new Error("The handoff capsule has invalid branch changes content.");
  }
  if (
    typeof bundle.branchHeadSha !== "string"
    || bundle.branchHeadSha !== capsule.source.headSha
    || (bundle.snapshotSha !== null
      && (typeof bundle.snapshotSha !== "string" || !SHA_PATTERN.test(bundle.snapshotSha)))
    || !validCount(bundle.unpushedCommitCount)
    || !validCount(bundle.changedFileCount)
  ) {
    throw new Error("The handoff capsule has invalid branch changes metadata.");
  }
  // The whole capsule rides one transport frame.
  const forkEncodedBytes = (capsule.forkTransport?.mainFile.contentBase64Gzip.length ?? 0)
    + (capsule.forkTransport?.sideFiles ?? []).reduce((total, file) => total + file.contentBase64Gzip.length, 0)
    + (capsule.transcriptEnvelopes?.contentBase64Gzip.length ?? 0);
  if (forkEncodedBytes + bundle.contentBase64.length > CROSS_MACHINE_FORK_ENCODED_BUDGET_BYTES) {
    throw new Error(HANDOFF_GIT_BUNDLE_TOO_LARGE_MESSAGE);
  }
}

export type HandoffGitBundleTarget =
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
   * exact handoff is left as it is (a retry after success).
   */
  | { kind: "existing_worktree"; worktreePath: string };

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
}): Promise<void> {
  const { projectRoot, bundle } = args;
  const branch = args.branchRef.replace(/^refs\/heads\//, "");
  const tip = bundle.branchHeadSha;
  const snapshot = bundle.snapshotSha;
  if (!SHA_PATTERN.test(tip) || (snapshot !== null && !SHA_PATTERN.test(snapshot))) {
    throw new Error("The handed-off changes name an invalid commit.");
  }
  const content = Buffer.from(bundle.contentBase64, "base64");
  if (content.length !== bundle.bytes || content.length > HANDOFF_GIT_BUNDLE_MAX_BYTES) {
    throw new Error("The handed-off changes arrived damaged. Hand off again.");
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

    // The bundle builds on commits origin has; fetch them when missing here.
    if (!(await gitOk(projectRoot, ["bundle", "verify", bundlePath]))) {
      await runGit(["fetch", "--quiet", "origin"], {
        cwd: projectRoot,
        timeoutMs: GIT_TIMEOUT_MS,
        ...(args.fetchEnv ? { env: args.fetchEnv } : {}),
      });
      if (!(await gitOk(projectRoot, ["bundle", "verify", bundlePath]))) {
        throw new Error(
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
      throw new Error("The handed-off changes don't match what was sent.");
    }
    // Deleted in `finally`, success or not.
    await gitOut(projectRoot, ["fetch", "--quiet", "--no-tags", bundlePath, `+${heads[0]![1]}:${tempRef}`]);
    if ((await resolveCommit(projectRoot, tempRef)) !== expectedHead) {
      throw new Error("The handed-off changes don't match what was sent.");
    }
    if (snapshot !== null) {
      const parents = (await gitOut(projectRoot, ["rev-list", "--parents", "-n", "1", snapshot])).split(/\s+/).slice(1);
      if (parents.length !== 1 || parents[0] !== tip) {
        throw new Error("The handed-off snapshot is not on top of the branch tip.");
      }
    }

    let worktreePath: string;
    let landedOnExistingLane = false;

    if (args.target.kind === "existing_worktree") {
      worktreePath = args.target.worktreePath;
      const onBranch = await runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: worktreePath, timeoutMs: 15_000 });
      if (onBranch.exitCode !== 0 || onBranch.stdout.trim() !== `refs/heads/${branch}`) {
        throw new Error(`The destination lane is not on '${branch}'.`);
      }
      const current = await resolveCommit(worktreePath, "HEAD");
      const status = await gitOut(worktreePath, ["status", "--porcelain=v1"]);
      if (status) {
        const alreadyApplied = current === tip
          && (await readHandoffWorkingTreeSha({ worktreePath }))
            === (await gitOut(worktreePath, ["rev-parse", `${expectedHead}^{tree}`]));
        if (alreadyApplied) return;
        throw new Error(
          `The destination lane on '${branch}' has uncommitted changes. Commit or discard them there, then hand off again.`,
        );
      }
      if (!current) throw new Error("The destination lane has no readable commit.");
      if (current !== tip) {
        if ((await isAncestor(worktreePath, current, tip)) !== true) {
          throw new Error(
            `'${branch}' on this machine has commits the handed-off work lacks. Reconcile the branches, then hand off again.`,
          );
        }
        // "Clean" ignores ignored files, and a fast-forward overwrites one
        // that an arriving commit adds (a later reset could not bring it
        // back). Refuse before the branch moves.
        const added = (await gitOut(worktreePath, ["diff", "--name-only", "--diff-filter=A", "-z", current, tip]))
          .split("\0")
          .filter(Boolean);
        // A path the lane's commit tracks (a directory the commits turn into a
        // file, say) is git's to replace; only untracked or ignored files are
        // at risk.
        let collision: string | undefined;
        for (const relPath of added) {
          if (!fs.existsSync(path.join(worktreePath, relPath))) continue;
          const tracked = await gitOut(worktreePath, ["ls-tree", "-r", "--name-only", current, "--", relPath]);
          // A tracked directory git replaces can still hold ignored or
          // untracked local files, which the replacement would delete.
          const local = tracked
            ? await gitOut(worktreePath, ["ls-files", "--others", "-z", "--", relPath])
            : "";
          if (!tracked || local.replace(/\0/g, "")) {
            collision = relPath;
            break;
          }
        }
        if (collision) {
          throw new Error(
            `The destination lane already has '${collision}' (an ignored or untracked file) where the handed-off commits add one. Move it aside, then hand off again.`,
          );
        }
        await gitOut(worktreePath, ["merge", "--ff-only", "--quiet", tip]);
      }
      // The lane was clean, so a hard reset back loses nothing of the user's.
      landedOnExistingLane = true;
      undo.push(() => ignore(() => runGit(["reset", "--hard", "--quiet", current], { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS })));
    } else {
      const ref = `refs/heads/${branch}`;
      const existing = await resolveCommit(projectRoot, ref);
      if (existing) {
        const worktrees = await gitOut(projectRoot, ["worktree", "list", "--porcelain"]);
        if (worktrees.split(/\r?\n/).some((line) => line.trim() === `branch ${ref}`)) {
          throw new Error(
            `'${branch}' is checked out in another worktree on this machine. Switch that checkout off it, then hand off again.`,
          );
        }
        if (existing !== tip) {
          if ((await isAncestor(projectRoot, existing, tip)) !== true) {
            throw new Error(
              `'${branch}' on this machine has commits the handed-off work lacks. Reconcile the branches, then hand off again.`,
            );
          }
          // Compare-and-swap: fails if the branch moved since it was read.
          await gitOut(projectRoot, ["update-ref", ref, tip, existing]);
          undo.push(() => ignore(() => runGit(["update-ref", ref, existing, tip], { cwd: projectRoot, timeoutMs: 15_000 })));
        }
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

      const attached = await args.target.attach(branch);
      worktreePath = attached.worktreePath;
      undo.push(() => ignore(attached.undo));
      if ((await resolveCommit(worktreePath, "HEAD")) !== tip) {
        throw new Error("The new checkout is not at the handed-off commit.");
      }
    }

    if (snapshot !== null) {
      // Never overwrite a file that exists only on this machine (ignored or stray).
      const added = (await gitOut(worktreePath, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=A", tip, snapshot]))
        .split("\0")
        .filter(Boolean);
      const collision = added.find((relative) => fs.existsSync(path.join(worktreePath, relative)));
      if (collision) {
        throw new Error(
          `'${collision}' already exists in the destination lane and would be overwritten. Move it aside, then hand off again.`,
        );
      }
      if (landedOnExistingLane) {
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
  } catch (error) {
    for (const step of undo.reverse()) await step();
    undo.length = 0;
    throw error;
  } finally {
    await runGit(["update-ref", "-d", tempRef], { cwd: projectRoot, timeoutMs: 15_000 });
    removeTempDir(tempDir);
  }
}

/** The lane fields landing needs; ADE's `LaneSummary` satisfies it. */
export type HandoffBundleLane = {
  id: string;
  worktreePath: string;
  laneType?: string | null;
};

/**
 * Lands `capsule.gitBundle` in a lane: the branch at the handed-off tip and
 * the snapshot's changes uncommitted. Reuses `existingLane` (clean, at or
 * behind the tip, or already holding this exact handoff); otherwise imports a
 * new lane, which is deleted again if a later step fails.
 *
 * Never lands in a primary checkout: that is the person's own working copy on
 * this machine, and a move must not rewrite it. The caller passes no primary
 * lane, and one handed in anyway is refused.
 */
/**
 * One landing at a time per destination branch. Two moves of the same branch
 * into one checkout would otherwise interleave their clean checks, applies and
 * `reset --hard` rollbacks, and one rollback could erase the other's arriving
 * changes. Acceptance runs in this one brain, so an in-process queue is the
 * whole lock.
 */
const landingQueues = new Map<string, Promise<unknown>>();

export async function landHandoffGitBundle<Lane extends HandoffBundleLane>(
  args: LandHandoffGitBundleArgs<Lane>,
): Promise<Lane> {
  const key = `${path.resolve(args.projectRoot)}\0${args.branchRef}`;
  const previous = landingQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => landHandoffGitBundleNow(args));
  landingQueues.set(key, run);
  try {
    return await run;
  } finally {
    if (landingQueues.get(key) === run) landingQueues.delete(key);
  }
}

type LandHandoffGitBundleArgs<Lane extends HandoffBundleLane> = {
  projectRoot: string;
  capsule: AgentChatCrossMachineHandoffCapsule;
  handoffId: string;
  branchRef: string;
  existingLane: Lane | null;
  fetchEnv?: NodeJS.ProcessEnv;
  importLane: (input: { branchRef: string; name: string; description: string }) => Promise<Lane>;
  deleteLane: (laneId: string) => Promise<void>;
  /**
   * Called the moment the lane is chosen (an existing one, or a new one as
   * soon as it exists), before any change lands in it, so a crash mid-apply
   * retries into that lane instead of refusing it as someone else's work.
   */
  onLaneImported: (laneId: string) => void;
};

async function landHandoffGitBundleNow<Lane extends HandoffBundleLane>(
  args: LandHandoffGitBundleArgs<Lane>,
): Promise<Lane> {
  const bundle = args.capsule.gitBundle;
  if (!bundle) throw new Error("The handoff carries no branch changes to land.");
  if (args.existingLane?.laneType === "primary") {
    throw new Error("Handed-off changes never land in this machine's primary checkout.");
  }
  if (args.existingLane) {
    args.onLaneImported(args.existingLane.id);
    await applyHandoffGitBundle({
      projectRoot: args.projectRoot,
      handoffId: args.handoffId,
      branchRef: args.branchRef,
      bundle,
      ...(args.fetchEnv ? { fetchEnv: args.fetchEnv } : {}),
      target: { kind: "existing_worktree", worktreePath: args.existingLane.worktreePath },
    });
    return args.existingLane;
  }
  let imported: Lane | null = null;
  await applyHandoffGitBundle({
    projectRoot: args.projectRoot,
    handoffId: args.handoffId,
    branchRef: args.branchRef,
    bundle,
    ...(args.fetchEnv ? { fetchEnv: args.fetchEnv } : {}),
    target: {
      kind: "attach",
      attach: async (branch) => {
        const lane = await args.importLane({
          branchRef: branch,
          name: args.capsule.source.laneName,
          description: `Received from ${args.capsule.source.machineName}`,
        });
        imported = lane;
        // Binding the lane to the handoff record can fail; the apply only
        // learns how to undo the lane from this return, so undo it here.
        try {
          args.onLaneImported(lane.id);
        } catch (error) {
          await args.deleteLane(lane.id).catch(() => {});
          throw error;
        }
        return {
          worktreePath: lane.worktreePath,
          // The bundle apply restores the branch ref itself.
          undo: () => args.deleteLane(lane.id),
        };
      },
    },
  });
  if (!imported) throw new Error("ADE could not create the destination lane for the handed-off changes.");
  return imported;
}
