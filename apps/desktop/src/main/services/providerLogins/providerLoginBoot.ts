/**
 * The brain's boot on an ADE Cloud computer (P5 step 2a), before it serves.
 *
 * A cloud computer made before P5 (or by an older desktop) has the person's
 * saved keys in its instance env, the variables `CLOUD_SIGN_INS` names. The
 * brain takes them out of its own `process.env` here, so a key the account
 * no longer has never reaches a chat. The sign-in sync then puts a saved key
 * back from the account vault, and only while ADE Cloud uses it
 * (`providerLoginSync` apply), so a key never outranks a carried sign-in.
 *
 * Claude's token (`CLAUDE_CODE_OAUTH_TOKEN`) is P6's and stays.
 *
 * The values are kept in memory only so apply can adopt the Codex
 * `auth.json` the old boot wrote from `OPENAI_API_KEY` (`adoptOldCodexKeyFile`).
 * Nothing here logs a value.
 */

import { CLOUD_SIGN_INS } from "../../../shared/cloudSignIns";

let taken: Readonly<Record<string, string>> = {};

/** Take the sign-in variables (all but Claude's) out of `env`. Returns their names, never values. */
export function takeCloudSignInEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const next: Record<string, string> = { ...taken };
  const names: string[] = [];
  for (const spec of CLOUD_SIGN_INS) {
    if (spec.id === "claude") continue;
    const value = env[spec.env];
    if (typeof value !== "string" || !value.trim()) continue;
    next[spec.env] = value.trim();
    delete env[spec.env];
    names.push(spec.env);
  }
  taken = next;
  return names;
}

/** What the boot took, for apply's one adoption of the old Codex file. */
export function bootSignInEnv(): Readonly<Record<string, string>> {
  return taken;
}
