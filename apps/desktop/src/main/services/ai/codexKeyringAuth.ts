import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileOffThread, offThreadSpawnEnabled } from "../shared/offThreadSpawn";
import { windowsPowerShellCommand } from "../shared/processExecution";

/**
 * Codex's login when it keeps it in the OS keyring instead of `auth.json`
 * (`cli_auth_credentials_store = "keyring"`, or `"auto"` with a keyring
 * present; the default is `"file"`).
 *
 * Mirrors codex-rs `login/src/auth/storage.rs` (rust-v0.164.0): service
 * `Codex Auth`, account `cli|` + the first 16 hex digits of the SHA-256 of the
 * canonical CODEX_HOME path, value the same JSON `auth.json` holds. The
 * `keyring` crate files it as a Secret Service item with `service`/`username`
 * attributes on Linux and a Windows generic credential named
 * `<account>.<service>` whose blob is UTF-16LE; neither asks the user.
 *
 * macOS is deliberately not read. Codex creates its Keychain item so that only
 * Codex may read it (checked with Codex 0.164.0: the account matches, and any
 * other reader makes macOS ask the user to allow access), and its app-server
 * has no call that returns the token. There, {@link codexLoginInKeyring} lets a
 * launch say why the login cannot be lent and how to change it.
 *
 * Read-only, and only the raw JSON: the caller parses it like `auth.json`.
 * The read is a process (`secret-tool`, or the trusted PowerShell), spawned off
 * the event loop: it runs on a lend pass inside the brain.
 */
const SERVICE = "Codex Auth";
const READ_TIMEOUT_MS = 5_000;
/**
 * Background callers (the usage poller) read on a cadence, and a keyring read
 * is a process (PowerShell on Windows). A hit or a miss is remembered for a
 * minute, so a sign-in made after a miss is seen on the next pass; a read that
 * failed (timed out, no `secret-tool`, a locked keyring) only for 15 seconds.
 * A caller that just had Codex renew its login reads fresh.
 */
const MISS_TTL_MS = 60_000;
const HIT_TTL_MS = 60_000;
const FAILED_TTL_MS = 15_000;
const cache = new Map<string, { value: string | null; until: number }>();
const inFlight = new Map<string, Promise<string | null>>();

export function codexKeyringAccount(codexHome: string): string {
  let canonical = codexHome;
  try {
    canonical = fs.realpathSync.native(codexHome);
  } catch {
    // Codex hashes the path as given when it cannot canonicalize it.
  }
  return `cli|${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

const WINDOWS_CRED_READ = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class AdeCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize;
    public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p; if (!CredRead(target, 1, 0, out p)) return null;
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); }
    finally { CredFree(p); } }
}
'@
$value = [AdeCred]::Read($env:ADE_CODEX_CRED_TARGET)
if ($null -ne $value) { [Console]::Out.Write($value) }
`;

/**
 * Whether this CODEX_HOME's Codex keeps its login in the OS keyring rather
 * than `auth.json` (`cli_auth_credentials_store = "keyring"` or `"auto"`).
 */
export function codexLoginInKeyring(codexHome: string): boolean {
  if (fs.existsSync(path.join(codexHome, "auth.json"))) return false;
  try {
    const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    return /^\s*cli_auth_credentials_store\s*=\s*"(keyring|auto)"/m.test(config);
  } catch {
    return false;
  }
}

/** The keyring copy of Codex's `auth.json` for this CODEX_HOME, or null (always null on macOS). */
export async function readCodexKeyringAuth(
  codexHome: string,
  options: { platform?: NodeJS.Platform; fresh?: boolean } = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "win32") return null;
  const account = codexKeyringAccount(codexHome);
  const cached = cache.get(account);
  if (!options.fresh && cached && cached.until > Date.now()) return cached.value;
  const pending = inFlight.get(account);
  if (pending) return pending;
  const read = readFromKeyring(account, platform)
    .then(({ value, failed }) => {
      cache.set(account, { value, until: Date.now() + (value ? HIT_TTL_MS : failed ? FAILED_TTL_MS : MISS_TTL_MS) });
      return value;
    })
    .finally(() => inFlight.delete(account));
  inFlight.set(account, read);
  return read;
}

async function readFromKeyring(account: string, platform: NodeJS.Platform): Promise<{ value: string | null; failed: boolean }> {
  const stdout = platform === "linux"
    ? await capture("secret-tool", ["lookup", "service", SERVICE, "username", account], READ_TIMEOUT_MS)
    : await capture(
      windowsPowerShellCommand(platform),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CRED_READ],
      READ_TIMEOUT_MS * 3,
      { ADE_CODEX_CRED_TARGET: `${account}.${SERVICE}` },
    );
  if (stdout === null) return { value: null, failed: true };
  const text = stdout.trim();
  return { value: text.startsWith("{") ? text : null, failed: false };
}

/** A short command's stdout, or null when it failed; off the event loop where ADE does that (Windows). */
async function capture(
  command: string,
  args: string[],
  timeoutMs: number,
  envPatch?: Record<string, string>,
): Promise<string | null> {
  if (offThreadSpawnEnabled()) {
    const result = await execFileOffThread(command, args, { timeoutMs, ...(envPatch ? { envPatch } : {}) });
    return result.error || result.exitCode !== 0 ? null : result.stdout;
  }
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8", ...(envPatch ? { env: { ...process.env, ...envPatch } } : {}) },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}
