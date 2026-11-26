import { useSyncExternalStore } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { RemoteRuntimeTrackSwitchResult } from "../../../shared/types/remoteRuntime";
import { updateTrackLabel, type UpdateTrack } from "../../../shared/updateTrack";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { UpdateTrackChip } from "../app/ChannelBadge";
import { confirmMachineTrackSwitch } from "./MachineUpdateImpact";
import { machineUpdateIsManual, readMachinesUpdateImpact } from "./machineUpdates";
import { machineUpdateTrack, newestKnownVersionOnTrack, type ConnectedMachine } from "./remoteMachineModel";

/**
 * Stable/Beta for another machine, from this one (`machine.switchUpdateTrack`).
 * Its own action, never part of "Update & restart" (which stays on a
 * machine's track). The machine runs its own database check and may refuse;
 * its answer shows under the row.
 */

type TrackSwitchState = {
  busyIds: ReadonlySet<string>;
  results: Readonly<Record<string, RemoteRuntimeTrackSwitchResult>>;
};

let state: TrackSwitchState = { busyIds: new Set(), results: {} };
const listeners = new Set<() => void>();

function setState(next: Partial<TrackSwitchState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function withId(ids: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(ids);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export function useMachineTrackSwitches(): TrackSwitchState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Whether this client can move another machine between tracks (desktop only). */
export function canSwitchMachineTracks(): boolean {
  return isAdeAvailable(window.ade?.remoteRuntime?.switchUpdateTrack);
}

/**
 * A connected machine this computer can move between tracks: not one that is
 * updated by hand there, and not one whose ADE can't be updated from here.
 * ADE Cloud computers are left out by the caller (they update themselves).
 */
export function machineTrackSwitchable(machine: ConnectedMachine): boolean {
  return canSwitchMachineTracks() && machine.canUpdate !== false && !machineUpdateIsManual(machine);
}

function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "").trim() || "It didn't switch.";
}

/** Asks what is running there, confirms, then sends the switch. */
export async function requestMachineTrackSwitch(
  machine: ConnectedMachine,
  track: UpdateTrack,
  known: readonly string[],
): Promise<void> {
  const switchUpdateTrack = window.ade?.remoteRuntime?.switchUpdateTrack;
  if (!switchUpdateTrack || state.busyIds.has(machine.id) || machineUpdateTrack(machine) === track) return;
  setState({ busyIds: withId(state.busyIds, machine.id, true) });
  try {
    const [withImpact] = await readMachinesUpdateImpact([machine]);
    const confirmed = await confirmMachineTrackSwitch(withImpact!, track, newestKnownVersionOnTrack(known, track));
    if (!confirmed) return;
    const result = await switchUpdateTrack(machine.id, track);
    setState({ results: { ...state.results, [machine.id]: result } });
  } catch (error) {
    setState({
      results: {
        ...state.results,
        [machine.id]: { ok: false, track, outcome: "refused", version: null, currentVersion: machine.version, message: message(error) },
      },
    });
  } finally {
    setState({ busyIds: withId(state.busyIds, machine.id, false) });
  }
}

/** The track chip as a picker: the chip's look, a native select underneath for the choice. */
export function MachineTrackPicker({
  machine,
  known,
}: {
  machine: ConnectedMachine;
  known: readonly string[];
}) {
  const { busyIds } = useMachineTrackSwitches();
  const track = machineUpdateTrack(machine);
  const busy = busyIds.has(machine.id);
  return (
    <label className="ade-track-pick" data-busy={busy || undefined} title={`Update track for ${machine.name}`}>
      <UpdateTrackChip track={track} />
      <CaretDown size={9} weight="bold" aria-hidden />
      <select
        aria-label={`Update track for ${machine.name}`}
        value={track}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.value === "beta" ? "beta" : "stable";
          void requestMachineTrackSwitch(machine, next, known);
        }}
      >
        {(["stable", "beta"] as const).map((option) => (
          <option key={option} value={option}>{updateTrackLabel(option)}</option>
        ))}
      </select>
    </label>
  );
}

/** The machine's answer to the last switch from here, for the line under its row. */
export function machineTrackSwitchStatus(
  results: TrackSwitchState["results"],
  machineId: string,
): { ok: boolean; message: string } | null {
  const result = results[machineId];
  return result ? { ok: result.ok, message: result.message } : null;
}
