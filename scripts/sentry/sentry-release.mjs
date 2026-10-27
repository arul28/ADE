// Release-time Sentry steps for the desktop app and the brain:
//
//   upload      --version <v> --dist <win-x64|mac-arm64|mac-x64|linux-x64|linux-arm64>
//               [--dir <path>]
//               Creates release ade@<v> in ade-desktop and ade-brain and uploads
//               the debug-ID source maps from apps/desktop/dist and
//               apps/ade-cli/dist. Run after packaging, in the same job. With
//               --dir, uploads only that folder to ade-brain: the standalone
//               runtime's SEA entry and its map (build-static.mjs).
//   set-commits --version <v>   Associates commits, read from this checkout's
//               git history (no Sentry GitHub integration needed).
//   finalize    --version <v>   Marks the release as released.
//
// <v> is the release tag without its leading "v": release jobs stamp exactly
// that into apps/desktop and apps/ade-cli package.json (set-release-version.mjs),
// which is what app.getVersion() and the brain's __ADE_VERSION__ report, so
// `ade@<v>` matches sentryReleaseName() at runtime. dist matches sentryDist().
//
// Skips with a log line when SENTRY_AUTH_TOKEN is empty, and never exits
// non-zero: a Sentry outage must not fail a release.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { scriptsMissingDebugIds } from "./inject-debug-ids.mjs";
import {
  SENTRY_ORG,
  SOURCE_MAP_TARGETS,
  adeCliRoot,
  desktopRoot,
  existingDirs,
  repoRoot,
  runSentryCli,
  warn,
} from "./sentry-cli.mjs";

const PROJECTS = SOURCE_MAP_TARGETS.map((target) => target.project);
const DISTS = new Set(["win-x64", "mac-arm64", "mac-x64", "linux-x64", "linux-arm64"]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    options[key] = inline ?? rest[index + 1];
    if (inline === undefined) index += 1;
  }
  return { command, options };
}

function packageVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
}

function cli(args, label) {
  const result = runSentryCli(args);
  if (!result.ok) warn(`Sentry ${label} failed (exit ${result.status}).`);
  return result.ok;
}

function createRelease(release) {
  return PROJECTS.every((project) =>
    cli(["releases", "new", release, "--org", SENTRY_ORG, "--project", project], `release create for ${project}`));
}

/** Best effort: a shallow checkout has one commit, and set-commits needs the range since the last release. */
function deepenHistory() {
  const result = spawnSync("git", ["fetch", "--deepen=500", "--no-tags", "origin"], { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) warn("Could not deepen git history; the release may list fewer commits.");
}

function upload(release, version, dist, dir) {
  if (!DISTS.has(dist)) {
    warn(`Unknown Sentry dist '${dist}'; expected one of ${[...DISTS].join(", ")}. Skipping upload.`);
    return;
  }
  // The running app reports its stamped package.json version; maps uploaded
  // under any other release name would never be looked up by it.
  const stamped = { "apps/desktop": packageVersion(desktopRoot), "apps/ade-cli": packageVersion(adeCliRoot) };
  const mismatched = Object.entries(stamped).filter(([, value]) => value !== version);
  if (mismatched.length > 0) {
    warn(
      `Release ${release} does not match the stamped package version(s) `
        + `${mismatched.map(([name, value]) => `${name}=${value}`).join(", ")}. Skipping source map upload.`,
    );
    return;
  }
  if (!createRelease(release)) return;
  const targets = dir ? [{ project: "ade-brain", dirs: [path.resolve(dir)] }] : SOURCE_MAP_TARGETS;
  for (const target of targets) {
    const dirs = existingDirs(target.dirs);
    if (dirs.length === 0) {
      warn(`No build output for ${target.project}; nothing to upload.`);
      continue;
    }
    const missing = scriptsMissingDebugIds(dirs);
    if (missing.length > 0) {
      warn(`${missing.length} ${target.project} bundle(s) have no debug ID (was ADE_BUILD_SOURCEMAPS=1 set for the build?). Their frames will stay minified.`);
    }
    console.log(`[sentry] Uploading ${target.project} source maps for ${release} (${dist}) from ${dirs.join(", ")}`);
    cli(
      [
        "sourcemaps", "upload",
        "--org", SENTRY_ORG,
        "--project", target.project,
        "--release", release,
        "--dist", dist,
        ...dirs,
      ],
      `source map upload for ${target.project}`,
    );
  }
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const version = String(options.version ?? "").trim().replace(/^v/, "");
  if (!["upload", "set-commits", "finalize"].includes(command) || !version) {
    warn("Usage: sentry-release.mjs <upload|set-commits|finalize> --version <semver> [--dist <dist>]");
    return;
  }
  if (!process.env.SENTRY_AUTH_TOKEN?.trim()) {
    console.log(`[sentry] SENTRY_AUTH_TOKEN is empty; skipping Sentry ${command} for ade@${version}.`);
    return;
  }
  const release = `ade@${version}`;
  if (command === "upload") {
    upload(release, version, String(options.dist ?? ""), options.dir ? String(options.dir) : null);
  } else if (command === "set-commits") {
    if (createRelease(release)) {
      // `--local` reads commits from this checkout instead of asking Sentry's
      // GitHub integration: the arul28 GitHub account is linked to another
      // Sentry organization, and sharing it needs a Business plan. Release
      // checkouts are shallow, so fetch enough history for the range first.
      deepenHistory();
      cli(
        ["releases", "set-commits", release, "--org", SENTRY_ORG, "--local", "--ignore-missing"],
        "set-commits from local git history",
      );
    }
  } else {
    cli(["releases", "finalize", release, "--org", SENTRY_ORG], "release finalize");
  }
}

try {
  main();
} catch (error) {
  warn(`Sentry release step failed: ${error instanceof Error ? error.message : String(error)}`);
}
