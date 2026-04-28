import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectBrowseEntry, ProjectBrowseInput, ProjectBrowseResult } from "../../../shared/types";
import { resolveRepoRoot } from "./projectService";

function expandHomePath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function isExplicitRelativePath(input: string): boolean {
  return input === "." || input === ".." || input.startsWith("./") || input.startsWith(".\\") || input.startsWith("../") || input.startsWith("..\\");
}

function isWindowsAbsolutePath(input: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith("\\\\");
}

function parentPathOf(input: string): string | null {
  const parent = path.dirname(input);
  return parent === input ? null : parent;
}

async function resolveOpenableProjectRoot(candidatePath: string | null): Promise<string | null> {
  if (!candidatePath) return null;
  try {
    return path.resolve(await resolveRepoRoot(candidatePath));
  } catch {
    return null;
  }
}

async function isGitRepoAt(candidatePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(candidatePath, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function browseProjectDirectories(args: ProjectBrowseInput = {}): Promise<ProjectBrowseResult> {
  const cwd = typeof args.cwd === "string" && args.cwd.trim().length > 0 ? args.cwd.trim() : null;
  const limit = Number.isFinite(args.limit) && (args.limit ?? 0) > 0 ? Math.min(args.limit ?? 200, 500) : 200;
  const rawInput = typeof args.partialPath === "string" && args.partialPath.trim().length > 0
    ? args.partialPath.trim()
    : cwd ?? "~/";

  if (process.platform !== "win32" && isWindowsAbsolutePath(rawInput)) {
    throw new Error("Windows-style paths are only supported on Windows.");
  }

  if (isExplicitRelativePath(rawInput) && !cwd) {
    throw new Error("Relative paths require an active project.");
  }

  const resolvedPath = isExplicitRelativePath(rawInput)
    ? path.resolve(expandHomePath(cwd!), rawInput)
    : path.resolve(expandHomePath(rawInput));
  const treatAsDirectory = /[\\/]$/.test(rawInput) || rawInput === "~";

  let exactDirectoryPath: string | null = null;
  let directoryPath = resolvedPath;
  let prefix = "";

  try {
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      exactDirectoryPath = resolvedPath;
      directoryPath = resolvedPath;
    } else {
      directoryPath = path.dirname(resolvedPath);
      prefix = path.basename(resolvedPath);
    }
  } catch {
    if (treatAsDirectory) {
      directoryPath = resolvedPath;
    } else {
      directoryPath = path.dirname(resolvedPath);
      prefix = path.basename(resolvedPath);
    }
  }

  const showHidden = exactDirectoryPath !== null || prefix.startsWith(".");
  const normalizedPrefix = prefix.toLowerCase();
  let entries: ProjectBrowseEntry[] = [];

  try {
    const dirents = await fs.readdir(directoryPath, { withFileTypes: true });
    const candidates = dirents
      .filter((dirent) => dirent.isDirectory())
      .filter((dirent) => showHidden || !dirent.name.startsWith("."))
      .filter((dirent) => dirent.name.toLowerCase().startsWith(normalizedPrefix))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, limit)
      .map((dirent) => ({
        name: dirent.name,
        fullPath: path.join(directoryPath, dirent.name),
      }));
    const gitFlags = await mapWithConcurrency(candidates, 16, (candidate) => isGitRepoAt(candidate.fullPath));
    entries = candidates.map((candidate, index) => ({
      ...candidate,
      isGitRepo: gitFlags[index] ?? false,
    }));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw error;
    }
  }

  return {
    inputPath: rawInput,
    resolvedPath,
    directoryPath,
    parentPath: parentPathOf(directoryPath),
    exactDirectoryPath,
    openableProjectRoot: await resolveOpenableProjectRoot(exactDirectoryPath),
    entries,
  };
}
