import { randomUUID } from "node:crypto";
import { AdeExpectedError } from "../../../shared/expectedError";
import type { AdeDb } from "../state/kvDb";
import { runGit } from "../git/git";
import { runGitWithGithubAuthFallback } from "../git/gitTransportAuth";
import type { Logger } from "../logging/logger";
import { branchNameFromLaneRef } from "../../../shared/laneBaseResolution";
import { resolveLinearIssueBranchName } from "../../../shared/linearIssueBranch";
import {
  normalizeLaneStart,
  plainLaneStartBranch,
  savedDefaultLaneStart,
  type NewLaneDefaults,
} from "../../../shared/laneStart";
import {
  LANE_BRANCH_NAME_MAX_CHARS,
  branchNameClash,
  branchNameClashMessage,
  laneBranchPatternProblem,
  laneBranchSlug,
  looksLikeTemporaryLaneBranch,
  renderLaneBranchName,
  renderLaneBranchPrefix,
  sanitizeBranchName,
  temporaryLaneBranchName,
} from "../../../shared/laneBranchName";
import {
  isAutoLaneTemporaryBranch,
  resolveAppliedAutoLaneBranchFragment,
} from "../../../shared/laneNameFallback";
import type {
  LaneBranchNameCheck,
  LaneLifecycleEvent,
  LaneLinearIssue,
  LaneType,
  NewLaneDefaultsSnapshot,
  RenameLaneBranchArgs,
  RenameLaneBranchResult,
} from "../../../shared/types";
import type { NewLaneSettingsStore } from "./newLaneSettingsStore";
import { assertLaneIdArg } from "./laneIdArg";
import { slugify } from "./laneWorktreeNaming";

/** The lane row columns branch naming reads. */
type LaneBranchRow = {
  id: string;
  name: string;
  lane_type: LaneType;
  branch_ref: string;
  worktree_path: string;
  color: string | null;
};

type BranchMoveOutcome =
  | "renamed"
  | "git_rename_failed"
  | "persistence_failed_git_rolled_back"
  | "persist_reconciled_after_rollback_failure";

type AutoLaneIdentityResult = {
  laneRenameOutcome: "renamed" | "kept" | "skipped" | "failed";
  branchRenameOutcome: "renamed" | "kept" | "skipped" | "failed";
  branchRef: string;
  reason?: string;
};

/**
 * What a lane's branch is called: the project's branch pattern, the
 * auto-create placeholder and its rename, typed names, and the lane menu's
 * Rename branch. Built by `createLaneService`, which owns the lane rows.
 */
export function createLaneBranchNaming(deps: {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  defaultBaseRef: string;
  logger: Logger;
  getNewLaneDefaultsForCreate: () => NewLaneDefaults;
  getNewLaneSettings: () => NewLaneSettingsStore | null;
  getValidateNewLaneTemplateId: () => ((templateId: string) => void) | null;
  getLaneRow: (laneId: string) => LaneBranchRow | null | undefined;
  getAllLaneRows: () => LaneBranchRow[];
  findActiveBranchOwner: (branchRef: string, laneId: string) => { id: string; name: string } | null;
  normalizeBranchKey: (ref: string) => string;
  /** One branch mutation per lane at a time; shared with the lane service. */
  autoLaneIdentityInFlight: Set<string>;
  renameLane: (args: { laneId: string; name: string }) => void;
  updateBranchRef: (laneId: string, branchRef: string) => void;
  invalidateLaneListCache: () => void;
  broadcastLifecycleEvent: (event: LaneLifecycleEvent) => void;
}) {
  const {
    db,
    projectId,
    projectRoot,
    logger,
    getNewLaneDefaultsForCreate,
    getLaneRow,
    findActiveBranchOwner,
    normalizeBranchKey,
    autoLaneIdentityInFlight,
  } = deps;

  // git `user.name` on this machine, for a branch pattern's `{user}`. Read at
  // most once a minute: every New lane dialog and Settings open asks for it.
  let gitUserName: { value: string | null; at: number } | null = null;
  let gitUserNameRead: Promise<string | null> | null = null;
  const readGitUserName = (): Promise<string | null> => {
    if (gitUserName && Date.now() - gitUserName.at < 60_000) return Promise.resolve(gitUserName.value);
    gitUserNameRead ??= runGit(["config", "--get", "user.name"], { cwd: projectRoot, timeoutMs: 5_000 })
      .then((res) => (res.exitCode === 0 ? res.stdout.trim() || null : null), () => null)
      .then((value) => {
        gitUserName = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        gitUserNameRead = null;
      });
    return gitUserNameRead;
  };
  /** The last read, for sync callers; starts a fresh read when it is old. */
  const cachedGitUserName = (): string | null => {
    if (!gitUserName || Date.now() - gitUserName.at >= 60_000) void readGitUserName();
    return gitUserName?.value ?? null;
  };
  const currentBranchPrefix = async (): Promise<string> =>
    renderLaneBranchPrefix(getNewLaneDefaultsForCreate().branchPattern, await readGitUserName());

  /** Plain names of every local and `origin` branch, for clash checks; [] when git can't list them. */
  const listBranchNames = async (): Promise<string[]> => {
    const res = await runGit(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"], {
      cwd: projectRoot,
      timeoutMs: 10_000,
    });
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, ""))
      .filter((name) => name && name !== "HEAD");
  };
  /**
   * The remote has this branch even though it was never fetched here. Unknown (offline) reads as no.
   * The full ref: `ls-remote` matches a bare name against the tail of every
   * ref, so `fix` would find another person's `user/fix`.
   */
  const remoteHasBranch = (ref: string): Promise<boolean> =>
    runGitWithGithubAuthFallback(["ls-remote", "--heads", "origin", `refs/heads/${ref}`], {
      cwd: projectRoot,
      timeoutMs: 15_000,
    }).then((res) => res.exitCode === 0 && res.stdout.trim().length > 0, () => false);
  const assertValidBranchRef = async (branchRef: string): Promise<void> => {
    const check = await runGit(["check-ref-format", "--branch", branchRef], { cwd: projectRoot, timeoutMs: 8_000 });
    if (check.exitCode !== 0) throw new AdeExpectedError(`"${branchRef}" isn't a valid branch name.`, "user");
  };

  /**
   * A branch name the user typed, as the lane would get it, and why it can't
   * be used (null when it can): unusable characters, a ref git refuses, or a
   * clash with a local or remote branch. `exclude` is a branch that is not in
   * the way (the lane's own, for a rename that only changes its case).
   */
  const checkTypedBranch = async (raw: string, options: { exclude?: string } = {}): Promise<LaneBranchNameCheck> => {
    const trimmed = raw.trim();
    const branchName = sanitizeBranchName(trimmed);
    if (!branchName) {
      return { branchName: "", problem: trimmed ? `"${trimmed}" can't be used as a branch name.` : "Enter a branch name." };
    }
    const valid = await runGit(["check-ref-format", "--branch", branchName], { cwd: projectRoot, timeoutMs: 8_000 });
    if (valid.exitCode !== 0) return { branchName, problem: `"${branchName}" isn't a valid branch name.` };
    const existing = (await listBranchNames()).filter((name) => name !== options.exclude);
    const clash = branchNameClash(branchName, existing) ?? ((await remoteHasBranch(branchName)) ? branchName : null);
    return { branchName, problem: clash ? branchNameClashMessage(branchName, clash) : null };
  };

  // An auto-create lane's placeholder branch carries this git config flag
  // (`branch.<name>.adeautolane`). It lives with the branch on this machine
  // only, needs no synced column, and is what tells a placeholder from a
  // user's own branch when the pattern has no prefix (`{slug}` makes the
  // placeholder a bare `1a2b3c4d`).
  const TEMPORARY_BRANCH_MARKER = "adeautolane";
  const setTemporaryBranchMarker = async (cwd: string, branch: string, on: boolean): Promise<void> => {
    const key = `branch.${branch}.${TEMPORARY_BRANCH_MARKER}`;
    await runGit(on ? ["config", key, "true"] : ["config", "--unset", key], { cwd, timeoutMs: 8_000 }).catch((error) => {
      // Without the marker a `{slug}`-only placeholder reads as the user's own
      // branch (never renamed); a stale one makes a user's branch look like one.
      logger.warn("lane.temporary_branch_marker_failed", {
        branch,
        on,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  /** An auto-create placeholder: the legacy `ade/<8 hex>`, or the current pattern's with ADE's marker. */
  const isTemporaryLaneBranch = async (branch: string, cwd = projectRoot): Promise<boolean> => {
    if (isAutoLaneTemporaryBranch(branch)) return true;
    if (!looksLikeTemporaryLaneBranch(branch)) return false;
    const marker = await runGit(["config", "--get", `branch.${branch}.${TEMPORARY_BRANCH_MARKER}`], { cwd, timeoutMs: 8_000 });
    return marker.exitCode === 0 && marker.stdout.trim() === "true";
  };

  const resolveCreateBranchRef = async (args: {
    name: string;
    laneId: string;
    branchName?: string | null;
    autoNamedBranch?: boolean;
    linearIssue?: LaneLinearIssue | null;
  }): Promise<{ branchRef: string; temporary: boolean }> => {
    const explicitBranch = args.branchName?.trim() ?? "";
    const linearBranch = !explicitBranch && args.linearIssue
      ? resolveLinearIssueBranchName(args.linearIssue)
      : "";
    const existing = await listBranchNames();
    const compactId = args.laneId.replace(/-/g, "");

    // A placeholder the auto-create lane's naming replaces. Current clients
    // send `autoNamedBranch` with a legacy `ade/<8 hex>` beside it (an older
    // brain ignores the flag and keeps that name) and read the branch back
    // from the lane, so the brain picks one in the project's pattern. An
    // older client sends the legacy name alone and later renames by that
    // exact name, so it is kept as sent.
    const placeholder = async (prefix: string): Promise<{ branchRef: string; temporary: boolean }> => {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = temporaryLaneBranchName(prefix, randomUUID().replace(/-/g, ""));
        if (!branchNameClash(candidate, existing)) return { branchRef: candidate, temporary: true };
      }
      throw new Error("Unable to allocate a unique temporary branch for the automatic lane.");
    };
    if (args.autoNamedBranch && !linearBranch && (!explicitBranch || isAutoLaneTemporaryBranch(explicitBranch))) {
      const prefix = await currentBranchPrefix();
      // A prefix that can't make a valid ref (a stale pattern) must not fail the launch.
      const result = await placeholder(prefix);
      const valid = await runGit(["check-ref-format", "--branch", result.branchRef], { cwd: projectRoot, timeoutMs: 8_000 });
      return valid.exitCode === 0 ? result : placeholder("ade/");
    }

    if (explicitBranch) {
      const legacy = sanitizeBranchName(explicitBranch);
      if (isAutoLaneTemporaryBranch(legacy)) {
        return branchNameClash(legacy, existing) ? placeholder("ade/") : { branchRef: legacy, temporary: true };
      }
      // The user named it: say exactly what is in the way rather than renaming it.
      const check = await checkTypedBranch(explicitBranch);
      if (check.problem) throw new AdeExpectedError(check.problem, "user");
      return { branchRef: check.branchName, temporary: false };
    }

    // Linear-derived and pattern names are deterministic (`ver-136-title`,
    // `ade/fix-login`) and so collide when the same issue or name comes back.
    // Keep the clean name when it is free (Linear's branch matching needs it),
    // otherwise add the lane's own id until the name is unused. Never hard-fail.
    const base = linearBranch || renderLaneBranchName(await currentBranchPrefix(), args.name);
    await assertValidBranchRef(base);
    if (!branchNameClash(base, existing) && !(await remoteHasBranch(base))) return { branchRef: base, temporary: false };
    for (let len = 6; len <= 12; len += 2) {
      const candidate = sanitizeBranchName(`${base.slice(0, LANE_BRANCH_NAME_MAX_CHARS - len - 1)}-${compactId.slice(0, len)}`);
      if (!branchNameClash(candidate, existing)) return { branchRef: candidate, temporary: false };
    }
    // Astronomically unlikely: the whole lane id is unique.
    return { branchRef: `ade/${slugify(args.name)}-${compactId}`, temporary: false };
  };

  /**
   * Why a lane's branch can't be renamed right now, or null when it can: it
   * is still checked out in the lane's folder, tracks nothing, was never
   * pushed, and has no PR. A renamed branch someone else already fetched, or
   * a PR's head, would leave them on a branch that no longer exists. Shared by
   * the auto-create rename and the lane menu's Rename branch.
   */
  const branchRenameBlocker = async (
    lane: LaneBranchRow,
    branch: string,
  ): Promise<{ blocked: { reason: string; message: string } | null; hasOrigin: boolean }> => {
    let hasOrigin = false;
    const blocked = (reason: string, message: string) => ({ blocked: { reason, message }, hasOrigin });
    const currentBranch = await runGit(["branch", "--show-current"], {
      cwd: lane.worktree_path,
      timeoutMs: 8_000,
    });
    if (currentBranch.exitCode !== 0 || branchNameFromLaneRef(currentBranch.stdout.trim()) !== branch) {
      return blocked("checked_out_branch_changed", "The lane's folder is on a different branch than ADE recorded. Refresh the lane, then try again.");
    }
    const upstream = await runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { cwd: lane.worktree_path, timeoutMs: 8_000 },
    );
    if (upstream.exitCode === 0 && upstream.stdout.trim()) {
      return blocked("upstream_configured", `${branch} tracks ${upstream.stdout.trim()}, so renaming it here would leave the remote branch behind.`);
    }
    const origin = await runGit(["remote", "get-url", "origin"], {
      cwd: lane.worktree_path,
      timeoutMs: 8_000,
    });
    hasOrigin = origin.exitCode === 0 && origin.stdout.trim().length > 0;
    if (hasOrigin) {
      const remote = await runGitWithGithubAuthFallback(
        ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
        { cwd: lane.worktree_path, timeoutMs: 12_000 },
      );
      if (remote.exitCode === 0 && remote.stdout.trim()) {
        return blocked("temporary_branch_pushed", `${branch} is already on the remote. Renaming it would leave the pushed branch behind.`);
      }
      if (remote.exitCode !== 2) {
        return blocked("remote_state_unavailable", "ADE couldn't reach the remote to check that the branch was never pushed. Try again when you're online.");
      }
    }
    const pr = db.get<{ id: string }>(
      "select id from pull_requests where project_id = ? and lane_id = ? and detached_at is null limit 1",
      [projectId, lane.id],
    );
    if (pr) return blocked("pull_request_exists", "This lane has a pull request, and a PR's branch can't be renamed.");
    return { blocked: null, hasOrigin };
  };

  /**
   * `git branch -m from to` in the lane's folder, then the lane row. When the
   * row can't be written the git rename is rolled back; when that fails too
   * the row is forced to match git, so the two never disagree.
   */
  const moveLaneBranch = async (lane: LaneBranchRow, from: string, to: string): Promise<BranchMoveOutcome> => {
    // A rename that only changes case (`foo` → `Foo`): on a case-insensitive
    // file system `-m` sees `Foo` as already there and refuses. `-M` only then.
    const moveFlag = from !== to && from.toLowerCase() === to.toLowerCase() ? "-M" : "-m";
    const renamed = await runGit(["branch", moveFlag, from, to], {
      cwd: lane.worktree_path,
      timeoutMs: 15_000,
    });
    if (renamed.exitCode !== 0) {
      logger.warn("lane.branch_rename_failed", {
        laneId: lane.id,
        from,
        to,
        error: renamed.stderr.trim(),
      });
      return "git_rename_failed";
    }
    // `branch -m` carries the placeholder's marker along; the new name is the lane's own.
    await setTemporaryBranchMarker(lane.worktree_path, to, false);
    try {
      deps.updateBranchRef(lane.id, to);
      return "renamed";
    } catch (error) {
      const rollback = await runGit(["branch", moveFlag, to, from], {
        cwd: lane.worktree_path,
        timeoutMs: 15_000,
      });
      logger.error("lane.branch_rename_persist_failed", {
        laneId: lane.id,
        from,
        to,
        rollbackSucceeded: rollback.exitCode === 0,
        // The Error itself, so `logBridge` lifts it into the Sentry event and
        // the issue groups by the real failure; `errorText` keeps the
        // sentence on disk, which `JSON.stringify` writes an Error without.
        error,
        errorText: error instanceof Error ? error.message : String(error),
      });
      if (rollback.exitCode !== 0) {
        db.run("update lanes set branch_ref = ? where id = ? and project_id = ?", [to, lane.id, projectId]);
        deps.invalidateLaneListCache();
        const reconciledLane = getLaneRow(lane.id);
        if (reconciledLane) {
          deps.broadcastLifecycleEvent({
            type: "lane-branch-updated",
            laneId: lane.id,
            laneName: reconciledLane.name,
            color: reconciledLane.color,
          });
        }
        return "persist_reconciled_after_rollback_failure";
      }
      return "persistence_failed_git_rolled_back";
    }
  };

  const applyAutoLaneIdentityNow = async (args: {
    laneId: string;
    expectedLaneName: string;
    temporaryBranch: string;
    laneTitle: string;
    branchFragment: string;
  }): Promise<AutoLaneIdentityResult> => {
    const lane = getLaneRow(args.laneId);
    if (!lane || lane.lane_type !== "worktree") {
      return {
        laneRenameOutcome: "skipped",
        branchRenameOutcome: "skipped",
        branchRef: lane?.branch_ref ?? args.temporaryBranch,
        reason: "lane_missing_or_not_worktree",
      };
    }

    let laneRenameOutcome: AutoLaneIdentityResult["laneRenameOutcome"] = "kept";
    if (lane.name === args.expectedLaneName) {
      try {
        deps.renameLane({ laneId: args.laneId, name: args.laneTitle });
        laneRenameOutcome = lane.name === args.laneTitle ? "kept" : "renamed";
      } catch (error) {
        laneRenameOutcome = "failed";
        logger.warn("lane.auto_identity_lane_rename_failed", {
          laneId: args.laneId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (lane.name !== args.laneTitle) {
      laneRenameOutcome = "skipped";
    }

    const skipBranch = (reason: string, branchRef = lane.branch_ref) => ({
      laneRenameOutcome,
      branchRenameOutcome: "skipped" as const,
      branchRef,
      reason,
    });
    const temporaryBranch = branchNameFromLaneRef(args.temporaryBranch);
    if (!(await isTemporaryLaneBranch(temporaryBranch, lane.worktree_path))) return skipBranch("invalid_temporary_branch");
    if (normalizeBranchKey(lane.branch_ref) !== temporaryBranch) return skipBranch("persisted_branch_changed");

    const { blocked, hasOrigin } = await branchRenameBlocker(lane, temporaryBranch);
    if (blocked) return skipBranch(blocked.reason);

    const autoIdentityBranchOccupied = (ref: string): boolean => {
      const normalized = normalizeBranchKey(ref);
      if (!normalized) return true;
      if (findActiveBranchOwner(normalized, args.laneId)) return true;
      const headVariants = [normalized, `refs/heads/${normalized}`, `origin/${normalized}`];
      const historical = db.get<{ id: string }>(
        `
          select id from pull_requests
          where project_id = ?
            and (
              head_branch = ?
              or head_branch = ?
              or head_branch = ?
            )
          limit 1
        `,
        [projectId, ...headVariants],
      );
      if (historical) return true;
      const projected = db.get<{ github_pr_number: number }>(
        `
          select github_pr_number from github_pr_projections
          where project_id = ?
            and (
              head_branch = ?
              or head_branch = ?
              or head_branch = ?
            )
          limit 1
        `,
        [projectId, ...headVariants],
      );
      return Boolean(projected);
    };

    // Only keep the AI fragment when this lane actually took the AI title.
    // A duplicate-name failure (or a user rename mid-flight) must not still
    // claim `ade/chat-mention-tags-2` for a lane that stayed on its fallback
    // title. Occupied fragments also lose to the applied title's slug rather
    // than suffixing a name that belongs to another live lane or merged PR.
    const adoptedAiTitle = laneRenameOutcome === "renamed"
      || (laneRenameOutcome === "kept" && args.laneTitle === lane.name);
    const identityTitle = laneRenameOutcome === "skipped"
      ? lane.name
      : laneRenameOutcome === "failed"
        ? args.expectedLaneName
        : args.laneTitle;
    // The user's pattern, never ADE's own default: a placeholder that kept
    // `ade/` after naming is what users complained about.
    const branchPrefix = await currentBranchPrefix();
    const branchFragment = resolveAppliedAutoLaneBranchFragment({
      adoptedAiTitle,
      aiBranchFragment: args.branchFragment,
      identityTitle,
      occupied: autoIdentityBranchOccupied,
      prefix: branchPrefix,
    });
    const baseRef = sanitizeBranchName(`${branchPrefix}${branchFragment}`);
    const validRef = await runGit(["check-ref-format", "--branch", baseRef], {
      cwd: lane.worktree_path,
      timeoutMs: 8_000,
    });
    if (validRef.exitCode !== 0) return skipBranch("invalid_target_branch");

    let targetRef: string | null = null;
    const existingBranches = (await listBranchNames()).filter((name) => name !== temporaryBranch);
    for (let suffix = 1; suffix < 1_000; suffix += 1) {
      const candidate = suffix === 1 ? baseRef : `${baseRef}-${suffix}`;
      if (branchNameClash(candidate, existingBranches) || autoIdentityBranchOccupied(candidate)) continue;
      const remote = hasOrigin
        ? await runGitWithGithubAuthFallback(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${candidate}`], {
          cwd: projectRoot,
          timeoutMs: 12_000,
        })
        : { exitCode: 2, stdout: "", stderr: "" };
      if (remote.exitCode !== 0 && remote.exitCode !== 2) {
        return skipBranch("remote_state_unavailable");
      }
      if (remote.exitCode === 2) {
        targetRef = candidate;
        break;
      }
    }
    if (!targetRef) return skipBranch("branch_collision_limit_reached");

    const latestLane = getLaneRow(args.laneId);
    if (normalizeBranchKey(latestLane?.branch_ref ?? "") !== temporaryBranch) {
      return skipBranch("persisted_branch_changed");
    }
    const latestBranch = await runGit(["branch", "--show-current"], {
      cwd: lane.worktree_path,
      timeoutMs: 8_000,
    });
    if (latestBranch.exitCode !== 0 || branchNameFromLaneRef(latestBranch.stdout.trim()) !== temporaryBranch) {
      return skipBranch("checked_out_branch_changed");
    }

    const moved = await moveLaneBranch(lane, temporaryBranch, targetRef);
    if (moved === "git_rename_failed" || moved === "persistence_failed_git_rolled_back") {
      return {
        laneRenameOutcome,
        branchRenameOutcome: "failed",
        branchRef: temporaryBranch,
        reason: moved,
      };
    }
    if (moved === "persist_reconciled_after_rollback_failure") {
      return {
        laneRenameOutcome,
        branchRenameOutcome: "renamed",
        branchRef: targetRef,
        reason: moved,
      };
    }
    return {
      laneRenameOutcome,
      branchRenameOutcome: "renamed",
      branchRef: targetRef,
    };
  };

  const getNewLaneDefaults = (): NewLaneDefaultsSnapshot => {
    const primary = deps.getAllLaneRows().find((row) => row.lane_type === "primary") ?? null;
    const defaults = getNewLaneDefaultsForCreate();
    const user = cachedGitUserName();
    return {
      defaults,
      scope: deps.getNewLaneSettings()?.scope() ?? { kind: "this-computer", repo: null },
      defaultBranch: plainLaneStartBranch(deps.defaultBaseRef),
      primaryBranch: primary?.branch_ref ? plainLaneStartBranch(primary.branch_ref) : null,
      branchPrefix: renderLaneBranchPrefix(defaults.branchPattern, user),
      branchUser: laneBranchSlug(user) || null,
    };
  };

  return {
    readGitUserName,
    listBranchNames,
    isTemporaryLaneBranch,
    setTemporaryBranchMarker,
    resolveCreateBranchRef,

    async applyAutoLaneIdentity(args: {
      laneId: string;
      expectedLaneName: string;
      temporaryBranch: string;
      laneTitle: string;
      branchFragment: string;
    }): Promise<AutoLaneIdentityResult> {
      if (autoLaneIdentityInFlight.has(args.laneId)) {
        const current = getLaneRow(args.laneId);
        return {
          laneRenameOutcome: "skipped",
          branchRenameOutcome: "skipped",
          branchRef: current?.branch_ref ?? args.temporaryBranch,
          reason: "identity_mutation_in_flight",
        };
      }
      autoLaneIdentityInFlight.add(args.laneId);
      try {
        return await applyAutoLaneIdentityNow(args);
      } finally {
        autoLaneIdentityInFlight.delete(args.laneId);
      }
    },

    /**
     * Rename a lane's branch: only while the branch is the lane's alone (never
     * pushed, tracking nothing, no PR). `dryRun` answers whether it may be
     * renamed without renaming it, for the lane menu.
     */
    async renameBranch(args: RenameLaneBranchArgs): Promise<RenameLaneBranchResult> {
      assertLaneIdArg(args?.laneId, "renameBranch");
      const lane = getLaneRow(args.laneId);
      if (!lane) throw new Error(`Lane not found: ${args.laneId}`);
      const current = normalizeBranchKey(lane.branch_ref);
      const blockedResult = (blocked: string): RenameLaneBranchResult => ({ branchRef: current, renamed: false, blocked });
      if (lane.lane_type === "primary") return blockedResult("The primary lane is your main checkout. Rename its branch with git.");
      if (lane.lane_type !== "worktree" || !lane.worktree_path) return blockedResult("Only a lane with its own folder can rename its branch.");
      if (autoLaneIdentityInFlight.has(args.laneId)) return blockedResult("ADE is naming this lane right now. Try again in a moment.");
      const { blocked } = await branchRenameBlocker(lane, current);
      if (blocked) return blockedResult(blocked.message);
      if (args.dryRun) return { branchRef: current, renamed: false, blocked: null };

      const raw = typeof args.branchName === "string" ? args.branchName : "";
      if (sanitizeBranchName(raw.trim()) === current) return { branchRef: current, renamed: false, blocked: null };
      // The lane's own branch is not in the way of a rename that only changes its case.
      const check = await checkTypedBranch(raw, { exclude: current });
      if (check.problem) throw new AdeExpectedError(check.problem, "user");
      const target = check.branchName;
      if (findActiveBranchOwner(target, args.laneId)) {
        throw new AdeExpectedError(branchNameClashMessage(target, target), "user");
      }

      // One branch mutation per lane at a time, shared with the auto-create rename.
      if (autoLaneIdentityInFlight.has(args.laneId)) return blockedResult("ADE is naming this lane right now. Try again in a moment.");
      autoLaneIdentityInFlight.add(args.laneId);
      try {
        const moved = await moveLaneBranch(lane, current, target);
        if (moved === "git_rename_failed") throw new Error(`git couldn't rename ${current} to ${target}.`);
        if (moved === "persistence_failed_git_rolled_back") throw new Error(`ADE couldn't save the new branch name, so ${current} was kept.`);
        return { branchRef: target, renamed: true, blocked: null };
      } finally {
        autoLaneIdentityInFlight.delete(args.laneId);
      }
    },

    getNewLaneDefaults,

    /** Merges the given fields into the saved defaults; fields left out keep their value. */
    async setNewLaneDefaults(args: { defaults: Partial<NewLaneDefaults> }): Promise<NewLaneDefaultsSnapshot> {
      const newLaneSettings = deps.getNewLaneSettings();
      if (!newLaneSettings) throw new Error("New-lane settings aren't available on this computer.");
      const patch = args.defaults ?? {};
      const next: NewLaneDefaults = { ...getNewLaneDefaultsForCreate() };
      if (patch.start !== undefined) {
        const start = normalizeLaneStart(patch.start);
        if (!start) throw new Error("Invalid lane start.");
        // Any branch can be the default now. Copying uncommitted changes is a
        // per-lane pick, so a saved `uncommitted` (an older client) is `local`.
        next.start = savedDefaultLaneStart(start);
      }
      if (patch.templateId !== undefined) {
        const templateId = typeof patch.templateId === "string" ? patch.templateId.trim() : "";
        if (templateId) deps.getValidateNewLaneTemplateId()?.(templateId);
        next.templateId = templateId || null;
      }
      if (patch.branchPattern !== undefined) {
        const pattern = typeof patch.branchPattern === "string" ? patch.branchPattern.trim() : "";
        const problem = laneBranchPatternProblem(pattern);
        if (problem) throw new AdeExpectedError(problem, "user");
        // `arul/` while a branch `arul` exists: git can't make `arul/<slug>`
        // ("cannot lock ref"), so every new lane would fail. Checked on this
        // machine with its own `{user}`. Branches already under the folder are
        // what the prefix makes, so they are not in the way.
        const prefix = renderLaneBranchPrefix(pattern, await readGitUserName());
        const folder = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
        if (folder) {
          const folderKey = `${folder.toLowerCase()}/`;
          const outside = (await listBranchNames()).filter((name) => !name.toLowerCase().startsWith(folderKey));
          const clash = branchNameClash(folder, outside);
          if (clash) {
            throw new AdeExpectedError(
              `A branch named "${clash}" already exists, so git can't make branches under "${prefix}". Rename that branch or choose another prefix.`,
              "user",
            );
          }
        }
        next.branchPattern = pattern;
      }
      newLaneSettings.setDefaults(next);
      return getNewLaneDefaults();
    },

    /**
     * Whether a new lane's branch can have this name on this machine: valid,
     * and not taken locally or on the remote (case-insensitively, as Windows
     * and macOS store refs).
     */
    async checkBranchName(args: { name: string }): Promise<LaneBranchNameCheck> {
      return checkTypedBranch(typeof args?.name === "string" ? args.name : "");
    },
  };
}
