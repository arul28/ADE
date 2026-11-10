/**
 * The sign-in variables an ADE Cloud computer may carry in its instance env
 * (an older desktop still sends the person's saved keys), and the one moment
 * the brain takes them out of its env (P5 step 2a, fix B1).
 *
 * The boot leaves them in place and runs the old path (`applyCloudSignIns`
 * writes Codex's key file), so a computer whose sign-in sync is off (a dev
 * bundle, sync off, an embedded runtime) or whose vault never becomes ready
 * keeps every key it was made with. The sync calls `takeCloudSignInEnv` at
 * its first apply, which runs only with a signed-in account and a ready vault.
 * From then on the vault decides: apply puts a saved key back while ADE Cloud
 * uses it, so a key never outranks a carried sign-in.
 *
 * Claude's token (`CLAUDE_CODE_OAUTH_TOKEN`) is P6's and always stays.
 * Nothing here logs a value.
 */

import { CLOUD_SIGN_INS } from "../../../shared/cloudSignIns";

/**
 * Take the sign-in variables (all but Claude's) out of `env`. Returns what it
 * took, name to value, for apply's one adoption of the old Codex key file.
 * Log only the names.
 */
export function takeCloudSignInEnv(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const taken: Record<string, string> = {};
  for (const spec of CLOUD_SIGN_INS) {
    if (spec.id === "claude") continue;
    const value = env[spec.env];
    if (typeof value !== "string" || !value.trim()) continue;
    taken[spec.env] = value.trim();
    delete env[spec.env];
  }
  return taken;
}
