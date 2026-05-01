import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { ProjectIcon } from "../../../shared/types";
import { resolvePathWithinRoot } from "../shared/utils";

const ICON_MAX_BYTES = 1024 * 1024;
const SUPPORTED_ICON_EXTENSIONS = new Set([".svg", ".ico", ".png", ".jpg", ".jpeg", ".webp"]);

const IGNORED_ICON_DIRS = new Set([
  ".ade",
  ".git",
  ".next",
  ".open-next",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const ICON_BASE_CANDIDATES = [
  ".",
  "app",
  "src",
  "src/app",
  "public",
  "assets",
  "build",
] as const;

const ICON_FILE_CANDIDATES = [
  "macIcon.png",
  "macicon.png",
  "app-icon.png",
  "app-icon.svg",
  "app-icon.webp",
  "icon.png",
  "icon.svg",
  "icon.ico",
  "icon.webp",
  "logo.png",
  "logo.svg",
  "logo.webp",
  "favicon.png",
  "favicon.svg",
  "favicon.ico",
] as const;

const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

type ProjectIconOverride = string | null | undefined;

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  const objMatch = source.match(LINK_ICON_OBJ_RE);
  if (objMatch?.[1]) return objMatch[1];
  return null;
}

function isLocalIconHref(href: string): boolean {
  return !/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(href)
    && !href.startsWith("data:")
    && !href.startsWith("#");
}

function findExistingFile(projectRoot: string, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    // resolvePathWithinRoot follows symlinks via fs.realpath, so a `public ->
    // /etc` symlink in the checked-out repo can't trick us into stat'ing or
    // reading outside the project root. Treat any failure (escape, missing
    // file, ENOENT, etc.) as "no icon" and keep probing.
    let resolved: string;
    try {
      resolved = resolvePathWithinRoot(projectRoot, candidate, { allowMissing: false });
    } catch {
      continue;
    }
    try {
      const stat = fs.statSync(resolved);
      if (stat.isFile()) return resolved;
    } catch {
      // Keep probing other candidates.
    }
  }
  return null;
}

function resolveIconHref(projectRoot: string, href: string): string[] {
  const clean = href.replace(/^\//, "");
  return [path.join(projectRoot, "public", clean), path.join(projectRoot, clean)];
}

function isSupportedIconPath(filePath: string): boolean {
  return SUPPORTED_ICON_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function toProjectRelative(projectRoot: string, filePath: string): string {
  const relative = path.relative(projectRoot, filePath).split(path.sep).join("/");
  return relative || ".";
}

function readProjectIconOverride(projectRoot: string): ProjectIconOverride {
  let filePath: string;
  try {
    filePath = resolvePathWithinRoot(projectRoot, ".ade/ade.yaml", { allowMissing: false });
  } catch {
    return undefined;
  }
  try {
    const parsed = YAML.parse(fs.readFileSync(filePath, "utf8"));
    const project = parsed?.project;
    if (!project || typeof project !== "object" || !Object.prototype.hasOwnProperty.call(project, "iconPath")) {
      return undefined;
    }
    const iconPath = project.iconPath;
    if (iconPath === null) return null;
    return typeof iconPath === "string" && iconPath.trim().length > 0 ? iconPath.trim() : null;
  } catch {
    // Project config validation surfaces malformed YAML. Icon lookup should
    // quietly degrade to automatic detection.
    return undefined;
  }
}

function resolveConfiguredProjectIconPath(projectRoot: string, configured: ProjectIconOverride): string | null {
  if (!configured || !isSupportedIconPath(configured)) return null;
  const match = findExistingFile(projectRoot, [configured]);
  return match && isSupportedIconPath(match) ? match : null;
}

function listSubdirectories(root: string, relativeDir: string): string[] {
  let dirPath: string;
  try {
    dirPath = resolvePathWithinRoot(root, relativeDir, { allowMissing: false });
  } catch {
    return [];
  }
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_ICON_DIRS.has(entry.name))
      .map((entry) => path.posix.join(relativeDir === "." ? "" : relativeDir, entry.name));
  } catch {
    return [];
  }
}

type IconSearchRootsCacheEntry = {
  rootMtimeMs: number;
  appsMtimeMs: number;
  packagesMtimeMs: number;
  value: string[];
};

const iconSearchRootsCache = new Map<string, IconSearchRootsCacheEntry>();
const PROJECT_ICON_RESULT_CACHE_MAX = 64;
const PROJECT_ICON_RESULT_CACHE_TTL_MS = 5 * 60_000;

type ProjectIconResultCacheEntry = {
  rootMtimeMs: number;
  appsMtimeMs: number;
  packagesMtimeMs: number;
  configMtimeMs: number;
  sourcePath: string | null;
  sourceMtimeMs: number;
  sourceSize: number;
  expiresAtMs: number;
  value: ProjectIcon;
};

const projectIconResultCache = new Map<string, ProjectIconResultCacheEntry>();

function dirMtimeMs(absPath: string): number {
  try {
    return fs.statSync(absPath).mtimeMs;
  } catch {
    return -1;
  }
}

function fileSignature(absPath: string | null): { mtimeMs: number; size: number } {
  if (!absPath) return { mtimeMs: -1, size: -1 };
  try {
    const stat = fs.statSync(absPath);
    return stat.isFile()
      ? { mtimeMs: stat.mtimeMs, size: stat.size }
      : { mtimeMs: -1, size: -1 };
  } catch {
    return { mtimeMs: -1, size: -1 };
  }
}

function projectIconResultCacheKey(root: string, options: { iconPathOverride?: string | null }): string {
  const overrideKey = Object.prototype.hasOwnProperty.call(options, "iconPathOverride")
    ? `override:${options.iconPathOverride ?? "null"}`
    : "auto";
  return `${root}\0${overrideKey}`;
}

function setProjectIconResultCache(key: string, entry: ProjectIconResultCacheEntry): void {
  if (projectIconResultCache.has(key)) {
    projectIconResultCache.delete(key);
  } else if (projectIconResultCache.size >= PROJECT_ICON_RESULT_CACHE_MAX) {
    const oldestKey = projectIconResultCache.keys().next().value;
    if (oldestKey !== undefined) {
      projectIconResultCache.delete(oldestKey);
    }
  }
  projectIconResultCache.set(key, entry);
}

function clearProjectIconResultCache(projectRoot: string): void {
  const root = path.resolve(projectRoot);
  for (const key of projectIconResultCache.keys()) {
    if (key === root || key.startsWith(`${root}\0`)) {
      projectIconResultCache.delete(key);
    }
  }
}

// Resolving a project icon scans the project root and every first-level child
// of `apps/` and `packages/`. On large monorepos the project-tab render fan-out
// turned into hundreds of `readdirSync` calls per refresh; cache the result
// keyed on the mtime of those three directories so it invalidates when a
// workspace dir is added/removed.
function iconSearchRoots(projectRoot: string): string[] {
  const rootMtimeMs = dirMtimeMs(projectRoot);
  const appsMtimeMs = dirMtimeMs(path.join(projectRoot, "apps"));
  const packagesMtimeMs = dirMtimeMs(path.join(projectRoot, "packages"));
  const cached = iconSearchRootsCache.get(projectRoot);
  if (
    cached
    && cached.rootMtimeMs === rootMtimeMs
    && cached.appsMtimeMs === appsMtimeMs
    && cached.packagesMtimeMs === packagesMtimeMs
  ) {
    return cached.value;
  }

  const roots = new Set<string>(["."]);
  for (const dir of listSubdirectories(projectRoot, ".")) {
    roots.add(dir);
  }
  for (const workspaceDir of ["apps", "packages"]) {
    for (const dir of listSubdirectories(projectRoot, workspaceDir)) {
      roots.add(dir);
    }
  }

  const value = Array.from(roots);
  iconSearchRootsCache.set(projectRoot, {
    rootMtimeMs,
    appsMtimeMs,
    packagesMtimeMs,
    value,
  });
  return value;
}

function candidateDirectoriesForRoot(root: string): string[] {
  return ICON_BASE_CANDIDATES.map((candidate) =>
    root === "." ? candidate : path.posix.join(root, candidate === "." ? "" : candidate)
  );
}

function isLikelyIconFile(fileName: string): boolean {
  if (!isSupportedIconPath(fileName)) return false;
  const base = path.basename(fileName, path.extname(fileName)).toLowerCase();
  if (base.includes("placeholder")) return false;
  return base.includes("icon") || base.includes("logo") || base === "favicon";
}

function discoverDirectoryIconFiles(projectRoot: string, relativeDir: string): string[] {
  let dirPath: string;
  try {
    dirPath = resolvePathWithinRoot(projectRoot, relativeDir, { allowMissing: false });
  } catch {
    return [];
  }
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isLikelyIconFile(entry.name))
      .map((entry) => path.posix.join(relativeDir === "." ? "" : relativeDir, entry.name));
  } catch {
    return [];
  }
}

function buildDetectedIconCandidates(projectRoot: string): string[] {
  const candidates = new Set<string>();
  for (const root of iconSearchRoots(projectRoot)) {
    for (const candidateDir of candidateDirectoriesForRoot(root)) {
      for (const fileName of ICON_FILE_CANDIDATES) {
        candidates.add(path.posix.join(candidateDir === "." ? "" : candidateDir, fileName));
      }
      for (const discovered of discoverDirectoryIconFiles(projectRoot, candidateDir)) {
        candidates.add(discovered);
      }
    }
  }
  return Array.from(candidates);
}

function scoreIconCandidate(projectRoot: string, filePath: string): number {
  const relativePath = toProjectRelative(projectRoot, filePath);
  const normalized = relativePath.toLowerCase();
  const fileName = path.basename(normalized, path.extname(normalized));
  const depth = relativePath.split("/").length;
  let score = 0;

  if (fileName === "macicon" || fileName === "app-icon" || fileName === "app_icon") score += 120;
  else if (fileName === "icon") score += 100;
  else if (fileName.includes("logo")) score += 80;
  else if (fileName === "favicon") score += 45;
  else if (fileName.includes("icon")) score += 70;

  if (normalized.includes("/app/") || normalized.includes("/src/app/")) score += 16;
  if (normalized.includes("/assets/")) score += 14;
  if (normalized.includes("/public/")) score += 8;
  if (normalized.includes("/apps/desktop/build/")) score += 20;
  if (normalized.includes("/docs/") || normalized.includes("/mintlify/")) score -= 30;

  switch (path.extname(normalized)) {
    case ".png":
      score += 8;
      break;
    case ".svg":
      score += 6;
      break;
    case ".ico":
      score += 2;
      break;
    case ".webp":
      score += 1;
      break;
    default:
      break;
  }

  return score - depth;
}

function findBestDetectedIcon(projectRoot: string): string | null {
  const matches: string[] = [];
  for (const candidate of buildDetectedIconCandidates(projectRoot)) {
    const match = findExistingFile(projectRoot, [candidate]);
    if (match && isSupportedIconPath(match)) matches.push(match);
  }
  matches.sort((a, b) => {
    const delta = scoreIconCandidate(projectRoot, b) - scoreIconCandidate(projectRoot, a);
    if (delta !== 0) return delta;
    return toProjectRelative(projectRoot, a).localeCompare(toProjectRelative(projectRoot, b));
  });
  return matches[0] ?? null;
}

export function resolveProjectIconPath(
  projectRoot: string,
  options: { iconPathOverride?: string | null } = {},
): string | null {
  const root = path.resolve(projectRoot);
  const configured = Object.prototype.hasOwnProperty.call(options, "iconPathOverride")
    ? options.iconPathOverride
    : readProjectIconOverride(root);
  if (configured === null) return null;
  const configuredMatch = resolveConfiguredProjectIconPath(root, configured);
  if (configuredMatch) return configuredMatch;

  const directMatch = findBestDetectedIcon(root);
  if (directMatch) return directMatch;

  for (const sourceFile of ICON_SOURCE_FILES) {
    // Resolve through the real filesystem so a symlinked source file (e.g.
    // `index.html -> ../outside.html`) can't trick us into reading outside
    // the project root.
    let sourcePath: string;
    try {
      sourcePath = resolvePathWithinRoot(root, sourceFile, { allowMissing: false });
    } catch {
      continue;
    }
    let source: string;
    try {
      source = fs.readFileSync(sourcePath, "utf8");
    } catch {
      continue;
    }
    const href = extractIconHref(source);
    if (!href || !isLocalIconHref(href)) continue;
    const existing = findExistingFile(root, resolveIconHref(root, href));
    if (existing && isSupportedIconPath(existing)) return existing;
  }

  return null;
}

function mimeTypeForIconPath(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function writeProjectIconPathOverride(projectRoot: string, iconPath: string | null): void {
  const sharedConfigPath = path.join(projectRoot, ".ade", "ade.yaml");
  let config: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(fs.readFileSync(sharedConfigPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code !== "ENOENT") throw error;
  }

  const project = config.project && typeof config.project === "object" && !Array.isArray(config.project)
    ? { ...(config.project as Record<string, unknown>) }
    : {};
  project.iconPath = iconPath;
  config.project = project;
  config.version = typeof config.version === "number" ? config.version : 1;

  fs.mkdirSync(path.dirname(sharedConfigPath), { recursive: true });
  // Write to a sibling temp file then rename so a crash mid-write can never
  // leave .ade/ade.yaml truncated/corrupted. The rename is atomic on the
  // same filesystem.
  const tempPath = `${sharedConfigPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, YAML.stringify(config, { indent: 2 }));
  try {
    fs.renameSync(tempPath, sharedConfigPath);
  } catch (renameError) {
    try { fs.unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    throw renameError;
  }
}

export function setProjectIconOverride(projectRoot: string, iconPath: string): ProjectIcon {
  const root = path.resolve(projectRoot);
  const resolvedIconPath = resolvePathWithinRoot(root, iconPath, { allowMissing: false });
  const stat = fs.statSync(resolvedIconPath);
  if (!stat.isFile()) throw new Error("Project icon must be a file.");
  if (!isSupportedIconPath(resolvedIconPath)) {
    throw new Error("Project icon must be an ico, jpg, png, svg, or webp file.");
  }

  const relativeIconPath = toProjectRelative(root, resolvedIconPath);
  writeProjectIconPathOverride(root, relativeIconPath);
  clearProjectIconResultCache(root);
  return resolveProjectIcon(root, { iconPathOverride: relativeIconPath });
}

export function removeProjectIconOverride(projectRoot: string): ProjectIcon {
  const root = path.resolve(projectRoot);
  writeProjectIconPathOverride(root, null);
  clearProjectIconResultCache(root);
  return resolveProjectIcon(root, { iconPathOverride: null });
}

export function resolveProjectIcon(
  projectRoot: string,
  options: { iconPathOverride?: string | null } = {},
): ProjectIcon {
  const root = path.resolve(projectRoot);
  const cacheKey = projectIconResultCacheKey(root, options);
  const rootMtimeMs = dirMtimeMs(root);
  const appsMtimeMs = dirMtimeMs(path.join(root, "apps"));
  const packagesMtimeMs = dirMtimeMs(path.join(root, "packages"));
  const configMtimeMs = dirMtimeMs(path.join(root, ".ade", "ade.yaml"));
  const cached = projectIconResultCache.get(cacheKey);
  if (
    cached
    && cached.expiresAtMs > Date.now()
    && cached.rootMtimeMs === rootMtimeMs
    && cached.appsMtimeMs === appsMtimeMs
    && cached.packagesMtimeMs === packagesMtimeMs
    && cached.configMtimeMs === configMtimeMs
  ) {
    const sourceSignature = fileSignature(cached.sourcePath);
    if (sourceSignature.mtimeMs === cached.sourceMtimeMs && sourceSignature.size === cached.sourceSize) {
      projectIconResultCache.delete(cacheKey);
      projectIconResultCache.set(cacheKey, cached);
      return cached.value;
    }
  }

  const cacheValue = (value: ProjectIcon, sourcePath: string | null, sourceMtimeMs = -1, sourceSize = -1): ProjectIcon => {
    setProjectIconResultCache(cacheKey, {
      rootMtimeMs,
      appsMtimeMs,
      packagesMtimeMs,
      configMtimeMs,
      sourcePath,
      sourceMtimeMs,
      sourceSize,
      expiresAtMs: Date.now() + PROJECT_ICON_RESULT_CACHE_TTL_MS,
      value,
    });
    return value;
  };

  const iconPath = resolveProjectIconPath(root, options);
  if (!iconPath) {
    // Don't cache negative lookups: there is no real source path to key off,
    // so adding an icon (e.g. src/app/icon.png) under an existing workspace
    // tree wouldn't change the cached mtimes and the UI would keep showing
    // "no icon" until the cache TTL expires.
    return { dataUrl: null, sourcePath: null, mimeType: null };
  }

  const mimeType = mimeTypeForIconPath(iconPath);
  if (!mimeType) {
    const sourceSignature = fileSignature(iconPath);
    return cacheValue(
      { dataUrl: null, sourcePath: iconPath, mimeType: null },
      iconPath,
      sourceSignature.mtimeMs,
      sourceSignature.size,
    );
  }

  // resolveProjectIconPath already returned a realpath inside the project
  // root, but defensively swallow any read/stat failure (e.g. a race that
  // unlinks the icon between resolve and read) and return "no icon" rather
  // than crashing.
  try {
    const stat = fs.statSync(iconPath);
    if (stat.size > ICON_MAX_BYTES) {
      return cacheValue({ dataUrl: null, sourcePath: iconPath, mimeType }, iconPath, stat.mtimeMs, stat.size);
    }
    const data = fs.readFileSync(iconPath);
    return cacheValue(
      {
        dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
        sourcePath: iconPath,
        mimeType,
      },
      iconPath,
      stat.mtimeMs,
      stat.size,
    );
  } catch {
    return cacheValue({ dataUrl: null, sourcePath: null, mimeType: null }, null);
  }
}
