/**
 * How long a woken machine gets to come back online. Main's connect waits this
 * long for the woken machine's link (`remoteConnectionService.ts`); a surface
 * that woke a machine waits the same for it to read online, then says so.
 */
export const WOKEN_MACHINE_CONNECT_WAIT_MS = 45_000;
