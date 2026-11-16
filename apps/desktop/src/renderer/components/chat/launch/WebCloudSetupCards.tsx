import { useEffect, useMemo } from "react";
import { launchInProgress, launchesForOrigin, useAccountCloudLaunches } from "../../../state/accountCloudLaunches";
import { refreshCloudMachines } from "../../remoteTargets/useCloudMachines";
import { CloudSetupCard } from "../../projects/CloudSetupCard";
import { cn } from "../../ui/cn";

/**
 * ADE Web's chats on new ADE Cloud computers for this project, above the Work
 * composer: the same setup card as the project page (computer, clone,
 * sign-in, message), from the account server's launches. The web starts them
 * through the account server (`POST /cloud/launches`), not through a lane
 * launch in a brain, so the desktop's lane setup card does not apply.
 *
 * Shown: launches in progress, failed ones (for Retry), and the ones this tab
 * started. Its own component, so the launch poll re-renders only the cards.
 */
export function WebCloudSetupCards({ originUrl, className }: { originUrl: string | null; className?: string }) {
  const { entries } = useAccountCloudLaunches();
  const shown = useMemo(
    () => launchesForOrigin(entries, originUrl).filter((entry) => (
      entry.record?.state !== "cancelled"
      && (launchInProgress(entry) || entry.startError != null || entry.record?.state === "failed" || entry.startedHere)
    )),
    [entries, originUrl],
  );
  // A chat that got its lane: read the account's computers again, so the new
  // lane shows in the Run on lane list and the Work list.
  const ready = shown.filter((entry) => entry.record?.laneId && entry.record.sessionId).length;
  useEffect(() => {
    if (ready > 0) refreshCloudMachines();
  }, [ready]);
  if (shown.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-2 text-left", className)} data-testid="web-cloud-setup-cards">
      {shown.map((entry) => <CloudSetupCard key={entry.launchId} entry={entry} />)}
    </div>
  );
}
