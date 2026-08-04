import crypto from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import {
  invalidateWindowsDpapiMaterial,
  readOrCreateWindowsDpapiMaterial,
  readOrCreateWindowsDpapiMaterialAsync,
} from "./windowsDpapiMaterial";

/**
 * OS-bound credential key material.
 *
 * The encrypted file store derives its key from a machine-local secret held by
 * the OS. This module owns everything about obtaining that secret — the
 * platform dispatch, the `security` invocations, the create race, the
 * process-wide cache, and the negative-cache backoff — so the credential store
 * itself only deals with ciphertext.
 *
 * The two supported bindings are shaped differently, and the difference is why
 * every entry point takes a `keyBindingDir` — the directory the caller keeps its
 * machine key in:
 *   - macOS holds ONE global keychain item for the machine, so `keyBindingDir`
 *     is ignored there.
 *   - Windows holds a DPAPI-protected key file PER directory
 *     (`<keyBindingDir>/.credential-key.dpapi`), so the directory selects which
 *     key is being asked for. Sharing a single slot across directories would
 *     hand one store another store's key.
 */

const MACOS_KEYCHAIN_SERVICE = "com.ade.runtime.credentials.file-store-key.v1";
const MACOS_KEYCHAIN_ACCOUNT = "machine";
const MACOS_KEYCHAIN_READ_TIMEOUT_MS = 2_000;
const MACOS_KEYCHAIN_NEGATIVE_CACHE_MS = 30_000;
/** `security` exits 44 (errSecItemNotFound) only when the item truly does not exist. */
const MACOS_KEYCHAIN_ITEM_NOT_FOUND_STATUS = 44;
/** `security` exits 45 (errSecDuplicateItem) when a peer already created the item. */
const MACOS_KEYCHAIN_DUPLICATE_ITEM_STATUS = 45;

/**
 * Why a resolution produced no material.
 *
 * The distinction is load-bearing: `not_found` means the item has to be
 * CREATED, which only the synchronous path does, so it must never suppress the
 * synchronous path. `unavailable` means the keychain itself could not answer
 * (locked, denied, timed out, wedged) and re-asking it on every credential read
 * is what the backoff exists to prevent.
 */
export type OsBoundKeyMaterialMissReason = "not_found" | "unavailable";

export type OsBoundKeyMaterialResolution =
  | { material: Buffer; reason?: undefined }
  | { material: null; reason: OsBoundKeyMaterialMissReason };

type MacKeychainFindOutcome =
  | { kind: "found"; value: string }
  /** errSecItemNotFound: the item genuinely does not exist yet. */
  | { kind: "not_found" }
  /** Timeout, locked keychain, denied access, or any other `security` failure. */
  | { kind: "error" };

type MacKeychainAddOutcome = "created" | "exists" | "error";

/**
 * Injection seam for the two `security` invocations so the create race can be
 * exercised without a real keychain.
 */
export type MacKeychainCommands = {
  find: () => MacKeychainFindOutcome;
  /**
   * MUST invoke `security add-generic-password` WITHOUT `-U`: an item another
   * process already created has to make this fail instead of being overwritten.
   */
  add: (secret: string) => MacKeychainAddOutcome;
};

function readCredentialPassphraseFromEnv(): Buffer | null {
  const passphrase = process.env.ADE_CREDENTIAL_STORE_PASSPHRASE?.trim();
  return passphrase ? Buffer.from(passphrase, "utf8") : null;
}

/** Explicit opt-out, or a test process that must never touch the real keychain. */
function osBindingDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  if (env.ADE_CREDENTIAL_STORE_DISABLE_OS_BINDING === "1") return true;
  return env.VITEST === "true" || env.NODE_ENV === "test";
}

/** Where this process's credential key material comes from. */
export type OsBoundKeyMaterialBinding =
  /** `ADE_CREDENTIAL_STORE_PASSPHRASE` overrides every OS binding. */
  | "env_passphrase"
  /** Explicit opt-out, or a test process that must not touch the real OS store. */
  | "disabled"
  /** `<keyBindingDir>/.credential-key.dpapi`, protected per directory. */
  | "windows_dpapi"
  /** One global `security` generic-password item per machine. */
  | "macos_keychain"
  /** The platform has no OS binding; the bare machine key is used. */
  | "none";

/**
 * The single decision every entry point below dispatches on.
 *
 * Read, read-async, invalidate and "is material expected?" MUST agree: an
 * invalidation that dropped the macOS resolver's cache on Windows would leave
 * the credential store's self-heal retrying against the same stale DPAPI
 * material, and an `expectsOsBoundKeyMaterial()` that still said "darwin only"
 * would misreport a Windows key failure as an ordinary decrypt failure.
 * Deriving all four from one pure function is what keeps them in step.
 *
 * The env-gate applies on BOTH platforms: a test process, or an explicit
 * opt-out, must never reach `security` or `powershell.exe`.
 */
export function resolveOsBoundKeyMaterialBinding(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): OsBoundKeyMaterialBinding {
  if (env.ADE_CREDENTIAL_STORE_PASSPHRASE?.trim()) return "env_passphrase";
  if (osBindingDisabledByEnv(env)) return "disabled";
  if (platform === "win32") return "windows_dpapi";
  if (platform === "darwin") return "macos_keychain";
  return "none";
}

/** Is OS-held material expected to back this process's credential key? */
export function expectsOsBoundKeyMaterial(): boolean {
  const binding = resolveOsBoundKeyMaterialBinding();
  return binding === "windows_dpapi" || binding === "macos_keychain";
}

function decodeMacKeychainSecret(raw: string): Buffer {
  const decoded = Buffer.from(raw, "base64");
  return decoded.length >= 32 ? decoded : Buffer.from(raw, "utf8");
}

function classifyMacKeychainFind(result: {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: unknown;
}): MacKeychainFindOutcome {
  if (result.error) return { kind: "error" };
  if (result.status === 0) {
    const raw = (result.stdout ?? "").trim();
    return raw.length ? { kind: "found", value: raw } : { kind: "error" };
  }
  // A timeout kills `security` with a signal and no exit status. Treating that
  // as "missing" is what let two first-run processes each mint their own secret.
  if (result.signal) return { kind: "error" };
  if (result.status === MACOS_KEYCHAIN_ITEM_NOT_FOUND_STATUS) return { kind: "not_found" };
  return { kind: "error" };
}

function defaultMacKeychainCommands(): MacKeychainCommands {
  const identityArgs = [
    "-a",
    MACOS_KEYCHAIN_ACCOUNT,
    "-s",
    MACOS_KEYCHAIN_SERVICE,
  ];
  return {
    find: () => classifyMacKeychainFind(spawnSync(
      "security",
      ["find-generic-password", ...identityArgs, "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: MACOS_KEYCHAIN_READ_TIMEOUT_MS,
      },
    )),
    add: (secret) => {
      // No `-U`: an existing item must fail this call so the peer's secret wins.
      const result = spawnSync(
        "security",
        ["add-generic-password", ...identityArgs, "-w"],
        {
          input: `${secret}\n`,
          stdio: ["pipe", "ignore", "pipe"],
          timeout: MACOS_KEYCHAIN_READ_TIMEOUT_MS,
        },
      );
      if (result.error || result.signal) return "error";
      if (result.status === 0) return "created";
      return result.status === MACOS_KEYCHAIN_DUPLICATE_ITEM_STATUS ? "exists" : "error";
    },
  };
}

/**
 * Race-safe, non-destructive keychain material resolution.
 *
 * Two processes doing their first read concurrently must converge on ONE
 * secret: whoever loses the create race adopts the winner's item instead of
 * clobbering it, and any inconclusive `security` result (timeout, locked
 * keychain) fails closed rather than minting a replacement.
 */
export function resolveMacKeychainMaterialOutcome(
  commands: MacKeychainCommands,
): OsBoundKeyMaterialResolution {
  const existing = commands.find();
  if (existing.kind === "found") return { material: decodeMacKeychainSecret(existing.value) };
  if (existing.kind === "error") return { material: null, reason: "unavailable" };

  const secret = crypto.randomBytes(32).toString("base64");
  if (commands.add(secret) === "created") return { material: Buffer.from(secret, "base64") };

  // The item appeared between our find and our add (or the add failed): adopt
  // whatever is in the keychain now. Never overwrite it.
  const winner = commands.find();
  if (winner.kind === "found") return { material: decodeMacKeychainSecret(winner.value) };
  // We could neither create nor read the item: the keychain, not its contents,
  // is the problem.
  return { material: null, reason: "unavailable" };
}

function readOrCreateMacKeychainMaterial(): OsBoundKeyMaterialResolution {
  if (process.platform !== "darwin") return { material: null, reason: "unavailable" };
  return resolveMacKeychainMaterialOutcome(defaultMacKeychainCommands());
}

/**
 * Read-only counterpart used by asynchronous reads: it never creates the item,
 * so a hot async path cannot participate in the create race at all.
 */
async function readMacKeychainMaterialAsync(): Promise<OsBoundKeyMaterialResolution> {
  if (process.platform !== "darwin") return { material: null, reason: "unavailable" };
  return new Promise((resolve) => {
    execFile(
      "security",
      [
        "find-generic-password",
        "-a",
        MACOS_KEYCHAIN_ACCOUNT,
        "-s",
        MACOS_KEYCHAIN_SERVICE,
        "-w",
      ],
      {
        encoding: "utf8",
        timeout: MACOS_KEYCHAIN_READ_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      },
      (error, stdout) => {
        const outcome = classifyMacKeychainFind({
          status: error ? (typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : null) : 0,
          signal: (error as { signal?: NodeJS.Signals | null } | null)?.signal ?? null,
          stdout,
        });
        if (outcome.kind === "found") {
          resolve({ material: decodeMacKeychainSecret(outcome.value) });
          return;
        }
        resolve({
          material: null,
          reason: outcome.kind === "not_found" ? "not_found" : "unavailable",
        });
      },
    );
  });
}

export type OsBoundKeyMaterialResolver = {
  /** Creating resolution: may mint the keychain item when it does not exist. */
  read(): Buffer | null;
  /** Read-only resolution: never creates the item. */
  readAsync(): Promise<Buffer | null>;
  /** Drops the cache so the next resolution re-asks the OS. */
  invalidate(): void;
};

/**
 * Caches one machine secret per process and bounds how often a failing keychain
 * is re-asked.
 *
 * The two paths are deliberately governed by DIFFERENT backoffs. The read-only
 * (async) path is the hot one and backs off on any miss. The creating (sync)
 * path backs off only when the keychain was unavailable: a `not_found` miss
 * recorded by the async path means the item still has to be created, and
 * suppressing creation for it would starve first-run item creation forever
 * because the async path refreshes the miss timestamp on every read.
 */
export function createMacKeychainMaterialResolver(args: {
  read: () => OsBoundKeyMaterialResolution;
  readAsync: () => Promise<OsBoundKeyMaterialResolution>;
  now?: () => number;
  negativeCacheMs?: number;
}): OsBoundKeyMaterialResolver {
  const now = args.now ?? Date.now;
  const negativeCacheMs = args.negativeCacheMs ?? MACOS_KEYCHAIN_NEGATIVE_CACHE_MS;
  let cached: Buffer | null = null;
  let inFlight: Promise<Buffer | null> | null = null;
  let lastMissAt = 0;
  let lastMissReason: OsBoundKeyMaterialMissReason | null = null;
  /** Bumped by invalidation so an in-flight read cannot re-cache stale material. */
  let epoch = 0;

  const withinBackoff = (): boolean =>
    lastMissAt > 0 && now() - lastMissAt < negativeCacheMs;

  const creationSuppressed = (): boolean =>
    lastMissReason === "unavailable" && withinBackoff();

  const record = (readEpoch: number, resolution: OsBoundKeyMaterialResolution): Buffer | null => {
    // An invalidation during this read means its result is already stale.
    if (readEpoch !== epoch) return resolution.material;
    if (resolution.material) {
      cached = resolution.material;
      lastMissAt = 0;
      lastMissReason = null;
    } else {
      lastMissAt = now();
      lastMissReason = resolution.reason;
    }
    return resolution.material;
  };

  return {
    read(): Buffer | null {
      if (cached) return cached;
      if (creationSuppressed()) return null;
      const readEpoch = epoch;
      return record(readEpoch, args.read());
    },
    async readAsync(): Promise<Buffer | null> {
      if (cached) return cached;
      if (withinBackoff()) return null;
      if (inFlight) return await inFlight;
      const readEpoch = epoch;
      const read = args.readAsync().then((resolution) => record(readEpoch, resolution));
      inFlight = read;
      try {
        return await read;
      } finally {
        if (inFlight === read) inFlight = null;
      }
    },
    invalidate(): void {
      epoch += 1;
      cached = null;
      lastMissAt = 0;
      lastMissReason = null;
      inFlight = null;
    },
  };
}

const defaultMacKeychainMaterialResolver = createMacKeychainMaterialResolver({
  read: readOrCreateMacKeychainMaterial,
  readAsync: readMacKeychainMaterialAsync,
});

/**
 * Drops the process-wide OS-material cache so the next read re-asks the OS.
 * Used when a decrypt fails with cached material: the other process may have
 * won the create race after this one cached its own copy.
 *
 * Dispatches exactly like the readers, so the cache that actually backs
 * `readDefaultOsBoundKeyMaterial` on this platform is the one that gets
 * dropped: a Windows invalidation that only cleared the macOS resolver would
 * leave the self-heal retry re-reading the same stale DPAPI material.
 */
export function invalidateDefaultOsBoundKeyMaterialCache(keyBindingDir: string): void {
  switch (resolveOsBoundKeyMaterialBinding()) {
    case "windows_dpapi":
      invalidateWindowsDpapiMaterial(keyBindingDir);
      return;
    case "macos_keychain":
      defaultMacKeychainMaterialResolver.invalidate();
      return;
    default:
      // Nothing is cached when no OS binding is in play.
      return;
  }
}

/**
 * Creating resolution for the platform's OS binding.
 *
 * DPAPI failures propagate rather than degrading to `null`. `null` means "no OS
 * binding", which derives the bare machine key — so swallowing a transient
 * PowerShell timeout would read a DPAPI-bound store as empty and, on the write
 * path, silently re-seal it unbound.
 */
export function readDefaultOsBoundKeyMaterial(keyBindingDir: string): Buffer | null {
  switch (resolveOsBoundKeyMaterialBinding()) {
    case "env_passphrase":
      return readCredentialPassphraseFromEnv();
    // Windows keeps its own per-directory cache and create race inside
    // `windowsDpapiMaterial`, so it does not go through the macOS resolver.
    case "windows_dpapi":
      return readOrCreateWindowsDpapiMaterial(keyBindingDir);
    case "macos_keychain":
      return defaultMacKeychainMaterialResolver.read();
    default:
      return null;
  }
}

export async function readDefaultOsBoundKeyMaterialAsync(
  keyBindingDir: string,
): Promise<Buffer | null> {
  switch (resolveOsBoundKeyMaterialBinding()) {
    case "env_passphrase":
      return readCredentialPassphraseFromEnv();
    case "windows_dpapi":
      return await readOrCreateWindowsDpapiMaterialAsync(keyBindingDir);
    case "macos_keychain":
      return await defaultMacKeychainMaterialResolver.readAsync();
    default:
      return null;
  }
}
