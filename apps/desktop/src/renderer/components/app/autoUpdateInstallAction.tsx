import type { AutoUpdateSnapshot } from "../../../shared/types";
import { confirmDialog } from "../ui/dialog/confirm";
import { captureUpdatePromptDecision } from "./captureUpdatePromptDecision";
import { dismissToast, showToast } from "./toast/toastStore";
import {
  ChoiceCheckbox,
  listOutdatedConnectedMachines,
  MachinesRunningWork,
  readMachinesRunningWork,
  runningWorkFromInstallImpact,
  RunningWorkSummary,
  type OutdatedMachine,
  type OutdatedMachineWork,
  type RunningWork,
} from "./updateRunningWork";

const UPDATING_MACHINES_TOAST_ID = "ade-update-other-machines";

function versionLabel(version: string | null): string {
  return version ? `v${version}` : "the latest update";
}

function machineNames(machines: readonly OutdatedMachine[]): string {
  return machines.map((machine) => machine.name).join(", ");
}

type InstallChoices = { resumeChats: boolean; updateMachines: boolean };

/**
 * What the install stops, here and on the other machines it can bring along,
 * with the two things the person can still decide.
 */
function InstallImpactBody({
  local,
  machines,
  choices,
  offerResume,
}: {
  local: RunningWork;
  machines: readonly OutdatedMachineWork[];
  choices: InstallChoices;
  offerResume: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <RunningWorkSummary work={local} heading={machines.length > 0 ? "This computer" : undefined} />
      {offerResume ? (
        <ChoiceCheckbox choices={choices} name="resumeChats" label="Resume these chats when ADE is back" />
      ) : null}
      {machines.length > 0 ? (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--color-border)" }}>
          <MachinesRunningWork machines={machines} />
          <ChoiceCheckbox
            choices={choices}
            name="updateMachines"
            label={machines.length === 1
              ? `Update ${machines[0].name} too`
              : `Update these ${machines.length} machines too`}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Other machines go first, because this computer's relaunch ends the run.
 * Resolves false when one did not take the update and the person chose not to
 * install here either.
 */
async function updateOtherMachinesFirst(
  machines: readonly OutdatedMachine[],
  targetVersion: string | null,
): Promise<boolean> {
  showToast({
    id: UPDATING_MACHINES_TOAST_ID,
    title: `Updating ${machineNames(machines)}`,
    message: "This computer installs once they have started.",
    tone: "info",
    durationMs: 0,
  });
  const results = await Promise.all(machines.map(async (machine) => {
    try {
      const result = await window.ade.remoteRuntime.updateAndRestart(machine.id, targetVersion);
      return { machine, ok: result.ok, message: result.message };
    } catch (error) {
      return { machine, ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }));
  dismissToast(UPDATING_MACHINES_TOAST_ID);
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return true;
  return await confirmDialog({
    title: failed.length === 1
      ? `${failed[0].machine.name} did not update`
      : `${failed.length} machines did not update`,
    message: "Install on this computer anyway? You can update a machine later from its row in Machines.",
    children: (
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 3 }}>
        {failed.map((result) => (
          <li key={result.machine.id} style={{ overflowWrap: "anywhere" }}>
            {`${result.machine.name}: ${result.message}`}
          </li>
        ))}
      </ul>
    ),
    tone: "warning",
    confirmLabel: "Install here",
    cancelLabel: "Not now",
  });
}

/** Shared confirmation and install action for every manual update affordance. */
export async function requestDownloadedUpdateInstall(
  snapshot: AutoUpdateSnapshot,
  onAccepted?: () => void,
): Promise<boolean> {
  const [impact, machines] = await Promise.all([
    Promise.resolve()
      .then(() => window.ade.updateGetInstallImpact())
      .catch(() => null),
    listOutdatedConnectedMachines(snapshot.version).then(readMachinesRunningWork),
  ]);
  const phones = impact?.connectedPhones ?? [];
  const local = runningWorkFromInstallImpact(impact);
  const offerResume = local.chats.some((chat) => chat.resumable !== false);
  const title = `ADE will quit and reopen automatically to install ${versionLabel(snapshot.version)}.`;
  const lines: string[] = [];
  if (phones.length === 1) {
    lines.push(
      `${phones[0].deviceName} is connected through ADE phone sync. It will disconnect during the update and reconnect automatically once ADE is back.`,
    );
  } else if (phones.length > 1) {
    lines.push(
      `Connected phones (${phones.map((phone) => phone.deviceName).join(", ")}) will disconnect during the update and reconnect automatically once ADE is back.`,
    );
  }
  lines.push(
    "Open ADE Code terminals and running agent sessions on this machine will disconnect while the ADE service restarts — you can reopen them right after the update.",
    "",
    "You do not need to restart ADE yourself. Any unsaved work may be lost. Continue?",
  );

  const choices: InstallChoices = { resumeChats: offerResume, updateMachines: machines.length > 0 };
  const confirmed = await confirmDialog({
    title,
    message: lines.join("\n"),
    children: (
      <InstallImpactBody local={local} machines={machines} choices={choices} offerResume={offerResume} />
    ),
    confirmLabel: "Continue",
  });
  if (!confirmed) {
    captureUpdatePromptDecision(snapshot, "deferred");
    return false;
  }

  const resumeChats = offerResume && choices.resumeChats;
  captureUpdatePromptDecision(snapshot, "accepted", { resumeChats });
  onAccepted?.();
  if (choices.updateMachines && machines.length > 0) {
    const proceed = await updateOtherMachinesFirst(machines, snapshot.version);
    if (!proceed) return false;
  }
  try {
    return await window.ade.updateQuitAndInstall({ resumeChats });
  } catch {
    // The main process logs updater failures.
    return false;
  }
}
