/**
 * The one line a machine row says about itself, and the one word its button
 * says back.
 *
 * A machine row used to carry three lines — a name, "Connected to your ADE
 * account", and a status sentence — none of which answered the question people
 * actually have in front of a list of computers: is it awake, and is it going
 * to stay that way. The second line now carries everything:
 *
 *     Arul's Mac Studio            CONNECTED  ✓
 *     Plugged in
 *     MacBook Pro                      Wake  ›
 *     Asleep · 82% battery
 *     windows                       Connect  ›
 *     Online · plugged in
 *
 * Two rules this file exists to enforce:
 *
 * 1. Presence comes from `resolveMachinePresence` and nowhere else, so a
 *    phone, the desktop, and the CLI cannot disagree about whether a machine
 *    is awake.
 * 2. A machine with no battery renders no battery slot at all. A Mac Studio
 *    showing "0% battery" is a lie about hardware that does not exist, so the
 *    absence of `power.battery` must stay an absence.
 *
 * A connected machine's line says only its power, because every surface that
 * can pass `connected: true` marks the row itself — the check beside the name.
 * A surface that renders no such mark must not pass the flag, or the row would
 * lose the one word that distinguishes it from any other online machine.
 *
 * Lives in `shared/` rather than beside a component: three unrelated trees
 * render machine rows, and none of them owns this.
 */

import type { AdeAccountMachine } from "./types/account";
import type { MachinePower, MachinePresence } from "./types/power";
import { resolveMachinePresence } from "./types/power";
import type { RemoteRuntimeConnectionStatus } from "./types/remoteRuntime";

/**
 * The machine identities this computer holds a live runtime channel to, kept in
 * TWO sets rather than one.
 *
 * Both ids are collected because a saved target references its machine by
 * whichever one it was created with: the directory's `machineKey`, or the
 * paired `hostIdentity` that the directory republishes as `deviceId`. Matching
 * on only one of them would report a machine we are actively talking to as
 * merely "online".
 *
 * They stay in separate namespaces because only `machine_key` is unique — the
 * machines table is keyed on `(user_id, machine_key)` and `device_id` carries
 * no constraint at all. Merged into one set, a reinstall that kept its
 * `deviceId` would render BOTH rows Connected off a single channel, which is
 * the identity-collision bug class this whole area exists to remove.
 */
export type ConnectedMachineIds = {
  machineKeys: ReadonlySet<string>;
  deviceIds: ReadonlySet<string>;
};

export function connectedMachineIds(
  connections: readonly RemoteRuntimeConnectionStatus[] | null | undefined,
): ConnectedMachineIds {
  const machineKeys = new Set<string>();
  const deviceIds = new Set<string>();
  for (const entry of connections ?? []) {
    if (entry.state !== "connected") continue;
    const machineKey = entry.target.pairedMachine?.machineKey?.trim();
    if (machineKey) machineKeys.add(machineKey);
    const hostIdentity = entry.target.pairedMachine?.hostIdentity?.trim();
    if (hostIdentity) deviceIds.add(hostIdentity);
  }
  return { machineKeys, deviceIds };
}

/** An empty result, so a surface with no snapshot yet has something to hold. */
export const NO_CONNECTED_MACHINE_IDS: ConnectedMachineIds = {
  machineKeys: new Set<string>(),
  deviceIds: new Set<string>(),
};

/** True when one of those live channels belongs to this directory machine. */
export function isMachineConnected(
  machine: AdeAccountMachine,
  connected: ConnectedMachineIds,
): boolean {
  if (connected.machineKeys.has(machine.machineKey.trim())) return true;
  const deviceId = machine.deviceId?.trim();
  return Boolean(deviceId && connected.deviceIds.has(deviceId));
}

export function accountMachinePresence(
  machine: AdeAccountMachine,
  options: { connected?: boolean; now?: number } = {},
): MachinePresence {
  return resolveMachinePresence({
    connected: options.connected === true,
    online: machine.online,
    sleepState: machine.sleepState ?? null,
    // Without the stamp the resolver cannot age the announcement, and a
    // `sleep_state` the directory can never write back to NULL would pin this
    // machine "Asleep" on every surface forever.
    sleepStateAt: machine.sleepStateAt ?? null,
    lastSeenAt: machine.lastSeenAt,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/**
 * The power half of the status line, or null when the machine never reported
 * any. Battery wins over wall power: "82% battery" tells the reader how long
 * they have, "plugged in" tells them they have as long as they want.
 */
export function machinePowerPhrase(power: MachinePower | null | undefined): string | null {
  if (!power) return null;
  if (power.battery) return `${power.battery.percent}% battery`;
  return power.onExternalPower ? "plugged in" : "on battery";
}

const PRESENCE_WORD: Record<MachinePresence, string> = {
  // Connected is already stated by the row's own status chip, so repeating it
  // on the second line would spend the line on nothing.
  connected: "",
  online: "Online",
  asleep: "Asleep",
  offline: "Offline",
};

/**
 * The second line. Six words at the outside, sentence case, and it never
 * renders an empty separator: a machine with no power reading says only its
 * presence, and a connected machine with no power reading says nothing at all
 * rather than an orphaned dot.
 */
export function machineStatusLine(
  machine: AdeAccountMachine,
  options: { connected?: boolean; now?: number; presence?: MachinePresence } = {},
): string | null {
  const presence = options.presence ?? accountMachinePresence(machine, options);
  const word = PRESENCE_WORD[presence];
  const power = machinePowerPhrase(machine.power);
  if (!word) {
    // Leading position, so the power phrase carries the capital.
    return power ? power.charAt(0).toUpperCase() + power.slice(1) : null;
  }
  return power ? `${word} · ${power}` : word;
}

/**
 * What the row's primary button says.
 *
 * "Wake" rather than "Connect" for a sleeping machine, because connecting IS
 * what wakes it — the same thing the phone says when a tapped link points at a
 * machine that has gone dark. It is one word of honesty about what the click
 * does, not a second mechanism.
 */
export function machineActionLabel(presence: MachinePresence): string {
  return presence === "asleep" ? "Wake" : "Connect";
}
