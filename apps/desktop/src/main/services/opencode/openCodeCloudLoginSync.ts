import fs from "node:fs";
import path from "node:path";
import { resolveAdeOpenCodeRuntimeRoot } from "../../../shared/opencodeDataHome";
import { writeFileAtomic } from "../state/durableFile";
import type { OpenCodeAuthDeps } from "./openCodeAuthService";
import type { OpenCodeCredentialSummary } from "./openCodeCredentials";

/**
 * The ADE account's list of OpenCode cloud logins, and this machine's record
 * of which ones it has set up from it. See `openCodeAccounts.ts` for the
 * model; this half has no server code, so the auth service can use it too.
 */

/** Account setting (scope `all`) holding the cloud logins every machine sets up. */
export const OPENCODE_CLOUD_LOGINS_SETTING_KEY = "opencodeCloudLogins";
const ACCOUNT_SCOPE_ALL = "all";
/** Cloud-login keys this machine last saw in the account, so one removed elsewhere goes here too. */
const APPLIED_CLOUD_LOGINS_FILE = "cloud-logins-applied.json";
export const MAX_CLOUD_LOGIN_LABEL_LENGTH = 80;

export type SyncedCloudLogin = {
  providerId: string;
  methodId: string;
  details: Record<string, string>;
  label?: string;
};

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record._tag === "string") return record._tag;
  }
  return error instanceof Error ? error.message : String(error);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.trim()) out[key] = entry.trim();
  }
  return out;
}

/** One login's identity: provider, method and the answers, in a fixed key order. */
export function cloudLoginKey(login: { providerId: string; methodId: string; details: Record<string, string> }): string {
  const details = Object.keys(login.details)
    .sort()
    .map((key) => [key, login.details[key]]);
  return JSON.stringify([login.providerId, login.methodId, details]);
}

function normalizeSyncedCloudLogins(value: unknown): SyncedCloudLogin[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SyncedCloudLogin[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
    const methodId = typeof record.methodId === "string" ? record.methodId.trim() : "";
    if (!providerId || !methodId) continue;
    const login: SyncedCloudLogin = { providerId, methodId, details: stringRecord(record.details) };
    const label = typeof record.label === "string" ? record.label.trim().slice(0, MAX_CLOUD_LOGIN_LABEL_LENGTH) : "";
    if (label) login.label = label;
    const key = cloudLoginKey(login);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(login);
  }
  return out;
}

/**
 * The account's cloud logins, or null when this process cannot both read and
 * write them (no brain account store, or signed out of ADE). Null never means
 * "none": a caller that removed local logins on a null would wipe them. Reading
 * without being able to write would also let a login signed out here come back
 * from the account at the next sync, so a read-only cache is not used.
 */
export function readSyncedCloudLogins(deps: OpenCodeAuthDeps): SyncedCloudLogin[] | null {
  if (!deps.accountSettings?.isSignedIn()) return null;
  return normalizeSyncedCloudLogins(deps.accountSettings.get(ACCOUNT_SCOPE_ALL, OPENCODE_CLOUD_LOGINS_SETTING_KEY));
}

/** Save the list to the account. False when this process has no account store or no account. */
export function writeSyncedCloudLogins(deps: OpenCodeAuthDeps, logins: SyncedCloudLogin[]): boolean {
  if (!deps.accountSettings?.isSignedIn()) return false;
  try {
    return deps.accountSettings.set(ACCOUNT_SCOPE_ALL, OPENCODE_CLOUD_LOGINS_SETTING_KEY, logins);
  } catch (err) {
    deps.logger.warn("opencode.cloud_logins_save_failed", { error: errorMessage(err) });
    return false;
  }
}

function appliedFilePath(): string {
  return path.join(resolveAdeOpenCodeRuntimeRoot(), APPLIED_CLOUD_LOGINS_FILE);
}

export function readAppliedKeys(): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(appliedFilePath(), "utf8")) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeAppliedKeys(keys: Iterable<string>, deps: OpenCodeAuthDeps): void {
  try {
    fs.mkdirSync(path.dirname(appliedFilePath()), { recursive: true });
    writeFileAtomic(appliedFilePath(), `${JSON.stringify([...keys].sort())}\n`);
  } catch (err) {
    deps.logger.warn("opencode.cloud_logins_applied_write_failed", { error: errorMessage(err) });
  }
}

export function credentialCloudKey(credential: OpenCodeCredentialSummary): string | null {
  if (credential.type !== "external" || !credential.methodId) return null;
  return cloudLoginKey({
    providerId: credential.integrationId,
    methodId: credential.methodId,
    details: credential.externalDetails,
  });
}

/**
 * Drop one provider's cloud logins from the account, when the provider is
 * disconnected here; otherwise the next sync would set them up again.
 */
export function forgetSyncedCloudLoginsFor(
  deps: OpenCodeAuthDeps,
  providerId: string,
): { ok: false } | { ok: true; undo: () => boolean } {
  const synced = readSyncedCloudLogins(deps);
  if (!synced?.some((login) => login.providerId === providerId)) return { ok: true, undo: () => true };
  const remaining = synced.filter((login) => login.providerId !== providerId);
  if (!writeSyncedCloudLogins(deps, remaining)) return { ok: false };
  writeAppliedKeys(remaining.map(cloudLoginKey), deps);
  return {
    ok: true,
    // Puts the list back as it was: names and answers only, never a secret.
    undo: () => {
      if (!writeSyncedCloudLogins(deps, synced)) {
        deps.logger.warn("opencode.cloud_logins_restore_failed", { providerId });
        return false;
      }
      writeAppliedKeys(synced.map(cloudLoginKey), deps);
      return true;
    },
  };
}
