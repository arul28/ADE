/**
 * The person's Claude token for cloud machines, as the account vault keeps
 * it, and the env a new Agent 37 machine starts with. No terminal and no
 * Electron here, so the brain reads it too. The sign-in that makes the token
 * is agent37ClaudeToken.ts.
 */

import type { Agent37Vault } from "./agent37Credential";

export const AGENT37_CLAUDE_TOKEN_VAULT_KEY = "agent37-claude-token";

/** Claude Code's subscription token: `sk-ant-oat01-…`. */
export const TOKEN_PATTERN = /\bsk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/;
/**
 * The same, only once something follows it: output arrives in chunks, and a
 * token cut at a chunk's end must not be saved half. Claude Code ends the
 * line after it; at exit the plain pattern reads a token printed last.
 */
export const COMPLETE_TOKEN_PATTERN = /\bsk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/;

export type StoredToken = { v: 1; token: string; savedAt: number };

export function parseStored(raw: string | null): StoredToken | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredToken>;
    if (parsed?.v !== 1 || typeof parsed.token !== "string" || !TOKEN_PATTERN.test(parsed.token)) return null;
    return { v: 1, token: parsed.token, savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0 };
  } catch {
    return null;
  }
}

/**
 * The env a new Agent 37 machine starts with: the person's Claude token, when
 * one is kept. An unreadable account gives nothing, never an error: the
 * machine is still made, and Claude asks to sign in on it like before.
 */
export async function agent37MachineEnv(vault: Agent37Vault | null): Promise<Record<string, string>> {
  if (!vault) return {};
  try {
    const read = await vault.get();
    const stored = read.ok ? parseStored(read.value) : null;
    return stored ? { CLAUDE_CODE_OAUTH_TOKEN: stored.token } : {};
  } catch {
    return {};
  }
}
