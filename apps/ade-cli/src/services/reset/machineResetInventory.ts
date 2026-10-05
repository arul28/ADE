import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";
import { backgroundItemStatusCommand, parseBackgroundItemStatus } from "../../serviceManager/installLaunchd";
import {
  laneHasWork,
  type MachineResetItem,
  type MachineResetLane,
  type MachineResetPlan,
  type MachineResetProject,
} from "../../../../desktop/src/shared/types/machineReset";

/**
 * What the hard reset finds on a machine, and the plan it shows: every ADE
 * process, service, folder, Keychain item and config entry, and every project
 * with its lanes. Read-only — {@link ./machineReset} does the removing, from
 * this same inventory, so the list a person confirms is the list removed.
 * Every external effect goes through {@link MachineResetDeps}, the process
 * boundary.
 */
export type ProcessEntry = { pid: number; ppid: number; command: string };

export type RunResult = { status: number | null; stdout: string; stderr: string };

export type MachineResetDeps = {
  platform: NodeJS.Platform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  tmpDir: string;
  uid: number | null;
  selfPid: number;
  run: (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => RunResult;
  listProcesses: () => ProcessEntry[];
  kill: (pid: number, signal: NodeJS.Signals) => void;
  pidAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Desktop data folders the caller knows of (the running app's `userData`). */
  extraDesktopDataDirs: string[];
  /** Where the running CLI lives, for the Windows service uninstall child. */
  cliEntry: { execPath: string; scriptPath: string | null };
  log: (line: string) => void;
};

export function defaultMachineResetDeps(overrides: Partial<MachineResetDeps> = {}): MachineResetDeps {
  const platform = overrides.platform ?? process.platform;
  return {
    platform,
    homeDir: os.homedir(),
    env: process.env,
    tmpDir: os.tmpdir(),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    selfPid: process.pid,
    run: (command, args, options) => {
      const result = spawnSync(command, args, {
        cwd: options?.cwd,
        env: options?.env,
        encoding: "utf8",
        timeout: options?.timeoutMs ?? 60_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        status: result.error ? null : result.status,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : (result.error?.message ?? ""),
      };
    },
    listProcesses: () => listProcessesDefault(platform),
    kill: (pid, signal) => {
      if (platform === "win32") {
        spawnSync(resolveTrustedWindowsTool("taskkill"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        return;
      }
      process.kill(pid, signal);
    },
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    // The desktop names its own data folder when it hands the reset off.
    extraDesktopDataDirs: process.env.ADE_DESKTOP_USER_DATA_PATH?.trim()
      ? [process.env.ADE_DESKTOP_USER_DATA_PATH.trim()]
      : [],
    cliEntry: { execPath: process.execPath, scriptPath: process.argv[1] ?? null },
    log: () => {},
    ...overrides,
  };
}

function listProcessesDefault(platform: NodeJS.Platform): ProcessEntry[] {
  if (platform === "win32") {
    const result = spawnSync(
      resolveTrustedWindowsTool("powershell"),
      ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }"],
      { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
    );
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return result.stdout.split(/\r?\n/).flatMap((line) => {
      const [pid, ppid, ...rest] = line.split("\t");
      const pidNumber = Number(pid);
      if (!Number.isFinite(pidNumber) || pidNumber <= 0) return [];
      return [{ pid: pidNumber, ppid: Number(ppid) || 0, command: rest.join("\t") }];
    });
  }
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }];
  });
}

// ---------------------------------------------------------------------------
// Names ADE uses on a machine
// ---------------------------------------------------------------------------

const CHANNEL_SUFFIXES = ["", "-beta", "-alpha"] as const;
export const BUNDLE_IDS = ["com.ade.desktop", "com.ade.desktop.beta", "com.ade.desktop.alpha"] as const;
const DESKTOP_DATA_DIR_NAMES = [
  "ADE",
  "ADE Beta",
  "ADE Alpha",
  "ade-desktop",
  "ade-desktop-beta",
  "ade-desktop-alpha",
  "ade-desktop-dev",
] as const;
const KEYCHAIN_SERVICES = [
  "com.ade.desktop.api-keys.v1",
  "com.ade.runtime.credentials.file-store-key.v1",
  "com.ade.runtime.credentials.v1",
  "ADE Safe Storage",
  "ADE Beta Safe Storage",
  "ADE Alpha Safe Storage",
  "ade-desktop Safe Storage",
] as const;
const NATIVE_HELPER_NAMES = [
  "ade-attention-notch",
  "ade-desktop-driver",
  "ade-media",
  "ade-capture-helper",
  "ade-sim-helper",
] as const;
const CURSOR_HOOK_FILE_PREFIXES = ["ade-tool-gate.", "ade-precompact."] as const;

/** Marks the reset process itself, so the process sweep never kills it. */
const RESET_COMMAND_MARKER = " reset --all";

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type ServiceTarget =
  | { kind: "launchd"; label: string; plistPath: string | null }
  | { kind: "systemd"; unit: string; unitPath: string }
  | { kind: "windows"; channel: "stable" | "beta" | "alpha" };

export type ProjectTarget = MachineResetProject & {
  adeDir: string;
  isGitRepo: boolean;
};

export type Inventory = {
  adeHomes: string[];
  desktopDataDirs: string[];
  services: ServiceTarget[];
  processes: ProcessEntry[];
  projects: ProjectTarget[];
  /** Folders and files removed whole, outside projects. */
  machinePaths: string[];
  keychainServices: string[];
  simulators: Array<{ udid: string; markerPath: string }>;
  shellRcFiles: string[];
  cursorHooksJson: string | null;
  notes: string[];
};

export function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function uniquePaths(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export function adeHomeCandidates(deps: MachineResetDeps): string[] {
  const homes = CHANNEL_SUFFIXES.map((suffix) => path.join(deps.homeDir, `.ade${suffix}`));
  const explicit = deps.env.ADE_HOME?.trim();
  if (explicit) homes.push(explicit);
  return uniquePaths(homes).filter(isDirectory);
}

function appDataRoot(deps: MachineResetDeps): string {
  if (deps.platform === "darwin") return path.join(deps.homeDir, "Library", "Application Support");
  if (deps.platform === "win32") return deps.env.APPDATA?.trim() || path.join(deps.homeDir, "AppData", "Roaming");
  return deps.env.XDG_CONFIG_HOME?.trim() || path.join(deps.homeDir, ".config");
}

function localAppDataRoot(deps: MachineResetDeps): string {
  return deps.env.LOCALAPPDATA?.trim() || path.join(deps.homeDir, "AppData", "Local");
}

/** `ade-desktop-dev-<lane>`: one per lane worktree that ran `npm run dev:desktop`. */
function laneDevDataDirs(root: string): string[] {
  try {
    return fs.readdirSync(root)
      .filter((name) => name.startsWith("ade-desktop-dev-"))
      .map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

export function desktopDataDirCandidates(deps: MachineResetDeps): string[] {
  const root = appDataRoot(deps);
  return uniquePaths([
    ...DESKTOP_DATA_DIR_NAMES.map((name) => path.join(root, name)),
    ...laneDevDataDirs(root),
    ...deps.extraDesktopDataDirs,
  ]).filter(isDirectory);
}

/**
 * Every project ADE was used on: each ADE home's `projects.json` (all
 * records, not only the recent ones) and each desktop's `ade-state.json`.
 */
function projectRootCandidates(adeHomes: string[], desktopDataDirs: string[]): string[] {
  const roots: string[] = [];
  for (const home of adeHomes) {
    const registry = readJson(path.join(home, "projects.json")) as { projects?: unknown } | null;
    const records = Array.isArray(registry?.projects) ? registry.projects : [];
    for (const record of records) {
      const rootPath = (record as { rootPath?: unknown })?.rootPath;
      if (typeof rootPath === "string" && rootPath.trim()) roots.push(rootPath);
    }
  }
  for (const dataDir of desktopDataDirs) {
    const state = readJson(path.join(dataDir, "ade-state.json")) as Record<string, unknown> | null;
    if (!state) continue;
    const recents = Array.isArray(state.recentProjects) ? state.recentProjects : [];
    for (const entry of recents) {
      const record = entry as { rootPath?: unknown; remote?: unknown };
      if (record.remote) continue;
      if (typeof record.rootPath === "string" && record.rootPath.trim()) roots.push(record.rootPath);
    }
    if (typeof state.lastProjectRoot === "string" && state.lastProjectRoot.trim()) roots.push(state.lastProjectRoot);
    const workspace = state.updateWorkspace as { localRoots?: unknown } | undefined;
    if (Array.isArray(workspace?.localRoots)) {
      for (const root of workspace.localRoots) if (typeof root === "string" && root.trim()) roots.push(root);
    }
  }
  // A home folder registered as a project would make `<home>/.ade` look like
  // a project's ADE folder; it is the machine home and is handled as one.
  return uniquePaths(roots);
}

export function gitLines(deps: MachineResetDeps, cwd: string, args: string[]): string[] | null {
  const result = deps.run("git", ["-C", cwd, ...args], { timeoutMs: 30_000 });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Git reports worktrees by real path (`/tmp` is `/private/tmp` on macOS); compare like with like. */
export function realPath(target: string): string {
  // A path that does not exist yet (a rescue folder about to be made) still
  // has to compare like with like: resolve the deepest part that exists and
  // keep the rest as written.
  let existing = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(target);
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function inventoryLanes(deps: MachineResetDeps, rootPath: string, adeDir: string): MachineResetLane[] {
  const lines = gitLines(deps, rootPath, ["worktree", "list", "--porcelain"]);
  if (!lines) return [];
  const realAdeDir = realPath(adeDir);
  const lanes: MachineResetLane[] = [];
  let current: { path: string; branch: string | null; head: string | null } | null = null;
  const flush = () => {
    if (!current) return;
    if (isInside(realPath(current.path), realAdeDir)) {
      const worktreePath = path.resolve(current.path);
      const present = isDirectory(worktreePath);
      const status = present ? gitLines(deps, worktreePath, ["status", "--porcelain"]) : [];
      // A branch lane: commits no remote has. A detached HEAD (a lane in the
      // middle of a rebase, say): commits no branch, tag or remote holds —
      // removing the worktree would lose them with its HEAD.
      // Counted from the main repository with the HEAD id git listed, so a
      // lane whose folder is already gone is still measured.
      const count = current.branch
        ? deps.run("git", ["-C", rootPath, "rev-list", "--count", `refs/heads/${current.branch}`, "--not", "--remotes"])
        : current.head
          ? deps.run("git", ["-C", rootPath, "rev-list", "--count", current.head, "--not", "--branches", "--remotes", "--tags"])
          : { status: 1, stdout: "", stderr: "no HEAD listed" };
      const unpushed = count.status === 0 ? Number(count.stdout.trim()) : Number.NaN;
      const workUnknown = status === null || !Number.isFinite(unpushed);
      lanes.push({
        name: path.basename(worktreePath),
        path: worktreePath,
        branch: current.branch,
        ...(current.head ? { head: current.head } : {}),
        uncommittedFiles: status?.length ?? 0,
        unpushedCommits: Number.isFinite(unpushed) ? unpushed : 0,
        ...(workUnknown ? { workUnknown: true } : {}),
      });
    }
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length), branch: null, head: null };
    } else if (line.startsWith("HEAD ") && current) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return lanes;
}

function inventoryProjects(deps: MachineResetDeps, roots: string[], adeHomes: string[]): ProjectTarget[] {
  return roots.flatMap((rootPath) => {
    const adeDir = path.join(rootPath, ".ade");
    // The machine home lives at `<home>/.ade`; a project registered at the
    // home folder must not turn the machine home into "project data".
    if (adeHomes.includes(path.resolve(adeDir))) return [];
    const projectExists = isDirectory(rootPath);
    const isGitRepo = projectExists && exists(path.join(rootPath, ".git"));
    return [{
      rootPath,
      displayName: path.basename(rootPath) || rootPath,
      exists: projectExists,
      adeDir,
      isGitRepo,
      lanes: projectExists && isGitRepo ? inventoryLanes(deps, rootPath, adeDir) : [],
    }];
  });
}

function launchAgentsDir(deps: MachineResetDeps): string {
  return path.join(deps.homeDir, "Library", "LaunchAgents");
}

function inventoryServices(deps: MachineResetDeps): ServiceTarget[] {
  if (deps.platform === "darwin") {
    const dir = launchAgentsDir(deps);
    const byLabel = new Map<string, string | null>();
    for (const name of listDir(dir)) {
      if (/^com\.ade\..+\.plist$/.test(name)) byLabel.set(name.replace(/\.plist$/, ""), path.join(dir, name));
    }
    // Loaded jobs whose plist is already gone still run until booted out.
    const listed = deps.run("launchctl", ["list"]);
    if (listed.status === 0) {
      for (const line of listed.stdout.split("\n")) {
        const label = line.trim().split(/\s+/).pop() ?? "";
        if (/^com\.ade\./.test(label) && !byLabel.has(label)) byLabel.set(label, null);
      }
    }
    return [...byLabel].map(([label, plistPath]) => ({ kind: "launchd", label, plistPath }));
  }
  if (deps.platform === "win32") {
    return (["stable", "beta", "alpha"] as const).map((channel) => ({ kind: "windows", channel }));
  }
  const unitDir = path.join(deps.homeDir, ".config", "systemd", "user");
  return listDir(unitDir)
    .filter((name) => /^com\.ade\..+\.service$/.test(name))
    .map((name) => ({ kind: "systemd", unit: name, unitPath: path.join(unitDir, name) }));
}

export function isAdeProcessCommand(command: string): boolean {
  if (command.includes(RESET_COMMAND_MARKER)) return false;
  // macOS app bundles, and every helper inside them.
  if (/[/\\]ADE( Beta| Alpha)?\.app[/\\]/.test(command)) return true;
  // Windows: `ADE.exe` / `ADE Beta.exe`, quoted or not.
  if (/[/\\]ADE( Beta| Alpha)?\.exe("|\s|$)/i.test(command)) return true;
  // Linux: electron-builder names the binary after the package, `ade-desktop`.
  if (/[/\\]ade-desktop("|\s|$)/.test(command)) return true;
  if (/ade-cli[/\\](dist[/\\])?cli\.cjs/.test(command)) return true;
  return NATIVE_HELPER_NAMES.some((name) => new RegExp(`[/\\\\]${name}(-win)?(\\.exe)?("|\\s|$)`, "i").test(command));
}

/**
 * ADE's processes and everything they started (shells, agent CLIs, helpers),
 * never the reset itself or anything that started it.
 */
export function inventoryProcesses(deps: MachineResetDeps): ProcessEntry[] {
  const all = deps.listProcesses();
  const byPid = new Map(all.map((entry) => [entry.pid, entry]));
  const protectedPids = new Set<number>();
  for (let pid: number | undefined = deps.selfPid; pid && !protectedPids.has(pid); pid = byPid.get(pid)?.ppid) {
    protectedPids.add(pid);
  }
  const children = new Map<number, number[]>();
  for (const entry of all) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const selected = new Set<number>();
  const visit = (pid: number) => {
    if (selected.has(pid) || protectedPids.has(pid)) return;
    selected.add(pid);
    for (const child of children.get(pid) ?? []) visit(child);
  };
  for (const entry of all) if (isAdeProcessCommand(entry.command)) visit(entry.pid);
  return [...selected].map((pid) => byPid.get(pid)).filter((entry): entry is ProcessEntry => Boolean(entry));
}

function ownedByUser(target: string, deps: MachineResetDeps): boolean {
  if (deps.uid == null) return true;
  try {
    return fs.lstatSync(target).uid === deps.uid;
  } catch {
    return false;
  }
}

function matchingEntries(dir: string, predicate: (name: string) => boolean): string[] {
  return listDir(dir).filter(predicate).map((name) => path.join(dir, name));
}

/**
 * The folder names Claude Code and Cursor give their per-workspace data for a
 * lane of this project. Built from the project's own path, so a folder of
 * the person's that merely mentions "ade-worktrees" never matches.
 */
function agentSessionPrefixes(projectRoots: string[]): { claude: string[]; cursor: string[] } {
  const claude: string[] = [];
  const cursor: string[] = [];
  for (const root of projectRoots) {
    const resolved = path.resolve(root);
    // Claude: every non-alphanumeric becomes "-", so "/.ade/" reads "--ade-".
    claude.push(`${resolved.replace(/[^A-Za-z0-9]/g, "-")}--ade-worktrees-`);
    // Cursor: no leading separator, separators become "-", the dot is dropped.
    cursor.push(`${resolved.replace(/^[/\\]+/, "").replace(/[^A-Za-z0-9]+/g, "-")}-ade-worktrees-`);
  }
  return { claude, cursor };
}

export function inventoryMachinePaths(
  deps: MachineResetDeps,
  adeHomes: string[],
  desktopDataDirs: string[],
  projectRoots: string[],
): string[] {
  const home = deps.homeDir;
  const paths: string[] = [...adeHomes, ...desktopDataDirs];
  if (deps.platform === "darwin") {
    const library = path.join(home, "Library");
    const isBundleEntry = (name: string) => BUNDLE_IDS.some((id) => name === id || name.startsWith(`${id}.`));
    paths.push(
      ...matchingEntries(path.join(library, "Caches"), (name) => name.startsWith("ade-desktop-updater") || isBundleEntry(name)),
      ...matchingEntries(path.join(library, "Preferences"), (name) => isBundleEntry(name)),
      ...matchingEntries(path.join(library, "Saved Application State"), (name) => isBundleEntry(name)),
      ...matchingEntries(path.join(library, "HTTPStorages"), (name) => isBundleEntry(name)),
      ...matchingEntries(path.join(library, "WebKit"), (name) => isBundleEntry(name)),
      ...matchingEntries(path.join(library, "Logs"), (name) => /^(ADE( Beta| Alpha)?|ade-desktop.*)$/.test(name)),
      // Hand-parked agent definitions from older installs.
      ...matchingEntries(launchAgentsDir(deps), (name) => /^disabled-ade/.test(name)),
    );
  } else if (deps.platform === "win32") {
    const local = localAppDataRoot(deps);
    paths.push(
      path.join(local, "ADE"),
      ...matchingEntries(local, (name) => name.startsWith("ade-desktop-updater")),
    );
  } else {
    const cache = deps.env.XDG_CACHE_HOME?.trim() || path.join(home, ".cache");
    paths.push(...matchingEntries(cache, (name) => name.startsWith("ade-desktop-updater")));
  }
  // The CLI links ADE installed on PATH. Only links into an ADE install: a
  // file named `ade` the person put there themselves stays.
  for (const suffix of CHANNEL_SUFFIXES) {
    const link = path.join(home, ".local", "bin", `ade${suffix}`);
    try {
      if (fs.lstatSync(link).isSymbolicLink() && /ade-cli|ADE( Beta| Alpha)?\.app/.test(fs.readlinkSync(link))) {
        paths.push(link);
      }
    } catch {
      // not there
    }
  }
  // Cursor hook scripts ADE installed; hooks.json itself is edited, not removed.
  paths.push(...matchingEntries(path.join(home, ".cursor", "hooks"), (name) =>
    CURSOR_HOOK_FILE_PREFIXES.some((prefix) => name.startsWith(prefix))));
  // Coding-agent session folders for lane worktrees: they name worktrees the
  // reset removes, and nothing else ever reads them again.
  const sessionPrefixes = agentSessionPrefixes(projectRoots);
  paths.push(
    ...matchingEntries(path.join(home, ".claude", "projects"), (name) =>
      sessionPrefixes.claude.some((prefix) => name.startsWith(prefix))),
    ...matchingEntries(path.join(home, ".cursor", "projects"), (name) =>
      sessionPrefixes.cursor.some((prefix) => name.startsWith(prefix))),
  );
  // Legacy ADE skill copies: `ade-*` folders next to ADE's manifest only.
  for (const dir of [
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".factory", "skills"),
    path.join(home, ".config", "opencode", "skills"),
  ]) {
    const manifest = path.join(dir, ".ade-skills.json");
    if (!exists(manifest)) continue;
    paths.push(manifest, ...matchingEntries(dir, (name) => name.startsWith("ade-")));
  }
  // Scratch files ADE left in the temp folder. On a shared `/tmp` other
  // people's `ade-*` files are theirs: only this user's are removed.
  paths.push(...matchingEntries(deps.tmpDir, (name) =>
    name.startsWith("ade-") || name.startsWith("com.ade.desktop.ShipIt"))
    .filter((target) => ownedByUser(target, deps)));
  return uniquePaths(paths).filter(exists);
}

function inventorySimulators(deps: MachineResetDeps): Array<{ udid: string; markerPath: string }> {
  if (deps.platform !== "darwin") return [];
  const devicesDir = path.join(deps.homeDir, "Library", "Developer", "CoreSimulator", "Devices");
  return listDir(devicesDir).flatMap((udid) => {
    const markerPath = path.join(devicesDir, udid, "ade-lane-device.json");
    return exists(markerPath) ? [{ udid, markerPath }] : [];
  });
}

function shellRcCandidates(deps: MachineResetDeps): string[] {
  const home = deps.homeDir;
  return [
    path.join(home, ".zshrc"),
    path.join(home, ".bashrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".profile"),
    path.join(home, ".config", "fish", "config.fish"),
  ].filter((file) => {
    try {
      return stripAdeShellLines(fs.readFileSync(file, "utf8")) !== null;
    } catch {
      return false;
    }
  });
}

/**
 * Removes the PATH lines ADE added to a shell startup file, or returns null
 * when there are none. Two shapes exist: the desktop's `# ADE CLI` marker
 * plus the one line after it, and the standalone installer's
 * `# >>> ade >>>` … `# <<< ade <<<` block.
 */
export function stripAdeShellLines(raw: string): string | null {
  const lines = raw.split("\n");
  const out: string[] = [];
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "# ADE CLI" && /\.local\/bin/.test(lines[index + 1] ?? "")) {
      changed = true;
      index += 1;
      if (out.length && out[out.length - 1]?.trim() === "") out.pop();
      continue;
    }
    if (line.trim() === "# >>> ade >>>") {
      const end = lines.findIndex((candidate, at) => at > index && candidate.trim() === "# <<< ade <<<");
      if (end > index) {
        changed = true;
        index = end;
        if (out.length && out[out.length - 1]?.trim() === "") out.pop();
        continue;
      }
    }
    out.push(line);
  }
  return changed ? out.join("\n") : null;
}

export function cursorHooksWithoutAde(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const hooks = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return null;
  let changed = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => {
      const command = (entry as { command?: unknown })?.command;
      const isAde = typeof command === "string"
        && CURSOR_HOOK_FILE_PREFIXES.some((prefix) => command.includes(prefix));
      if (isAde) changed = true;
      return !isAde;
    });
    hooks[event] = kept;
  }
  return changed ? `${JSON.stringify(parsed, null, 2)}\n` : null;
}

function backgroundItemBlocked(plistPath: string, deps: MachineResetDeps): boolean {
  const { command, args } = backgroundItemStatusCommand(plistPath);
  const result = deps.run(command, args, { timeoutMs: 5_000 });
  return result.status === 0 && parseBackgroundItemStatus(result.stdout) === "requires_approval";
}

export function inventory(deps: MachineResetDeps): Inventory {
  const adeHomes = adeHomeCandidates(deps);
  const desktopDataDirs = desktopDataDirCandidates(deps);
  const projects = inventoryProjects(deps, projectRootCandidates(adeHomes, desktopDataDirs), adeHomes);
  const cursorHooksPath = path.join(deps.homeDir, ".cursor", "hooks.json");
  let cursorHooksJson: string | null = null;
  try {
    if (cursorHooksWithoutAde(fs.readFileSync(cursorHooksPath, "utf8")) !== null) cursorHooksJson = cursorHooksPath;
  } catch {
    // no Cursor hooks
  }
  const notes: string[] = [];
  const services = inventoryServices(deps);
  if (deps.platform === "darwin" && services.some((service) =>
    service.kind === "launchd"
    && service.plistPath
    && /^com\.ade\.runtime/.test(service.label)
    && backgroundItemBlocked(service.plistPath, deps))) {
    // The one thing a reset cannot undo, and the likeliest reason it was
    // needed: macOS keeps this switch outside every folder ADE owns.
    notes.push("Your Mac is blocking ADE from running in the background, and a reset can't change that. After the reset, open System Settings, go to General, then Login Items, and turn on ADE under \"Allow in the Background\".");
  }
  return {
    adeHomes,
    desktopDataDirs,
    services,
    processes: inventoryProcesses(deps),
    projects,
    machinePaths: inventoryMachinePaths(deps, adeHomes, desktopDataDirs, projects.map((project) => project.rootPath)),
    keychainServices: deps.platform === "darwin" ? [...KEYCHAIN_SERVICES] : [],
    simulators: inventorySimulators(deps),
    shellRcFiles: shellRcCandidates(deps),
    cursorHooksJson,
    notes,
  };
}

function isTempEntry(target: string, deps: MachineResetDeps): boolean {
  return path.dirname(target) === path.resolve(deps.tmpDir);
}

/**
 * The nearest ADE process this one runs under, or null. A reset started from
 * a terminal inside ADE would stop that terminal's brain, and the terminal —
 * and the reset with it — half-way through.
 */
export function findAdeAncestor(deps: MachineResetDeps, options: { allowPid?: number | null } = {}): ProcessEntry | null {
  const all = deps.listProcesses();
  const byPid = new Map(all.map((entry) => [entry.pid, entry]));
  const seen = new Set<number>();
  for (let pid = byPid.get(deps.selfPid)?.ppid; pid && pid > 1 && !seen.has(pid); pid = byPid.get(pid)?.ppid) {
    seen.add(pid);
    // The desktop that handed the reset off and is about to quit: the one ADE
    // parent this process is meant to outlive.
    if (pid === options.allowPid) continue;
    const entry = byPid.get(pid);
    if (entry && isAdeProcessCommand(entry.command)) return entry;
  }
  return null;
}

function describeMachinePath(target: string, deps: MachineResetDeps): string {
  const name = path.basename(target);
  if (target.startsWith(deps.tmpDir)) return "Temporary file";
  if (/^\.ade/.test(name) && path.dirname(target) === deps.homeDir) return "ADE's data folder";
  if (name.endsWith(".plist")) return "Settings file";
  if (target.includes(`${path.sep}.claude${path.sep}`) || target.includes(`${path.sep}.cursor${path.sep}`)) {
    return "Coding-agent data for a lane";
  }
  return "ADE folder";
}

export function planMachineReset(deps: MachineResetDeps): MachineResetPlan {
  const found = inventory(deps);
  return toPlan(found, deps);
}

function toPlan(found: Inventory, deps: MachineResetDeps): MachineResetPlan {
  const items: MachineResetItem[] = [
    ...found.processes.map((entry) => ({
      kind: "process" as const,
      label: "Running ADE process",
      target: `${entry.pid} ${entry.command.slice(0, 160)}`,
    })),
    ...found.services.map((service) => ({
      kind: "background_service" as const,
      label: "Background service",
      target: service.kind === "launchd"
        ? (service.plistPath ?? service.label)
        : service.kind === "systemd" ? service.unitPath : `ADE Runtime (${service.channel})`,
    })),
    ...found.machinePaths.filter((target) => !isTempEntry(target, deps)).map((target) => ({
      kind: (isDirectory(target) ? "directory" : "file") as MachineResetItem["kind"],
      label: describeMachinePath(target, deps),
      target,
    })),
    // Scratch files can number in the thousands; one line says it.
    ...(() => {
      const temp = found.machinePaths.filter((target) => isTempEntry(target, deps)).length;
      return temp
        ? [{ kind: "directory" as const, label: "Temporary files", target: `${path.join(deps.tmpDir, "ade-*")} (${temp})` }]
        : [];
    })(),
    ...found.projects.filter((project) => project.exists && exists(project.adeDir)).map((project) => ({
      kind: "directory" as const,
      label: "Project data",
      target: project.adeDir,
    })),
    ...found.simulators.map((simulator) => ({
      kind: "directory" as const,
      label: "Simulator ADE created",
      target: simulator.udid,
    })),
    ...found.keychainServices.map((service) => ({
      kind: "keychain" as const,
      label: "Keychain items",
      target: service,
    })),
    ...found.shellRcFiles.map((file) => ({
      kind: "config_entry" as const,
      label: "PATH line ADE added",
      target: file,
    })),
    ...(found.cursorHooksJson
      ? [{ kind: "config_entry" as const, label: "Cursor hook ADE added", target: found.cursorHooksJson }]
      : []),
  ];
  const projects: MachineResetProject[] = found.projects.map(({ rootPath, displayName, exists: projectExists, lanes }) => ({
    rootPath,
    displayName,
    exists: projectExists,
    lanes,
  }));
  return {
    generatedAt: deps.now().toISOString(),
    platform: deps.platform,
    projects,
    items,
    lanesWithWork: projects.reduce(
      (count, project) => count + project.lanes.filter(laneHasWork).length,
      0,
    ),
    notes: found.notes,
  };
}

/** Plain-text summary for `ade reset --text`. */
export function formatMachineResetPlan(plan: MachineResetPlan): string {
  const lines = ["ADE reset plan", ""];
  lines.push(`Projects (${plan.projects.length}):`);
  for (const project of plan.projects) {
    lines.push(`  ${project.rootPath}${project.exists ? "" : " (folder is gone)"}`);
    for (const lane of project.lanes) {
      const work = [
        lane.uncommittedFiles ? `${lane.uncommittedFiles} changed files` : "",
        lane.unpushedCommits ? `${lane.unpushedCommits} unpushed commits` : "",
        lane.workUnknown ? "git could not check it, so it is treated as having work" : "",
      ].filter(Boolean).join(", ");
      lines.push(`    lane ${lane.name}${lane.branch ? ` [${lane.branch}]` : ""}${work ? ` — ${work}` : ""}`);
    }
  }
  lines.push("", `Items (${plan.items.length}):`);
  for (const item of plan.items) lines.push(`  ${item.kind.padEnd(18)} ${item.target}`);
  if (plan.notes.length) {
    lines.push("", "Notes:");
    for (const note of plan.notes) lines.push(`  ${note}`);
  }
  return `${lines.join("\n")}\n`;
}
