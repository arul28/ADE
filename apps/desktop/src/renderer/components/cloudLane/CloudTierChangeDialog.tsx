import { useMemo, useState } from "react";
import { cloudCatalogOf } from "../../../shared/adeCloud";
import type { CloudLaneJobSnapshot } from "../../../shared/cloudLaneLife";
import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { cloudTiers, type CloudTierId } from "../../../shared/cloudTiers";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import { tierOfMachine } from "../settings/cloudDashboard/cloudDashboardModel";
import { Dialog } from "../ui/dialog";
import { CloudLaneJobCard } from "./CloudLaneJobCard";
import { CloudTierChangeCard } from "./CloudTierChangeCard";
import { useCloudLaneJobs } from "./cloudLaneStores";

/**
 * A person's tier change for one cloud lane, from the dashboard or the chat's
 * ADE Cloud chip: the tier-change card with the four sizes, then the steps
 * once it starts. Reads the account's computers from the one shared read
 * while open (no read of its own, no wake).
 */
export function CloudTierChangeDialog({
  instanceId,
  laneName,
  onClose,
}: {
  instanceId: string;
  laneName: string;
  onClose: () => void;
}) {
  const machines = useCloudMachines(true);
  const result = machines.result?.state === "ok" ? machines.result : null;
  const account = result?.account ?? null;
  const machine = (result?.machines as CloudLaneMachine[] | undefined)?.find((entry) => entry.instanceId === instanceId) ?? null;
  const fromSizeId = useMemo<CloudTierId | null>(
    () => (machine ? tierOfMachine(machine, cloudTiers(cloudCatalogOf(account)))?.id ?? null : null),
    [account, machine],
  );
  const [started, setStarted] = useState<CloudLaneJobSnapshot | null>(null);
  const jobs = useCloudLaneJobs();
  // The job's events move it on; the answer to the start shows until the first one.
  const job = started ? jobs.get(started.jobId) ?? started : null;
  const jobLive = job != null && (job.phase === "waiting" || job.phase === "running");

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={job ? `Changing ${laneName}` : `Change the size of ${laneName}`}
      description={jobLive ? "It goes on if you close this. The steps also show in the lane's chat and on the dashboard." : undefined}
      size="md"
      actions={job ? [{ label: "Close", onClick: onClose, autoFocus: true }] : []}
    >
      {job ? (
        <CloudLaneJobCard job={job} account={account} variant="panel" />
      ) : (
        <CloudTierChangeCard
          facts={{ laneName, instanceId, fromSizeId, toSizeId: null, reason: null }}
          account={account}
          pickable
          headless
          onStarted={setStarted}
          onNotNow={onClose}
        />
      )}
    </Dialog>
  );
}
