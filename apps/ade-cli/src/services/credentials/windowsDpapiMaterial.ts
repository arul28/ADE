import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WINDOWS_DPAPI_KEY_FILE = ".credential-key.dpapi";
const WINDOWS_DPAPI_KEY_MAGIC = "ADE_WINDOWS_DPAPI_KEY_V1";
const WINDOWS_DPAPI_TIMEOUT_MS = 5_000;
const WINDOWS_DPAPI_MAX_OUTPUT_BYTES = 64 * 1024;

const cachedKeyMaterial = new Map<string, Buffer>();
const keyMaterialReadInFlight = new Map<string, Promise<Buffer>>();

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

function runDpapiSync(operation: "protect" | "unprotect", value: Buffer): Buffer {
  const result = spawnSync("powershell.exe", dpapiArguments(), {
    encoding: "utf8",
    env: dpapiChildEnv(operation),
    input: value.toString("base64"),
    maxBuffer: WINDOWS_DPAPI_MAX_OUTPUT_BYTES,
    timeout: WINDOWS_DPAPI_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error("Windows DPAPI credential protection is unavailable.");
  }
  if (result.status !== 0) {
    throw new Error("Windows DPAPI credential protection failed.");
  }
  return decodeDpapiResult(result.stdout ?? "");
}

function runDpapiAsync(operation: "protect" | "unprotect", value: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", dpapiArguments(), {
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

function protectedKeyPath(secretsDir: string): string {
  return path.resolve(secretsDir, WINDOWS_DPAPI_KEY_FILE);
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
export function readOrCreateWindowsDpapiMaterial(secretsDir: string): Buffer {
  const keyPath = protectedKeyPath(secretsDir);
  const cached = cachedKeyMaterial.get(keyPath);
  if (cached) return cached;

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
  cachedKeyMaterial.set(keyPath, material);
  return material;
}

/** Async counterpart used by brain-facing credential reads. */
export async function readOrCreateWindowsDpapiMaterialAsync(secretsDir: string): Promise<Buffer> {
  const keyPath = protectedKeyPath(secretsDir);
  const cached = cachedKeyMaterial.get(keyPath);
  if (cached) return cached;
  const existing = keyMaterialReadInFlight.get(keyPath);
  if (existing) return await existing;

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
    cachedKeyMaterial.set(keyPath, material);
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
