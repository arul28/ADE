/**
 * Where a Chromium fork's cookie-encryption key comes from, per OS.
 *
 * - **macOS** — a random secret in the login keychain under
 *   `"<Browser> Safe Storage"`, stretched with PBKDF2-HMAC-SHA1 (salt
 *   `saltysalt`, 1003 iterations, 16 bytes) into an AES-128-CBC key.
 * - **Linux** — the same stretch with a single iteration, over either the
 *   keyring secret (`v11`) or Chromium's documented `"peanuts"` fallback
 *   (`v10`).
 * - **Windows** — a random AES-256 key in `Local State`, wrapped with DPAPI.
 *   Since Chrome 127 mainstream forks wrap it with App-Bound Encryption
 *   instead, which is bound to the browser's own identity: no other process can
 *   unwrap it, and the presence of `app_bound_encrypted_key` is a hard stop
 *   rather than something to retry.
 *
 * @module loginImport/chromiumKeys
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { pbkdf2Sync } from "node:crypto";
import {
  resolveTrustedWindowsTool,
  TrustedWindowsToolError,
} from "../../../../../../ade-cli/src/lib/trustedWindowsTools";

const KEY_SALT = "saltysalt";
const KEY_LENGTH = 16;
/** macOS stretches the keychain secret; Linux uses a single iteration. */
const MAC_KEY_ITERATIONS = 1003;
const LINUX_KEY_ITERATIONS = 1;
/** Chromium's documented fallback passphrase when no Linux keyring answers. */
const LINUX_FALLBACK_PASSPHRASE = "peanuts";
const WINDOWS_KEY_LENGTH = 32;
const DPAPI_PREFIX = Buffer.from("DPAPI");
/**
 * PowerShell cold start plus a Defender on-access scan is the documented worst
 * case (`windows-quirks.md` §7). Without a ceiling a wedged PowerShell hangs the
 * import forever; this runs in a utility process, so the only cost of waiting is
 * the import itself.
 */
const WINDOWS_DPAPI_TIMEOUT_MS = 30_000;

export type ChromiumKeyFailureReason = "key_unavailable" | "unsupported" | "read_failed";

export class ChromiumKeyError extends Error {
  constructor(
    readonly reason: ChromiumKeyFailureReason,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ChromiumKeyError";
    this.cause = cause;
  }
}

/**
 * Keys to try, indexed by the record prefix they decrypt. A single database can
 * hold records written under more than one scheme, so a missing entry means
 * those records are skipped rather than the whole import failing.
 */
export type ChromiumKeyMaterial = {
  /** AES-128-CBC — macOS keychain secret, or the Linux keyring-free fallback. */
  readonly cbcV10?: Buffer;
  /** AES-128-CBC — Linux keyring-derived. */
  readonly cbcV11?: Buffer;
  /**
   * AES-128-CBC from an empty passphrase. Some Linux clients wrote records with
   * it (crbug.com/1195256), so Chromium — and this import — retry with it after
   * a record's own key fails.
   */
  readonly cbcEmpty?: Buffer;
  /** AES-256-GCM key used by pre-App-Bound Chromium on Windows. */
  readonly gcmV10?: Buffer;
};

/** PBKDF2-HMAC-SHA1 over Chromium's fixed salt. Exported for tests. */
export function deriveChromiumKey(passphrase: string, iterations: number): Buffer {
  return pbkdf2Sync(passphrase, KEY_SALT, iterations, KEY_LENGTH, "sha1");
}

export type ChromiumKeyDeps = {
  /**
   * Reads a macOS keychain generic password. Injected so tests never touch the
   * real keychain and so a caller can supply a different reader.
   */
  readMacKeychainSecret?: (service: string, account: string) => string | null;
  /** Reads a Linux keyring secret for a libsecret application name. */
  readLinuxSecret?: (application: string) => string | null;
  /** Unwraps a Windows DPAPI blob for the current user. */
  unwrapWindowsKey?: (wrapped: Buffer) => Buffer;
  readFile?: (filePath: string) => string;
};

/**
 * Reads the OSCrypt secret from the macOS login keychain.
 *
 * ADE shells out to `/usr/bin/security` because the packaged app carries no
 * native keychain binding and this unit is not allowed to add one — the same
 * route `apiKeyStore` already uses. The tradeoff is real and worth naming: the
 * consent prompt macOS shows is attributed to `security`, not to ADE, so
 * "Always Allow" grants trust to a tool any process can invoke. That is why the
 * import stays human-only and per-run. Replacing this with an in-process
 * Keychain call is the follow-up (see the open items in the docs).
 *
 * Deliberately untimed: macOS answers with a modal, and a timeout racing the
 * human means the prompt can be approved while nothing is left listening.
 */
function readMacKeychainSecretViaSecurity(service: string, account: string): string | null {
  try {
    const stdout = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const value = stdout.replace(/(?:\r?\n)+$/, "");
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Reads the Chromium keyring secret through `secret-tool`.
 *
 * Chromium stores it under the `chrome_libsecret_os_crypt_password_v2` schema
 * keyed by an `application` attribute. `secret-tool` ships with libsecret and is
 * the only libsecret client ADE can reach without adding a native dependency;
 * when it is absent the caller falls back to the `v10` `"peanuts"` key, which is
 * what Chromium itself does on a keyring-less system.
 */
function readLinuxSecretViaSecretTool(application: string): string | null {
  const attempts: string[][] = [
    ["lookup", "xdg:schema", "chrome_libsecret_os_crypt_password_v2", "application", application],
    ["lookup", "application", application],
  ];
  for (const args of attempts) {
    const result = spawnSync("secret-tool", args, { encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) continue;
    const value = (result.stdout ?? "").replace(/(?:\r?\n)+$/, "");
    if (value.length > 0) return value;
  }
  return null;
}

const WINDOWS_DPAPI_SCRIPT =
  "Add-Type -AssemblyName System.Security;" +
  "$value=[Console]::In.ReadToEnd();" +
  "$encrypted=[Convert]::FromBase64String($value);" +
  "$plain=[Security.Cryptography.ProtectedData]::Unprotect(" +
  "$encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);" +
  "[Console]::Out.Write([Convert]::ToBase64String($plain))";

/**
 * Unwraps the Windows key with the current user's DPAPI identity.
 *
 * The blob goes in on **stdin**, never argv: a command line is visible to every
 * process on the machine through the process table, and this one carries key
 * material.
 */
function unwrapWindowsDpapiKey(wrapped: Buffer): Buffer {
  // Never `SystemRoot`/`WINDIR`/PATH: all three are caller-controlled, and this
  // is the one process on the machine that gets DPAPI key material on its
  // stdin. `resolveTrustedWindowsTool` goes through the kernel's GLOBALROOT
  // alias and canonical-path check instead.
  let powershell: string;
  try {
    powershell = resolveTrustedWindowsTool("powershell");
  } catch (cause) {
    throw new ChromiumKeyError(
      "key_unavailable",
      cause instanceof TrustedWindowsToolError
        ? "Windows would not hand ADE a trusted PowerShell to unwrap the browser key."
        : "Windows could not unwrap the browser key.",
      cause,
    );
  }
  const result = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_DPAPI_SCRIPT],
    {
      input: wrapped.toString("base64"),
      encoding: "utf8",
      windowsHide: true,
      timeout: WINDOWS_DPAPI_TIMEOUT_MS,
    },
  );
  if (result.error || result.status !== 0) {
    throw new ChromiumKeyError("key_unavailable", "Windows could not unwrap the browser key.", result.error);
  }
  const plain = Buffer.from((result.stdout ?? "").trim(), "base64");
  if (plain.length !== WINDOWS_KEY_LENGTH) {
    throw new ChromiumKeyError("read_failed", "The unwrapped Windows browser key was the wrong length.");
  }
  return plain;
}

type WindowsLocalState = {
  os_crypt?: {
    encrypted_key?: unknown;
    app_bound_encrypted_key?: unknown;
  };
};

/**
 * Pulls the DPAPI-wrapped key out of `Local State`, refusing app-bound stores.
 * Exported so the capability matrix and the tests can exercise it without a
 * PowerShell round trip.
 */
export function decodeWindowsWrappedKey(contents: string): Buffer {
  let state: WindowsLocalState;
  try {
    state = JSON.parse(contents) as WindowsLocalState;
  } catch (cause) {
    throw new ChromiumKeyError("read_failed", "Local State is not valid JSON.", cause);
  }
  const osCrypt = state.os_crypt;
  if (!osCrypt || typeof osCrypt !== "object") {
    throw new ChromiumKeyError("read_failed", "Local State has no os_crypt section.");
  }
  if (typeof osCrypt.app_bound_encrypted_key === "string" && osCrypt.app_bound_encrypted_key.length > 0) {
    throw new ChromiumKeyError(
      "unsupported",
      "Chrome's app-bound encryption blocks import on Windows",
    );
  }
  if (typeof osCrypt.encrypted_key !== "string" || osCrypt.encrypted_key.length === 0) {
    throw new ChromiumKeyError("read_failed", "Local State has no encrypted_key.");
  }
  const wrapped = Buffer.from(osCrypt.encrypted_key, "base64");
  if (!wrapped.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) {
    throw new ChromiumKeyError("read_failed", "The stored Windows key is missing its DPAPI prefix.");
  }
  return wrapped.subarray(DPAPI_PREFIX.length);
}

export type ResolveChromiumKeysArgs = {
  platform: NodeJS.Platform;
  keychainService?: string;
  keychainAccount?: string;
  linuxSecretApplication?: string;
  windowsLocalStatePath?: string;
};

/**
 * Gathers every key ADE can offer for one Chromium source.
 *
 * Throws only when *no* key could be obtained; a partial set is normal (a Linux
 * jar mixes `v10` and `v11`, and a keyring that is merely absent still leaves
 * the `v10` fallback usable).
 */
export function resolveChromiumKeys(
  args: ResolveChromiumKeysArgs,
  deps: ChromiumKeyDeps = {},
): ChromiumKeyMaterial {
  const readMacSecret = deps.readMacKeychainSecret ?? readMacKeychainSecretViaSecurity;
  const readLinuxSecret = deps.readLinuxSecret ?? readLinuxSecretViaSecretTool;
  const unwrapWindows = deps.unwrapWindowsKey ?? unwrapWindowsDpapiKey;
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));

  if (args.platform === "darwin") {
    if (!args.keychainService || !args.keychainAccount) {
      throw new ChromiumKeyError("read_failed", "No keychain identity is known for this browser.");
    }
    const secret = readMacSecret(args.keychainService, args.keychainAccount);
    if (secret === null) {
      throw new ChromiumKeyError(
        "key_unavailable",
        "macOS did not release this browser's keychain secret. Approve the Keychain prompt and try again.",
      );
    }
    return { cbcV10: deriveChromiumKey(secret, MAC_KEY_ITERATIONS) };
  }

  if (args.platform === "linux") {
    // `v10` is always available: Chromium falls back to it whenever no keyring
    // answers, so deriving it costs nothing and rescues keyring-less machines.
    const cbcV10 = deriveChromiumKey(LINUX_FALLBACK_PASSPHRASE, LINUX_KEY_ITERATIONS);
    const cbcEmpty = deriveChromiumKey("", LINUX_KEY_ITERATIONS);
    const secret = args.linuxSecretApplication
      ? readLinuxSecret(args.linuxSecretApplication)
      : null;
    return secret === null
      ? { cbcV10, cbcEmpty }
      : { cbcV10, cbcEmpty, cbcV11: deriveChromiumKey(secret, LINUX_KEY_ITERATIONS) };
  }

  if (args.platform === "win32") {
    if (!args.windowsLocalStatePath) {
      throw new ChromiumKeyError("read_failed", "No Local State path is known for this browser.");
    }
    let contents: string;
    try {
      contents = readFile(args.windowsLocalStatePath);
    } catch (cause) {
      throw new ChromiumKeyError("read_failed", "Local State could not be read.", cause);
    }
    return { gcmV10: unwrapWindows(decodeWindowsWrappedKey(contents)) };
  }

  throw new ChromiumKeyError("unsupported", "ADE can't import logins on this platform.");
}
