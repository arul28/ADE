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
