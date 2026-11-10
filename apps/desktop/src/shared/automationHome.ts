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
