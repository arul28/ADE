/**
 * What an ADE Cloud computer's brain tells ADE Cloud about itself at its idle
 * step (`ade serve`, wired in `runServe`): its lanes' work for the dashboard
 * (unpushed work, the pull request's state), its disk use, the files git
 * ignores that a delete would lose (the idle cleanup's warning lists them),
 * an update when it is idle and behind its channel, that it booted, and hours
 * near full CPU with no chat turn running.
 */

import type { CloudBrainAccess } from "../../../../desktop/src/main/services/adeCloud/cloudBrainAccess";
import type { CloudDiskUsageReport, CloudIgnoredFiles, CloudSustainedCpuReport } from "../../../../desktop/src/shared/adeCloud";
import { readCloudIgnoredFiles } from "./cloudIgnoredFiles";
import type { ProjectScopeRegistry } from "../projects/projectScope";
import type { ProjectRegistry } from "../projects/projectRegistry";

/**
 * After a failed update check or start, the idle step waits this long before
 * it asks again: the same wait the server's own automatic retry keeps
 * (`AUTO_RETRY_AFTER_MS` in the account directory).
 */
const UPDATE_RETRY_AFTER_MS = 60 * 60_000;

export function createCloudComputerReports(deps: {
  /** This computer's ADE Cloud id (`ADE_CLOUD_INSTANCE_ID`), read once; empty when unknown. */
  instanceId: string;
  projectRegistry: Pick<ProjectRegistry, "list">;
  /** Read at call time: the registry is made after these reports are. */
  scopeRegistry: () => Pick<ProjectScopeRegistry, "getIfBooted">;
  getCloudBrainAccess: () => Promise<CloudBrainAccess>;
  version: string;
  logger?: { warn(event: string, data?: unknown): void };
}) {
  const { instanceId, projectRegistry, getCloudBrainAccess } = deps;
  let updateRetryAt = 0;
  // Only projects already open: the idle step never boots one to look.
  const bootedRuntimes = async () => {
    const scopeRegistry = deps.scopeRegistry();
    return (await Promise.all(projectRegistry.list().map(async (record) =>
      (await scopeRegistry.getIfBooted(record.projectId)?.catch(() => null))?.runtime ?? null)))
      .filter((runtime): runtime is NonNullable<typeof runtime> => Boolean(runtime));
  };
  return {
    readWork: async () => {
      const runtimes = await bootedRuntimes();
      if (!runtimes.length) return null;
      let unpushed = false;
      let prState: "draft" | "open" | "merged" | "closed" | null = null;
      for (const runtime of runtimes) {
        for (const lane of await runtime.laneService.list({ includeArchived: true, includeStatus: true })) {
          if (lane.status?.dirty === true || (lane.status?.ahead ?? 0) > 0) unpushed = true;
          if (lane.laneType !== "primary") prState ??= runtime.prService?.getForLane(lane.id)?.state ?? null;
        }
      }
      return { checkedAt: Date.now(), unpushed, prState };
    },
    /** Every open lane's files git ignores, summed up; null when no lane could be read. */
    readIgnored: async (): Promise<CloudIgnoredFiles | null> => {
      const lanes = [];
      for (const runtime of await bootedRuntimes()) {
        for (const lane of await runtime.laneService.list({ includeArchived: false, includeStatus: false })) {
          if (lane.worktreePath) lanes.push({ laneName: lane.name, worktreePath: lane.worktreePath });
        }
      }
      return lanes.length ? await readCloudIgnoredFiles(lanes, { logger: deps.logger }) : null;
    },
    send: async (report: CloudDiskUsageReport) => {
      const client = await (await getCloudBrainAccess()).client();
      if (!client?.reportDiskUsage) throw new Error("no ADE Cloud access");
      await client.reportDiskUsage(instanceId, report);
    },
    // Idle and behind its channel's checked image: update now (it restarts), not sleep.
    updateIfBehind: async (stillIdle: () => boolean) => {
      if (Date.now() < updateRetryAt) return false;
      const client = instanceId ? await (await getCloudBrainAccess()).client() : null;
      if (!client) return false;
      try {
        const check = await client.checkForUpdate(instanceId);
        // An update restarts the computer, and work may have started during that read.
        if (!check.behind || !stillIdle()) return false;
        await client.updateInstance(instanceId, { reason: "idle", computerIdle: true });
        return true;
      } catch (error) {
        updateRetryAt = Date.now() + UPDATE_RETRY_AFTER_MS;
        throw error;
      }
    },
    // Hours near full CPU with no chat turn or agent working (`cloudSustainedCpu.ts`): a line in the owner's daily report.
    reportSustainedCpu: async (report: CloudSustainedCpuReport) => {
      if (!instanceId) return;
      const client = await (await getCloudBrainAccess()).client();
      if (!client?.reportSustainedCpu) throw new Error("no ADE Cloud access");
      await client.reportSustainedCpu(instanceId, report);
    },
    reportBooted: async () => {
      if (!instanceId) return { sleepWhenIdle: false };
      const client = await (await getCloudBrainAccess()).client();
      if (!client) throw new Error("no ADE Cloud access");
      return await client.reportBooted(instanceId, deps.version);
    },
  };
}
