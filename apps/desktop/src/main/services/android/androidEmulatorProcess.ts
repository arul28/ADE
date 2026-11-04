import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AndroidRunningEmulator } from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { terminateProcessTree } from "../shared/processExecution";
import { runAdb, runAdbText } from "./adb";
import { readAndroidAvd, sameAvdName } from "./androidAvds";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import { parseAndroidIni, type AndroidEnv } from "./androidSdk";
import { sleep } from "../shared/utils";

/*
 * Booting, finding and stopping emulators.
 *
 * Every emulator writes a discovery file, `avd/running/pid_<qemu pid>.ini`,
 * with its ports and AVD while it runs. That is how ADE sees all running
 * emulators, the user's too. On Windows the `emulator.exe` launcher spawns
 * qemu as a child and waits, so the launcher pid and the discovery pid differ;
 * on macOS and Linux the launcher execs qemu, so they are the same.
 *
 * ADE stops only what it started. `AdeStartedEmulators` remembers each start
 * (in a small JSON file when given one, so it survives a brain restart), and
 * an emulator counts as ADE's only while its pid, AVD and console port all
 * still match.
 */

/* ---------- discovery files ---------- */

/**
 * Where the emulator writes its discovery files, per OS (the emulator's
 * `ConfigDirs::getDiscoveryDirectory`, mirrored by Android Studio's
 * `RunningEmulatorCatalog`):
 * - Windows: `%LOCALAPPDATA%\Temp\avd\running` (the emulator's temp folder;
 *   `%TEMP%` is listed too in case it was moved);
 * - macOS: `~/Library/Caches/TemporaryItems/avd/running`;
 * - Linux: `$XDG_RUNTIME_DIR/avd/running`, else `/tmp/android-<user>/avd/running`.
 */
export function androidDiscoveryDirs(
  platform: NodeJS.Platform = process.platform,
  env: AndroidEnv = process.env,
  home = os.homedir(),
): string[] {
  const dirs: string[] = [];
  if (platform === "win32") {
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Temp", "avd", "running"));
    if (env.TEMP) dirs.push(path.join(env.TEMP, "avd", "running"));
    dirs.push(path.join(os.tmpdir(), "avd", "running"));
  } else if (platform === "darwin") {
    dirs.push(path.join(home, "Library", "Caches", "TemporaryItems", "avd", "running"));
  } else {
    if (env.XDG_RUNTIME_DIR) dirs.push(path.join(env.XDG_RUNTIME_DIR, "avd", "running"));
    let user = env.USER ?? "";
    try {
      user = os.userInfo().username || user;
    } catch {
      // No passwd entry; keep $USER.
    }
    dirs.push(path.join("/tmp", `android-${user}`, "avd", "running"));
  }
  const seen = new Set<string>();
  return dirs.filter((dir) => {
    const key = platform === "win32" ? path.resolve(dir).toLowerCase() : path.resolve(dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type AndroidDiscoveredEmulator = Omit<AndroidRunningEmulator, "startedByAde" | "booted">;

/**
 * One discovery file. Keys (emulator 37): `port.serial` (console), `port.adb`,
 * `avd.id` (the AVD name), `avd.name` (its display name, which can be
 * anything), `avd.dir`, `grpc.port`, `cmdline`, and `grpc.token` /
 * `grpc.jwks` when the emulator was started with gRPC auth (Android Studio
 * does that; ADE does not).
 */
function parseAndroidDiscoveryFile(fileName: string, text: string): AndroidDiscoveredEmulator | null {
  const pid = Number(/^pid_(\d+)\.ini$/u.exec(fileName)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const values = parseAndroidIni(text);
  const consolePort = Number(values.get("port.serial"));
  const avdName = values.get("avd.id") || values.get("avd.name") || "";
  if (!Number.isInteger(consolePort) || consolePort <= 0 || !avdName) return null;
  const adbPort = Number(values.get("port.adb"));
  const grpcPort = Number(values.get("grpc.port"));
  return {
    avdName,
    serial: `emulator-${consolePort}`,
    consolePort,
    adbPort: Number.isInteger(adbPort) && adbPort > 0 ? adbPort : consolePort + 1,
    grpcPort: Number.isInteger(grpcPort) && grpcPort > 0 ? grpcPort : null,
    pid,
    grpcTokenRequired: values.has("grpc.token") || values.has("grpc.jwks"),
  };
}

/** True while a process with this pid exists (EPERM means it exists but is not ours). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The emulators that are running now. A discovery file whose pid is gone (an
 * emulator that crashed) is skipped, not deleted: the emulator owns those
 * files.
 */
export function readAndroidDiscoveryFiles(dirs: readonly string[] = androidDiscoveryDirs()): AndroidDiscoveredEmulator[] {
  const byPid = new Map<number, AndroidDiscoveredEmulator>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^pid_\d+\.ini$/u.test(name)) continue;
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, name), "utf8");
      } catch {
        continue;
      }
      const found = parseAndroidDiscoveryFile(name, text);
      if (found && !byPid.has(found.pid) && isProcessAlive(found.pid)) byPid.set(found.pid, found);
    }
  }
  return [...byPid.values()].sort((a, b) => a.consolePort - b.consolePort);
}

/* ---------- what ADE started ---------- */

type AdeStartRecord = {
  avdName: string;
  consolePort: number;
  launcherPid: number;
  /** The qemu pid, once its discovery file showed up. */
  pid: number | null;
  startedAt: string;
};

/**
 * The emulators ADE started. With a `statePath` the list is kept in a JSON
 * file, so an emulator started before a brain restart is still ADE's (and
 * still stopped with its lane) afterwards.
 *
 * With a `statePath` the file is read again on every call. Two services can
 * share one project's file (the desktop's own copy in a dev build and the
 * brain's). A list loaded once would write its stale copy over the other's
 * starts, and those emulators would stop counting as ADE's. Reading per call
 * keeps both, short of two writes in one instant.
 */
export class AdeStartedEmulators {
  /** The list when there is no file. */
  private records: AdeStartRecord[] = [];

  constructor(
    private readonly statePath: string | null = null,
    /** A read or write of the file failed. A missing file is not a failure. */
    private readonly onFileError?: (op: "load" | "save", error: unknown) => void,
  ) {}

  /** The current list: the file's, read now, or the in-memory one. */
  private read(): AdeStartRecord[] {
    return this.statePath ? this.load() : this.records;
  }

  private load(): AdeStartRecord[] {
    if (!this.statePath) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is AdeStartRecord =>
        Boolean(entry) && typeof entry.avdName === "string" && typeof entry.consolePort === "number" && typeof entry.launcherPid === "number");
    } catch (error) {
      // An unreadable list makes every emulator ADE started look foreign.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") this.onFileError?.("load", error);
      return [];
    }
  }

  /** Keeps `records` as the list: in memory, and in the file when there is one. */
  private save(records: AdeStartRecord[]): void {
    this.records = records;
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const temp = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(records, null, 2));
      fs.renameSync(temp, this.statePath);
    } catch (error) {
      this.onFileError?.("save", error);
    }
  }

  record(entry: Omit<AdeStartRecord, "startedAt"> & { startedAt?: string }): void {
    const records = this.read().filter((record) => !(sameAvdName(record.avdName, entry.avdName) && record.consolePort === entry.consolePort));
    records.push({ ...entry, startedAt: entry.startedAt ?? new Date().toISOString() });
    this.save(records);
  }

  forget(match: { avdName: string; consolePort: number }): void {
    const before = this.read();
    const records = before.filter((record) => !(sameAvdName(record.avdName, match.avdName) && record.consolePort === match.consolePort));
    if (records.length !== before.length) this.save(records);
  }

  /**
   * ADE started this running emulator: same AVD, same console port, and one of
   * its pids. A start whose qemu pid is not known yet (it is still booting, or
   * the brain that started it handed it off mid-boot) matches on the AVD and
   * console port alone; that port came from ADE's own reservation.
   */
  owns(emulator: Pick<AndroidRunningEmulator, "avdName" | "consolePort" | "pid">): boolean {
    return this.read().some((record) =>
      sameAvdName(record.avdName, emulator.avdName)
      && record.consolePort === emulator.consolePort
      && (record.pid === null || record.pid === emulator.pid || record.launcherPid === emulator.pid));
  }

  /**
   * Drops records whose processes are all gone (a crash, a reboot). A record
   * with no qemu pid yet stays while a discovery file still names its AVD and
   * console port, so a launcher that exits before qemu does not drop it.
   */
  prune(discovered: readonly Pick<AndroidRunningEmulator, "avdName" | "consolePort">[] = []): void {
    const before = this.read();
    const records = before.filter((record) =>
      isProcessAlive(record.pid ?? record.launcherPid)
      || isProcessAlive(record.launcherPid)
      || (record.pid === null
        && discovered.some((emulator) => sameAvdName(emulator.avdName, record.avdName) && emulator.consolePort === record.consolePort)));
    if (records.length !== before.length) this.save(records);
  }
}

/** `sys.boot_completed` is 1. Never throws; an offline or busy emulator reads false. */
export async function readAndroidBootCompleted(adbPath: string, serial: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const value = await runAdbText(adbPath, ["shell", "getprop", "sys.boot_completed"], { serial, timeoutMs, allowFailure: true });
    return value === "1";
  } catch {
    return false;
  }
}

/* ---------- ports ---------- */

/** Console ports are even, 5554–5682 (64 emulators); adb is console + 1. */
const ANDROID_CONSOLE_PORT_FIRST = 5554;
const ANDROID_CONSOLE_PORT_LAST = 5682;
const GRPC_PORT_FIRST = 8554;

/** Ports this process has handed out and whose emulator has not exited yet. */
const reservedPorts = new Set<number>();

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    // Loopback only: a listen on every interface would raise the Windows
    // firewall prompt for a check that keeps the port for a millisecond.
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export type AndroidEmulatorPorts = {
  consolePort: number;
  adbPort: number;
  grpcPort: number;
  /** Gives the ports back to this process's pool; the launch calls it when its emulator exits. */
  release: () => void;
};

/**
 * A free console/adb pair and a gRPC port for one new emulator. Skips every
 * port a running emulator uses (the user's included), every port this
 * process already handed out, and every port something else is bound to.
 * gRPC prefers the emulator's own convention, 8554 + (console − 5554).
 */
async function allocateAndroidEmulatorPorts(
  running: readonly Pick<AndroidRunningEmulator, "consolePort" | "adbPort" | "grpcPort">[],
): Promise<AndroidEmulatorPorts> {
  const used = new Set<number>(reservedPorts);
  for (const emulator of running) {
    used.add(emulator.consolePort);
    used.add(emulator.adbPort);
    if (emulator.grpcPort) used.add(emulator.grpcPort);
  }
  for (let consolePort = ANDROID_CONSOLE_PORT_FIRST; consolePort <= ANDROID_CONSOLE_PORT_LAST; consolePort += 2) {
    const adbPort = consolePort + 1;
    if (used.has(consolePort) || used.has(adbPort)) continue;
    if (!(await portIsFree(consolePort)) || !(await portIsFree(adbPort))) continue;
    const grpcPort = await pickGrpcPort(GRPC_PORT_FIRST + (consolePort - ANDROID_CONSOLE_PORT_FIRST), used);
    if (grpcPort === null) break;
    const taken = [consolePort, adbPort, grpcPort];
    for (const port of taken) reservedPorts.add(port);
    let released = false;
    return {
      consolePort,
      adbPort,
      grpcPort,
      release: () => {
        if (released) return;
        released = true;
        for (const port of taken) reservedPorts.delete(port);
      },
    };
  }
  throw new AndroidEmulatorFailure(
    "ANDROID_NO_FREE_PORT",
    `Every emulator port pair from ${ANDROID_CONSOLE_PORT_FIRST} to ${ANDROID_CONSOLE_PORT_LAST + 1} is in use. Stop an emulator and try again.`,
  );
}

async function pickGrpcPort(preferred: number, used: ReadonlySet<number>): Promise<number | null> {
  const candidates = [preferred];
  for (let port = GRPC_PORT_FIRST; port <= GRPC_PORT_FIRST + 128; port += 1) candidates.push(port);
  for (const port of candidates) {
    if (!used.has(port) && await portIsFree(port)) return port;
  }
  return null;
}

/* ---------- launch, boot, stop ---------- */

/**
 * How the boot treats the AVD's quick-boot snapshot:
 * - `cold`: `-no-snapshot`, a clean cold boot that neither loads nor saves
 *   one. For AVDs ADE made: every start is the same, and stop has no
 *   multi-GB snapshot to write.
 * - `no-save`: `-no-snapshot-save`, loads the user's snapshot but does not
 *   save one. For an attached user AVD. The emulator still rewrites its small
 *   `snapshot.pb` (measured), so the AVD is not left byte-identical.
 */
export type AndroidSnapshotMode = "cold" | "no-save";

export type LaunchAndroidEmulatorInput = {
  emulatorPath: string;
  sdkRoot: string;
  avdHome: string;
  avdName: string;
  /** The emulator's stdout and stderr go here (the panel's "Open log"). */
  logPath: string;
  snapshot: AndroidSnapshotMode;
  registry?: AdeStartedEmulators | null;
  discoveryDirs?: readonly string[];
  env?: AndroidEnv;
  /**
   * Its own process group, so the emulator outlives this process: a brain
   * that exits (an update, a restart) hands it to the next brain instead of
   * taking it down with its own group.
   */
  detached?: boolean;
};

export type AndroidEmulatorExit = { code: number | null; signal: NodeJS.Signals | null; error: string | null };

export type AndroidEmulatorLaunch = {
  avdName: string;
  serial: string;
  consolePort: number;
  adbPort: number;
  grpcPort: number;
  /** The process ADE spawned (`emulator`); qemu's pid comes from the boot wait. */
  launcherPid: number;
  logPath: string;
  /** `Date.now()` at spawn; boot times are measured from here. */
  startedAt: number;
  child: ChildProcess;
  /** Settles when the launcher exits, for any reason. */
  exit: Promise<AndroidEmulatorExit>;
  /** The exit, once it happened. */
  exited: () => AndroidEmulatorExit | null;
};

/** The emulator flags ADE always passes, before the snapshot flag. */
function androidEmulatorArgs(input: { avdName: string; consolePort: number; grpcPort: number; snapshot: AndroidSnapshotMode }): string[] {
  return [
    "-avd", input.avdName,
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-gpu", "auto",
    "-port", String(input.consolePort),
    "-grpc", String(input.grpcPort),
    input.snapshot === "cold" ? "-no-snapshot" : "-no-snapshot-save",
    // No usage reports to Google from an emulator ADE starts.
    "-no-metrics",
  ];
}

/**
 * Starts an AVD headless and returns at once; `waitForAndroidBoot` waits for
 * it. The emulator is ADE's child (not detached): ADE owns it and stops it.
 *
 * Refuses an AVD that does not exist or already runs (one AVD boots once at a
 * time).
 */
export async function launchAndroidEmulator(input: LaunchAndroidEmulatorInput): Promise<AndroidEmulatorLaunch> {
  if (!fs.existsSync(input.emulatorPath)) {
    throw new AndroidEmulatorFailure("ANDROID_TOOL_MISSING", `The Android emulator is not installed at ${input.emulatorPath}.`);
  }
  if (!readAndroidAvd(input.avdHome, input.avdName)) {
    throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `No AVD named ${input.avdName} is on this machine.`);
  }
  const running = readAndroidDiscoveryFiles(input.discoveryDirs ?? androidDiscoveryDirs());
  const already = running.find((emulator) => sameAvdName(emulator.avdName, input.avdName));
  if (already) {
    throw new AndroidEmulatorFailure("ANDROID_AVD_RUNNING", `${input.avdName} is already running as ${already.serial}.`);
  }
  const ports = await allocateAndroidEmulatorPorts(running);
  const args = androidEmulatorArgs({ avdName: input.avdName, consolePort: ports.consolePort, grpcPort: ports.grpcPort, snapshot: input.snapshot });

  fs.mkdirSync(path.dirname(input.logPath), { recursive: true });
  const logFd = fs.openSync(input.logPath, "a");
  let child: ChildProcess;
  try {
    fs.writeSync(logFd, `# ADE started ${input.emulatorPath} ${args.join(" ")} at ${new Date().toISOString()}\n`);
    child = spawn(input.emulatorPath, args, {
      cwd: path.dirname(input.emulatorPath),
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      detached: input.detached === true,
      env: {
        ...(input.env ?? process.env),
        // Both names, equal, so the emulator finds this SDK and never warns
        // that they disagree; the AVD folder is the one ADE listed.
        ANDROID_HOME: input.sdkRoot,
        ANDROID_SDK_ROOT: input.sdkRoot,
        ANDROID_AVD_HOME: input.avdHome,
      },
    });
  } catch (error) {
    ports.release();
    throw error;
  } finally {
    fs.closeSync(logFd);
  }

  let exitInfo: AndroidEmulatorExit | null = null;
  const exit = new Promise<AndroidEmulatorExit>((resolve) => {
    const settle = (info: AndroidEmulatorExit) => {
      if (exitInfo) return;
      exitInfo = info;
      ports.release();
      resolve(info);
    };
    child.once("error", (error) => settle({ code: null, signal: null, error: error.message }));
    child.once("exit", (code, signal) => settle({ code, signal, error: null }));
  });
  const launcherPid = child.pid;
  if (!launcherPid) {
    const info = await exit;
    throw new AndroidEmulatorFailure("ANDROID_EMULATOR_EXITED", `The emulator did not start: ${info.error ?? "no process"}.`, input.logPath);
  }
  input.registry?.record({ avdName: input.avdName, consolePort: ports.consolePort, launcherPid, pid: null });
  return {
    avdName: input.avdName,
    serial: `emulator-${ports.consolePort}`,
    consolePort: ports.consolePort,
    adbPort: ports.adbPort,
    grpcPort: ports.grpcPort,
    launcherPid,
    logPath: input.logPath,
    startedAt: Date.now(),
    child,
    exit,
    exited: () => exitInfo,
  };
}

/** The last error line of an emulator log (`ERROR | …`, `FATAL | …`), for the panel's sentence. */
function lastAndroidEmulatorLogError(logPath: string): string | null {
  let text: string;
  try {
    const stat = fs.statSync(logPath);
    const length = Math.min(stat.size, 16 * 1024);
    const fd = fs.openSync(logPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/\b(ERROR|FATAL|PANIC)\b/u.test(lines[index]!)) return lines[index]!;
  }
  return null;
}

function exitedFailure(launch: AndroidEmulatorLaunch, info: AndroidEmulatorExit): AndroidEmulatorFailure {
  const how = info.error ? info.error : info.signal ? `signal ${info.signal}` : `code ${info.code}`;
  const reason = lastAndroidEmulatorLogError(launch.logPath);
  return new AndroidEmulatorFailure(
    "ANDROID_EMULATOR_EXITED",
    `The emulator for ${launch.avdName} exited (${how}) before it finished booting.${reason ? ` ${reason}` : ""}`,
    launch.logPath,
  );
}

export type AndroidBootResult = {
  /** qemu's pid, from the discovery file (equal to the launcher's on macOS and Linux). */
  pid: number;
  /** From spawn to `adb wait-for-device` returning. */
  waitForDeviceMs: number;
  /** From spawn to `sys.boot_completed` = 1. */
  bootCompletedMs: number;
};

/**
 * Waits until the emulator is booted: `adb wait-for-device`, then
 * `sys.boot_completed` = 1, then its discovery file. Throws
 * `ANDROID_EMULATOR_EXITED` as soon as the emulator exits, and
 * `ANDROID_BOOT_TIMEOUT` after `timeoutMs` (a cold boot measured 24 s on
 * Windows). On a timeout the emulator is left running; the caller stops it.
 */
export async function waitForAndroidBoot(
  launch: AndroidEmulatorLaunch,
  options: { adbPath: string; timeoutMs?: number; registry?: AdeStartedEmulators | null; discoveryDirs?: readonly string[] },
): Promise<AndroidBootResult> {
  if (!fs.existsSync(options.adbPath)) {
    throw new AndroidEmulatorFailure("ANDROID_TOOL_MISSING", `adb is not installed at ${options.adbPath}.`);
  }
  const deadline = launch.startedAt + (options.timeoutMs ?? 120_000);
  const exitRace = launch.exit.then((info) => {
    throw exitedFailure(launch, info);
  });
  // Unhandled until a race picks it up; this keeps a quiet early exit from
  // being reported as an unhandled rejection.
  exitRace.catch(() => undefined);
  const remaining = () => deadline - Date.now();
  const checkAlive = () => {
    const info = launch.exited();
    if (info) throw exitedFailure(launch, info);
    if (remaining() <= 0) {
      throw new AndroidEmulatorFailure(
        "ANDROID_BOOT_TIMEOUT",
        `${launch.avdName} did not finish booting in ${Math.round((options.timeoutMs ?? 120_000) / 1000)} s.`,
        launch.logPath,
      );
    }
  };

  // `wait-for-device` in short slices: an adb call cannot be cancelled, so a
  // slice that times out is simply asked again while the emulator lives.
  for (;;) {
    checkAlive();
    const slice = Math.max(250, Math.min(5_000, remaining()));
    const attempt = runAdb(options.adbPath, ["wait-for-device"], { serial: launch.serial, timeoutMs: slice })
      .then(() => true, () => false);
    if (await Promise.race([attempt, exitRace])) break;
    await Promise.race([sleep(250), exitRace]);
  }
  const waitForDeviceMs = Date.now() - launch.startedAt;

  for (;;) {
    checkAlive();
    const booted = await Promise.race([readAndroidBootCompleted(options.adbPath, launch.serial, Math.max(250, Math.min(5_000, remaining()))), exitRace]);
    if (booted) break;
    await Promise.race([sleep(500), exitRace]);
  }
  const bootCompletedMs = Date.now() - launch.startedAt;

  // The discovery file is written early in boot; by now it is there.
  let pid = launch.launcherPid;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = readAndroidDiscoveryFiles(options.discoveryDirs ?? androidDiscoveryDirs())
      .find((emulator) => sameAvdName(emulator.avdName, launch.avdName) && emulator.consolePort === launch.consolePort);
    if (found) {
      pid = found.pid;
      break;
    }
    checkAlive();
    await sleep(250);
  }
  options.registry?.record({ avdName: launch.avdName, consolePort: launch.consolePort, launcherPid: launch.launcherPid, pid });
  return { pid, waitForDeviceMs, bootCompletedMs };
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(200);
  }
  return !isProcessAlive(pid);
}

export type StopAndroidEmulatorInput = {
  adbPath: string;
  serial: string;
  consolePort: number;
  avdName: string;
  /** qemu's pid (the discovery file's). */
  pid: number;
  /** The launcher ADE spawned, when it is not qemu itself (Windows). */
  launcherPid?: number | null;
  /** How long `emu kill` gets before the last resort. */
  timeoutMs?: number;
  registry?: AdeStartedEmulators | null;
  discoveryDirs?: readonly string[];
};

export type AndroidStopResult = {
  /** `emu-kill` = a clean exit; `terminate` = the verified pid was killed. */
  method: "already-exited" | "emu-kill" | "terminate";
  ms: number;
};

/**
 * Stops one emulator: `adb emu kill`, then waits for qemu to exit. Only if it
 * does not, kills the pid, and only after checking it is still this
 * emulator (its discovery file names the same AVD and console port), so a
 * reused pid is never killed. The caller makes sure ADE started it.
 */
export async function stopAndroidEmulator(input: StopAndroidEmulatorInput): Promise<AndroidStopResult> {
  const startedAt = Date.now();
  const done = (method: AndroidStopResult["method"]): AndroidStopResult => {
    input.registry?.forget({ avdName: input.avdName, consolePort: input.consolePort });
    return { method, ms: Date.now() - startedAt };
  };
  const launcherGone = async () => {
    const launcher = input.launcherPid;
    if (!launcher || launcher === input.pid) return;
    // The Windows launcher exits right after qemu; a launcher still there is
    // ADE's own child, so it may be ended.
    if (!(await waitForExit(launcher, 5_000))) {
      try {
        process.kill(launcher);
      } catch {
        // Gone already.
      }
    }
  };

  if (!isProcessAlive(input.pid)) {
    await launcherGone();
    return done("already-exited");
  }
  await runAdb(input.adbPath, ["emu", "kill"], { serial: input.serial, timeoutMs: 10_000, allowFailure: true }).catch(() => undefined);
  if (await waitForExit(input.pid, input.timeoutMs ?? 20_000)) {
    await launcherGone();
    return done("emu-kill");
  }

  const stillThisEmulator = readAndroidDiscoveryFiles(input.discoveryDirs ?? androidDiscoveryDirs())
    .some((emulator) => emulator.pid === input.pid && sameAvdName(emulator.avdName, input.avdName) && emulator.consolePort === input.consolePort);
  if (!stillThisEmulator) {
    throw new Error(`Emulator ${input.serial} did not exit, and pid ${input.pid} no longer matches its discovery file; ADE will not kill it.`);
  }
  try {
    process.kill(input.pid, "SIGTERM");
  } catch {
    // It exited between the check and the kill.
  }
  if (!(await waitForExit(input.pid, 5_000))) {
    try {
      process.kill(input.pid, "SIGKILL");
    } catch {
      // Gone.
    }
    if (!(await waitForExit(input.pid, 5_000))) {
      throw new Error(`Emulator ${input.serial} (pid ${input.pid}) did not exit after a kill.`);
    }
  }
  await launcherGone();
  return done("terminate");
}

/**
 * Stops an emulator this process launched, at any point of its boot. Before
 * qemu wrote its discovery file there is no qemu pid yet, so it waits a
 * little for one (or for the launcher to exit) before ending the launcher.
 */
export async function stopAndroidLaunch(
  launch: AndroidEmulatorLaunch,
  options: { adbPath: string; registry: AdeStartedEmulators; discoveryDirs: readonly string[]; logger?: Pick<Logger, "warn"> | null },
): Promise<void> {
  const { adbPath, registry, discoveryDirs, logger } = options;
  const isThisLaunch = (emulator: AndroidDiscoveredEmulator) =>
    emulator.consolePort === launch.consolePort && sameAvdName(emulator.avdName, launch.avdName);
  const deadline = Date.now() + 15_000;
  while (!launch.exited()) {
    const found = readAndroidDiscoveryFiles(discoveryDirs).find(isThisLaunch);
    if (found) {
      await stopAndroidEmulator({
        adbPath,
        serial: found.serial,
        consolePort: found.consolePort,
        avdName: found.avdName,
        pid: found.pid,
        launcherPid: launch.launcherPid,
        registry,
        discoveryDirs,
      });
      return;
    }
    if (Date.now() >= deadline) break;
    await Promise.race([sleep(250), launch.exit]);
  }
  if (!launch.exited()) {
    // No discovery file after 15 s. qemu may still be starting under the
    // launcher (Windows), so end the whole tree, not only the launcher.
    terminateProcessTree(launch.child, "SIGTERM", (detail) =>
      logger?.warn("android.emulator_tree_kill_failed", { avdName: launch.avdName, pid: detail.pid, status: detail.status }));
    await Promise.race([launch.exit, sleep(5_000)]);
  }
  // A qemu that outlived the kill stays ADE's, so a later stop can still end it.
  if (readAndroidDiscoveryFiles(discoveryDirs).some(isThisLaunch)) {
    logger?.warn("android.emulator_survived_stop", { avdName: launch.avdName, consolePort: launch.consolePort });
    return;
  }
  registry.forget({ avdName: launch.avdName, consolePort: launch.consolePort });
}
