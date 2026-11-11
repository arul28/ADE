/**
 * "Push all work to GitHub" on a cloud computer (`ade cloud push-work`): commits
 * every project's lanes as they stand and pushes them. The primary lane is only
 * counted, since its branch is usually the default one.
 */

import type { AdeRuntime } from "../../bootstrap";

const COMMIT_MESSAGE = "Work saved from ADE Cloud";

/**
 * One lane as push-work left it. `unpushed`: work only on the computer (a
 * check, or a primary lane, which is never pushed). `failed`: a push that
 * didn't go through, or a lane whose state couldn't be read. `pushed`: on
 * GitHub now. `clean`: read now, nothing GitHub doesn't have. `ahead` counts
 * commits no remote has (not commits past the lane's base).
 */
export type CloudPushWorkLane = {
  laneId: string;
  laneName: string;
  branchRef: string;
  primary: boolean;
  dirty: boolean;
  ahead: number;
  state: "clean" | "pushed" | "failed" | "unpushed";
};

/**
 * `readsRemotes: true` marks a tally from this read (`ade cloud push-work` and
 * `work-state` both): each lane's `ahead` counts commits no remote has, and a
 * lane it couldn't read is `failed`. An older ADE left it out; its `clean`
 * primary lane may still hold unpushed commits, so the server trusts only this.
 */
export type CloudPushWorkResult = { readsRemotes: true; pushed: number; failed: number; skipped: number; lanes: CloudPushWorkLane[] };

type Logger = { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };

async function pushLane(runtime: Pick<AdeRuntime, "gitService">, laneId: string, dirty: boolean): Promise<void> {
  if (dirty) {
    await runtime.gitService.stageAll({ laneId, paths: [] });
    await runtime.gitService.commit({ laneId, message: COMMIT_MESSAGE });
  }
  await runtime.gitService.push({ laneId });
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
  logger?: Logger;
}): Promise<CloudPushWorkResult> {
  const tally: CloudPushWorkResult = { readsRemotes: true, pushed: 0, failed: 0, skipped: 0, lanes: [] };
  for (const load of args.projects) {
    try {
      const runtime = await load();
      runtime.laneService.invalidateListCache();
      // "Everything is on GitHub" has to be true now, so each lane is read
      // uncached, against the remotes (the list's `ahead` counts past the base,
      // which is 0 for the primary lane), and a read that fails is not "clean".
      for (const lane of await runtime.laneService.list({ includeArchived: true, includeStatus: false })) {
        const primary = lane.laneType === "primary";
        const entry: CloudPushWorkLane = { laneId: lane.id, laneName: lane.name, branchRef: lane.branchRef, primary, dirty: false, ahead: 0, state: "clean" };
        tally.lanes.push(entry);
        let unsaved: { dirty: boolean; unpushedCommits: number };
        try {
          unsaved = await runtime.laneService.readUnsavedWork(lane.id);
        } catch (error) {
          entry.state = "failed";
          tally.failed += 1;
          args.logger?.warn("cloud.push_work_lane_unreadable", { laneId: lane.id, error: error instanceof Error ? error.message : String(error) });
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
        try {
          await pushLane(runtime, lane.id, dirty);
          entry.state = "pushed";
          tally.pushed += 1;
        } catch (error) {
          entry.state = "failed";
          tally.failed += 1;
          args.logger?.warn("cloud.push_work_lane_failed", { laneId: lane.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      // A project that couldn't be read wasn't saved; the tally must not say it was.
      tally.failed += 1;
      args.logger?.warn("cloud.push_work_project_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  args.logger?.info("cloud.push_work", { pushed: tally.pushed, failed: tally.failed, skipped: tally.skipped, check: args.check === true });
  return tally;
}
