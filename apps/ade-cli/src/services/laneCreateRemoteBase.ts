import { resolveDefaultRemoteLaneBase } from "../../../desktop/src/shared/defaultRemoteLaneBase";
import type { NewLaneBaseSource } from "../../../desktop/src/shared/types";
import type { createProjectConfigService } from "../../../desktop/src/main/services/config/projectConfigService";
import type { createGitOperationsService } from "../../../desktop/src/main/services/git/gitOperationsService";
import type { createLaneService } from "../../../desktop/src/main/services/lanes/laneService";

export interface LaneCreateRemoteBaseDeps {
  laneService: Pick<ReturnType<typeof createLaneService>, "list">;
  gitService?: Pick<ReturnType<typeof createGitOperationsService>, "fetch" | "listBranches"> | null;
  projectConfigService?: Pick<ReturnType<typeof createProjectConfigService>, "getEffective"> | null;
}

/**
 * Remote-first default base for lane creation when the caller omits a base.
 * Reads the project's `git.newLaneBaseSource` (effective default "remote"),
 * fetches the primary lane's remote (bounded), and maps the primary base branch
 * to its remote-tracking ref. Returns null — keep the local default — when the
 * source is "local", services are unavailable, or no remote ref exists.
 *
 * Shared by every base-less lane-create entry point that a headless host
 * serves: the sync layer's `lanes.create` (mobile) and the ADE RPC server's
 * `create_lane` tool (`ade lanes create`, agent tool calls).
 */
export async function resolveLaneCreateRemoteBase(deps: LaneCreateRemoteBaseDeps): Promise<string | null> {
  const gitService = deps.gitService;
  if (!gitService) return null;
  let source: NewLaneBaseSource | null = null;
  try {
    source = deps.projectConfigService?.getEffective().git?.newLaneBaseSource ?? null;
  } catch {
    source = null;
  }
  // "local" short-circuits before the lane/branch lookups; the callee re-checks
  // as its own contract.
  if (source === "local") return null;
  try {
    const lanes = await deps.laneService.list({ includeStatus: false });
    const primary = lanes.find((lane) => lane.laneType === "primary");
    if (!primary) return null;
    return await resolveDefaultRemoteLaneBase({
      newLaneBaseSource: source,
      primaryBaseRef: primary.baseRef || primary.branchRef,
      fetchRemote: () => gitService.fetch({ laneId: primary.id }),
      listBranches: () => gitService.listBranches({ laneId: primary.id }),
    });
  } catch {
    return null;
  }
}
