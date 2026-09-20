import { createHash } from "node:crypto";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  resolveCliSpawnInvocation,
} from "../../../../desktop/src/main/services/shared/processExecution";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";
import type { CliProxyApiReleaseAsset } from "./cliProxyApiRelease";
import type { CliProxyApiSupervisorPaths } from "./cliProxyApiConfig";

export type CliProxyApiSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export type CliProxyApiArchiveExtractor = (
  asset: CliProxyApiReleaseAsset,
  archivePath: string,
  destination: string,
  platform: NodeJS.Platform,
  spawnImpl: CliProxyApiSpawn,
) => Promise<void>;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifySha256(bytes: Uint8Array, expectedSha256: string): void {
  const actualSha256 = sha256Hex(bytes);
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(`CLIProxyAPI checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
}

function runArchiveCommand(
  command: string,
  args: string[],
  cwd: string,
  platform: NodeJS.Platform,
  spawnImpl: CliProxyApiSpawn,
): Promise<void> {
  const invocation = resolveCliSpawnInvocation(command, args, process.env, platform);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawnImpl(invocation.command, invocation.args, {
      cwd,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`CLIProxyAPI archive extraction failed (${code ?? signal ?? "unknown"})`));
    });
  });
}

export const defaultExtractArchive: CliProxyApiArchiveExtractor = (asset, archivePath, destination, platform, spawnImpl) =>
  runArchiveCommand(
    platform === "win32" ? resolveTrustedWindowsTool("tar") : "tar",
    asset.archive === "tar.gz"
      ? ["-xzf", archivePath, "-C", destination]
      : ["-xf", archivePath, "-C", destination],
    destination,
    platform,
    spawnImpl,
  );

export async function installAsset(args: {
  paths: CliProxyApiSupervisorPaths;
  asset: CliProxyApiReleaseAsset;
  platform: NodeJS.Platform;
  fetchImpl: typeof fetch;
  spawnImpl: CliProxyApiSpawn;
  extractArchive: CliProxyApiArchiveExtractor;
  secureDirectory: (directoryPath: string) => void;
}): Promise<string> {
  args.secureDirectory(args.paths.proxyDir);
  args.secureDirectory(args.paths.versionDir);
  const response = await args.fetchImpl(args.asset.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`CLIProxyAPI download failed with HTTP ${response.status}`);
  }
  const archiveBytes = Buffer.from(await response.arrayBuffer());
  verifySha256(archiveBytes, args.asset.sha256);

  const archivePath = path.join(
    args.paths.versionDir,
    args.asset.archive === "zip" ? "cli-proxy-api.zip" : "cli-proxy-api.tar.gz",
  );
  fs.writeFileSync(archivePath, archiveBytes, { mode: 0o600 });
  if (args.platform !== "win32") {
    try {
      fs.chmodSync(archivePath, 0o600);
    } catch {
      // Best effort; the private directory is the primary boundary.
    }
  }
  try {
    await args.extractArchive(args.asset, archivePath, args.paths.versionDir, args.platform, args.spawnImpl);
    if (!fs.existsSync(args.paths.binaryPath)) {
      throw new Error(`CLIProxyAPI archive did not contain ${args.asset.binaryName}`);
    }
    if (args.platform !== "win32") {
      fs.chmodSync(args.paths.binaryPath, 0o755);
    }
    return args.paths.binaryPath;
  } finally {
    try {
      fs.rmSync(archivePath, { force: true });
    } catch {
      // A leftover archive is harmless inside the private version directory;
      // the install result still reports the extraction failure itself.
    }
  }
}
