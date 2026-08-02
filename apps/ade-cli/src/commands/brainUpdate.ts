import { execFile, spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { resolveMachineAdeLayout } from "../services/projects/machineLayout";

type BrainUpdateExecFile = (
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const execFileAsync = promisify(execFile) as BrainUpdateExecFile;

const DEFAULT_RELEASE_REPO = "arul28/ADE";
const CHECKSUMS_ASSET = "SHA256SUMS";
const UPDATE_STATUS_FILE = "update-status.json";
const UPDATE_USER_AGENT = "ADE brain updater";
const UPDATE_DOWNLOAD_TIMEOUT_MS = 30_000;
const SUPPORTED_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
]);

export class BrainUpdateUsageError extends Error {}

export type BrainUpdateState =
  | "idle"
  | "staging"
  | "staged"
  | "applying"
  | "restarting"
  | "succeeded"
  | "failed";

export type BrainUpdateStatus = {
  state: BrainUpdateState;
  updatedAt: string;
  message: string;
  version: string | null;
  currentVersion?: string | null;
  target: string | null;
  binaryPath: string | null;
  runtimePath: string | null;
  pid?: number;
  error?: string;
};

type BrainUpdateManifest = {
  version: string;
  repo: string;
  target: string;
  adeHome: string;
  binaryPath: string;
  runtimeTargetDir: string;
  stagedRuntimeRoot: string;
  stagedBinaryPath: string;
  nativeArchivePath: string;
  restartService: boolean;
  createdAt: string;
};

type BrainUpdateOptions = {
  action: "run" | "status" | "check" | "apply-staged";
  repo: string;
  version: string;
  installDir: string | null;
  dryRun: boolean;
  foreground: boolean;
  restartService: boolean;
  manifestPath: string | null;
};

export type BrainUpdateDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  execPath?: string;
  currentVersion?: string;
  now?: () => Date;
  tmpDir?: () => Promise<string>;
  downloadFile?: (url: string, outPath: string) => Promise<void>;
  execFile?: BrainUpdateExecFile;
  spawnDetached?: (command: string, args: string[], options: SpawnOptions) => void;
  runCommand?: typeof runCommand;
};

function nowIso(deps: BrainUpdateDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function normalizeArch(arch: string): "arm64" | "x64" | null {
  const normalized = arch.trim().toLowerCase();
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  if (normalized === "x64" || normalized === "x86_64" || normalized === "amd64") return "x64";
  return null;
}

export function detectRuntimeTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = os.arch(),
): string {
  const normalizedArch = normalizeArch(arch);
  const normalizedPlatform = platform === "darwin" || platform === "linux" || platform === "win32"
    ? platform
    : null;
  if (!normalizedPlatform || !normalizedArch) {
    throw new BrainUpdateUsageError(
      `ADE brain update is supported on macOS/Linux arm64/x64 and Windows x64 runtimes; got ${platform}/${arch}.`,
    );
  }
  const target = `${normalizedPlatform}-${normalizedArch}`;
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new BrainUpdateUsageError(`Unsupported ADE runtime target: ${target}.`);
  }
  return target;
}

export function brainUpdateAssetUrl(repo: string, version: string, assetName: string): string {
  const trimmedRepo = repo.trim();
  const trimmedVersion = version.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmedRepo)) {
    throw new BrainUpdateUsageError("ADE brain update --repo must be in owner/repo form.");
  }
  if (!trimmedVersion || trimmedVersion === "latest") {
    return `https://github.com/${trimmedRepo}/releases/latest/download/${assetName}`;
  }
  if (!/^v?[A-Za-z0-9_.-]+$/.test(trimmedVersion)) {
    throw new BrainUpdateUsageError("ADE brain update --version must be a release tag such as v1.2.13.");
  }
  return `https://github.com/${trimmedRepo}/releases/download/${trimmedVersion}/${assetName}`;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new BrainUpdateUsageError(`ADE brain update ${flag} requires a value.`);
  }
  return value;
}

function parseBrainUpdateArgs(rest: string[], env: NodeJS.ProcessEnv): BrainUpdateOptions {
  const args = [...rest];
  if (args[0] === "update") args.shift();
  let action: BrainUpdateOptions["action"] = "run";
  let repo = env.ADE_RELEASE_REPO?.trim() || DEFAULT_RELEASE_REPO;
  let version = env.ADE_VERSION?.trim() || "latest";
  let installDir: string | null = null;
  let dryRun = false;
  let foreground = false;
  let restartService = true;
  let manifestPath: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "status") {
      action = "status";
      continue;
    }
    if (arg === "check") {
      action = "check";
      dryRun = true;
      continue;
    }
    if (arg === "--repo") {
      repo = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
      continue;
    }
    if (arg === "--version") {
      version = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      version = arg.slice("--version=".length);
      continue;
    }
    if (arg === "--install-dir") {
      installDir = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--install-dir=")) {
      installDir = arg.slice("--install-dir=".length);
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--foreground") {
      foreground = true;
      continue;
    }
    if (arg === "--no-restart") {
      restartService = false;
      continue;
    }
    if (arg === "--apply-staged") {
      action = "apply-staged";
      manifestPath = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--apply-staged=")) {
      action = "apply-staged";
      manifestPath = arg.slice("--apply-staged=".length);
      continue;
    }
    throw new BrainUpdateUsageError(`Unknown ADE brain update option: ${arg}`);
  }

  return {
    action,
    repo,
    version,
    installDir,
    dryRun,
    foreground,
    restartService,
    manifestPath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readManifest(manifestPath: string): BrainUpdateManifest {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new BrainUpdateUsageError("Invalid ADE brain update manifest.");
  }
  const manifest = parsed as Record<string, unknown>;
  const stringField = (key: keyof BrainUpdateManifest): string => {
    const value = manifest[key];
    if (typeof value !== "string" || !value) {
      throw new BrainUpdateUsageError(`Invalid ADE brain update manifest: missing ${key}.`);
    }
    return value;
  };
  return {
    version: stringField("version"),
    repo: stringField("repo"),
    target: stringField("target"),
    adeHome: stringField("adeHome"),
    binaryPath: stringField("binaryPath"),
    runtimeTargetDir: stringField("runtimeTargetDir"),
    stagedRuntimeRoot: stringField("stagedRuntimeRoot"),
    stagedBinaryPath: stringField("stagedBinaryPath"),
    nativeArchivePath: stringField("nativeArchivePath"),
    restartService: manifest.restartService !== false,
    createdAt: stringField("createdAt"),
  };
}

function updateStatusPath(runtimeDir: string): string {
  return path.join(runtimeDir, UPDATE_STATUS_FILE);
}

async function writeBrainUpdateStatus(
  runtimeDir: string,
  status: BrainUpdateStatus,
): Promise<void> {
  await fsp.mkdir(runtimeDir, { recursive: true });
  const target = updateStatusPath(runtimeDir);
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, target);
}

export function readBrainUpdateStatus(env: NodeJS.ProcessEnv = process.env): BrainUpdateStatus {
  const layout = resolveMachineAdeLayout(env);
  const statusPath = updateStatusPath(layout.runtimeDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.state === "string") {
      return parsed as BrainUpdateStatus;
    }
  } catch {}
  return {
    state: "idle",
    updatedAt: new Date(0).toISOString(),
    message: "No ADE brain update has run on this machine.",
    version: null,
    target: null,
    binaryPath: null,
    runtimePath: null,
  };
}

async function defaultUpdateStagingDir(runtimeDir: string): Promise<string> {
  const updatesDir = path.join(runtimeDir, "updates");
  await fsp.mkdir(updatesDir, { recursive: true });
  return await fsp.mkdtemp(path.join(updatesDir, "update-"));
}

function resolveDownload(url: string): typeof https | typeof http {
  if (url.startsWith("https://")) return https;
  if (url.startsWith("http://")) return http;
  throw new BrainUpdateUsageError(`Unsupported ADE brain update URL: ${url}`);
}

async function defaultDownloadFile(url: string, outPath: string, redirects = 0): Promise<void> {
  if (redirects > 5) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.download`;
  await new Promise<void>((resolve, reject) => {
    const request = resolveDownload(url).get(
      url,
      { headers: { "user-agent": UPDATE_USER_AGENT }, timeout: UPDATE_DOWNLOAD_TIMEOUT_MS },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          const redirected = new URL(location, url).toString();
          if (url.startsWith("https://") && !redirected.startsWith("https://")) {
            reject(new Error(`Refusing insecure redirect from ${url} to ${redirected}`));
            return;
          }
          defaultDownloadFile(redirected, outPath, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`Download failed with HTTP ${status}: ${url}`));
          return;
        }
        pipeline(response, fs.createWriteStream(tmp))
          .then(() => fsp.rename(tmp, outPath))
          .then(resolve, reject);
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error(`Timed out downloading ${url}`));
    });
    request.on("error", reject);
  }).catch(async (error) => {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  });
}

function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

export type BrainServiceRestartResult = ReturnType<typeof runCommand>;

export function requestBrainServiceRestart(
  args: {
    command: string;
    commandArgs: string[];
    env?: NodeJS.ProcessEnv;
  },
  run: typeof runCommand = runCommand,
): BrainServiceRestartResult {
  return run(
    args.command,
    [...args.commandArgs, "--install-service"],
    {
      env: {
        ...(args.env ?? process.env),
        ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION: "1",
      },
    },
  );
}

export function requestBrainServiceStop(
  args: {
    command: string;
    commandArgs: string[];
    env?: NodeJS.ProcessEnv;
  },
  run: typeof runCommand = runCommand,
): BrainServiceRestartResult {
  return run(
    args.command,
    [...args.commandArgs, "--uninstall-service"],
    {
      env: {
        ...(args.env ?? process.env),
        ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION: "1",
      },
    },
  );
}

export function requestBrainServiceStatus(
  args: {
    command: string;
    commandArgs: string[];
    env?: NodeJS.ProcessEnv;
  },
  run: typeof runCommand = runCommand,
): BrainServiceRestartResult & { installed: boolean | null } {
  const result = run(
    args.command,
    [...args.commandArgs, "--service-status", "--json"],
    { env: args.env ?? process.env },
  );
  let installed: boolean | null = null;
  if (result.status === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as { installed?: unknown };
      installed = typeof parsed.installed === "boolean" ? parsed.installed : null;
    } catch {
      installed = null;
    }
  }
  return { ...result, installed };
}

function runtimeBinaryAssetName(target: string): string {
  return `ade-${target}${target.startsWith("win32-") ? ".exe" : ""}`;
}

function installedRuntimeBinaryName(target: string): string {
  return target.startsWith("win32-") ? "ade.exe" : "ade";
}

function runtimeNodeModulesPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "node_modules");
}

function runtimeSidecarEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeRoot: string,
): NodeJS.ProcessEnv {
  const nodePath = runtimeNodeModulesPath(runtimeRoot);
  return {
    ...baseEnv,
    ADE_RUNTIME_ROOT: runtimeRoot,
    ADE_RUNTIME_NODE_MODULES: nodePath,
    NODE_PATH: baseEnv.NODE_PATH ? `${nodePath}${path.delimiter}${baseEnv.NODE_PATH}` : nodePath,
  };
}

function readSha256Sums(filePath: string): Map<string, string> {
  const sums = new Map<string, string>();
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (!match) continue;
    sums.set(path.basename(match[2].trim()), match[1].toLowerCase());
  }
  return sums;
}

async function verifySha256(filePath: string, expectedHex: string, label: string): Promise<void> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  const actual = hash.digest("hex");
  if (actual !== expectedHex.toLowerCase()) {
    throw new Error(`ADE brain update checksum mismatch for ${label}: expected ${expectedHex}, got ${actual}.`);
  }
}

async function verifyDownloadedAssetChecksums(args: {
  checksumPath: string;
  binaryName: string;
  binaryPath: string;
  nativeArchiveName: string;
  nativeArchivePath: string;
}): Promise<void> {
  const sums = readSha256Sums(args.checksumPath);
  const binarySum = sums.get(args.binaryName);
  const nativeArchiveSum = sums.get(args.nativeArchiveName);
  if (!binarySum) {
    throw new Error(`ADE brain update checksum file is missing ${args.binaryName}.`);
  }
  if (!nativeArchiveSum) {
    throw new Error(`ADE brain update checksum file is missing ${args.nativeArchiveName}.`);
  }
  await verifySha256(args.binaryPath, binarySum, args.binaryName);
  await verifySha256(args.nativeArchivePath, nativeArchiveSum, args.nativeArchiveName);
}

async function extractArchiveToDirectory(
  archivePath: string,
  targetDir: string,
  deps: BrainUpdateDeps,
): Promise<void> {
  await fsp.mkdir(targetDir, { recursive: true });
  const result = (deps.runCommand ?? runCommand)("tar", ["-xzf", archivePath, "-C", targetDir]);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to extract ADE native runtime dependencies.");
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function promoteStagedNativeRuntime(manifest: BrainUpdateManifest): Promise<string | null> {
  if (!(await pathExists(path.join(manifest.stagedRuntimeRoot, "node_modules")))) {
    throw new Error("Staged ADE native runtime dependencies are missing node_modules.");
  }

  const parent = path.dirname(manifest.runtimeTargetDir);
  const backupPath = path.join(parent, `.${path.basename(manifest.runtimeTargetDir)}.previous-${process.pid}`);
  await fsp.mkdir(parent, { recursive: true });
  await fsp.rm(backupPath, { recursive: true, force: true });

  let hasBackup = false;
  try {
    await fsp.rename(manifest.runtimeTargetDir, backupPath);
    hasBackup = true;
  } catch (error) {
    if (!isNodeErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await fsp.rename(manifest.stagedRuntimeRoot, manifest.runtimeTargetDir);
    return hasBackup ? backupPath : null;
  } catch (error) {
    if (hasBackup) {
      try {
        await fsp.rename(backupPath, manifest.runtimeTargetDir);
      } catch (restoreError) {
        throw new Error(
          `ADE native runtime promotion failed (${error instanceof Error ? error.message : String(error)}); `
          + `restoring the previous runtime also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}. `
          + `Recovery files remain at ${backupPath}.`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

async function rollbackPromotedNativeRuntime(
  manifest: BrainUpdateManifest,
  backupPath: string | null,
): Promise<void> {
  await fsp.rm(manifest.runtimeTargetDir, { recursive: true, force: true });
  if (backupPath) {
    await fsp.rename(backupPath, manifest.runtimeTargetDir);
  }
}

const WINDOWS_DEFERRED_STAGING_CLEANUP = [
  "$ErrorActionPreference='SilentlyContinue';",
  "$target=$env:ADE_BRAIN_UPDATE_CLEANUP_DIR;",
  "$parentPid=[int]$env:ADE_BRAIN_UPDATE_CLEANUP_PARENT_PID;",
  "Wait-Process -Id $parentPid -ErrorAction SilentlyContinue;",
  "for ($attempt=0; $attempt -lt 20; $attempt++) {",
  "  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue;",
  "  if (-not (Test-Path -LiteralPath $target)) { exit 0 }",
  "  Start-Sleep -Milliseconds 500;",
  "}",
  "exit 1;",
].join(" ");

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function cleanupAppliedUpdateStaging(
  stagingDir: string,
  deps: BrainUpdateDeps,
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const execPath = deps.execPath ?? process.execPath;
  if (platform === "win32" && isPathInside(stagingDir, execPath)) {
    (deps.spawnDetached ?? spawnDetached)(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_DEFERRED_STAGING_CLEANUP],
      {
        env: {
          ...(deps.env ?? process.env),
          ADE_BRAIN_UPDATE_CLEANUP_DIR: stagingDir,
          ADE_BRAIN_UPDATE_CLEANUP_PARENT_PID: String(process.pid),
        },
      },
    );
    return;
  }
  await fsp.rm(stagingDir, { recursive: true, force: true });
}

async function applyStagedBrainUpdate(
  manifestPath: string,
  deps: BrainUpdateDeps,
): Promise<Record<string, unknown>> {
  const manifest = readManifest(manifestPath);
  if (manifest.target === "win32-x64" && !manifest.restartService) {
    throw new BrainUpdateUsageError(
      "ADE brain update --no-restart is not supported on Windows because replacing the running executable requires re-registering its per-user startup service.",
    );
  }
  const stagingDir = path.dirname(manifestPath);
  const runtimeDir = path.dirname(manifest.runtimeTargetDir);
  const statusBase = {
    version: manifest.version,
    target: manifest.target,
    binaryPath: manifest.binaryPath,
    runtimePath: manifest.runtimeTargetDir,
    pid: process.pid,
  };
  const writeStatus = (state: BrainUpdateState, message: string, error?: string) =>
    writeBrainUpdateStatus(runtimeDir, {
      ...statusBase,
      state,
      updatedAt: nowIso(deps),
      message,
      error,
    });
  const cleanupStagingDir = () => cleanupAppliedUpdateStaging(stagingDir, deps);
  const cleanupStagingAfterSuccess = async (successMessage: string): Promise<string> => {
    try {
      await cleanupStagingDir();
      return successMessage;
    } catch (error) {
      const cleanupError = error instanceof Error ? error.message : String(error);
      const warningMessage = `${successMessage} Staging cleanup could not complete: ${cleanupError}. Remove ${stagingDir} manually.`;
      await writeStatus("succeeded", warningMessage).catch(() => undefined);
      return warningMessage;
    }
  };
  const platform = deps.platform ?? process.platform;
  const baseEnv = deps.env ?? process.env;
  let windowsServiceStopped = false;
  let windowsServiceWasInstalled = false;
  const serviceEnv = () => ({
    ...runtimeSidecarEnv(baseEnv, manifest.runtimeTargetDir),
    ADE_HOME: manifest.adeHome,
  });
  const restartRolledBackWindowsService = (): string | null => {
    if (!windowsServiceStopped || !windowsServiceWasInstalled || platform !== "win32") return null;
    const rollbackRestart = requestBrainServiceRestart(
      {
        command: manifest.binaryPath,
        commandArgs: ["serve"],
        env: serviceEnv(),
      },
      deps.runCommand ?? runCommand,
    );
    if (rollbackRestart.status === 0) return null;
    return rollbackRestart.stderr || rollbackRestart.stdout || "ADE brain service rollback restart failed.";
  };

  try {
    await writeStatus("applying", "Applying staged ADE brain runtime update.");
    if (platform === "win32" && await pathExists(manifest.binaryPath)) {
      const statusResult = requestBrainServiceStatus(
        {
          command: manifest.binaryPath,
          commandArgs: ["serve"],
          env: serviceEnv(),
        },
        deps.runCommand ?? runCommand,
      );
      if (statusResult.status !== 0 || statusResult.installed === null) {
        throw new Error(
          statusResult.stderr || statusResult.stdout || "ADE brain service state could not be read before replacing the Windows runtime.",
        );
      }
      windowsServiceWasInstalled = statusResult.installed;
      const stopResult = requestBrainServiceStop(
        {
          command: manifest.binaryPath,
          commandArgs: ["serve"],
          env: serviceEnv(),
        },
        deps.runCommand ?? runCommand,
      );
      if (stopResult.status !== 0) {
        throw new Error(
          stopResult.stderr || stopResult.stdout || "ADE brain service could not be stopped before replacing the Windows runtime.",
        );
      }
      windowsServiceStopped = true;
    }
    await fsp.mkdir(path.dirname(manifest.binaryPath), { recursive: true });
    await fsp.mkdir(path.dirname(manifest.runtimeTargetDir), { recursive: true });
    const replacementPath = path.join(
      path.dirname(manifest.binaryPath),
      `.${path.basename(manifest.binaryPath)}.updating-${process.pid}`,
    );
    const binaryBackupPath = path.join(
      path.dirname(manifest.binaryPath),
      `.${path.basename(manifest.binaryPath)}.previous-${process.pid}`,
    );
    let nativeBackupPath: string | null = null;
    let nativePromoted = false;
    let binaryBackedUp = false;
    let binaryPromoted = false;
    const rollbackPromotedAssets = async () => {
      const rollbackErrors: string[] = [];
      const attempt = async (label: string, action: () => Promise<void>) => {
        try {
          await action();
        } catch (error) {
          rollbackErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      await attempt("staged binary cleanup", () => fsp.rm(replacementPath, { force: true }));
      if (binaryPromoted) {
        await attempt("new binary removal", () => fsp.rm(manifest.binaryPath, { force: true }));
      }
      if (binaryBackedUp) {
        await attempt("previous binary restoration", () => fsp.rename(binaryBackupPath, manifest.binaryPath));
      }
      if (nativePromoted) {
        await attempt(
          "previous native runtime restoration",
          () => rollbackPromotedNativeRuntime(manifest, nativeBackupPath),
        );
      }
      if (rollbackErrors.length > 0) {
        throw new Error(rollbackErrors.join("; "));
      }
    };
    const discardPromotedBackups = async () => {
      await fsp.rm(binaryBackupPath, { force: true }).catch(() => undefined);
      if (nativeBackupPath) {
        await fsp.rm(nativeBackupPath, { recursive: true, force: true }).catch(() => undefined);
      }
    };
    await fsp.copyFile(manifest.stagedBinaryPath, replacementPath);
    await fsp.chmod(replacementPath, 0o755);
    try {
      nativeBackupPath = await promoteStagedNativeRuntime(manifest);
      nativePromoted = true;
      await fsp.rm(binaryBackupPath, { force: true });
      try {
        await fsp.rename(manifest.binaryPath, binaryBackupPath);
        binaryBackedUp = true;
      } catch (error) {
        if (!isNodeErrnoException(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
      await fsp.rename(replacementPath, manifest.binaryPath);
      binaryPromoted = true;
    } catch (error) {
      try {
        await rollbackPromotedAssets();
      } catch (rollbackError) {
        throw new Error(
          `ADE runtime asset promotion failed (${error instanceof Error ? error.message : String(error)}); `
          + `rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. `
          + `Recovery files were retained beside ${manifest.binaryPath} and ${manifest.runtimeTargetDir}.`,
          { cause: error },
        );
      }
      throw error;
    }

    if (!manifest.restartService) {
      const successMessage = "ADE brain runtime updated. Service restart was skipped.";
      await writeStatus("succeeded", successMessage);
      await discardPromotedBackups();
      const message = await cleanupStagingAfterSuccess(successMessage);
      return {
        ok: true,
        action: "update",
        applied: true,
        restarted: false,
        version: manifest.version,
        target: manifest.target,
        binaryPath: manifest.binaryPath,
        runtimePath: manifest.runtimeTargetDir,
        message,
      };
    }

    await writeStatus("restarting", "Restarting ADE brain service with the updated runtime.");
    const env = serviceEnv();
    const result = requestBrainServiceRestart(
      {
        command: manifest.binaryPath,
        commandArgs: ["serve"],
        env,
      },
      deps.runCommand ?? runCommand,
    );
    if (result.status !== 0) {
      const message = result.stderr || result.stdout || "ADE brain service restart failed.";
      let rollbackMessage = "Update was rolled back.";
      try {
        await rollbackPromotedAssets();
      } catch (error) {
        rollbackMessage = `Rollback failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const rollbackRestartError = restartRolledBackWindowsService();
      const failureMessage = `${message} ${rollbackMessage}${
        rollbackRestartError ? ` Previous Windows service restart also failed: ${rollbackRestartError}` : ""
      }`;
      await writeStatus("failed", failureMessage, failureMessage);
      return {
        ok: false,
        action: "update",
        applied: false,
        restarted: false,
        version: manifest.version,
        target: manifest.target,
        binaryPath: manifest.binaryPath,
        runtimePath: manifest.runtimeTargetDir,
        message: failureMessage,
      };
    }

    const successMessage = "ADE brain updated and service restart requested.";
    await writeStatus("succeeded", successMessage);
    await discardPromotedBackups();
    const message = await cleanupStagingAfterSuccess(successMessage);
    return {
      ok: true,
      action: "update",
      applied: true,
      restarted: true,
      version: manifest.version,
      target: manifest.target,
      binaryPath: manifest.binaryPath,
      runtimePath: manifest.runtimeTargetDir,
      message,
    };
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const rollbackRestartError = restartRolledBackWindowsService();
    const message = rollbackRestartError
      ? `${baseMessage} Previous Windows service restart also failed: ${rollbackRestartError}`
      : baseMessage;
    await writeStatus("failed", message, message).catch(() => undefined);
    return {
      ok: false,
      action: "update",
      applied: false,
      restarted: false,
      version: manifest.version,
      target: manifest.target,
      binaryPath: manifest.binaryPath,
      runtimePath: manifest.runtimeTargetDir,
      message,
    };
  }
}

function spawnDetached(command: string, args: string[], options: SpawnOptions): void {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export async function runBrainUpdateCommand(
  rest: string[],
  deps: BrainUpdateDeps = {},
): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const options = parseBrainUpdateArgs(rest, env);
  if (options.action === "status") {
    return {
      ok: true,
      action: "update-status",
      status: readBrainUpdateStatus(env),
    };
  }
  if (options.action === "apply-staged") {
    if (!options.manifestPath) {
      throw new BrainUpdateUsageError("ADE brain update --apply-staged requires a manifest path.");
    }
    return applyStagedBrainUpdate(options.manifestPath, deps);
  }

  const layout = resolveMachineAdeLayout(env, deps.platform ?? process.platform);
  const target = detectRuntimeTarget(deps.platform ?? process.platform, deps.arch ?? os.arch());
  if (target === "win32-x64" && !options.restartService) {
    throw new BrainUpdateUsageError(
      "ADE brain update --no-restart is not supported on Windows because replacing the running executable requires re-registering its per-user startup service.",
    );
  }
  const binaryName = runtimeBinaryAssetName(target);
  const canonicalNativeArchiveName = `ade-${target}.native.tar.gz`;
  const binaryUrl = brainUpdateAssetUrl(options.repo, options.version, binaryName);
  const nativeArchiveUrl = brainUpdateAssetUrl(options.repo, options.version, canonicalNativeArchiveName);
  const checksumUrl = brainUpdateAssetUrl(options.repo, options.version, CHECKSUMS_ASSET);
  const installDir = path.resolve(options.installDir ?? layout.binDir);
  const binaryPath = path.join(installDir, installedRuntimeBinaryName(target));
  const runtimeTargetDir = path.join(layout.runtimeDir, target);
  const currentVersion = deps.currentVersion ?? null;
  const summary = {
    ok: true,
    action: options.action === "check" ? "update-check" : "update",
    dryRun: options.dryRun,
    repo: options.repo,
    requestedVersion: options.version,
    currentVersion,
    target,
    binaryUrl,
    nativeArchiveUrl,
    checksumUrl,
    binaryPath,
    runtimePath: runtimeTargetDir,
    restartService: options.restartService,
  };

  if (options.dryRun) {
    return {
      ...summary,
      message: "ADE brain update check passed. Runtime assets are available at the listed release URLs.",
    };
  }

  await writeBrainUpdateStatus(layout.runtimeDir, {
    state: "staging",
    updatedAt: nowIso(deps),
    message: "Downloading ADE brain runtime update.",
    version: options.version,
    currentVersion,
    target,
    binaryPath,
    runtimePath: runtimeTargetDir,
    pid: process.pid,
  });

  try {
    const tmpDir = await (deps.tmpDir ?? (() => defaultUpdateStagingDir(layout.runtimeDir)))();
    const stagedBinaryPath = path.join(tmpDir, installedRuntimeBinaryName(target));
    const nativeArchivePath = path.join(tmpDir, canonicalNativeArchiveName);
    const checksumPath = path.join(tmpDir, CHECKSUMS_ASSET);
    const stagedRuntimeRoot = path.join(tmpDir, "runtime", target);
    const download = deps.downloadFile ?? defaultDownloadFile;
    await download(binaryUrl, stagedBinaryPath);
    await download(nativeArchiveUrl, nativeArchivePath);
    await download(checksumUrl, checksumPath);
    await verifyDownloadedAssetChecksums({
      checksumPath,
      binaryName,
      binaryPath: stagedBinaryPath,
      nativeArchiveName: canonicalNativeArchiveName,
      nativeArchivePath,
    });
    await fsp.chmod(stagedBinaryPath, 0o755);
    await extractArchiveToDirectory(nativeArchivePath, stagedRuntimeRoot, deps);
    const exec = deps.execFile ?? execFileAsync;
    const versionResult = await exec(stagedBinaryPath, ["--version"], {
      env: {
        ...runtimeSidecarEnv(env, stagedRuntimeRoot),
        ADE_CLI_VERSION: "",
      },
      timeout: 30_000,
    });
    const stagedVersion = String(versionResult.stdout ?? "").trim().replace(/^ade\s+/, "") || options.version;
    const manifest: BrainUpdateManifest = {
      version: stagedVersion,
      repo: options.repo,
      target,
      adeHome: layout.adeDir,
      binaryPath,
      runtimeTargetDir,
      stagedRuntimeRoot,
      stagedBinaryPath,
      nativeArchivePath,
      restartService: options.restartService,
      createdAt: nowIso(deps),
    };
    const manifestPath = path.join(tmpDir, "manifest.json");
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeBrainUpdateStatus(layout.runtimeDir, {
      state: "staged",
      updatedAt: nowIso(deps),
      message: "ADE brain update staged. Applying in a detached helper.",
      version: stagedVersion,
      currentVersion,
      target,
      binaryPath,
      runtimePath: runtimeTargetDir,
      pid: process.pid,
    });

    if (options.foreground) {
      return await applyStagedBrainUpdate(manifestPath, deps);
    }

    const helperEnv = {
      ...runtimeSidecarEnv(env, stagedRuntimeRoot),
      ADE_HOME: layout.adeDir,
      ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION: "1",
      ADE_BRAIN_UPDATE_APPLY: "1",
    };
    (deps.spawnDetached ?? spawnDetached)(
      stagedBinaryPath,
      ["brain", "update", "--apply-staged", manifestPath],
      { env: helperEnv },
    );
    return {
      ...summary,
      dryRun: false,
      stagedVersion,
      detached: true,
      statusPath: updateStatusPath(layout.runtimeDir),
      message:
        "ADE brain update staged. The current connection may disconnect while the helper restarts the brain service.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeBrainUpdateStatus(layout.runtimeDir, {
      state: "failed",
      updatedAt: nowIso(deps),
      message,
      version: options.version,
      currentVersion,
      target,
      binaryPath,
      runtimePath: runtimeTargetDir,
      pid: process.pid,
      error: message,
    }).catch(() => undefined);
    throw error;
  }
}
