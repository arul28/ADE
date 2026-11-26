import { useEffect, useMemo, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import type { RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { openExternalUrl } from "../../lib/openExternal";
import { useAutoUpdateSnapshot } from "../app/useAutoUpdateSnapshot";
import {
  canSwitchMachineTracks,
  canUpdateOtherMachines,
  isMachineUpdateBusy,
  requestMachineTrackSwitch,
  requestMachineUpdates,
  useKnownAdeVersions,
  useMachineUpdates,
  machineUpdateIsManual,
} from "../remoteTargets/machineUpdates";
import {
  connectedMachinesFromSnapshot,
  machineBehindVersion,
  machineUpdateTrack,
  machinesBehindOnTheirTrack,
  newestKnownVersionOnTrack,
  type ConnectedMachine,
} from "../remoteTargets/remoteMachineModel";
import { describeMachineUpdateAttempt } from "../remoteTargets/machineUpdateStatus";
import { MachineAvatar, machineFormFactor, machinePlatform } from "../remoteTargets/MachineIdentity";
import { useCloudSelfUpdates } from "../remoteTargets/useCloudSelfUpdates";
import type { CloudMachine } from "../../../shared/adeCloud";
import { ADE_CLOUD_MACHINE_ID, ADE_CLOUD_NAME } from "../../../shared/adeCloud/binding";
import { UpdateTrackChip } from "../app/ChannelBadge";
import { ModernRow, ModernRows, ModernSection, SettingsSegmented } from "./primitives";
import { Banner } from "../ui/notice";
import type { UpdateTrack } from "../../../shared/updateTrack";
import { UPDATE_TRACK_OPTIONS } from "./UpdateTrackControls";

/** The tracks without their hints: a machine row has room for the names only. */
const TRACK_OPTIONS = UPDATE_TRACK_OPTIONS.map(({ value, label }) => ({ value, label }));

/**
 * The connected machines, kept current by main's connection snapshot. Null
 * until ADE has read them; `failed` when the read failed and no push has
 * arrived since, so an error never reads as "no machines".
 */
function useConnectedMachines(): { machines: ConnectedMachine[] | null; failed: boolean } {
  const [snapshot, setSnapshot] = useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // Whichever arrives later wins; an older read must not replace a newer push.
    const accept = (next: RemoteRuntimeConnectionSnapshot) => {
      if (cancelled) return;
      setFailed(false);
      setSnapshot((current) => (current && current.updatedAt > next.updatedAt ? current : next));
    };
    void window.ade.remoteRuntime.getConnectionSnapshot().then(accept).catch(() => {
      if (!cancelled) setFailed(true);
    });
    const unsubscribe = window.ade.remoteRuntime.onConnectionSnapshotChanged?.(accept);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  const machines = useMemo(() => (snapshot ? connectedMachinesFromSnapshot(snapshot) : null), [snapshot]);
  return { machines, failed };
}

/**
 * ADE on the other machines this computer is connected to: the version each
 * runs, and "Update & restart" for the ones that are behind. The same action
 * as the Machines list, placed where this computer's own update lives.
 * ADE Cloud is one machine: its computers update themselves, so they show as
 * one "ADE Cloud" row with the update line (and its Retry) of the computer that
 * needs attention, connected or asleep, never one row per computer.
 *
 * Renders nothing where this client cannot ask a machine to update
 * (`canUpdateOtherMachines`).
 */
type UpdatesProps = {
  group: string;
  anchor?: string;
  /**
   * For a page where updates are one part among many (Account): the section
   * says nothing until there is a connected machine to show, and carries an
   * icon like its neighbours.
   */
  compact?: boolean;
};

export function OtherMachinesUpdateSection(props: UpdatesProps) {
  if (!canUpdateOtherMachines()) return null;
  return <OtherMachinesUpdates {...props} />;
}

function OtherMachinesUpdates({ group, anchor, compact = false }: UpdatesProps) {
  const { machines: readMachines, failed } = useConnectedMachines();
  const machines = readMachines ?? [];
  const updateSnapshot = useAutoUpdateSnapshot();
  const machineUpdates = useMachineUpdates();
  // Every build this computer knows of, on either track. Each machine is
  // offered only the newest one on its OWN track: a Stable machine is never
  // sent this computer's Beta, and a machine whose track has no known build
  // here is not called behind.
  const known = useKnownAdeVersions();
  const cloud = useCloudSelfUpdates();
  // Cloud computers keep themselves current: they leave the machine rows and "Update all",
  // and go into the one ADE Cloud row.
  const ownMachines = machines.filter((machine) => !cloud.boxFor(machine.colorKey));
  const behind = machinesBehindOnTheirTrack(ownMachines, known);
  const automaticBehind = behind.filter((machine) => !machineUpdateIsManual(machine, machineUpdates.attempts[machine.id]));
  const targetById = new Map(behind.map((machine) => [machine.id, machine.targetVersion]));
  const anyBusy = automaticBehind.some((machine) => isMachineUpdateBusy(machineUpdates, machine, machineUpdates.nowMs));
  // Name tracks once Beta is anywhere in the picture: here, or on a machine.
  const showTracks = updateSnapshot.track?.running === "beta"
    || updateSnapshot.track?.selected === "beta"
    || machines.some((machine) => machineUpdateTrack(machine) === "beta");
  const canSwitchTracks = canSwitchMachineTracks();
  const cloudBox = adeCloudRowBox(cloud);

  if (compact && ownMachines.length === 0 && !cloudBox) return null;

  return (
    <ModernSection
      group={group}
      anchor={anchor}
      icon={compact ? <ArrowsClockwise size={15} weight="bold" /> : undefined}
      tone="green"
      title="Update other machines"
      hint="With the ADE app open there, the app and its background service update together; otherwise only the service does."
      actions={automaticBehind.length > 1 ? (
        <button
          type="button"
          className="ade-modern-btn"
          disabled={anyBusy}
          onClick={() => void requestMachineUpdates(automaticBehind)}
        >
          <ArrowsClockwise size={13} weight="bold" />
          {`Update all ${automaticBehind.length}`}
        </button>
      ) : undefined}
    >
      <ModernRows>
        {failed && readMachines == null ? (
          <ModernRow
            title="Couldn't read the connected machines"
            hint="ADE could not list them just now. Open Connections in the top bar to see them."
          />
        ) : readMachines == null ? (
          <ModernRow title="Reading connected machines…" />
        ) : ownMachines.length === 0 && !cloudBox ? (
          <ModernRow
            title="No other machines connected"
            hint="Connect a machine from Connections in the top bar to see its version and update it from here."
          />
        ) : [...ownMachines.map((machine) => {
          const attempt = machineUpdates.attempts[machine.id] ?? null;
          const status = attempt
            ? describeMachineUpdateAttempt(attempt, { ...machine, connected: true }, machineUpdates.nowMs)
            : null;
          const updating = machineUpdates.updatingIds.has(machine.id) || status?.inFlight === true;
          const checking = machineUpdates.checkingIds.has(machine.id);
          const track = machineUpdateTrack(machine);
          const targetVersion = targetById.get(machine.id) ?? null;
          const manual = machineUpdateIsManual(machine, attempt);
          const downloadUrl = machine.downloadUrl ?? attempt?.downloadUrl;
          // Up to date only when this computer knows a build on that track to
          // compare with; otherwise the version stands alone.
          const knowsTrack = newestKnownVersionOnTrack(known, track) != null;
          // Each machine's own Stable / Beta, switched on that machine. Not for
          // one whose ADE is installed by hand, or one too old to be updated from here.
          const trackSwitch = canSwitchTracks && machine.canUpdate !== false && !manual ? (
            <SettingsSegmented<UpdateTrack>
              ariaLabel={`Update track for ${machine.name}`}
              value={track}
              options={TRACK_OPTIONS}
              disabled={updating || checking}
              onChange={(next) => { void requestMachineTrackSwitch(machine, next); }}
            />
          ) : null;
          const updateControl = targetVersion ? (
            <button
              type="button"
              className="ade-modern-btn"
              disabled={updating || checking || (manual && !downloadUrl)}
              onClick={() => manual ? openExternalUrl(downloadUrl) : void requestMachineUpdates([{ ...machine, targetVersion }])}
            >
              <ArrowsClockwise size={13} weight="bold" className={updating ? "animate-spin" : undefined} />
              {manual ? "Download update" : updating ? "Updating…" : checking ? "Checking…" : "Update & restart"}
            </button>
          ) : machineBehindVersion(machine, known) ? (
            <span className="kit-tag">Update it on that machine</span>
          ) : machine.version && knowsTrack ? (
            <span className="kit-tag" data-tone="ok">Up to date</span>
          ) : null;
          return (
            <ModernRow
              key={machine.id}
              leading={(
                <MachineAvatar
                  colorKey={machine.colorKey ?? machine.id}
                  name={machine.name}
                  platform={machinePlatform(machine.arch)}
                  formFactor={machineFormFactor({ name: machine.name })}
                  size={30}
                />
              )}
              title={showTracks && !trackSwitch ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {machine.name}
                  <UpdateTrackChip track={track} />
                </span>
              ) : machine.name}
              hint={(
                <>
                  {machine.version ? <>ADE <span className="kit-num">{machine.versionLabel ?? machine.version}</span></> : "Version unknown"}
                  {targetVersion
                    ? <> · <span className="kit-num">{targetVersion}</span> available</>
                    : null}
                </>
              )}
              control={trackSwitch || updateControl ? <>{trackSwitch}{updateControl}</> : undefined}
            >
              {status?.ok ? (
                <div role="status" className="ade-ap-rowhint">
                  {status.message}
                </div>
              ) : status ? (
                <Banner
                  layout="inline"
                  model={{
                    id: `machine-update-error-${machine.id}`,
                    tone: "error",
                    title: status.message,
                    report: { surface: "machine_update" },
                  }}
                />
              ) : null}
            </ModernRow>
          );
        }), ...(cloudBox ? [<CloudUpdateRow key="ade-cloud" box={cloudBox} cloud={cloud} />] : [])]}
      </ModernRows>
    </ModernSection>
  );
}

/** The cloud computer whose line the ADE Cloud row shows: one with an error, then a failed update, then any. */
function adeCloudRowBox(cloud: ReturnType<typeof useCloudSelfUpdates>): CloudMachine | null {
  return cloud.boxes.find((box) => cloud.errorFor(box))
    ?? cloud.boxes.find((box) => box.update?.state === "failed")
    ?? cloud.boxes.find((box) => box.update?.state === "updating")
    ?? cloud.boxes[0]
    ?? null;
}

/** The one ADE Cloud row: the update line where other machines have Update & restart. */
function CloudUpdateRow({ box, cloud }: { box: CloudMachine; cloud: ReturnType<typeof useCloudSelfUpdates> }) {
  const error = cloud.errorFor(box);
  return (
    <ModernRow
      leading={<MachineAvatar colorKey={ADE_CLOUD_MACHINE_ID} name={ADE_CLOUD_NAME} platform={machinePlatform(null, "linux")} formFactor={machineFormFactor({ name: ADE_CLOUD_NAME })} size={30} />}
      title={ADE_CLOUD_NAME}
      hint="Updates itself"
      control={cloud.lineFor(box, ADE_CLOUD_NAME)}
    >
      {error ? (
        <Banner
          layout="inline"
          model={{
            id: `cloud-update-error-${box.instanceId}`,
            tone: error.blocker ? "warning" : "error",
            title: error.message,
            dismiss: { onDismiss: () => cloud.dismissError(box.instanceId) },
            ...(error.blocker ? { report: false as const } : { report: { surface: "cloud_machine_action" } }),
          }}
        />
      ) : null}
    </ModernRow>
  );
}
