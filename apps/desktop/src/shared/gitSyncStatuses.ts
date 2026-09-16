import type { GitSyncStatuses, GitSyncStatusesArgs, GitUpstreamSyncStatus } from "./types";

export function normalizeSyncStatusLaneIds(
  args: GitSyncStatusesArgs | { laneIds?: unknown } | null | undefined,
): string[] {
  return Array.from(
    new Set(
      (Array.isArray(args?.laneIds) ? args.laneIds : [])
        .map((laneId) => typeof laneId === "string" ? laneId.trim() : "")
        .filter(Boolean),
    ),
  );
}

export async function settleLaneSyncStatuses(
  laneIds: string[],
  getOne: (laneId: string) => Promise<GitUpstreamSyncStatus | null>,
): Promise<GitSyncStatuses> {
  const entries = await Promise.all(
    laneIds.map(async (laneId) => {
      try {
        return [laneId, await getOne(laneId)] as const;
      } catch {
        return [laneId, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
