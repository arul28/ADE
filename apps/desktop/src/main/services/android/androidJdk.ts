import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AndroidEnv } from "./androidSdk";

/*
 * The JDK a Gradle build runs on. ADE often starts without JAVA_HOME (a Dock
 * launch, a background brain), and a Mac can have no system JDK at all: then
 * `/usr/bin/java` is a stub that prints "Unable to locate a Java Runtime".
 * So ADE finds a JDK itself and gives Gradle its JAVA_HOME.
 *
 * Order, first match wins (a JDK under 17 counts only when nothing newer is
 * found, except JAVA_HOME, which the user set on purpose):
 * 1. JAVA_HOME, when it holds `bin/java[.exe]`.
 * 2. Android Studio's bundled JDK (`jbr`).
 * 3. macOS: `/usr/libexec/java_home` (only exit 0 counts).
 * 4. Homebrew `openjdk*` (keg-only: not on the PATH).
 * 5. `java` on the PATH (not the macOS stub).
 */

export type AndroidJdkSource = "JAVA_HOME" | "android-studio" | "java_home" | "homebrew" | "path";

export type AndroidJdk = {
  /** The JDK root: the value Gradle gets as JAVA_HOME. */
  home: string;
  source: AndroidJdkSource;
  /** `JAVA_VERSION` from the JDK's `release` file, or null when it has none. */
  version: string | null;
};

export type AndroidJdkLookup = {
  jdk: AndroidJdk | null;
  /** Each place ADE looked, for the error when it found nothing. */
  looked: string[];
};

export type AndroidJdkLocateOptions = {
  env: AndroidEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
};

const MIN_MAJOR = 17;
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: AndroidJdkLookup }>();

/** Reads an env var; on Windows the name has no case (`Path`, `PATH`). */
function readEnv(env: AndroidEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name] || undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value) return value;
  }
  return undefined;
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function readReleaseVersion(home: string, p: path.PlatformPath): string | null {
  try {
    const text = fs.readFileSync(p.join(home, "release"), "utf8");
    return /^JAVA_VERSION="?([^"\r\n]+)"?/mu.exec(text)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** "1.8.0_392" is 8, "21.0.13" is 21; null when unknown. */
export function javaMajorVersion(version: string | null): number | null {
  if (!version) return null;
  const match = /^1\.(\d+)/u.exec(version) ?? /^(\d+)/u.exec(version);
  return match ? Number(match[1]) : null;
}

function runJavaHome(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/usr/libexec/java_home", [], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null);
    });
  });
}

function homebrewJdkHomes(): string[] {
  const out: string[] = [];
  for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    let names: string[];
    try {
      names = fs.readdirSync(prefix).filter((name) => /^openjdk(@\d+)?$/u.test(name));
    } catch {
      continue;
    }
    // `openjdk` (no suffix) is the newest; then the highest `@N`.
    const rank = (name: string) => (name === "openjdk" ? Number.MAX_SAFE_INTEGER : Number(name.split("@")[1]));
    names.sort((a, b) => rank(b) - rank(a));
    for (const name of names) out.push(path.posix.join(prefix, name, "libexec/openjdk.jdk/Contents/Home"));
  }
  return out;
}

async function locateUncached(env: AndroidEnv, platform: NodeJS.Platform, homeDir: string): Promise<AndroidJdkLookup> {
  const p = platform === "win32" ? path.win32 : path.posix;
  const javaName = platform === "win32" ? "java.exe" : "java";
  const looked: string[] = [];
  let fallback: AndroidJdk | null = null;

  /** A JDK at `home`, or null. Records the place either way. */
  const probe = (home: string, source: AndroidJdkSource, label = home): AndroidJdk | null => {
    if (!isFile(p.join(home, "bin", javaName))) {
      looked.push(`${label} (no JDK)`);
      return null;
    }
    const version = readReleaseVersion(home, p);
    const major = javaMajorVersion(version);
    const jdk: AndroidJdk = { home, source, version };
    if (source !== "JAVA_HOME" && major !== null && major < MIN_MAJOR) {
      looked.push(`${label} (JDK ${version}, older than ${MIN_MAJOR})`);
      fallback ??= jdk;
      return null;
    }
    return jdk;
  };

  // 1. JAVA_HOME.
  const javaHome = readEnv(env, "JAVA_HOME", platform)?.trim();
  if (javaHome) {
    const found = probe(javaHome, "JAVA_HOME", `JAVA_HOME=${javaHome}`);
    if (found) return { jdk: found, looked };
  } else {
    looked.push("JAVA_HOME (not set)");
  }

  // 2. Android Studio's bundled JDK.
  const studioHomes: string[] = [];
  if (platform === "darwin") {
    studioHomes.push(
      "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
      p.join(homeDir, "Applications/Android Studio.app/Contents/jbr/Contents/Home"),
    );
  } else if (platform === "win32") {
    const programFiles = readEnv(env, "ProgramFiles", platform) ?? "C:\\Program Files";
    studioHomes.push(p.join(programFiles, "Android", "Android Studio", "jbr"));
    const localAppData = readEnv(env, "LOCALAPPDATA", platform);
    if (localAppData) studioHomes.push(p.join(localAppData, "Programs", "Android Studio", "jbr"));
  } else {
    studioHomes.push("/opt/android-studio/jbr", p.join(homeDir, "android-studio/jbr"), "/snap/android-studio/current/jbr");
  }
  for (const home of studioHomes) {
    const found = probe(home, "android-studio");
    if (found) return { jdk: found, looked };
  }

  if (platform === "darwin") {
    // 3. The macOS registry of installed JDKs.
    const registered = await runJavaHome();
    if (registered) {
      const found = probe(registered, "java_home", `/usr/libexec/java_home → ${registered}`);
      if (found) return { jdk: found, looked };
    } else {
      looked.push("/usr/libexec/java_home (no JDK)");
    }
    // 4. Homebrew's keg-only JDKs.
    const brewHomes = homebrewJdkHomes();
    if (!brewHomes.length) looked.push("Homebrew openjdk (/opt/homebrew/opt, /usr/local/opt: none)");
    for (const home of brewHomes) {
      const found = probe(home, "homebrew");
      if (found) return { jdk: found, looked };
    }
  }

  // 5. `java` on the PATH.
  const pathValue = readEnv(env, "PATH", platform) ?? "";
  let onPath = false;
  for (const dir of pathValue.split(p.delimiter)) {
    if (!dir) continue;
    const candidate = p.join(dir, javaName);
    if (!isFile(candidate)) continue;
    // The macOS stub only says "Unable to locate a Java Runtime".
    if (platform === "darwin" && candidate === "/usr/bin/java") continue;
    onPath = true;
    let real = candidate;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      // Keep the PATH entry.
    }
    const found = probe(p.dirname(p.dirname(real)), "path", `${candidate} on PATH`);
    if (found) return { jdk: found, looked };
  }
  if (!onPath) looked.push(platform === "darwin" ? "java on PATH (only the macOS stub /usr/bin/java)" : "java on PATH (none)");

  return { jdk: fallback, looked };
}

/** Finds a JDK for Gradle. Cached for a minute per environment; cheap after that. */
export async function locateAndroidJdk(options: AndroidJdkLocateOptions): Promise<AndroidJdkLookup> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const key = [platform, homeDir, readEnv(options.env, "JAVA_HOME", platform) ?? "", readEnv(options.env, "PATH", platform) ?? ""].join("\0");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await locateUncached(options.env, platform, homeDir);
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** The refusal when no JDK is found: where ADE looked and how to fix it. */
export function androidJdkMissingMessage(looked: readonly string[]): string {
  return `Gradle needs a JDK and ADE found none. ADE looked at: ${looked.join("; ")}. `
    + `Install Android Studio (it brings a JDK) or a JDK ${MIN_MAJOR}+, or set JAVA_HOME for ADE, then try again. `
    + "To skip the build, build the APK yourself and pass --apk <path>.";
}
