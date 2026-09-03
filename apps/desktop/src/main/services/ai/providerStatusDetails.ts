/**
 * The budgets every provider probe runs under, and the operator-facing `detail`
 * copy it writes.
 *
 * Their own module because all four parts of the probe read them — the seams,
 * the two per-provider tables, and the probe loop — and a shared root is what
 * keeps those four acyclic.
 */

/** Per-provider cache lifetime. Documented in `docs/features/sdk/README.md`. */
export const PROVIDER_STATUS_CACHE_TTL_MS = 60_000;

/** One `--version` spawn may not outlive this. */
export const PROVIDER_VERSION_TIMEOUT_MS = 5_000;

/** One last-resort `auth status` spawn may not outlive this. */
export const PROVIDER_AUTH_STATUS_TIMEOUT_MS = 5_000;

/** The whole report may not outlive this, however many providers hang. */
export const PROVIDER_STATUS_BUDGET_MS = 8_000;

/**
 * How much of one command's stdout (and stderr) is kept.
 *
 * Everything this module reads out of a probe — the first non-empty line of
 * `--version`, an `auth status` verdict — is in the first few hundred bytes.
 * Past this cap the text is dropped rather than accumulated, so a looping CLI
 * cannot grow the brain's heap for the length of its timeout.
 */
export const PROVIDER_OUTPUT_CAP_BYTES = 16 * 1024;

/**
 * The `detail` lines this module writes, as one exported table.
 *
 * They are operator-facing copy that appears on a setup screen, and the tests
 * assert on them: a test matching a substring of a sentence assembled inside
 * the module breaks on a rewording that broke nothing, and passes on a sentence
 * that no longer says what it used to. Exported so both sides read one string.
 */
export const PROVIDER_STATUS_DETAILS = {
  /** A resolver threw. Its message is appended. */
  detectionFailed: (message: string): string => `Detection failed: ${message}`,
  /** A bare command name that no PATH lookup confirmed. */
  notOnPath: (command: string): string =>
    `No \`${command}\` was found on PATH or in the known install directories.`,
  /** A real file, without the execute bit. POSIX only; Windows has no such bit. */
  notExecutable: (binaryPath: string): string => `${binaryPath} exists but is not executable.`,
  /** The credential file exists and could not be parsed or read. */
  credentialsUnreadable: "Credentials could not be read.",
  /** The last-resort `auth status` spawn timed out or failed to start. */
  authStatusUnverified: "login state could not be verified",
  /** The whole report ran out of budget before this provider answered. */
  budgetExceeded: "Detection did not finish within the status budget.",
} as const;
