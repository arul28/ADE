import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectDetail, ProjectLanguageShare, ProjectLastCommit, RecentProjectSummary } from "../../../shared/types";
import { runGit } from "../git/git";
import { readGlobalState } from "../state/globalState";
import { toRecentProjectSummary } from "./recentProjectSummary";

const README_CANDIDATES = ["README.md", "readme.md", "Readme.md", "README", "readme"];
const README_EXCERPT_CHARS = 1600;
const LANGUAGE_SCAN_FILE_CAP = 2000;
const LANGUAGE_SCAN_DEPTH = 2;

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  rb: "Ruby",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  m: "Objective-C",
  mm: "Objective-C++",
  c: "C",
  h: "C",
  hpp: "C++",
  cc: "C++",
  cpp: "C++",
  cs: "C#",
  php: "PHP",
  lua: "Lua",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  fish: "Shell",
  ps1: "PowerShell",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
  json: "JSON",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  md: "Markdown",
  mdx: "Markdown",
};

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".ade",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "__pycache__",
  ".cache",
  "coverage",
]);

function parseLastCommitLine(raw: string): ProjectLastCommit | null {
  const line = raw.trim();
  if (!line) return null;
  const parts = line.split("\u001f");
  if (parts.length < 3) return null;
  const [subject, isoDate, shortSha] = parts;
  if (!subject || !isoDate || !shortSha) return null;
  return { subject, isoDate, shortSha };
}

function parseAheadBehind(raw: string): { ahead: number; behind: number } | null {
  const line = raw.trim();
  if (!line) return null;
  const [behindStr, aheadStr] = line.split(/\s+/);
  const behind = Number.parseInt(behindStr ?? "", 10);
  const ahead = Number.parseInt(aheadStr ?? "", 10);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
  return { ahead, behind };
}

async function readReadmeExcerpt(rootPath: string): Promise<string | null> {
  for (const candidate of README_CANDIDATES) {
    try {
      const filePath = path.join(rootPath, candidate);
      const handle = await fs.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(README_EXCERPT_CHARS * 2);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const raw = buffer.slice(0, bytesRead).toString("utf8");
        const cleaned = raw.replace(/^(\s*<!--[\s\S]*?-->\s*)+/, "").trim();
        if (!cleaned) return null;
        if (cleaned.length <= README_EXCERPT_CHARS) return cleaned;
        const truncated = cleaned.slice(0, README_EXCERPT_CHARS);
        const lastBreak = Math.max(truncated.lastIndexOf("\n\n"), truncated.lastIndexOf(". "));
        const boundary = lastBreak > README_EXCERPT_CHARS * 0.6 ? lastBreak : truncated.length;
        return `${truncated.slice(0, boundary).trimEnd()}\n\n_…continues_`;
      } finally {
        await handle.close();
      }
    } catch {
      // keep trying the next candidate
    }
  }
  return null;
}

async function countFilesByLanguage(rootPath: string): Promise<ProjectLanguageShare[]> {
  const counts = new Map<string, number>();
  let totalRecognized = 0;
  let filesVisited = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (filesVisited >= LANGUAGE_SCAN_FILE_CAP) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (filesVisited >= LANGUAGE_SCAN_FILE_CAP) return;
      if (dirent.name.startsWith(".") && dirent.name !== ".github") {
        continue;
      }
      if (dirent.isDirectory()) {
        if (EXCLUDED_DIRS.has(dirent.name)) continue;
        if (depth >= LANGUAGE_SCAN_DEPTH) continue;
        await walk(path.join(dir, dirent.name), depth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;
      filesVisited += 1;
      const dotIndex = dirent.name.lastIndexOf(".");
      if (dotIndex <= 0) continue;
      const ext = dirent.name.slice(dotIndex + 1).toLowerCase();
      const language = EXTENSION_TO_LANGUAGE[ext];
      if (!language) continue;
      counts.set(language, (counts.get(language) ?? 0) + 1);
      totalRecognized += 1;
    }
  };

  await walk(rootPath, 0);

  if (totalRecognized === 0) return [];
  return [...counts.entries()]
    .map(([name, count]) => ({ name, fraction: count / totalRecognized }))
    .sort((a, b) => b.fraction - a.fraction)
    .slice(0, 4);
}

async function countSubdirectories(rootPath: string): Promise<number | null> {
  try {
    const dirents = await fs.readdir(rootPath, { withFileTypes: true });
    return dirents.filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith(".")).length;
  } catch {
    return null;
  }
}

async function isGitRepo(rootPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(rootPath, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

async function readGitMetadata(rootPath: string): Promise<Pick<ProjectDetail, "branchName" | "dirtyCount" | "lastCommit" | "aheadBehind">> {
  const [branchRes, dirtyRes, lastCommitRes, aheadBehindRes] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: rootPath, timeoutMs: 5_000 }),
    runGit(["status", "--porcelain"], { cwd: rootPath, timeoutMs: 8_000 }),
    runGit(["log", "-1", "--format=%s%x1f%cI%x1f%h"], { cwd: rootPath, timeoutMs: 6_000 }),
    runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"], { cwd: rootPath, timeoutMs: 6_000 }),
  ]);

  const branchName = branchRes.exitCode === 0 ? branchRes.stdout.trim() || null : null;
  const dirtyCount = dirtyRes.exitCode === 0
    ? dirtyRes.stdout.split("\n").filter((line) => line.trim().length > 0).length
    : null;
  const lastCommit = lastCommitRes.exitCode === 0 ? parseLastCommitLine(lastCommitRes.stdout) : null;
  const aheadBehind = aheadBehindRes.exitCode === 0 ? parseAheadBehind(aheadBehindRes.stdout) : null;

  return { branchName, dirtyCount, lastCommit, aheadBehind };
}

export type GetProjectDetailOptions = {
  globalStatePath?: string | null;
};

async function resolveProjectDetailScanRoot(rootPath: string): Promise<{
  requestedRoot: string;
  scanRoot: string;
}> {
  const requestedRoot = path.resolve(rootPath);
  let scanRoot: string;
  try {
    scanRoot = await fs.realpath(requestedRoot);
  } catch {
    throw new Error(`Project detail requires an existing directory: ${requestedRoot}`);
  }

  let stat;
  try {
    stat = await fs.stat(scanRoot);
  } catch {
    throw new Error(`Project detail requires an existing directory: ${requestedRoot}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Project detail requires an existing directory: ${requestedRoot}`);
  }

  return { requestedRoot, scanRoot };
}

function lookupRecentProjectEntry(globalStatePath: string | null | undefined, rootPath: string): RecentProjectSummary | null {
  if (!globalStatePath) return null;
  try {
    const state = readGlobalState(globalStatePath);
    const entry = (state.recentProjects ?? []).find((rp) => rp.rootPath === rootPath);
    return entry ? toRecentProjectSummary(entry) : null;
  } catch {
    return null;
  }
}

export async function getProjectDetail(rootPath: string, options: GetProjectDetailOptions = {}): Promise<ProjectDetail> {
  const { requestedRoot, scanRoot } = await resolveProjectDetailScanRoot(rootPath);
  const [gitRepo, readmeExcerpt, languages, subdirectoryCount] = await Promise.all([
    isGitRepo(scanRoot),
    readReadmeExcerpt(scanRoot),
    countFilesByLanguage(scanRoot),
    countSubdirectories(scanRoot),
  ]);

  const gitMeta = gitRepo
    ? await readGitMetadata(scanRoot)
    : { branchName: null, dirtyCount: null, lastCommit: null, aheadBehind: null };

  const recent = lookupRecentProjectEntry(options.globalStatePath ?? null, requestedRoot);

  return {
    rootPath: requestedRoot,
    isGitRepo: gitRepo,
    branchName: gitMeta.branchName,
    dirtyCount: gitMeta.dirtyCount,
    aheadBehind: gitMeta.aheadBehind,
    lastCommit: gitMeta.lastCommit,
    readmeExcerpt,
    languages,
    laneCount: recent?.laneCount ?? null,
    lastOpenedAt: recent?.lastOpenedAt ?? null,
    subdirectoryCount,
  };
}

export const __internal = {
  parseLastCommitLine,
  parseAheadBehind,
};
