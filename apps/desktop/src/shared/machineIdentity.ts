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
 * matching and ADE warns you that This Mac has diverged from itself.
 *
 * Machines are named absolutely. The word "remote" is never a machine name:
 * once the machine a tab is bound to can change, "remote" has no fixed
 * referent, and inside the create-lane dialog it already means the git
 * base-branch source ("Use fetched upstream").
 */

/** Stable id for the machine ADE itself is running on. */
export const THIS_MACHINE_ID = "this-mac";

/** Absolute display name for the machine ADE itself is running on. */
export const THIS_MACHINE_NAME = "This Mac";

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
