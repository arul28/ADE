import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AndroidEnv } from "./androidSdk";

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
const VERSION_TTL_MS = 10 * 60_000;

/**
 * `android --no-metrics --version`, cached per binary (path + mtime + size).
 * The first run of a fresh CLI unpacks its bundle (about 150 MB, some
 * seconds), so the timeout is generous.
 */
export async function readAndroidCliVersion(binary: string): Promise<string | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(binary);
  } catch {
    return null;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = versionCache.get(binary);
  if (cached && cached.key === key && Date.now() - cached.at < VERSION_TTL_MS) return cached.value;
  const value = await new Promise<string | null>((resolve) => {
    execFile(binary, androidCliArgs(null, ["--version"]), { timeout: 120_000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const line = stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean).pop() ?? "";
      resolve(/^\d+(\.\d+){1,3}$/u.test(line) ? line : null);
    });
  });
  versionCache.set(binary, { key, at: Date.now(), value });
  return value;
}

/**
 * The CLI ADE installed into the SDK first, then one on PATH that answers
 * `--version` like the new CLI. Null when neither is there.
 */
export async function locateAndroidCli(options: {
  sdkRoot: string | null;
  env?: AndroidEnv;
  platform?: NodeJS.Platform;
}): Promise<AndroidCliLocation | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (options.sdkRoot) {
    const own = androidCliInstallPath(options.sdkRoot, platform);
    if (isExecutableFile(own)) return { path: own, source: "ade", version: await readAndroidCliVersion(own) };
  }
  for (const candidate of pathCandidates(env, platform)) {
    if (!isExecutableFile(candidate)) continue;
    // The old SDK `tools/android` lives in `<sdk>/tools`; skip it without running it.
    if (path.basename(path.dirname(candidate)) === "tools") continue;
    const version = await readAndroidCliVersion(candidate);
    if (version) return { path: candidate, source: "path", version };
  }
  return null;
}
