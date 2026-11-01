import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
 */
const SERVICE = "Codex Auth";
const READ_TIMEOUT_MS = 5_000;
/**
 * Background callers (the usage poller) read on a cadence, and a keyring read
 * is a process (PowerShell on Windows). A miss is remembered for 10 minutes and
 * a hit for one; a caller that just had Codex renew its login reads fresh.
 */
const MISS_TTL_MS = 10 * 60_000;
const HIT_TTL_MS = 60_000;
const cache = new Map<string, { value: string | null; until: number }>();

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
export function readCodexKeyringAuth(
  codexHome: string,
  options: { platform?: NodeJS.Platform; fresh?: boolean } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const account = codexKeyringAccount(codexHome);
  const cached = cache.get(account);
  if (!options.fresh && cached && cached.until > Date.now()) return cached.value;
  const value = readFromKeyring(account, platform);
  cache.set(account, { value, until: Date.now() + (value ? HIT_TTL_MS : MISS_TTL_MS) });
  return value;
}

function readFromKeyring(account: string, platform: NodeJS.Platform): string | null {
  let result: ReturnType<typeof spawnSync>;
  if (platform === "linux") {
    result = spawnSync("secret-tool", ["lookup", "service", SERVICE, "username", account], {
      encoding: "utf8",
      timeout: READ_TIMEOUT_MS,
    });
  } else if (platform === "win32") {
    result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CRED_READ], {
      encoding: "utf8",
      timeout: READ_TIMEOUT_MS * 3,
      windowsHide: true,
      env: { ...process.env, ADE_CODEX_CRED_TARGET: `${account}.${SERVICE}` },
    });
  } else {
    return null;
  }
  if (result.error || result.status !== 0) return null;
  const text = String(result.stdout ?? "").trim();
  return text.startsWith("{") ? text : null;
}
