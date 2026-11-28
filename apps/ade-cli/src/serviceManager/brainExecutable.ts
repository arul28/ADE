import fs from "node:fs";
import modeConfig from "./brainExecutableMode.json";

/**
 * Which executable runs the brain on macOS (prototype, default off).
 *
 * Today the brain service, its watchdog and its PTY host run the app's own
 * executable (`ADE.app/Contents/MacOS/ADE`) with `ELECTRON_RUN_AS_NODE=1`.
 * They keep running after the app quits, which is a feature, but anything that
 * counts the app's executable after a quit sees "the app is still running".
 *
 * Modes:
 * - `off`: the app's executable, as today.
 * - `helper`: the app's signed Electron helper
 *   (`Contents/Frameworks/ADE Helper.app/Contents/MacOS/ADE Helper`). Its
 *   bundle id is `<app id>.helper`, so macOS privacy grants (TCC) made to the
 *   app do not cover it.
 * - `brain-copy`: a copy of the app's executable in the same folder
 *   (`Contents/MacOS/DAEX Brain`), which the packaging step creates and signs
 *   with the app's own identifier and team (`scripts/mac-brain-copy.cjs`).
 *   macOS names the background item after it ("Background Items Added",
 *   Login Items). Builds before the rename called it `ADE Brain`; the bundle
 *   keeps a copy under that name too, so a launch agent written by an older
 *   build still starts until the next install rewrites it to the new name.
 *
 * The switch is `brainExecutableMode.json`, read here and by the packaging
 * step, so the app, the `ade` CLI, the brain and the build always agree.
 * `ADE_BRAIN_EXECUTABLE=off|helper|brain-copy` overrides it for one process
 * tree, for a quick test. Any mode falls back to the app's executable when
 * its file is missing (a `brain-copy` mode on a build without the copy).
 */
export type BrainExecutableMode = "off" | "helper" | "brain-copy";

function normalizeMode(value: unknown): BrainExecutableMode | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "off" || text === "helper" || text === "brain-copy" ? text : null;
}

export const BRAIN_EXECUTABLE_MODE: BrainExecutableMode = normalizeMode(modeConfig.mode) ?? "off";

export const BRAIN_EXECUTABLE_ENV = "ADE_BRAIN_EXECUTABLE";

/** The suffix of the brain copy's file name. Keep in step with `scripts/mac-brain-copy.cjs`. */
export const BRAIN_COPY_SUFFIX = " Brain";

// The brain copy shows the product name, while the app's executable keeps the
// frozen one: `ADE` -> `DAEX Brain`, `ADE Alpha` -> `DAEX Alpha Brain`. Builds
// before the rename named it `<executable> Brain` (`ADE Brain`). File names,
// not display text: they must not follow BRAND if it changes again.
const FROZEN_EXECUTABLE_PREFIX = "ADE";
const BRAIN_COPY_PREFIX = "DAEX";

function swapPrefix(name: string, from: string, to: string): string | null {
  return name === from || name.startsWith(`${from} `) ? `${to}${name.slice(from.length)}` : null;
}

/** `ADE` -> `DAEX Brain`; any other executable (a dev `Electron`) -> `<name> Brain`. */
function brainCopyFileName(executableName: string): string {
  return `${swapPrefix(executableName, FROZEN_EXECUTABLE_PREFIX, BRAIN_COPY_PREFIX) ?? executableName}${BRAIN_COPY_SUFFIX}`;
}

/** The name older builds gave the copy (`ADE Brain`). */
function legacyBrainCopyFileName(executableName: string): string {
  return `${executableName}${BRAIN_COPY_SUFFIX}`;
}

/** The app's executable for a brain copy's file name (either name), or null when it is not one. */
function executableNameForBrainCopy(fileName: string): string | null {
  if (!fileName.endsWith(BRAIN_COPY_SUFFIX) || fileName.length <= BRAIN_COPY_SUFFIX.length) return null;
  const base = fileName.slice(0, -BRAIN_COPY_SUFFIX.length);
  return swapPrefix(base, BRAIN_COPY_PREFIX, FROZEN_EXECUTABLE_PREFIX) ?? base;
}

export function resolveBrainExecutableMode(env: NodeJS.ProcessEnv = process.env): BrainExecutableMode {
  return normalizeMode(env[BRAIN_EXECUTABLE_ENV]) ?? BRAIN_EXECUTABLE_MODE;
}

/** The executables of one Electron app bundle on macOS. */
export type ElectronMacExecutables = {
  /** `<bundle>.app/Contents/MacOS/<name>`: the app (`CFBundleExecutable`). */
  main: string;
  /** `<bundle>.app/Contents/Frameworks/<name> Helper.app/Contents/MacOS/<name> Helper`. */
  helper: string;
  /** `<bundle>.app/Contents/MacOS/DAEX Brain` (`brainCopyFileName`). */
  brainCopy: string;
  /** `<bundle>.app/Contents/MacOS/ADE Brain`: the copy's name before the rename. */
  legacyBrainCopy: string;
};

const HELPER_EXECUTABLE = /^(\/.+?\.app)\/Contents\/Frameworks\/([^/]+) Helper\.app\/Contents\/MacOS\/\2 Helper$/;
const MAIN_EXECUTABLE = /^(\/.+?\.app)\/Contents\/MacOS\/([^/]+)$/;

function executablesFor(bundle: string, name: string): ElectronMacExecutables {
  return {
    main: `${bundle}/Contents/MacOS/${name}`,
    helper: `${bundle}/Contents/Frameworks/${name} Helper.app/Contents/MacOS/${name} Helper`,
    brainCopy: `${bundle}/Contents/MacOS/${brainCopyFileName(name)}`,
    legacyBrainCopy: `${bundle}/Contents/MacOS/${legacyBrainCopyFileName(name)}`,
  };
}

/**
 * The app, helper and brain-copy executables for a path that is any of them,
 * or null. The names follow electron-builder (`ADE` / `ADE Helper`,
 * `ADE Alpha` / `ADE Alpha Helper`), the brain copy (`DAEX Brain`,
 * `DAEX Alpha Brain`, and the older `ADE Brain`, `ADE Alpha Brain`) and a
 * development Electron (`Electron` / `Electron Helper`). The GPU, Renderer and
 * Plugin helpers are not the plain helper: their paths give executables that
 * do not exist, and callers check for that.
 */
export function electronMacExecutables(execPath: string): ElectronMacExecutables | null {
  const helper = HELPER_EXECUTABLE.exec(execPath);
  if (helper) return executablesFor(helper[1]!, helper[2]!);
  const main = MAIN_EXECUTABLE.exec(execPath);
  if (!main) return null;
  const [, bundle, fileName] = main;
  return executablesFor(bundle!, executableNameForBrainCopy(fileName!) ?? fileName!);
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * The executable a brain service, its watchdog and its PTY host run as Node.
 *
 * Anything but macOS, and any executable outside an app bundle (node, the
 * standalone `ade` runtime), is returned as it is. Otherwise the mode's
 * executable when it exists, else the app's own. A caller that already runs
 * on the helper or the copy (either name) gets the same answer as the app, so
 * every process agrees on one command and the installed plist does not flip
 * between them. A plist an older build wrote with `ADE Brain` differs from
 * this command, so the next install rewrites it to `DAEX Brain`.
 */
export function resolveBrainNodeExecutable(
  execPath: string = process.execPath,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    exists?: (filePath: string) => boolean;
  } = {},
): string {
  if ((options.platform ?? process.platform) !== "darwin") return execPath;
  const executables = electronMacExecutables(execPath);
  if (!executables) return execPath;
  const exists = options.exists ?? isExecutableFile;
  const mode = resolveBrainExecutableMode(options.env ?? process.env);
  const wanted = mode === "helper"
    ? executables.helper
    : mode === "brain-copy"
      ? executables.brainCopy
      : executables.main;
  if (wanted === execPath || exists(wanted)) return wanted;
  // A bundle from before the rename has only the old copy.
  if (mode === "brain-copy" && exists(executables.legacyBrainCopy)) return executables.legacyBrainCopy;
  return exists(executables.main) ? executables.main : execPath;
}

/**
 * The executable to name explicitly for a Node child (the PTY host) when the
 * switch moves background processes off the app's executable, else null, so
 * the caller keeps its default.
 */
export function brainNodeExecutableOverride(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (resolveBrainExecutableMode(env) === "off") return null;
  const executable = resolveBrainNodeExecutable(execPath, { env });
  return executable === electronMacExecutables(executable)?.main ? null : executable;
}

/**
 * Whether two executables run the same Node: the same path, or the app and
 * its helper or brain copy. A service command on either still runs the
 * caller's CLI script, so its build is the script's, not the executable's.
 */
export function isSameElectronRuntime(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (left === right) return true;
  if (platform !== "darwin") return false;
  const a = electronMacExecutables(left);
  const b = electronMacExecutables(right);
  return a !== null && b !== null && a.main === b.main;
}

/**
 * The `.app` bundle an executable belongs to: the app's own bundle for its
 * helper and brain copy too, never the nested `ADE Helper.app`.
 */
export function electronMacAppBundlePath(execPath: string): string | null {
  const executables = electronMacExecutables(execPath);
  if (!executables) return null;
  return MAIN_EXECUTABLE.exec(executables.main)?.[1] ?? null;
}
