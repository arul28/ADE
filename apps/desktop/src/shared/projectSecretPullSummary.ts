import type { ProjectSecretPullResult } from "./types/projectSecrets";

/**
 * The one sentence that describes a pull from the account vault.
 *
 * Shared by `ade secrets pull --text` and Settings > Secrets, so the terminal
 * and the window can never describe the same result differently.
 */
export function projectSecretPullSummary(result: ProjectSecretPullResult): string {
  if (result.state === "unavailable") {
    return "Could not pull account secrets. Sign in, keep the background service running, and check this repository has a Git remote.";
  }
  const added = result.added ?? 0;
  const updated = result.updated ?? 0;
  const removed = result.removed ?? 0;
  if (added === 0 && updated === 0 && removed === 0) {
    return "Account secrets are already up to date on this machine.";
  }
  const parts = [
    added > 0 ? `${added} added` : null,
    updated > 0 ? `${updated} updated` : null,
    removed > 0 ? `${removed} removed` : null,
  ].filter((part): part is string => part !== null);
  return `Pulled from account storage: ${parts.join(", ")}.`;
}

/** True for a value a pull action returned, so a formatter can recognise one. */
export function isProjectSecretPullResult(value: unknown): value is ProjectSecretPullResult {
  if (!value || typeof value !== "object") return false;
  const record = value as { state?: unknown; added?: unknown; updated?: unknown; removed?: unknown };
  if (record.state === "unavailable") return true;
  // `pulled` carries counts the summary reads, so promise them and check them.
  // `removed` may be missing: a runtime from before account-wide deletes answers
  // the older three-field shape, and that is still a pull result.
  return record.state === "pulled"
    && typeof record.added === "number"
    && typeof record.updated === "number"
    && (record.removed === undefined || typeof record.removed === "number");
}
