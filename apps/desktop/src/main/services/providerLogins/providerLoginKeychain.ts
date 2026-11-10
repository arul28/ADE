/**
 * The one Keychain read of the sign-in sync (P5 §3.7): Antigravity's Google
 * sign-in on a Mac, when the person presses Allow. Nothing here runs in the
 * background, on a timer or in a pass.
 *
 * `security find-generic-password -s gemini -a <account> -w` prints the
 * item's secret. ADE did not make the item (the Antigravity agent did), so
 * macOS asks the person first. One process per Allow. The value goes back to
 * the caller as bytes and is never logged; on a failure only a reason code
 * comes back, never the command's output.
 */

import { execFile } from "node:child_process";

/** The agent's keychain item (`antigravityAuth.ts` KEYCHAIN_SERVICE / KEYCHAIN_ACCOUNT). */
export const ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini";
export const ANTIGRAVITY_KEYCHAIN_ACCOUNTS = {
  personal: "antigravity-acp",
  business: "antigravity-acp-business",
} as const;

export type AntigravityKeychainSlot = keyof typeof ANTIGRAVITY_KEYCHAIN_ACCOUNTS;

/** The real command. The scratch checks pass a fake one; they never run this. */
export const SECURITY_COMMAND = "/usr/bin/security";
/** How long the person has to answer the macOS prompt. */
export const KEYCHAIN_READ_TIMEOUT_MS = 120_000;

export type KeychainReadResult =
  | { ok: true; data: Buffer }
  | { ok: false; reason: "not_found" | "denied" | "timeout" | "failed" };

/** `security`'s exit code for "the item is not there" (errSecItemNotFound). */
const SECURITY_NOT_FOUND = 44;
/** Exit codes `security` gives when the person pressed Deny or closed the prompt. */
const SECURITY_DENIED = new Set([36, 51, 128]);

/**
 * What the agent stored, as the login file holds it. `-w` prints the secret
 * as text, or as hex when it has bytes that are not printable. A Go keyring
 * writer may also prefix it (`go-keyring-base64:`, `go-keyring-encoded:`).
 * Null when the result is not a JSON object.
 */
export function decodeKeychainSecret(raw: Buffer): Buffer | null {
  const text = raw.toString("utf8").replace(/\r?\n$/, "");
  const candidates: Buffer[] = [Buffer.from(text, "utf8")];
  if (text.startsWith("go-keyring-base64:")) candidates.unshift(Buffer.from(text.slice("go-keyring-base64:".length), "base64"));
  if (text.startsWith("go-keyring-encoded:")) candidates.unshift(Buffer.from(text.slice("go-keyring-encoded:".length), "hex"));
  if (/^(?:[0-9a-fA-F]{2})+$/.test(text)) candidates.push(Buffer.from(text, "hex"));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.toString("utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return candidate;
    } catch {
      // The next form.
    }
  }
  return null;
}

/** One `security` read. macOS shows its prompt; the call waits for the person's answer. */
export function readKeychainSecret(args: {
  account: string;
  service?: string;
  command?: string;
  timeoutMs?: number;
}): Promise<KeychainReadResult> {
  const service = args.service ?? ANTIGRAVITY_KEYCHAIN_SERVICE;
  return new Promise((resolve) => {
    execFile(
      args.command ?? SECURITY_COMMAND,
      ["find-generic-password", "-s", service, "-a", args.account, "-w"],
      { timeout: args.timeoutMs ?? KEYCHAIN_READ_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: "buffer", windowsHide: true },
      (error, stdout) => {
        if (!error) {
          resolve({ ok: true, data: stdout });
          return;
        }
        // execFile puts the exit code in `code` (a number); a spawn failure puts a string there.
        const failure = error as { code?: unknown; killed?: boolean; signal?: string | null };
        const exitCode = typeof failure.code === "number" ? failure.code : null;
        if (failure.killed || failure.signal === "SIGTERM") resolve({ ok: false, reason: "timeout" });
        else if (exitCode === SECURITY_NOT_FOUND) resolve({ ok: false, reason: "not_found" });
        else if (exitCode !== null && SECURITY_DENIED.has(exitCode)) resolve({ ok: false, reason: "denied" });
        else resolve({ ok: false, reason: "failed" });
      },
    );
  });
}
