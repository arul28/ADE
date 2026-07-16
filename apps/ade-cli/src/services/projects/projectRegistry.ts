import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveMachineAdeLayout,
  type MachineAdeLayout,
} from "./machineLayout";
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
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length ? value : null;
}

function ensureProjectAdeDir(rootPath: string): void {
  fs.mkdirSync(path.join(rootPath, ".ade"), { recursive: true });
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

    ensureProjectAdeDir(normalized);

    const file = this.read();
    const now = Date.now();
    const projectId = deriveProjectId(normalized);
    const existingIndex = file.projects.findIndex(
      (record) =>
        record.projectId === projectId || record.rootPath === normalized,
    );
    const existing = existingIndex >= 0 ? file.projects[existingIndex] : null;
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
    file.projects[index] = next;
    this.write(file);
    return next;
  }

  private read(): ProjectRegistryFile {
    try {
      const raw = fs.readFileSync(this.layout.projectsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return emptyFile();
      const rawFile = parsed as {
        version?: unknown;
        projects?: unknown;
      };
      const isLegacy = rawFile.version !== 2;
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
