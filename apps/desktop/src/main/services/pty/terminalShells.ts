import fs from "node:fs";
import path from "node:path";
import { resolveWindowsShellKind } from "../../../shared/cliLaunch";
import type { TerminalShellOption } from "../../../shared/types/terminalShells";
import type { Logger } from "../logging/logger";

/**
 * Which shells this machine has, and which one a new terminal opens.
 *
 * Detection runs on the machine that owns the terminal (the brain, or the
 * desktop's own runtime), so a Settings page for another machine lists that
 * machine's shells. Only shells found here can be chosen: there is no
 * free-text command, so a saved choice can never become an arbitrary launch.
 *
 * WSL is left out on purpose. `resolveWindowsShellLaunchFields` refuses it:
 * a lane's Windows path and environment do not carry into a WSL distro, so a
 * WSL terminal would open somewhere other than the lane.
 */

/** Detection reads a few files; a terminal open reuses the last answer. */
const DETECTION_TTL_MS = 5 * 60_000;
/** A saved id missing from a cached list re-checks once the list is this old. */
const MISSING_SHELL_REDETECT_MS = 10_000;
/** `/etc/shells` is a short file; anything longer is not one. */
const MAX_LISTED_SHELLS = 64;
const MAX_SHELL_ID_LENGTH = 1024;
const PREFERENCE_FILE_NAME = "terminal-shell.json";

/** Entries `/etc/shells` lists that are not shells a person works in. */
const NON_INTERACTIVE_SHELL_NAMES = new Set(["nologin", "false", "true", "git-shell", "rbash", "sync"]);

type FsPromises = Pick<typeof fs.promises, "readFile" | "stat" | "lstat" | "access" | "realpath">;

export type ShellDetectionDeps = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fsp?: FsPromises;
};

function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const direct = env[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  // A plain copy of a Windows environment loses its case-insensitive lookup.
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === lower && typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function isRegularFile(fsp: FsPromises, file: string): Promise<boolean> {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(fsp: FsPromises, file: string): Promise<boolean> {
  if (!(await isRegularFile(fsp, file))) return false;
  try {
    await fsp.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows: a real file, or an App Execution Alias (the Microsoft Store's
 * `pwsh.exe` under WindowsApps), which `stat` cannot follow but a process
 * launch can.
 */
async function windowsExecutableExists(fsp: FsPromises, file: string): Promise<boolean> {
  if (await isRegularFile(fsp, file)) return true;
  try {
    await fsp.lstat(file);
    return true;
  } catch {
    return false;
  }
}

function parseEtcShells(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || !line.startsWith("/")) continue;
    out.push(line);
    if (out.length >= MAX_LISTED_SHELLS) break;
  }
  return out;
}

async function detectPosixShells(env: NodeJS.ProcessEnv, fsp: FsPromises): Promise<TerminalShellOption[]> {
  const listed: string[] = [];
  // $SHELL first: it is what Automatic opens, so a symlinked duplicate of it
  // in /etc/shells collapses onto the path the user already knows.
  const fromEnv = env.SHELL?.trim();
  if (fromEnv && path.posix.isAbsolute(fromEnv)) listed.push(fromEnv);
  try {
    listed.push(...parseEtcShells(await fsp.readFile("/etc/shells", "utf8")));
  } catch {
    // No /etc/shells (some containers): $SHELL alone.
  }
  const seenPaths = new Set<string>();
  const seenTargets = new Set<string>();
  const shells: TerminalShellOption[] = [];
  for (const file of listed) {
    if (seenPaths.has(file)) continue;
    seenPaths.add(file);
    const name = path.posix.basename(file);
    if (NON_INTERACTIVE_SHELL_NAMES.has(name)) continue;
    if (!(await isExecutableFile(fsp, file))) continue;
    // Merged-/usr systems list /bin/bash and /usr/bin/bash for one binary.
    // Distinct binaries that share a name (Apple's /bin/bash and Homebrew's)
    // both stay; the picker shows their paths.
    let target = file;
    try {
      target = await fsp.realpath(file);
    } catch {
      // Keep the listed path as its own identity.
    }
    if (seenTargets.has(target)) continue;
    seenTargets.add(target);
    shells.push({ id: file, label: name, path: file });
  }
  return shells;
}

async function detectWindowsShells(env: NodeJS.ProcessEnv, fsp: FsPromises): Promise<TerminalShellOption[]> {
  const win = path.win32;
  const systemRoot = envValue(env, "SystemRoot") ?? envValue(env, "WINDIR") ?? "C:\\Windows";
  const programFiles = [
    envValue(env, "ProgramFiles"),
    envValue(env, "ProgramW6432"),
    envValue(env, "ProgramFiles(x86)"),
  ].filter((value): value is string => Boolean(value));
  const localAppData = envValue(env, "LOCALAPPDATA");
  const pathDirs = (envValue(env, "Path") ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .slice(0, 256);

  const firstExisting = async (candidates: string[]): Promise<string | null> => {
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (await windowsExecutableExists(fsp, candidate)) return candidate;
    }
    return null;
  };

  const shells: TerminalShellOption[] = [];
  const pwsh = await firstExisting([
    ...programFiles.map((root) => win.join(root, "PowerShell", "7", "pwsh.exe")),
    ...pathDirs.map((dir) => win.join(dir, "pwsh.exe")),
  ]);
  if (pwsh) shells.push({ id: "pwsh", label: "PowerShell 7", path: pwsh });

  const windowsPowerShell = await firstExisting([
    win.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ]);
  if (windowsPowerShell) shells.push({ id: "powershell", label: "Windows PowerShell", path: windowsPowerShell });

  const comSpec = envValue(env, "ComSpec");
  const cmd = await firstExisting([
    ...(comSpec && win.basename(comSpec).toLowerCase() === "cmd.exe" ? [comSpec] : []),
    win.join(systemRoot, "System32", "cmd.exe"),
  ]);
  if (cmd) shells.push({ id: "cmd", label: "Command Prompt", path: cmd });

  // Git for Windows: the standard installs, then whatever `git.exe` on PATH
  // belongs to (`<root>\cmd`, `<root>\bin` or `<root>\mingw64\bin`).
  const gitRoots = [
    ...programFiles.map((root) => win.join(root, "Git")),
    ...(localAppData ? [win.join(localAppData, "Programs", "Git")] : []),
  ];
  for (const dir of pathDirs) {
    const normalized = dir.replace(/[\\/]+$/, "");
    const base = win.basename(normalized).toLowerCase();
    const parent = win.dirname(normalized);
    if (base === "cmd" || base === "bin") {
      if (win.basename(parent).toLowerCase() === "mingw64") gitRoots.push(win.dirname(parent));
      else gitRoots.push(parent);
    }
  }
  const gitBashCandidates: string[] = [];
  for (const root of gitRoots) {
    const bash = win.join(root, "bin", "bash.exe");
    // The same rule the launcher applies: never System32's WSL `bash.exe`.
    if (resolveWindowsShellKind(bash) === "git-bash") gitBashCandidates.push(bash);
  }
  // A PATH dir yields a root only when Git is really there.
  const gitBash = await (async () => {
    const seen = new Set<string>();
    for (const candidate of gitBashCandidates) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (await isRegularFile(fsp, candidate)) return candidate;
    }
    return null;
  })();
  if (gitBash) shells.push({ id: "git-bash", label: "Git Bash", path: gitBash });

  return shells;
}

/** Scan this machine for shells. Never throws; a failed check drops that shell. */
export async function detectInstalledShells(deps: ShellDetectionDeps = {}): Promise<TerminalShellOption[]> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const fsp = deps.fsp ?? fs.promises;
  try {
    return platform === "win32" ? await detectWindowsShells(env, fsp) : await detectPosixShells(env, fsp);
  } catch {
    return [];
  }
}

export type TerminalShellPreferenceStore = {
  /** The saved shell id, or null for Automatic. A missing or unreadable file is Automatic. */
  readDefaultShellId(): Promise<string | null>;
  writeDefaultShellId(shellId: string | null): Promise<void>;
  /** The installed shells, from a short-lived cache unless `refresh`. */
  listShells(options?: { refresh?: boolean }): Promise<TerminalShellOption[]>;
  /** The installed shell with this id, re-checking once if a recent scan missed it. */
  findShell(shellId: string): Promise<TerminalShellOption | null>;
};

/**
 * The machine's default-shell choice, kept in the machine's ADE home
 * (`~/.ade/terminal-shell.json`) so every project on the machine, the brain
 * and the desktop's own runtime agree on it. Read on each new shell (the file
 * is a few bytes), so a change made through one process reaches the other.
 */
export function createTerminalShellPreferenceStore(args: {
  adeDir: string;
  logger?: Pick<Logger, "warn"> | null;
  detection?: ShellDetectionDeps;
}): TerminalShellPreferenceStore {
  const filePath = path.join(args.adeDir, PREFERENCE_FILE_NAME);
  let cache: { at: number; shells: Promise<TerminalShellOption[]> } | null = null;

  const listShells = (options: { refresh?: boolean } = {}): Promise<TerminalShellOption[]> => {
    const now = Date.now();
    if (!options.refresh && cache && now - cache.at < DETECTION_TTL_MS) return cache.shells;
    const shells = detectInstalledShells(args.detection);
    cache = { at: now, shells };
    return shells;
  };

  return {
    async readDefaultShellId() {
      let text: string;
      try {
        text = await fs.promises.readFile(filePath, "utf8");
      } catch {
        return null;
      }
      try {
        const parsed = JSON.parse(text) as { defaultShellId?: unknown } | null;
        const id = typeof parsed?.defaultShellId === "string" ? parsed.defaultShellId.trim() : "";
        return id && id.length <= MAX_SHELL_ID_LENGTH ? id : null;
      } catch {
        args.logger?.warn("pty.default_shell_preference_unreadable", { filePath });
        return null;
      }
    },
    async writeDefaultShellId(shellId) {
      await fs.promises.mkdir(args.adeDir, { recursive: true });
      const body = `${JSON.stringify({ defaultShellId: shellId }, null, 2)}\n`;
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.promises.writeFile(tempPath, body, "utf8");
        await fs.promises.rename(tempPath, filePath);
      } catch (error) {
        // Windows refuses the rename while another process holds the file
        // open (an indexer, antivirus); a direct write still lands it.
        await fs.promises.rm(tempPath, { force: true }).catch(() => {});
        await fs.promises.writeFile(filePath, body, "utf8").catch(() => {
          throw error;
        });
      }
    },
    listShells,
    async findShell(shellId) {
      const before = cache;
      const found = (await listShells()).find((shell) => shell.id === shellId);
      if (found) return found;
      // Installed a moment ago? Look again, but never on every terminal open:
      // not when that list was just scanned, nor when it is still recent.
      if (!before || cache !== before || Date.now() - before.at < MISSING_SHELL_REDETECT_MS) return null;
      return (await listShells({ refresh: true })).find((shell) => shell.id === shellId) ?? null;
    },
  };
}

const storesByAdeDir = new Map<string, TerminalShellPreferenceStore>();

/** One store per ADE home, shared by every project runtime in this process. */
export function terminalShellPreferenceStoreFor(
  adeDir: string,
  logger?: Pick<Logger, "warn"> | null,
): TerminalShellPreferenceStore {
  const key = path.resolve(adeDir);
  let store = storesByAdeDir.get(key);
  if (!store) {
    store = createTerminalShellPreferenceStore({ adeDir: key, logger });
    storesByAdeDir.set(key, store);
  }
  return store;
}
