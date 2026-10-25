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
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import { findMoveInProgress, readMovedMarker, type MovedMarker } from "./projectMove/moveJournal";
import { statIdentity } from "./fileIdentity";
import { normalizeProjectRootPath } from "./projectRoots";
import { ExclusiveFileLockTimeoutError, withExclusiveFileLockSync } from "../../lib/exclusiveFileLock";
import { addSentryBreadcrumb, captureProblem } from "../../../../desktop/src/shared/sentry/capture";
import {
  DIAGNOSTIC_ATTACH_TAG,
  diagnosticEventText,
  type DiagnosticEvent,
} from "../../../../desktop/src/shared/sentry/diagnostics";
import { forwardLogToSentry } from "../../../../desktop/src/shared/sentry/logBridge";

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
    let stat: fs.Stats;
    try {
      stat = fs.statSync(normalized);
    } catch (error) {
      // A recent project whose folder was moved or deleted since.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Project folder not found: ${normalized}. It may have been moved or deleted.`);
      }
      throw error;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Project root is not a directory: ${normalized}`);
    }

    assertProjectNotMovedAway(normalized);
    const projectId = deriveProjectId(normalized);
    const matches = (record: ProjectRecord) =>
      record.projectId === projectId || record.rootPath === normalized;
    // Checked before `.ade` is created below, which would hide missing data.
    const known = this.read().projects.find(matches) ?? null;
    this.assertProjectDataAvailable(known);
    ensureProjectAdeDir(normalized);
    this.recordDatabaseIfPresent(projectId, normalized);
    // Outside the lock: it starts git, which can take seconds.
    const gitOriginUrl = known?.gitOriginUrl ?? readGitOriginUrl(normalized);
    return this.mutate("add", { projectId, rootPath: normalized }, (file) => {
      const now = Date.now();
      const existingIndex = file.projects.findIndex(matches);
      const existing = existingIndex >= 0 ? file.projects[existingIndex] : null;
      const next: ProjectRecord = {
        projectId,
        rootPath: normalized,
        displayName: existing?.displayName ?? path.basename(normalized),
        addedAt: existing?.addedAt ?? now,
        lastOpenedAt: now,
        gitOriginUrl: existing?.gitOriginUrl ?? gitOriginUrl,
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
      return { file, result: next };
    });
  }

  setCatalogVisibilityByRootPath(
    rootPath: string,
    catalogVisibility: ProjectCatalogVisibility,
    registrationSource: ProjectRegistrationSource,
  ): ProjectRecord | null {
    const normalized = normalizeRoot(rootPath);
    const current = this.read().projects.find((record) => record.rootPath === normalized);
    if (!current) return null;
    if (
      current.catalogVisibility === catalogVisibility &&
      current.registrationSource === registrationSource
    ) {
      return current;
    }
    return this.mutate("set_visibility", { rootPath: normalized, catalogVisibility }, (file) => {
      const index = file.projects.findIndex((record) => record.rootPath === normalized);
      if (index < 0) return { file: null, result: null };
      const next: ProjectRecord = {
        ...file.projects[index]!,
        catalogVisibility,
        registrationSource,
      };
      file.projects[index] = next;
      return { file, result: next };
    });
  }

  remove(projectId: ProjectId): boolean {
    const removed = this.mutate("remove", { projectId }, (file) => {
      const projects = file.projects.filter((record) => record.projectId !== projectId);
      if (projects.length === file.projects.length) return { file: null, result: false };
      return { file: { ...file, projects }, result: true };
    });
    if (removed) this.forgetDatabaseIdentity(projectId);
    return removed;
  }

  touch(projectId: ProjectId): ProjectRecord {
    const next = this.mutate("touch", { projectId }, (file) => {
      const index = file.projects.findIndex((record) => record.projectId === projectId);
      if (index < 0) throw new Error(`Unknown projectId: ${projectId}`);
      const touched: ProjectRecord = { ...file.projects[index]!, lastOpenedAt: Date.now() };
      file.projects[index] = touched;
      return { file, result: touched };
    });
    this.recordDatabaseIfPresent(projectId, next.rootPath);
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
    const oldCandidateIds = oldCandidates.map((root) => deriveProjectId(root));
    const isOld = (record: ProjectRecord) =>
      oldCandidates.includes(record.rootPath) || oldCandidateIds.includes(record.projectId);
    // Outside the lock: it starts git, which can take seconds.
    const knownOrigin = this.read().projects.find(isOld)?.gitOriginUrl ?? readGitOriginUrl(newNormalized);
    const { next, oldId } = this.mutate("relocate", { projectId: newId, rootPath: newNormalized }, (file) => {
      const index = file.projects.findIndex(isOld);
      const existing = index >= 0 ? file.projects[index]! : null;
      const relocated: ProjectRecord = {
        projectId: newId,
        rootPath: newNormalized,
        displayName: existing?.displayName ?? path.basename(newNormalized),
        addedAt: existing?.addedAt ?? Date.now(),
        lastOpenedAt: Date.now(),
        gitOriginUrl: existing?.gitOriginUrl ?? knownOrigin,
        catalogVisibility: existing?.catalogVisibility ?? "recent",
        registrationSource: existing?.registrationSource ?? "desktop",
      };
      const projects = file.projects.filter(
        (record, i) => i !== index && record.projectId !== newId,
      );
      projects.splice(index >= 0 ? Math.min(index, projects.length) : projects.length, 0, relocated);
      return {
        file: { ...file, projects },
        result: { next: relocated, oldId: existing?.projectId ?? oldCandidateIds[0]! },
      };
    });
    this.forgetDatabaseIdentity(oldId);
    this.recordDatabaseIfPresent(newId, newNormalized);
    const aliases = this.readAliases();
    for (const [from, to] of Object.entries(aliases)) {
      if (to === oldId) aliases[from] = newId;
    }
    aliases[oldId] = newId;
    delete aliases[newId];
    fs.mkdirSync(path.dirname(this.aliasesPath()), { recursive: true });
    writeFileAtomic(this.aliasesPath(), `${JSON.stringify(aliases, null, 2)}\n`);
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
    const { file, isLegacy } = this.readFromDisk();
    if (isLegacy) return this.mutate("migrate_v1", {}, (fresh) => ({ file: fresh, result: fresh }));
    return file;
  }

  /**
   * Parse `projects.json`. A record's id is not trusted from the file: it is
   * the hash of the folder as this machine resolves it now. When that differs
   * from the id the file stored, the project's id just changed under every
   * window and phone that holds the old one, which answers "Unknown
   * projectId" from then on. That is reported, and the old id is kept as an
   * alias so the brain still finds the project by it.
   */
  private readFromDisk(): { file: ProjectRegistryFile; isLegacy: boolean } {
    try {
      const raw = fs.readFileSync(this.layout.projectsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return { file: emptyFile(), isLegacy: false };
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
      const changedIds: Array<{ storedId: string; projectId: string; storedRoot: string; rootPath: string }> = [];
      const dropped: Array<{ storedId: string | null; storedRoot: string | null; reason: string }> = [];
      const projects = Array.isArray(rawFile.projects)
        ? rawFile.projects
            .map((value) => {
              let record: ProjectRecord | null;
              if (isLegacy) {
                const legacyRecord = value as Record<string, unknown>;
                const legacyRoot =
                  typeof legacyRecord?.rootPath === "string"
                    ? normalizeRoot(legacyRecord.rootPath)
                    : "";
                const matchesDesktopRecents =
                  legacyRoot.length > 0 &&
                  this.legacyRecentProjectRoots.has(legacyRoot);
                record = coerceRecord(value, {
                  catalogVisibility:
                    matchesDesktopRecents || isExistingGitRoot(legacyRoot)
                      ? "recent"
                      : "system",
                  registrationSource: matchesDesktopRecents
                    ? "desktop"
                    : "runtime-auto",
                });
              } else {
                const stored = value as Record<string, unknown>;
                record = coerceRecord(value, {
                  catalogVisibility:
                    stored?.catalogVisibility === "recent" ? "recent" : "system",
                  registrationSource: isProjectRegistrationSource(
                    stored?.registrationSource,
                  )
                    ? stored.registrationSource
                    : "runtime-auto",
                });
              }
              const stored = value as { projectId?: unknown; rootPath?: unknown } | null;
              const storedId = typeof stored?.projectId === "string" ? stored.projectId : null;
              const storedRoot = typeof stored?.rootPath === "string" ? stored.rootPath : null;
              if (!record) {
                dropped.push({ storedId, storedRoot, reason: storedRoot ? "disallowed_or_unresolvable_root" : "no_root" });
              } else if (storedId && storedId !== record.projectId) {
                changedIds.push({ storedId, projectId: record.projectId, storedRoot: storedRoot ?? "", rootPath: record.rootPath });
              }
              return record;
            })
            .filter((entry): entry is ProjectRecord => entry != null)
        : [];
      const seen = new Set<string>();
      const file: ProjectRegistryFile = {
        version: 2,
        projects: projects.filter((project) => {
          if (seen.has(project.rootPath)) {
            dropped.push({ storedId: project.projectId, storedRoot: project.rootPath, reason: "duplicate_root" });
            return false;
          }
          seen.add(project.rootPath);
          return true;
        }),
      };
      if (changedIds.length > 0) this.noteChangedProjectIds(changedIds);
      if (dropped.length > 0) noteDroppedRecords(this.layout.projectsPath, this.journalPath(), dropped);
      return { file, isLegacy };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { file: emptyFile(), isLegacy: false };
      throw error;
    }
  }

  /** Report each id change once per process, and keep the old id working as an alias. */
  private noteChangedProjectIds(
    changes: Array<{ storedId: string; projectId: string; storedRoot: string; rootPath: string }>,
  ): void {
    const aliases = this.readAliases();
    let aliasesChanged = false;
    for (const change of changes) {
      const key = `${change.storedId}>${change.projectId}`;
      if (!reportedIdChanges.has(key)) {
        reportedIdChanges.add(key);
        const detail = { ...change, writer: describeRegistryWriter(), registryPath: this.layout.projectsPath };
        forwardLogToSentry("warn", "project_registry.project_id_changed", detail);
        appendJournalLine(this.journalPath(), { op: "id_changed", ...change });
        captureProblem("A registered project's id changed when its folder was resolved again", {
          fingerprint: ["project_registry", "project_id_changed"],
          tags: { [DIAGNOSTIC_ATTACH_TAG]: "project_registry" },
          extra: detail,
        });
      }
      // The same edge rule `relocate` keeps: the new id never has an alias of
      // its own, so a folder that flips back and forth cannot make a cycle.
      if (aliases[change.storedId] !== change.projectId) {
        aliases[change.storedId] = change.projectId;
        aliasesChanged = true;
      }
      if (aliases[change.projectId] !== undefined) {
        delete aliases[change.projectId];
        aliasesChanged = true;
      }
    }
    if (!aliasesChanged) return;
    try {
      fs.mkdirSync(path.dirname(this.aliasesPath()), { recursive: true });
      writeFileAtomic(this.aliasesPath(), `${JSON.stringify(aliases, null, 2)}\n`);
    } catch {
      // The alias is a convenience; the report above is the record.
    }
  }

  private lockPath(): string {
    return `${this.layout.projectsPath}.lock`;
  }

  journalPath(): string {
    return path.join(path.dirname(this.layout.projectsPath), "projects.journal.jsonl");
  }

  /**
   * Every change to `projects.json` goes through here. The desktop app, the
   * brain, the `ade` CLI and a project move all write the file, and each
   * write is a read, a change and a rename. Without a lock, two writers that
   * overlap each keep their own copy, and the second rename erases what the
   * first one added. The lock spans the fresh read and the write only, never
   * git or other slow work. The journal records who changed what.
   */
  private mutate<T>(
    op: string,
    detail: Record<string, unknown>,
    change: (file: ProjectRegistryFile) => { file: ProjectRegistryFile | null; result: T },
  ): T {
    const lockPath = this.lockPath();
    const run = (lockWaitMs: number | null) => {
      const before = this.readFromDisk().file;
      const { file, result } = change(cloneRegistryFile(before));
      if (file) {
        this.write(file);
        appendRegistryJournal(this.journalPath(), op, detail, before, file, lockWaitMs);
      }
      return result;
    };
    // A write inside a write in this process (the v1 upgrade during a read
    // under `mutate`) already holds the lock.
    if (heldRegistryLocks.has(lockPath)) return run(0);
    const startedAt = Date.now();
    try {
      return withExclusiveFileLockSync(lockPath, () => {
        heldRegistryLocks.add(lockPath);
        try {
          return run(Date.now() - startedAt);
        } finally {
          heldRegistryLocks.delete(lockPath);
        }
      }, { waitMs: REGISTRY_LOCK_WAIT_MS, label: "the ADE project list" });
    } catch (error) {
      if (!(error instanceof ExclusiveFileLockTimeoutError)) throw error;
      // A holder that never lets go must not stop ADE from opening projects:
      // write without the lock, as every ADE before this one did, and say so.
      forwardLogToSentry("warn", "project_registry.lock_timeout", { op, lockPath, waitedMs: Date.now() - startedAt });
      return run(null);
    }
  }

  private write(file: ProjectRegistryFile): void {
    this.readCache = null;
    fs.mkdirSync(this.layout.adeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(this.layout.projectsPath), {
      recursive: true,
      mode: 0o700,
    });
    const payload = `${JSON.stringify({ version: 2, projects: file.projects }, null, 2)}\n`;
    // `writeFileAtomic` also gets past Windows refusing a rename over a file
    // another process has open (EPERM, EBUSY), which a plain rename does not.
    writeFileAtomic(this.layout.projectsPath, payload, { mode: 0o600 });
  }

  /**
   * The project list as it is now and the newest journal lines, for an error
   * report about a project the brain could not find.
   */
  diagnosticFile(): { filename: string; data: string } | null {
    const read = (filePath: string) => {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch (error) {
        return `[${(error as NodeJS.ErrnoException).code ?? "unreadable"}]`;
      }
    };
    const journal = read(this.journalPath());
    return {
      filename: "project-registry.txt",
      data: [
        `# ${this.layout.projectsPath}`,
        read(this.layout.projectsPath),
        `# ${this.aliasesPath()}`,
        read(this.aliasesPath()),
        `# ${this.journalPath()} (newest last)`,
        journal.length > REGISTRY_JOURNAL_REPORT_CHARS ? journal.slice(-REGISTRY_JOURNAL_REPORT_CHARS) : journal,
      ].join("\n"),
    };
  }
}

/**
 * The project list file for a report that is about it: one the registry or
 * the brain tagged, or any error that names an unknown project id (the
 * desktop's copy of the brain's answer). Every other report goes without it.
 */
export function projectRegistryDiagnosticAttachment(
  registry: ProjectRegistry,
): (event: DiagnosticEvent) => { filename: string; data: string } | null {
  return (event) => {
    const asked = event.tags?.[DIAGNOSTIC_ATTACH_TAG] === "project_registry";
    if (!asked && !/Unknown projectId/.test(diagnosticEventText(event))) return null;
    return registry.diagnosticFile();
  };
}

const REGISTRY_LOCK_WAIT_MS = 2_000;
const REGISTRY_JOURNAL_MAX_BYTES = 512 * 1024;
const REGISTRY_JOURNAL_REPORT_CHARS = 64 * 1024;
const heldRegistryLocks = new Set<string>();
const reportedIdChanges = new Set<string>();
const reportedDrops = new Set<string>();

/** Which program wrote: the desktop app, the brain, or an `ade` command. */
function describeRegistryWriter(): string {
  if ((process as { type?: string }).type === "browser") return "desktop-main";
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  if (args[0] === "serve") return "brain";
  return args.length > 0 ? `cli ${args.slice(0, 2).join(" ")}` : path.basename(process.argv[1] ?? process.argv0 ?? "node");
}

function noteDroppedRecords(
  registryPath: string,
  journalPath: string,
  dropped: Array<{ storedId: string | null; storedRoot: string | null; reason: string }>,
): void {
  for (const record of dropped) {
    const key = `${record.storedId ?? ""}|${record.storedRoot ?? ""}|${record.reason}`;
    if (reportedDrops.has(key)) continue;
    reportedDrops.add(key);
    // A record the next write will not keep: the project disappears for every
    // window that knew it. A breadcrumb and a log line, not an issue, since a
    // duplicate is often the same folder registered twice on purpose.
    forwardLogToSentry("warn", "project_registry.record_dropped", { ...record, registryPath, writer: describeRegistryWriter() });
    appendJournalLine(journalPath, { op: "record_dropped", ...record });
  }
}

function recordSummary(records: ProjectRecord[], ids: Set<string>): Array<{ projectId: string; rootPath: string }> {
  return records
    .filter((record) => ids.has(record.projectId))
    .map((record) => ({ projectId: record.projectId, rootPath: record.rootPath }));
}

/**
 * One line per write: who, what, and which ids came or went. Read by
 * `diagnosticFile` and by a person debugging a project that vanished. Kept to
 * the newest half once it passes 512 KB.
 */
function appendRegistryJournal(
  journalPath: string,
  op: string,
  detail: Record<string, unknown>,
  before: ProjectRegistryFile,
  after: ProjectRegistryFile,
  lockWaitMs: number | null,
): void {
  try {
    const beforeIds = new Set(before.projects.map((record) => record.projectId));
    const afterIds = new Set(after.projects.map((record) => record.projectId));
    const added = new Set([...afterIds].filter((id) => !beforeIds.has(id)));
    const removed = new Set([...beforeIds].filter((id) => !afterIds.has(id)));
    if (removed.size > 0) {
      addSentryBreadcrumb("project_registry", `project_registry.${op}`, { removed: [...removed], writer: describeRegistryWriter() }, "warning");
    }
    appendJournalLine(journalPath, {
      op,
      ...detail,
      count: { before: beforeIds.size, after: afterIds.size },
      ...(added.size > 0 ? { added: recordSummary(after.projects, added) } : {}),
      ...(removed.size > 0 ? { removed: recordSummary(before.projects, removed) } : {}),
      lockWaitMs,
    });
  } catch {
    // The journal is diagnostics; a failed append must not fail the write.
  }
}

function appendJournalLine(journalPath: string, entry: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, writer: describeRegistryWriter(), ...entry });
    fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(journalPath, `${line}\n`, { mode: 0o600 });
    const size = fs.statSync(journalPath).size;
    if (size > REGISTRY_JOURNAL_MAX_BYTES) {
      const text = fs.readFileSync(journalPath, "utf8");
      const keep = text.slice(text.length - Math.floor(REGISTRY_JOURNAL_MAX_BYTES / 2));
      writeFileAtomic(journalPath, keep.slice(keep.indexOf("\n") + 1), { mode: 0o600 });
    }
  } catch {
    // The journal is diagnostics only.
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
  // A move whose process is gone is settled by the next ADE start instead.
  if (!findMoveInProgress(path.resolve(projectRoot))) return;
  throw codedError("This project is being moved. It opens again when the move finishes.", "project_moving");
}

/**
 * A project's old folder is kept after a move until the person deletes it.
 * Opening it would register a second copy of the project and let agents work
 * in the stale one, so every open refuses it and names the new location.
 */
export function assertProjectNotMovedAway(projectRoot: string): void {
  // Any folder inside the old copy counts too: its lanes live there, and a
  // lane folder opened on its own would otherwise slip past.
  let marker: MovedMarker | null = null;
  for (let dir = path.resolve(projectRoot); !marker; dir = path.dirname(dir)) {
    marker = readMovedMarker(dir);
    if (path.dirname(dir) === dir) break;
  }
  if (!marker) return;
  const { movedTo } = marker;
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
