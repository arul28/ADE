/**
 * "Push all work to GitHub" on a cloud computer (`ade cloud push-work`): commits
 * every project's lanes as they stand and pushes them. The primary lane is only
 * counted, since its branch is usually the default one.
 */

import type { AdeRuntime } from "../../bootstrap";

const COMMIT_MESSAGE = "Work saved from ADE Cloud";

export type CloudPushWorkResult = { pushed: number; failed: number; skipped: number };

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
  logger?: Logger;
}): Promise<CloudPushWorkResult> {
  const tally: CloudPushWorkResult = { pushed: 0, failed: 0, skipped: 0 };
  for (const load of args.projects) {
    try {
      const runtime = await load();
      for (const lane of await runtime.laneService.list({ includeArchived: false, includeStatus: true })) {
        if (!lane.status.dirty && lane.status.ahead === 0) continue;
        if (lane.laneType === "primary") {
          tally.skipped += 1;
          continue;
        }
        try {
          await pushLane(runtime, lane.id, lane.status.dirty);
          tally.pushed += 1;
        } catch (error) {
          tally.failed += 1;
          args.logger?.warn("cloud.push_work_lane_failed", { laneId: lane.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      args.logger?.warn("cloud.push_work_project_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  args.logger?.info("cloud.push_work", tally);
  return tally;
}
