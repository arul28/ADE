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
  newestKnownAdeVersion,
  outdatedMachines,
  type ConnectedMachine,
} from "../remoteTargets/remoteMachineModel";
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
export function OtherMachinesUpdateSection({ group, anchor }: { group: string; anchor?: string }) {
  if (!canUpdateOtherMachines()) return null;
  return <OtherMachinesUpdates group={group} anchor={anchor} />;
}

function OtherMachinesUpdates({ group, anchor }: { group: string; anchor?: string }) {
  const { machines: readMachines, failed } = useConnectedMachines();
  const machines = readMachines ?? [];
  const updateSnapshot = useAutoUpdateSnapshot();
  const machineUpdates = useMachineUpdates();
  const newestVersion = useMemo(
    () =>
      newestKnownAdeVersion({
        currentVersion: updateSnapshot.currentVersion,
        latestKnownVersion: updateSnapshot.latestKnownVersion,
      }),
    [updateSnapshot.currentVersion, updateSnapshot.latestKnownVersion],
  );
  const behind = outdatedMachines(machines, newestVersion);
  const behindIds = new Set(behind.map((machine) => machine.id));
  const anyBusy = behind.some((machine) => isMachineUpdateBusy(machineUpdates, machine, machineUpdates.nowMs));

  return (
    <ModernSection
      group={group}
      anchor={anchor}
      title="Update other machines"
      hint="With the ADE app open there, the app and its background service update together; otherwise only the service does."
      actions={behind.length > 1 ? (
        <button
          type="button"
          className="ade-modern-btn"
          disabled={anyBusy}
          onClick={() => void requestMachineUpdates(behind, newestVersion)}
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
          return (
            <ModernRow
              key={machine.id}
              title={machine.name}
              hint={(
                <>
                  {machine.version ? <>ADE <span className="kit-num">{machine.version}</span></> : "Version unknown"}
                  {behindIds.has(machine.id) && newestVersion
                    ? <> · <span className="kit-num">{newestVersion}</span> available</>
                    : null}
                </>
              )}
              control={behindIds.has(machine.id) ? (
                <button
                  type="button"
                  className="ade-modern-btn"
                  disabled={updating || checking}
                  onClick={() => void requestMachineUpdates([machine], newestVersion)}
                >
                  <ArrowsClockwise size={13} weight="bold" className={updating ? "animate-spin" : undefined} />
                  {updating ? "Updating…" : checking ? "Checking…" : "Update & restart"}
                </button>
              ) : machine.version ? (
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
