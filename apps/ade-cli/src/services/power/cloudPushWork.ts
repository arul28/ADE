/**
 * "Push all work to GitHub" on a cloud computer (`ade cloud push-work`): commits
 * every project's lanes as they stand and pushes them. The primary lane is only
 * counted, since its branch is usually the default one.
 */

import type { AdeRuntime } from "../../bootstrap";
import { classifyGitPushFailure } from "../../../../desktop/src/main/services/git/gitPushFailure";

const COMMIT_MESSAGE = "Work saved from ADE Cloud";
/**
 * The whole fetch step per project, including the wait for the lane's queue
 * (git's own fetch budget is GIT_FETCH_TIMEOUT_MS): a computer GitHub can't
 * reach is kept quickly.
 */
const FETCH_STEP_TIMEOUT_MS = 60_000;

/**
 * One lane as push-work left it. `unpushed`: work only on the computer (a
 * check, or a primary lane, which is never pushed). `failed`: a push that
 * didn't go through, or a lane whose state couldn't be read. `pushed`: on
 * GitHub now. `clean`: read now, nothing GitHub doesn't have. `ahead` counts
 * commits no remote has (not commits past the lane's base). `reason` says why
 * GitHub stopped a `failed` lane's fetch or push, when it did: the free and the
 * delete name that cause instead of "open the lane".
 */
export type CloudPushWorkLane = {
  laneId: string;
  laneName: string;
  branchRef: string;
  primary: boolean;
  dirty: boolean;
  ahead: number;
  state: "clean" | "pushed" | "failed" | "unpushed";
  reason?: CloudPushWorkFailReason;
};

/**
 * `github_refused`: the repository is gone, or the computer's GitHub access
 * can't see or write it, so trying again won't help. `github_unreachable`: no
 * answer from GitHub in time.
 */
export type CloudPushWorkFailReason = "github_refused" | "github_unreachable";

/**
 * `readsRemotes: true` marks a tally from this read (`ade cloud push-work` and
 * `work-state` both): each lane's `ahead` counts commits no remote has, and a
 * lane it couldn't read is `failed`. An older ADE left it out; its `clean`
 * primary lane may still hold unpushed commits, so the server trusts only this.
 */
export type CloudPushWorkResult = { readsRemotes: true; pushed: number; failed: number; skipped: number; lanes: CloudPushWorkLane[] };

const GITHUB_REFUSED_KINDS: ReadonlySet<string> = new Set(["auth_failed", "permission_denied", "repository_not_found"]);
const GITHUB_UNREACHABLE = /could not resolve host|failed to connect|connection (timed out|refused|reset)|timed out|network is unreachable/i;
/**
 * A host git names in its error: a remote URL (`https://`, `ssh://`, `git@`,
 * past any user part), or ssh's and curl's own words for a host they couldn't find or reach.
 */
const REMOTE_HOST = /(?:https?:\/\/|ssh:\/\/|git@)(?:[^@\s/'"]+@)?([a-z0-9.-]+)|could not resolve host(?:name)?:?\s+([a-z0-9.-]+)|connect to host\s+([a-z0-9.-]+)/gi;
/** `git fetch --all` names each remote it reads, the ones that worked too: "Fetching origin", "From <url>", a ref line. */
const PROGRESS_LINE = /^(?:Fetching \S|From \S|To \S|\s)/;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Why GitHub stopped a fetch or a push, read from git's error; undefined when
 * it wasn't GitHub. `git fetch --all` also reads other remotes: an error that
 * names only other hosts (a GitLab remote's 403) is not GitHub's to fix.
 */
function githubFailReason(error: unknown): CloudPushWorkFailReason | undefined {
  const failure = errorText(error).split("\n").filter((line) => !PROGRESS_LINE.test(line)).join("\n");
  const hosts = Array.from(failure.matchAll(REMOTE_HOST), (match) => (match[1] ?? match[2] ?? match[3])!.toLowerCase());
  if (hosts.length > 0 && !hosts.some((host) => host === "github.com" || host.endsWith(".github.com"))) return undefined;
  const kind = classifyGitPushFailure(failure)?.kind;
  if (kind && GITHUB_REFUSED_KINDS.has(kind)) return "github_refused";
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError" || name === "GitTimeoutError") return "github_unreachable";
  return GITHUB_UNREACHABLE.test(failure) ? "github_unreachable" : undefined;
}

type Logger = { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };

/**
 * Commits a dirty lane, then pushes it; null when both went through. Only the
 * push talks to GitHub, so only its failure carries GitHub's reason: a slow
 * commit hook is the lane's own.
 */
async function pushLane(
  runtime: Pick<AdeRuntime, "gitService">,
  laneId: string,
  dirty: boolean,
  message: string,
): Promise<{ error: unknown; reason?: CloudPushWorkFailReason } | null> {
  if (dirty) {
    try {
      // `git add -A` honours .gitignore: files git ignores are never committed or pushed.
      await runtime.gitService.stageAll({ laneId, paths: [] });
      // A computer with no git identity commits with ADE's (the runtime's `commitIdentityFallback`).
      await runtime.gitService.commit({ laneId, message });
    } catch (error) {
      return { error };
    }
  }
  try {
    await runtime.gitService.push({ laneId });
    return null;
  } catch (error) {
    return { error, reason: githubFailReason(error) };
  }
}

export async function pushCloudComputerWork(args: {
  /** One loader per project, so a project that won't open doesn't stop the rest. */
  projects: ReadonlyArray<() => Promise<Pick<AdeRuntime, "laneService" | "gitService">>>;
  /**
   * Only read which lanes have work that isn't on GitHub; change nothing.
   * Delete lane asks this first so it can warn. Archived lanes count either
   * way: deleting or freeing the computer takes their work too.
   */
  check?: boolean;
  /** The commit message for uncommitted work (the server's idle cleanup sends its own); ADE's default otherwise. */
  message?: string | null;
  /** Sets the computer's git identity when nobody did (`ensureCloudGitIdentity`), before any commit. */
  ensureIdentity?: () => Promise<unknown>;
  logger?: Logger;
}): Promise<CloudPushWorkResult> {
  const message = args.message?.trim() || COMMIT_MESSAGE;
  if (!args.check && args.ensureIdentity) {
    await args.ensureIdentity().catch((error: unknown) => {
      args.logger?.warn("cloud.push_work_identity_failed", { error: errorText(error) });
    });
  }
  const tally: CloudPushWorkResult = { readsRemotes: true, pushed: 0, failed: 0, skipped: 0, lanes: [] };
  for (const load of args.projects) {
    try {
      const runtime = await load();
      runtime.laneService.invalidateListCache();
      // "Everything is on GitHub" has to be true now, so each lane is read
      // uncached, against the remotes (the list's `ahead` counts past the base,
      // which is 0 for the primary lane), and a read that fails is not "clean".
      const lanes = await runtime.laneService.list({ includeArchived: true, includeStatus: false });
      // One fetch of every remote per project before the read (every lane
      // shares its refs), in a push and in a check alike: a branch
      // force-pushed or deleted on GitHub must not leave a stale tracking ref
      // that makes unpushed commits read as saved. A branch merged and
      // deleted on GitHub reads as saved because its changes are in the base
      // (`readUnsavedWork`), so it is not pushed back. A fetch that fails
      // marks every lane of the project `failed`, so the computer is kept and
      // delete says ADE couldn't read the work, or what GitHub said.
      let fetchFailed: { reason?: CloudPushWorkFailReason } | null = null;
      const anchor = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0];
      if (anchor) {
        const deadline = AbortSignal.timeout(FETCH_STEP_TIMEOUT_MS);
        try {
          await runtime.gitService.fetch({ laneId: anchor.id, allRemotes: true, signal: deadline });
        } catch (error) {
          // The step's own deadline stops git with a plain "Git was cancelled.":
          // nothing else runs at a free or a check, so that is a fetch with no answer.
          fetchFailed = { reason: deadline.aborted ? "github_unreachable" : githubFailReason(error) };
          args.logger?.warn("cloud.push_work_fetch_failed", { error: errorText(error) });
        }
      }
      for (const lane of lanes) {
        const primary = lane.laneType === "primary";
        const entry: CloudPushWorkLane = { laneId: lane.id, laneName: lane.name, branchRef: lane.branchRef, primary, dirty: false, ahead: 0, state: "clean" };
        tally.lanes.push(entry);
        if (fetchFailed) {
          entry.state = "failed";
          if (fetchFailed.reason) entry.reason = fetchFailed.reason;
          tally.failed += 1;
          continue;
        }
        let unsaved: { dirty: boolean; unpushedCommits: number };
        try {
          unsaved = await runtime.laneService.readUnsavedWork(lane.id);
        } catch (error) {
          entry.state = "failed";
          tally.failed += 1;
          args.logger?.warn("cloud.push_work_lane_unreadable", { laneId: lane.id, error: errorText(error) });
          continue;
        }
        const { dirty, unpushedCommits: ahead } = unsaved;
        entry.dirty = dirty;
        entry.ahead = ahead;
        if (!dirty && ahead === 0) continue;
        if (primary || args.check) {
          entry.state = "unpushed";
          if (primary) tally.skipped += 1;
          continue;
        }
        const failure = await pushLane(runtime, lane.id, dirty, message);
        if (!failure) {
          entry.state = "pushed";
          tally.pushed += 1;
          continue;
        }
        entry.state = "failed";
        if (failure.reason) entry.reason = failure.reason;
        tally.failed += 1;
        args.logger?.warn("cloud.push_work_lane_failed", { laneId: lane.id, error: errorText(failure.error) });
      }
    } catch (error) {
      // A project that couldn't be read wasn't saved; the tally must not say it was.
      tally.failed += 1;
      args.logger?.warn("cloud.push_work_project_failed", { error: errorText(error) });
    }
  }
  args.logger?.info("cloud.push_work", { pushed: tally.pushed, failed: tally.failed, skipped: tally.skipped, check: args.check === true });
  return tally;
}
