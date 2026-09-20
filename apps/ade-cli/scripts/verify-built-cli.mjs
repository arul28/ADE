import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import packagedAdeCliResourcesModule from "../../desktop/scripts/packaged-ade-cli-resources.cjs";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");
const cliPath = path.join(packageRoot, "dist", "cli.cjs");
const { packagedAdeCliBuildResources, sourceContainsPath } = packagedAdeCliResourcesModule;
const bundledRuntimeEntryPaths = (await fs.readdir(distRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".cjs"))
  .map((entry) => path.join(distRoot, entry.name));
const tuiPath = path.join(packageRoot, "dist", "tuiClient", "cli.mjs");
const packageJsonPath = path.join(packageRoot, "package.json");

async function runHelp(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: packageRoot,
    env: process.env,
  });
  if (!stdout.includes("Agent-focused command-line interface for ADE")) {
    throw new Error(`[ade-cli:build] CLI help output did not include the ADE banner text for ${command}`);
  }
}

async function assertVersion(command, args, expectedVersion) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: packageRoot,
    env: process.env,
  });
  const actual = stdout.trim().replace(/^ade\s+/i, "");
  if (actual !== expectedVersion) {
    throw new Error(`[ade-cli:build] CLI version mismatch: expected ${expectedVersion}, got ${actual || "<empty>"}`);
  }
}

async function assertIsolatedTuiHelp() {
  const tuiContents = await fs.readFile(tuiPath, "utf8");
  for (const token of ["__dirname", "__filename"]) {
    if (tuiContents.includes(token) && !tuiContents.includes(`const ${token} =`)) {
      throw new Error(`[ade-cli:build] dist/tuiClient/cli.mjs references ${token} without an ESM shim`);
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-cli-tui-isolated-"));
  try {
    const isolatedTuiPath = path.join(tempDir, "cli.mjs");
    const runnerPath = path.join(tempDir, "run-tui-help.mjs");
    await fs.copyFile(tuiPath, isolatedTuiPath);
    await fs.writeFile(
      runnerPath,
      "const tui = await import('./cli.mjs');\nprocess.exitCode = await tui.runAdeCodeCli(['--help']);\n",
      "utf8",
    );
    const { stdout } = await execFileAsync(process.execPath, [runnerPath], {
      cwd: tempDir,
      env: {
        ...process.env,
        NODE_PATH: "",
      },
    });
    if (!stdout.includes("Terminal-native ADE Work chat.")) {
      throw new Error("[ade-cli:build] isolated TUI help output did not include the ADE code banner text");
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Run `cli.cjs --help` the way the packaged app resolves it.
 *
 * tsup externalizes every package dependency, and the packaged CLI sits at
 * Resources/ade-cli/dist/cli.cjs with no node_modules beside it, so its
 * externals resolve ONLY through NODE_PATH into the desktop package's
 * production tree (apps/desktop/src/main/services/runtime/packagedNodePath.ts).
 * This checkout hoists dev-only packages next to the production ones, so an
 * unshipped module-scope require passes every in-checkout run here and only
 * fails inside release-core's packaged smoke, after signing and notarization.
 * v1.2.75's first release run died exactly that way on `string-width`.
 *
 * So: copy the bundle into a directory with no node_modules, expose the
 * desktop package's production tree — the flattened top-level packages
 * electron-builder ships into app.asar, read from the lock file — in a
 * SIBLING directory on NODE_PATH, and run --help.
 *
 * Scope: this proves module-scope requires on the --help path only. A deeper
 * command path can still reach an unshipped external, and the packaged CLI
 * runs under Electron's Node rather than the CI Node used here; a green gate
 * is a preflight, not proof of the packaged runtime.
 */
async function assertPackagedResolutionCliHelp() {
  const desktopRoot = path.join(packageRoot, "..", "desktop");
  const lock = JSON.parse(await fs.readFile(path.join(desktopRoot, "package-lock.json"), "utf8"));
  const productionNames = Object.keys(lock.packages ?? {})
    .filter((key) => /^node_modules\/(@[^/]+\/)?[^/]+$/.test(key) && !lock.packages[key].dev)
    .map((key) => key.slice("node_modules/".length));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ade-cli-packaged-resolution-"));
  const createdLinks = [];
  try {
    const nodeModules = path.join(tempRoot, "shipped-node-modules");
    const appDir = path.join(tempRoot, "app");
    await fs.mkdir(appDir, { recursive: true });
    const notInstalled = [];
    for (const name of productionNames) {
      const source = path.join(desktopRoot, "node_modules", name);
      try {
        await fs.access(source);
      } catch {
        notInstalled.push(name);
        continue;
      }
      const target = path.join(nodeModules, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
      createdLinks.push(target);
    }
    const isolatedCliPath = path.join(appDir, "cli.cjs");
    await fs.copyFile(cliPath, isolatedCliPath);
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync(process.execPath, [isolatedCliPath, "--help"], {
        cwd: appDir,
        env: { ...process.env, NODE_PATH: nodeModules },
      }));
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
      const missing = stderr.match(/Cannot find module '([^']+)'/)?.[1];
      const bare = missing?.replace(/^(@[^/]+\/[^/]+|[^/]+).*$/, "$1");
      let detail = `: ${stderr.trim().split("\n")[0]}`;
      if (missing && bare && notInstalled.includes(bare)) {
        detail = `: "${bare}" is a shipped production dependency that is not installed in this checkout; ` +
          "run npm ci in apps/desktop and rebuild.";
      } else if (missing) {
        detail = `: bare require("${missing}") is reached at module scope but is not in apps/desktop's ` +
          "production dependency tree. Inline it in tsup noExternal (see string-width), or make it a " +
          "production dependency of the desktop package.";
      }
      throw new Error(`[ade-cli:build] dist/cli.cjs --help failed under packaged module resolution${detail}`);
    }
    if (!stdout.includes("Agent-focused command-line interface for ADE")) {
      throw new Error("[ade-cli:build] packaged-resolution CLI help output did not include the ADE banner text");
    }
  } finally {
    // Remove the links themselves before the tree, so no rm implementation
    // can be tempted to descend into apps/desktop/node_modules through one.
    for (const link of createdLinks) {
      await fs.unlink(link).catch(() => {});
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const contents = await fs.readFile(cliPath, "utf8");
const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
const expectedVersion = process.env.ADE_CLI_VERSION?.trim() || packageJson.version;
if (!expectedVersion) {
  throw new Error("[ade-cli:build] Unable to resolve expected CLI version from ADE_CLI_VERSION or package.json");
}

if (!contents.startsWith("#!/usr/bin/env node")) {
  throw new Error("[ade-cli:build] dist/cli.cjs is missing the node shebang");
}

const normalized = contents.replace(/require\((["'])sqlite\1\)/g, 'require("node:sqlite")');
if (normalized !== contents) {
  await fs.writeFile(cliPath, normalized, "utf8");
}

for (const entryPath of bundledRuntimeEntryPaths) {
  const entryContents = await fs.readFile(entryPath, "utf8");
  if (/require\((["'])@opencode-ai\/sdk\1\)/.test(entryContents)) {
    throw new Error(
      `[ade-cli:build] ${path.relative(packageRoot, entryPath)} contains a bare require("@opencode-ai/sdk"); ` +
        "inline the ESM-only SDK in tsup instead.",
    );
  }
}

const packagedBuildResources = packagedAdeCliBuildResources();
for (const entryPath of [...bundledRuntimeEntryPaths, tuiPath]) {
  if (packagedBuildResources.some((resource) => sourceContainsPath(resource.sourcePath, entryPath))) {
    continue;
  }
  throw new Error(
    `[ade-cli:build] ${path.relative(packageRoot, entryPath)} is not shipped by ` +
      "apps/desktop/package.json build.extraResources",
  );
}

for (const marker of ["__ade-usage-ledger-worker", "Usage ledger worker input is invalid"]) {
  if (!contents.includes(marker)) {
    throw new Error(`[ade-cli:build] dist/cli.cjs is missing embedded usage ledger worker marker: ${marker}`);
  }
}

const stat = await fs.stat(cliPath);
if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
  throw new Error("[ade-cli:build] dist/cli.cjs is not executable");
}

await runHelp(process.execPath, [cliPath, "--help"]);
await assertVersion(process.execPath, [cliPath, "--version"], expectedVersion);
await assertIsolatedTuiHelp();
await assertPackagedResolutionCliHelp();

if (process.platform !== "win32") {
  await runHelp(cliPath, ["--help"]);
  await assertVersion(cliPath, ["--version"], expectedVersion);
}

console.log("[ade-cli:build] verified dist/cli.cjs binary");
