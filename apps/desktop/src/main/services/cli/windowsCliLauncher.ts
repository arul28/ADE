/**
 * The native `ade.exe` ADE_CLI_PATH names on Windows.
 *
 * `ade.cmd` runs through cmd.exe, which ends a command at its first line feed:
 * a multi-line `--prompt` or `--text` reached the CLI as its first line, and
 * every argument after it was lost (ledger #46, W2). A packaged ADE runs its
 * CLI as `ADE.exe <resources>\ade-cli\cli.cjs` with ELECTRON_RUN_AS_NODE=1,
 * which one path cannot express, so ADE ships a tiny launcher
 * (`resources/native/ade-cli-launcher.exe`, native/ADECliLauncherWin). It is
 * copied into a directory of its own as `ade.exe`, beside an `ade.launch`
 * file that says what to run; the launcher passes the rest of its command line
 * on verbatim. `ade.cmd` stays on PATH for people typing `ade` in cmd or
 * PowerShell; only ADE_CLI_PATH changes.
 *
 * Everything here is a no-op off Windows, and every failure names its reason
 * so the caller keeps `ade.cmd` and says why: a missing launcher costs
 * multi-line arguments, never the CLI.
 */
import fs from "node:fs";
import path from "node:path";

export const WINDOWS_CLI_LAUNCHER_BINARY = "ade-cli-launcher.exe";
/** The env var `ade.cmd` sets so the CLI can warn about cmd.exe's line cut. */
export const ADE_CLI_VIA_CMD_ENV = "ADE_CLI_VIA_CMD";

/**
 * The Node compile cache `ade.cmd` turns on: without it every agent `ade`
 * call re-parses the ~20 MB cli.cjs. The caller's own NODE_COMPILE_CACHE or
 * NODE_DISABLE_COMPILE_CACHE wins, as in the wrapper.
 */
export function windowsCliCompileCacheDefault(adeHome: string): { guards: string[]; name: string; value: string } {
  return {
    guards: ["NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE"],
    name: "NODE_COMPILE_CACHE",
    value: path.win32.join(adeHome, "cache", "node-compile"),
  };
}

export type WindowsCliLaunchSpec = {
  /** The program to run: ADE.exe (Electron), node.exe, or a native ade.exe. */
  exe: string;
  /** Leading arguments, e.g. the cli.cjs entry. */
  args?: readonly string[];
  /** Always set. */
  env?: ReadonlyArray<readonly [string, string]>;
  /** Set only when the caller's env names no brain (no ADE_HOME, no ADE_RUNTIME_SOCKET_PATH). */
  brainDefaults?: ReadonlyArray<readonly [string, string]>;
  /** `value;<existing>`. */
  prepend?: ReadonlyArray<readonly [string, string]>;
  /** Removed before the child starts. */
  unset?: readonly string[];
  /** Set only when none of `guards` is set (the Node compile cache, as `ade.cmd` sets it). */
  ifNone?: ReadonlyArray<{ guards: readonly string[]; name: string; value: string }>;
  /**
   * Run the Node that ADE_CLI_NODE names instead of the bundled runtime.
   * The same rule as ade-cli-windows-wrapper.cmd.
   */
  ttyNode?: boolean;
};

/**
 * The launch spec for a CLI the Electron app runs as Node: `ADE.exe <cli.cjs>`
 * with ELECTRON_RUN_AS_NODE, the app's module dirs on NODE_PATH, and the
 * brain defaults, as `ade.cmd` runs it. Also what `ade.cmd` did besides: a
 * warm compile cache for every call, and the Node ADE_CLI_NODE names when set.
 */
export function electronCliLaunchSpec(input: {
  /** The app's `ADE.exe`. */
  execPath: string;
  /** The CLI entry, `<resources>\ade-cli\cli.cjs`. */
  entryPath: string;
  /** Put in front of the caller's NODE_PATH. */
  nodeModulePaths: readonly string[];
  /** Set only when the caller's env names no brain. */
  brainDefaults: ReadonlyArray<readonly [string, string]>;
  /** The ADE home whose compile cache the CLI warms. */
  adeHome: string;
}): WindowsCliLaunchSpec {
  return {
    exe: input.execPath,
    args: [input.entryPath],
    env: [["ELECTRON_RUN_AS_NODE", "1"]],
    brainDefaults: input.brainDefaults,
    prepend: input.nodeModulePaths.length ? [["NODE_PATH", input.nodeModulePaths.join(";")]] : [],
    unset: [ADE_CLI_VIA_CMD_ENV],
    ifNone: [windowsCliCompileCacheDefault(input.adeHome)],
    ttyNode: true,
  };
}

/** A value one `ade.launch` line can carry: no line break or NUL. */
function launchSafe(value: string): boolean {
  return !/[\r\n\0]/.test(value);
}

/**
 * The `ade.launch` text for `spec` (format in native/ADECliLauncherWin/src/main.cpp).
 * Null when a path or value cannot be written on one line.
 */
export function renderWindowsCliLaunchFile(spec: WindowsCliLaunchSpec): string | null {
  const lines = ["ade-launch 1"];
  const values: string[] = [spec.exe, ...(spec.args ?? [])];
  if (!spec.exe.trim() || values.some((value) => !launchSafe(value))) return null;
  lines.push(`exe ${spec.exe}`);
  for (const arg of spec.args ?? []) lines.push(`arg ${arg}`);
  const assignments: Array<[string, ReadonlyArray<readonly [string, string]> | undefined]> = [
    ["env", spec.env],
    ["default", spec.brainDefaults],
    ["prepend", spec.prepend],
  ];
  for (const [directive, entries] of assignments) {
    for (const [name, value] of entries ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !launchSafe(value)) continue;
      lines.push(`${directive} ${name}=${value}`);
    }
  }
  for (const name of spec.unset ?? []) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) lines.push(`unset ${name}`);
  }
  const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const entry of spec.ifNone ?? []) {
    if (!envName.test(entry.name) || !launchSafe(entry.value) || entry.guards.some((guard) => !envName.test(guard))) continue;
    lines.push(`ifnone ${entry.guards.join(",")} ${entry.name}=${entry.value}`);
  }
  if (spec.ttyNode) lines.push("ttynode 1");
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Where the shipped launcher is, for a CLI entry or an Electron resources
 * directory: `<resources>/native/ade-cli-launcher.exe`, packaged or in a dev
 * checkout (`apps/desktop/resources/native`). Null when none exists.
 */
export function resolveWindowsCliLauncherSource(input: {
  resourcesPath?: string | null;
  cliEntry?: string | null;
  exists?: (candidate: string) => boolean;
}): string | null {
  const exists = input.exists ?? ((candidate: string) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  const win = path.win32;
  const candidates: string[] = [];
  if (input.resourcesPath?.trim()) candidates.push(win.join(input.resourcesPath.trim(), "native", WINDOWS_CLI_LAUNCHER_BINARY));
  if (input.cliEntry?.trim()) {
    const entryDir = win.dirname(input.cliEntry.trim());
    // Packaged: <resources>/ade-cli/cli.cjs. Dev: <repo>/apps/ade-cli/dist/cli.cjs or src/cli.ts.
    candidates.push(win.join(entryDir, "..", "native", WINDOWS_CLI_LAUNCHER_BINARY));
    candidates.push(win.join(entryDir, "..", "..", "desktop", "resources", "native", WINDOWS_CLI_LAUNCHER_BINARY));
  }
  return candidates.map((candidate) => win.normalize(candidate)).find(exists) ?? null;
}

function sameFileContents(a: string, b: string): boolean {
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    if (left.size !== right.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

export type WindowsCliLauncherInstall =
  | { exePath: string; reason: null }
  | { exePath: null; reason: string };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Put the launcher in `dir` as `ade.exe` with its `ade.launch`, and return the
 * `ade.exe` path, or why it could not (the caller keeps `ade.cmd`).
 *
 * The exe is copied only when its bytes differ: a running copy is locked on
 * Windows, and an agent mid-command must not break the next brain start. When
 * the copy cannot be replaced, the one already there is kept, since the
 * `ade.launch` format is versioned and read on every run.
 */
export function installWindowsCliLauncher(input: {
  /** `resolveWindowsCliLauncherSource`'s answer; null when the app ships none. */
  launcherSource: string | null;
  dir: string;
  spec: WindowsCliLaunchSpec;
}): WindowsCliLauncherInstall {
  if (!input.launcherSource) {
    return { exePath: null, reason: `${WINDOWS_CLI_LAUNCHER_BINARY} is not in this build's resources\\native` };
  }
  const body = renderWindowsCliLaunchFile(input.spec);
  if (!body) return { exePath: null, reason: "a path in the CLI command holds a line break, which ade.launch cannot carry" };
  const exePath = path.join(input.dir, "ade.exe");
  const launchPath = path.join(input.dir, "ade.launch");
  try {
    fs.mkdirSync(input.dir, { recursive: true });
    if (!sameFileContents(input.launcherSource, exePath)) {
      const temporary = `${exePath}.${process.pid}.tmp`;
      try {
        fs.copyFileSync(input.launcherSource, temporary);
        fs.renameSync(temporary, exePath);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        if (!fs.existsSync(exePath)) return { exePath: null, reason: `copying the launcher to ${exePath} failed: ${errorText(error)}` };
      }
    }
    let current: string | null = null;
    try {
      current = fs.readFileSync(launchPath, "utf8");
    } catch {
      current = null;
    }
    if (current !== body) {
      const temporary = `${launchPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, body, "utf8");
      fs.renameSync(temporary, launchPath);
    }
    return { exePath, reason: null };
  } catch (error) {
    return { exePath: null, reason: `writing the launcher in ${input.dir} failed: ${errorText(error)}` };
  }
}

/** True when the CLI was started through `ade.cmd` (the marker env), consumed once. */
export function consumeCliViaCmdMarker(env: NodeJS.ProcessEnv = process.env): boolean {
  const via = env[ADE_CLI_VIA_CMD_ENV] === "1";
  // Never inherited: a brain started through ade.cmd must not hand the marker
  // to every agent it starts.
  delete env[ADE_CLI_VIA_CMD_ENV];
  return via;
}
