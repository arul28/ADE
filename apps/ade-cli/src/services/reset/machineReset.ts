import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backgroundItemStatusCommand, parseBackgroundItemStatus } from "../../serviceManager/installLaunchd";
import type {
  MachineResetFailure,
  MachineResetItem,
  MachineResetLane,
  MachineResetOptions,
  MachineResetPlan,
  MachineResetProject,
  MachineResetReceipt,
  MachineResetRescuedLane,
} from "../../../../desktop/src/shared/types/machineReset";

/**
 * The hard reset engine: removes everything ADE put on this computer.
 *
 * Planning and doing share one inventory ({@link inventory}), so the list the
 * person confirms is exactly the list that is removed. Nothing here talks to
 * a brain — the reset is for machines where the brain is the problem — and
 * every external effect goes through {@link MachineResetDeps}, the process
 * boundary.
 *
 * Safety rails, in order of importance:
 *  1. A project's own files are never removed. Inside a project the reset
 *     touches only `<root>/.ade`, the lane worktrees git lists under it, lane
 *     branches whose every commit also lives on another branch or a remote,
 *     and ADE's line in `.git/info/exclude`. Files a project committed under
 *     `.ade/` are restored from git after the wipe.
 *  2. Lane work is rescued (committed on its branch, or moved out with git)
 *     before anything is removed, unless the person chose `none`. A rescue
 *     that fails falls back to moving the lane folder out, never to deleting it.
 *  3. Every machine path is checked against {@link assertRemovable} first.
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
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
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
      "powershell.exe",
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
const BUNDLE_IDS = ["com.ade.desktop", "com.ade.desktop.beta", "com.ade.desktop.alpha"] as const;
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

type ServiceTarget =
  | { kind: "launchd"; label: string; plistPath: string | null }
  | { kind: "systemd"; unit: string; unitPath: string }
  | { kind: "windows"; channel: "stable" | "beta" | "alpha" };

type ProjectTarget = MachineResetProject & {
  adeDir: string;
  isGitRepo: boolean;
};

type Inventory = {
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

function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
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

function uniquePaths(paths: Iterable<string>): string[] {
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

function adeHomeCandidates(deps: MachineResetDeps): string[] {
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

function desktopDataDirCandidates(deps: MachineResetDeps): string[] {
  const root = appDataRoot(deps);
  return uniquePaths([
    ...DESKTOP_DATA_DIR_NAMES.map((name) => path.join(root, name)),
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

function gitLines(deps: MachineResetDeps, cwd: string, args: string[]): string[] | null {
  const result = deps.run("git", ["-C", cwd, ...args], { timeoutMs: 30_000 });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Git reports worktrees by real path (`/tmp` is `/private/tmp` on macOS); compare like with like. */
function realPath(target: string): string {
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

function inventoryLanes(deps: MachineResetDeps, rootPath: string, adeDir: string): MachineResetLane[] {
  const lines = gitLines(deps, rootPath, ["worktree", "list", "--porcelain"]);
  if (!lines) return [];
  const realAdeDir = realPath(adeDir);
  const lanes: MachineResetLane[] = [];
  let current: { path: string; branch: string | null } | null = null;
  const flush = () => {
    if (!current) return;
    if (isInside(realPath(current.path), realAdeDir)) {
      const worktreePath = path.resolve(current.path);
      const status = isDirectory(worktreePath) ? gitLines(deps, worktreePath, ["status", "--porcelain"]) : [];
      const unpushed = current.branch
        ? Number(deps.run("git", ["-C", rootPath, "rev-list", "--count", current.branch, "--not", "--remotes"]).stdout.trim()) || 0
        : 0;
      lanes.push({
        name: path.basename(worktreePath),
        path: worktreePath,
        branch: current.branch,
        uncommittedFiles: status?.length ?? 0,
        unpushedCommits: unpushed,
      });
    }
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length), branch: null };
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
function inventoryProcesses(deps: MachineResetDeps): ProcessEntry[] {
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

function inventoryMachinePaths(deps: MachineResetDeps, adeHomes: string[], desktopDataDirs: string[]): string[] {
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
  paths.push(
    ...matchingEntries(path.join(home, ".claude", "projects"), (name) => name.includes("-ade-worktrees-")),
    ...matchingEntries(path.join(home, ".cursor", "projects"), (name) => name.includes("ade-worktrees")),
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

function cursorHooksWithoutAde(raw: string): string | null {
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

function inventory(deps: MachineResetDeps): Inventory {
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
    machinePaths: inventoryMachinePaths(deps, adeHomes, desktopDataDirs),
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
export function findAdeAncestor(deps: MachineResetDeps): ProcessEntry | null {
  const all = deps.listProcesses();
  const byPid = new Map(all.map((entry) => [entry.pid, entry]));
  const seen = new Set<number>();
  for (let pid = byPid.get(deps.selfPid)?.ppid; pid && pid > 1 && !seen.has(pid); pid = byPid.get(pid)?.ppid) {
    seen.add(pid);
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
      (count, project) => count + project.lanes.filter((lane) => lane.uncommittedFiles > 0 || lane.unpushedCommits > 0).length,
      0,
    ),
    notes: found.notes,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * The last check before anything is removed: the path is absolute, is not the
 * home folder or a parent of it, and lives under the home folder, the temp
 * folder, or a project's `.ade` folder.
 */
function assertRemovable(target: string, deps: MachineResetDeps, extraRoots: string[] = []): void {
  const resolved = path.resolve(target);
  if (!path.isAbsolute(target) || resolved === path.parse(resolved).root) {
    throw new Error(`Refusing to remove ${target}: not a safe path.`);
  }
  if (resolved === path.resolve(deps.homeDir) || isInside(path.resolve(deps.homeDir), resolved)) {
    throw new Error(`Refusing to remove ${target}: it contains the home folder.`);
  }
  const allowedRoots = [deps.homeDir, deps.tmpDir, ...extraRoots].map((root) => path.resolve(root));
  if (!allowedRoots.some((root) => isInside(resolved, root))) {
    throw new Error(`Refusing to remove ${target}: outside the folders a reset may touch.`);
  }
}

function makeWritable(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  try {
    fs.chmodSync(target, stat.isDirectory() ? 0o777 : 0o666);
  } catch {
    // best effort; the retry reports what is still in the way
  }
  if (stat.isDirectory()) {
    for (const name of listDir(target)) makeWritable(path.join(target, name));
  }
}

function removePath(
  target: string,
  deps: MachineResetDeps,
  receipt: { removed: string[]; failed: MachineResetFailure[] },
  extraRoots: string[] = [],
): void {
  try {
    assertRemovable(target, deps, extraRoots);
    if (!exists(target)) return;
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      // Git marks its object files read-only, and Windows refuses to delete
      // a read-only file. Make the tree writable and try once more.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") throw error;
      makeWritable(target);
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
    receipt.removed.push(target);
    deps.log(`removed ${target}`);
  } catch (error) {
    receipt.failed.push({ target, error: error instanceof Error ? error.message : String(error) });
    deps.log(`failed to remove ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForExit(deps: MachineResetDeps, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!deps.pidAlive(pid)) return true;
    await deps.sleep(200);
  }
  return !deps.pidAlive(pid);
}

function stopServices(services: ServiceTarget[], deps: MachineResetDeps, receipt: MachineResetReceipt): void {
  for (const service of services) {
    if (service.kind === "launchd") {
      const domain = deps.uid != null ? `gui/${deps.uid}` : null;
      const bootout = domain ? deps.run("launchctl", ["bootout", `${domain}/${service.label}`]) : null;
      if ((!bootout || bootout.status !== 0) && service.plistPath) {
        deps.run("launchctl", ["unload", service.plistPath]);
      }
      if (service.plistPath) removePath(service.plistPath, deps, receipt);
      else receipt.removed.push(`launchd:${service.label}`);
    } else if (service.kind === "systemd") {
      deps.run("systemctl", ["--user", "disable", "--now", service.unit]);
      removePath(service.unitPath, deps, receipt);
    } else {
      // The Windows supervisor, scheduled task and Run key belong to the
      // service manager. It reads which channel to remove from the
      // environment, so each channel gets its own run with its own names.
      const suffix = service.channel === "stable" ? "" : `.${service.channel}`;
      const env: NodeJS.ProcessEnv = {
        ...deps.env,
        ADE_PACKAGE_CHANNEL: service.channel,
        ADE_RUNTIME_SERVICE_NAME: `com.ade.runtime${suffix}`,
        ADE_HOME: path.join(deps.homeDir, service.channel === "stable" ? ".ade" : `.ade-${service.channel}`),
      };
      // A packaged CLI is a script run by the app binary; a standalone one is
      // the binary itself.
      const script = deps.cliEntry.scriptPath;
      const args = script && /\.(c?js|mjs)$/i.test(script)
        ? [script, "serve", "--uninstall-service"]
        : ["serve", "--uninstall-service"];
      const result = deps.run(deps.cliEntry.execPath, args, { timeoutMs: 60_000, env });
      if (result.status === 0) receipt.removed.push(`windows-service:${service.channel}`);
    }
  }
  if (deps.platform === "linux" && services.length) deps.run("systemctl", ["--user", "daemon-reload"]);
}

async function stopProcesses(deps: MachineResetDeps, receipt: MachineResetReceipt): Promise<void> {
  // Re-read: the services just booted out took their children with them, and
  // a pid from the plan may already belong to something else.
  const targets = inventoryProcesses(deps);
  for (const entry of targets) {
    try {
      deps.kill(entry.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && targets.some((entry) => deps.pidAlive(entry.pid))) {
    await deps.sleep(200);
  }
  for (const entry of targets) {
    if (!deps.pidAlive(entry.pid)) continue;
    try {
      deps.kill(entry.pid, "SIGKILL");
    } catch {
      // gone between the check and the kill
    }
  }
  if (targets.length) receipt.notes.push(`Stopped ${targets.length} ADE process${targets.length === 1 ? "" : "es"}.`);
}

function laneHasWork(lane: MachineResetLane): boolean {
  return lane.uncommittedFiles > 0 || lane.unpushedCommits > 0;
}

function uniqueDestination(base: string): string {
  let candidate = base;
  for (let index = 2; exists(candidate); index += 1) candidate = `${base}-${index}`;
  return candidate;
}

function commitLaneWork(deps: MachineResetDeps, lane: MachineResetLane): { ok: true; branch: string } | { ok: false; error: string } {
  let branch = lane.branch;
  if (!branch) {
    // Detached HEAD: give the work a branch to live on first.
    branch = `ade-rescue/${lane.name}`;
    const created = deps.run("git", ["-C", lane.path, "checkout", "-b", branch]);
    if (created.status !== 0) return { ok: false, error: created.stderr.trim() || "could not create a rescue branch" };
  }
  if (lane.uncommittedFiles > 0) {
    const added = deps.run("git", ["-C", lane.path, "add", "-A"]);
    if (added.status !== 0) return { ok: false, error: added.stderr.trim() || "git add failed" };
    const message = "ADE reset: saved lane work before removing the lane";
    let committed = deps.run("git", ["-C", lane.path, "commit", "--no-verify", "-m", message]);
    if (committed.status !== 0 && /identity|user\.email|user\.name/i.test(committed.stderr)) {
      committed = deps.run("git", [
        "-C", lane.path, "-c", "user.name=ADE reset", "-c", "user.email=reset@ade.invalid",
        "commit", "--no-verify", "-m", message,
      ]);
    }
    if (committed.status !== 0) return { ok: false, error: committed.stderr.trim() || "git commit failed" };
  }
  return { ok: true, branch };
}

function moveLane(
  deps: MachineResetDeps,
  project: ProjectTarget,
  lane: MachineResetLane,
  rescueRoot: string,
): { ok: true; location: string } | { ok: false; error: string } {
  const destination = uniqueDestination(path.join(rescueRoot, project.displayName, lane.name));
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // Twice: a locked worktree is only moved with --force given twice.
  const moved = deps.run("git", ["-C", project.rootPath, "worktree", "move", "--force", "--force", lane.path, destination]);
  if (moved.status !== 0) return { ok: false, error: moved.stderr.trim() || "git worktree move failed" };
  return { ok: true, location: destination };
}

/** A branch whose every commit is also on another branch, a tag or a remote: deleting it loses nothing. */
function branchIsRedundant(deps: MachineResetDeps, rootPath: string, branch: string): boolean {
  // `--exclude` patterns for `--branches` are branch names, not full refs: a
  // `refs/heads/` prefix matches nothing, the branch stays in its own `--not`
  // set, and every branch reads as redundant.
  const unique = deps.run("git", [
    "-C", rootPath, "rev-list", "--count", `refs/heads/${branch}`,
    "--not", `--exclude=${branch}`, "--branches", "--remotes", "--tags",
  ]);
  return unique.status === 0 && unique.stdout.trim() === "0";
}

function scrubExcludeRule(rootPath: string): boolean {
  let gitDir = path.join(rootPath, ".git");
  try {
    if (fs.statSync(gitDir).isFile()) {
      const pointer = fs.readFileSync(gitDir, "utf8").match(/^gitdir:\s*(.+)\s*$/im)?.[1];
      if (!pointer) return false;
      gitDir = path.resolve(rootPath, pointer);
    }
  } catch {
    return false;
  }
  const excludePath = path.join(gitDir, "info", "exclude");
  let raw: string;
  try {
    raw = fs.readFileSync(excludePath, "utf8");
  } catch {
    return false;
  }
  const isAdeRule = (line: string) => /^\/?\.ade(\/(\*\*?)?)?$/.test(line.trim());
  const kept = raw.split(/\r?\n/).filter((line) => !isAdeRule(line));
  while (kept.length && kept[kept.length - 1]?.trim() === "") kept.pop();
  const next = kept.length ? `${kept.join("\n")}\n` : "";
  if (next === raw) return false;
  fs.writeFileSync(excludePath, next, "utf8");
  return true;
}

function resetProject(
  project: ProjectTarget,
  options: MachineResetOptions,
  deps: MachineResetDeps,
  receipt: MachineResetReceipt,
): void {
  if (!project.exists) return;
  const fallbackRescueRoot = path.join(deps.homeDir, "ADE Rescued Lanes");
  const keptBranches = new Set<string>();

  if (project.isGitRepo) {
    // Fresh numbers: the brain is stopped now, so nothing changes underneath.
    const lanes = inventoryLanes(deps, project.rootPath, project.adeDir);
    for (const lane of lanes) {
      let moved = false;
      if (options.rescue !== "none" && laneHasWork(lane)) {
        if (options.rescue === "move" && options.rescueDir) {
          const result = moveLane(deps, project, lane, options.rescueDir);
          if (result.ok) {
            moved = true;
            if (lane.branch) keptBranches.add(lane.branch);
            receipt.rescued.push({ projectRoot: project.rootPath, lane: lane.name, mode: "move", branch: lane.branch, location: result.location });
          } else {
            receipt.failed.push({ target: lane.path, error: `move failed, committing instead: ${result.error}` });
          }
        }
        if (!moved) {
          const committed = commitLaneWork(deps, lane);
          if (committed.ok) {
            keptBranches.add(committed.branch);
            receipt.rescued.push({ projectRoot: project.rootPath, lane: lane.name, mode: "commit", branch: committed.branch, location: null });
          } else {
            // Never delete work a rescue could not save: park the folder.
            const parked = moveLane(deps, project, lane, fallbackRescueRoot);
            if (parked.ok) {
              moved = true;
              if (lane.branch) keptBranches.add(lane.branch);
              receipt.rescued.push({ projectRoot: project.rootPath, lane: lane.name, mode: "move", branch: lane.branch, location: parked.location });
            } else {
              receipt.failed.push({ target: lane.path, error: `could not save this lane's work (${committed.error}); left in place` });
              if (lane.branch) keptBranches.add(lane.branch);
              continue;
            }
          }
        }
      }
      if (moved) continue;
      const removed = deps.run("git", ["-C", project.rootPath, "worktree", "remove", "--force", "--force", lane.path]);
      if (removed.status === 0) receipt.removed.push(lane.path);
      if (lane.branch && !keptBranches.has(lane.branch)) {
        if (branchIsRedundant(deps, project.rootPath, lane.branch)) {
          const deleted = deps.run("git", ["-C", project.rootPath, "branch", "-D", lane.branch]);
          if (deleted.status === 0) receipt.removed.push(`${project.rootPath} branch ${lane.branch}`);
        } else {
          receipt.notes.push(`Kept branch ${lane.branch} in ${project.displayName}: it has commits that are nowhere else.`);
        }
      }
    }
  }

  // Files the project committed under `.ade/` belong to the repository.
  const tracked = project.isGitRepo
    ? (gitLines(deps, project.rootPath, ["ls-files", "--", ".ade"]) ?? [])
    : [];
  // A lane the reset could not save is still inside `.ade/worktrees`.
  const unsavedLaneLeft = receipt.failed.some((failure) => isInside(realPath(failure.target), realPath(project.adeDir)));
  if (unsavedLaneLeft) {
    for (const name of listDir(project.adeDir)) {
      if (name === "worktrees") continue;
      removePath(path.join(project.adeDir, name), deps, receipt, [project.rootPath]);
    }
  } else {
    removePath(project.adeDir, deps, receipt, [project.rootPath]);
  }
  if (project.isGitRepo) {
    deps.run("git", ["-C", project.rootPath, "worktree", "prune"]);
    if (tracked.length) {
      deps.run("git", ["-C", project.rootPath, "checkout", "HEAD", "--", ".ade"]);
      receipt.notes.push(`Restored ${tracked.length} file${tracked.length === 1 ? "" : "s"} ${project.displayName} commits under .ade/.`);
    }
    if (scrubExcludeRule(project.rootPath)) receipt.removed.push(`${project.rootPath} .git/info/exclude .ade rule`);
  }
}

function clearKeychain(services: string[], deps: MachineResetDeps, receipt: MachineResetReceipt): void {
  for (const service of services) {
    let deleted = 0;
    // One item per call; stop at the first "not found". Bounded so a keychain
    // that keeps answering cannot spin forever.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = deps.run("security", ["delete-generic-password", "-s", service], { timeoutMs: 10_000 });
      if (result.status !== 0) break;
      deleted += 1;
    }
    if (deleted) receipt.removed.push(`keychain:${service} (${deleted})`);
  }
}

function clearAppleState(deps: MachineResetDeps, simulators: Inventory["simulators"], receipt: MachineResetReceipt): void {
  if (deps.platform !== "darwin") return;
  for (const simulator of simulators) {
    deps.run("xcrun", ["simctl", "shutdown", simulator.udid], { timeoutMs: 60_000 });
    const deleted = deps.run("xcrun", ["simctl", "delete", simulator.udid], { timeoutMs: 120_000 });
    if (deleted.status === 0) receipt.removed.push(`simulator:${simulator.udid}`);
    else receipt.failed.push({ target: `simulator:${simulator.udid}`, error: deleted.stderr.trim() || "simctl delete failed" });
  }
  for (const bundleId of BUNDLE_IDS) {
    // cfprefsd caches preferences; deleting the plist alone can be undone by
    // its next flush.
    deps.run("defaults", ["delete", bundleId]);
    // Privacy permissions (microphone, screen recording, accessibility…).
    deps.run("tccutil", ["reset", "All", bundleId]);
  }
}

/**
 * What a Windows install registers outside its folders: the user PATH entry
 * for `%LOCALAPPDATA%\\ADE\\bin` and the `ade://` link. The NSIS uninstaller
 * removes the same two; a reset has to as well, or a fresh install inherits
 * a PATH entry to a folder that is gone.
 */
function clearWindowsRegistrations(deps: MachineResetDeps, receipt: MachineResetReceipt): void {
  if (deps.platform !== "win32") return;
  const script = [
    "$p = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "if ($p) {",
    "  $kept = ($p -split ';' | Where-Object { $_ -and ($_ -notmatch '\\\\ADE\\\\bin\\\\?$') }) -join ';'",
    "  if ($kept -ne $p) { [Environment]::SetEnvironmentVariable('Path', $kept, 'User'); 'path' }",
    "}",
    "$k = 'HKCU:\\Software\\Classes\\ade'",
    "if (Test-Path $k) { $c = (Get-ItemProperty -Path ($k + '\\shell\\open\\command') -ErrorAction SilentlyContinue).'(default)'; if ($c -match 'ADE') { Remove-Item -Path $k -Recurse -Force; 'scheme' } }",
  ].join("\n");
  const result = deps.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 30_000 });
  if (result.stdout.includes("path")) receipt.removed.push("Windows user PATH entry for ADE");
  if (result.stdout.includes("scheme")) receipt.removed.push("ade:// link");
}

function clearConfigEntries(found: Inventory, deps: MachineResetDeps, receipt: MachineResetReceipt): void {
  for (const file of found.shellRcFiles) {
    try {
      const next = stripAdeShellLines(fs.readFileSync(file, "utf8"));
      if (next !== null) {
        fs.writeFileSync(file, next, "utf8");
        receipt.removed.push(`${file} (ADE PATH lines)`);
      }
    } catch (error) {
      receipt.failed.push({ target: file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (found.cursorHooksJson) {
    try {
      const next = cursorHooksWithoutAde(fs.readFileSync(found.cursorHooksJson, "utf8"));
      if (next !== null) {
        fs.writeFileSync(found.cursorHooksJson, next, "utf8");
        receipt.removed.push(`${found.cursorHooksJson} (ADE hooks)`);
      }
    } catch (error) {
      receipt.failed.push({ target: found.cursorHooksJson, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export type MachineResetRunOptions = MachineResetOptions & {
  /** Wait for this process (the desktop app) to exit before starting. */
  waitPid?: number | null;
  /** Where to write the receipt; defaults to the channel's fresh ADE home. */
  receiptPath?: string;
};

export async function executeMachineReset(
  options: MachineResetRunOptions,
  deps: MachineResetDeps,
): Promise<MachineResetReceipt> {
  const receipt: MachineResetReceipt = {
    version: 1,
    startedAt: deps.now().toISOString(),
    finishedAt: "",
    ok: false,
    removed: [],
    rescued: [],
    failed: [],
    notes: [],
  };
  if (options.rescue === "move" && !options.rescueDir) {
    throw new Error("Moving lanes out needs a destination folder.");
  }
  if (options.waitPid && options.waitPid !== deps.selfPid) {
    deps.log(`waiting for process ${options.waitPid} to exit`);
    if (!await waitForExit(deps, options.waitPid, 30_000)) {
      // The desktop did not quit; it is an ADE process, so the sweep below
      // stops it like every other.
      receipt.notes.push(`Process ${options.waitPid} did not exit by itself and was stopped.`);
    }
  }

  const found = inventory(deps);
  if (options.rescue === "move" && options.rescueDir) {
    // Rescued lanes must not land somewhere the reset is about to remove.
    const rescueDir = realPath(options.rescueDir);
    const doomed = [
      ...found.machinePaths,
      ...found.projects.map((project) => project.adeDir),
    ].map(realPath);
    const clash = doomed.find((target) => rescueDir === target || isInside(rescueDir, target));
    if (clash) {
      throw new Error(`The rescue folder ${options.rescueDir} is inside ${clash}, which the reset removes. Pick another folder.`);
    }
  }
  deps.log(`plan: ${found.services.length} services, ${found.processes.length} processes, ${found.projects.length} projects, ${found.machinePaths.length} machine paths`);

  // 1. Nothing may restart or write while the rest runs.
  stopServices(found.services, deps, receipt);
  await stopProcesses(deps, receipt);

  // 2. Projects: rescue lane work, then remove ADE's data inside each.
  for (const project of found.projects) {
    try {
      resetProject(project, options, deps, receipt);
    } catch (error) {
      receipt.failed.push({ target: project.rootPath, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // 3. The machine.
  clearAppleState(deps, found.simulators, receipt);
  clearKeychain(found.keychainServices, deps, receipt);
  clearConfigEntries(found, deps, receipt);
  clearWindowsRegistrations(deps, receipt);
  // Inventory again for paths: a process stopped above may have flushed one
  // more file (a log, a state file) on its way out.
  const machinePaths = uniquePaths([
    ...found.machinePaths,
    ...inventoryMachinePaths(deps, adeHomeCandidates(deps), desktopDataDirCandidates(deps)),
  ]);
  for (const target of machinePaths) removePath(target, deps, receipt);

  receipt.notes.push(...found.notes);
  receipt.finishedAt = deps.now().toISOString();
  receipt.ok = receipt.failed.length === 0;

  const receiptPath = options.receiptPath ?? path.join(deps.env.ADE_HOME?.trim() || path.join(deps.homeDir, ".ade"), "reset-receipt.json");
  try {
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  } catch (error) {
    deps.log(`could not write the receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  return receipt;
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

export function formatMachineResetReceipt(receipt: MachineResetReceipt): string {
  const lines = [receipt.ok ? "ADE reset finished." : "ADE reset finished with problems.", ""];
  lines.push(`Removed ${receipt.removed.length} items.`);
  for (const rescued of receipt.rescued) {
    lines.push(`Saved lane ${rescued.lane}: ${rescued.mode === "move" ? `moved to ${rescued.location}` : `committed on branch ${rescued.branch}`}`);
  }
  for (const failure of receipt.failed) lines.push(`Could not remove ${failure.target}: ${failure.error}`);
  for (const note of receipt.notes) lines.push(note);
  return `${lines.join("\n")}\n`;
}
