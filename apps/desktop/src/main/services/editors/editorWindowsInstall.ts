import { execFile } from "node:child_process";
import fs from "node:fs";

import type { EditorTarget } from "../../../shared/editorTargets";
import {
  resolveTrustedWindowsTool,
  TrustedWindowsToolError,
} from "../../../../../ade-cli/src/lib/trustedWindowsTools";

/**
 * Windows editors do not all put a shim on PATH. The system VS Code installer
 * registers `Code.exe` under `%ProgramFiles%`, the user installer under
 * `%LOCALAPPDATA%\Programs`, and JetBrains Toolbox installs under
 * `%LOCALAPPDATA%\JetBrains\Toolbox\apps\<Product>\ch-*\`. `where.exe` only
 * sees PATH, so discovery has to look at those locations and at the uninstall
 * registry keys too — otherwise "Open in <editor>" silently disappears for a
 * perfectly normal Windows install.
 *
 * This module is read-only: it lists directories, checks file existence, and
 * runs `reg query` against uninstall keys no user can write without elevation.
 * It never launches a GUI and never asks for permission. Every path is verified
 * to exist before it is returned, so a wrong guess yields "not installed", not
 * a false positive.
 */

export type WindowsRegistryApp = {
  displayName: string;
  installLocation?: string;
  displayIcon?: string;
};

type WindowsEditorSpec = {
  /** Case-insensitive substrings matched against the uninstall `DisplayName`. */
  displayNames: readonly string[];
  /** Folder names looked for directly under the install base directories. */
  dirNames: readonly string[];
  /** Executable file names, checked at the folder root and under `bin\`. */
  exeNames: readonly string[];
  /** JetBrains Toolbox product folder names containing `ch-<build>` releases. */
  toolboxProducts?: readonly string[];
  /** Folder-name prefixes under `<ProgramFiles>\JetBrains` (system JetBrains installs). */
  jetbrainsDirPrefixes?: readonly string[];
};

const WINDOWS_EDITOR_SPECS: Partial<Record<EditorTarget, WindowsEditorSpec>> = {
  vscode: {
    displayNames: ["Visual Studio Code"],
    dirNames: ["Microsoft VS Code", "Visual Studio Code"],
    exeNames: ["Code.exe"],
  },
  "vscode-insiders": {
    displayNames: ["Visual Studio Code - Insiders"],
    dirNames: ["Microsoft VS Code Insiders", "Visual Studio Code - Insiders"],
    exeNames: ["Code - Insiders.exe"],
  },
  vscodium: {
    displayNames: ["VSCodium"],
    dirNames: ["VSCodium"],
    exeNames: ["VSCodium.exe"],
  },
  cursor: {
    displayNames: ["Cursor"],
    dirNames: ["Cursor"],
    exeNames: ["Cursor.exe"],
  },
  zed: {
    displayNames: ["Zed"],
    dirNames: ["Zed"],
    exeNames: ["zed.exe", "Zed.exe"],
  },
  zeditor: {
    displayNames: ["Zed"],
    dirNames: ["Zed"],
    exeNames: ["zed.exe", "Zed.exe"],
  },
  windsurf: {
    displayNames: ["Windsurf"],
    dirNames: ["Windsurf"],
    exeNames: ["Windsurf.exe"],
  },
  trae: {
    displayNames: ["Trae"],
    dirNames: ["Trae"],
    exeNames: ["Trae.exe"],
  },
  kiro: {
    displayNames: ["Kiro"],
    dirNames: ["Kiro"],
    exeNames: ["Kiro.exe"],
  },
  antigravity: {
    displayNames: ["Antigravity"],
    dirNames: ["Antigravity"],
    exeNames: ["Antigravity.exe"],
  },
  "sublime-text": {
    displayNames: ["Sublime Text"],
    dirNames: ["Sublime Text", "Sublime Text 3", "Sublime Text 4"],
    exeNames: ["sublime_text.exe"],
  },
  fleet: {
    displayNames: ["JetBrains Fleet", "Fleet"],
    dirNames: [],
    exeNames: ["fleet64.exe", "fleet.exe"],
    toolboxProducts: ["Fleet"],
  },
  "intellij-idea": {
    displayNames: ["IntelliJ IDEA"],
    dirNames: [],
    exeNames: ["idea64.exe", "idea.exe"],
    toolboxProducts: ["IntelliJIdea"],
    jetbrainsDirPrefixes: ["IntelliJ IDEA"],
  },
  webstorm: {
    displayNames: ["WebStorm"],
    dirNames: [],
    exeNames: ["webstorm64.exe", "webstorm.exe"],
    toolboxProducts: ["WebStorm"],
    jetbrainsDirPrefixes: ["WebStorm"],
  },
  "android-studio": {
    displayNames: ["Android Studio"],
    dirNames: ["Android Studio"],
    exeNames: ["studio64.exe", "studio.exe"],
    jetbrainsDirPrefixes: ["Android Studio"],
  },
};

export function windowsEditorSpec(target: EditorTarget): WindowsEditorSpec | null {
  return WINDOWS_EDITOR_SPECS[target] ?? null;
}

export type WindowsEditorInstallIo = {
  env: NodeJS.ProcessEnv;
  pathExists: (target: string) => boolean;
  listDir: (dir: string) => readonly string[];
  registryApps: readonly WindowsRegistryApp[];
};

function winJoin(...parts: string[]): string {
  return parts.join("\\");
}

function firstExisting(candidates: readonly (string | null)[], io: WindowsEditorInstallIo): string | null {
  for (const candidate of candidates) {
    if (candidate && io.pathExists(candidate)) return candidate;
  }
  return null;
}

function findExecutableInDir(
  dir: string,
  spec: WindowsEditorSpec,
  io: WindowsEditorInstallIo,
): string | null {
  const candidates: Array<string | null> = [];
  for (const exeName of spec.exeNames) {
    candidates.push(winJoin(dir, exeName));
    candidates.push(winJoin(dir, "bin", exeName));
  }
  return firstExisting(candidates, io);
}

function listDirSafe(dir: string, io: WindowsEditorInstallIo): readonly string[] {
  try {
    return io.listDir(dir);
  } catch {
    return [];
  }
}

function findMatchingChild(
  dir: string,
  names: readonly string[],
  io: WindowsEditorInstallIo,
): string | null {
  const entries = listDirSafe(dir, io);
  for (const name of names) {
    const wanted = name.toLowerCase();
    const match = entries.find((entry) => entry.toLowerCase() === wanted);
    if (match) return winJoin(dir, match);
  }
  return null;
}

function findViaProgramDirs(
  spec: WindowsEditorSpec,
  io: WindowsEditorInstallIo,
): string | null {
  if (spec.dirNames.length === 0) return null;
  const bases = [
    io.env.ProgramFiles?.trim(),
    io.env["ProgramFiles(x86)"]?.trim(),
    io.env.LOCALAPPDATA?.trim() ? winJoin(io.env.LOCALAPPDATA.trim(), "Programs") : undefined,
  ].filter((base): base is string => Boolean(base));
  for (const base of bases) {
    const dir = findMatchingChild(base, spec.dirNames, io);
    if (!dir) continue;
    const exe = findExecutableInDir(dir, spec, io);
    if (exe) return exe;
  }
  return null;
}

function findViaJetBrainsDirs(
  spec: WindowsEditorSpec,
  io: WindowsEditorInstallIo,
): string | null {
  if (!spec.jetbrainsDirPrefixes?.length) return null;
  const bases = [
    io.env.ProgramFiles?.trim(),
    io.env["ProgramFiles(x86)"]?.trim(),
  ].filter((base): base is string => Boolean(base));
  for (const base of bases) {
    const jetbrainsDir = winJoin(base, "JetBrains");
    const entries = listDirSafe(jetbrainsDir, io);
    for (const prefix of spec.jetbrainsDirPrefixes) {
      const wanted = prefix.toLowerCase();
      const match = entries.find((entry) => entry.toLowerCase().startsWith(wanted));
      if (!match) continue;
      const exe = findExecutableInDir(winJoin(jetbrainsDir, match), spec, io);
      if (exe) return exe;
    }
  }
  return null;
}

function findViaJetBrainsToolbox(
  spec: WindowsEditorSpec,
  io: WindowsEditorInstallIo,
): string | null {
  if (!spec.toolboxProducts?.length) return null;
  const localAppData = io.env.LOCALAPPDATA?.trim();
  if (!localAppData) return null;
  const appsDir = winJoin(localAppData, "JetBrains", "Toolbox", "apps");
  for (const product of spec.toolboxProducts) {
    const productDir = winJoin(appsDir, product);
    const entries = listDirSafe(productDir, io);
    const build = entries.find((entry) => /^ch-/i.test(entry));
    if (!build) continue;
    const exe = findExecutableInDir(winJoin(productDir, build), spec, io);
    if (exe) return exe;
  }
  return null;
}

function stripDisplayIcon(displayIcon: string): string {
  let value = displayIcon.trim();
  if (value.startsWith('"')) {
    const closing = value.indexOf('"', 1);
    value = closing > 0 ? value.slice(1, closing) : value.slice(1);
  } else {
    value = value.replace(/,\s*\d+\s*$/, "");
  }
  return value.trim();
}

function findViaRegistry(
  spec: WindowsEditorSpec,
  io: WindowsEditorInstallIo,
): string | null {
  const app = findRegistryAppForSpec(spec, io.registryApps);
  if (!app) return null;
  if (app.displayIcon) {
    const icon = stripDisplayIcon(app.displayIcon);
    if (icon && io.pathExists(icon)) return icon;
  }
  if (app.installLocation) {
    const exe = findExecutableInDir(app.installLocation.trim(), spec, io);
    if (exe) return exe;
  }
  return null;
}

/**
 * Pick the uninstall entry that belongs to `spec`.
 *
 * An exact `DisplayName` wins. A `contains` fallback then ignores an entry that
 * a *more specific* spec names more fully — otherwise matching `"Visual Studio
 * Code"` inside `"Visual Studio Code - Insiders"` would report a phantom
 * `vscode` on an Insiders-only machine.
 */
export function findRegistryAppForSpec(
  spec: WindowsEditorSpec,
  apps: readonly WindowsRegistryApp[],
): WindowsRegistryApp | null {
  const ownNames = spec.displayNames.map((name) => name.toLowerCase());
  const allNames = Object.values(WINDOWS_EDITOR_SPECS)
    .flatMap((entry) => entry.displayNames.map((name) => name.toLowerCase()));
  let containsMatch: { app: WindowsRegistryApp; name: string } | null = null;
  for (const app of apps) {
    const displayName = app.displayName.toLowerCase();
    if (ownNames.includes(displayName)) return app;
    const matched = ownNames
      .filter((name) => displayName.includes(name))
      .sort((a, b) => b.length - a.length)[0];
    if (!matched) continue;
    const claimedByMoreSpecific = allNames.some(
      (name) => name.length > matched.length && displayName.includes(name),
    );
    if (claimedByMoreSpecific) continue;
    if (!containsMatch || matched.length > containsMatch.name.length) {
      containsMatch = { app, name: matched };
    }
  }
  return containsMatch?.app ?? null;
}

/**
 * Resolve one editor's launching executable from Windows install locations.
 *
 * Pure given the injected IO, so the resolution rules are tested without a
 * Windows host or a real registry. Returns `null` when no verified executable
 * exists anywhere.
 */
export function resolveWindowsEditorExecutable(
  target: EditorTarget,
  io: WindowsEditorInstallIo,
): string | null {
  const spec = windowsEditorSpec(target);
  if (!spec) return null;
  return findViaProgramDirs(spec, io)
    ?? findViaJetBrainsDirs(spec, io)
    ?? findViaJetBrainsToolbox(spec, io)
    ?? findViaRegistry(spec, io);
}

// ── Default (real) IO ────────────────────────────────────────────────────

const UNINSTALL_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

function queryRegistryKey(key: string): Promise<string> {
  const command = trustedRegCommand();
  if (!command) return Promise.resolve("");
  return new Promise((resolve) => {
    execFile(
      command,
      ["query", key, "/s"],
      { windowsHide: true, timeout: 4_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });
}

let cachedTrustedRegCommand: string | null | undefined;

/**
 * The kernel-resolved `reg.exe`, memoized. A bare `reg.exe` lets
 * `CreateProcessW` search the current directory before PATH, which is a
 * code-execution hazard in a worktree (see `processExecution.ts` and
 * `trustedWindowsTools.ts`). A host that refuses the GLOBALROOT lookup returns
 * null, and registry discovery is skipped — the install-dir scan still runs.
 */
export function trustedRegCommand(): string | null {
  if (cachedTrustedRegCommand !== undefined) return cachedTrustedRegCommand;
  try {
    cachedTrustedRegCommand = resolveTrustedWindowsTool("reg");
  } catch (error) {
    if (!(error instanceof TrustedWindowsToolError)) throw error;
    cachedTrustedRegCommand = null;
  }
  return cachedTrustedRegCommand;
}

/** Parse `reg query <key> /s` output into one row per uninstall entry. */
export function parseRegistryUninstallOutput(output: string): WindowsRegistryApp[] {
  const apps: WindowsRegistryApp[] = [];
  let current: WindowsRegistryApp | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^HKEY_/i.test(line)) {
      current = null;
      continue;
    }
    const match = /^(\S+)\s+REG_\w+\s+(.*)$/i.exec(line);
    if (!match) continue;
    const [, name, value] = match;
    if (name.toLowerCase() === "displayname") {
      if (!value.trim()) continue;
      current = { displayName: value.trim() };
      apps.push(current);
    } else if (current && name.toLowerCase() === "installlocation") {
      current.installLocation = value.trim();
    } else if (current && name.toLowerCase() === "displayicon") {
      current.displayIcon = value.trim();
    }
  }
  return apps;
}

const WINDOWS_EXECUTABLE_TTL_MS = 5 * 60_000;
const windowsExecutableCache = new Map<EditorTarget, { value: string | null; readAt: number }>();
let registryAppsCache: { value: WindowsRegistryApp[]; readAt: number } | null = null;
let registryAppsPromise: Promise<WindowsRegistryApp[]> | null = null;

async function readWindowsRegistryApps(): Promise<WindowsRegistryApp[]> {
  const outputs = await Promise.all(UNINSTALL_KEYS.map((key) => queryRegistryKey(key)));
  return outputs.flatMap((output) => parseRegistryUninstallOutput(output));
}

/**
 * Registry rows with the same TTL as the executable cache. `force` re-reads;
 * otherwise an entry older than the TTL is refreshed once and shared by every
 * concurrent caller.
 */
async function readWindowsRegistryAppsCached(force: boolean): Promise<WindowsRegistryApp[]> {
  if (!force && registryAppsCache && Date.now() - registryAppsCache.readAt < WINDOWS_EXECUTABLE_TTL_MS) {
    return registryAppsCache.value;
  }
  if (!registryAppsPromise) {
    registryAppsPromise = readWindowsRegistryApps()
      .then((value) => {
        registryAppsCache = { value, readAt: Date.now() };
        return value;
      })
      .finally(() => {
        registryAppsPromise = null;
      });
  }
  return registryAppsPromise;
}

/**
 * `resolveWindowsEditorExecutable` against the real filesystem and registry,
 * cached for a few minutes so building the "Open in" menu does not re-scan on
 * every render. No-op off Windows.
 */
export async function resolveWindowsEditorExecutableCached(
  target: EditorTarget,
  options: { env?: NodeJS.ProcessEnv; force?: boolean } = {},
): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const cached = windowsExecutableCache.get(target);
  if (!options.force && cached && Date.now() - cached.readAt < WINDOWS_EXECUTABLE_TTL_MS) {
    return cached.value;
  }
  const registryApps = await readWindowsRegistryAppsCached(options.force === true);
  const value = resolveWindowsEditorExecutable(target, {
    env: options.env ?? process.env,
    pathExists: (candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    },
    listDir: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    registryApps,
  });
  windowsExecutableCache.set(target, { value, readAt: Date.now() });
  return value;
}

export const _testing = {
  resolveWindowsEditorExecutable,
  parseRegistryUninstallOutput,
  windowsEditorSpec,
  findRegistryAppForSpec,
  trustedRegCommand,
};
