import fs from "node:fs";
import path from "node:path";

import type { ProjectIcon } from "../../../shared/types";
import { resolvePathWithinRoot } from "../shared/utils";

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

export function resolveProjectIconPath(projectRoot: string): string | null {
  const root = path.resolve(projectRoot);
  const directMatch = findExistingFile(root, ICON_CANDIDATES.map((candidate) => path.join(root, candidate)));
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

  // resolveProjectIconPath already returned a realpath inside the project
  // root, but defensively swallow any read/stat failure (e.g. a race that
  // unlinks the icon between resolve and read) and return "no icon" rather
  // than crashing.
  try {
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
  } catch {
    return { dataUrl: null, sourcePath: null, mimeType: null };
  }
}
