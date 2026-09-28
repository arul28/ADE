/**
 * Grok version monitor and one-click update.
 *
 * ADE launches Grok with `--no-auto-update`, so its own updater never runs from
 * a chat and an outdated CLI would otherwise show no advisory anywhere. This
 * reads the vendor's npm `latest` tag, compares it to the installed
 * `--version`, and — only when the binary resolves to a known installer — runs
 * `<resolved binary> update` with the instance environment so a custom
 * `GROK_HOME` updates that home, then re-reads the version to confirm.
 *
 * An unresolvable binary stays manual: no latest-version fetch and no button.
 * The install-kind decision is pure and injected so it is testable without a
 * Windows host or a real registry.
 */

import fs from "node:fs";
import { spawn } from "node:child_process";

import type {
  AcpProviderUpdateInfo,
  AcpProviderUpdateResult,
} from "../../../shared/types/config";
import { resolveCliSpawnInvocation, terminateProcessTree } from "../shared/processExecution";

export const GROK_NPM_PACKAGE = "@xai-official/grok";
const GROK_REGISTRY_LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(GROK_NPM_PACKAGE)}/latest`;
const REGISTRY_TIMEOUT_MS = 6_000;
const REGISTRY_CACHE_TTL_MS = 30 * 60_000;
const UPDATE_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 6_000;
const UPDATE_OUTPUT_LIMIT = 10_000;

export type GrokInstallerKind = "native" | "npm";

export type GrokInstallerIo = {
  /** Whether `path` exists on disk. */
  exists: (path: string) => boolean;
  /** First line of a text file, or null when it cannot be read. */
  readFirstLine: (path: string) => string | null;
};

const DEFAULT_INSTALLER_IO: GrokInstallerIo = {
  exists: (path) => {
    try {
      return fs.existsSync(path);
    } catch {
      return false;
    }
  },
  readFirstLine: (path) => {
    try {
      const fd = fs.openSync(path, "r");
      try {
        const buffer = Buffer.alloc(256);
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        return buffer.subarray(0, read).toString("utf8").split(/\r?\n/, 1)[0] ?? null;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  },
};

/**
 * Which installer owns a resolved Grok binary.
 *
 * `npm` covers the Windows `.cmd`/`.ps1` shims, a path under `node_modules`, and
 * a Node shebang; everything else that exists is the vendor's native binary.
 * Returns `null` when the path is missing, which is the "manual only" signal.
 */
export function resolveGrokInstaller(
  binaryPath: string | null | undefined,
  io: GrokInstallerIo = DEFAULT_INSTALLER_IO,
): { installer: GrokInstallerKind | null } {
  const candidate = binaryPath?.trim();
  if (!candidate || !io.exists(candidate)) return { installer: null };
  const lower = candidate.toLowerCase();
  const firstLine = (io.readFirstLine(candidate) ?? "").trim();
  const isNodeShim = /^#!.*\bnode\b/.test(firstLine)
    || lower.endsWith(".cmd")
    || lower.endsWith(".ps1")
    || lower.endsWith(".bat");
  const inNodeModules = lower.includes("node_modules") || lower.includes("xai-official");
  const installer: GrokInstallerKind = isNodeShim || inNodeModules ? "npm" : "native";
  return { installer };
}

/** Numeric compare of the first `x.y.z` in each string. `null` when unparsable. */
export function compareGrokVersions(current: string | null, latest: string | null): number | null {
  const parse = (value: string | null): [number, number, number] | null => {
    const match = value?.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const from = parse(current);
  const to = parse(latest);
  if (!from || !to) return null;
  for (let index = 0; index < 3; index += 1) {
    if (from[index] !== to[index]) return from[index]! - to[index]!;
  }
  return 0;
}

/**
 * Decide the advisory and whether a one-click update is offered.
 *
 * `canUpdate` is false with an explanatory note whenever the installer could
 * not be resolved or the versions could not be compared, so the UI never shows
 * a button that would run the wrong command.
 */
export function decideGrokUpdate(args: {
  currentVersion: string | null;
  latestVersion: string | null;
  installer: GrokInstallerKind | null;
}): AcpProviderUpdateInfo {
  const comparison = compareGrokVersions(args.currentVersion, args.latestVersion);
  const updateAvailable = comparison != null && comparison < 0;
  let note: string | null = null;
  if (!args.installer) {
    note = "ADE could not tell how this Grok was installed. Update it with the installer you used.";
  } else if (args.latestVersion == null) {
    note = `Could not read the latest version from npm (${GROK_NPM_PACKAGE}).`;
  } else if (!args.currentVersion || comparison == null) {
    note = "Could not compare versions. Check for an update with your installer.";
  }
  return {
    latestVersion: args.latestVersion,
    updateAvailable,
    installer: args.installer,
    canUpdate: args.installer != null,
    note,
  };
}

let cachedLatestVersion: { value: string | null; readAt: number } | null = null;

/** Latest `@xai-official/grok` version from the npm registry, cached 30 minutes. */
export async function fetchLatestGrokVersion(
  opts: { fetchImpl?: typeof fetch; force?: boolean } = {},
): Promise<string | null> {
  if (!opts.force && cachedLatestVersion && Date.now() - cachedLatestVersion.readAt < REGISTRY_CACHE_TTL_MS) {
    return cachedLatestVersion.value;
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(GROK_REGISTRY_LATEST_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      cachedLatestVersion = { value: null, readAt: Date.now() };
      return null;
    }
    const data = await response.json() as { version?: unknown };
    const value = typeof data?.version === "string" && data.version.trim().length
      ? data.version.trim()
      : null;
    cachedLatestVersion = { value, readAt: Date.now() };
    return value;
  } catch {
    cachedLatestVersion = { value: null, readAt: Date.now() };
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type GrokUpdateBaseline = {
  installer: GrokInstallerKind | null;
  latestVersion: string | null;
};

/**
 * Resolve the installer and fetch the latest version, independent of the
 * installed version. A caller that also needs `--version` can start this first
 * so the registry round-trip overlaps the version spawn instead of following it.
 * Skips the registry entirely when the installer cannot be resolved.
 */
export async function fetchGrokUpdateBaseline(args: {
  binaryPath: string | null;
  installerIo?: GrokInstallerIo;
  fetchImpl?: typeof fetch;
  force?: boolean;
}): Promise<GrokUpdateBaseline> {
  const { installer } = resolveGrokInstaller(args.binaryPath, args.installerIo ?? DEFAULT_INSTALLER_IO);
  if (!installer) return { installer: null, latestVersion: null };
  const latestVersion = await fetchLatestGrokVersion({
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.force ? { force: true } : {}),
  });
  return { installer, latestVersion };
}

/**
 * Update state for a resolved Grok binary. Skips the registry entirely when the
 * installer could not be resolved, so a missing binary never costs a network
 * call.
 */
export async function collectGrokUpdateInfo(args: {
  binaryPath: string | null;
  currentVersion: string | null;
  installerIo?: GrokInstallerIo;
  fetchImpl?: typeof fetch;
  force?: boolean;
}): Promise<AcpProviderUpdateInfo> {
  const baseline = await fetchGrokUpdateBaseline({
    binaryPath: args.binaryPath,
    ...(args.installerIo ? { installerIo: args.installerIo } : {}),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.force ? { force: true } : {}),
  });
  return decideGrokUpdate({
    currentVersion: args.currentVersion,
    latestVersion: baseline.latestVersion,
    installer: baseline.installer,
  });
}

export type GrokRunResult = { status: number | null; stdout: string; stderr: string };
export type GrokSpawn = (
  command: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv; cwd?: string },
) => Promise<GrokRunResult>;

/**
 * Kill the updater and anything it spawned.
 *
 * The POSIX child is detached, so it leads its own process group; signalling the
 * group reaches installer grandchildren that `child.kill()` alone would leave
 * running. On Windows `terminateProcessTree` runs `taskkill /T` plus the direct
 * kill.
 */
function killGrokUpdateTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (process.platform !== "win32" && typeof pid === "number") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group already exited.
    }
  }
  terminateProcessTree(child, "SIGKILL", () => {});
}

function defaultGrokSpawn(
  command: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv; cwd?: string },
): Promise<GrokRunResult> {
  return new Promise((resolve) => {
    try {
      const invocation = resolveCliSpawnInvocation(command, args, opts.env);
      const child = spawn(invocation.command, invocation.args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        windowsHide: true,
        env: opts.env,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (status: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8").slice(0, Math.max(0, UPDATE_OUTPUT_LIMIT - stdout.length));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8").slice(0, Math.max(0, UPDATE_OUTPUT_LIMIT - stderr.length));
      });
      child.once("error", () => settle(null));
      child.once("close", (code) => settle(code));
      const timer = setTimeout(() => {
        killGrokUpdateTree(child);
        settle(null);
      }, opts.timeout);
    } catch {
      resolve({ status: null, stdout: "", stderr: "" });
    }
  });
}

function lastMeaningfulLine(stdout: string, stderr: string): string {
  const text = `${stderr}\n${stdout}`.trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

/**
 * Run `<resolved binary> update` with the instance environment, then re-read
 * the version. Never throws: a failure is reported as a message for the row.
 */
export async function runGrokUpdate(args: {
  binaryPath: string;
  configHome?: string | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  run?: GrokSpawn;
}): Promise<AcpProviderUpdateResult> {
  const run = args.run ?? defaultGrokSpawn;
  const env: NodeJS.ProcessEnv = { ...(args.env ?? process.env) };
  if (args.configHome?.trim()) env.GROK_HOME = args.configHome.trim();
  const runOpts = { timeout: UPDATE_TIMEOUT_MS, env, ...(args.cwd ? { cwd: args.cwd } : {}) };
  const update = await run(args.binaryPath, ["update"], runOpts);
  if (update.status !== 0) {
    const detail = lastMeaningfulLine(update.stdout, update.stderr);
    return {
      ok: false,
      message: detail ? `Grok update failed: ${detail}` : "Grok update failed.",
      version: null,
    };
  }
  const version = await run(args.binaryPath, ["--version"], { timeout: VERSION_TIMEOUT_MS, env, ...(args.cwd ? { cwd: args.cwd } : {}) });
  const versionLine = version.status === 0 ? lastMeaningfulLine(version.stdout, version.stderr) : "";
  return {
    ok: true,
    message: versionLine ? `Grok updated to ${versionLine}.` : "Grok updated.",
    version: versionLine || null,
  };
}
