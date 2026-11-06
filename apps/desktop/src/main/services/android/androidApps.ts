import { createAndroidChromeSetup } from "./androidChromeSetup";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  AndroidAppInfo,
  AndroidGradleTarget,
  AndroidInstallResult,
  AndroidLaneDevice,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { resolveCliSpawnInvocation, terminateProcessTree } from "../shared/processExecution";
import { getErrorMessage } from "../shared/utils";
import { runAdb } from "./adb";
import { runAdbOutput, runDeviceShell } from "./androidDeviceShell";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import { androidJdkMissingMessage, locateAndroidJdk } from "./androidJdk";
import { containAndroidOutPath } from "./androidScreenshot";

/*
 * Apps on the lane's emulator: list, install (an APK, or a Gradle build in
 * the lane's worktree), launch, terminate, uninstall, open a URL.
 *
 * Rules:
 * - An APK path and the Gradle project must be inside the lane's worktree (or
 *   the chat's work copy), checked lexically and again after symlinks.
 * - A Gradle install runs the project's own wrapper (`gradlew`, or
 *   `gradlew.bat` through `cmd.exe` on Windows) with `ANDROID_SERIAL` set to
 *   the lane's emulator, so `install<Variant>` installs there and nowhere else.
 *   It also gets the SDK (`ANDROID_HOME`, `ANDROID_SDK_ROOT`) and a JDK
 *   (`JAVA_HOME`, from `androidJdk`), because ADE can start without them.
 * - Every package ADE installs is recorded on the lane's row
 *   (`adeInstalledPackages`). On an AVD the lane attached (the user's own, or
 *   one a chat's work copy borrowed), uninstall takes only those, and the
 *   lane's release removes them.
 * - Device commands are quoted for the device's shell (`androidDeviceShell`).
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** A first Gradle build downloads Gradle and the project's dependencies. */
const GRADLE_TIMEOUT_MS = 20 * 60_000;
const ADB_INSTALL_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_LINES = 40;
/** Android package names: dot-separated Java identifiers. */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/u;
/** A Gradle module path segment or variant: no shell or `cmd.exe` metacharacters can get through. */
const GRADLE_NAME = /^[A-Za-z0-9_-]+$/u;

export type AndroidAppsDeps = {
  requireBooted: (laneId: string) => Promise<{ serial: string; adbPath: string }>;
  /** The SDK root, for `ANDROID_HOME` in a Gradle build and for `aapt2`. */
  sdkRoot: () => Promise<string>;
  laneRoot: (laneId: string) => string | null;
  isWorkCopy: (laneId: string) => boolean;
  laneDevice: (laneId: string) => AndroidLaneDevice | null;
  /** Adds a package to the lane row's `adeInstalledPackages`. */
  rememberInstalled: (laneId: string, packageName: string) => void;
  /** Drops it again after an uninstall. */
  forgetInstalled: (laneId: string, packageName: string) => void;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  logger: Logger | null;
};

export function assertPackageName(value: unknown, what = "packageName"): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!PACKAGE_NAME.test(trimmed)) {
    throw new Error(`${what} must be an Android package name such as com.example.app${trimmed ? ` (got ${JSON.stringify(trimmed)})` : ""}.`);
  }
  return trimmed;
}

/**
 * A Gradle module and variant, checked: module `app` and variant `debug` by
 * default, a nested module as `a:b`. Only letters, digits, `-` and `_` pass,
 * so nothing reaches `cmd.exe` or the shell as syntax.
 */
export function readAndroidGradleTarget(target: AndroidGradleTarget | null | undefined): { segments: string[]; variant: string } {
  const moduleName = target?.module?.trim() || "app";
  const variant = target?.variant?.trim() || "debug";
  const segments = moduleName.replace(/^:/u, "").split(":");
  if (!segments.every((segment) => GRADLE_NAME.test(segment)) || !GRADLE_NAME.test(variant)) {
    throw new Error("--module and --variant take letters, digits, '-' and '_' only (a nested module as a:b).");
  }
  return { segments, variant };
}

function tail(text: string, lines = OUTPUT_TAIL_LINES): string[] {
  return text.split(/\r?\n/u).map((line) => line.trimEnd()).filter(Boolean).slice(-lines);
}

/** `com.example/.MainActivity` lines from `cmd package query-activities --brief` / `resolve-activity --brief`. */
function parseComponents(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z][\w.]*)\/([\w.$]+)\s*$/u.exec(line);
    if (match) out.push(`${match[1]}/${match[2]}`);
  }
  return out;
}

/** `package:com.example` lines from `pm list packages`. */
function parsePackageList(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => /^package:(\S+)/u.exec(line.trim())?.[1] ?? null)
    .filter((name): name is string => Boolean(name));
}

/** `TotalTime: 412` from `am start -W`. */
function parseTotalTime(text: string): number | null {
  const match = /TotalTime:\s*(\d+)/u.exec(text);
  return match ? Number(match[1]) : null;
}

/** The `applicationId` and APK of a Gradle variant, from AGP's `output-metadata.json`. */
function readGradleOutputMetadata(moduleDir: string, variant: string): { applicationId: string | null; apkPath: string | null } {
  const apkRoot = path.join(moduleDir, "build", "outputs", "apk");
  const found: Array<{ file: string; mtimeMs: number }> = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && entry.name === "output-metadata.json") {
        try {
          found.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
        } catch {
          // Gone between the read and the stat.
        }
      }
    }
  };
  walk(apkRoot, 0);
  // The newest file whose variant matches; a flavoured variant (`freeDebug`)
  // lives in `free/debug`.
  for (const { file } of found.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(file, "utf8")) as {
        applicationId?: unknown;
        variantName?: unknown;
        elements?: Array<{ outputFile?: unknown }>;
      };
      if (typeof metadata.variantName === "string" && metadata.variantName.toLowerCase() !== variant.toLowerCase()) continue;
      const outputFile = metadata.elements?.find((element) => typeof element.outputFile === "string")?.outputFile;
      return {
        applicationId: typeof metadata.applicationId === "string" ? metadata.applicationId : null,
        apkPath: typeof outputFile === "string" ? path.join(path.dirname(file), outputFile) : null,
      };
    } catch {
      continue;
    }
  }
  return { applicationId: null, apkPath: null };
}

/** `aapt2` (or `aapt`) from the newest build-tools, when the SDK has one. */
function findAapt(sdkRoot: string, platform: NodeJS.Platform): string | null {
  const exe = platform === "win32" ? ".exe" : "";
  const buildTools = path.join(sdkRoot, "build-tools");
  let versions: string[];
  try {
    versions = fs.readdirSync(buildTools);
  } catch {
    return null;
  }
  const sorted = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of sorted) {
    for (const name of [`aapt2${exe}`, `aapt${exe}`]) {
      const candidate = path.join(buildTools, version, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** The package name an APK declares, read with build-tools' `aapt2 dump badging`, or null. */
async function readApkPackage(apkPath: string, sdkRoot: string, platform: NodeJS.Platform): Promise<string | null> {
  const aapt = findAapt(sdkRoot, platform);
  if (!aapt) return null;
  return new Promise((resolve) => {
    const child = spawn(aapt, ["dump", "badging", apkPath], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < 64 * 1024) out += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(/package: name='([^']+)'/u.exec(out)?.[1] ?? null);
    });
  });
}

/** Each third-party package's `lastUpdateTime`, from one `dumpsys package` read. */
async function readUpdateTimes(adbPath: string, serial: string, signal: AbortSignal): Promise<Map<string, string>> {
  const result = await runAdb(adbPath, ["shell", "dumpsys package packages | grep -E '^  Package \\[|lastUpdateTime='"], {
    serial,
    timeoutMs: 30_000,
    signal,
    allowFailure: true,
  });
  const times = new Map<string, string>();
  let current: string | null = null;
  for (const line of result.stdout.toString("utf8").split(/\r?\n/u)) {
    const name = /^\s*Package \[([^\]]+)\]/u.exec(line)?.[1];
    if (name) {
      current = name;
      continue;
    }
    const time = /lastUpdateTime=(.+)$/u.exec(line)?.[1];
    if (time && current) times.set(current, time.trim());
  }
  return times;
}

export function createAndroidApps(deps: AndroidAppsDeps) {
  const { platform, signal, logger } = deps;
  // Chrome's first-run screens, out of the way before Chrome opens a page (`androidChromeSetup.ts`).
  const chrome = createAndroidChromeSetup({ signal, logger });

  const laneRootOrRefuse = (laneId: string, what: string): string => {
    const root = deps.laneRoot(laneId);
    if (root) return root;
    throw new AndroidEmulatorFailure(
      "ANDROID_PATH_OUTSIDE_LANE",
      deps.isWorkCopy(laneId)
        ? `This chat's work copy on this machine is gone, so ADE has no folder to take ${what} from.`
        : `ADE cannot find this lane's worktree, so it has no folder to take ${what} from.`,
    );
  };

  const shell = async (laneId: string, words: string[], timeoutMs = 20_000) => {
    const { adbPath, serial } = await deps.requireBooted(laneId);
    return runDeviceShell(adbPath, serial, words, { timeoutMs, signal });
  };

  const isInstalled = async (laneId: string, packageName: string): Promise<boolean> => {
    const result = await shell(laneId, ["pm", "path", packageName]);
    return /^package:/mu.test(result.stdout);
  };

  const resolveLaunchActivity = async (laneId: string, packageName: string): Promise<string | null> => {
    const result = await shell(laneId, [
      "cmd", "package", "resolve-activity", "--brief",
      "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", packageName,
    ]);
    return parseComponents(result.stdout).find((component) => component.startsWith(`${packageName}/`)) ?? null;
  };

  /** Runs `adb install` on one APK; the refusal names adb's reason. */
  const adbInstall = async (laneId: string, apkPath: string): Promise<string[]> => {
    const { adbPath, serial } = await deps.requireBooted(laneId);
    // `-r` replaces an installed copy (keeping its data); `-t` allows a debug
    // build marked test-only.
    const result = await runAdb(adbPath, ["install", "-r", "-t", apkPath], {
      serial,
      timeoutMs: ADB_INSTALL_TIMEOUT_MS,
      signal,
      allowFailure: true,
    });
    const text = `${result.stdout.toString("utf8")}\n${result.stderr}`;
    if (result.exitCode !== 0 || !/\bSuccess\b/u.test(text)) {
      const reason = /Failure \[([^\]]+)\]/u.exec(text)?.[1] ?? tail(text, 3).join(" ");
      throw new AndroidEmulatorFailure("ANDROID_INSTALL_FAILED", `adb could not install ${path.basename(apkPath)}: ${reason || `exit ${result.exitCode}`}.`);
    }
    return tail(text);
  };

  /**
   * Runs the project's Gradle wrapper with the lane's emulator as the only
   * target, and answers with its exit code and output (the last 128-256 KB).
   * It throws when Gradle cannot run, runs too long, or ADE shuts down; a
   * failing build is the caller's to read.
   */
  const runGradleProcess = async (
    laneId: string,
    root: string,
    task: string,
    extraArgs: readonly string[] = [],
  ): Promise<{ exitCode: number | null; output: string; jdk: { home: string; source: string } }> => {
    const wrapperName = platform === "win32" ? "gradlew.bat" : "gradlew";
    const wrapper = path.join(root, wrapperName);
    if (!fs.existsSync(wrapper)) {
      throw new AndroidEmulatorFailure(
        "ANDROID_BUILD_FAILED",
        `No ${wrapperName} at the root of ${root}. ADE runs the project's own Gradle wrapper; build the APK yourself and pass --apk <path>.`,
      );
    }
    const { serial } = await deps.requireBooted(laneId);
    const sdkRoot = await deps.sdkRoot();
    // ADE can start without JAVA_HOME, and a Mac can have only the `java` stub.
    const { jdk, looked } = await locateAndroidJdk({ env: deps.env, platform });
    if (!jdk) throw new AndroidEmulatorFailure("ANDROID_BUILD_FAILED", androidJdkMissingMessage(looked));
    const args = [task, "--console=plain", ...extraArgs];
    // A checkout can lose the execute bit (a zip, a Windows copy); `sh` runs it anyway.
    const posixExecutable = platform !== "win32" && (fs.statSync(wrapper).mode & 0o111) !== 0;
    const invocation = platform === "win32"
      ? resolveCliSpawnInvocation(wrapper, args, deps.env, platform)
      : posixExecutable
        ? { command: wrapper, args, windowsVerbatimArguments: false }
        : { command: "/bin/sh", args: [wrapper, ...args], windowsVerbatimArguments: false };
    const overrides: Record<string, string> = {
      ANDROID_SERIAL: serial,
      // Without these the Android Gradle plugin stops at "SDK location not found".
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
      JAVA_HOME: jdk.home,
    };
    const env: NodeJS.ProcessEnv = { ...deps.env };
    if (platform === "win32") {
      // Windows names have no case: drop `Java_Home` so only ours is passed.
      const names = new Set(Object.keys(overrides).map((name) => name.toLowerCase()));
      for (const key of Object.keys(env)) if (names.has(key.toLowerCase())) delete env[key];
    }
    Object.assign(env, overrides);
    const startedAt = Date.now();
    logger?.info("android.gradle_started", { laneId, task, root, jdk: jdk.home, jdkSource: jdk.source, jdkVersion: jdk.version });
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      });
      let output = "";
      const keep = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        // Only the tail is reported; keep the buffer bounded on a chatty build.
        if (output.length > 256 * 1024) output = output.slice(-128 * 1024);
      };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      let ended = false;
      const stop = (reason: string) => {
        if (ended) return;
        ended = true;
        terminateProcessTree(child);
        reject(new AndroidEmulatorFailure("ANDROID_BUILD_FAILED", `Gradle ${task} ${reason}.\n${tail(output, 15).join("\n")}`));
      };
      const timer = setTimeout(() => stop(`ran longer than ${GRADLE_TIMEOUT_MS / 60_000} minutes and was stopped`), GRADLE_TIMEOUT_MS);
      const onAbort = () => stop("was stopped because ADE is shutting down");
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (ended) return;
        ended = true;
        reject(new AndroidEmulatorFailure("ANDROID_BUILD_FAILED", `Gradle could not start: ${getErrorMessage(error)}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (ended) return;
        ended = true;
        logger?.info("android.gradle_finished", { laneId, task, exitCode: code, durationMs: Date.now() - startedAt });
        resolve({ exitCode: code, output, jdk: { home: jdk.home, source: jdk.source } });
      });
    });
  };

  /** The refusal for a Gradle run that ended with a non-zero exit. */
  const gradleFailure = (task: string, run: { exitCode: number | null; output: string; jdk: { home: string; source: string } }) => {
    const javaMissing = /JAVA_HOME|no java|Unable to locate a Java Runtime/iu.test(run.output);
    return new AndroidEmulatorFailure(
      "ANDROID_BUILD_FAILED",
      `Gradle ${task} failed (exit ${run.exitCode ?? "none"}).${javaMissing ? ` Gradle could not run the JDK at ${run.jdk.home} (${run.jdk.source}): install Android Studio or a JDK 17+, or set JAVA_HOME for ADE.` : ""}\n${tail(run.output, 25).join("\n")}`,
    );
  };

  /** Runs one Gradle task and answers with the tail of its output; a non-zero exit throws. */
  const runGradle = async (laneId: string, root: string, task: string): Promise<string[]> => {
    const run = await runGradleProcess(laneId, root, task);
    if (run.exitCode !== 0) throw gradleFailure(task, run);
    return tail(run.output);
  };

  const install = async (laneId: string, input: { apkPath?: string | null; gradle?: AndroidGradleTarget | null }): Promise<AndroidInstallResult> => {
    const apkArg = input.apkPath?.trim() || null;
    if (apkArg && input.gradle) throw new Error("Pass an APK path or a Gradle build, not both.");
    if (!apkArg && !input.gradle) throw new Error("install needs an APK path (--apk) or a Gradle build (--gradle).");
    const startedAt = Date.now();
    if (apkArg) {
      const root = laneRootOrRefuse(laneId, "an APK");
      const apkPath = containAndroidOutPath(apkArg, root, platform);
      if (!fs.existsSync(apkPath) || !fs.statSync(apkPath).isFile()) {
        throw new AndroidEmulatorFailure("ANDROID_INSTALL_FAILED", `No APK file at ${apkPath}.`);
      }
      const { adbPath, serial } = await deps.requireBooted(laneId);
      const sdkRoot = await deps.sdkRoot();
      const declared = await readApkPackage(apkPath, sdkRoot, platform);
      // Without build-tools' aapt2, the package whose update time changed is the one installed.
      const before = declared ? null : await readUpdateTimes(adbPath, serial, signal);
      const outputTail = await adbInstall(laneId, apkPath);
      let packageName = declared;
      if (!packageName && before) {
        const after = await readUpdateTimes(adbPath, serial, signal);
        packageName = [...after.entries()].find(([name, time]) => before.get(name) !== time)?.[0] ?? null;
      }
      if (packageName) deps.rememberInstalled(laneId, packageName);
      return { laneId, packageName, method: "apk", apkPath, gradleTask: null, durationMs: Date.now() - startedAt, outputTail };
    }
    const { segments, variant } = readAndroidGradleTarget(input.gradle);
    const root = laneRootOrRefuse(laneId, "a Gradle build");
    const task = `:${segments.join(":")}:install${variant.charAt(0).toUpperCase()}${variant.slice(1)}`;
    const outputTail = await runGradle(laneId, root, task);
    const metadata = readGradleOutputMetadata(path.join(root, ...segments), variant);
    if (metadata.applicationId) deps.rememberInstalled(laneId, metadata.applicationId);
    return {
      laneId,
      packageName: metadata.applicationId,
      method: "gradle",
      apkPath: metadata.apkPath,
      gradleTask: task,
      durationMs: Date.now() - startedAt,
      outputTail,
    };
  };

  return {
    install,
    isInstalled,
    resolveLaunchActivity,
    /** P3 instrumentation tests: the same runner, with the exit code and output left to the caller. */
    runGradleProcess,
    gradleFailure,
    laneRootOrRefuse,

    async listApps(laneId: string): Promise<AndroidAppInfo[]> {
      const [packages, launchers] = await Promise.all([
        shell(laneId, ["pm", "list", "packages", "-3"]),
        shell(laneId, [
          "cmd", "package", "query-activities", "--brief",
          "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
        ]),
      ]);
      const components = parseComponents(launchers.stdout);
      const adeInstalled = new Set(deps.laneDevice(laneId)?.adeInstalledPackages ?? []);
      return parsePackageList(packages.stdout)
        // The Android CLI's own helper (`android layout`), not an app of the user's.
        .filter((packageName) => !packageName.startsWith("com.android.cli."))
        .sort((a, b) => a.localeCompare(b))
        .map((packageName) => ({
          packageName,
          launchActivity: components.find((component) => component.startsWith(`${packageName}/`)) ?? null,
          adeInstalled: adeInstalled.has(packageName),
        }));
    },

    /** Starts the app's launcher activity (or the named one) and waits for it to draw (`am start -W`). */
    async start(laneId: string, packageName: string, activity: string | null): Promise<{ activity: string; totalTimeMs: number | null }> {
      let component: string | null;
      if (activity) {
        const trimmed = activity.trim();
        if (!/^[\w.$/]+$/u.test(trimmed)) throw new Error(`activity ${JSON.stringify(trimmed)} is not an activity name.`);
        component = trimmed.includes("/") ? trimmed : `${packageName}/${trimmed}`;
      } else {
        component = await resolveLaunchActivity(laneId, packageName);
      }
      if (!component) {
        const installed = await isInstalled(laneId, packageName);
        throw new AndroidEmulatorFailure(
          "ANDROID_APP_NOT_FOUND",
          installed
            ? `${packageName} has no launcher activity. Pass --activity <name> to start one.`
            : `${packageName} is not installed on this lane's emulator. Install it first (ade android install), or check the name with ade android apps.`,
        );
      }
      await chrome.beforeLaunch(laneId, await deps.requireBooted(laneId), packageName);
      const result = await shell(laneId, ["am", "start", "-W", "-n", component], 60_000);
      if (/Error:|Exception|does not exist/u.test(result.text)) {
        throw new AndroidEmulatorFailure("ANDROID_APP_NOT_FOUND", `The emulator could not start ${component}: ${tail(result.text, 3).join(" ")}`);
      }
      return { activity: component, totalTimeMs: parseTotalTime(result.text) };
    },

    async terminate(laneId: string, packageName: string): Promise<void> {
      await shell(laneId, ["am", "force-stop", packageName]);
    },

    /**
     * Removes a package. On an AVD the lane attached, only one ADE installed
     * there: the user's own apps on their own AVD are not ADE's to remove.
     */
    async uninstall(laneId: string, packageName: string): Promise<boolean> {
      const device = deps.laneDevice(laneId);
      if (device?.origin === "attached" && !device.adeInstalledPackages.includes(packageName)) {
        throw new AndroidEmulatorFailure(
          "ANDROID_PACKAGE_NOT_ADE_INSTALLED",
          `${device.avdName} is an AVD this lane attached, and ADE did not install ${packageName} on it, so ADE leaves it there. Remove it yourself with adb if you mean to.`,
        );
      }
      const booted = await deps.requireBooted(laneId);
      const result = await runAdbOutput(booted, ["uninstall", packageName], { timeoutMs: 60_000, signal });
      const { text } = result;
      const removed = /\bSuccess\b/u.test(text);
      if (removed || /DELETE_FAILED_INTERNAL_ERROR|Unknown package|not installed/iu.test(text)) {
        deps.forgetInstalled(laneId, packageName);
      }
      if (!removed && !/Unknown package|not installed|DELETE_FAILED_INTERNAL_ERROR/iu.test(text)) {
        throw new AndroidEmulatorFailure("ANDROID_INSTALL_FAILED", `adb could not uninstall ${packageName}: ${tail(text, 2).join(" ") || `exit ${result.exitCode}`}.`);
      }
      return removed;
    },

    /** The lane's emulator booted again: Chrome's first-run setup runs once more. */
    forgetBoot: (laneId: string) => chrome.forget(laneId),

    async openUrl(laneId: string, url: string): Promise<void> {
      await chrome.beforeOpenUrl(laneId, await deps.requireBooted(laneId), url);
      const result = await shell(laneId, ["am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", url], 60_000);
      if (/Error:|No Activity found|unable to resolve/iu.test(result.text)) {
        throw new AndroidEmulatorFailure("ANDROID_APP_NOT_FOUND", `No app on the emulator opens ${url}: ${tail(result.text, 2).join(" ")}`);
      }
    },

    /**
     * The lane's release: removes each package ADE installed, while the AVD
     * runs. Best effort; returns what was removed.
     */
    async uninstallAdePackages(laneId: string, packages: readonly string[]): Promise<string[]> {
      const removed: string[] = [];
      let booted: { adbPath: string; serial: string };
      try {
        booted = await deps.requireBooted(laneId);
      } catch {
        return removed;
      }
      for (const packageName of packages) {
        if (!PACKAGE_NAME.test(packageName)) continue;
        try {
          const result = await runAdb(booted.adbPath, ["uninstall", packageName], { serial: booted.serial, timeoutMs: 60_000, signal, allowFailure: true });
          if (/\bSuccess\b/u.test(result.stdout.toString("utf8"))) removed.push(packageName);
        } catch (error) {
          logger?.warn("android.release_uninstall_failed", { laneId, packageName, error: getErrorMessage(error) });
        }
      }
      return removed;
    },
  };
}

