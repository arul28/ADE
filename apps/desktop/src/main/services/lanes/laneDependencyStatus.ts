import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  LaneDependencyFolderStatus,
  LaneDependencyManager,
  LaneDependencyStatus,
} from "../../../shared/types";
import { runGit } from "../git/git";

/**
 * Which lockfiles the main checkout has, and whether each install is current.
 *
 * ADE never installs packages on its own. This only reads the disk, so the
 * desktop can say "main's packages are out of date" after a pull changes a
 * lockfile, and suggest a lane template when a project has packages.
 *
 * Two ways to tell that an install is current:
 *  - **The tool's own install record** (npm's hidden lockfile, pnpm's
 *    `.modules.yaml`, CocoaPods' `Manifest.lock`, …). An install rewrites it,
 *    so a lockfile newer than its record changed after the last install.
 *  - **A remembered fingerprint**, for tools that leave no record ADE can read
 *    (bun, Bundler, Python tools). The first fingerprint ADE sees counts as
 *    installed; a different one later means the lockfile changed. The user
 *    acknowledges it (Update or Dismiss) to make the new one current.
 */

type Detection =
  | { kind: "record"; files: string[] }
  | { kind: "npm" }
  | { kind: "cocoapods" }
  | { kind: "fingerprint" }
  | { kind: "none" };

type LockfileRule = {
  manager: LaneDependencyManager;
  installCommand: string | null;
  installDir: string | null;
  detection: Detection;
};

const LOCKFILE_RULES: Record<string, LockfileRule> = {
  "package-lock.json": { manager: "npm", installCommand: "npm install", installDir: "node_modules", detection: { kind: "npm" } },
  "npm-shrinkwrap.json": { manager: "npm", installCommand: "npm install", installDir: "node_modules", detection: { kind: "npm" } },
  "pnpm-lock.yaml": {
    manager: "pnpm",
    installCommand: "pnpm install",
    installDir: "node_modules",
    detection: { kind: "record", files: ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"] },
  },
  "yarn.lock": {
    manager: "yarn",
    installCommand: "yarn install",
    installDir: "node_modules",
    detection: { kind: "record", files: [".yarn/install-state.gz", "node_modules/.yarn-state.yml", "node_modules/.yarn-integrity"] },
  },
  "bun.lock": { manager: "bun", installCommand: "bun install", installDir: "node_modules", detection: { kind: "fingerprint" } },
  "bun.lockb": { manager: "bun", installCommand: "bun install", installDir: "node_modules", detection: { kind: "fingerprint" } },
  "Podfile.lock": { manager: "cocoapods", installCommand: "pod install", installDir: "Pods", detection: { kind: "cocoapods" } },
  "Gemfile.lock": { manager: "bundler", installCommand: "bundle install", installDir: null, detection: { kind: "fingerprint" } },
  "poetry.lock": { manager: "poetry", installCommand: "poetry install", installDir: ".venv", detection: { kind: "fingerprint" } },
  "uv.lock": { manager: "uv", installCommand: "uv sync", installDir: ".venv", detection: { kind: "fingerprint" } },
  "Pipfile.lock": { manager: "pipenv", installCommand: "pipenv install", installDir: null, detection: { kind: "fingerprint" } },
  "composer.lock": {
    manager: "composer",
    installCommand: "composer install",
    installDir: "vendor",
    detection: { kind: "record", files: ["vendor/composer/installed.json"] },
  },
  // These tools fetch what they need at build time, so there is nothing to update.
  "Cargo.lock": { manager: "cargo", installCommand: null, installDir: null, detection: { kind: "none" } },
  "go.sum": { manager: "go", installCommand: null, installDir: null, detection: { kind: "none" } },
  "Package.resolved": { manager: "swiftpm", installCommand: null, installDir: null, detection: { kind: "none" } },
};

const LOCKFILE_NAMES = Object.keys(LOCKFILE_RULES);
const MAX_LOCKFILES = 50;
const STATUS_CACHE_MS = 20_000;
/** Git's checkout and an install that finishes in the same second share a timestamp. */
const MTIME_SLACK_MS = 2_000;
const BASELINE_FILE = "dependency-baselines.json";

type Baselines = Record<string, { fingerprint?: string; installedFingerprint?: string }>;

type HashEntry = { size: number; mtimeMs: number; hash: string };
const hashCache = new Map<string, HashEntry>();
const npmCompareCache = new Map<string, { key: string; current: boolean | null }>();
const statusCache = new Map<string, { at: number; status: LaneDependencyStatus }>();

export type LaneDependencyStatusDeps = {
  projectRoot: string;
  /** Machine-local folder for the remembered fingerprints (`.ade/cache`). */
  cacheDir: string;
  getDefaultTemplateId: () => string | null;
  getTemplateCount: () => number;
  logger?: { warn: (event: string, meta?: Record<string, unknown>) => void };
  platform?: NodeJS.Platform;
};

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function fingerprintOf(absolute: string, stat: fs.Stats): string {
  const cached = hashCache.get(absolute);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.hash;
  const hash = crypto.createHash("sha1").update(fs.readFileSync(absolute)).digest("hex").slice(0, 12);
  hashCache.set(absolute, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
  return hash;
}

function readBaselines(cacheDir: string): Baselines {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, BASELINE_FILE), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Baselines) : {};
  } catch {
    return {};
  }
}

function writeBaselines(cacheDir: string, baselines: Baselines, logger?: LaneDependencyStatusDeps["logger"]): void {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const target = path.join(cacheDir, BASELINE_FILE);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(baselines, null, 2)}\n`);
    fs.renameSync(temp, target);
  } catch (error) {
    // Without the file ADE only forgets what it already showed.
    logger?.warn("lane_dependency_status.baseline_write_failed", { cacheDir, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Lockfiles git knows about (tracked or not ignored), so `node_modules` and nested repos are never walked. */
async function listLockfiles(projectRoot: string): Promise<{ files: string[]; truncated: boolean }> {
  const pathspecs = LOCKFILE_NAMES.map((name) => `:(glob)**/${name}`);
  const result = await runGit(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs],
    { cwd: projectRoot, timeoutMs: 15_000 },
  ).catch(() => null);
  let files: string[];
  if (result && result.exitCode === 0) {
    files = [...new Set(result.stdout.split("\0").map((entry) => entry.trim()).filter(Boolean))];
  } else {
    // Not a git checkout: look at the root only.
    files = LOCKFILE_NAMES.filter((name) => statOrNull(path.join(projectRoot, name))?.isFile());
  }
  files = files.filter((file) => LOCKFILE_RULES[path.posix.basename(file)] && fs.existsSync(path.join(projectRoot, file)));
  files.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return { files: files.slice(0, MAX_LOCKFILES), truncated: files.length > MAX_LOCKFILES };
}

/**
 * npm: compare the lockfile with what npm says it installed. Exact, so a
 * branch switch that only touches the lockfile's timestamp is not reported.
 * Null when either file cannot be read.
 */
function npmInstallMatches(lockfilePath: string, hiddenPath: string, lockStat: fs.Stats, hiddenStat: fs.Stats): boolean | null {
  const key = `${lockStat.size}:${lockStat.mtimeMs}:${hiddenStat.size}:${hiddenStat.mtimeMs}`;
  const cached = npmCompareCache.get(lockfilePath);
  if (cached?.key === key) return cached.current;
  let current: boolean | null = null;
  try {
    const wanted = (JSON.parse(fs.readFileSync(lockfilePath, "utf8")) as { packages?: Record<string, { version?: string; optional?: boolean; peer?: boolean; link?: boolean }> }).packages;
    const installed = (JSON.parse(fs.readFileSync(hiddenPath, "utf8")) as { packages?: Record<string, { version?: string }> }).packages;
    if (wanted && installed) {
      current = true;
      for (const [name, entry] of Object.entries(wanted)) {
        if (!name || !name.startsWith("node_modules/") || entry.link) continue;
        const have = installed[name];
        if (!have) {
          // Optional packages for other platforms are never installed.
          if (entry.optional || entry.peer) continue;
          current = false;
          break;
        }
        if (entry.version && have.version && entry.version !== have.version) {
          current = false;
          break;
        }
      }
    }
  } catch {
    current = null;
  }
  npmCompareCache.set(lockfilePath, { key, current });
  return current;
}

function newestRecord(base: string, files: string[]): fs.Stats | null {
  let newest: fs.Stats | null = null;
  for (const file of files) {
    const stat = statOrNull(path.join(base, file));
    if (stat && (!newest || stat.mtimeMs > newest.mtimeMs)) newest = stat;
  }
  return newest;
}

function folderStatus(projectRoot: string, lockfile: string, baselines: Baselines): LaneDependencyFolderStatus | null {
  const rule = LOCKFILE_RULES[path.posix.basename(lockfile)];
  if (!rule) return null;
  const absolute = path.join(projectRoot, lockfile);
  const lockStat = statOrNull(absolute);
  if (!lockStat?.isFile()) return null;
  const dirPosix = path.posix.dirname(lockfile);
  const dirAbs = path.join(projectRoot, dirPosix);
  const fingerprint = fingerprintOf(absolute, lockStat);
  const base: LaneDependencyFolderStatus = {
    manager: rule.manager,
    lockfile,
    dir: dirPosix,
    installCommand: rule.installCommand,
    installDir: rule.installDir,
    installed: rule.installDir ? Boolean(statOrNull(path.join(dirAbs, rule.installDir))?.isDirectory()) : null,
    outOfDate: false,
    outOfDateReason: null,
    tracksInstall: rule.detection.kind !== "fingerprint",
    fingerprint,
  };
  const memory = baselines[lockfile] ?? {};
  const changedReason = `${path.posix.basename(lockfile)} changed after the last ${rule.installCommand ?? "install"}.`;

  switch (rule.detection.kind) {
    case "none":
      return base;
    case "fingerprint": {
      if (base.installed === false) return base;
      if (!memory.fingerprint) {
        baselines[lockfile] = { ...memory, fingerprint };
        return base;
      }
      if (memory.fingerprint !== fingerprint) return { ...base, outOfDate: true, outOfDateReason: changedReason };
      return base;
    }
    case "cocoapods": {
      if (!base.installed) return base;
      const manifest = path.join(dirAbs, "Pods", "Manifest.lock");
      try {
        const same = fs.readFileSync(manifest, "utf8") === fs.readFileSync(absolute, "utf8");
        return same ? base : { ...base, outOfDate: true, outOfDateReason: "Podfile.lock does not match the installed pods." };
      } catch {
        return base;
      }
    }
    case "npm": {
      if (!base.installed) return base;
      const hiddenPath = path.join(dirAbs, "node_modules", ".package-lock.json");
      const hiddenStat = statOrNull(hiddenPath);
      if (hiddenStat) {
        const matches = npmInstallMatches(absolute, hiddenPath, lockStat, hiddenStat);
        if (matches === true) return base;
        if (matches === false) {
          return { ...base, outOfDate: true, outOfDateReason: "The installed packages do not match package-lock.json." };
        }
      }
      return recordCompare(base, lockStat, hiddenStat, memory, baselines, changedReason);
    }
    case "record": {
      // Yarn Plug'n'Play installs leave a record and no `node_modules`.
      const record = newestRecord(dirAbs, rule.detection.files);
      if (!record) return base;
      return recordCompare(base.installed ? base : { ...base, installed: true }, lockStat, record, memory, baselines, changedReason);
    }
  }
}

/**
 * A lockfile newer than the tool's install record changed after the install,
 * unless its content is the one ADE last saw installed (a branch switch away
 * and back rewrites the file without changing it).
 */
function recordCompare(
  base: LaneDependencyFolderStatus,
  lockStat: fs.Stats,
  record: fs.Stats | null,
  memory: Baselines[string],
  baselines: Baselines,
  changedReason: string,
): LaneDependencyFolderStatus {
  if (!record) return base;
  if (record.mtimeMs + MTIME_SLACK_MS >= lockStat.mtimeMs) {
    if (memory.installedFingerprint !== base.fingerprint) {
      baselines[base.lockfile] = { ...memory, installedFingerprint: base.fingerprint };
    }
    return base;
  }
  if (memory.installedFingerprint === base.fingerprint) return base;
  return { ...base, outOfDate: true, outOfDateReason: changedReason };
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** One line for the machine's terminal: POSIX shells, or PowerShell on Windows. */
export function buildDependencyUpdateCommand(
  folders: Array<Pick<LaneDependencyFolderStatus, "dir" | "installCommand">>,
  platform: NodeJS.Platform,
): string | null {
  const runnable = folders.filter((folder) => folder.installCommand);
  if (runnable.length === 0) return null;
  if (platform === "win32") {
    return runnable
      .map((folder) =>
        folder.dir === "."
          ? folder.installCommand!
          : `Push-Location -LiteralPath ${quotePowerShell(folder.dir.split("/").join("\\"))}; ${folder.installCommand}; Pop-Location`,
      )
      .join("; ");
  }
  return runnable
    .map((folder) => (folder.dir === "." ? folder.installCommand! : `(cd ${quotePosix(folder.dir)} && ${folder.installCommand})`))
    .join(" && ");
}

export async function readLaneDependencyStatus(
  deps: LaneDependencyStatusDeps,
  options: { refresh?: boolean } = {},
): Promise<LaneDependencyStatus> {
  const cached = statusCache.get(deps.projectRoot);
  if (!options.refresh && cached && Date.now() - cached.at < STATUS_CACHE_MS) {
    // Templates change from Settings without touching the disk the cache read.
    return {
      ...cached.status,
      defaultTemplateId: deps.getDefaultTemplateId(),
      templateCount: deps.getTemplateCount(),
    };
  }
  const platform = deps.platform ?? process.platform;
  const { files, truncated } = await listLockfiles(deps.projectRoot);
  const baselines = readBaselines(deps.cacheDir);
  const before = JSON.stringify(baselines);
  const folders: LaneDependencyFolderStatus[] = [];
  for (const file of files) {
    try {
      const status = folderStatus(deps.projectRoot, file, baselines);
      if (status) folders.push(status);
    } catch (error) {
      // One unreadable lockfile must not hide the others.
      deps.logger?.warn("lane_dependency_status.lockfile_read_failed", { lockfile: file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (JSON.stringify(baselines) !== before) writeBaselines(deps.cacheDir, baselines, deps.logger);
  const status: LaneDependencyStatus = {
    projectRoot: deps.projectRoot,
    platform,
    folders,
    truncated,
    updateCommand: buildDependencyUpdateCommand(folders.filter((folder) => folder.outOfDate), platform),
    defaultTemplateId: deps.getDefaultTemplateId(),
    templateCount: deps.getTemplateCount(),
    checkedAt: new Date().toISOString(),
  };
  statusCache.set(deps.projectRoot, { at: Date.now(), status });
  return status;
}

/**
 * Make the current lockfiles count as installed, for the tools whose installs
 * ADE cannot see (`tracksInstall: false`), once the user starts an update.
 */
export async function acknowledgeLaneDependencyStatus(
  deps: LaneDependencyStatusDeps,
  args: { lockfiles?: string[] } = {},
): Promise<LaneDependencyStatus> {
  const wanted = args.lockfiles?.length ? new Set(args.lockfiles.map((entry) => toPosix(entry.trim()))) : null;
  const { files } = await listLockfiles(deps.projectRoot);
  const baselines = readBaselines(deps.cacheDir);
  for (const file of files) {
    if (wanted && !wanted.has(file)) continue;
    // Tools with an install record report a finished install themselves; marking
    // them current here would hide an update that has not run yet.
    if (LOCKFILE_RULES[path.posix.basename(file)]?.detection.kind !== "fingerprint") continue;
    const absolute = path.join(deps.projectRoot, file);
    const stat = statOrNull(absolute);
    if (!stat?.isFile()) continue;
    const fingerprint = fingerprintOf(absolute, stat);
    baselines[file] = { fingerprint, installedFingerprint: fingerprint };
  }
  writeBaselines(deps.cacheDir, baselines, deps.logger);
  return readLaneDependencyStatus(deps, { refresh: true });
}
