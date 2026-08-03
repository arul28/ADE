/**
 * Install every sub-app's dependencies.
 *
 * This exists because `npm --prefix <app> install` is the wrong tool for the
 * job. `--prefix` only moves where npm *writes* node_modules; the package npm
 * considers "the one being installed" is still the one in the current working
 * directory. Run from the repo root, `npm --prefix apps/ade-cli install`
 * therefore means "install the root package `ade` into apps/ade-cli", which
 * npm faithfully does: it writes `"ade": "file:../.."` into
 * apps/ade-cli/package.json and package-lock.json and drops an
 * apps/ade-cli/node_modules/ade symlink pointing back at the repo root.
 *
 * Spawning `npm install` with `cwd` set to the app directory is the form that
 * means what everyone actually wants. `.github/workflows/ci.yml` already uses
 * the equivalent `(cd apps/<app> && npm ci)`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const APPS = [
  "ade-cli",
  "desktop",
  "web",
  "webhook-relay",
  "tunnel-relay",
  "push-relay",
  "account-directory",
];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const passthrough = process.argv.slice(2);

for (const app of APPS) {
  const cwd = path.join(repoRoot, "apps", app);
  if (!fs.existsSync(path.join(cwd, "package.json"))) {
    throw new Error(`[install:apps] apps/${app} has no package.json`);
  }
  console.log(`[install:apps] npm install (cwd apps/${app})`);
  const result = spawnSync(npm, ["install", ...passthrough], {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[install:apps] apps/${app} install failed with exit code ${result.status}`);
  }
}

console.log(`[install:apps] installed ${APPS.length} app(s)`);
