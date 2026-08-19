import type { SyncAccountDirectoryHealth } from "./types/sync";

/**
 * Why the account directory refused to register THIS machine, decoded once.
 *
 * Every surface that reacts to a refusal — the auto-recovery loop in the brain,
 * the desktop's reliability telemetry — reads the same two fields off the same
 * publisher health snapshot, and each used to decode them itself. One home, so
 * "what counts as a refusal" cannot drift between the thing that repairs it and
 * the thing that reports it.
 */

/** The codes the directory answers with; see `apps/account-directory/src/directory.ts`. */
export const ACCOUNT_MACHINE_REFUSAL_CODES = [
  "machine_revoked",
  "pairing_authentication_required",
] as const;

export type AccountMachineRefusalCode = typeof ACCOUNT_MACHINE_REFUSAL_CODES[number];

/**
 * The known code, `"other"` for a 403 this build has no name for, or null when
 * the last attempt was not a refusal at all.
 *
 * 403 ONLY, deliberately. A 401 is an authentication problem — the token this
 * machine presented was not accepted — which is a different failure with a
 * different repair, and counting it as a register refusal both mis-attributes
 * the incident and hides the auth failure behind it. A refusal is the
 * directory looking at a valid caller and saying no.
 *
 * `lastHttpReason` on the unrecognised path is server-supplied prose and must
 * never travel; `"other"` is all a caller may learn from it. That an
 * unrecognised 403 still resolves to something rather than to null is the
 * point: "the directory turned this machine away for a reason this build
 * cannot name" is exactly the fact the last incident needed and could not get.
 *
 * Anything else — a timeout, a 5xx, a transport failure — is not a refusal.
 *
 * The state gate is the other half of that. Health is a STATE, not an event:
 * `lastHttpStatus` / `lastHttpReason` describe the attempt currently failing
 * only while the state is `http_error`, and every other state either carries
 * its own status or leaves the pair behind. Decoding a refusal off one of those
 * would date-stamp a rejection that is no longer the reason this machine is
 * unpublished — and on the CLI's pairing-recovery path that is not just a
 * mislabelled metric, it is a repair episode started for nothing.
 */
export function readAccountRefusalCode(
  health: SyncAccountDirectoryHealth | null | undefined,
): AccountMachineRefusalCode | "other" | null {
  if (!health || health.state !== "http_error" || health.lastHttpStatus !== 403) return null;
  const reason = typeof health.lastHttpReason === "string" ? health.lastHttpReason.trim() : "";
  return (ACCOUNT_MACHINE_REFUSAL_CODES as readonly string[]).includes(reason)
    ? reason as AccountMachineRefusalCode
    : "other";
}
