import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WINDOWS_DPAPI_KEY_FILE = ".credential-key.dpapi";
const WINDOWS_DPAPI_KEY_MAGIC = "ADE_WINDOWS_DPAPI_KEY_V1";
/**
 * DPAPI itself is a local, sub-millisecond call; essentially the whole budget
 * pays for a Windows PowerShell 5.1 cold start. That start is not bounded by
 * anything ADE controls - it loads the CLR and the System.Security assembly
 * from disk, and Defender's on-access scanner inspects powershell.exe and each
 * assembly the first time they are touched. On a contended machine (a CI
 * runner, or a laptop right after login) it routinely runs several seconds,
 * which a 5s budget turned into a hard "credentials are unavailable" failure
 * for a helper that had done nothing wrong. Bound the helper generously
 * instead: waiting longer only costs time in the case that was already broken,
 * while a tight bound costs the user their credentials.
 */
const WINDOWS_DPAPI_TIMEOUT_MS = 30_000;
const WINDOWS_DPAPI_MAX_OUTPUT_BYTES = 64 * 1024;
const WINDOWS_DPAPI_POWERSHELL_KERNEL_PATH =
  "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Windows deliberately has no negative cache, unlike the macOS keychain
 * resolver. A locked keychain is a durable state worth backing off from, but a
 * DPAPI failure is almost always a transient PowerShell timeout — suppressing
 * retries for it would turn one slow cold start into a permanent-looking
 * "credentials are unavailable".
 */
const cachedKeyMaterial = new Map<string, Buffer>();
/**
 * Concurrent credential reads would otherwise each spawn their own PowerShell,
 * and that contention is precisely what makes a cold start slow enough to hit
 * the timeout above. One in-flight read per key path serves them all.
 */
const keyMaterialReadInFlight = new Map<string, Promise<Buffer>>();
/**
 * Bumped by every invalidation so a read that started before it cannot write
 * its now-stale material back into the cache.
 */
let dpapiEpoch = 0;

const WINDOWS_DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  "$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser",
  "if ($env:ADE_DPAPI_OPERATION -eq 'protect') {",
  "  $outputBytes = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, $scope)",
  "} elseif ($env:ADE_DPAPI_OPERATION -eq 'unprotect') {",
  "  $outputBytes = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, $scope)",
  "} else {",
  "  throw 'Unknown DPAPI operation.'",
  "}",
  "[Console]::Out.Write([Convert]::ToBase64String($outputBytes))",
].join("; ");

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function parseProtectedKeyFile(raw: string): Buffer {
  const [magic, encoded, ...rest] = raw.trim().split(/\r?\n/);
  if (magic !== WINDOWS_DPAPI_KEY_MAGIC || !encoded || rest.length > 0) {
    throw new Error("ADE Windows credential key has an unsupported format.");
  }
  const protectedKey = Buffer.from(encoded, "base64");
  if (protectedKey.length === 0) {
    throw new Error("ADE Windows credential key is invalid.");
  }
  return protectedKey;
}

function decodeDpapiResult(raw: string): Buffer {
  const value = raw.trim();
  const decoded = value ? Buffer.from(value, "base64") : Buffer.alloc(0);
  if (decoded.length === 0) {
    throw new Error("Windows DPAPI returned an empty credential key.");
  }
  return decoded;
}

function dpapiChildEnv(operation: "protect" | "unprotect"): NodeJS.ProcessEnv {
  const allowed = new Set([
    "comspec",
    "path",
    "pathext",
    "psmodulepath",
    "systemroot",
    "temp",
    "tmp",
    "windir",
  ]);
  const env: NodeJS.ProcessEnv = { ADE_DPAPI_OPERATION: operation };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key.toLowerCase())) env[key] = value;
  }
  return env;
}

function dpapiArguments(): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    WINDOWS_DPAPI_SCRIPT,
  ];
}

/**
 * Resolve Windows PowerShell through the kernel-owned SystemRoot link. The
 * mutable SystemRoot/windir environment and CreateProcess executable search
 * are intentionally not involved, so an untrusted project or poisoned launch
 * environment cannot redirect the DPAPI helper.
 */
export function resolveWindowsDpapiPowerShellPath(): string {
  try {
    const resolved = path.win32.normalize(
      fs.realpathSync.native(WINDOWS_DPAPI_POWERSHELL_KERNEL_PATH),
    );
    const parsed = path.win32.parse(resolved);
    const expectedSuffix = "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    if (
      !path.win32.isAbsolute(resolved)
      || !/^[A-Za-z]:\\$/.test(parsed.root)
      || !resolved.toLowerCase().endsWith(expectedSuffix.toLowerCase())
      || !fs.statSync(resolved).isFile()
    ) {
      throw new Error("invalid system PowerShell path");
    }
    return resolved;
  } catch {
    throw new Error("Windows DPAPI credential protection is unavailable.");
  }
}

function runDpapiSync(operation: "protect" | "unprotect", value: Buffer): Buffer {
  const result = spawnSync(resolveWindowsDpapiPowerShellPath(), dpapiArguments(), {
    encoding: "utf8",
    env: dpapiChildEnv(operation),
    input: value.toString("base64"),
    maxBuffer: WINDOWS_DPAPI_MAX_OUTPUT_BYTES,
    timeout: WINDOWS_DPAPI_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    // spawnSync folds "could not start" and "ran past the deadline" into the
    // same field. They are different diagnoses - one means the helper is
    // missing or blocked, the other means the machine was busy - and the async
    // path already reports them apart.
    if (isNodeErrorCode(result.error, "ETIMEDOUT")) {
      throw new Error("Windows DPAPI credential protection timed out.");
    }
    throw new Error("Windows DPAPI credential protection is unavailable.");
  }
  if (result.status !== 0) {
    throw new Error("Windows DPAPI credential protection failed.");
  }
  return decodeDpapiResult(result.stdout ?? "");
}

function runDpapiAsync(operation: "protect" | "unprotect", value: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveWindowsDpapiPowerShellPath(), dpapiArguments(), {
      stdio: ["pipe", "pipe", "pipe"],
      env: dpapiChildEnv(operation),
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error: Error | null, output?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output ?? Buffer.alloc(0));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Windows DPAPI credential protection timed out."));
    }, WINDOWS_DPAPI_TIMEOUT_MS);
    timeout.unref?.();
    child.once("error", () => {
      finish(new Error("Windows DPAPI credential protection is unavailable."));
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += next.length;
      if (stdoutBytes > WINDOWS_DPAPI_MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("Windows DPAPI credential protection returned too much data."));
        return;
      }
      stdout.push(next);
    });
    // Drain stderr without retaining it. PowerShell errors can contain host
    // details, and diagnostics never need the protected key or credential input.
    child.stderr.resume();
    child.stdin.once("error", () => {
      finish(new Error("Windows DPAPI credential protection input failed."));
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error("Windows DPAPI credential protection failed."));
        return;
      }
      try {
        finish(null, decodeDpapiResult(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(value.toString("base64"));
  });
}

function protectedKeyPath(keyBindingDir: string): string {
  return path.resolve(keyBindingDir, WINDOWS_DPAPI_KEY_FILE);
}

/**
 * Drops the in-process DPAPI material cache for one key-binding directory so
 * the next read re-runs the unprotect against whatever is on disk now.
 *
 * The credential store's self-heal needs this on Windows for the same reason it
 * needs it on macOS: a peer process can win the key-creation race after this
 * process cached its own copy, and without a way to drop that copy every later
 * decrypt keeps failing against material that is already known to be wrong.
 *
 * The in-flight promise is deliberately left alone — it is already reading, and
 * dropping it would only duplicate the PowerShell spawn the dedup exists to
 * avoid. Bumping the epoch is what makes that safe: the read still resolves for
 * its own callers, but its cache write is discarded, so material this
 * invalidation just rejected cannot reappear behind the self-heal's 30 s
 * throttle.
 */
export function invalidateWindowsDpapiMaterial(keyBindingDir: string): void {
  dpapiEpoch += 1;
  cachedKeyMaterial.delete(protectedKeyPath(keyBindingDir));
}

function unprotectKey(keyPath: string): Buffer {
  const material = runDpapiSync(
    "unprotect",
    parseProtectedKeyFile(fs.readFileSync(keyPath, "utf8")),
  );
  if (material.length !== 32) throw new Error("ADE Windows credential key is invalid.");
  return material;
}

async function unprotectKeyAsync(keyPath: string): Promise<Buffer> {
  const material = await runDpapiAsync(
    "unprotect",
    parseProtectedKeyFile(await fs.promises.readFile(keyPath, "utf8")),
  );
  if (material.length !== 32) throw new Error("ADE Windows credential key is invalid.");
  return material;
}

/**
 * Returns a per-user, per-ADE-home key protected by Windows DPAPI. The random
 * key crosses the PowerShell boundary only on stdin/stdout and the persisted
 * blob is unusable from another Windows account.
 */
export function readOrCreateWindowsDpapiMaterial(keyBindingDir: string): Buffer {
  const keyPath = protectedKeyPath(keyBindingDir);
  const cached = cachedKeyMaterial.get(keyPath);
  if (cached) return cached;

  const readEpoch = dpapiEpoch;
  let material: Buffer;
  try {
    material = unprotectKey(keyPath);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
    material = crypto.randomBytes(32);
    const protectedKey = runDpapiSync("protect", material);
    ensureDirectory(path.dirname(keyPath));
    try {
      fs.writeFileSync(
        keyPath,
        `${WINDOWS_DPAPI_KEY_MAGIC}\n${protectedKey.toString("base64")}\n`,
        { flag: "wx", mode: 0o600 },
      );
    } catch (writeError) {
      if (!isNodeErrorCode(writeError, "EEXIST")) throw writeError;
      material = unprotectKey(keyPath);
    }
  }
  if (readEpoch === dpapiEpoch) cachedKeyMaterial.set(keyPath, material);
  return material;
}

/** Async counterpart used by brain-facing credential reads. */
export async function readOrCreateWindowsDpapiMaterialAsync(
  keyBindingDir: string,
): Promise<Buffer> {
  const keyPath = protectedKeyPath(keyBindingDir);
  const cached = cachedKeyMaterial.get(keyPath);
  if (cached) return cached;
  const existing = keyMaterialReadInFlight.get(keyPath);
  if (existing) return await existing;

  const readEpoch = dpapiEpoch;
  const read = (async () => {
    let material: Buffer;
    try {
      material = await unprotectKeyAsync(keyPath);
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
      material = crypto.randomBytes(32);
      const protectedKey = await runDpapiAsync("protect", material);
      await fs.promises.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
      try {
        await fs.promises.writeFile(
          keyPath,
          `${WINDOWS_DPAPI_KEY_MAGIC}\n${protectedKey.toString("base64")}\n`,
          { flag: "wx", mode: 0o600 },
        );
      } catch (writeError) {
        if (!isNodeErrorCode(writeError, "EEXIST")) throw writeError;
        material = await unprotectKeyAsync(keyPath);
      }
    }
    // An invalidation while this read was in flight means the material it
    // produced is already known to be stale; hand it to this read's own callers
    // but never let it repopulate the cache the self-heal just cleared.
    if (readEpoch === dpapiEpoch) cachedKeyMaterial.set(keyPath, material);
    return material;
  })();
  keyMaterialReadInFlight.set(keyPath, read);
  try {
    return await read;
  } finally {
    if (keyMaterialReadInFlight.get(keyPath) === read) {
      keyMaterialReadInFlight.delete(keyPath);
    }
  }
}
