/**
 * The single definition of "the machine ADE is running on".
 *
 * This existed in five places at once — `laneMachines`, `projectTabGrouping`,
 * `AgentChatComposer`, `PersonalChatsPage`, and a hardcoded literal in
 * `LaneGitActionsPane` — under three different names and, worse, **two
 * different id values** (`"this-mac"` and `"local"`), kept in sync by comments.
 *
 * That is not a style problem. The push-divergence guard decides whether a
 * branch is on "another" machine by comparing these ids
 * (`laneDivergence.detectPushDivergence`). The moment one producer supplies
 * `"local"` and the consumer expects `"this-mac"`, the self-filter stops
 * matching and ADE warns you that This computer has diverged from itself.
 *
 * Machines are named absolutely. The word "remote" is never a machine name:
 * once the machine a tab is bound to can change, "remote" has no fixed
 * referent, and inside the create-lane dialog it already means the git
 * base-branch source ("Use fetched upstream").
 */

import type { OpenProjectBinding } from "./types/core";

/** Stable id for the machine ADE itself is running on. */
export const THIS_MACHINE_ID = "this-mac";

/** Absolute display name for the machine ADE itself is running on. */
export const THIS_MACHINE_NAME = "This computer";

/** True when an id refers to the machine ADE is running on. */
export function isThisMachineId(machineId: string | null | undefined): boolean {
  return machineId === THIS_MACHINE_ID;
}

/**
 * Resolves a machine id to its absolute display name. Remote machines carry
 * their own name from the connection snapshot; anything unnamed falls back to
 * the id rather than to "remote".
 */
export function machineDisplayName(
  machineId: string | null | undefined,
  remoteName?: string | null,
): string {
  if (isThisMachineId(machineId)) return THIS_MACHINE_NAME;
  return remoteName?.trim() || machineId?.trim() || THIS_MACHINE_NAME;
}

/**
 * The absolute name of the machine a call-routing binding targets.
 *
 * A null binding is the tab's own machine — which, for a chat, is reached by
 * the unpinned path — so it names This computer, exactly like a local binding.
 * Remote bindings prefer the runtime's own name and fall back to the project
 * tab's display name; neither is ever the word "remote".
 */
export function machineNameForBinding(
  binding: OpenProjectBinding | null | undefined,
): string {
  if (binding?.kind !== "remote") return THIS_MACHINE_NAME;
  return binding.runtimeName?.trim() || binding.displayName?.trim() || THIS_MACHINE_NAME;
}

/**
 * The stable id of the machine a call-routing binding targets.
 *
 * Local / unbound tabs are This computer (`THIS_MACHINE_ID`), never `"local"`.
 */
export function machineIdForBinding(
  binding: OpenProjectBinding | null | undefined,
): string {
  if (binding?.kind === "remote") return binding.targetId;
  return THIS_MACHINE_ID;
}

/**
 * A machine can hold more than one checkout of a project. The Work union reads
 * each one into its own slice: the first under the machine id, every other one
 * under `<machine id>#checkout:<project id or folder>`. Each slice keeps its
 * own binding, so its rows open and act on that checkout.
 */
const CHECKOUT_SLOT_MARK = "#checkout:";

export function checkoutSlotId(machineId: string, checkoutKey: string): string {
  return `${machineId}${CHECKOUT_SLOT_MARK}${checkoutKey}`;
}

/** The machine a union slice belongs to: the id itself, or its machine for a second checkout. */
export function machineIdOfSlot(slotId: string): string {
  const at = slotId.indexOf(CHECKOUT_SLOT_MARK);
  return at < 0 ? slotId : slotId.slice(0, at);
}

/**
 * A machine's platform as Node or the account directory names it ("darwin",
 * "macos", "windows", "win32-x64", "linux"), or null when it says nothing
 * usable. "darwin" is read first: it contains "win". The one platform rule for
 * other machines: the device kinds a machine can run and the name of its
 * screen both read it.
 */
export function remoteMachineHostPlatform(platform: string | null | undefined): NodeJS.Platform | null {
  const value = platform?.trim().toLowerCase() ?? "";
  if (/darwin|mac|osx/.test(value)) return "darwin";
  if (/win/.test(value)) return "win32";
  if (/linux/.test(value)) return "linux";
  return null;
}

/** What {@link distinctMachineNames} reads off one machine. */
export type NamedMachine = {
  id: string;
  /** The name it would show on its own. */
  name: string;
  isThisMachine?: boolean;
  hostname?: string | null;
  /** The account-wide device id, when known: steadier than `id` for the short tag. */
  deviceId?: string | null;
};

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/** A host name as a person reads it: no `.local` or trailing dot. */
function shortHostname(hostname: string | null | undefined): string {
  return (hostname ?? "").trim().replace(/\.$/, "").replace(/\.local$/i, "");
}

/** The end of an id, long enough to tell `ids` apart. */
function shortIdTags(ids: readonly string[]): string[] {
  const plain = ids.map((id) => id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase());
  for (let length = 4; length < 32; length += 2) {
    const tags = plain.map((id) => id.slice(-length));
    if (new Set(tags).size === tags.length) return tags;
  }
  return plain;
}

/**
 * The name each machine shows in a list, told apart when two share one.
 *
 * Two of a person's computers often carry the same name: a Mac set up from
 * another one keeps "Arul's Mac Studio", and a list showing both twice gives
 * no way to pick the right one. Unique names come back unchanged. Within a
 * group that shares a name (case and spacing aside), This computer reads
 * "This computer", and every other machine gets its host name in brackets
 * when the host names tell them apart, or else the end of its id. Keyed by
 * `id`; every machine passed in has an entry.
 */
export function distinctMachineNames(machines: readonly NamedMachine[]): Map<string, string> {
  const groups = new Map<string, NamedMachine[]>();
  for (const machine of machines) {
    const key = nameKey(machine.name);
    groups.set(key, [...(groups.get(key) ?? []), machine]);
  }
  const names = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) {
      for (const machine of group) names.set(machine.id, machine.name);
      continue;
    }
    const others = group.filter((machine) => {
      if (!machine.isThisMachine) return true;
      names.set(machine.id, THIS_MACHINE_NAME);
      return false;
    });
    const hosts = others.map((machine) => shortHostname(machine.hostname));
    const hostsTellApart = hosts.every((host, index) => host && nameKey(host) !== nameKey(others[index]!.name))
      && new Set(hosts.map(nameKey)).size === hosts.length;
    // One other machine left beside This computer needs nothing more.
    if (others.length === 1 && others.length < group.length) {
      names.set(others[0]!.id, others[0]!.name);
      continue;
    }
    const tags = hostsTellApart ? hosts : shortIdTags(others.map((machine) => machine.deviceId?.trim() || machine.id));
    others.forEach((machine, index) => names.set(machine.id, `${machine.name.trim()} (${tags[index]})`));
  }
  return withoutLabelClashes(machines, names);
}

/**
 * A label made in one group can match a name in another ("Studio (office)"
 * made for one of two Studios, beside a machine named "Studio (office)"), and
 * "This computer" can match a machine named so. One label of each clash is
 * kept (This computer's, else one shown as it is named), and the rest take
 * their whole id, which no other machine shares.
 */
function withoutLabelClashes(machines: readonly NamedMachine[], names: Map<string, string>): Map<string, string> {
  const byId = new Map(machines.map((machine) => [machine.id, machine]));
  const byLabel = new Map<string, string[]>();
  for (const [id, label] of names) byLabel.set(nameKey(label), [...(byLabel.get(nameKey(label)) ?? []), id]);
  for (const ids of byLabel.values()) {
    if (ids.length < 2) continue;
    const keep = ids.find((id) => byId.get(id)?.isThisMachine && names.get(id) === THIS_MACHINE_NAME)
      ?? ids.find((id) => names.get(id) === byId.get(id)?.name)
      ?? ids[0]!;
    for (const id of ids) {
      if (id === keep) continue;
      const machine = byId.get(id);
      const tag = (machine?.deviceId?.trim() || id).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      names.set(id, `${(machine?.name ?? id).trim()} (${tag})`);
    }
  }
  return names;
}
