import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client, ConnectConfig, SFTPWrapper } from "ssh2";
import type {
  RemoteRuntimeCapabilities,
  RemoteRuntimeConnectResult,
  RemoteRuntimeMachineProjectCapability,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetRoute,
} from "../../../shared/types/remoteRuntime";
import { RuntimeRpcClient } from "./runtimeRpcClient";
import { connectSshWithRoute, execSsh, openSshRuntimeTransport, type ConnectedSshRoute } from "./sshTransport";
import { routeKey } from "./routeUtils";
import {
  normalizeRemoteTargetRoutes,
  type RemoteTargetRegistry,
} from "./remoteTargetRegistry";

export function normalizeRemoteArch(raw: string): { platform: string; arch: string; label: string } {
  const lower = raw.toLowerCase();
  const platform = lower.includes("darwin")
    ? "darwin"
    : lower.includes("linux")
      ? "linux"
      : null;
  const arch = lower.includes("arm64") || lower.includes("aarch64")
    ? "arm64"
    : lower.includes("x86_64") || lower.includes("amd64")
      ? "x64"
      : null;
  if (!platform || !arch) {
    throw new Error(`Unsupported remote ADE service platform: ${raw.trim() || "unknown"}. Supported targets are macOS/Linux on arm64 or x64.`);
  }
  return { platform, arch, label: `${platform}-${arch}` };
}

export function normalizeRuntimeVersion(raw: string): string | null {
  const version = raw.trim().replace(/^ade\s+/i, "").trim();
  return version || null;
}

const PLACEHOLDER_RUNTIME_VERSION = "0.0.0";

export function selectRemoteRuntimeVersion(args: {
  markerVersion: string | null;
  executableVersion: string | null;
}): string | null {
  if (args.executableVersion && args.executableVersion !== PLACEHOLDER_RUNTIME_VERSION) {
    return args.executableVersion;
  }
  return args.markerVersion ?? args.executableVersion;
}

export function shouldUploadBundledRuntime(args: {
  localBinaryAvailable: boolean;
  executableVersion: string | null;
  markerVersion?: string | null;
  appVersion: string;
  localBinarySha256?: string | null;
  remoteBinarySha256?: string | null;
  remoteBinaryMatchesLocal?: boolean | null;
}): boolean {
  if (!args.localBinaryAvailable) return false;
  const installedVersion = selectRemoteRuntimeVersion({
    markerVersion: args.markerVersion ?? null,
    executableVersion: args.executableVersion,
  });
  if (installedVersion !== args.appVersion) return true;
  if (args.remoteBinaryMatchesLocal != null) {
    return !args.remoteBinaryMatchesLocal;
  }
  if (args.localBinarySha256) {
    return args.remoteBinarySha256 !== args.localBinarySha256;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const MACHINE_PROJECT_CAPABILITIES = [
  "browseDirectories",
  "getDetail",
  "getWorkSummary",
  "getDefaultParentDir",
  "create",
  "clone",
  "listMyGitHubRepos",
] as const satisfies readonly RemoteRuntimeMachineProjectCapability[];

type RemoteRuntimeInitializeInfo = {
  version: string | null;
  packageChannel: string | null;
  capabilities: RemoteRuntimeCapabilities;
  compatibilityWarnings: string[];
};

export function validateRemoteRuntimeInitializeResult(args: {
  result: unknown;
  expectedVersion: string | null;
  expectedLayout?: RemoteRuntimeLayout;
}): RemoteRuntimeInitializeInfo {
  if (!isRecord(args.result)) {
    throw new Error("Remote ADE service returned an invalid initialize response.");
  }
  const runtimeInfo = isRecord(args.result.runtimeInfo) ? args.result.runtimeInfo : {};
  const capabilities = isRecord(args.result.capabilities) ? args.result.capabilities : {};
  if (runtimeInfo.multiProject !== true || capabilities.projects !== true) {
    throw new Error("Remote ADE service does not support multi-project mode. Update the ADE service on that machine.");
  }
  const machineProjects = isRecord(capabilities.machineProjects)
    ? capabilities.machineProjects
    : {};
  const normalizedMachineProjects: RemoteRuntimeCapabilities["machineProjects"] = {};
  for (const capability of MACHINE_PROJECT_CAPABILITIES) {
    normalizedMachineProjects[capability] = machineProjects[capability] === true;
  }
  const version = typeof runtimeInfo.version === "string" && runtimeInfo.version.trim()
    ? runtimeInfo.version.trim()
    : null;
  const compatibilityWarnings: string[] = [];
  if (args.expectedVersion && version !== args.expectedVersion) {
    const expected = args.expectedVersion;
    const actual = version ?? "unknown";
    compatibilityWarnings.push(
      `Remote ADE service reported ${actual}; local ADE is ${expected}. ADE will connect because the RPC capabilities are compatible.`,
    );
  }
  const missing = MACHINE_PROJECT_CAPABILITIES.filter((capability) => machineProjects[capability] !== true);
  if (missing.length) {
    compatibilityWarnings.push(
      `Remote ADE service is missing project capabilities: ${missing.join(", ")}. Some remote project actions will ask you to update ADE on that machine.`,
    );
  }
  const packageChannel = typeof runtimeInfo.packageChannel === "string" && runtimeInfo.packageChannel.trim()
    ? runtimeInfo.packageChannel.trim()
    : null;
  const expectedChannel = args.expectedLayout?.channel ?? null;
  if (expectedChannel && packageChannel && packageChannel !== expectedChannel) {
    compatibilityWarnings.push(
      `Connected to ADE ${packageChannel} runtime from ADE ${expectedChannel}; compatible RPC features remain available.`,
    );
  }
  return {
    version,
    packageChannel,
    capabilities: {
      projects: true,
      machineProjects: normalizedMachineProjects,
    },
    compatibilityWarnings,
  };
}

type RemoteRuntimeChannel = "alpha" | "beta" | null;

type RemoteRuntimeLayout = {
  channel: RemoteRuntimeChannel;
  homeDirName: ".ade" | ".ade-alpha" | ".ade-beta";
  homeDirExpr: string;
  binDirExpr: string;
  binDirRelative: string;
  runtimeDirExpr: string;
  runtimeDirRelative: string;
  binaryExpr: string;
  binaryRelative: string;
  versionExpr: string;
  sha256Expr: string;
  ptyHostWorkerExpr: string;
  ptyHostWorkerSha256Expr: string;
};

function normalizeRemoteRuntimeChannel(value: unknown): RemoteRuntimeChannel {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "alpha" || normalized === "beta") return normalized;
  return null;
}

export function resolveRemoteRuntimeLayout(env: NodeJS.ProcessEnv = process.env): RemoteRuntimeLayout {
  const channel = normalizeRemoteRuntimeChannel(env.ADE_PACKAGE_CHANNEL);
  const homeDirName = channel === "alpha"
    ? ".ade-alpha"
    : channel === "beta"
      ? ".ade-beta"
      : ".ade";
  const homeDirExpr = `$HOME/${homeDirName}`;
  const binDirExpr = `${homeDirExpr}/bin`;
  const runtimeDirExpr = `${homeDirExpr}/runtime`;
  return {
    channel,
    homeDirName,
    homeDirExpr,
    binDirExpr,
    binDirRelative: `${homeDirName}/bin`,
    runtimeDirExpr,
    runtimeDirRelative: `${homeDirName}/runtime`,
    binaryExpr: `${binDirExpr}/ade`,
    binaryRelative: `${homeDirName}/bin/ade`,
    versionExpr: `${binDirExpr}/ade.version`,
    sha256Expr: `${binDirExpr}/ade.sha256`,
    ptyHostWorkerExpr: `${runtimeDirExpr}/ptyHostWorker.cjs`,
    ptyHostWorkerSha256Expr: `${runtimeDirExpr}/ptyHostWorker.cjs.sha256`,
  };
}

export function resolveRemoteRuntimeLayoutCandidates(env: NodeJS.ProcessEnv = process.env): RemoteRuntimeLayout[] {
  const preferred = resolveRemoteRuntimeLayout(env);
  const candidateEnvs: NodeJS.ProcessEnv[] = [
    {},
    { ADE_PACKAGE_CHANNEL: "beta" } as NodeJS.ProcessEnv,
    { ADE_PACKAGE_CHANNEL: "alpha" } as NodeJS.ProcessEnv,
  ];
  const candidates = [preferred, ...candidateEnvs.map((candidateEnv) => resolveRemoteRuntimeLayout(candidateEnv))];
  const seen = new Set<string>();
  return candidates.filter((layout) => {
    if (seen.has(layout.homeDirName)) return false;
    seen.add(layout.homeDirName);
    return true;
  });
}

export function buildRemoteRuntimeEnvironmentPrefix(args: {
  archLabel: string;
  nativeDepsReady: boolean;
  layout?: RemoteRuntimeLayout;
  disableRuntimeServiceInstall?: boolean;
  ptyHostWorkerReady?: boolean;
  ptyHostWorkerNodePath?: string | null;
  ptyHostWorkerCommandExpr?: string | null;
}): string {
  const layout = args.layout ?? resolveRemoteRuntimeLayout();
  const parts = [
    `ADE_HOME="${layout.homeDirExpr}"`,
    `PATH="${layout.binDirExpr}:$HOME/.local/bin:$HOME/.npm-global/bin${"${PATH:+:$PATH}"}"`,
    `ADE_DEFAULT_ROLE="cto"`,
  ];
  if (layout.channel) {
    parts.push(`ADE_PACKAGE_CHANNEL="${layout.channel}"`);
  }
  if (layout.channel || args.disableRuntimeServiceInstall) {
    parts.push("ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1");
  }
  if (args.nativeDepsReady) {
    parts.push(`NODE_PATH="${layout.runtimeDirExpr}/${args.archLabel}/node_modules${"${NODE_PATH:+:$NODE_PATH}"}"`);
  }
  if (args.ptyHostWorkerReady) {
    if (args.ptyHostWorkerNodePath) {
      parts.push(`ADE_PTY_HOST_WORKER_PATH="${layout.ptyHostWorkerExpr}"`);
      parts.push(`ADE_PTY_HOST_WORKER_NODE=${shellQuote(args.ptyHostWorkerNodePath)}`);
    } else if (args.ptyHostWorkerCommandExpr) {
      parts.push(`ADE_PTY_HOST_WORKER_COMMAND="${args.ptyHostWorkerCommandExpr}"`);
    }
  }
  return `${parts.join(" ")} `;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function bundledRuntimePath(resourcesPath: string, archLabel: string): string | null {
  const candidates = [
    path.join(resourcesPath, "runtime", `ade-${archLabel}`),
    path.join(resourcesPath, "app.asar.unpacked", "runtime", `ade-${archLabel}`),
    path.resolve(process.cwd(), "resources", "runtime", `ade-${archLabel}`),
  ];
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

function bundledNativeDepsPath(resourcesPath: string, archLabel: string): string | null {
  const archiveName = `ade-${archLabel}.native.tar.gz`;
  const candidates = [
    path.join(resourcesPath, "runtime", archiveName),
    path.join(resourcesPath, "app.asar.unpacked", "runtime", archiveName),
    path.resolve(process.cwd(), "resources", "runtime", archiveName),
  ];
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

function bundledPtyHostWorkerPath(resourcesPath: string, localBinaryPath: string | null): string | null {
  const candidates = [
    path.join(resourcesPath, "ade-cli", "ptyHostWorker.cjs"),
    path.join(resourcesPath, "app.asar.unpacked", "ade-cli", "ptyHostWorker.cjs"),
  ];
  if (localBinaryPath) {
    const localBinaryDir = path.dirname(localBinaryPath);
    const desktopRuntimeDir = path.resolve(process.cwd(), "resources", "runtime");
    const repoRuntimeDir = path.resolve(process.cwd(), "apps", "desktop", "resources", "runtime");
    if (localBinaryDir === desktopRuntimeDir) {
      candidates.push(path.resolve(process.cwd(), "../ade-cli/dist/ptyHostWorker.cjs"));
    }
    if (localBinaryDir === repoRuntimeDir) {
      candidates.push(path.resolve(process.cwd(), "apps/ade-cli/dist/ptyHostWorker.cjs"));
    }
  }
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

type LocalArtifactHashCacheEntry = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string;
};

const localArtifactHashCache = new Map<string, LocalArtifactHashCacheEntry>();

function hashRuntimeBinary(localPath: string): string {
  const stat = fs.statSync(localPath);
  const cached = localArtifactHashCache.get(localPath);
  if (
    cached &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.ctimeMs === stat.ctimeMs
  ) {
    return cached.sha256;
  }
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(localPath)).digest("hex");
  localArtifactHashCache.set(localPath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    sha256,
  });
  return sha256;
}

function fileSizeBytes(localPath: string): number {
  return fs.statSync(localPath).size;
}

function remoteUploadTempSuffix(): string {
  return `upload-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.tmp`;
}

function remoteUploadAppendCommand(remoteFileExpr: string): string {
  return [
    "umask 077",
    `cat >> ${remoteFileExpr} & ade_upload_pid=$!`,
    `( sleep ${REMOTE_ARTIFACT_UPLOAD_WATCHDOG_SECONDS}; kill "$ade_upload_pid" >/dev/null 2>&1 ) & ade_upload_watchdog=$!`,
    "wait \"$ade_upload_pid\"",
    "ade_upload_status=$?",
    "kill \"$ade_upload_watchdog\" >/dev/null 2>&1 || true",
    "wait \"$ade_upload_watchdog\" 2>/dev/null || true",
    "exit \"$ade_upload_status\"",
  ].join("; ");
}

async function execSshOrThrow(client: Client, command: string, fallback: string): Promise<void> {
  const result = await execSsh(client, command);
  if (result.code === 0) return;
  throw new Error(result.stderr.trim() || result.stdout.trim() || fallback);
}

async function resolveRemoteUploadPath(client: Client, remoteFileExpr: string): Promise<string> {
  const result = await execSsh(client, `printf '%s' ${remoteFileExpr}`);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to resolve remote ADE service artifact path.");
  }
  const remotePath = result.stdout.trim();
  if (!remotePath) {
    throw new Error("Remote ADE service artifact path resolved to an empty value.");
  }
  return remotePath;
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(sftp);
    });
  });
}

async function uploadSftpFile(
  client: Client,
  localPath: string,
  remoteFileExpr: string,
  totalBytes: number,
): Promise<void> {
  const remotePath = await resolveRemoteUploadPath(client, remoteFileExpr);
  const sftp = await openSftp(client);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let transferredBytes = 0;
      let timeout: NodeJS.Timeout | null = null;
      let idleTimeout: NodeJS.Timeout | null = null;

      const uploadProgressSuffix = (): string =>
        transferredBytes > 0 ? ` after ${transferredBytes} transferred bytes` : "";

      const clearTimers = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (idleTimeout) {
          clearTimeout(idleTimeout);
          idleTimeout = null;
        }
      };

      const closeSftp = (destroy: boolean): void => {
        try {
          if (destroy) sftp.destroy();
          else sftp.end();
        } catch {}
      };

      const settle = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (error) {
          closeSftp(true);
          reject(error);
          return;
        }
        resolve();
      };

      const resetIdleTimer = (): void => {
        if (idleTimeout) clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => {
          settle(new Error(`Timed out uploading ADE service artifact with SFTP: no transfer progress for ${REMOTE_ARTIFACT_UPLOAD_IDLE_TIMEOUT_MS}ms${uploadProgressSuffix()}.`));
        }, REMOTE_ARTIFACT_UPLOAD_IDLE_TIMEOUT_MS);
        idleTimeout.unref?.();
      };

      timeout = setTimeout(() => {
        settle(new Error(`Timed out uploading ADE service artifact with SFTP after ${REMOTE_ARTIFACT_UPLOAD_TIMEOUT_MS}ms${uploadProgressSuffix()}.`));
      }, REMOTE_ARTIFACT_UPLOAD_TIMEOUT_MS);
      timeout.unref?.();
      resetIdleTimer();

      sftp.fastPut(localPath, remotePath, {
        concurrency: 4,
        chunkSize: 256 * 1024,
        fileSize: totalBytes,
        mode: 0o600,
        step: (total) => {
          transferredBytes = total;
          resetIdleTimer();
        },
      }, (error) => {
        if (error) {
          settle(new Error(`Unable to upload ADE service artifact with SFTP${uploadProgressSuffix()}: ${error.message}`));
          return;
        }
        settle(null);
      });
    });
  } finally {
    try {
      sftp.end();
    } catch {}
  }
}

function remoteSha256Expr(fileExpr: string): string {
  return `(command -v shasum >/dev/null 2>&1 && shasum -a 256 ${fileExpr} || sha256sum ${fileExpr}) | awk '{print $1}'`;
}

function remoteFileMatchesCommand(fileExpr: string, expectedSize: number, expectedSha256: string): string {
  return [
    `test "$(wc -c < ${fileExpr} | tr -d '[:space:]')" = ${shellQuote(String(expectedSize))}`,
    `test "$(${remoteSha256Expr(fileExpr)})" = ${shellQuote(expectedSha256)}`,
  ].join(" && ");
}

const REMOTE_ARTIFACT_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const REMOTE_ARTIFACT_UPLOAD_IDLE_TIMEOUT_MS = 45_000;
const REMOTE_ARTIFACT_UPLOAD_WATCHDOG_SECONDS = Math.ceil(
  REMOTE_ARTIFACT_UPLOAD_IDLE_TIMEOUT_MS / 1000,
) + 30;
const REMOTE_ARTIFACT_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const REMOTE_ARTIFACT_UPLOAD_NO_PROGRESS_RETRIES = 2;

function openSshArgsForRoute(
  target: RemoteRuntimeTarget,
  route: ConnectedSshRoute,
  connectedConfig: Pick<ConnectConfig, "host" | "port" | "username"> | null | undefined,
  remoteCommand: string,
): string[] {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  const identityFile = target.sshKeyPath?.trim();
  if (identityFile) args.push("-i", identityFile);
  const port = connectedConfig?.port ?? route.port ?? target.port;
  if (port) args.push("-p", String(port));
  const user = connectedConfig?.username?.trim() || target.sshUser?.trim();
  const host = connectedConfig?.host?.trim() || route.hostname;
  args.push(user ? `${user}@${host}` : host);
  args.push(remoteCommand);
  return args;
}

async function writeTemporaryUploadChunk(chunk: Buffer): Promise<{ path: string; remove: () => Promise<void> }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-remote-upload-"));
  const filePath = path.join(dir, "chunk.bin");
  await fs.promises.writeFile(filePath, chunk, { mode: 0o600 });
  return {
    path: filePath,
    remove: () => fs.promises.rm(dir, { recursive: true, force: true }),
  };
}

async function uploadSshChunk(
  client: Client,
  target: RemoteRuntimeTarget,
  route: ConnectedSshRoute,
  connectedConfig: Pick<ConnectConfig, "host" | "port" | "username"> | null | undefined,
  remoteFileExpr: string,
  chunk: Buffer,
  committedBytes: number,
): Promise<void> {
  try {
    await uploadSshChunkViaConnectedClient(client, remoteFileExpr, chunk, committedBytes);
    return;
  } catch (error) {
    if ((error as { wroteToChannel?: boolean }).wroteToChannel) {
      throw error;
    }
    try {
      await uploadSshChunkViaOpenSsh(target, route, connectedConfig, remoteFileExpr, chunk, committedBytes);
    } catch (fallbackError) {
      const primaryMessage = error instanceof Error ? error.message : String(error);
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Unable to upload ADE service artifact over the existing SSH session: ${primaryMessage}; OpenSSH fallback failed: ${fallbackMessage}`);
    }
  }
}

async function uploadSshChunkViaConnectedClient(
  client: Client,
  remoteFileExpr: string,
  chunk: Buffer,
  committedBytes: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let wroteToChannel = false;
    let stderr = "";
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let idleTimeout: NodeJS.Timeout | null = null;
    let channelRef: { close?: () => void; destroy?: () => void } | null = null;

    const uploadProgressSuffix = (): string =>
      committedBytes > 0 ? ` after ${committedBytes} committed bytes` : "";

    const markError = (error: Error): Error => {
      (error as Error & { wroteToChannel?: boolean }).wroteToChannel = wroteToChannel;
      return error;
    };

    const clearTimers = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
      }
    };

    const closeChannel = (): void => {
      try {
        channelRef?.close?.();
      } catch {}
      try {
        channelRef?.destroy?.();
      } catch {}
    };

    const settle = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error) {
        closeChannel();
        reject(markError(error));
        return;
      }
      resolve();
    };

    const resetIdleTimer = (): void => {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        settle(new Error(`Timed out uploading ADE service artifact: no remote chunk completion for ${REMOTE_ARTIFACT_UPLOAD_IDLE_TIMEOUT_MS}ms${uploadProgressSuffix()}.`));
      }, REMOTE_ARTIFACT_UPLOAD_IDLE_TIMEOUT_MS);
      idleTimeout.unref?.();
    };

    timeout = setTimeout(() => {
      settle(new Error(`Timed out uploading ADE service artifact after ${REMOTE_ARTIFACT_UPLOAD_TIMEOUT_MS}ms${uploadProgressSuffix()}.`));
    }, REMOTE_ARTIFACT_UPLOAD_TIMEOUT_MS);
    timeout.unref?.();
    resetIdleTimer();

    client.exec(remoteUploadAppendCommand(remoteFileExpr), (error, channel) => {
      if (error) {
        settle(new Error(`SSH upload channel failed${uploadProgressSuffix()}: ${error.message}`));
        return;
      }
      channelRef = channel as unknown as { close?: () => void; destroy?: () => void };
      channel.resume();
      channel.stderr?.on("data", (data: Buffer | string) => {
        stderr += data.toString();
      });
      channel.on("exit", (code: number | null, signal: string | null) => {
        exitCode = typeof code === "number" ? code : null;
        exitSignal = signal ?? null;
      });
      channel.on("error", (channelError: Error) => {
        settle(new Error(`SSH upload channel failed${uploadProgressSuffix()}: ${channelError.message}`));
      });
      channel.on("close", () => {
        if (exitCode && exitCode !== 0) {
          const detail = stderr.trim() || `remote command exited with code ${exitCode}`;
          settle(new Error(`Unable to upload ADE service artifact: ${detail}`));
          return;
        }
        if (exitSignal) {
          const detail = stderr.trim() || `remote command exited with signal ${exitSignal}`;
          settle(new Error(`Unable to upload ADE service artifact: ${detail}`));
          return;
        }
        settle(null);
      });
      const finishWrite = (): void => {
        try {
          channel.end();
        } catch (writeError) {
          settle(new Error(`SSH upload channel failed${uploadProgressSuffix()}: ${writeError instanceof Error ? writeError.message : String(writeError)}`));
        }
      };
      wroteToChannel = true;
      if (!channel.write(chunk)) {
        channel.once("drain", finishWrite);
      } else {
        finishWrite();
      }
    });
  });
}

async function uploadSshChunkViaOpenSsh(
  target: RemoteRuntimeTarget,
  route: ConnectedSshRoute,
  connectedConfig: Pick<ConnectConfig, "host" | "port" | "username"> | null | undefined,
  remoteFileExpr: string,
  chunk: Buffer,
  committedBytes: number,
): Promise<void> {
  const chunkFile = await writeTemporaryUploadChunk(chunk);
  const chunkHandle = await fs.promises.open(chunkFile.path, "r");
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = spawn("ssh", openSshArgsForRoute(target, route, connectedConfig, remoteUploadAppendCommand(remoteFileExpr)), {
        stdio: [chunkHandle.fd, "ignore", "pipe"],
      });
      let stderr = "";
      let timeout: NodeJS.Timeout | null = null;
      let idleTimeout: NodeJS.Timeout | null = null;

      const uploadProgressSuffix = (): string =>
        committedBytes > 0 ? ` after ${committedBytes} committed bytes` : "";

      const clearTimers = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (idleTimeout) {
          clearTimeout(idleTimeout);
          idleTimeout = null;
        }
      };

      const resetIdleTimer = (): void => {
        if (idleTimeout) clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => {
          settle(new Error(`Timed out uploading ADE service artifact: no remote chunk completion for ${REMOTE_ARTIFACT_UPLOAD_IDLE_TIMEOUT_MS}ms${uploadProgressSuffix()}.`));
        }, REMOTE_ARTIFACT_UPLOAD_IDLE_TIMEOUT_MS);
        idleTimeout.unref?.();
      };

      const settle = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (error) {
          try { child.kill("SIGKILL"); } catch {}
          reject(error);
          return;
        }
        resolve();
      };

      timeout = setTimeout(() => {
        settle(new Error(`Timed out uploading ADE service artifact after ${REMOTE_ARTIFACT_UPLOAD_TIMEOUT_MS}ms${uploadProgressSuffix()}.`));
      }, REMOTE_ARTIFACT_UPLOAD_TIMEOUT_MS);
      timeout.unref?.();
      resetIdleTimer();

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        settle(new Error(`SSH upload process failed${uploadProgressSuffix()}: ${error.message}`));
      });
      child.on("close", (code, signal) => {
        if (code && code !== 0) {
          const detail = stderr.trim() || `ssh exited with code ${code}`;
          settle(new Error(`Unable to upload ADE service artifact: ${detail}`));
          return;
        }
        if (signal) {
          const detail = stderr.trim() || `ssh exited with signal ${signal}`;
          settle(new Error(`Unable to upload ADE service artifact: ${detail}`));
          return;
        }
        settle(null);
      });
    });
  } finally {
    await chunkHandle.close().catch(() => okIgnored());
    await chunkFile.remove();
  }
}

async function uploadSshFileInChunks(
  client: Client,
  target: RemoteRuntimeTarget,
  route: ConnectedSshRoute,
  connectedConfig: Pick<ConnectConfig, "host" | "port" | "username"> | null | undefined,
  localPath: string,
  remoteFileExpr: string,
  totalBytes: number,
): Promise<void> {
  const readRemoteBytes = async (): Promise<number> => {
    const result = await execSsh(client, `wc -c < ${remoteFileExpr} | tr -d '[:space:]'`);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to read remote ADE service artifact upload size.");
    }
    const value = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isFinite(value) || value < 0 || value > totalBytes) {
      throw new Error(`Remote ADE service artifact upload reported invalid size ${result.stdout.trim() || "<empty>"}.`);
    }
    return value;
  };
  const file = await fs.promises.open(localPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(REMOTE_ARTIFACT_UPLOAD_CHUNK_BYTES);
    let committedBytes = 0;
    let noProgressRetries = 0;
    while (committedBytes < totalBytes) {
      const targetBytes = Math.min(REMOTE_ARTIFACT_UPLOAD_CHUNK_BYTES, totalBytes - committedBytes);
      const { bytesRead } = await file.read(buffer, 0, targetBytes, committedBytes);
      if (bytesRead <= 0) {
        throw new Error(`Unable to read ADE service artifact after ${committedBytes} bytes.`);
      }
      try {
        await uploadSshChunk(client, target, route, connectedConfig, remoteFileExpr, buffer.subarray(0, bytesRead), committedBytes);
      } catch (error) {
        const remoteBytes = await readRemoteBytes();
        if (remoteBytes > committedBytes) {
          committedBytes = remoteBytes;
          noProgressRetries = 0;
          continue;
        }
        noProgressRetries += 1;
        if (noProgressRetries <= REMOTE_ARTIFACT_UPLOAD_NO_PROGRESS_RETRIES) {
          continue;
        }
        throw error;
      }
      const remoteBytes = committedBytes + bytesRead;
      const actualRemoteBytes = await readRemoteBytes();
      if (actualRemoteBytes !== remoteBytes) {
        if (actualRemoteBytes > committedBytes) {
          committedBytes = actualRemoteBytes;
          noProgressRetries = 0;
          continue;
        }
        throw new Error(`Uploaded ADE service artifact stopped at ${actualRemoteBytes} bytes.`);
      }
      committedBytes = remoteBytes;
      noProgressRetries = 0;
    }
  } finally {
    await file.close();
  }
}

async function uploadSshFile(
  client: Client,
  target: RemoteRuntimeTarget,
  route: ConnectedSshRoute,
  connectedConfig: Pick<ConnectConfig, "host" | "port" | "username"> | null | undefined,
  localPath: string,
  remoteFileExpr: string,
): Promise<void> {
  const totalBytes = fileSizeBytes(localPath);
  const prepareRemoteFile = async (): Promise<void> => {
    await execSshOrThrow(
      client,
      `rm -f ${remoteFileExpr} && umask 077 && : > ${remoteFileExpr} && chmod 600 ${remoteFileExpr}`,
      "Unable to prepare remote ADE service artifact upload.",
    );
  };

  await prepareRemoteFile();
  try {
    await uploadSftpFile(client, localPath, remoteFileExpr, totalBytes);
    return;
  } catch (sftpError) {
    await prepareRemoteFile();
    try {
      await uploadSshFileInChunks(client, target, route, connectedConfig, localPath, remoteFileExpr, totalBytes);
    } catch (streamError) {
      const sftpMessage = sftpError instanceof Error ? sftpError.message : String(sftpError);
      const streamMessage = streamError instanceof Error ? streamError.message : String(streamError);
      throw new Error(`Unable to upload ADE service artifact with SFTP: ${sftpMessage}; SSH stream fallback failed: ${streamMessage}`);
    }
  }
}

async function uploadRuntimeBinary(
  client: Client,
  target: RemoteRuntimeTarget,
  route: ConnectedSshRoute,
  connectedConfig: Pick<ConnectConfig, "host" | "port" | "username"> | null | undefined,
  layout: RemoteRuntimeLayout,
  localPath: string,
  appVersion: string,
  localBinarySha256: string,
): Promise<void> {
  const tempSuffix = remoteUploadTempSuffix();
  const tempExpr = `${layout.binaryExpr}.${tempSuffix}`;
  await execSshOrThrow(
    client,
    `mkdir -p ${layout.binDirExpr} && chmod 700 ${layout.binDirExpr}`,
    "Unable to create the remote ADE service directory.",
  );
  try {
    await uploadSshFile(client, target, route, connectedConfig, localPath, tempExpr);
    await execSshOrThrow(client, [
      remoteFileMatchesCommand(tempExpr, fileSizeBytes(localPath), localBinarySha256),
      `chmod +x ${tempExpr}`,
      `mv -f ${tempExpr} ${layout.binaryExpr}`,
      `printf '%s\\n' ${shellQuote(appVersion)} > ${layout.versionExpr}`,
      `printf '%s\\n' ${shellQuote(localBinarySha256)} > ${layout.sha256Expr}`,
      `chmod 600 ${layout.versionExpr}`,
      `chmod 600 ${layout.sha256Expr}`,
    ].join(" && "), "Uploaded ADE service did not pass size and checksum verification.");
  } catch (error) {
    await execSsh(client, `rm -f ${tempExpr}`).catch(() => okIgnored());
    throw error;
  }
}

function okIgnored(): void {}

async function uploadNativeDepsBundle(
  client: Client,
  target: RemoteRuntimeTarget,
  route: ConnectedSshRoute,
  connectedConfig: Pick<ConnectConfig, "host" | "port" | "username"> | null | undefined,
  layout: RemoteRuntimeLayout,
  archLabel: string,
  localPath: string,
  appVersion: string,
): Promise<void> {
  const localSha256 = hashRuntimeBinary(localPath);
  const remoteArchiveExpr = `${layout.runtimeDirExpr}/ade-${archLabel}.native.tar.gz`;
  const tempSuffix = remoteUploadTempSuffix();
  const tempExpr = `${remoteArchiveExpr}.${tempSuffix}`;
  await execSshOrThrow(
    client,
    `mkdir -p ${layout.runtimeDirExpr}`,
    "Unable to create the remote ADE native dependency directory.",
  );
  try {
    await uploadSshFile(client, target, route, connectedConfig, localPath, tempExpr);
    const extract = await execSsh(client, [
      remoteFileMatchesCommand(tempExpr, fileSizeBytes(localPath), localSha256),
      `mv -f ${tempExpr} ${remoteArchiveExpr}`,
      `rm -rf ${layout.runtimeDirExpr}/${archLabel}`,
      `mkdir -p ${layout.runtimeDirExpr}/${archLabel}`,
      `tar -xzf ${remoteArchiveExpr} -C ${layout.runtimeDirExpr}/${archLabel}`,
      `printf '%s\\n' ${shellQuote(appVersion)} > ${layout.runtimeDirExpr}/${archLabel}/.ade-version`,
    ].join(" && "));
    if (extract.code !== 0) {
      throw new Error(extract.stderr.trim() || "Unable to unpack ADE service native dependencies on the remote machine.");
    }
  } catch (error) {
    await execSsh(client, `rm -f ${tempExpr}`).catch(() => okIgnored());
    throw error;
  }
}

async function uploadPtyHostWorker(
  client: Client,
  target: RemoteRuntimeTarget,
  route: ConnectedSshRoute,
  connectedConfig: Pick<ConnectConfig, "host" | "port" | "username"> | null | undefined,
  layout: RemoteRuntimeLayout,
  localPath: string,
  localSha256: string,
): Promise<void> {
  const tempSuffix = remoteUploadTempSuffix();
  const tempExpr = `${layout.ptyHostWorkerExpr}.${tempSuffix}`;
  await execSshOrThrow(
    client,
    `mkdir -p ${layout.runtimeDirExpr}`,
    "Unable to create the remote ADE runtime artifact directory.",
  );
  try {
    await uploadSshFile(client, target, route, connectedConfig, localPath, tempExpr);
    await execSshOrThrow(client, [
      remoteFileMatchesCommand(tempExpr, fileSizeBytes(localPath), localSha256),
      `mv -f ${tempExpr} ${layout.ptyHostWorkerExpr}`,
      `printf '%s\\n' ${shellQuote(localSha256)} > ${layout.ptyHostWorkerSha256Expr}`,
      `chmod 600 ${layout.ptyHostWorkerExpr}`,
      `chmod 600 ${layout.ptyHostWorkerSha256Expr}`,
    ].join(" && "), "Uploaded ADE PTY host worker did not pass size and checksum verification.");
  } catch (error) {
    await execSsh(client, `rm -f ${tempExpr}`).catch(() => okIgnored());
    throw error;
  }
}

async function signUploadedRuntimeBinaryIfNeeded(client: Client, layout: RemoteRuntimeLayout, platform: string): Promise<void> {
  if (platform !== "darwin") return;
  const signed = await execSsh(client, `codesign --force --sign - ${layout.binaryExpr}`);
  if (signed.code !== 0) {
    throw new Error(
      signed.stderr.trim() ||
      signed.stdout.trim() ||
      "Uploaded ADE service could not be signed on the remote Mac.",
    );
  }
}

async function stopRemoteRuntimeDaemon(client: Client, layout: RemoteRuntimeLayout, runtimeEnvPrefix: string): Promise<void> {
  await execSsh(
    client,
    `${runtimeEnvPrefix}${layout.binaryExpr} runtime stop --text >/dev/null 2>&1 || true`,
  );
}

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openValidatedRuntimeClient(args: {
  ssh: Client;
  command: string;
  appVersion: string;
  expectedVersion: string | null;
  expectedLayout?: RemoteRuntimeLayout;
}): Promise<{ client: RuntimeRpcClient; initializeInfo: RemoteRuntimeInitializeInfo }> {
  const transport = await openSshRuntimeTransport(args.ssh, args.command);
  const client = new RuntimeRpcClient(transport);
  try {
    const initializeResult = await client.initialize(
      "ade-desktop-remote",
      args.appVersion,
    );
    const initializeInfo = validateRemoteRuntimeInitializeResult({
      result: initializeResult,
      expectedVersion: args.expectedVersion,
      expectedLayout: args.expectedLayout,
    });
    return { client, initializeInfo };
  } catch (error) {
    client.close();
    throw error;
  }
}

export function coerceProjects(value: unknown): RemoteRuntimeProjectRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const projectId = typeof record.projectId === "string" ? record.projectId : "";
    const rootPath = typeof record.rootPath === "string" ? record.rootPath : "";
    if (!projectId || !rootPath) return [];
    return [{
      projectId,
      rootPath,
      displayName: typeof record.displayName === "string" ? record.displayName : path.basename(rootPath),
      addedAt: typeof record.addedAt === "number" ? record.addedAt : 0,
      lastOpenedAt: typeof record.lastOpenedAt === "number" ? record.lastOpenedAt : 0,
      gitOriginUrl: typeof record.gitOriginUrl === "string" ? record.gitOriginUrl : null,
    }];
  });
}


export function markRemoteTargetRouteSucceeded(args: {
  target: RemoteRuntimeTarget;
  route: RemoteRuntimeTargetRoute;
  nowMs: number;
}): RemoteRuntimeTargetRoute[] {
  const routes = normalizeRemoteTargetRoutes({
    hostname: args.target.hostname,
    port: args.target.port,
    routes: args.target.routes,
  });
  const successKey = routeKey(args.route);
  let matched = false;
  const updated = routes.map((route) => {
    if (routeKey(route) !== successKey) return route;
    matched = true;
    return {
      ...route,
      source:
        route.source === "manual" && args.route.source !== "manual"
          ? args.route.source
          : route.source,
      lastSucceededAt: args.nowMs,
    };
  });
  if (!matched) {
    updated.push({ ...args.route, lastSucceededAt: args.nowMs });
  }
  return updated;
}

export async function bootstrapRemoteRuntime(args: {
  target: RemoteRuntimeTarget;
  registry: RemoteTargetRegistry;
  resourcesPath: string;
  appVersion: string;
}): Promise<{ client: RuntimeRpcClient; result: RemoteRuntimeConnectResult; ssh: Client }> {
  const { client: ssh, route: connectedRoute, config: connectedConfig } = await connectSshWithRoute(args.target);
  try {
    const uname = await execSsh(ssh, "uname -sm");
    if (uname.code !== 0) {
      throw new Error(uname.stderr.trim() || "Unable to detect remote architecture.");
    }
    const arch = normalizeRemoteArch(uname.stdout.trim());
    const preferredLayout = resolveRemoteRuntimeLayout();
    let layout = preferredLayout;
    let runtimeLayoutFallbackReason: string | null = null;
    const binaryMarkerCheck = await execSsh(ssh, `cat ${layout.versionExpr} 2>/dev/null || true`);
    let markedRuntimeVersion = normalizeRuntimeVersion(binaryMarkerCheck.stdout);
    const binaryHashCheck = await execSsh(ssh, `cat ${layout.sha256Expr} 2>/dev/null || true`);
    let remoteBinarySha256 = binaryHashCheck.stdout.trim() || null;
    const versionCheck = await execSsh(ssh, `test -x ${layout.binaryExpr} && ${layout.binaryExpr} --version || true`);
    let executableRuntimeVersion = normalizeRuntimeVersion(versionCheck.stdout);
    let runtimeVersion = selectRemoteRuntimeVersion({
      markerVersion: markedRuntimeVersion,
      executableVersion: executableRuntimeVersion,
    });
    const localBinary = bundledRuntimePath(args.resourcesPath, arch.label);
    const localBinarySha256 = localBinary ? hashRuntimeBinary(localBinary) : null;
    const nativeDepsBundle = bundledNativeDepsPath(args.resourcesPath, arch.label);
    const localPtyHostWorker = bundledPtyHostWorkerPath(args.resourcesPath, localBinary);
    const localPtyHostWorkerSha256 = localPtyHostWorker ? hashRuntimeBinary(localPtyHostWorker) : null;
    let remoteBinaryMatchesLocal: boolean | null = null;

    if (!localBinary && !executableRuntimeVersion) {
      for (const candidateLayout of resolveRemoteRuntimeLayoutCandidates().filter((candidate) => candidate.homeDirName !== layout.homeDirName)) {
        const candidateVersionCheck = await execSsh(
          ssh,
          `test -x ${candidateLayout.binaryExpr} && ${candidateLayout.binaryExpr} --version || true`,
        );
        const candidateExecutableVersion = normalizeRuntimeVersion(candidateVersionCheck.stdout);
        if (!candidateExecutableVersion) continue;
        const candidateMarkerCheck = await execSsh(ssh, `cat ${candidateLayout.versionExpr} 2>/dev/null || true`);
        const candidateHashCheck = await execSsh(ssh, `cat ${candidateLayout.sha256Expr} 2>/dev/null || true`);
        layout = candidateLayout;
        executableRuntimeVersion = candidateExecutableVersion;
        markedRuntimeVersion = normalizeRuntimeVersion(candidateMarkerCheck.stdout);
        remoteBinarySha256 = candidateHashCheck.stdout.trim() || null;
        runtimeVersion = selectRemoteRuntimeVersion({
          markerVersion: markedRuntimeVersion,
          executableVersion: executableRuntimeVersion,
        });
        runtimeLayoutFallbackReason = `Using remote runtime home ${layout.homeDirName} because ${preferredLayout.homeDirName} did not contain an ADE service for ${arch.label}.`;
        break;
      }
    }

    let runtimeUploaded = false;
    if (localBinary && localBinarySha256 && runtimeVersion === args.appVersion) {
      if (arch.platform === "darwin") {
        if (remoteBinarySha256 === localBinarySha256) {
          const binarySignatureCheck = await execSsh(
            ssh,
            `codesign --verify ${layout.binaryExpr} >/dev/null 2>&1 && echo ok || true`,
          );
          remoteBinaryMatchesLocal = binarySignatureCheck.stdout.trim() === "ok";
        } else {
          remoteBinaryMatchesLocal = false;
        }
      } else {
        const binaryContentCheck = await execSsh(
          ssh,
          `${remoteFileMatchesCommand(layout.binaryExpr, fileSizeBytes(localBinary), localBinarySha256)} && echo ok || true`,
        );
        remoteBinaryMatchesLocal = binaryContentCheck.stdout.trim() === "ok";
      }
    }

    const shouldUploadRuntime = Boolean(localBinary && localBinarySha256 && shouldUploadBundledRuntime({
      localBinaryAvailable: true,
      executableVersion: executableRuntimeVersion,
      markerVersion: markedRuntimeVersion,
      appVersion: args.appVersion,
      localBinarySha256,
      remoteBinarySha256,
      remoteBinaryMatchesLocal,
    }));

    const uploadBundledRuntime = async (): Promise<void> => {
      if (!localBinary || !localBinarySha256) return;
      await uploadRuntimeBinary(ssh, args.target, connectedRoute, connectedConfig, layout, localBinary, args.appVersion, localBinarySha256);
      await signUploadedRuntimeBinaryIfNeeded(ssh, layout, arch.platform);
      runtimeUploaded = true;
      runtimeVersion = args.appVersion;
    };

    if (shouldUploadRuntime) {
      await uploadBundledRuntime();
    }

    const ensureNativeDepsReady = async (forceUpload: boolean): Promise<boolean> => {
      if (!nativeDepsBundle) return false;
      const nativeDepsCheck = await execSsh(ssh, [
        `test -d ${layout.runtimeDirExpr}/${arch.label}/node_modules`,
        `test "$(cat ${layout.runtimeDirExpr}/${arch.label}/.ade-version 2>/dev/null)" = ${shellQuote(args.appVersion)}`,
        "echo ok",
      ].join(" && ") + " || true");
      const shouldUploadNativeDeps = forceUpload || nativeDepsCheck.stdout.trim() !== "ok";
      if (shouldUploadNativeDeps) {
        await uploadNativeDepsBundle(ssh, args.target, connectedRoute, connectedConfig, layout, arch.label, nativeDepsBundle, args.appVersion);
      }
      return true;
    };

    let nativeDepsReady = await ensureNativeDepsReady(runtimeUploaded);

    let ptyHostWorkerNodePath: string | null = null;
    let ptyHostWorkerCommandExpr: string | null = null;
    const ensurePtyHostWorkerReady = async (forceUpload: boolean): Promise<boolean> => {
      const nodePathCheck = await execSsh(ssh, "command -v node || true");
      ptyHostWorkerNodePath = nodePathCheck.stdout.trim().split(/\r?\n/u)[0]?.trim() || null;
      if (!ptyHostWorkerNodePath) {
        ptyHostWorkerCommandExpr = layout.binaryExpr;
        return true;
      }
      if (!localPtyHostWorker || !localPtyHostWorkerSha256) return false;
      const ptyHostWorkerCheck = await execSsh(ssh, [
        `test -f ${layout.ptyHostWorkerExpr}`,
        `test "$(cat ${layout.ptyHostWorkerSha256Expr} 2>/dev/null)" = ${shellQuote(localPtyHostWorkerSha256)}`,
        "echo ok",
      ].join(" && ") + " || true");
      const shouldUploadPtyHostWorker = forceUpload || ptyHostWorkerCheck.stdout.trim() !== "ok";
      if (shouldUploadPtyHostWorker) {
        await uploadPtyHostWorker(
          ssh,
          args.target,
          connectedRoute,
          connectedConfig,
          layout,
          localPtyHostWorker,
          localPtyHostWorkerSha256,
        );
      }
      return true;
    };

    const ptyHostWorkerReady = await ensurePtyHostWorkerReady(runtimeUploaded);

    let runtimeEnvPrefix = buildRemoteRuntimeEnvironmentPrefix({
      archLabel: arch.label,
      nativeDepsReady,
      layout,
      disableRuntimeServiceInstall: layout.homeDirName !== preferredLayout.homeDirName,
      ptyHostWorkerReady,
      ptyHostWorkerNodePath,
      ptyHostWorkerCommandExpr,
    });

    const verifyUploadedRuntime = async (): Promise<void> => {
      const uploadedVersionCheck = await execSsh(ssh, `${runtimeEnvPrefix}${layout.binaryExpr} --version`);
      const uploadedVersion = normalizeRuntimeVersion(uploadedVersionCheck.stdout);
      if (uploadedVersionCheck.code !== 0 || !uploadedVersion) {
        throw new Error(
          uploadedVersionCheck.stderr.trim()
          || "Uploaded ADE service did not report a version on the remote machine.",
        );
      }
      if (uploadedVersion !== args.appVersion) {
        throw new Error(`Uploaded ADE service version mismatch: expected ${args.appVersion}, got ${uploadedVersion}.`);
      }
      runtimeVersion = uploadedVersion;
    };

    if (runtimeUploaded) {
      await verifyUploadedRuntime();
      await stopRemoteRuntimeDaemon(ssh, layout, runtimeEnvPrefix);
    }

    if (!runtimeVersion) {
      const pathVersionCheck = await execSsh(ssh, `${runtimeEnvPrefix}ade --version || true`);
      runtimeVersion = normalizeRuntimeVersion(pathVersionCheck.stdout);
      if (!runtimeVersion) {
        throw new Error(`ADE service is not installed on the remote machine and no bundled ADE service is available for ${arch.label}.`);
      }
    }

    const command = localBinary || runtimeUploaded
      ? `${runtimeEnvPrefix}${layout.binaryExpr} rpc --stdio`
      : `${runtimeEnvPrefix}ade rpc --stdio`;
    let openedRuntime: Awaited<ReturnType<typeof openValidatedRuntimeClient>> | null = null;
    const expectedVersion = localBinary || runtimeUploaded ? args.appVersion : null;
    try {
      openedRuntime = await openValidatedRuntimeClient({
        ssh,
        command,
        appVersion: args.appVersion,
        expectedVersion,
        expectedLayout: layout,
      });
    } catch (error) {
      if (localBinary || runtimeUploaded) {
        throw error;
      }
      const attempted = [{ layout: layout.homeDirName, error: runtimeErrorMessage(error) }];
      for (const candidateLayout of resolveRemoteRuntimeLayoutCandidates().filter((candidate) => candidate.homeDirName !== layout.homeDirName)) {
        const candidateVersionCheck = await execSsh(
          ssh,
          `test -x ${candidateLayout.binaryExpr} && ${candidateLayout.binaryExpr} --version || true`,
        );
        const candidateRuntimeVersion = normalizeRuntimeVersion(candidateVersionCheck.stdout);
        if (!candidateRuntimeVersion) continue;
        const candidateNativeDepsCheck = await execSsh(
          ssh,
          `test -d ${candidateLayout.runtimeDirExpr}/${arch.label}/node_modules && echo ok || true`,
        );
        const candidateRuntimeEnvPrefix = buildRemoteRuntimeEnvironmentPrefix({
          archLabel: arch.label,
          nativeDepsReady: candidateNativeDepsCheck.stdout.trim() === "ok",
          layout: candidateLayout,
          disableRuntimeServiceInstall: true,
        });
        const candidateCommand = `${candidateRuntimeEnvPrefix}ade rpc --stdio`;
        try {
          openedRuntime = await openValidatedRuntimeClient({
            ssh,
            command: candidateCommand,
            appVersion: args.appVersion,
            expectedVersion: null,
            expectedLayout: candidateLayout,
          });
          runtimeLayoutFallbackReason = `Using remote runtime home ${candidateLayout.homeDirName} because ${layout.homeDirName} could not start a compatible ADE RPC service: ${runtimeErrorMessage(error)}`;
          layout = candidateLayout;
          runtimeVersion = candidateRuntimeVersion;
          break;
        } catch (candidateError) {
          attempted.push({ layout: candidateLayout.homeDirName, error: runtimeErrorMessage(candidateError) });
        }
      }
      if (!openedRuntime) {
        throw new Error(
          "Remote ADE service could not start a compatible RPC runtime. " +
            `Tried ${attempted.map((attempt) => `${attempt.layout}: ${attempt.error}`).join("; ")}.`,
        );
      }
    }
    if (!openedRuntime) {
      throw new Error("Remote ADE service could not start a compatible RPC runtime.");
    }
    const { client, initializeInfo } = openedRuntime;
    const projects = coerceProjects(await client.call("projects.list", {}));
    const connectedAt = Date.now();
    const compatibilityWarnings = [...initializeInfo.compatibilityWarnings];
    if (runtimeLayoutFallbackReason) {
      compatibilityWarnings.push(runtimeLayoutFallbackReason);
    } else if (layout.homeDirName !== preferredLayout.homeDirName) {
      compatibilityWarnings.push(
        `Using remote runtime home ${layout.homeDirName} instead of ${preferredLayout.homeDirName}.`,
      );
    }
    const updated = args.registry.update(args.target.id, {
      lastSeenArch: arch.label,
      runtimeBinaryVersion: initializeInfo.version ?? runtimeVersion,
      lastConnectedAt: connectedAt,
      routes: markRemoteTargetRouteSucceeded({
        target: args.target,
        route: connectedRoute,
        nowMs: connectedAt,
      }),
    });
    return {
      client,
      ssh,
      result: {
        target: updated,
        arch: arch.label,
        version: initializeInfo.version ?? runtimeVersion,
        capabilities: initializeInfo.capabilities,
        compatibilityWarnings,
        projects,
      },
    };
  } catch (error) {
    ssh.end();
    throw error;
  }
}

export async function ensureRemoteProject(client: RuntimeRpcClient, rootPath: string): Promise<RemoteRuntimeProjectRecord> {
  const project = await client.call("projects.add", { rootPath });
  const records = coerceProjects([project]);
  if (!records[0]) throw new Error("Remote ADE service did not return a project record.");
  return records[0];
}
