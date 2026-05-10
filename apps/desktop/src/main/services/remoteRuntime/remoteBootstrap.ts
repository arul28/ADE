import fs from "node:fs";
import path from "node:path";
import type { Client } from "ssh2";
import type { RemoteRuntimeConnectResult, RemoteRuntimeProjectRecord, RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";
import { RuntimeRpcClient } from "./runtimeRpcClient";
import { connectSsh, execSsh, openSshRuntimeTransport } from "./sshTransport";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";

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
}): boolean {
  return args.localBinaryAvailable && args.executableVersion !== args.appVersion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateRemoteRuntimeInitializeResult(args: {
  result: unknown;
  expectedVersion: string | null;
}): void {
  if (!isRecord(args.result)) {
    throw new Error("Remote ADE service returned an invalid initialize response.");
  }
  const runtimeInfo = isRecord(args.result.runtimeInfo) ? args.result.runtimeInfo : {};
  const capabilities = isRecord(args.result.capabilities) ? args.result.capabilities : {};
  if (runtimeInfo.multiProject !== true || capabilities.projects !== true) {
    throw new Error("Remote ADE service does not support multi-project mode. Update the ADE service on that machine.");
  }
  const version = typeof runtimeInfo.version === "string" && runtimeInfo.version.trim()
    ? runtimeInfo.version.trim()
    : null;
  if (args.expectedVersion && version !== args.expectedVersion) {
    throw new Error(`Remote ADE service version mismatch: expected ${args.expectedVersion}, got ${version ?? "unknown"}.`);
  }
}

const REMOTE_RUNTIME_PATH_PREFIX = 'PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}"';

export function buildRemoteRuntimeEnvironmentPrefix(args: {
  archLabel: string;
  nativeDepsReady: boolean;
}): string {
  const parts = [REMOTE_RUNTIME_PATH_PREFIX];
  if (args.nativeDepsReady) {
    parts.push(`NODE_PATH="$HOME/.ade/runtime/${args.archLabel}/node_modules${"${NODE_PATH:+:$NODE_PATH}"}"`);
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

async function uploadRuntimeBinary(client: Client, localPath: string, appVersion: string): Promise<void> {
  await execSsh(client, "mkdir -p ~/.ade/bin");
  await new Promise<void>((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }
      sftp.fastPut(localPath, ".ade/bin/ade", {}, (putError) => {
        sftp.end();
        if (putError) reject(putError);
        else resolve();
      });
    });
  });
  await execSsh(client, [
    "chmod 700 ~/.ade/bin",
    "chmod +x ~/.ade/bin/ade",
    `printf '%s\\n' ${shellQuote(appVersion)} > ~/.ade/bin/ade.version`,
    "chmod 600 ~/.ade/bin/ade.version",
  ].join(" && "));
}

async function uploadNativeDepsBundle(client: Client, archLabel: string, localPath: string, appVersion: string): Promise<void> {
  await execSsh(client, "mkdir -p ~/.ade/runtime");
  const remoteArchive = `.ade/runtime/ade-${archLabel}.native.tar.gz`;
  await new Promise<void>((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }
      sftp.fastPut(localPath, remoteArchive, {}, (putError) => {
        sftp.end();
        if (putError) reject(putError);
        else resolve();
      });
    });
  });
  const extract = await execSsh(client, [
    `rm -rf ~/.ade/runtime/${archLabel}`,
    `mkdir -p ~/.ade/runtime/${archLabel}`,
    `tar -xzf ~/.ade/runtime/ade-${archLabel}.native.tar.gz -C ~/.ade/runtime/${archLabel}`,
    `printf '%s\\n' ${shellQuote(appVersion)} > ~/.ade/runtime/${archLabel}/.ade-version`,
  ].join(" && "));
  if (extract.code !== 0) {
    throw new Error(extract.stderr.trim() || "Unable to unpack ADE service native dependencies on the remote machine.");
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

export async function bootstrapRemoteRuntime(args: {
  target: RemoteRuntimeTarget;
  registry: RemoteTargetRegistry;
  resourcesPath: string;
  appVersion: string;
}): Promise<{ client: RuntimeRpcClient; result: RemoteRuntimeConnectResult; ssh: Client }> {
  const ssh = await connectSsh(args.target);
  try {
    const uname = await execSsh(ssh, "uname -sm");
    if (uname.code !== 0) {
      throw new Error(uname.stderr.trim() || "Unable to detect remote architecture.");
    }
    const arch = normalizeRemoteArch(uname.stdout.trim());
    const binaryMarkerCheck = await execSsh(ssh, "cat ~/.ade/bin/ade.version 2>/dev/null || true");
    const markedRuntimeVersion = normalizeRuntimeVersion(binaryMarkerCheck.stdout);
    const versionCheck = await execSsh(ssh, "test -x ~/.ade/bin/ade && ~/.ade/bin/ade --version || true");
    const executableRuntimeVersion = normalizeRuntimeVersion(versionCheck.stdout);
    let runtimeVersion = selectRemoteRuntimeVersion({
      markerVersion: markedRuntimeVersion,
      executableVersion: executableRuntimeVersion,
    });
    const localBinary = bundledRuntimePath(args.resourcesPath, arch.label);
    const nativeDepsBundle = bundledNativeDepsPath(args.resourcesPath, arch.label);
    let runtimeUploaded = false;
    if (localBinary && shouldUploadBundledRuntime({
      localBinaryAvailable: true,
      executableVersion: executableRuntimeVersion,
      appVersion: args.appVersion,
    })) {
      await uploadRuntimeBinary(ssh, localBinary, args.appVersion);
      runtimeUploaded = true;
      runtimeVersion = args.appVersion;
    }

    let nativeDepsReady = false;
    if (nativeDepsBundle) {
      const nativeDepsCheck = await execSsh(ssh, [
        `test -d ~/.ade/runtime/${arch.label}/node_modules`,
        `test "$(cat ~/.ade/runtime/${arch.label}/.ade-version 2>/dev/null)" = ${shellQuote(args.appVersion)}`,
        "echo ok",
      ].join(" && ") + " || true");
      const shouldUploadNativeDeps = runtimeUploaded || nativeDepsCheck.stdout.trim() !== "ok";
      if (shouldUploadNativeDeps) {
        await uploadNativeDepsBundle(ssh, arch.label, nativeDepsBundle, args.appVersion);
      }
      nativeDepsReady = true;
    }

    const runtimeEnvPrefix = buildRemoteRuntimeEnvironmentPrefix({
      archLabel: arch.label,
      nativeDepsReady,
    });

    if (runtimeUploaded) {
      const uploadedVersionCheck = await execSsh(ssh, `${runtimeEnvPrefix}~/.ade/bin/ade --version`);
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

    if (!runtimeVersion) {
      const pathVersionCheck = await execSsh(ssh, `${runtimeEnvPrefix}ade --version || true`);
      runtimeVersion = normalizeRuntimeVersion(pathVersionCheck.stdout);
      if (!runtimeVersion) {
        throw new Error(`ADE service is not installed on the remote machine and no bundled ADE service is available for ${arch.label}.`);
      }
    }

    const command = localBinary || runtimeUploaded
      ? `${runtimeEnvPrefix}~/.ade/bin/ade rpc --stdio`
      : `${runtimeEnvPrefix}ade rpc --stdio`;
    const transport = await openSshRuntimeTransport(ssh, command);
    const client = new RuntimeRpcClient(transport);
    const initializeResult = await client.initialize("ade-desktop-remote", args.appVersion);
    validateRemoteRuntimeInitializeResult({
      result: initializeResult,
      expectedVersion: localBinary || runtimeUploaded ? args.appVersion : null,
    });
    const projects = coerceProjects(await client.call("projects.list", {}));
    const updated = args.registry.update(args.target.id, {
      lastSeenArch: arch.label,
      runtimeBinaryVersion: runtimeVersion,
      lastConnectedAt: Date.now(),
    });
    return {
      client,
      ssh,
      result: {
        target: updated,
        arch: arch.label,
        version: runtimeVersion,
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
