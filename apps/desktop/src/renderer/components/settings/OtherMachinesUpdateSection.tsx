import { useEffect, useMemo, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import type { RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { openExternalUrl } from "../../lib/openExternal";
import { useAutoUpdateSnapshot } from "../app/useAutoUpdateSnapshot";
import {
  canUpdateOtherMachines,
  isMachineUpdateBusy,
  requestMachineUpdates,
  useKnownAdeVersions,
  useMachineUpdates,
  machineUpdateIsManual,
} from "../remoteTargets/machineUpdates";
import {
  connectedMachinesFromSnapshot,
  describeMachineUpdateAttempt,
  machineUpdateTrack,
  machinesBehindOnTheirTrack,
  newestKnownVersionOnTrack,
  type ConnectedMachine,
} from "../remoteTargets/remoteMachineModel";
import { MachineAvatar, machineFormFactor, machinePlatform } from "../remoteTargets/MachineIdentity";
import { useCloudSelfUpdates } from "../remoteTargets/useCloudSelfUpdates";
import type { CloudMachine } from "../../../shared/adeCloud";
import { UpdateTrackChip } from "../app/ChannelBadge";
import { ModernRow, ModernRows, ModernSection } from "./primitives";
import { Banner } from "../ui/notice";

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
 * Cloud computers update themselves: each shows that line instead of the
 * button, and one that is asleep (so not connected) is listed too.
 *
 * Renders nothing in the browser client, which cannot ask a machine to update.
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
  // Cloud computers keep themselves current, so they are never in "Update all".
  const behind = machinesBehindOnTheirTrack(machines.filter((machine) => !cloud.boxFor(machine.colorKey)), known);
  const automaticBehind = behind.filter((machine) => !machineUpdateIsManual(machine, machineUpdates.attempts[machine.id]));
  const targetById = new Map(behind.map((machine) => [machine.id, machine.targetVersion]));
  const anyBusy = automaticBehind.some((machine) => isMachineUpdateBusy(machineUpdates, machine, machineUpdates.nowMs));
  // Name tracks once Beta is anywhere in the picture: here, or on a machine.
  const showTracks = updateSnapshot.track?.running === "beta"
    || updateSnapshot.track?.selected === "beta"
    || machines.some((machine) => machineUpdateTrack(machine) === "beta");
  const connectedKeys = new Set(machines.map((machine) => machine.colorKey ?? machine.id));
  const restingCloud = cloud.boxes.filter((box) => !connectedKeys.has(box.machineKey!));

  if (compact && machines.length === 0 && restingCloud.length === 0) return null;

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
        ) : machines.length === 0 && restingCloud.length === 0 ? (
          <ModernRow
            title="No other machines connected"
            hint="Connect a machine from Connections in the top bar to see its version and update it from here."
          />
        ) : [...machines.map((machine) => {
          const box = cloud.boxFor(machine.colorKey);
          if (box) {
            return (
              <CloudUpdateRow
                key={machine.id}
                box={box}
                name={machine.name}
                colorKey={machine.colorKey ?? machine.id}
                arch={machine.arch}
                version={machine.version ? machine.versionLabel ?? machine.version : null}
                cloud={cloud}
              />
            );
          }
          const attempt = machineUpdates.attempts[machine.id] ?? null;
          const status = attempt
            ? describeMachineUpdateAttempt(attempt, { connected: true, version: machine.version }, machineUpdates.nowMs)
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
              title={showTracks ? (
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
              control={targetVersion ? (
                <button
                  type="button"
                  className="ade-modern-btn"
                  disabled={updating || checking || (manual && !downloadUrl)}
                  onClick={() => manual ? openExternalUrl(downloadUrl) : void requestMachineUpdates([{ ...machine, targetVersion }])}
                >
                  <ArrowsClockwise size={13} weight="bold" className={updating ? "animate-spin" : undefined} />
                  {manual ? "Download update" : updating ? "Updating…" : checking ? "Checking…" : "Update & restart"}
                </button>
              ) : machine.version && knowsTrack ? (
                <span className="kit-tag" data-tone="ok">Up to date</span>
              ) : undefined}
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
        }), ...restingCloud.map((box) => (
          <CloudUpdateRow key={box.instanceId} box={box} name={box.name?.trim() || box.instanceId} colorKey={box.machineKey!} arch={null} version={null} cloud={cloud} />
        ))]}
      </ModernRows>
    </ModernSection>
  );
}

/**
 * A cloud computer in the list: its image, and the update line where other
 * machines have Update & restart. Asleep, it has no ADE version to read.
 */
function CloudUpdateRow({
  box,
  name,
  colorKey,
  arch,
  version,
  cloud,
}: {
  box: CloudMachine;
  name: string;
  colorKey: string;
  arch: string | null | undefined;
  version: string | null;
  cloud: ReturnType<typeof useCloudSelfUpdates>;
}) {
  const error = cloud.errorFor(box);
  return (
    <ModernRow
      leading={<MachineAvatar colorKey={colorKey} name={name} platform={machinePlatform(arch, "linux")} formFactor={machineFormFactor({ name })} size={30} />}
      title={name}
      hint={version ? <>ADE <span className="kit-num">{version}</span></> : box.state === "asleep" ? "Asleep" : "Not connected"}
      control={cloud.lineFor(box, name)}
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
