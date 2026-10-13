// Shared helpers for the release-time Sentry source map steps: which CLI runs,
// which org and projects, and which build outputs belong to which project.
//
// The CLI is the official `@sentry/cli`, pinned to one exact version and run
// through `npx --yes`, so CI needs no global install and the binary that
// injects debug IDs is the same one that uploads them. It ships its native
// binary as a per-platform optional dependency (no postinstall download), so
// it runs the same on the macOS and Windows release runners.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SENTRY_CLI_VERSION = "3.8.0";
export const SENTRY_ORG = "ade-app";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "..", "..");
export const desktopRoot = path.join(repoRoot, "apps", "desktop");
export const adeCliRoot = path.join(repoRoot, "apps", "ade-cli");

// Only what ships. apps/desktop/dist/web-client is the web client build; it
// belongs to the ade-web project and is uploaded by deploy-web.yml.
export const SOURCE_MAP_TARGETS = [
  {
    project: "ade-desktop",
    dirs: ["main", "preload", "renderer"].map((dir) => path.join(desktopRoot, "dist", dir)),
  },
  {
    project: "ade-brain",
    dirs: [path.join(adeCliRoot, "dist")],
  },
];

export function sourceMapsRequested(env = process.env) {
  return env.ADE_BUILD_SOURCEMAPS === "1";
}

export function existingDirs(dirs) {
  return dirs.filter((dir) => fs.existsSync(dir));
}

function resolveNpxInvocation() {
  // `npx` is `npx.cmd` on Windows, which spawnSync cannot run without a shell.
  // Run npm's own npx-cli.js with this Node instead, as build-static.mjs does
  // for npm-cli.js.
  const candidates = [
    process.env.npm_execpath ? path.join(path.dirname(process.env.npm_execpath), "npx-cli.js") : null,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ].filter(Boolean);
  const npxCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (npxCli) return { command: process.execPath, prefix: [npxCli], shell: false };
  return { command: "npx", prefix: [], shell: process.platform === "win32" };
}

/** Runs `sentry-cli <args>`; returns `{ ok, status, stdout, stderr }` and never throws. */
export function runSentryCli(args, options = {}) {
  const npx = resolveNpxInvocation();
  const result = spawnSync(
    npx.command,
    [...npx.prefix, "--yes", `@sentry/cli@${SENTRY_CLI_VERSION}`, ...args],
    {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, SENTRY_LOAD_DOTENV: "0", ...(options.env ?? {}) },
      encoding: "utf8",
      shell: npx.shell,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    },
  );
  if (result.error) {
    return { ok: false, status: null, stdout: "", stderr: result.error.message };
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** A GitHub Actions warning annotation outside CI is just a readable line. */
export function warn(message) {
  console.log(`${process.env.GITHUB_ACTIONS === "true" ? "::warning::" : "[sentry] warning: "}${message}`);
}
