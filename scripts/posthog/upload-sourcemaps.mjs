// Uploads the desktop and brain source maps to PostHog error tracking, so the
// `$exception` frames ADE mirrors from Sentry read as source, not bundles.
//
//   node scripts/posthog/upload-sourcemaps.mjs --version <v> [--dir <path>]
//
// Same folders as scripts/sentry/sentry-release.mjs upload (apps/desktop/dist
// main/preload/renderer and apps/ade-cli/dist), or only --dir: the standalone
// runtime's SEA entry and its map. Run it after the Sentry upload, in the same
// job, on the same files.
//
// How frames find these maps. PostHog keys a source map by a chunk id, and
// `posthog-cli sourcemap upload` (0.18.10+) uses a bundle's ECMA-426 debug id
// as that chunk id when no PostHog chunk id was injected. The bundles already
// carry the debug ids `sentry-cli sourcemaps inject` stamped in beforePack, so
// nothing is injected here and the shipped bytes stay exactly what Sentry
// paired its maps with. At runtime, the mirror copies each frame's debug id
// from Sentry's `debug_meta` into `chunk_id` (exceptionProductAnalytics.ts).
//
// A debug id is a hash of the bundle's content, so the maps are keyed by
// content, not by version: a beta and the stable that promotes it resolve
// through whichever build uploaded those bytes first, and a rebuilt bundle
// gets a new id and its own upload. --version only names the build in the log.
//
// Needs POSTHOG_PERSONAL_API_KEY (scope: error tracking write, organization
// read) and POSTHOG_PROJECT_ID; POSTHOG_HOST defaults to https://us.posthog.com.
// Skips with a notice without them and never exits non-zero: PostHog must not
// fail a release.

import path from "node:path";
import { scriptsMissingDebugIds } from "../sentry/inject-debug-ids.mjs";
import { SOURCE_MAP_TARGETS, existingDirs, runNpxPackage } from "../sentry/sentry-cli.mjs";
import { DEFAULT_POSTHOG_HOST, notice, parseArgs, warn } from "./cli.mjs";

export const POSTHOG_CLI_VERSION = "0.19.0";

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = String(options.version ?? "").trim().replace(/^v/, "");
  if (!version) {
    warn("Usage: upload-sourcemaps.mjs --version <semver> [--dir <path>]");
    return;
  }
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY?.trim();
  const projectId = process.env.POSTHOG_PROJECT_ID?.trim();
  if (!apiKey || !projectId) {
    notice(`POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID is empty; skipping the PostHog source map upload for ${version}.`);
    return;
  }
  const dirs = existingDirs(
    options.dir ? [path.resolve(String(options.dir))] : SOURCE_MAP_TARGETS.flatMap((target) => target.dirs),
  );
  if (dirs.length === 0) {
    warn(`No build output found; nothing to upload to PostHog for ${version}.`);
    return;
  }
  const missing = scriptsMissingDebugIds(dirs);
  if (missing.length > 0) {
    warn(`${missing.length} bundle(s) have no Sentry debug ID (was ADE_BUILD_SOURCEMAPS=1 set for the build?); PostHog skips them and their frames stay minified.`);
  }
  const env = {
    POSTHOG_CLI_API_KEY: apiKey,
    POSTHOG_CLI_PROJECT_ID: projectId,
    POSTHOG_CLI_HOST: process.env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
  };
  for (const dir of dirs) {
    console.log(`[posthog] Uploading source maps for ${version} from ${dir}`);
    // Event mode (the CLI default): symbol sets are keyed by chunk id alone,
    // not bound to a release row. No --delete-after: the Sentry step and the
    // packaged app share these files.
    const result = runNpxPackage(`@posthog/cli@${POSTHOG_CLI_VERSION}`, ["sourcemap", "upload", "--directory", dir], { env });
    if (!result.ok) warn(`PostHog source map upload failed for ${dir} (exit ${result.status}).`);
  }
}

try {
  main();
} catch (error) {
  warn(`PostHog source map upload failed: ${error instanceof Error ? error.message : String(error)}`);
}
