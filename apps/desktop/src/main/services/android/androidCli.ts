import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BootedDevice } from "./androidDeviceShell";
import type { AndroidEnv } from "./androidSdk";
import { parseAndroidCliLayout, type ParsedUiTree } from "./androidUiTree";

/*
 * Google's Android CLI (`android`, v1.1+). Optional: ADE works with `adb`,
 * `emulator` and the SDK alone, and uses the CLI only when it is installed
 * (the UI tree, Compose previews, delta installs).
 *
 * ADE always passes `--no-metrics`: the CLI sends usage data to Google
 * unless told not to. Every caller goes through `androidCliArgs`.
 *
 * The name `android` also belongs to the old SDK `tools/android` script, so a
 * binary on PATH counts only when `--version` prints a bare version number.
 */

/** Where the guided install puts the CLI: inside the SDK, so removing the SDK removes it. */
export function androidCliInstallPath(sdkRoot: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(sdkRoot, "android-cli", platform === "win32" ? "android.exe" : "android");
}

/** The download for this host (`darwin_arm64`, `windows_x86_64`, …), or null when Google publishes none. */
export function androidCliDownloadUrl(platform: NodeJS.Platform, machine: string): string | null {
  const arch = /^(arm64|aarch64)/iu.test(machine) ? "arm64" : "x86_64";
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null;
  if (!os || (os === "windows" && arch === "arm64")) return null;
  return `https://dl.google.com/android/cli/latest/${os}_${arch}/android${os === "windows" ? ".exe" : ""}`;
}

/** Every CLI call starts with these: never send usage data. */
export function androidCliArgs(sdkRoot: string | null, args: readonly string[]): string[] {
  return ["--no-metrics", ...(sdkRoot ? [`--sdk=${sdkRoot}`] : []), ...args];
}

function isExecutableFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function pathCandidates(env: AndroidEnv, platform: NodeJS.Platform): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  const names = platform === "win32" ? ["android.exe"] : ["android"];
  const out: string[] = [];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) out.push(path.join(dir, name));
  }
  return out;
}

export type AndroidCliLocation = { path: string; source: "ade" | "path"; version: string | null };

type CliCacheEntry = { key: string; at: number; value: string | null };
const versionCache = new Map<string, CliCacheEntry>();
/** The `--version` run in progress per binary, so concurrent reads share one (a first run unpacks for minutes). */
const versionReads = new Map<string, { key: string; promise: Promise<string | null> }>();
const VERSION_TTL_MS = 10 * 60_000;
/** The first run of a fresh CLI unpacks its bundle (about 150 MB, some seconds, minutes on a slow disk). */
const VERSION_TIMEOUT_MS = 120_000;

/** The binary's cache key (mtime + size), or null when it is not there. */
function versionKey(binary: string): string | null {
  try {
    const stat = fs.statSync(binary);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** Runs `--version` once per binary and key; a second caller joins the run. */
function startVersionRead(binary: string, key: string): Promise<string | null> {
  const running = versionReads.get(binary);
  if (running && running.key === key) return running.promise;
  const read = new Promise<string | null>((resolve) => {
    execFile(binary, androidCliArgs(null, ["--version"]), { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const line = stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean).pop() ?? "";
      resolve(/^\d+(\.\d+){1,3}$/u.test(line) ? line : null);
    });
  });
  const promise = read.then((value) => {
    versionCache.set(binary, { key, at: Date.now(), value });
    if (versionReads.get(binary)?.promise === promise) versionReads.delete(binary);
    return value;
  });
  versionReads.set(binary, { key, promise });
  return promise;
}

/**
 * `android --no-metrics --version`, cached per binary (path + mtime + size).
 * Waits for the run when the cache has no fresh answer; concurrent callers
 * share one run.
 */
export async function readAndroidCliVersion(binary: string): Promise<string | null> {
  const key = versionKey(binary);
  if (!key) return null;
  const cached = versionCache.get(binary);
  if (cached && cached.key === key && Date.now() - cached.at < VERSION_TTL_MS) return cached.value;
  return startVersionRead(binary, key);
}

/**
 * The cached `--version` answer without waiting: `undefined` while no run has
 * answered for this binary yet. A missing or stale answer starts a run in the
 * background, so a later read has it. For the status path, which must answer
 * in seconds.
 */
function peekAndroidCliVersion(binary: string): string | null | undefined {
  const key = versionKey(binary);
  if (!key) return null;
  const cached = versionCache.get(binary);
  const known = cached && cached.key === key ? cached : null;
  if (!known || Date.now() - known.at >= VERSION_TTL_MS) void startVersionRead(binary, key);
  return known ? known.value : undefined;
}

/**
 * The CLI ADE installed into the SDK first, then one on PATH that answers
 * `--version` like the new CLI. Null when neither is there.
 */
export async function locateAndroidCli(options: {
  sdkRoot: string | null;
  env?: AndroidEnv;
  platform?: NodeJS.Platform;
  /**
   * False: answer from the version cache and never wait for `--version`
   * (`peekAndroidCliVersion`). The ADE-installed CLI then reads with a null
   * version, and a PATH binary not checked yet does not count until a later
   * read. Default true.
   */
  wait?: boolean;
}): Promise<AndroidCliLocation | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const wait = options.wait !== false;
  const versionOf = async (binary: string): Promise<string | null | undefined> =>
    wait ? readAndroidCliVersion(binary) : peekAndroidCliVersion(binary);
  if (options.sdkRoot) {
    const own = androidCliInstallPath(options.sdkRoot, platform);
    if (isExecutableFile(own)) return { path: own, source: "ade", version: (await versionOf(own)) ?? null };
  }
  for (const candidate of pathCandidates(env, platform)) {
    if (!isExecutableFile(candidate)) continue;
    // The old SDK `tools/android` lives in `<sdk>/tools`; skip it without running it.
    if (path.basename(path.dirname(candidate)) === "tools") continue;
    const version = await versionOf(candidate);
    if (version) return { path: candidate, source: "path", version };
  }
  return null;
}

/** Runs one Android CLI command and answers its stdout; a failure names the command (without `--sdk=`) and its stderr. */
function runAndroidCli(
  cliPath: string,
  args: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cliPath, [...args], {
      timeout: options.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: options.env,
      signal: options.signal,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${path.basename(cliPath)} ${args.filter((arg) => !arg.startsWith("--sdk=")).join(" ")} failed: ${String(stderr || error.message).trim().slice(0, 400)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** A first `android layout` unpacks the CLI's bundle (~150 MB). */
const ANDROID_CLI_LAYOUT_TIMEOUT_MS = 120_000;

/**
 * The screen's UI tree from `android layout`. It waits for the screen to
 * settle first; a screen that never settles (the launcher's animated icons, a
 * video) answers "Could not obtain idle state", and then it is read as it is
 * (`--no-idle`). Measured on API 37: 3.0 s settled, 1.0 s with `--no-idle`.
 * The first call on a device installs the CLI's layout server and prints a
 * line about it before the JSON; `parseAndroidCliLayout` skips that line. The
 * server stays on the device between calls, so `uiautomator dump` cannot run
 * while it does (`androidUiSnapshot.ts` stops it).
 */
export async function dumpWithAndroidCli(
  booted: BootedDevice,
  cliPath: string,
  sdkRoot: string,
  options: { env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<ParsedUiTree> {
  const run = (extra: string[]) => runAndroidCli(cliPath, androidCliArgs(sdkRoot, ["layout", `--device=${booted.serial}`, ...extra]), {
    timeoutMs: ANDROID_CLI_LAYOUT_TIMEOUT_MS,
    env: { ...options.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot },
    signal: options.signal,
  });
  let stdout: string;
  try {
    stdout = await run([]);
  } catch (error) {
    if (!/idle state/iu.test(error instanceof Error ? error.message : String(error))) throw error;
    stdout = await run(["--no-idle"]);
  }
  return parseAndroidCliLayout(stdout);
}
