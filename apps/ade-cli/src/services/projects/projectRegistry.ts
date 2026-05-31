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

export type ProjectRecord = {
  projectId: ProjectId;
  rootPath: string;
  displayName: string;
  addedAt: number;
  lastOpenedAt: number;
  gitOriginUrl: string | null;
};

type ProjectRegistryFile = {
  version: 1;
  projects: ProjectRecord[];
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
  return { version: 1, projects: [] };
}

function coerceRecord(value: unknown): ProjectRecord | null {
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
  };
}

export class ProjectRegistry {
  private readonly layout: MachineAdeLayout;

  constructor(layout: MachineAdeLayout = resolveMachineAdeLayout()) {
    this.layout = layout;
  }

  get path(): string {
    return this.layout.projectsPath;
  }

  list(): ProjectRecord[] {
    return this.read().projects;
  }

  get(projectId: ProjectId): ProjectRecord | null {
    return this.list().find((record) => record.projectId === projectId) ?? null;
  }

  findByRootPath(rootPath: string): ProjectRecord | null {
    const normalized = normalizeRoot(rootPath);
    return this.list().find((record) => record.rootPath === normalized) ?? null;
  }

  add(rootPath: string): ProjectRecord {
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
    };
    if (existingIndex >= 0) {
      file.projects[existingIndex] = next;
    } else {
      file.projects.push(next);
    }
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
      const projects = Array.isArray(
        (parsed as { projects?: unknown }).projects,
      )
        ? (parsed as { projects: unknown[] }).projects
            .map(coerceRecord)
            .filter((entry): entry is ProjectRecord => entry != null)
        : [];
      const seen = new Set<string>();
      return {
        version: 1,
        projects: projects.filter((project) => {
          if (seen.has(project.rootPath)) return false;
          seen.add(project.rootPath);
          return true;
        }),
      };
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
    const payload = `${JSON.stringify({ version: 1, projects: file.projects }, null, 2)}\n`;
    fs.writeFileSync(tempPath, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, this.layout.projectsPath);
  }
}
