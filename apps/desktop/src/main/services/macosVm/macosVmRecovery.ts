import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { MacosVmDeleteArgs, MacosVmRecord } from "../../../shared/types";

const MACOS_VM_STATE_FILE = "records.json";
const MACOS_VM_GLOBAL_LEASE_FILE = "lease.json";
const MACOS_VM_VNC_CREDENTIALS_FILE = "macos-vm-vnc.v1.json";
const LUME_DELETE_TIMEOUT_MS = 60_000;

type CommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  fs.renameSync(tmpPath, filePath);
  if (mode != null) {
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      // Best effort. These files live under ADE-managed cache/secrets dirs.
    }
  }
}

function asVmRecord(value: unknown): MacosVmRecord | null {
  if (!isRecord(value)) return null;
  return typeof value.name === "string" && typeof value.laneId === "string"
    ? value as MacosVmRecord
    : null;
}

function readRecords(storePath: string): MacosVmRecord[] {
  const parsed = readJsonFile(storePath);
  if (!isRecord(parsed) || !Array.isArray(parsed.records)) return [];
  return parsed.records.map(asVmRecord).filter((record): record is MacosVmRecord => Boolean(record));
}

function writeRecords(storePath: string, records: MacosVmRecord[]): void {
  writeJsonFile(storePath, { version: 1, records });
}

function vncCredentialKey(laneId: string, vmName: string): string {
  return `${laneId}:${vmName}`;
}

function clearVncCredential(vncStorePath: string, record: MacosVmRecord): void {
  const parsed = readJsonFile(vncStorePath);
  if (!isRecord(parsed) || !isRecord(parsed.credentials)) return;
  const key = vncCredentialKey(record.laneId, record.name);
  if (!Object.prototype.hasOwnProperty.call(parsed.credentials, key)) return;
  delete parsed.credentials[key];
  writeJsonFile(vncStorePath, { ...parsed, version: 1, credentials: parsed.credentials }, 0o600);
}

function clearGlobalLease(leasePath: string, args: MacosVmDeleteArgs, record: MacosVmRecord | null): boolean {
  const parsed = readJsonFile(leasePath);
  const lease = isRecord(parsed) && isRecord(parsed.lease) ? parsed.lease : null;
  if (!lease) return false;
  const laneId = args.laneId?.trim() || record?.laneId || null;
  const vmName = args.vmName?.trim() || record?.name || null;
  const matchesLane = Boolean(laneId && lease.laneId === laneId);
  const matchesVm = Boolean(vmName && lease.vmName === vmName);
  if (!matchesLane && !matchesVm) return false;
  writeJsonFile(leasePath, { version: 1, lease: null });
  return true;
}

function commonLumePaths(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || os.homedir();
  return [
    env.LUME_PATH,
    ...String(env.PATH ?? "").split(path.delimiter).map((entry) => entry ? path.join(entry, "lume") : ""),
    path.join(home, ".local", "bin", "lume"),
    "/opt/homebrew/bin/lume",
    "/usr/local/bin/lume",
  ].filter((entry): entry is string => Boolean(entry?.trim()));
}

function resolveLumeCommand(env: NodeJS.ProcessEnv): string {
  for (const candidate of commonLumePaths(env)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "lume";
}

const defaultRunCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        exitCode: null,
        signal: "SIGTERM",
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8") || "Timed out deleting Lume VM.",
      });
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      finish({
        exitCode: 1,
        signal: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error.message,
      });
    });
    child.once("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

async function bestEffortDeleteExternalVm(
  projectRoot: string,
  vmName: string | null,
  force: boolean,
  env: NodeJS.ProcessEnv,
  runCommand: CommandRunner,
): Promise<void> {
  if (!vmName) return;
  const command = resolveLumeCommand(env);
  const args = ["delete", vmName];
  if (force) args.push("--force");
  await runCommand(command, args, { cwd: projectRoot, timeoutMs: LUME_DELETE_TIMEOUT_MS, env }).catch(() => null);
}

export async function deleteMacosVmFromProjectState({
  projectRoot,
  args,
  env = process.env,
  runCommand = defaultRunCommand,
}: {
  projectRoot: string;
  args: MacosVmDeleteArgs;
  env?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
}): Promise<{ deleted: boolean; previous: MacosVmRecord | null }> {
  const laneId = args.laneId?.trim() || null;
  const vmName = args.vmName?.trim() || null;
  if (!laneId && !vmName) throw new Error("A lane id or VM name is required to remove a macOS VM.");

  const layout = resolveAdeLayout(projectRoot);
  const storePath = path.join(layout.cacheDir, "macos-vms", MACOS_VM_STATE_FILE);
  const adeHome = env.ADE_HOME?.trim() || path.join(layout.cacheDir, "runtime-home");
  const leasePath = path.join(adeHome, "cache", "macos-vms", MACOS_VM_GLOBAL_LEASE_FILE);
  const vncStorePath = path.join(layout.secretsDir, MACOS_VM_VNC_CREDENTIALS_FILE);

  const records = readRecords(storePath);
  const previous = records.find((record) =>
    (laneId && record.laneId === laneId) || (vmName && record.name === vmName),
  ) ?? null;
  const nextRecords = previous
    ? records.filter((record) => record.laneId !== previous.laneId && record.name !== previous.name)
    : records;
  if (previous) {
    writeRecords(storePath, nextRecords);
    clearVncCredential(vncStorePath, previous);
  }
  const leaseCleared = clearGlobalLease(leasePath, args, previous);
  await bestEffortDeleteExternalVm(projectRoot, vmName || previous?.name || null, args.force === true, env, runCommand);

  return { deleted: Boolean(previous || leaseCleared), previous };
}
