/**
 * The person's sign-ins for cloud machines, as the account vault keeps them,
 * and the env a new cloud machine starts with. No terminal and no
 * Electron here, so the desktop and the brain both read it. Claude's sign-in
 * that makes its token is cloudClaudeSignIn.ts.
 *
 * One vault item per sign-in, so two windows saving different keys never
 * overwrite each other. A value is never logged or returned to a window.
 */

import {
  CLOUD_SIGN_INS,
  type CloudSignInId,
  type CloudSignInStatus,
} from "../../../shared/cloudSignIns";
import type { CloudVault } from "./cloudAccess";

type Logger = { warn?(event: string, meta?: Record<string, unknown>): void } | null | undefined;

/** The account vault, one item per sign-in key; null when signed out of ADE. */
export type CloudSignInVaults = (vaultKey: string) => CloudVault | null;

/** Claude's item keeps the name it had when it was the only one. */
export function cloudSignInVaultKey(id: CloudSignInId): string {
  return id === "claude" ? "cloud-claude-token" : `cloud-key-${id}`;
}

/** Claude Code's subscription token: `sk-ant-oat01-…`. */
export const CLAUDE_TOKEN_PATTERN = /\bsk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/;
/**
 * The same, only once something follows it: output arrives in chunks, and a
 * token cut at a chunk's end must not be saved half. Claude Code ends the
 * line after it; at exit the plain pattern reads a token printed last.
 */
export const COMPLETE_CLAUDE_TOKEN_PATTERN = /\bsk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/;

type StoredSignIn = { v: 1; token: string; savedAt: number };

function parseStored(id: CloudSignInId, raw: string | null): StoredSignIn | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSignIn>;
    if (parsed?.v !== 1 || typeof parsed.token !== "string" || !parsed.token) return null;
    if (id === "claude" && !CLAUDE_TOKEN_PATTERN.test(parsed.token)) return null;
    return { v: 1, token: parsed.token, savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0 };
  } catch {
    return null;
  }
}

/**
 * A pasted key, trimmed, or why it can't be one. Formats change, so only what
 * can never be a key is refused: nothing, spaces inside, or a whole file.
 */
export function cleanCloudCloudKey(raw: unknown): { ok: true; key: string } | { ok: false; message: string } {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return { ok: false, message: "Paste the key first." };
  if (/\s/.test(key)) return { ok: false, message: "That has spaces in it. Paste only the key." };
  if (key.length < 8 || key.length > 4096) return { ok: false, message: "That doesn't look like a key. Paste only the key." };
  return { ok: true, key };
}

/** Keeps one sign-in. False when the account refused it. */
export async function saveCloudSignIn(
  vaults: CloudSignInVaults,
  id: CloudSignInId,
  token: string,
  logger?: Logger,
): Promise<boolean> {
  const vault = vaults(cloudSignInVaultKey(id));
  if (!vault) return false;
  const stored: StoredSignIn = { v: 1, token, savedAt: Date.now() };
  const ok = await vault.set(JSON.stringify(stored)).catch(() => {
    logger?.warn?.("cloud.cloud_sign_in_save_threw", { id, reason: "vault_write_threw" });
    return false;
  });
  if (!ok) logger?.warn?.("cloud.cloud_sign_in_save_failed", { id });
  return ok;
}

/** Forgets one sign-in. False when the account refused. */
export async function removeCloudSignIn(
  vaults: CloudSignInVaults,
  id: CloudSignInId,
  logger?: Logger,
): Promise<boolean> {
  const vault = vaults(cloudSignInVaultKey(id));
  if (!vault) return false;
  return await vault.remove().catch(() => {
    logger?.warn?.("cloud.cloud_sign_in_remove_threw", { id, reason: "vault_remove_threw" });
    return false;
  });
}

type ReadResult = { id: CloudSignInId; stored: StoredSignIn | null; readable: boolean };

async function readAll(vaults: CloudSignInVaults | null, logger: Logger): Promise<ReadResult[] | null> {
  // Signed out of ADE: there is no account to read.
  if (!vaults?.(cloudSignInVaultKey("claude"))) return null;
  return await Promise.all(CLOUD_SIGN_INS.map(async ({ id }): Promise<ReadResult> => {
    const vault = vaults(cloudSignInVaultKey(id));
    if (!vault) return { id, stored: null, readable: false };
    try {
      const read = await vault.get();
      return read.ok ? { id, stored: parseStored(id, read.value), readable: true } : { id, stored: null, readable: false };
    } catch {
      // The vault's own error can name the value's item; a fixed reason only.
      logger?.warn?.("cloud.cloud_sign_in_read_failed", { id, reason: "vault_read_threw" });
      return { id, stored: null, readable: false };
    }
  }));
}

/** Which sign-ins are kept, never their values. */
export async function readCloudSignIns(
  vaults: CloudSignInVaults | null,
  logger?: Logger,
): Promise<Pick<CloudSignInStatus, "saved" | "unknown">> {
  const results = await readAll(vaults, logger);
  return {
    saved: CLOUD_SIGN_INS.map(({ id }) => {
      const stored = results?.find((result) => result.id === id)?.stored ?? null;
      return { id, saved: stored != null, savedAt: stored?.savedAt ?? null };
    }),
    unknown: results != null && results.some((result) => !result.readable),
  };
}

/**
 * The env a new cloud machine starts with: every kept sign-in, in the
 * variable its provider's CLI reads. One that can't be read is left out,
 * never an error: the machine is still made, and that provider asks to sign
 * in on it like before. Codex's key also becomes its auth file on the
 * machine (cloudSignInBoot.ts): Codex's app server ignores the env.
 */
export async function cloudMachineEnv(vaults: CloudSignInVaults | null, logger?: Logger): Promise<Record<string, string>> {
  const results = await readAll(vaults, logger);
  const env: Record<string, string> = {};
  for (const spec of CLOUD_SIGN_INS) {
    const stored = results?.find((result) => result.id === spec.id)?.stored;
    if (stored) env[spec.env] = stored.token;
  }
  return env;
}
