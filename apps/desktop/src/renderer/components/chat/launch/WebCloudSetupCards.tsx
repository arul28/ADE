import { useMemo } from "react";
import { hideAccountCloudLaunch, launchInProgress, launchesForOrigin, useAccountCloudLaunches } from "../../../state/accountCloudLaunches";
import { CloudSetupCard } from "../../projects/CloudSetupCard";
import { cn } from "../../ui/cn";
import { navigateToAppTarget } from "../../../lib/openExternal";
import type { CloudLaunchRecord } from "../../../../shared/accountCloudLaunches";

/** The chat on its lane's computer: Work opens it on the machine that holds it, as a link to it does. */
function openLaunchChat(record: CloudLaunchRecord): void {
  if (!record.sessionId) return;
  navigateToAppTarget({ kind: "chat", sessionId: record.sessionId, laneId: record.laneId ?? null });
}

/**
 * ADE Web's chats on new ADE Cloud computers for this project, above the Work
 * composer: the same setup card as the project page (computer, clone,
 * sign-in, message), from the account server's launches. The web starts them
 * through the account server (`POST /cloud/launches`), not through a lane
 * launch in a brain, so the desktop's lane setup card does not apply.
 *
 * Shown: launches in progress, failed ones (for Retry), and the ones this tab
 * started, until the person hides a finished one (its chat is in the Work
 * list). Its own component, so the launch poll re-renders only the cards.
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
  if (shown.length === 0) return null;
  return (
    // Above the composer, inside its dock: several cards scroll on their own so none is cut off.
    <div className={cn("flex max-h-[30vh] flex-col gap-2 overflow-y-auto text-left [&>*]:shrink-0", className)} data-testid="web-cloud-setup-cards">
      {shown.map((entry) => (
        <CloudSetupCard key={entry.launchId} entry={entry} onOpenChat={openLaunchChat} onHide={() => hideAccountCloudLaunch(entry.launchId)} />
      ))}
    </div>
  );
}
