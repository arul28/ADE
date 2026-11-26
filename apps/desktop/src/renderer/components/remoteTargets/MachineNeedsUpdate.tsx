import { useMemo } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { isWindowsSelfInstallBlocked } from "../../../shared/updateVersions";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { Banner } from "../ui/notice";
import type { NoticeAction } from "../ui/notice/NoticeParts";
import {
  canUpdateOtherMachines,
  isMachineUpdateBusy,
  machineUpdateIsManual,
  requestMachineUpdates,
  useKnownAdeVersions,
  useMachineUpdates,
} from "./machineUpdates";
import { connectedMachinesFromSnapshot, machineUpdateTargetVersion, type ConnectedMachine } from "./remoteMachineModel";
import { describeMachineUpdateAttempt, type MachineUpdateStatus } from "./machineUpdateStatus";

/**
 * "Update & restart" for one connected machine, as a notice's actions: the
 * button (or the Linux download), whether it can be asked from here at all,
 * and the last attempt's outcome. Shared by every "update ADE there" notice.
 */
export function useMachineUpdateAsk(
  machine: ConnectedMachine | null,
  name: string,
  targetVersion: string | null,
): { actions: NoticeAction[]; busy: boolean; askable: boolean; status: MachineUpdateStatus | null; failed: boolean } {
  const updates = useMachineUpdates();
  const attempt = machine ? updates.attempts[machine.id] : undefined;
  const status = machine && attempt ? describeMachineUpdateAttempt(attempt, { ...machine, connected: true }, updates.nowMs) : null;
  const busy = machine ? isMachineUpdateBusy(updates, machine, updates.nowMs) : false;
  const manual = machine ? machineUpdateIsManual(machine, attempt) : false;
  // A brain too old to take `machine.updateAndRestart`, a build whose app
  // cannot run its installer, or a client that cannot ask (no bridge).
  const askable = machine != null
    && canUpdateOtherMachines()
    && machine.canUpdate !== false
    && !manual
    && !isWindowsSelfInstallBlocked(machine.version, machine.arch ?? null);
  const actions: NoticeAction[] = [];
  if (machine && askable) {
    actions.push({
      label: `Update & restart ${name}`,
      variant: "solid",
      busy,
      onClick: () => void requestMachineUpdates([{ ...machine, targetVersion }]),
    });
  }
  const downloadUrl = machine?.downloadUrl ?? attempt?.downloadUrl ?? null;
  if (manual && downloadUrl) actions.push({ label: "Download the update", href: downloadUrl, variant: "secondary" });
  const failed = Boolean(status && !status.ok && !status.inFlight);
  return { actions, busy, askable, status, failed };
}

/**
 * What a surface shows in place of a call another computer could not answer
 * because its ADE is older (`isMachineNeedsUpdateError`): "Update ADE on
 * <machine>", what that unlocks, and the same "Update & restart" the Machines
 * list runs. Never the raw error.
 *
 * The machine is found by its connection (`machineKey` is the paired
 * machine's account key, the snapshot's `colorKey`). One this window is not
 * connected to, or one too old to be updated from here, is updated on itself,
 * and the notice says so.
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
  const { snapshot } = useRemoteConnectionSnapshot(true);
  const machine = useMemo(
    () => connectedMachinesFromSnapshot(snapshot).find((entry) => entry.colorKey === machineKey) ?? null,
    [machineKey, snapshot],
  );
  const known = useKnownAdeVersions();
  const ask = useMachineUpdateAsk(machine, machineName, machine ? machineUpdateTargetVersion(machine, known) : null);
  const detail = ask.askable
    ? `${machineName} runs an older ADE. Update it ${unlocks}`
    : machine
      ? `${machineName} runs an older ADE that can't be updated from here. Update it on that computer ${unlocks}`
      : `${machineName} runs an older ADE. Connect to it to update it from here, or update it on that computer ${unlocks}`;
  return (
    <Banner
      layout="inline"
      model={{
        id: `machine-needs-update:${machineKey}`,
        tone: "warning",
        icon: <ArrowsClockwise size={16} weight="bold" />,
        title: `Update ADE on ${machineName}`,
        detail,
        actions: ask.actions,
        busy: ask.busy,
        report: false,
        ...(ask.status && !ask.failed ? { extra: <span className="text-[11px]" style={{ opacity: 0.85 }}>{ask.status.message}</span> } : {}),
        ...(ask.failed && ask.status ? { error: ask.status.message } : {}),
      }}
    />
  );
}
