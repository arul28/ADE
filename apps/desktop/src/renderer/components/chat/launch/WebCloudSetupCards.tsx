import { useEffect, useMemo, useRef, useState } from "react";
import { hideAccountCloudLaunch, launchInProgress, launchesForOrigin, useAccountCloudLaunches } from "../../../state/accountCloudLaunches";
import { useAdeCloudLaneComputers } from "../../../state/adeCloudLaneIndex";
import { CloudSetupCardList } from "../../projects/CloudSetupCard";
import { refreshCloudMachines } from "../../remoteTargets/useCloudMachines";
import { cn } from "../../ui/cn";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { extractError } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { useOptionalWebWorkspace, useWebMachines } from "../../../webclient/workspace/WebWorkspaceContext";
import type { CloudLaunchRecord } from "../../../../shared/accountCloudLaunches";

/** How many 5 s reads "Open chat" waits for a new computer to be listed before it gives up. */
const OPEN_CHAT_READS = 12;

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
  const workspace = useOptionalWebWorkspace();
  const webMachines = useWebMachines();
  const cloudIndex = useAdeCloudLaneComputers();
  // "Open chat" on a launch whose computer this tab has not connected: connect it first, then open the chat.
  const [opening, setOpening] = useState<CloudLaunchRecord | null>(null);
  const machineOf = (record: CloudLaunchRecord) => {
    const machineKey = cloudIndex.computers.find((computer) => computer.instanceId === record.instanceId)?.machineKey?.toLowerCase();
    return machineKey ? webMachines.find((machine) => machine.accountMachine?.machineKey?.toLowerCase() === machineKey) ?? null : null;
  };
  const openingMachine = opening ? machineOf(opening) : null;
  const openingListed = openingMachine != null;
  const startedRef = useRef<string | null>(null);
  // The open the person chose last; an older connect that ends later, or one that ends after the cards unmount, opens nothing.
  const currentOpenRef = useRef<string | null>(null);
  useEffect(() => () => {
    currentOpenRef.current = null;
  }, []);
  useEffect(() => {
    if (!opening || !openingMachine || !workspace || startedRef.current === opening.launchId) return;
    startedRef.current = opening.launchId;
    const record = opening;
    void workspace.connectMachineEntry(openingMachine).then(
      () => {
        if (record.sessionId && currentOpenRef.current === record.launchId) navigateToAppTarget({ kind: "chat", sessionId: record.sessionId, laneId: record.laneId ?? null });
      },
      (error: unknown) => showToast({ tone: "error", title: `Couldn't connect to ${openingMachine.name}`, message: extractError(error) }),
    ).finally(() => {
      startedRef.current = null;
      setOpening((current) => (current?.launchId === record.launchId ? null : current));
    });
  }, [opening, openingMachine, workspace]);
  // A computer not listed yet: read the account's computers again every few seconds, then stop.
  useEffect(() => {
    if (!opening || openingListed) return;
    refreshCloudMachines();
    let reads = 0;
    const timer = window.setInterval(() => {
      reads += 1;
      if (reads >= OPEN_CHAT_READS) {
        window.clearInterval(timer);
        setOpening(null);
        showToast({ tone: "error", title: "Couldn't open the chat yet", message: "Its ADE Cloud computer isn't listed yet. Try again in a moment." });
        return;
      }
      refreshCloudMachines();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [opening, openingListed]);
  const openLaunchChat = (record: CloudLaunchRecord) => {
    if (!record.sessionId) return;
    if (!workspace) {
      navigateToAppTarget({ kind: "chat", sessionId: record.sessionId, laneId: record.laneId ?? null });
      return;
    }
    currentOpenRef.current = record.launchId;
    setOpening(record);
  };
  if (shown.length === 0) return null;
  return (
    // Above the composer, inside its dock: several cards scroll on their own so none is cut off.
    // The bottom fades over the padding, so a list that scrolls never reads as running under the composer.
    <div
      className={cn(
        "flex max-h-[40vh] flex-col gap-2 overflow-y-auto pb-4 text-left [&>*]:shrink-0",
        "[mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent)]",
        className,
      )}
      data-testid="web-cloud-setup-cards"
    >
      <CloudSetupCardList
        entries={shown}
        onOpenChat={openLaunchChat}
        openingLaunchId={opening?.launchId ?? null}
        onHide={hideAccountCloudLaunch}
        compact
      />
    </div>
  );
}
