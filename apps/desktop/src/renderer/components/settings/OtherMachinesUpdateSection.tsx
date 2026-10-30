import { useEffect, useMemo, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import type { RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { useAutoUpdateSnapshot } from "../app/useAutoUpdateSnapshot";
import {
  canUpdateOtherMachines,
  isMachineUpdateBusy,
  requestMachineUpdates,
  useMachineUpdates,
} from "../remoteTargets/machineUpdates";
import {
  connectedMachinesFromSnapshot,
  describeMachineUpdateAttempt,
  knownAdeVersions,
  machineUpdateTrack,
  machinesBehindOnTheirTrack,
  newestKnownVersionOnTrack,
  type ConnectedMachine,
} from "../remoteTargets/remoteMachineModel";
import { MachineAvatar, machineFormFactor, machinePlatform } from "../remoteTargets/MachineIdentity";
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
  const { currentVersion, version: downloadedVersion, latestKnownVersion } = updateSnapshot;
  const known = useMemo(
    () => knownAdeVersions({ currentVersion, version: downloadedVersion, latestKnownVersion }),
    [currentVersion, downloadedVersion, latestKnownVersion],
  );
  const behind = machinesBehindOnTheirTrack(machines, known);
  const targetById = new Map(behind.map((machine) => [machine.id, machine.targetVersion]));
  const anyBusy = behind.some((machine) => isMachineUpdateBusy(machineUpdates, machine, machineUpdates.nowMs));
  // Name tracks once Beta is anywhere in the picture: here, or on a machine.
  const showTracks = updateSnapshot.track?.running === "beta"
    || updateSnapshot.track?.selected === "beta"
    || machines.some((machine) => machineUpdateTrack(machine) === "beta");

  if (compact && machines.length === 0) return null;

  return (
    <ModernSection
      group={group}
      anchor={anchor}
      icon={compact ? <ArrowsClockwise size={15} weight="bold" /> : undefined}
      tone="green"
      title="Update other machines"
      hint="With the ADE app open there, the app and its background service update together; otherwise only the service does."
      actions={behind.length > 1 ? (
        <button
          type="button"
          className="ade-modern-btn"
          disabled={anyBusy}
          onClick={() => void requestMachineUpdates(behind)}
        >
          <ArrowsClockwise size={13} weight="bold" />
          {`Update all ${behind.length}`}
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
        ) : machines.length === 0 ? (
          <ModernRow
            title="No other machines connected"
            hint="Connect a machine from Connections in the top bar to see its version and update it from here."
          />
        ) : machines.map((machine) => {
          const attempt = machineUpdates.attempts[machine.id] ?? null;
          const status = attempt
            ? describeMachineUpdateAttempt(attempt, { connected: true, version: machine.version }, machineUpdates.nowMs)
            : null;
          const updating = machineUpdates.updatingIds.has(machine.id) || status?.inFlight === true;
          const checking = machineUpdates.checkingIds.has(machine.id);
          const track = machineUpdateTrack(machine);
          const targetVersion = targetById.get(machine.id) ?? null;
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
                  disabled={updating || checking}
                  onClick={() => void requestMachineUpdates([{ ...machine, targetVersion }])}
                >
                  <ArrowsClockwise size={13} weight="bold" className={updating ? "animate-spin" : undefined} />
                  {updating ? "Updating…" : checking ? "Checking…" : "Update & restart"}
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
        })}
      </ModernRows>
    </ModernSection>
  );
}
