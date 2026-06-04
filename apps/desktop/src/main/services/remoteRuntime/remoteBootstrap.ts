import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Client } from "ssh2";
import type {
  RemoteRuntimeCapabilities,
  RemoteRuntimeConnectResult,
  RemoteRuntimeMachineProjectCapability,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetRoute,
} from "../../../shared/types/remoteRuntime";
import { RuntimeRpcClient } from "./runtimeRpcClient";
import { connectSshWithRoute, execSsh, openSshRuntimeTransport } from "./sshTransport";
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

export function selectRemoteRuntimeVersion(args: {
  markerVersion: string | null;
  executableVersion: string | null;
}): string | null {
  return args.executableVersion ?? args.markerVersion;
}

export function shouldUploadBundledRuntime(args: {
  localBinaryAvailable: boolean;
  executableVersion: string | null;
  appVersion: string;
  localBinarySha256?: string | null;
  remoteBinarySha256?: string | null;
}): boolean {
  if (!args.localBinaryAvailable) return false;
  if (args.executableVersion !== args.appVersion) return true;
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

function hashRuntimeBinary(localPath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(localPath)).digest("hex");
}

function fileSizeBytes(localPath: string): number {
  return fs.statSync(localPath).size;
}

function remoteUploadTempSuffix(): string {
  return `upload-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.tmp`;
}

async function execSshOrThrow(client: Client, command: string, fallback: string): Promise<void> {
  const result = await execSsh(client, command);
  if (result.code === 0) return;
  throw new Error(result.stderr.trim() || result.stdout.trim() || fallback);
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
const REMOTE_ARTIFACT_UPLOAD_IDLE_TIMEOUT_MS = 120_000;

async function uploadSshFile(client: Client, localPath: string, remoteFileExpr: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let readStream: fs.ReadStream | null = null;
    let uploadChannel: (NodeJS.WritableStream & {
      stderr?: NodeJS.ReadableStream;
      close?: () => void;
      destroy?: (error?: Error) => void;
    }) | null = null;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let stderr = "";
    let uploadedBytes = 0;
    let timeout: NodeJS.Timeout | null = null;
    let idleTimeout: NodeJS.Timeout | null = null;

    const uploadProgressSuffix = (): string =>
      uploadedBytes > 0 ? ` after ${uploadedBytes} bytes` : "";

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
        settle(new Error(`Timed out uploading ADE service artifact: no read or drain progress for ${REMOTE_ARTIFACT_UPLOAD_IDLE_TIMEOUT_MS}ms${uploadProgressSuffix()}.`));
      }, REMOTE_ARTIFACT_UPLOAD_IDLE_TIMEOUT_MS);
      idleTimeout.unref?.();
    };

    const onClientClose = (): void => {
      settle(new Error(`SSH connection closed while uploading ADE service artifact${uploadProgressSuffix()}.`));
    };
    const onClientEnd = (): void => {
      settle(new Error(`SSH connection ended while uploading ADE service artifact${uploadProgressSuffix()}.`));
    };
    const onClientError = (error: Error): void => {
      settle(new Error(`SSH connection failed while uploading ADE service artifact${uploadProgressSuffix()}: ${error.message}`));
    };

    const removeClientListeners = (): void => {
      client.off("close", onClientClose);
      client.off("end", onClientEnd);
      client.off("error", onClientError);
    };

    const settle = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      removeClientListeners();
      if (error) {
        try {
          readStream?.destroy();
        } catch {}
        try {
          uploadChannel?.close?.();
        } catch {}
        try {
          uploadChannel?.destroy?.(error);
        } catch {}
        reject(error);
        return;
      }
      resolve();
    };

    client.once("close", onClientClose);
    client.once("end", onClientEnd);
    client.once("error", onClientError);

    timeout = setTimeout(() => {
      settle(new Error(`Timed out uploading ADE service artifact after ${REMOTE_ARTIFACT_UPLOAD_TIMEOUT_MS}ms${uploadProgressSuffix()}.`));
    }, REMOTE_ARTIFACT_UPLOAD_TIMEOUT_MS);
    timeout.unref?.();
    resetIdleTimer();

    client.exec(`umask 077; cat > ${remoteFileExpr}`, (error, channel) => {
      if (error) {
        settle(error);
        return;
      }
      uploadChannel = channel as typeof uploadChannel;
      readStream = fs.createReadStream(localPath);
      channel.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      channel.on("exit", (code: number | null, signal: string | null) => {
        exitCode = code;
        exitSignal = signal;
      });
      channel.on("error", (streamError: Error) => {
        settle(streamError);
      });
      channel.on("drain", () => {
        resetIdleTimer();
      });
      readStream.on("data", (chunk: Buffer | string) => {
        uploadedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        resetIdleTimer();
      });
      readStream.on("end", () => {
        resetIdleTimer();
      });
      readStream.on("error", (streamError) => {
        settle(streamError);
      });
      channel.on("close", (code: number | null, signal: string | null) => {
        const resolvedCode = code ?? exitCode;
        const resolvedSignal = signal ?? exitSignal;
        if (resolvedCode && resolvedCode !== 0) {
          const detail = stderr.trim() || `remote command exited with code ${resolvedCode}`;
          settle(new Error(`Unable to upload ADE service artifact: ${detail}`));
          return;
        }
        if (resolvedSignal) {
          const detail = stderr.trim() || `remote command exited with signal ${resolvedSignal}`;
          settle(new Error(`Unable to upload ADE service artifact: ${detail}`));
          return;
        }
        settle(null);
      });
      readStream.pipe(channel);
    });
  });
}

async function uploadRuntimeBinary(client: Client, layout: RemoteRuntimeLayout, localPath: string, appVersion: string, localBinarySha256: string): Promise<void> {
  const tempSuffix = remoteUploadTempSuffix();
  const tempExpr = `${layout.binaryExpr}.${tempSuffix}`;
  await execSshOrThrow(
    client,
    `mkdir -p ${layout.binDirExpr} && chmod 700 ${layout.binDirExpr}`,
    "Unable to create the remote ADE service directory.",
  );
  try {
    await uploadSshFile(client, localPath, tempExpr);
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

async function uploadNativeDepsBundle(client: Client, layout: RemoteRuntimeLayout, archLabel: string, localPath: string, appVersion: string): Promise<void> {
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
    await uploadSshFile(client, localPath, tempExpr);
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
  const { client: ssh, route: connectedRoute } = await connectSshWithRoute(args.target);
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
    if (localBinary && localBinarySha256 && shouldUploadBundledRuntime({
      localBinaryAvailable: true,
      executableVersion: executableRuntimeVersion,
      appVersion: args.appVersion,
      localBinarySha256,
      remoteBinarySha256,
    })) {
      await uploadRuntimeBinary(ssh, layout, localBinary, args.appVersion, localBinarySha256);
      await signUploadedRuntimeBinaryIfNeeded(ssh, layout, arch.platform);
      runtimeUploaded = true;
      runtimeVersion = args.appVersion;
    }

    let nativeDepsReady = false;
    if (nativeDepsBundle) {
      const nativeDepsCheck = await execSsh(ssh, [
        `test -d ${layout.runtimeDirExpr}/${arch.label}/node_modules`,
        `test "$(cat ${layout.runtimeDirExpr}/${arch.label}/.ade-version 2>/dev/null)" = ${shellQuote(args.appVersion)}`,
        "echo ok",
      ].join(" && ") + " || true");
      const shouldUploadNativeDeps = runtimeUploaded || nativeDepsCheck.stdout.trim() !== "ok";
      if (shouldUploadNativeDeps) {
        await uploadNativeDepsBundle(ssh, layout, arch.label, nativeDepsBundle, args.appVersion);
      }
      nativeDepsReady = true;
    }

    const runtimeEnvPrefix = buildRemoteRuntimeEnvironmentPrefix({
      archLabel: arch.label,
      nativeDepsReady,
      layout,
      disableRuntimeServiceInstall: layout.homeDirName !== preferredLayout.homeDirName,
    });

    if (runtimeUploaded) {
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
    }

    if (runtimeUploaded) {
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
