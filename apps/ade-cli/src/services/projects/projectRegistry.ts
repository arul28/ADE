import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveMachineAdeLayout,
  type MachineAdeLayout,
} from "./machineLayout";
import { codedError } from "../../../../desktop/src/shared/codedError";
import { resolveMachineAdeDir } from "./machineLayout";
import { statIdentity } from "./fileIdentity";
import { normalizeProjectRootPath } from "./projectRoots";

export type ProjectId = string;

export type ProjectCatalogVisibility = "recent" | "system";

export type ProjectRegistrationSource =
  | "desktop"
  | "mobile"
  | "cli-explicit"
  | "runtime-auto"
  | "test";

export type ProjectRegistrationIntent = {
  catalogVisibility: ProjectCatalogVisibility;
  registrationSource: ProjectRegistrationSource;
};

export const SYSTEM_PROJECT_REGISTRATION: ProjectRegistrationIntent = {
  catalogVisibility: "system",
  registrationSource: "runtime-auto",
};

export type ProjectRecord = {
  projectId: ProjectId;
  rootPath: string;
  displayName: string;
  addedAt: number;
  lastOpenedAt: number;
  gitOriginUrl: string | null;
  catalogVisibility: ProjectCatalogVisibility;
  registrationSource: ProjectRegistrationSource;
};

/** A database file's device and inode, as decimal strings. A move keeps both. */
export type ProjectDatabaseIdentity = { dev: string; ino: string };

type ProjectRegistryFile = {
  version: 2;
  projects: ProjectRecord[];
};

type ProjectRegistryOptions = {
  /** Desktop recents used only while upgrading a legacy v1 registry. */
  legacyRecentProjectRoots?: Iterable<string>;
};

function normalizeRoot(rootPath: string): string {
  return normalizeProjectRootPath(rootPath);
}

function isSamePath(left: string, right: string): boolean {
  return normalizeRoot(left) === normalizeRoot(right);
}

export function isDisallowedProjectRoot(
  rootPath: string,
  homeDir = os.homedir(),
): boolean {
  const normalized = normalizeRoot(rootPath);
  if (homeDir && isSamePath(normalized, homeDir)) return true;
  return normalized === path.parse(normalized).root;
}

export function deriveProjectId(rootPath: string): ProjectId {
  const normalized = normalizeRoot(rootPath);
  const digest = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 24);
  return `project_${digest}`;
}

function readGitOriginUrl(rootPath: string): string | null {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: rootPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length ? value : null;
}

function ensureProjectAdeDir(rootPath: string): void {
  fs.mkdirSync(path.join(rootPath, ".ade"), { recursive: true });
}

/**
 * How long a parsed registry may be reused while `projects.json` is unchanged.
 * Each read normalizes every root (realpath, stat, linked-worktree checks), and
 * hot paths call `get` once per project, so an uncached read is O(projects²)
 * synchronous filesystem work on the brain's event loop. The window bounds how
 * stale a root's normalization can get when the disk under it changes.
 */
const REGISTRY_READ_CACHE_MS = 5_000;

function cloneRegistryFile(file: ProjectRegistryFile): ProjectRegistryFile {
  return { version: 2, projects: file.projects.map((project) => ({ ...project })) };
}

function emptyFile(): ProjectRegistryFile {
  return { version: 2, projects: [] };
}

function isProjectRegistrationSource(
  value: unknown,
): value is ProjectRegistrationSource {
  return (
    value === "desktop" ||
    value === "mobile" ||
    value === "cli-explicit" ||
    value === "runtime-auto" ||
    value === "test"
  );
}

function isExistingGitRoot(rootPath: string): boolean {
  try {
    return (
      fs.statSync(rootPath).isDirectory() && fs.existsSync(path.join(rootPath, ".git"))
    );
  } catch {
    return false;
  }
}

function coerceRecord(
  value: unknown,
  registration: ProjectRegistrationIntent,
): ProjectRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rootPath =
    typeof record.rootPath === "string" ? normalizeRoot(record.rootPath) : "";
  if (!rootPath) return null;
  if (isDisallowedProjectRoot(rootPath)) return null;
  const projectId = deriveProjectId(rootPath);
  const now = Date.now();
  return {
    projectId,
    rootPath,
    displayName:
      typeof record.displayName === "string" && record.displayName.trim()
        ? record.displayName.trim()
        : path.basename(rootPath),
    addedAt:
      typeof record.addedAt === "number" && Number.isFinite(record.addedAt)
        ? record.addedAt
        : now,
    lastOpenedAt:
      typeof record.lastOpenedAt === "number" &&
      Number.isFinite(record.lastOpenedAt)
        ? record.lastOpenedAt
        : now,
    gitOriginUrl:
      typeof record.gitOriginUrl === "string" && record.gitOriginUrl.trim()
        ? record.gitOriginUrl.trim()
        : null,
    catalogVisibility: registration.catalogVisibility,
    registrationSource: registration.registrationSource,
  };
}

export class ProjectRegistry {
  private readonly layout: MachineAdeLayout;
  private readonly legacyRecentProjectRoots: Set<string>;
  private readCache: { identity: string; at: number; file: ProjectRegistryFile } | null = null;

  constructor(
    layout: MachineAdeLayout = resolveMachineAdeLayout(),
    options: ProjectRegistryOptions = {},
  ) {
    this.layout = layout;
    this.legacyRecentProjectRoots = new Set(
      [...(options.legacyRecentProjectRoots ?? [])]
        .map((rootPath) => {
          try {
            return normalizeRoot(rootPath);
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    );
  }

  get path(): string {
    return this.layout.projectsPath;
  }

  list(): ProjectRecord[] {
    return this.read().projects;
  }

  listRecent(): ProjectRecord[] {
    return this.list().filter(
      (record) => record.catalogVisibility === "recent",
    );
  }

  get(projectId: ProjectId): ProjectRecord | null {
    return this.list().find((record) => record.projectId === projectId) ?? null;
  }

  findByRootPath(rootPath: string): ProjectRecord | null {
    const normalized = normalizeRoot(rootPath);
    return this.list().find((record) => record.rootPath === normalized) ?? null;
  }

  add(
    rootPath: string,
    registration: ProjectRegistrationIntent = SYSTEM_PROJECT_REGISTRATION,
  ): ProjectRecord {
    const normalized = normalizeRoot(rootPath);
    if (isDisallowedProjectRoot(normalized)) {
      throw new Error(
        "Refusing to register the user home directory or filesystem root as an ADE project. Choose a project folder.",
      );
    }
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      throw new Error(`Project root is not a directory: ${normalized}`);
    }

    assertProjectNotMovedAway(normalized);
    const file = this.read();
    const now = Date.now();
    const projectId = deriveProjectId(normalized);
    const existingIndex = file.projects.findIndex(
      (record) =>
        record.projectId === projectId || record.rootPath === normalized,
    );
    const existing = existingIndex >= 0 ? file.projects[existingIndex] : null;
    this.assertProjectDataAvailable(existing);
    ensureProjectAdeDir(normalized);
    this.recordDatabaseIfPresent(projectId, normalized);
    const next: ProjectRecord = {
      projectId,
      rootPath: normalized,
      displayName: existing?.displayName ?? path.basename(normalized),
      addedAt: existing?.addedAt ?? now,
      lastOpenedAt: now,
      gitOriginUrl: existing?.gitOriginUrl ?? readGitOriginUrl(normalized),
      catalogVisibility:
        existing?.catalogVisibility === "recent" ||
        registration.catalogVisibility === "recent"
          ? "recent"
          : "system",
      registrationSource: registration.registrationSource,
    };
    if (existingIndex >= 0) {
      file.projects[existingIndex] = next;
    } else {
      file.projects.push(next);
    }
    this.write(file);
    return next;
  }

  setCatalogVisibilityByRootPath(
    rootPath: string,
    catalogVisibility: ProjectCatalogVisibility,
    registrationSource: ProjectRegistrationSource,
  ): ProjectRecord | null {
    const normalized = normalizeRoot(rootPath);
    const file = this.read();
    const index = file.projects.findIndex(
      (record) => record.rootPath === normalized,
    );
    if (index < 0) return null;
    const current = file.projects[index]!;
    if (
      current.catalogVisibility === catalogVisibility &&
      current.registrationSource === registrationSource
    ) {
      return current;
    }
    const next: ProjectRecord = {
      ...current,
      catalogVisibility,
      registrationSource,
    };
    file.projects[index] = next;
    this.write(file);
    return next;
  }

  remove(projectId: ProjectId): boolean {
    const file = this.read();
    const nextProjects = file.projects.filter(
      (record) => record.projectId !== projectId,
    );
    if (nextProjects.length === file.projects.length) return false;
    this.write({ ...file, projects: nextProjects });
    this.forgetDatabaseIdentity(projectId);
    return true;
  }

  touch(projectId: ProjectId): ProjectRecord {
    const file = this.read();
    const index = file.projects.findIndex(
      (record) => record.projectId === projectId,
    );
    if (index < 0) throw new Error(`Unknown projectId: ${projectId}`);
    const next: ProjectRecord = {
      ...file.projects[index]!,
      lastOpenedAt: Date.now(),
    };
    this.recordDatabaseIfPresent(projectId, next.rootPath);
    file.projects[index] = next;
    this.write(file);
    return next;
  }

  /**
   * The identity (device and inode) of the database this machine opened for
   * the project; its presence means the project had data here. One file per
   * project beside the registry, not a field in projects.json: an older ADE
   * that rewrites projects.json drops fields it doesn't know, and with it the
   * protection against silently creating a replacement.
   */
  private databaseIdentityPath(projectId: ProjectId): string {
    return path.join(this.layout.adeDir, "project-data", `${projectId}.json`);
  }

  /**
   * Records the database file's identity. Moving a folder to the Trash keeps
   * it, so recovery can tell this project's trashed `.ade` from any other —
   * even before the database has a project row.
   */
  private recordDatabaseIfPresent(projectId: ProjectId, rootPath: string): void {
    let stat: fs.BigIntStats;
    try {
      stat = fs.statSync(path.join(rootPath, ".ade", "ade.db"), { bigint: true });
    } catch {
      return;
    }
    const identity: ProjectDatabaseIdentity = { dev: stat.dev.toString(), ino: stat.ino.toString() };
    const known = this.readDatabaseIdentity(projectId);
    if (known?.dev === identity.dev && known.ino === identity.ino) return;
    const identityPath = this.databaseIdentityPath(projectId);
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    fs.writeFileSync(identityPath, JSON.stringify(identity));
  }

  /** The device and inode of the database this machine last opened for the project. */
  readDatabaseIdentity(projectId: ProjectId): ProjectDatabaseIdentity | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.databaseIdentityPath(projectId), "utf8")) as { dev?: unknown; ino?: unknown };
      return typeof parsed.dev === "string" && typeof parsed.ino === "string" ? { dev: parsed.dev, ino: parsed.ino } : null;
    } catch {
      return null;
    }
  }

  /**
   * Forget that the database existed, so the next open creates a new one.
   * Only for an explicit "start fresh" or removing the project from ADE.
   */
  forgetDatabaseIdentity(projectId: ProjectId): void {
    fs.rmSync(this.databaseIdentityPath(projectId), { force: true });
  }

  /**
   * A project moved to a new folder. Its id is a hash of its path, so the
   * record is re-keyed; the old id is kept as an alias (in its own file, for
   * the same reason as the identity files) so links made before the move
   * still find the project. The database identity moves with it.
   */
  relocate(oldRoots: string[], newRoot: string): ProjectRecord {
    // The old folder is gone by now, so it can't be resolved to its real
    // path: match every spelling the caller knew (`/tmp` and `/private/tmp`).
    const oldCandidates = oldRoots.map((root) => path.resolve(root));
    const newNormalized = normalizeRoot(newRoot);
    const newId = deriveProjectId(newNormalized);
    const file = this.read();
    const index = file.projects.findIndex((record) =>
      oldCandidates.includes(record.rootPath)
      || oldCandidates.some((root) => record.projectId === deriveProjectId(root)),
    );
    const existing = index >= 0 ? file.projects[index]! : null;
    const oldId = existing?.projectId ?? deriveProjectId(oldCandidates[0]!);
    const next: ProjectRecord = {
      projectId: newId,
      rootPath: newNormalized,
      displayName: existing?.displayName ?? path.basename(newNormalized),
      addedAt: existing?.addedAt ?? Date.now(),
      lastOpenedAt: Date.now(),
      gitOriginUrl: existing?.gitOriginUrl ?? readGitOriginUrl(newNormalized),
      catalogVisibility: existing?.catalogVisibility ?? "recent",
      registrationSource: existing?.registrationSource ?? "desktop",
    };
    const projects = file.projects.filter(
      (record, i) => i !== index && record.projectId !== newId,
    );
    projects.splice(index >= 0 ? Math.min(index, projects.length) : projects.length, 0, next);
    this.write({ ...file, projects });
    this.forgetDatabaseIdentity(oldId);
    this.recordDatabaseIfPresent(newId, newNormalized);
    const aliases = this.readAliases();
    for (const [from, to] of Object.entries(aliases)) {
      if (to === oldId) aliases[from] = newId;
    }
    aliases[oldId] = newId;
    delete aliases[newId];
    fs.mkdirSync(path.dirname(this.aliasesPath()), { recursive: true });
    fs.writeFileSync(this.aliasesPath(), `${JSON.stringify(aliases, null, 2)}\n`);
    return next;
  }

  /** The current id of a project that was moved, given an id it had before. */
  resolveMovedProjectId(projectId: ProjectId): ProjectId | null {
    return this.readAliases()[projectId] ?? null;
  }

  private aliasesPath(): string {
    return path.join(this.layout.adeDir, "project-aliases.json");
  }

  private readAliases(): Record<ProjectId, ProjectId> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.aliasesPath(), "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    } catch {
      return {};
    }
  }

  /** Called after a successful open; a no-op until the database file exists. */
  recordDatabaseIdentity(projectId: ProjectId): void {
    const record = this.get(projectId);
    if (record) this.recordDatabaseIfPresent(projectId, record.rootPath);
  }

  /**
   * Whether a registered project's ADE data is gone: its whole `.ade` folder
   * (registering a project creates one, so even a record from before identity
   * files existed had it), or a database this machine recorded opening. A
   * project folder that is itself gone counts too: opening it would recreate
   * the folder with empty data.
   */
  isProjectDataMissing(record: ProjectRecord | null): boolean {
    if (!record) return false;
    const adeDir = path.join(record.rootPath, ".ade");
    return !fs.existsSync(adeDir)
      || (fs.existsSync(this.databaseIdentityPath(record.projectId)) && !fs.existsSync(path.join(adeDir, "ade.db")));
  }

  /** Check before creating directories or opening SQLite on any local entry point. */
  assertProjectDataAvailable(record: ProjectRecord | null): void {
    if (!record || !this.isProjectDataMissing(record)) return;
    const adeDir = path.join(record.rootPath, ".ade");
    throw codedError(
      fs.existsSync(record.rootPath)
        ? `ADE's data for this project is missing from ${adeDir}. Open the project in the ADE app to restore it or start fresh, or put the .ade folder back from the Trash. To start fresh from the command line instead, run \`ade projects remove ${record.projectId}\` and then \`ade projects add ${record.rootPath}\`. ADE has not created a replacement.`
        : `The project folder ${record.rootPath} isn't there. Plug its drive in or move it back; ADE has not created a replacement.`,
      "project_data_missing",
    );
  }

  private read(): ProjectRegistryFile {
    // Other processes (CLI, a second brain) rewrite this file by rename, so the
    // inode changes on every write; size and mtime cover in-place edits.
    let identity: string;
    try {
      const stat = fs.statSync(this.layout.projectsPath);
      identity = statIdentity(stat);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.readCache = null;
        return emptyFile();
      }
      throw error;
    }
    const now = Date.now();
    const cached = this.readCache;
    if (cached && cached.identity === identity && now - cached.at < REGISTRY_READ_CACHE_MS) {
      return cloneRegistryFile(cached.file);
    }
    const file = this.readUncached();
    this.readCache = { identity, at: now, file: cloneRegistryFile(file) };
    return file;
  }

  private readUncached(): ProjectRegistryFile {
    try {
      const raw = fs.readFileSync(this.layout.projectsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return emptyFile();
      const rawFile = parsed as {
        version?: unknown;
        projects?: unknown;
      };
      const isLegacy = rawFile.version === 1;
      if (!isLegacy && rawFile.version !== 2) {
        throw new Error(
          `Unsupported project registry version: ${String(rawFile.version)}`,
        );
      }
      const projects = Array.isArray(rawFile.projects)
        ? rawFile.projects
            .map((value) => {
              if (isLegacy) {
                const legacyRecord = value as Record<string, unknown>;
                const legacyRoot =
                  typeof legacyRecord?.rootPath === "string"
                    ? normalizeRoot(legacyRecord.rootPath)
                    : "";
                const matchesDesktopRecents =
                  legacyRoot.length > 0 &&
                  this.legacyRecentProjectRoots.has(legacyRoot);
                return coerceRecord(value, {
                  catalogVisibility:
                    matchesDesktopRecents || isExistingGitRoot(legacyRoot)
                      ? "recent"
                      : "system",
                  registrationSource: matchesDesktopRecents
                    ? "desktop"
                    : "runtime-auto",
                });
              }
              const record = value as Record<string, unknown>;
              return coerceRecord(value, {
                catalogVisibility:
                  record.catalogVisibility === "recent" ? "recent" : "system",
                registrationSource: isProjectRegistrationSource(
                  record.registrationSource,
                )
                  ? record.registrationSource
                  : "runtime-auto",
              });
            })
            .filter((entry): entry is ProjectRecord => entry != null)
        : [];
      const seen = new Set<string>();
      const file: ProjectRegistryFile = {
        version: 2,
        projects: projects.filter((project) => {
          if (seen.has(project.rootPath)) return false;
          seen.add(project.rootPath);
          return true;
        }),
      };
      if (isLegacy) this.write(file);
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyFile();
      throw error;
    }
  }

  private write(file: ProjectRegistryFile): void {
    this.readCache = null;
    fs.mkdirSync(this.layout.adeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(this.layout.projectsPath), {
      recursive: true,
      mode: 0o700,
    });
    const tempPath = `${this.layout.projectsPath}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${JSON.stringify({ version: 2, projects: file.projects }, null, 2)}\n`;
    fs.writeFileSync(tempPath, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, this.layout.projectsPath);
  }
}

export function assertLocalProjectDataAvailable(projectRoot: string): void {
  assertProjectNotMovedAway(projectRoot);
  assertProjectNotBeingMoved(projectRoot);
  const registry = new ProjectRegistry();
  registry.assertProjectDataAvailable(registry.findByRootPath(projectRoot));
}

/**
 * While a move copies a project, nothing may open it: a write after the copy
 * would be lost. The move's journal (`<ADE_HOME>/project-moves/`) names the
 * project and the process running the move.
 */
export function assertProjectNotBeingMoved(projectRoot: string): void {
  const dir = path.join(resolveMachineAdeDir(), "project-moves");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const root = path.resolve(projectRoot);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let record: { state?: unknown; sourceRoot?: unknown; destinationRoot?: unknown; pid?: unknown };
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as typeof record;
    } catch {
      continue;
    }
    if (record.state !== "running" || typeof record.pid !== "number") continue;
    if (record.sourceRoot !== root && record.destinationRoot !== root) continue;
    try {
      process.kill(record.pid, 0);
    } catch {
      continue; // the process that ran it is gone; the next ADE start settles it
    }
    throw codedError("This project is being moved. It opens again when the move finishes.", "project_moving");
  }
}

/** Written into a project's old folder when it moves (see projectMove/projectMoveEngine.ts). */
export const PROJECT_MOVED_MARKER = path.join(".ade", "moved-to.json");

/**
 * A project's old folder is kept after a move until the person deletes it.
 * Opening it would register a second copy of the project and let agents work
 * in the stale one, so every open refuses it and names the new location.
 */
export function assertProjectNotMovedAway(projectRoot: string): void {
  // Any folder inside the old copy counts too: its lanes live there, and a
  // lane folder opened on its own would otherwise slip past.
  let movedTo: string | null = null;
  let found = false;
  for (let dir = path.resolve(projectRoot); ; dir = path.dirname(dir)) {
    const marker = path.join(dir, PROJECT_MOVED_MARKER);
    if (fs.existsSync(marker)) {
      found = true;
      try {
        const parsed = JSON.parse(fs.readFileSync(marker, "utf8")) as { movedTo?: unknown };
        movedTo = typeof parsed.movedTo === "string" ? parsed.movedTo : null;
      } catch {
        movedTo = null;
      }
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  if (!found) return;
  throw codedError(
    movedTo
      ? `This is the old copy of a project that moved to ${movedTo}. Open it there. ADE keeps this copy only until you delete it.`
      : "This is the old copy of a project that was moved. Open the project at its new location.",
    "project_moved",
  );
}

export function isLocalProjectDataMissing(projectRoot: string): boolean {
  const registry = new ProjectRegistry();
  return registry.isProjectDataMissing(registry.findByRootPath(projectRoot));
}

export function readLocalProjectDatabaseIdentity(projectRoot: string): ProjectDatabaseIdentity | null {
  return new ProjectRegistry().readDatabaseIdentity(deriveProjectId(normalizeRoot(projectRoot)));
}

/** Let the next open of this project create new ADE data. */
export function forgetLocalProjectDatabaseIdentity(projectRoot: string): void {
  new ProjectRegistry().forgetDatabaseIdentity(deriveProjectId(normalizeRoot(projectRoot)));
}

/**
 * Remember that this machine opened the project's database, so a later open
 * that finds it missing asks for restoration. Desktop opens it in-process and
 * its brain mirror is best-effort, so it records this itself.
 */
export function recordLocalProjectDatabaseIdentity(
  projectRoot: string,
  logger?: { warn: (event: string, data: Record<string, unknown>) => void },
): void {
  try {
    const registry = new ProjectRegistry();
    const record = registry.findByRootPath(projectRoot);
    if (record) registry.recordDatabaseIdentity(record.projectId);
  } catch (error) {
    logger?.warn("project.database_identity_record_failed", {
      projectRoot,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
