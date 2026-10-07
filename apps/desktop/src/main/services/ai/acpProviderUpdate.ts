/**
 * Version policy and one-click update for the ACP provider CLIs.
 *
 * ADE does not ship these CLIs; the user installs them. Each provider has a
 * tested range: the oldest and newest versions someone checked ADE against
 * (the dialect files record the evidence). ADE compares the installed
 * `--version` to that range:
 *
 * - below the range: the chat shows a warning with an Update button;
 * - inside it but not at the top: Settings offers an update;
 * - above it: Settings says the version is newer than ADE has tested.
 *
 * An update always installs the newest TESTED version, never npm `latest`, so
 * a user cannot update into a release that breaks ADE. Raising the range is a
 * code change made after a live check of the new version.
 *
 * Only an install ADE can identify gets a button: a vendor-native Grok, or an
 * npm global install whose prefix ADE can read from the binary's real path.
 * Everything else stays manual with a note, so the button never runs a guess.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { signalProcessGroup } from "../shared/utils";

import type { AcpChatProvider } from "../../../shared/types/chat";
import type {
  AcpProviderUpdateInfo,
  AcpProviderUpdateResult,
  AcpProviderVersionStanding,
} from "../../../shared/types/config";
import { resolveCliSpawnInvocation, terminateProcessTree } from "../shared/processExecution";

const UPDATE_TIMEOUT_MS = 180_000;
const VERSION_TIMEOUT_MS = 6_000;
/** The longest one update can run: the install, then the version re-read. */
export const ACP_PROVIDER_UPDATE_RUN_BUDGET_MS = UPDATE_TIMEOUT_MS + VERSION_TIMEOUT_MS;
const UPDATE_OUTPUT_LIMIT = 10_000;

export type AcpProviderVersionPolicy = {
  label: string;
  /** The vendor's npm package, or null for a native-only CLI. */
  npmPackage: string | null;
  /** Inclusive. Update both ends only after a live check of that version. */
  tested: { min: string; max: string };
  /** The vendor's own updater can install an exact version (`update --version <v>`). */
  nativeUpdater: boolean;
};

/**
 * One row per ACP provider. The ranges come from the live checks recorded in
 * `chat/acpHost/acpDialects/<provider>.ts`.
 */
export const ACP_PROVIDER_VERSION_POLICY: Record<AcpChatProvider, AcpProviderVersionPolicy> = {
  grok: { label: "Grok", npmPackage: "@xai-official/grok", tested: { min: "1.0.40", max: "1.0.46" }, nativeUpdater: true },
  copilot: { label: "Copilot", npmPackage: "@github/copilot", tested: { min: "1.0.82", max: "1.0.91" }, nativeUpdater: false },
  qwen: { label: "Qwen Code", npmPackage: "@qwen-code/qwen-code", tested: { min: "0.22.3", max: "0.25.0" }, nativeUpdater: false },
  kimi: { label: "Kimi", npmPackage: null, tested: { min: "0.39.1", max: "2.1.1" }, nativeUpdater: false },
  devin: { label: "Devin", npmPackage: null, tested: { min: "3000.11.3", max: "3000.11.3" }, nativeUpdater: false },
};

export type AcpInstaller =
  | { kind: "native"; binaryPath: string }
  | { kind: "npm"; binaryPath: string; prefix: string };

export type AcpInstallerIo = {
  exists: (filePath: string) => boolean;
  realpath: (filePath: string) => string;
  /** First line of a text file, or null when it cannot be read. */
  readFirstLine: (filePath: string) => string | null;
};

const DEFAULT_INSTALLER_IO: AcpInstallerIo = {
  exists: (filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  },
  realpath: (filePath) => {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return filePath;
    }
  },
  readFirstLine: (filePath) => {
    try {
      const fd = fs.openSync(filePath, "r");
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
 * The npm global prefix that owns `binaryPath`, or null.
 *
 * POSIX: `<prefix>/bin/<name>` links into `<prefix>/lib/node_modules/<pkg>`.
 * Windows: the `<prefix>\<name>.cmd` shim sits beside `<prefix>\node_modules\<pkg>`.
 * A project-local install (`<repo>/node_modules/<pkg>`, its `.bin` shim) has
 * neither layout and stays manual: installing "globally" there would leave
 * the selected binary unchanged.
 */
function npmPrefixFor(binaryPath: string, npmPackage: string, io: AcpInstallerIo): string | null {
  const pkgSegments = npmPackage.split("/");
  const real = io.realpath(binaryPath);
  const parts = real.split(/[\\/]+/);
  for (let i = 0; i + pkgSegments.length < parts.length; i += 1) {
    if (parts[i] !== "node_modules") continue;
    if (!pkgSegments.every((segment, offset) => parts[i + 1 + offset] === segment)) continue;
    const before = parts.slice(0, i);
    if (before[before.length - 1] !== "lib") continue;
    before.pop();
    const prefix = before.join(real.includes("\\") ? "\\" : "/");
    return prefix || null;
  }
  const lower = binaryPath.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".ps1") || lower.endsWith(".bat")) {
    // A shim is a Windows-only shape, so read it with Windows path rules.
    const dir = path.win32.dirname(binaryPath);
    if (io.exists(path.win32.join(dir, "node_modules", ...pkgSegments))) return dir;
  }
  return null;
}

/**
 * Which installer owns a resolved binary. Null means "manual only": the path is
 * missing, the CLI has no npm package and no exact-version updater, or an npm
 * install whose prefix ADE cannot read.
 */
export function resolveAcpInstaller(
  provider: AcpChatProvider,
  binaryPath: string | null | undefined,
  io: AcpInstallerIo = DEFAULT_INSTALLER_IO,
): AcpInstaller | null {
  const candidate = binaryPath?.trim();
  if (!candidate || !io.exists(candidate)) return null;
  const policy = ACP_PROVIDER_VERSION_POLICY[provider];
  if (policy.npmPackage) {
    const prefix = npmPrefixFor(candidate, policy.npmPackage, io);
    if (prefix) return { kind: "npm", binaryPath: candidate, prefix };
    const firstLine = (io.readFirstLine(candidate) ?? "").trim();
    const looksLikeNode = /^#!.*\bnode\b/.test(firstLine) || io.realpath(candidate).toLowerCase().includes("node_modules");
    // An npm install ADE cannot place stays manual rather than guessing a prefix.
    if (looksLikeNode) return null;
  }
  return policy.nativeUpdater ? { kind: "native", binaryPath: candidate } : null;
}

/** Numeric compare of the first `x.y.z` in each string. `null` when unparsable. */
export function compareVersions(current: string | null, other: string | null): number | null {
  const parse = (value: string | null): [number, number, number] | null => {
    const match = value?.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const from = parse(current);
  const to = parse(other);
  if (!from || !to) return null;
  for (let index = 0; index < 3; index += 1) {
    if (from[index] !== to[index]) return from[index]! - to[index]!;
  }
  return 0;
}

/** The first `x.y.z` in a `--version` line, for display. */
export function extractVersion(value: string | null): string | null {
  return value?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/)?.[0] ?? null;
}

export function acpVersionStanding(provider: AcpChatProvider, version: string | null): AcpProviderVersionStanding {
  const { tested } = ACP_PROVIDER_VERSION_POLICY[provider];
  const vsMin = compareVersions(version, tested.min);
  const vsMax = compareVersions(version, tested.max);
  if (vsMin == null || vsMax == null) return "unknown";
  if (vsMin < 0) return "below";
  if (vsMax > 0) return "above";
  return "tested";
}

/** The advisory for one installed CLI, and whether ADE may update it. */
export function decideAcpProviderUpdate(args: {
  provider: AcpChatProvider;
  versionLine: string | null;
  installer: AcpInstaller | null;
}): AcpProviderUpdateInfo {
  const policy = ACP_PROVIDER_VERSION_POLICY[args.provider];
  const installedVersion = extractVersion(args.versionLine);
  const standing = acpVersionStanding(args.provider, installedVersion);
  const behindTarget = (compareVersions(installedVersion, policy.tested.max) ?? 0) < 0;
  const updateAvailable = (standing === "below" || standing === "tested") && behindTarget;
  let note: string | null = null;
  if (updateAvailable && !args.installer) {
    note = policy.npmPackage
      ? `ADE could not tell how this ${policy.label} was installed. Run \`npm install -g ${policy.npmPackage}@${policy.tested.max}\` with the installer you used.`
      : `Update ${policy.label} to ${policy.tested.max} with the installer you used.`;
  }
  return {
    installedVersion,
    testedRange: { ...policy.tested },
    standing,
    targetVersion: policy.tested.max,
    updateAvailable,
    installer: args.installer?.kind ?? null,
    canUpdate: updateAvailable && args.installer != null,
    note,
  };
}

export type AcpRunResult = { status: number | null; stdout: string; stderr: string };
export type AcpSpawn = (
  command: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv; cwd?: string },
) => Promise<AcpRunResult>;

/**
 * Kill the updater and anything it spawned.
 *
 * The POSIX child is detached, so it leads its own process group; signalling the
 * group reaches installer grandchildren that `child.kill()` alone would leave
 * running. On Windows `terminateProcessTree` runs `taskkill /T` plus the direct
 * kill.
 */
function killUpdateTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (process.platform !== "win32" && typeof pid === "number") {
    try {
      signalProcessGroup(pid, "SIGKILL");
    } catch {
      // The group already exited.
    }
  }
  terminateProcessTree(child, "SIGKILL", () => {});
}

function defaultSpawn(
  command: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv; cwd?: string },
): Promise<AcpRunResult> {
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
        killUpdateTree(child);
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

/** The npm that belongs to the prefix, so the install lands where the binary lives. */
function npmCommandFor(prefix: string, io: AcpInstallerIo): string {
  const candidates = process.platform === "win32"
    ? [path.join(prefix, "npm.cmd")]
    : [path.join(prefix, "bin", "npm")];
  return candidates.find((candidate) => io.exists(candidate)) ?? "npm";
}

/** The exact command an update runs. Exported so Settings and the docs describe the same thing. */
export function acpUpdateCommand(
  provider: AcpChatProvider,
  installer: AcpInstaller,
  io: AcpInstallerIo = DEFAULT_INSTALLER_IO,
): { command: string; args: string[] } {
  const policy = ACP_PROVIDER_VERSION_POLICY[provider];
  const target = policy.tested.max;
  if (installer.kind === "native") {
    return { command: installer.binaryPath, args: ["update", "--version", target] };
  }
  return {
    command: npmCommandFor(installer.prefix, io),
    args: ["install", "-g", "--prefix", installer.prefix, `${policy.npmPackage}@${target}`],
  };
}

/**
 * Install the newest tested version, then re-read the version. Never throws:
 * a failure is reported as a message for the row.
 */
export async function runAcpProviderInstall(args: {
  provider: AcpChatProvider;
  installer: AcpInstaller;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  run?: AcpSpawn;
  io?: AcpInstallerIo;
}): Promise<AcpProviderUpdateResult> {
  const policy = ACP_PROVIDER_VERSION_POLICY[args.provider];
  const run = args.run ?? defaultSpawn;
  const env: NodeJS.ProcessEnv = { ...(args.env ?? process.env) };
  const runOpts = { timeout: UPDATE_TIMEOUT_MS, env, ...(args.cwd ? { cwd: args.cwd } : {}) };
  const { command, args: commandArgs } = acpUpdateCommand(args.provider, args.installer, args.io ?? DEFAULT_INSTALLER_IO);
  const update = await run(command, commandArgs, runOpts);
  if (update.status !== 0) {
    const detail = lastMeaningfulLine(update.stdout, update.stderr);
    return {
      ok: false,
      message: detail ? `${policy.label} update failed: ${detail}` : `${policy.label} update failed.`,
      version: null,
    };
  }
  // The installer's exit code is not proof: an install into another prefix
  // succeeds and leaves this binary as it was. The binary must now report the
  // version ADE asked for.
  const version = await run(args.installer.binaryPath, ["--version"], { ...runOpts, timeout: VERSION_TIMEOUT_MS });
  const versionLine = version.status === 0 ? lastMeaningfulLine(version.stdout, version.stderr) : "";
  if (compareVersions(versionLine, policy.tested.max) !== 0) {
    return {
      ok: false,
      message: versionLine
        ? `The update finished, but ${policy.label} still reports ${versionLine}, not ${policy.tested.max}.`
        : `The update finished, but ADE could not confirm the ${policy.label} version.`,
      version: versionLine || null,
    };
  }
  return { ok: true, message: `${policy.label} updated to ${versionLine}.`, version: versionLine };
}
