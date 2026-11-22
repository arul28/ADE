/**
 * The one OS keyring read of the sign-in sync (P5 §3.7): Antigravity's Google
 * sign-in, kept by the agy CLI in this computer's keyring, when the person
 * presses Allow. Nothing here runs in the background, on a timer or in a pass.
 *
 * The agy CLI stores it with go-keyring: service `gemini`, user `antigravity`.
 * One process per Allow, always async (never a sync spawn on the main thread):
 *
 * - macOS: `security find-generic-password -s gemini -a antigravity -w`. ADE
 *   did not make the item (agy did), so macOS asks the person first.
 * - Windows: Credential Manager, the generic credential `gemini:antigravity`.
 *   Windows PowerShell reads it with `CredReadW` and prints the blob as
 *   base64 (`WINDOWS_CRED_READ_SCRIPT`, on stdin). No prompt.
 * - Linux: `secret-tool lookup service gemini username antigravity`
 *   (libsecret-tools). The keyring may ask to unlock.
 *
 * The value goes back to the caller as bytes and is never logged; on a failure
 * only a reason code comes back, never the command's output.
 */

import { execFile, type ExecFileException } from "node:child_process";
import path from "node:path";

import type { ProviderLoginKeyringStore } from "../../../shared/types/providerLogins";
import { ANTIGRAVITY_KEYCHAIN_SERVICE, ANTIGRAVITY_KEYRING_USER } from "../ai/antigravityAuth";

/** The two Google sign-ins of the agent, as the sign-in sync names its slots. */
export type AntigravityKeychainSlot = "personal" | "business";

/**
 * The keyring user of the agent's item for a slot. agy keeps one item for
 * both Google methods, so both slots name the same user.
 */
export function antigravityKeychainAccount(_slot: AntigravityKeychainSlot): string {
  return ANTIGRAVITY_KEYRING_USER;
}

/** The OS stores ADE can ask on the person's Allow. */
export type KeyringPlatform = "darwin" | "win32" | "linux";

export function isKeyringPlatform(platform: NodeJS.Platform): platform is KeyringPlatform {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}

/** The store's name in a sentence for the person ("this computer's …"). */
export const KEYRING_STORE_NAME: Record<KeyringPlatform, string> = {
  darwin: "the Keychain",
  win32: "Credential Manager",
  linux: "the keyring",
};

/** The store's id in the status (`ProviderLoginProviderStatus.keychain.store`). */
export const KEYRING_STORE: Record<KeyringPlatform, ProviderLoginKeyringStore> = {
  darwin: "keychain",
  win32: "credential_manager",
  linux: "keyring",
};

export const SECURITY_COMMAND = "/usr/bin/security";
export const SECRET_TOOL_COMMAND = "secret-tool";
/** How long the person has to answer a macOS or keyring unlock prompt. */
export const KEYCHAIN_READ_TIMEOUT_MS = 120_000;
/** Credential Manager does not prompt; this covers PowerShell starting and compiling its P/Invoke. */
const WINDOWS_READ_TIMEOUT_MS = 30_000;

export type KeychainReadFailure = "not_found" | "denied" | "timeout" | "unavailable" | "failed";

export type KeychainReadResult =
  | { ok: true; data: Buffer }
  | { ok: false; reason: KeychainReadFailure };

/**
 * `security` exits with the low byte of the OSStatus. 44 is -25300
 * (errSecItemNotFound): the item is not there.
 */
const SECURITY_NOT_FOUND = 44;
/**
 * The person said no: 51 is -25293 (errSecAuthFailed), 36 is -25308
 * (errSecInteractionNotAllowed), 128 is -128 (userCanceledErr). The mapping
 * is consistent with the OSStatus values, but it is not checked on a real Mac.
 */
const SECURITY_DENIED = new Set([36, 51, 128]);

/** The script's exit codes (0 is the blob on stdout). */
const WINDOWS_EXIT_NOT_FOUND = 3;
const WINDOWS_EXIT_UNAVAILABLE = 5;

/**
 * Read one generic credential from Credential Manager and print its blob as
 * base64. Each statement is one line: `-Command -` runs stdin line by line,
 * and a statement spread over lines would wait for a blank line. The target
 * is the one `__TARGET__` (single-quoted, quotes doubled).
 *
 * - 0: the blob, base64, on stdout.
 * - 3: no such credential (ERROR_NOT_FOUND, 1168).
 * - 5: no credential store for this logon (ERROR_NO_SUCH_LOGON_SESSION, 1312),
 *   or the P/Invoke could not be compiled (constrained language mode).
 * - 4: any other failure.
 */
export const WINDOWS_CRED_READ_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$source = 'using System; using System.Runtime.InteropServices; public static class AdeCredRead { [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct CREDENTIAL { public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment; public int LastWrittenLow; public int LastWrittenHigh; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName; } [DllImport(\"advapi32.dll\", EntryPoint = \"CredReadW\", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CredRead(string target, int type, int flags, out IntPtr credential); [DllImport(\"advapi32.dll\")] private static extern void CredFree(IntPtr buffer); public static int Read(string target, out byte[] blob) { blob = null; IntPtr ptr; if (!CredRead(target, 1, 0, out ptr)) { int code = Marshal.GetLastWin32Error(); return code == 0 ? -1 : code; } try { CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL)); blob = new byte[cred.CredentialBlobSize]; if (cred.CredentialBlobSize > 0) Marshal.Copy(cred.CredentialBlob, blob, 0, cred.CredentialBlobSize); return 0; } finally { CredFree(ptr); } } }'",
  "try { Add-Type -TypeDefinition $source -Language CSharp } catch { exit 5 }",
  "$blob = $null",
  "try { $code = [AdeCredRead]::Read('__TARGET__', [ref]$blob) } catch { exit 4 }",
  "if ($code -eq 0) { [Console]::Out.Write([Convert]::ToBase64String($blob)); exit 0 }",
  "if ($code -eq 1168) { exit 3 }",
  "if ($code -eq 1312) { exit 5 }",
  "exit 4",
  "",
].join("\n");

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

type ExecFailure = ExecFileException & { code?: unknown; killed?: boolean; signal?: NodeJS.Signals | null };

function exitCodeOf(error: ExecFailure): number | null {
  // execFile puts the exit code in `code` (a number); a spawn failure puts a string there.
  return typeof error.code === "number" ? error.code : null;
}

function timedOut(error: ExecFailure): boolean {
  return Boolean(error.killed) || error.signal === "SIGTERM";
}

function spawnMissing(error: ExecFailure): boolean {
  return error.code === "ENOENT" || error.code === "EACCES";
}

function readMac(service: string, account: string): Promise<KeychainReadResult> {
  return new Promise((resolve) => {
    execFile(
      SECURITY_COMMAND,
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { timeout: KEYCHAIN_READ_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: "buffer", windowsHide: true },
      (error, stdout) => {
        if (!error) return resolve({ ok: true, data: stdout });
        const failure = error as ExecFailure;
        const exitCode = exitCodeOf(failure);
        if (timedOut(failure)) resolve({ ok: false, reason: "timeout" });
        else if (spawnMissing(failure)) resolve({ ok: false, reason: "unavailable" });
        else if (exitCode === SECURITY_NOT_FOUND) resolve({ ok: false, reason: "not_found" });
        else if (exitCode !== null && SECURITY_DENIED.has(exitCode)) resolve({ ok: false, reason: "denied" });
        else resolve({ ok: false, reason: "failed" });
      },
    );
  });
}

function windowsPowerShell(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim() || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function readWindows(target: string, env: NodeJS.ProcessEnv): Promise<KeychainReadResult> {
  const script = WINDOWS_CRED_READ_SCRIPT.replace("__TARGET__", target.replace(/'/g, "''"));
  return new Promise((resolve) => {
    const child = execFile(
      windowsPowerShell(env),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
      { timeout: WINDOWS_READ_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        if (!error) {
          const encoded = String(stdout ?? "").trim();
          // Base64 only: anything else on stdout is not the blob.
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return resolve({ ok: false, reason: "failed" });
          return resolve({ ok: true, data: Buffer.from(encoded, "base64") });
        }
        const failure = error as ExecFailure;
        const exitCode = exitCodeOf(failure);
        if (timedOut(failure)) resolve({ ok: false, reason: "timeout" });
        else if (spawnMissing(failure)) resolve({ ok: false, reason: "unavailable" });
        else if (exitCode === WINDOWS_EXIT_NOT_FOUND) resolve({ ok: false, reason: "not_found" });
        else if (exitCode === WINDOWS_EXIT_UNAVAILABLE) resolve({ ok: false, reason: "unavailable" });
        else resolve({ ok: false, reason: "failed" });
      },
    );
    // The script goes on stdin, not on the command line.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(script, "utf8");
  });
}

function readLinux(service: string, account: string): Promise<KeychainReadResult> {
  return new Promise((resolve) => {
    execFile(
      SECRET_TOOL_COMMAND,
      ["lookup", "service", service, "username", account],
      { timeout: KEYCHAIN_READ_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: "buffer", windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          // `secret-tool lookup` exits 0 with nothing when no item matches on some versions.
          return resolve(stdout.length ? { ok: true, data: stdout } : { ok: false, reason: "not_found" });
        }
        const failure = error as ExecFailure;
        const exitCode = exitCodeOf(failure);
        if (timedOut(failure)) resolve({ ok: false, reason: "timeout" });
        else if (spawnMissing(failure)) resolve({ ok: false, reason: "unavailable" });
        // No match: exit 1 and nothing on stderr. An error (no Secret Service, a refused unlock) says something there.
        else if (exitCode === 1 && !stderr?.length) resolve({ ok: false, reason: "not_found" });
        else resolve({ ok: false, reason: "failed" });
      },
    );
  });
}

/**
 * One read of the agent's keyring item on this OS. The call waits for the
 * person's answer to any prompt. Off macOS, Windows and Linux: "unavailable".
 */
export function readKeychainSecret(args: {
  account: string;
  service?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): Promise<KeychainReadResult> {
  const service = args.service ?? ANTIGRAVITY_KEYCHAIN_SERVICE;
  const platform = args.platform ?? process.platform;
  if (platform === "darwin") return readMac(service, args.account);
  // go-keyring's Windows target name: `<service>:<user>`.
  if (platform === "win32") return readWindows(`${service}:${args.account}`, args.env ?? process.env);
  if (platform === "linux") return readLinux(service, args.account);
  return Promise.resolve({ ok: false, reason: "unavailable" });
}
