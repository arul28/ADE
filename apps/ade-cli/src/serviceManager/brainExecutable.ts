import fs from "node:fs";

/**
 * Which executable runs the brain on macOS (prototype, default off).
 *
 * Today the brain service, its watchdog and its PTY host run the app's own
 * executable (`ADE.app/Contents/MacOS/ADE`) with `ELECTRON_RUN_AS_NODE=1`.
 * They keep running after the app quits, which is a feature, but anything that
 * counts the app's executable after a quit sees "the app is still running".
 *
 * With the switch on, they run the app's signed Electron helper instead
 * (`ADE.app/Contents/Frameworks/ADE Helper.app/Contents/MacOS/ADE Helper`),
 * also as Node. The helper loads the same Electron Framework, so the Node
 * version, the fuses and the native modules are the same. Its code-signing
 * identity is not: its bundle id is `<app id>.helper`, so macOS privacy
 * grants (TCC) made to the app do not cover a brain that launchd starts.
 *
 * The switch is one constant. `ADE_BRAIN_HELPER_EXECUTABLE=1` (or `0`)
 * overrides it for one process tree, for a quick test; a build that keeps the
 * change flips the constant, so the app, the `ade` CLI and the brain always
 * agree on the service command.
 */
export const BRAIN_RUNS_IN_ELECTRON_HELPER = false;

export const BRAIN_HELPER_EXECUTABLE_ENV = "ADE_BRAIN_HELPER_EXECUTABLE";

export function isBrainHelperExecutableEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[BRAIN_HELPER_EXECUTABLE_ENV]?.trim();
  if (value === "1") return true;
  if (value === "0") return false;
  return BRAIN_RUNS_IN_ELECTRON_HELPER;
}

/** The two executables of one Electron app bundle on macOS. */
export type ElectronMacExecutables = {
  /** `<bundle>.app/Contents/MacOS/<name>`: the app (`CFBundleExecutable`). */
  main: string;
  /** `<bundle>.app/Contents/Frameworks/<name> Helper.app/Contents/MacOS/<name> Helper`. */
  helper: string;
};

const HELPER_EXECUTABLE = /^(\/.+?\.app)\/Contents\/Frameworks\/([^/]+) Helper\.app\/Contents\/MacOS\/\2 Helper$/;
const MAIN_EXECUTABLE = /^(\/.+?\.app)\/Contents\/MacOS\/([^/]+)$/;

/**
 * The app and helper executables for a path that is either one, or null.
 * The names follow electron-builder (`ADE` / `ADE Helper`, `ADE Alpha` /
 * `ADE Alpha Helper`) and a development Electron (`Electron` / `Electron
 * Helper`). The GPU, Renderer and Plugin helpers are not the plain helper:
 * their paths give a helper that does not exist, and callers check for that.
 */
export function electronMacExecutables(execPath: string): ElectronMacExecutables | null {
  const helper = HELPER_EXECUTABLE.exec(execPath);
  if (helper) {
    return { main: `${helper[1]}/Contents/MacOS/${helper[2]}`, helper: execPath };
  }
  const main = MAIN_EXECUTABLE.exec(execPath);
  if (!main) return null;
  const [, bundle, name] = main;
  return { main: execPath, helper: `${bundle}/Contents/Frameworks/${name} Helper.app/Contents/MacOS/${name} Helper` };
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
 * standalone `ade` runtime), is returned as it is. With the switch on, the
 * app's helper, when it exists. With the switch off, the app itself, also
 * when the caller already runs in the helper: a brain that a switched build
 * started then installs the service back on the app, and every process
 * agrees on one command, so the installed plist does not flip between them.
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
  const pair = electronMacExecutables(execPath);
  if (!pair) return execPath;
  const exists = options.exists ?? isExecutableFile;
  if (isBrainHelperExecutableEnabled(options.env ?? process.env)) {
    return exists(pair.helper) ? pair.helper : execPath;
  }
  return execPath === pair.helper && exists(pair.main) ? pair.main : execPath;
}

/**
 * Whether two executables run the same Node: the same path, or the app and
 * its helper. A service command on the helper still runs the caller's CLI
 * script, so its build is the script's, not the executable's.
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
 * helper too, never the nested `ADE Helper.app`.
 */
export function electronMacAppBundlePath(execPath: string): string | null {
  const pair = electronMacExecutables(execPath);
  if (!pair) return null;
  return MAIN_EXECUTABLE.exec(pair.main)?.[1] ?? null;
}
