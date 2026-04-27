import fs from "node:fs";
import path from "node:path";

import type { ProjectIcon } from "../../../shared/types";

const ICON_MAX_BYTES = 1024 * 1024;

const ICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  ".idea/icon.svg",
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

function isPathWithinProject(projectRoot: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findExistingFile(projectRoot: string, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (!isPathWithinProject(projectRoot, candidate)) continue;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
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

export function resolveProjectIconPath(projectRoot: string): string | null {
  const root = path.resolve(projectRoot);
  for (const candidate of ICON_CANDIDATES) {
    const existing = findExistingFile(root, [path.join(root, candidate)]);
    if (existing) return existing;
  }

  for (const sourceFile of ICON_SOURCE_FILES) {
    const sourcePath = path.join(root, sourceFile);
    let source: string;
    try {
      source = fs.readFileSync(sourcePath, "utf8");
    } catch {
      continue;
    }
    const href = extractIconHref(source);
    if (!href || !isLocalIconHref(href)) continue;
    const existing = findExistingFile(root, resolveIconHref(root, href));
    if (existing) return existing;
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
    default:
      return null;
  }
}

export function resolveProjectIcon(projectRoot: string): ProjectIcon {
  const iconPath = resolveProjectIconPath(projectRoot);
  if (!iconPath) return { dataUrl: null, sourcePath: null, mimeType: null };

  const mimeType = mimeTypeForIconPath(iconPath);
  if (!mimeType) return { dataUrl: null, sourcePath: null, mimeType: null };

  const stat = fs.statSync(iconPath);
  if (stat.size > ICON_MAX_BYTES) {
    return { dataUrl: null, sourcePath: iconPath, mimeType };
  }

  const data = fs.readFileSync(iconPath);
  return {
    dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
    sourcePath: iconPath,
    mimeType,
  };
}
