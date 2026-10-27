import type { AutoUpdateSnapshot, UpdateImpact, UpdateInstallImpact } from "../../../shared/types";
import { UNKNOWN_UPDATE_IMPACT } from "../../../shared/updateImpact";
import { updateVersionLabel } from "../../../shared/updateVersions";
import { checkboxConfirmDialog, confirmDialog } from "../ui/dialog/confirm";
import {
  listOutdatedConnectedMachines,
  readMachinesUpdateImpact,
  runMachineUpdates,
} from "../remoteTargets/machineUpdates";
import {
  MachinesUpdateImpact,
  UpdateImpactSummary,
  type MachineWithImpact,
} from "../remoteTargets/MachineUpdateImpact";
import type { ConnectedMachine } from "../remoteTargets/remoteMachineModel";
import { captureUpdatePromptDecision } from "./captureUpdatePromptDecision";
import { dismissToast, showToast } from "./toast/toastStore";

const UPDATING_MACHINES_TOAST_ID = "ade-update-other-machines";
const RESUME_CHATS = "resumeChats";
const UPDATE_MACHINES = "updateMachines";

/** The install flow running now; a second click joins it instead of asking again. */
let installInFlight: Promise<boolean> | null = null;

function phonesLine(phones: UpdateInstallImpact["connectedPhones"]): string | null {
  if (phones.length === 1) {
    return `${phones[0].deviceName} is connected through ADE phone sync. It will disconnect during the update and reconnect automatically once ADE is back.`;
  }
  if (phones.length > 1) {
    return `Connected phones (${phones.map((phone) => phone.deviceName).join(", ")}) will disconnect during the update and reconnect automatically once ADE is back.`;
  }
  return null;
}

/**
 * Other machines go first, because this computer's relaunch ends the run.
 * Resolves false when one did not take the update and the person chose not to
 * install here either.
 */
async function updateOtherMachinesFirst(
  machines: readonly ConnectedMachine[],
  targetVersion: string | null,
): Promise<boolean> {
  showToast({
    id: UPDATING_MACHINES_TOAST_ID,
    title: `Updating ${machines.map((machine) => machine.name).join(", ")}`,
    message: "This computer installs once they have started.",
    tone: "info",
    durationMs: 0,
  });
  let results: Awaited<ReturnType<typeof runMachineUpdates>>;
  try {
    results = await runMachineUpdates(machines, targetVersion);
  } finally {
    dismissToast(UPDATING_MACHINES_TOAST_ID);
  }
  const failed = results.filter((result) => !result.attempt.ok);
  if (failed.length === 0) return true;
  return await confirmDialog({
    title: failed.length === 1
      ? `${failed[0].machine.name} did not update`
      : `${failed.length} machines did not update`,
    message: "Install on this computer anyway? You can update a machine later from Update other machines in Settings.",
    children: (
      <ul className="ade-dialog-impact-list">
        {failed.map(({ machine, attempt }) => (
          <li key={machine.id}>{`${machine.name}: ${attempt.message}`}</li>
        ))}
      </ul>
    ),
    tone: "warning",
    confirmLabel: "Install here",
    cancelLabel: "Not now",
    returnKeyHint: true,
  });
}

async function runInstallFlow(snapshot: AutoUpdateSnapshot, onAccepted?: () => void): Promise<boolean> {
  const [impact, machines] = await Promise.all([
    Promise.resolve()
      .then(() => window.ade.updateGetInstallImpact())
      .catch((): UpdateInstallImpact => ({ ...UNKNOWN_UPDATE_IMPACT, connectedPhones: [] })),
    listOutdatedConnectedMachines(snapshot.version).then(readMachinesUpdateImpact),
  ]);
  const { connectedPhones, ...local } = impact;
  const offerResume = local.chats.some((chat) => chat.resumable !== false);
  const phones = phonesLine(connectedPhones);

  const answer = await checkboxConfirmDialog({
    title: `ADE will quit and reopen automatically to install ${updateVersionLabel(snapshot.version, "the latest update")}.`,
    message: [
      ...(phones ? [phones, ""] : []),
      "You do not need to restart ADE yourself. Any unsaved work may be lost. Continue?",
    ].join("\n"),
    children: <InstallImpactBody local={local} machines={machines} />,
    checkboxes: [
      ...(offerResume
        ? [{ key: RESUME_CHATS, label: "Resume this computer's chats when ADE is back" }]
        : []),
      ...(machines.length > 0
        ? [{
            key: UPDATE_MACHINES,
            label: machines.length === 1 ? `Update ${machines[0].name} too` : `Update these ${machines.length} machines too`,
          }]
        : []),
    ],
    confirmLabel: "Continue",
    returnKeyHint: true,
  });
  if (!answer.confirmed) {
    captureUpdatePromptDecision(snapshot, "deferred");
    return false;
  }

  const resumeChats = offerResume && answer.checked[RESUME_CHATS] === true;
  if (machines.length > 0 && answer.checked[UPDATE_MACHINES] === true) {
    const proceed = await updateOtherMachinesFirst(machines, snapshot.version);
    if (!proceed) {
      captureUpdatePromptDecision(snapshot, "deferred");
      return false;
    }
  }
  onAccepted?.();
  let started = false;
  try {
    started = await window.ade.updateQuitAndInstall({ resumeChats });
  } catch {
    // The main process logs updater failures.
  }
  captureUpdatePromptDecision(snapshot, started ? "accepted" : "deferred", { resumeChats });
  return started;
}

/** What the install stops here and, when they come along, on the other machines. */
function InstallImpactBody({ local, machines }: { local: UpdateImpact; machines: readonly MachineWithImpact[] }) {
  return (
    <div className="ade-dialog-impact">
      <UpdateImpactSummary impact={local} label={machines.length > 0 ? "This computer" : undefined} />
      <MachinesUpdateImpact machines={machines} />
    </div>
  );
}

/**
 * Shared confirmation and install action for every manual update affordance.
 * Resolves true once the install has started; false when the person said no,
 * or it could not start. Never rejects.
 */
export function requestDownloadedUpdateInstall(
  snapshot: AutoUpdateSnapshot,
  onAccepted?: () => void,
): Promise<boolean> {
  installInFlight ??= runInstallFlow(snapshot, onAccepted)
    .catch(() => false)
    .finally(() => {
      installInFlight = null;
    });
  return installInFlight;
}
