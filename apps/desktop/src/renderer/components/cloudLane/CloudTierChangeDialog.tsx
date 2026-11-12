import { useMemo } from "react";
import { cloudCatalogOf } from "../../../shared/adeCloud";
import type { CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { cloudTierOfMachine, cloudTiers, type CloudTierId } from "../../../shared/cloudTiers";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import { Dialog } from "../ui/dialog";
import { CloudTierChangeCard } from "./CloudTierChangeCard";

/**
 * A person's tier change for one cloud lane, from the dashboard or the chat's
 * ADE Cloud chip: the tier-change card with the four sizes. Once it starts,
 * the dialog closes and the change shows where it doesn't hold the app: the
 * corner panel (`CloudLaneJobsSlideOut`), the lane's row on the dashboard and
 * the card in its chat. Reads the account's computers from the one shared
 * read while open (no read of its own, no wake).
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
    () => (machine ? cloudTierOfMachine(machine, cloudTiers(cloudCatalogOf(account)))?.id ?? null : null),
    [account, machine],
  );
  const computer = useMemo(
    () => (machine ? { diskGb: machine.resources?.diskGb ?? null, usedGb: machine.diskUsage?.totalGb ?? null } : null),
    [machine],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={`Change the size of ${laneName}`}
      size="md"
      actions={[]}
    >
      <CloudTierChangeCard
        facts={{ laneName, instanceId, fromSizeId, toSizeId: null, reason: null }}
        account={account}
        computer={computer}
        pickable
        headless
        onStarted={onClose}
        onNotNow={onClose}
      />
    </Dialog>
  );
}
