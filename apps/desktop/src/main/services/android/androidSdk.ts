import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AndroidAcceleration,
  AndroidSdkSource,
  AndroidSdkStatus,
  AndroidSdkTool,
  AndroidSystemImage,
} from "../../../shared/types/androidEmulator";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";

/*
 * Where this machine's Android SDK is and what it holds: the tools, the
 * installed system images, hardware acceleration and the AVD folder.
 *
 * Read at the time of use, never once at start (t3code's repeated bug: an SDK
 * installed while the app ran stayed "missing"). Everything here is a few
 * `stat`s and small file reads; the one process, `emulator -accel-check`, is
 * cached per emulator binary.
 *
 * Node built-ins only, so it runs under `tsx` on a machine with no
 * `node_modules`.
 */

export type AndroidEnv = Readonly<Record<string, string | undefined>>;

export type AndroidSdkLocateOptions = {
  /** The SDK the user picked in Settings ("Use mine…"). */
  settingPath?: string | null;
  env?: AndroidEnv;
  platform?: NodeJS.Platform;
  home?: string;
};

/** `key=value` lines (`config.ini`, `source.properties`, discovery files); `#` starts a comment. */
export function parseAndroidIni(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return values;
}

/** An ini file's values, or null when it cannot be read. */
export function readAndroidIniFile(filePath: string): Map<string, string> | null {
  try {
    return parseAndroidIni(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** The platform's default SDK folder, the one Android Studio installs to. */
function androidDefaultSdkRoot(
  platform: NodeJS.Platform = process.platform,
  env: AndroidEnv = process.env,
  home = os.homedir(),
): string {
  if (platform === "darwin") return path.join(home, "Library", "Android", "sdk");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Android", "Sdk");
  return path.join(home, "Android", "Sdk");
}

/**
 * A folder that holds at least one SDK part. An env var left pointing at a
 * deleted SDK is not an answer; the next candidate is tried instead.
 */
function looksLikeSdkRoot(dir: string): boolean {
  return ["platform-tools", "emulator", "system-images", "cmdline-tools"].some((part) => isDirectory(path.join(dir, part)));
}

/**
 * The SDK root and where it came from.
 *
 * The Settings path wins: it is the user's explicit choice in ADE, and a Dock
 * launch on macOS has no shell env at all. Then `ANDROID_HOME`, the deprecated
 * `ANDROID_SDK_ROOT`, then the platform default.
 */
export function locateAndroidSdk(options: AndroidSdkLocateOptions = {}): { root: string; source: AndroidSdkSource } | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const candidates: Array<{ dir: string | null | undefined; source: AndroidSdkSource }> = [
    { dir: options.settingPath, source: "setting" },
    { dir: env.ANDROID_HOME, source: "ANDROID_HOME" },
    { dir: env.ANDROID_SDK_ROOT, source: "ANDROID_SDK_ROOT" },
    { dir: androidDefaultSdkRoot(platform, env, options.home ?? os.homedir()), source: "default" },
  ];
  for (const candidate of candidates) {
    const dir = candidate.dir?.trim();
    if (!dir) continue;
    const root = path.resolve(dir);
    if (looksLikeSdkRoot(root)) return { root, source: candidate.source };
  }
  return null;
}

export type AndroidSdkPaths = {
  root: string;
  adb: string;
  emulator: string;
  /** The cmdline-tools `bin` folder in use, when any is installed. */
  cmdlineToolsBin: string | null;
  sdkmanager: string | null;
  avdmanager: string | null;
};

/**
 * The cmdline-tools folder: `latest` first, else the highest versioned one
 * (`cmdline-tools/19.0`), else the legacy `tools`. Returns the package folder
 * (the one with `bin` and `lib`).
 */
export function androidCmdlineToolsDir(root: string): string | null {
  const base = path.join(root, "cmdline-tools");
  if (isDirectory(path.join(base, "latest", "bin"))) return path.join(base, "latest");
  let versions: string[] = [];
  try {
    versions = fs.readdirSync(base).filter((name) => /^\d+(\.\d+)*$/u.test(name) && isDirectory(path.join(base, name, "bin")));
  } catch {
    // No cmdline-tools folder.
  }
  versions.sort((a, b) => compareVersions(b, a));
  if (versions[0]) return path.join(base, versions[0]);
  const legacy = path.join(root, "tools");
  return isDirectory(path.join(legacy, "bin")) ? legacy : null;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The binaries ADE runs, with Windows' `.exe` and `.bat` suffixes. */
export function androidSdkPaths(root: string, platform: NodeJS.Platform = process.platform): AndroidSdkPaths {
  const exe = platform === "win32" ? ".exe" : "";
  const bat = platform === "win32" ? ".bat" : "";
  const cmdline = androidCmdlineToolsDir(root);
  const bin = cmdline ? path.join(cmdline, "bin") : null;
  return {
    root,
    adb: path.join(root, "platform-tools", `adb${exe}`),
    emulator: path.join(root, "emulator", `emulator${exe}`),
    cmdlineToolsBin: bin,
    sdkmanager: bin ? path.join(bin, `sdkmanager${bat}`) : null,
    avdmanager: bin ? path.join(bin, `avdmanager${bat}`) : null,
  };
}

/** `Pkg.Revision` from a package's `source.properties` (`37.1.11`). */
function androidPackageRevision(packageDir: string): string | null {
  return readAndroidIniFile(path.join(packageDir, "source.properties"))?.get("Pkg.Revision") ?? null;
}

/**
 * The folder holding the user's Android config (`devices.xml`, the default
 * `avd` folder): `ANDROID_EMULATOR_HOME`, `ANDROID_USER_HOME`, the deprecated
 * `ANDROID_SDK_HOME/.android`, else `~/.android`. The emulator reads the same
 * variables, and ADE passes its env on, so both agree.
 */
export function androidUserHome(env: AndroidEnv = process.env, home = os.homedir()): string {
  const explicit = env.ANDROID_EMULATOR_HOME?.trim() || env.ANDROID_USER_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  const sdkHome = env.ANDROID_SDK_HOME?.trim();
  if (sdkHome) return path.join(path.resolve(sdkHome), ".android");
  return path.join(home, ".android");
}

/** The AVD folder: `ANDROID_AVD_HOME`, else `<user home>/avd`. */
export function androidAvdHome(env: AndroidEnv = process.env, home = os.homedir()): string {
  const explicit = env.ANDROID_AVD_HOME?.trim();
  return explicit ? path.resolve(explicit) : path.join(androidUserHome(env, home), "avd");
}

/**
 * The only system-image ABI this host runs at full speed: Apple Silicon (HVF)
 * runs only `arm64-v8a`, every x86 host runs `x86_64`.
 */
function androidHostAbi(machine: string = typeof os.machine === "function" ? os.machine() : process.arch): "x86_64" | "arm64-v8a" {
  return /^(arm64|aarch64)/iu.test(machine) ? "arm64-v8a" : "x86_64";
}

/**
 * The installed system images, from `system-images/<platform>/<tag>/<abi>/`.
 * A folder counts once it has a `source.properties` (sdkmanager writes it
 * last, so a half-finished download is not listed). Newest API first.
 */
export function listAndroidSystemImages(root: string): AndroidSystemImage[] {
  const base = path.join(root, "system-images");
  const images: AndroidSystemImage[] = [];
  for (const platformDir of safeReaddir(base)) {
    for (const tag of safeReaddir(path.join(base, platformDir))) {
      for (const abi of safeReaddir(path.join(base, platformDir, tag))) {
        const dir = path.join(base, platformDir, tag, abi);
        const props = readAndroidIniFile(path.join(dir, "source.properties"));
        if (!props) continue;
        const apiFromProps = Number(props.get("AndroidVersion.ApiLevel"));
        const apiFromFolder = Number(/^android-(\d+)/u.exec(platformDir)?.[1]);
        const apiLevel = Number.isFinite(apiFromProps) && apiFromProps > 0 ? apiFromProps : apiFromFolder;
        if (!Number.isFinite(apiLevel) || apiLevel <= 0) continue;
        images.push({
          packageId: `system-images;${platformDir};${tag};${abi}`,
          apiLevel,
          tag: props.get("SystemImage.TagId") || tag,
          abi: props.get("SystemImage.Abi") || abi,
          path: dir,
        });
      }
    }
  }
  return images.sort((a, b) => b.apiLevel - a.apiLevel || a.packageId.localeCompare(b.packageId));
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * `emulator -accel-check` reduced to the panel's shape. The output is
 *
 *     accel:
 *     0
 *     WHPX(10.0.26200) is installed and usable.
 *     accel
 *
 * where the number is the emulator's status code (0 = usable).
 */
function parseAccelCheck(output: string, exitCode: number | null): AndroidAcceleration {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const start = lines.indexOf("accel:");
  const body = start >= 0 ? lines.slice(start + 1).filter((line) => line !== "accel") : lines;
  const statusLine = body.find((line) => /^\d+$/u.test(line));
  const status = statusLine === undefined ? exitCode : Number(statusLine);
  const detail = body.filter((line) => line !== statusLine).join(" ").trim() || null;
  const haystack = detail ?? "";
  const kind: AndroidAcceleration["kind"] = /WHPX/u.test(haystack) ? "WHPX"
    : /AEHD|Android Emulator hypervisor/iu.test(haystack) ? "AEHD"
    : /\bKVM\b/u.test(haystack) ? "KVM"
    : /HVF|Hypervisor\.Framework/iu.test(haystack) ? "HVF"
    : null;
  return { kind, usable: status === 0 && exitCode === 0, detail };
}

type AccelCacheEntry = { key: string; at: number; value: AndroidAcceleration };
const accelCache = new Map<string, AccelCacheEntry>();
/** A usable answer holds for 10 minutes; a failure only 30 s, so a fix shows quickly. */
const ACCEL_OK_TTL_MS = 10 * 60_000;
const ACCEL_FAIL_TTL_MS = 30_000;
const ACCEL_CHECK_TIMEOUT_MS = 20_000;

/** Runs `emulator -accel-check`, cached per emulator binary (path + mtime). */
async function readAndroidAcceleration(emulatorPath: string, options: { force?: boolean } = {}): Promise<AndroidAcceleration> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(emulatorPath);
  } catch {
    return { kind: null, usable: false, detail: "The Android emulator is not installed." };
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = accelCache.get(emulatorPath);
  if (!options.force && cached && cached.key === key) {
    const ttl = cached.value.usable ? ACCEL_OK_TTL_MS : ACCEL_FAIL_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.value;
  }
  const value = await new Promise<AndroidAcceleration>((resolve) => {
    execFile(emulatorPath, ["-accel-check"], { timeout: ACCEL_CHECK_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
      if (error && exitCode === null) {
        resolve({ kind: null, usable: false, detail: `emulator -accel-check did not run: ${error.message}` });
        return;
      }
      resolve(parseAccelCheck(`${stdout}\n${stderr}`, exitCode));
    });
  });
  accelCache.set(emulatorPath, { key, at: Date.now(), value });
  return value;
}

export type ReadyAndroidSdk = { sdk: AndroidSdkStatus; root: string; avdHome: string; adbPath: string; emulatorPath: string };

/** The SDK with adb (and the emulator, when asked), or the coded refusal that says what is missing. */
export function requireAndroidSdkTools(
  sdk: AndroidSdkStatus,
  platform: NodeJS.Platform,
  needs: { emulator: boolean },
): ReadyAndroidSdk {
  if (!sdk.found || !sdk.root || !sdk.avdHome) {
    throw new AndroidEmulatorFailure("ANDROID_SDK_NOT_FOUND", "No Android SDK was found on this machine. Install Android Studio or the SDK command-line tools.");
  }
  const paths = androidSdkPaths(sdk.root, platform);
  const tool = (id: "platform-tools" | "emulator") => sdk.tools.find((entry) => entry.id === id);
  const adb = tool("platform-tools");
  if (!adb?.available) {
    throw new AndroidEmulatorFailure("ANDROID_TOOL_MISSING", adb?.detail ?? "Android SDK Platform-Tools (adb) is not installed.");
  }
  if (needs.emulator) {
    const emulator = tool("emulator");
    if (!emulator?.available) {
      throw new AndroidEmulatorFailure("ANDROID_TOOL_MISSING", emulator?.detail ?? "The Android Emulator package is not installed.");
    }
  }
  return { sdk, root: sdk.root, avdHome: sdk.avdHome, adbPath: paths.adb, emulatorPath: paths.emulator };
}

export type AndroidSdkStatusOptions = AndroidSdkLocateOptions & {
  /** Re-run `emulator -accel-check` even when a cached answer is fresh. */
  forceAccelCheck?: boolean;
};

/** The SDK as the panel and `ade android status` read it. */
export async function readAndroidSdkStatus(options: AndroidSdkStatusOptions = {}): Promise<AndroidSdkStatus> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const hostAbi = androidHostAbi();
  const avdHome = androidAvdHome(env, home);
  const checkedAt = new Date().toISOString();
  const located = locateAndroidSdk({ ...options, env, platform, home });
  if (!located) {
    return {
      found: false,
      root: null,
      source: null,
      tools: [],
      acceleration: { kind: null, usable: false, detail: "No Android SDK was found." },
      hostAbi,
      avdHome,
      checkedAt,
    };
  }
  const paths = androidSdkPaths(located.root, platform);
  const adbFound = isFile(paths.adb);
  const emulatorFound = isFile(paths.emulator);
  const cmdlineDir = paths.cmdlineToolsBin ? path.dirname(paths.cmdlineToolsBin) : null;
  const images = listAndroidSystemImages(located.root);
  const hostImages = images.filter((image) => image.abi === hostAbi);
  const tools: AndroidSdkTool[] = [
    {
      id: "platform-tools",
      available: adbFound,
      path: adbFound ? paths.adb : null,
      version: adbFound ? androidPackageRevision(path.join(located.root, "platform-tools")) : null,
      detail: adbFound ? null : "Android SDK Platform-Tools (adb) is not installed.",
    },
    {
      id: "emulator",
      available: emulatorFound,
      path: emulatorFound ? paths.emulator : null,
      version: emulatorFound ? androidPackageRevision(path.join(located.root, "emulator")) : null,
      detail: emulatorFound ? null : "The Android Emulator package is not installed.",
    },
    {
      id: "cmdline-tools",
      available: Boolean(paths.sdkmanager && isFile(paths.sdkmanager)),
      path: paths.sdkmanager && isFile(paths.sdkmanager) ? paths.sdkmanager : null,
      version: cmdlineDir ? androidPackageRevision(cmdlineDir) : null,
      detail: paths.sdkmanager && isFile(paths.sdkmanager) ? null : "Android SDK Command-line Tools are not installed (optional).",
    },
    {
      id: "system-image",
      available: hostImages.length > 0,
      path: hostImages[0]?.path ?? null,
      version: hostImages[0] ? `API ${hostImages[0].apiLevel} ${hostImages[0].tag}` : null,
      detail: hostImages.length > 0
        ? null
        : images.length > 0
          ? `The installed system images are ${[...new Set(images.map((image) => image.abi))].join(", ")}; this machine runs ${hostAbi} images.`
          : `No ${hostAbi} system image is installed.`,
    },
  ];
  const acceleration = emulatorFound
    ? await readAndroidAcceleration(paths.emulator, { force: options.forceAccelCheck })
    : { kind: null, usable: false, detail: "The Android emulator is not installed." };
  return {
    found: true,
    root: located.root,
    source: located.source,
    tools,
    acceleration,
    hostAbi,
    avdHome,
    checkedAt,
  };
}
