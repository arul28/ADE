export type HistorySurface = "activity" | "commits";

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
