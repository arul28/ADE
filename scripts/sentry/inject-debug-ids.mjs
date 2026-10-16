// Stamps Sentry debug IDs into the built desktop and brain bundles (and their
// .map files) so the source maps uploaded after packaging pair with the exact
// bytes users run. Needs no auth token. Runs from electron-builder's beforePack
// hook (apps/desktop/scripts/sentry-before-pack.cjs), before anything is copied into the app, and
// only when ADE_BUILD_SOURCEMAPS=1; every other build is left untouched.
//
// Never fails a build: a release without readable stack traces is still a
// release. Problems surface as warnings instead.
//
// Manual run: ADE_BUILD_SOURCEMAPS=1 node scripts/sentry/inject-debug-ids.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_MAP_TARGETS,
  existingDirs,
  runSentryCli,
  sourceMapsRequested,
  warn,
} from "./sentry-cli.mjs";

const SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const DEBUG_ID_COMMENT = /\/\/# debugId=[0-9a-f-]{36}\s*$/i;

function listScriptsWithMaps(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !SCRIPT_EXTENSIONS.has(path.extname(entry.name))) continue;
    const filePath = path.join(entry.parentPath ?? entry.path, entry.name);
    if (fs.existsSync(`${filePath}.map`)) found.push(filePath);
  }
  return found;
}

/** Bundles that have a source map but no debug ID; uploads cannot pair these. */
export function scriptsMissingDebugIds(dirs) {
  return dirs.flatMap(listScriptsWithMaps).filter((filePath) => {
    const contents = fs.readFileSync(filePath, "utf8");
    return !DEBUG_ID_COMMENT.test(contents.slice(-200));
  });
}

export function injectDebugIds() {
  const dirs = existingDirs(SOURCE_MAP_TARGETS.flatMap((target) => target.dirs));
  if (dirs.length === 0) {
    warn("No build output found to inject Sentry debug IDs into.");
    return false;
  }
  console.log(`[sentry] Injecting debug IDs into ${dirs.join(", ")}`);
  // Idempotent: files that already carry a debug ID are skipped, so the
  // per-arch macOS build (two electron-builder runs) can call this twice.
  const result = runSentryCli(["sourcemaps", "inject", ...dirs]);
  if (!result.ok) {
    warn(`sentry-cli sourcemaps inject failed (exit ${result.status}): ${result.stderr.trim()}`);
    return false;
  }
  const missing = scriptsMissingDebugIds(dirs);
  if (missing.length > 0) {
    warn(`Sentry debug IDs missing from ${missing.length} bundle(s): ${missing.join(", ")}`);
    return false;
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!sourceMapsRequested()) {
    console.log("[sentry] ADE_BUILD_SOURCEMAPS is not 1; leaving the build output untouched.");
  } else {
    injectDebugIds();
  }
}
