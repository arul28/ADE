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
 * didn't go through. `pushed`: on GitHub now. `clean`: nothing to push.
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

export type CloudPushWorkResult = { pushed: number; failed: number; skipped: number; lanes: CloudPushWorkLane[] };

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
  const tally: CloudPushWorkResult = { pushed: 0, failed: 0, skipped: 0, lanes: [] };
  for (const load of args.projects) {
    try {
      const runtime = await load();
      // The list keeps lane statuses for 10 s. "Everything is pushed" has to be true now.
      runtime.laneService.invalidateListCache();
      for (const lane of await runtime.laneService.list({ includeArchived: true, includeStatus: true })) {
        const primary = lane.laneType === "primary";
        const dirty = lane.status?.dirty === true;
        const ahead = lane.status?.ahead ?? 0;
        const entry: CloudPushWorkLane = { laneId: lane.id, laneName: lane.name, branchRef: lane.branchRef, primary, dirty, ahead, state: "clean" };
        tally.lanes.push(entry);
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
