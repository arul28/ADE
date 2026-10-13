import { useEffect, useMemo, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import type { RemoteRuntimeConnectionSnapshot } from "../../../shared/types";
import { useAutoUpdateSnapshot } from "../app/useAutoUpdateSnapshot";
import type { OutdatedMachine } from "../app/updateRunningWork";
import {
  canUpdateOtherMachines,
  requestMachineUpdates,
  useMachineUpdates,
} from "../remoteTargets/machineUpdates";
import {
  describeMachineUpdateAttempt,
  isMachineVersionOutdated,
  newestKnownAdeVersion,
} from "../remoteTargets/remoteMachineModel";
import { ModernRow, ModernRows, ModernSection } from "./primitives";

/** The connected machines, kept current by main's connection snapshot. */
function useConnectedMachines(): OutdatedMachine[] {
  const [snapshot, setSnapshot] = useState<RemoteRuntimeConnectionSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Whichever arrives later wins; an older read must not replace a newer push.
    const accept = (next: RemoteRuntimeConnectionSnapshot) => {
      if (cancelled) return;
      setSnapshot((current) => (current && current.updatedAt > next.updatedAt ? current : next));
    };
    void window.ade.remoteRuntime.getConnectionSnapshot().then(accept).catch(() => undefined);
    const unsubscribe = window.ade.remoteRuntime.onConnectionSnapshotChanged?.(accept);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  return useMemo(
    () =>
      (snapshot?.connections ?? [])
        .filter((connection) => connection.state === "connected")
        .map((connection) => ({
          id: connection.target.id,
          name: connection.target.name,
          version: connection.version ?? connection.target.runtimeBinaryVersion ?? null,
        })),
    [snapshot],
  );
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
  const machines = useConnectedMachines();
  const updateSnapshot = useAutoUpdateSnapshot();
  const { updatingIds, checkingIds, attempts, nowMs } = useMachineUpdates();
  const newestVersion = useMemo(
    () =>
      newestKnownAdeVersion({
        currentVersion: updateSnapshot.currentVersion,
        latestKnownVersion: updateSnapshot.latestKnownVersion,
      }),
    [updateSnapshot.currentVersion, updateSnapshot.latestKnownVersion],
  );
  const outdated = machines.filter((machine) => isMachineVersionOutdated(machine.version, newestVersion));
  const anyBusy = outdated.some((machine) => updatingIds.has(machine.id) || checkingIds.has(machine.id));

  return (
    <ModernSection
      group={group}
      anchor={anchor}
      title="Update other machines"
      hint="ADE on the machines this computer is connected to. A machine with the ADE app open updates the app and its background service together; with the app closed, only the background service updates, and the app offers its own update when it is next opened."
      actions={outdated.length > 1 ? (
        <button
          type="button"
          className="ade-modern-btn"
          disabled={anyBusy}
          onClick={() => void requestMachineUpdates(outdated, newestVersion)}
        >
          <ArrowsClockwise size={13} weight="bold" />
          {`Update all ${outdated.length}`}
        </button>
      ) : undefined}
    >
      <ModernRows>
        {machines.length === 0 ? (
          <ModernRow
            title="No other machines connected"
            hint="Connect a machine from Connections in the top bar to see its version and update it from here."
          />
        ) : machines.map((machine) => {
          const attempt = attempts[machine.id] ?? null;
          const status = attempt
            ? describeMachineUpdateAttempt(attempt, { connected: true, version: machine.version }, nowMs)
            : null;
          const behind = isMachineVersionOutdated(machine.version, newestVersion);
          const updating = updatingIds.has(machine.id) || status?.inFlight === true;
          const checking = checkingIds.has(machine.id);
          return (
            <ModernRow
              key={machine.id}
              title={machine.name}
              hint={(
                <>
                  {machine.version ? <>ADE <span className="kit-num">{machine.version}</span></> : "Version unknown"}
                  {behind && newestVersion ? <> · <span className="kit-num">{newestVersion}</span> available</> : null}
                </>
              )}
              control={behind ? (
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
              {status ? (
                <p
                  role="status"
                  className={status.ok ? "ade-ap-rowhint" : "ade-modern-error"}
                  style={{ margin: "6px 0 0" }}
                >
                  {status.message}
                </p>
              ) : null}
            </ModernRow>
          );
        })}
      </ModernRows>
    </ModernSection>
  );
}
