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
  if (result.added === 0 && result.updated === 0) {
    return "Account secrets are already up to date on this machine.";
  }
  const parts = [
    result.added > 0 ? `${result.added} added` : null,
    result.updated > 0 ? `${result.updated} updated` : null,
  ].filter((part): part is string => part !== null);
  return `Pulled ${parts.join(", ")} from account storage.`;
}

/** True for a value a pull action returned, so a formatter can recognise one. */
export function isProjectSecretPullResult(value: unknown): value is ProjectSecretPullResult {
  if (!value || typeof value !== "object") return false;
  const record = value as { state?: unknown; added?: unknown; updated?: unknown };
  if (record.state === "unavailable") return true;
  // `pulled` carries counts the summary reads, so promise them and check them.
  return record.state === "pulled"
    && typeof record.added === "number"
    && typeof record.updated === "number";
}
