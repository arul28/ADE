import { ArrowsClockwise } from "@phosphor-icons/react";
import { useInRouterContext } from "react-router-dom";
import { settingsRouteFor } from "../../../shared/settingsManifest";
import { useGoTo } from "../onboarding/spotlight/useGoTo";
import type { AutoUpdateSnapshot, UpdateInstallImpact } from "../../../shared/types";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { UNKNOWN_UPDATE_IMPACT } from "../../../shared/updateImpact";
import { updateTrackOfVersion } from "../../../shared/updateTrack";
import { rendererRuntimeTarget } from "../../lib/platform";
import { checkboxConfirmDialog, confirmDialog, type ConfirmDialogChoices } from "../ui/dialog/confirm";
import {
  listOutdatedConnectedMachines,
  readMachinesUpdateImpact,
  runMachineUpdates,
} from "../remoteTargets/machineUpdates";
import {
  MachineUpdateRow,
  PhonesLine,
  remoteMachineRowModel,
  resumableChatCount,
  rowsShowTracks,
  type MachineUpdateRowModel,
  type MachineWithImpact,
} from "../remoteTargets/MachineUpdateImpact";
import { machinePlatform } from "../remoteTargets/MachineIdentity";
import { knownAdeVersions, type MachineUpdateTarget } from "../remoteTargets/remoteMachineModel";
import { readThisComputerColorKey } from "../settings/machines/machineFacts";
import { captureUpdatePromptDecision } from "./captureUpdatePromptDecision";
import { dismissToast, showToast } from "./toast/toastStore";
import { updateRestartAction, type UpdateRestartAction } from "./updateRestartAction";

const UPDATING_MACHINES_TOAST_ID = "ade-update-other-machines";
/** One "Update" box per other machine, keyed by its id. */
const updateMachineKey = (id: string) => `updateMachine:${id}`;

type MachineToUpdate = MachineWithImpact & MachineUpdateTarget;

/** The install flow running now; a second click joins it instead of asking again. */
let installInFlight: Promise<boolean> | null = null;

/**
 * Other machines go first, because this computer's relaunch ends the run.
 * Resolves false when one did not take the update and the person chose not to
 * restart here either.
 */
async function updateOtherMachinesFirst(
  machines: readonly MachineToUpdate[],
  action: UpdateRestartAction,
): Promise<boolean> {
  showToast({
    id: UPDATING_MACHINES_TOAST_ID,
    title: `Updating ${machines.map((machine) => machine.name).join(", ")}`,
    message: "This computer restarts once they have started.",
    tone: "info",
    durationMs: 0,
  });
  let results: Awaited<ReturnType<typeof runMachineUpdates<MachineToUpdate>>>;
  try {
    results = await runMachineUpdates(machines);
  } finally {
    dismissToast(UPDATING_MACHINES_TOAST_ID);
  }
  const failed = results.filter((result) => !result.attempt.ok);
  if (failed.length === 0) return true;
  return await confirmDialog({
    title: failed.length === 1
      ? `${failed[0]!.machine.name} did not update`
      : `${failed.length} machines did not update`,
    message: "Restart this computer anyway? You can update a machine later from Update other machines in Settings.",
    children: (
      <ul className="ade-dialog-impact-list">
        {failed.map(({ machine, attempt }) => (
          <li key={machine.id}>{`${machine.name}: ${attempt.message}`}</li>
        ))}
      </ul>
    ),
    tone: "warning",
    confirmLabel: action.label,
    cancelLabel: "Not now",
    returnKeyHint: true,
  });
}

async function runInstallFlow(snapshot: AutoUpdateSnapshot, onAccepted?: () => void): Promise<boolean> {
  const action = updateRestartAction(snapshot);
  const [impact, machines, colorKey] = await Promise.all([
    Promise.resolve()
      .then(() => window.ade.updateGetInstallImpact())
      .catch((): UpdateInstallImpact => ({ ...UNKNOWN_UPDATE_IMPACT, connectedPhones: [] })),
    // Each machine is offered the newest build this computer knows on that
    // machine's own track; a track switch here never moves another machine.
    listOutdatedConnectedMachines(knownAdeVersions(snapshot)).then(readMachinesUpdateImpact),
    readThisComputerColorKey(),
  ]);
  const { connectedPhones, ...local } = impact;
  // No choice here: the resume follows this computer's "Continue chats after
  // restarts", and on the launch that lands the update each chat is checked
  // against the same rule a crash or reboot uses (setting, open question).
  const resumeChats = resumableChatCount(local) > 0 && local.continueAfterRestart !== false;
  const runningTrack = snapshot.track?.running ?? updateTrackOfVersion(snapshot.currentVersion);
  const thisComputer: MachineUpdateRowModel = {
    key: "this-computer",
    name: THIS_MACHINE_NAME,
    colorKey,
    platform: machinePlatform(rendererRuntimeTarget().platform),
    fromVersion: snapshot.currentVersion || null,
    toVersion: snapshot.version,
    fromTrack: runningTrack,
    toTrack: action.switchTo ?? runningTrack,
    thisComputer: true,
    impact: local,
  };
  const otherRows = machines.map((machine) => ({ machine, row: remoteMachineRowModel(machine) }));
  const showTracks = rowsShowTracks([thisComputer, ...otherRows.map(({ row }) => row)]);

  const answer = await checkboxConfirmDialog({
    title: action.switchTo
      ? `${action.label}?`
      : `${action.label} to ${snapshot.version?.trim().replace(/^v/i, "") || "the latest version"}?`,
    message: "ADE quits and reopens on its own. Unsaved edits may be lost.",
    icon: <ArrowsClockwise size={16} weight="bold" />,
    tone: "accent",
    size: "md",
    checkboxes: machines.map((machine) => ({ key: updateMachineKey(machine.id), label: `Update ${machine.name}` })),
    children: (choices: ConfirmDialogChoices) => (
      <div className="ade-upd-list">
        <MachineUpdateRow
          row={thisComputer}
          showTracks={showTracks}
          // Settings › Chat edits This computer's value; another machine's
          // row shows its value only (Settings › Chat has no machine picker).
          settingAction={<ChangeContinueSettingLink onOpen={choices.dismiss} />}
          extra={<PhonesLine phones={connectedPhones} />}
        />
        {otherRows.map(({ machine, row }) => (
          <MachineUpdateRow
            key={row.key}
            row={row}
            showTracks={showTracks}
            control={(
              <label className="ade-upd-check" title={`Update ${machine.name} first, then restart this computer`}>
                <input type="checkbox" aria-label={`Update ${machine.name}`} {...choices.checkboxProps(updateMachineKey(machine.id))} />
                Update
              </label>
            )}
          />
        ))}
      </div>
    ),
    confirmLabel: action.label,
    cancelLabel: "Not now",
    // No visible Return hint: beside the long action name it pushed the
    // button onto its own line. Return still confirms (the button has focus).
  });
  if (!answer.confirmed) {
    captureUpdatePromptDecision(snapshot, "deferred");
    return false;
  }

  const chosen = machines.filter((machine) => answer.checked[updateMachineKey(machine.id)] === true);
  if (chosen.length > 0) {
    const proceed = await updateOtherMachinesFirst(chosen, action);
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

/**
 * "Change" beside this computer's continue line: closes the dialog and opens
 * Settings › Chat on the setting, which lights up as a deep link does. Only
 * inside the app's router (the dialog host); elsewhere the line stands alone.
 */
function ChangeContinueSettingLink({ onOpen }: { onOpen: () => void }) {
  if (!useInRouterContext()) return null;
  return <ChangeContinueSettingLinkInRouter onOpen={onOpen} />;
}

function ChangeContinueSettingLinkInRouter({ onOpen }: { onOpen: () => void }) {
  const goTo = useGoTo();
  return (
    <button
      type="button"
      className="ade-upd-link"
      onClick={() => {
        onOpen();
        goTo(settingsRouteFor("chat.continue-after-restart") as `/${string}`);
      }}
    >
      Change
    </button>
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
