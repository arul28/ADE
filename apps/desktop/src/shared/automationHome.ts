/**
 * How long a computer may keep running the automations it is home to without
 * hearing from the ADE account. A home that has not synced for this long
 * stops starting them, because another computer may have taken them over
 * meanwhile (a change of home it has not seen).
 */
export const AUTOMATION_HOME_LEASE_MS = 10 * 60_000;

/**
 * How long a new home waits after a change of home before it starts triggered
 * runs: past the old home's lease, so the two never run a rule at once.
 */
export const AUTOMATION_HOME_HANDOVER_MS = AUTOMATION_HOME_LEASE_MS + 2 * 60_000;

/** The handover wait in whole minutes, for copy. */
export const AUTOMATION_HOME_HANDOVER_MINUTES = Math.round(AUTOMATION_HOME_HANDOVER_MS / 60_000);
/** The lease in whole minutes, for copy. */
export const AUTOMATION_HOME_LEASE_MINUTES = Math.round(AUTOMATION_HOME_LEASE_MS / 60_000);

/**
 * ADE Cloud as a rule's home (C9): ADE's server watches the trigger and starts
 * each run on its own new cloud computer. Written as a home with a device id
 * no computer has, so every brain, an older one included, reads it as
 * another computer's home and never runs the rule (`runsHere` false).
 */
export const ADE_CLOUD_HOME_DEVICE_ID = "ade-cloud";
export const ADE_CLOUD_HOME_NAME = "ADE Cloud";

/** True for the ADE Cloud home. */
export function isAdeCloudHome(home: { deviceId?: string | null; kind?: string | null } | null | undefined): boolean {
  return home?.kind === "cloud" || home?.deviceId === ADE_CLOUD_HOME_DEVICE_ID;
}
