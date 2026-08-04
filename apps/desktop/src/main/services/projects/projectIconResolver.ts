import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";

import type { ProjectIcon } from "../../../shared/types";
import { isWithinDir, resolvePathWithinRoot } from "../shared/utils";
import { ensureSharedAdeProjectScaffold } from "./adeProjectService";

const ICON_MAX_BYTES = 10 * 1024 * 1024;
const ICON_MAX_LABEL = "10 MB";
const SUPPORTED_ICON_EXTENSIONS = new Set([".svg", ".ico", ".png", ".jpg", ".jpeg", ".webp"]);
const IMPORTED_PROJECT_ICON_DIR = ".ade/project-icons";

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

const IOS_ASSET_CATALOG_CANDIDATE_DIRS = [
  "Assets.xcassets",
  "Resources/Assets.xcassets",
] as const;

const IOS_ASSET_ICONSET_EXTENSIONS = new Set([".appiconset", ".imageset"]);

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

function realpathExisting(filePath: string): string {
  return typeof fs.realpathSync.native === "function"
    ? fs.realpathSync.native(filePath)
    : fs.realpathSync(filePath);
}

/**
 * Canonicalize a project root the same way every path this module hands back is
 * canonicalized: `resolvePathWithinRoot` realpaths each existing segment, so an
 * icon path is always spelled the way the filesystem spells it.
 *
 * `path.resolve` alone does not get the root there. On Windows a root can
 * arrive as an 8.3 short name (`C:\Users\RUNNER~1\...` whenever the account
 * name exceeds eight characters — `Administrator`, most `First Last` accounts,
 * and GitHub's own `runneradmin`), and on every platform it can arrive through
 * a junction or symlink. The root and the resolved icon then name the same file
 * with different strings, and `path.relative` between them yields a `..`
 * traversal instead of a project-relative path — which `setProjectIconOverride`
 * would persist into the shared `.ade/ade.yaml` as the project's `iconPath`.
 *
 * Falls back to the lexical resolve when the root does not exist, so callers
 * that probe a stale project directory still get "no icon" rather than a throw.
 */
function canonicalProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  try {
    return realpathExisting(resolved);
  } catch {
    return resolved;
  }
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

type ProjectIconPathCacheEntry = {
  rootMtimeMs: number;
  appsMtimeMs: number;
  packagesMtimeMs: number;
  configMtimeMs: number;
  sourceMtimeMs: number;
  sourceSize: number;
  expiresAtMs: number;
  value: string;
};

const projectIconPathCache = new Map<string, ProjectIconPathCacheEntry>();

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

function setProjectIconPathCache(key: string, entry: ProjectIconPathCacheEntry): void {
  if (projectIconPathCache.has(key)) {
    projectIconPathCache.delete(key);
  } else if (projectIconPathCache.size >= PROJECT_ICON_RESULT_CACHE_MAX) {
    const oldestKey = projectIconPathCache.keys().next().value;
    if (oldestKey !== undefined) projectIconPathCache.delete(oldestKey);
  }
  projectIconPathCache.set(key, entry);
}

function clearProjectIconResultCache(projectRoot: string): void {
  const root = canonicalProjectRoot(projectRoot);
  for (const key of projectIconResultCache.keys()) {
    if (key === root || key.startsWith(`${root}\0`)) {
      projectIconResultCache.delete(key);
    }
  }
  for (const key of projectIconPathCache.keys()) {
    if (key === root || key.startsWith(`${root}\0`)) {
      projectIconPathCache.delete(key);
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
  for (const discovered of discoverIosAssetCatalogIconFiles(projectRoot)) {
    candidates.add(discovered);
  }
  return Array.from(candidates);
}

function assetCatalogCandidateRoots(projectRoot: string): string[] {
  const candidates = new Set<string>();
  const addCatalogCandidates = (root: string) => {
    for (const candidateDir of IOS_ASSET_CATALOG_CANDIDATE_DIRS) {
      candidates.add(root === "." ? candidateDir : path.posix.join(root, candidateDir));
    }
  };
  const addNestedCatalogCandidates = (root: string, remainingDepth: number) => {
    addCatalogCandidates(root);
    if (remainingDepth <= 0) return;
    for (const child of listSubdirectories(projectRoot, root)) {
      addNestedCatalogCandidates(child, remainingDepth - 1);
    }
  };

  for (const root of iconSearchRoots(projectRoot)) {
    addNestedCatalogCandidates(root, 2);
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = resolvePathWithinRoot(projectRoot, candidate, { allowMissing: false });
    } catch {
      continue;
    }
    try {
      if (fs.statSync(resolved).isDirectory()) existing.push(candidate);
    } catch {
      // Keep probing.
    }
  }
  return existing;
}

function isLikelyIosAssetIconSet(dirName: string): boolean {
  const ext = path.extname(dirName).toLowerCase();
  if (!IOS_ASSET_ICONSET_EXTENSIONS.has(ext)) return false;
  if (ext === ".appiconset") return true;

  const base = path.basename(dirName, ext).toLowerCase();
  return base.includes("icon")
    || base.includes("logo")
    || base.includes("brand")
    || base.includes("mark");
}

function assetContentsFilenames(assetSetPath: string): string[] {
  const contentsPath = path.join(assetSetPath, "Contents.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(contentsPath, "utf8"));
  } catch {
    return [];
  }
  const images = parsed && typeof parsed === "object" && "images" in parsed
    ? (parsed as { images?: unknown }).images
    : undefined;
  if (!Array.isArray(images)) return [];

  return images
    .map((entry) => {
      if (!entry || typeof entry !== "object" || !("filename" in entry)) return null;
      const filename = (entry as { filename?: unknown }).filename;
      return typeof filename === "string" ? filename.trim() : null;
    })
    .filter((filename): filename is string =>
      !!filename
      && !path.isAbsolute(filename)
      && !filename.includes("/")
      && !filename.includes("\\")
      && isSupportedIconPath(filename)
    );
}

function discoverIosAssetCatalogIconFiles(projectRoot: string): string[] {
  const candidates: string[] = [];
  for (const catalogDir of assetCatalogCandidateRoots(projectRoot)) {
    let catalogPath: string;
    try {
      catalogPath = resolvePathWithinRoot(projectRoot, catalogDir, { allowMissing: false });
    } catch {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(catalogPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !isLikelyIosAssetIconSet(entry.name)) continue;
      const relativeSetDir = path.posix.join(catalogDir, entry.name);
      const assetSetPath = path.join(catalogPath, entry.name);
      const filenames = assetContentsFilenames(assetSetPath);
      if (filenames.length > 0) {
        for (const filename of filenames) {
          candidates.push(path.posix.join(relativeSetDir, filename));
        }
        continue;
      }
      for (const discovered of discoverDirectoryIconFiles(projectRoot, relativeSetDir)) {
        candidates.push(discovered);
      }
    }
  }
  return candidates;
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
  if (normalized.includes("/assets.xcassets/")) score += 24;
  if (normalized.includes(".appiconset/")) score += 90;
  if (normalized.includes("/appicon.appiconset/")) score += 35;
  if (normalized.includes(".imageset/")) score += 18;
  if (normalized.includes("/brandmark.imageset/")) score += 30;
  if (normalized.includes("/public/")) score += 8;
  if (normalized.includes("/apps/desktop/build/")) score += 20;
  if (normalized.includes("/docs/") || normalized.includes("/mintlify/")) score -= 30;

  const pixelMatch = normalized.match(/(?:^|[-_])(\d{2,4})x(\d{2,4})(?:@(\d)x)?/);
  if (pixelMatch) {
    const width = Number(pixelMatch[1]);
    const height = Number(pixelMatch[2]);
    const scale = pixelMatch[3] ? Number(pixelMatch[3]) : 1;
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const displayEdge = Math.sqrt(width * height) * (Number.isFinite(scale) && scale > 0 ? scale : 1);
      score += Math.min(44, Math.round(displayEdge / 24));
    }
  }
  if (normalized.includes("1024")) score += 18;

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

function isInlineableIconFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size <= ICON_MAX_BYTES;
  } catch {
    return false;
  }
}

function findBestDetectedIcon(projectRoot: string): string | null {
  const matches: string[] = [];
  for (const candidate of buildDetectedIconCandidates(projectRoot)) {
    const match = findExistingFile(projectRoot, [candidate]);
    if (match && isSupportedIconPath(match) && isInlineableIconFile(match)) matches.push(match);
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
  const root = canonicalProjectRoot(projectRoot);
  const cacheKey = projectIconResultCacheKey(root, options);
  const rootMtimeMs = dirMtimeMs(root);
  const appsMtimeMs = dirMtimeMs(path.join(root, "apps"));
  const packagesMtimeMs = dirMtimeMs(path.join(root, "packages"));
  const configMtimeMs = dirMtimeMs(path.join(root, ".ade", "ade.yaml"));
  const cached = projectIconPathCache.get(cacheKey);
  if (
    cached
    && cached.expiresAtMs > Date.now()
    && cached.rootMtimeMs === rootMtimeMs
    && cached.appsMtimeMs === appsMtimeMs
    && cached.packagesMtimeMs === packagesMtimeMs
    && cached.configMtimeMs === configMtimeMs
  ) {
    const sourceSignature = fileSignature(cached.value);
    if (
      sourceSignature.mtimeMs === cached.sourceMtimeMs
      && sourceSignature.size === cached.sourceSize
    ) {
      projectIconPathCache.delete(cacheKey);
      projectIconPathCache.set(cacheKey, cached);
      return cached.value;
    }
  }
  const cacheValue = (value: string): string => {
    const sourceSignature = fileSignature(value);
    setProjectIconPathCache(cacheKey, {
      rootMtimeMs,
      appsMtimeMs,
      packagesMtimeMs,
      configMtimeMs,
      sourceMtimeMs: sourceSignature.mtimeMs,
      sourceSize: sourceSignature.size,
      expiresAtMs: Date.now() + PROJECT_ICON_RESULT_CACHE_TTL_MS,
      value,
    });
    return value;
  };
  const configured = Object.prototype.hasOwnProperty.call(options, "iconPathOverride")
    ? options.iconPathOverride
    : readProjectIconOverride(root);
  if (configured === null) return null;
  const configuredMatch = resolveConfiguredProjectIconPath(root, configured);
  if (configuredMatch) return cacheValue(configuredMatch);

  const directMatch = findBestDetectedIcon(root);
  if (directMatch) return cacheValue(directMatch);

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
    if (existing && isSupportedIconPath(existing) && isInlineableIconFile(existing)) {
      return cacheValue(existing);
    }
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
  ensureSharedAdeProjectScaffold(projectRoot);
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
  const root = canonicalProjectRoot(projectRoot);
  const resolvedIconPath = resolvePathWithinRoot(root, iconPath, { allowMissing: false });
  assertUsableProjectIconFile(resolvedIconPath);

  const relativeIconPath = toProjectRelative(root, resolvedIconPath);
  writeProjectIconPathOverride(root, relativeIconPath);
  clearProjectIconResultCache(root);
  return resolveProjectIcon(root, { iconPathOverride: relativeIconPath });
}

function assertUsableProjectIconFile(iconPath: string): void {
  const stat = fs.statSync(iconPath);
  if (!stat.isFile()) throw new Error("Project icon must be a file.");
  if (!isSupportedIconPath(iconPath)) {
    throw new Error("Project icon must be an ico, jpg, png, svg, or webp file.");
  }
  if (stat.size > ICON_MAX_BYTES) {
    throw new Error(`Project icon must be ${ICON_MAX_LABEL} or smaller.`);
  }
}

function importedProjectIconRelativePath(sourcePath: string, data: Buffer): string {
  const ext = path.extname(sourcePath).toLowerCase();
  const rawBase = path.basename(sourcePath, path.extname(sourcePath));
  const safeBase = rawBase
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    || "icon";
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 12);
  return path.posix.join(IMPORTED_PROJECT_ICON_DIR, `${safeBase}-${hash}${ext}`);
}

export function setProjectIconOverrideFromSelection(projectRoot: string, iconPath: string): ProjectIcon {
  // Both sides are canonicalized with the same realpath, so the containment
  // check below compares like-for-like spellings.
  const root = canonicalProjectRoot(projectRoot);
  const selectedPath = realpathExisting(path.resolve(iconPath));
  assertUsableProjectIconFile(selectedPath);

  if (isWithinDir(root, selectedPath)) {
    return setProjectIconOverride(root, selectedPath);
  }

  const data = fs.readFileSync(selectedPath);
  // TOCTOU safety net: file may have grown between assertUsableProjectIconFile's stat and this read.
  if (data.length > ICON_MAX_BYTES) {
    throw new Error(`Project icon must be ${ICON_MAX_LABEL} or smaller.`);
  }
  const relativeImportPath = importedProjectIconRelativePath(selectedPath, data);
  const importDir = resolvePathWithinRoot(root, IMPORTED_PROJECT_ICON_DIR, { allowMissing: true });
  fs.mkdirSync(importDir, { recursive: true });
  const importPath = resolvePathWithinRoot(root, relativeImportPath, { allowMissing: true });
  try {
    fs.writeFileSync(importPath, data, { flag: "wx", mode: 0o644 });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code !== "EEXIST") throw error;
  }

  return setProjectIconOverride(root, relativeImportPath);
}

export function removeProjectIconOverride(projectRoot: string): ProjectIcon {
  const root = canonicalProjectRoot(projectRoot);
  writeProjectIconPathOverride(root, null);
  clearProjectIconResultCache(root);
  return resolveProjectIcon(root, { iconPathOverride: null });
}

export function resolveProjectIcon(
  projectRoot: string,
  options: { iconPathOverride?: string | null } = {},
): ProjectIcon {
  const root = canonicalProjectRoot(projectRoot);
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
