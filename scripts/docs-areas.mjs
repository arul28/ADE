#!/usr/bin/env node
/**
 * Source-to-page ownership for the public docs.
 *
 * `docs-areas.json` says which source trees produce which public pages. This
 * script keeps that map honest and gives the release skill a way to answer one
 * question: "this change touched these files — which docs pages can it make
 * wrong?"
 *
 * Usage:
 *   node scripts/docs-areas.mjs                     # validate the map
 *   node scripts/docs-areas.mjs --changed           # areas touched vs main
 *   node scripts/docs-areas.mjs --changed --base X  # ... against another ref
 *   node scripts/docs-areas.mjs --changed --json    # machine-readable
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WALK_SKIP = new Set([".git", "node_modules", "dist", "build", ".ade", ".next", "out"]);

function hasGlob(value) {
  return value.includes("*") || value.includes("?");
}

function segmentToRegex(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

/** Matches a forward-slash relative path against a `*`/`**` glob. */
export function matchGlob(pattern, pathValue) {
  const pat = pattern.split("/").filter(Boolean);
  const parts = pathValue.split("/").filter(Boolean);

  const walk = (pi, si) => {
    if (pi === pat.length) return si === parts.length;
    if (pat[pi] === "**") {
      if (pi === pat.length - 1) return true;
      for (let skip = si; skip <= parts.length; skip += 1) {
        if (walk(pi + 1, skip)) return true;
      }
      return false;
    }
    if (si >= parts.length) return false;
    return segmentToRegex(pat[pi]).test(parts[si]) && walk(pi + 1, si + 1);
  };

  return walk(0, 0);
}

function literalBase(pattern) {
  const segments = pattern.split("/");
  const literal = [];
  for (const segment of segments) {
    if (hasGlob(segment)) break;
    literal.push(segment);
  }
  // A pattern ending in a literal file has no directory to walk.
  return literal.join("/");
}

function walkFiles(root, relativeDir, out) {
  const absolute = path.join(root, relativeDir);
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (WALK_SKIP.has(entry.name)) continue;
      walkFiles(root, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

function filesUnder(root, relativeDir, cache) {
  if (cache.has(relativeDir)) return cache.get(relativeDir);
  const files = [];
  const stat = (() => {
    try {
      return fs.statSync(path.join(root, relativeDir || "."));
    } catch {
      return null;
    }
  })();
  if (stat?.isFile()) {
    files.push(relativeDir);
  } else if (stat?.isDirectory()) {
    walkFiles(root, relativeDir, files);
  }
  cache.set(relativeDir, files);
  return files;
}

/** True when `pattern` matches at least one file in the repository. */
export function globMatchesAny(root, pattern, cache = new Map()) {
  if (!hasGlob(pattern)) {
    return fs.existsSync(path.join(root, pattern));
  }
  const base = literalBase(pattern);
  const candidates = filesUnder(root, base, cache);
  return candidates.some((file) => matchGlob(pattern, file));
}

export function loadAreaMap(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "docs-areas.json"), "utf8"));
}

/**
 * Validates the map against the routes that actually exist.
 * `routeIds` are repo-relative page ids without a leading slash, e.g.
 * `concepts/lanes`.
 */
export function validateAreaMap({ root, routeIds }) {
  const errors = [];
  const map = loadAreaMap(root);
  const routeSet = new Set(routeIds);
  const cache = new Map();
  const owners = new Map();

  for (const area of map.areas ?? []) {
    if (!area.id) errors.push("docs-areas.json: area without an id");
    if (!Array.isArray(area.sources) || area.sources.length === 0) {
      errors.push(`docs-areas.json: area ${area.id} has no sources`);
    }
    if (!Array.isArray(area.pages) || area.pages.length === 0) {
      errors.push(`docs-areas.json: area ${area.id} has no pages`);
    }
    for (const page of area.pages ?? []) {
      if (!routeSet.has(page)) {
        errors.push(`docs-areas.json: area ${area.id} points at missing page ${page}`);
      }
      const previous = owners.get(page);
      if (previous) {
        errors.push(`docs-areas.json: page ${page} is owned by both ${previous} and ${area.id}`);
      } else {
        owners.set(page, area.id);
      }
    }
    for (const source of area.sources ?? []) {
      if (!globMatchesAny(root, source, cache)) {
        errors.push(`docs-areas.json: area ${area.id} source matches no files: ${source}`);
      }
    }
  }

  const shared = new Set(map.shared ?? []);
  for (const page of shared) {
    if (!routeSet.has(page)) {
      errors.push(`docs-areas.json: shared page does not exist: ${page}`);
    }
  }

  for (const routeId of routeSet) {
    if (routeId.startsWith("changelog/")) continue;
    if (shared.has(routeId) || owners.has(routeId)) continue;
    errors.push(`docs-areas.json: public page ${routeId} has no owner; add it to an area or to shared`);
  }

  return errors;
}

/** Returns the areas (and their pages) whose sources match the given files. */
export function affectedAreas({ root, changedFiles }) {
  const map = loadAreaMap(root);
  const results = [];
  for (const area of map.areas ?? []) {
    const matched = changedFiles.filter((file) => (area.sources ?? []).some((source) => matchGlob(source, file)));
    if (matched.length === 0) continue;
    results.push({
      id: area.id,
      title: area.title,
      pages: area.pages ?? [],
      files: matched.slice(0, 20),
      fileCount: matched.length
    });
  }
  return results;
}

function gitLines(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function changedFilesFor(root, base) {
  // Committed work since the base, plus anything still in the working tree, so
  // the same command is useful before a commit as well as inside a release.
  return [
    ...new Set([
      ...gitLines(root, ["diff", "--name-only", `${base}...HEAD`]),
      ...gitLines(root, ["diff", "--name-only", "HEAD"]),
      ...gitLines(root, ["diff", "--name-only", "--cached"]),
      ...gitLines(root, ["ls-files", "--others", "--exclude-standard"])
    ])
  ];
}

function main() {
  const root = process.cwd();
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const changed = args.includes("--changed");

  if (!changed) {
    const { routeIds } = readRouteIds(root);
    const errors = validateAreaMap({ root, routeIds });
    if (errors.length > 0) {
      console.error("Docs area validation failed:");
      for (const error of errors) console.error(`- ${error}`);
      process.exit(1);
    }
    console.log(`Docs area map covers ${routeIds.length} pages.`);
    return;
  }

  const baseIndex = args.indexOf("--base");
  const base = baseIndex >= 0 ? args[baseIndex + 1] : "origin/main";
  const files = changedFilesFor(root, base);
  const areas = affectedAreas({ root, changedFiles: files });

  if (json) {
    console.log(JSON.stringify({ base, changedFileCount: files.length, areas }, null, 2));
    return;
  }

  if (areas.length === 0) {
    console.log(`No docs areas affected by changes since ${base}.`);
    return;
  }

  console.log(`Docs areas affected by changes since ${base}:`);
  for (const area of areas) {
    console.log(`\n${area.title} (${area.id}) — ${area.fileCount} file(s)`);
    for (const page of area.pages) console.log(`  /${page}`);
  }
  console.log(
    "\nUpdate each page above, or record why it needs no change. Pages not listed here are not expected to change."
  );
}

function readRouteIds(root) {
  const routeIds = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (WALK_SKIP.has(entry.name)) continue;
        walk(rel);
      } else if (entry.name.endsWith(".mdx")) {
        routeIds.push(rel.replace(/\.mdx$/, ""));
      }
    }
  };
  walk("");
  return { routeIds };
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main();
}
