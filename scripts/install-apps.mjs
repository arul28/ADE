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

const PACKAGES = ["sdk", "chat-ui"];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const passthrough = process.argv.slice(2);

const targets = [
  ...APPS.map((app) => ({ label: `apps/${app}`, cwd: path.join(repoRoot, "apps", app) })),
  ...PACKAGES.map((pkg) => ({ label: `packages/${pkg}`, cwd: path.join(repoRoot, "packages", pkg) })),
];

// .nvmrc pins the Node CI uses. A newer Node can install "successfully" and
// still leave packages broken (Electron's unzip stops partway on Node 26).
const pinnedNode = (() => {
  try {
    return fs.readFileSync(path.join(repoRoot, ".nvmrc"), "utf8").trim().replace(/^v/, "");
  } catch {
    return null;
  }
})();
const nodeMismatch = Boolean(pinnedNode) && pinnedNode.split(".")[0] !== process.versions.node.split(".")[0];
if (nodeMismatch) {
  console.warn(`[install:apps] warning: this is Node ${process.versions.node}, but .nvmrc pins ${pinnedNode}. Run \`nvm use\` (or put Node ${pinnedNode.split(".")[0]} first on PATH) if an install fails.`);
}

for (const target of targets) {
  if (!fs.existsSync(path.join(target.cwd, "package.json"))) {
    throw new Error(`[install:apps] ${target.label} has no package.json`);
  }
  console.log(`[install:apps] npm install (cwd ${target.label})`);
  const result = spawnSync(npm, ["install", ...passthrough], {
    cwd: target.cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[install:apps] ${target.label} install failed with exit code ${result.status}`);
  }
}

// Since Electron 42 `npm install` no longer downloads the binary (it comes on
// first run), so fetch it here the way `npm run dev` does, then verify both
// its final path marker and the executable it names.
const electronDir = path.join(repoRoot, "apps", "desktop", "node_modules", "electron");
const electronPath = path.join(electronDir, "path.txt");
let ensureElectronStatus = null;
if (fs.existsSync(path.join(electronDir, "install.js")) && !process.env.ELECTRON_OVERRIDE_DIST_PATH) {
  // A no-op when the binary is already there.
  const ensured = spawnSync(process.execPath, [path.join(repoRoot, "apps", "desktop", "scripts", "ensure-electron.cjs")], {
    cwd: path.join(repoRoot, "apps", "desktop"),
    stdio: "inherit",
  });
  ensureElectronStatus = ensured.error ? ensured.error.message : ensured.status;
}
const electronRelativePath = fs.existsSync(electronPath) ? fs.readFileSync(electronPath, "utf8").trim() : "";
const electronDist = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronDir, "dist");
const electronExecutable = electronRelativePath ? path.join(electronDist, electronRelativePath) : null;
if (!electronExecutable || !fs.existsSync(electronExecutable)) {
  const repair = fs.existsSync(electronDir)
    ? ensureElectronStatus != null && ensureElectronStatus !== 0
      ? `retry the download (ensure-electron exited ${ensureElectronStatus}; check the network or proxy) by running \`node install.js\` in ${path.relative(repoRoot, electronDir)}`
      : `run \`node scripts/ensure-electron.cjs\` in apps/desktop`
    : "run `npm install` again in apps/desktop";
  const missing = !fs.existsSync(electronPath)
    ? `no ${path.relative(repoRoot, electronPath)}`
    : !electronRelativePath
      ? `an empty ${path.relative(repoRoot, electronPath)}`
      : `missing ${path.relative(repoRoot, electronExecutable)}`;
  throw new Error(
    `[install:apps] Electron's binary didn't finish installing (${missing}).` +
      (nodeMismatch ? ` Switch to Node ${pinnedNode} and` : "") +
      ` ${repair}.`,
  );
}

console.log(`[install:apps] installed ${targets.length} package(s)`);
