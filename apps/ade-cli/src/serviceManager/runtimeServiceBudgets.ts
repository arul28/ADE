/**
 * Every timeout in the brain's start/handover lifecycle, in one place.
 *
 * These numbers only mean anything relative to each other: the desktop's wait
 * for the endpoint has to outlast the installer's handover budget, and the
 * young-brain window has to outlast a cold start. They used to be spelled as
 * bare literals in seven files, so tuning one silently broke that ordering.
 *
 * Lives in the CLI because the CLI owns the service installers; the desktop
 * imports from here the same way it imports the installers themselves.
 */

/**
 * How long a freshly (re)started brain gets to answer before the installer
 * stops waiting and reports it as `starting` instead of ready. Generous on
 * purpose: this used to be 10s, and a brain that legitimately took longer on a
 * cold machine was reported as a failed install, which the desktop turned into
 * "couldn't be set up" plus a Repair that killed the brain and started the
 * same race over.
 */
export const RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS = 30_000;

/**
 * A brain younger than this that is not answering yet is presumed to still be
 * starting. Installers leave it alone and wait for it instead of restarting it:
 * restarting a booting brain only resets its clock, and doing so on every
 * Repair click is how a slow machine could never finish starting one.
 *
 * Also the desktop's "still starting, not broken" window.
 */
export const RUNTIME_SERVICE_YOUNG_BRAIN_MS = 120_000;

/**
 * The Windows supervisor's handover budget. Shorter than the POSIX one because
 * the supervisor is a process this installer starts and watches directly,
 * rather than a service handed to launchd/systemd and observed through it.
 */
export const WINDOWS_HANDOVER_TIMEOUT_MS = 15_000;

/**
 * How long a caller waits for the service endpoint to come up.
 *
 * Deliberately larger than RUNTIME_SERVICE_HANDOVER_TIMEOUT_MS: an installer
 * that gives up and reports `starting` has NOT failed, and the caller has to
 * still be waiting when the brain finishes. Two handover budgets (the
 * young-brain wait plus the real restart) fit inside this with room to spare.
 */
export const RUNTIME_SERVICE_START_WAIT_MS = 90_000;

/**
 * How long a caller keeps dialing a brain the installer reported as `starting`
 * before it gives up. Twice the handover budget: the installer stopped waiting,
 * the supervisor did not, and the socket appears the moment the brain is up.
 */
export const RUNTIME_SERVICE_STARTING_CONNECT_WAIT_MS = 60_000;
