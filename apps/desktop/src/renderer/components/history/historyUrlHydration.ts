export type HistorySurface = "activity" | "commits";

/** History's commit graph on a lane; `machineId` names a lane on another machine. */
export function historyCommitsPath(laneId: string, machineId?: string | null): string {
  const params = new URLSearchParams({ surface: "commits", laneId });
  if (machineId) params.set("machineId", machineId);
  return `/history?${params.toString()}`;
}

export function shouldHydrateCommitShaFromUrl(args: {
  commitSha: string | null;
  requestedSurface: HistorySurface | null;
  selectedCommitSha: string | null;
  focusLaneChanged: boolean;
}): boolean {
  const commitSha = args.commitSha?.trim() ?? "";
  if (!commitSha || args.requestedSurface === "activity") return false;
  return args.focusLaneChanged || commitSha !== args.selectedCommitSha;
}
