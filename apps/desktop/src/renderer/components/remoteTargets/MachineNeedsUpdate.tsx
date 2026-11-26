import { ArrowsClockwise, ArrowSquareOut, WarningCircle } from "@phosphor-icons/react";
import { openExternalUrl } from "../../lib/openExternal";
import {
  canUpdateOtherMachines,
  isMachineUpdateBusy,
  machineUpdateIsManual,
  requestMachineUpdates,
  useConnectedMachines,
  useKnownAdeVersions,
  useMachineUpdates,
} from "./machineUpdates";
import { machineUpdateTargetVersion } from "./remoteMachineModel";
import { describeMachineUpdateAttempt } from "./machineUpdateStatus";
import { useCloudSelfUpdates } from "./useCloudSelfUpdates";

/**
 * What a surface shows in place of a call another computer could not answer
 * because its ADE is older (`isMachineNeedsUpdateError`): "Update ADE on
 * <machine>", what that unlocks, and the same Update the Machines list and
 * "Update other machines" run. Never the raw error.
 *
 * The button goes to that computer by its connection (`machineKey` is the
 * paired machine's account key, the snapshot's `colorKey`). An ADE Cloud
 * computer updates itself, and a computer this window is not connected to,
 * or one too old to be updated from here, is updated on itself: those say so
 * and have no button.
 */
export function MachineNeedsUpdate({
  machineKey,
  machineName,
  unlocks,
}: {
  machineKey: string;
  machineName: string;
  /** What updating it unlocks here, as the end of a sentence: "to see what it has installed here." */
  unlocks: string;
}) {
  const { machines } = useConnectedMachines();
  const known = useKnownAdeVersions();
  const updates = useMachineUpdates();
  const cloud = useCloudSelfUpdates();
  const machine = machines?.find((entry) => entry.colorKey === machineKey) ?? null;
  const selfUpdating = cloud.boxFor(machineKey) != null;
  const attempt = machine ? updates.attempts[machine.id] ?? null : null;
  const status = machine && attempt
    ? describeMachineUpdateAttempt(attempt, { ...machine, connected: true }, updates.nowMs)
    : null;
  const busy = machine ? isMachineUpdateBusy(updates, machine, updates.nowMs) : false;
  const manual = machine ? machineUpdateIsManual(machine, attempt) : false;
  const downloadUrl = machine?.downloadUrl ?? attempt?.downloadUrl ?? null;
  const canAsk = machine != null && machine.canUpdate !== false && canUpdateOtherMachines() && !selfUpdating;

  const hint = selfUpdating
    ? `ADE Cloud updates itself; this works once ${machineName} has its next update.`
    : canAsk
      ? `${machineName} runs an older ADE. Update it ${unlocks}`
      : machine
        ? `${machineName} runs an older ADE that can't be updated from here. Update it on that computer ${unlocks}`
        : `${machineName} runs an older ADE. Connect to it to update it from here, or update it on that computer ${unlocks}`;

  return (
    <div className="ade-machine-needs-update" role="status" data-machine-needs-update={machineKey}>
      <WarningCircle size={15} weight="fill" className="ade-machine-needs-update-icon" aria-hidden />
      <div className="ade-machine-needs-update-copy">
        <div className="ade-ap-rowtitle">{`Update ADE on ${machineName}`}</div>
        <div className="ade-ap-rowhint">{status?.message ?? hint}</div>
      </div>
      {canAsk && machine ? (
        manual ? (
          <button
            type="button"
            className="ade-acct-btn"
            data-tone="primary"
            disabled={!downloadUrl}
            onClick={() => downloadUrl && openExternalUrl(downloadUrl)}
          >
            Download update
            <ArrowSquareOut size={12} weight="bold" />
          </button>
        ) : (
          <button
            type="button"
            className="ade-acct-btn"
            data-tone="primary"
            disabled={busy}
            onClick={() => void requestMachineUpdates([{ ...machine, targetVersion: machineUpdateTargetVersion(machine, known) }])}
          >
            <ArrowsClockwise size={12} weight="bold" className={busy ? "animate-spin" : undefined} />
            {busy ? "Updating…" : "Update"}
          </button>
        )
      ) : null}
    </div>
  );
}
