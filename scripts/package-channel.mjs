#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const currentRepoRoot = path.resolve(scriptDir, "..");

const CHANNELS = {
  alpha: {
    source: "current",
    productName: "ADE Alpha",
    appId: "com.ade.desktop.alpha",
    cliName: "ade-alpha",
    adeHome: path.join(os.homedir(), ".ade-alpha"),
    outputDir: "release-alpha",
  },
  beta: {
    source: "origin-main",
    productName: "ADE Beta",
    appId: "com.ade.desktop.beta",
    cliName: "ade-beta",
    adeHome: path.join(os.homedir(), ".ade-beta"),
    outputDir: "release-beta",
  },
};

function usage() {
  process.stdout.write([
    "Usage: node scripts/package-channel.mjs <alpha|beta> [options]",
    "",
    "Builds a local packaged macOS ADE channel without using the GitHub release workflow.",
    "",
    "Channels:",
    "  alpha    Builds the current checkout as ADE Alpha.",
    "  beta     Builds origin/main in a temporary worktree as ADE Beta.",
    "",
    "Options:",
    "  --skip-install       Do not run app-local npm install before building.",
    "  --skip-fetch         For beta, do not fetch origin/main before creating the worktree.",
    "  --dry-run            Print the commands without running them.",
    "  --repo <path>        Internal/debug: build the selected channel from an existing repo path.",
    "  --help               Show this help.",
    "",
  ].join("\n"));
}

function fail(message) {
  process.stderr.write(`[ade] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    channel: null,
    skipInstall: false,
    skipFetch: false,
    dryRun: false,
    repo: null,
  };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--skip-install") {
      options.skipInstall = true;
      continue;
    }
    if (arg === "--skip-fetch") {
      options.skipFetch = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--repo") {
      const value = args.shift();
      if (!value) fail("--repo requires a path.");
      options.repo = path.resolve(value);
      continue;
    }
    if (arg.startsWith("--repo=")) {
      options.repo = path.resolve(arg.slice("--repo=".length));
      continue;
    }
    if (arg.startsWith("-")) fail(`Unknown option: ${arg}`);
    if (options.channel) fail(`Unexpected extra argument: ${arg}`);
    options.channel = arg;
  }
  if (!options.channel) fail("Missing channel. Use alpha or beta.");
  if (!CHANNELS[options.channel]) fail(`Unknown channel: ${options.channel}`);
  return options;
}

function run(command, args, options = {}) {
  const cwd = options.cwd ?? currentRepoRoot;
  const env = options.env ?? process.env;
  const printable = [command, ...args].join(" ");
  process.stdout.write(`[ade] ${cwd}$ ${printable}\n`);
  if (options.dryRun) return;
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return;
    throw new Error(`${printable} exited with ${result.status ?? "unknown status"}`);
  }
}

function removePath(targetPath, dryRun) {
  if (dryRun) {
    process.stdout.write(`[ade] rm -rf ${targetPath}\n`);
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function currentTarget() {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${platform}-${arch}`;
}

function runtimeArtifactNames(target) {
  return [`ade-${target}`, `ade-${target}.native.tar.gz`];
}

function assertRuntimeArtifacts(repoRoot, target) {
  const runtimeRoot = path.join(repoRoot, "apps", "desktop", "resources", "runtime");
  for (const name of runtimeArtifactNames(target)) {
    const artifactPath = path.join(runtimeRoot, name);
    const stat = fs.existsSync(artifactPath) ? fs.statSync(artifactPath) : null;
    if (!stat?.isFile() || stat.size <= 0) {
      fail(`Missing host runtime artifact after build: ${artifactPath}`);
    }
  }
}

function ensureHostRuntimeResources(repoRoot, options) {
  const target = currentTarget();
  const env = {
    ...process.env,
    ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY: "1",
  };
  run("npm", [
    "--prefix",
    "apps/desktop",
    "run",
    "materialize:runtime-resources",
  ], { cwd: repoRoot, env, dryRun: options.dryRun });
  if (!options.dryRun) assertRuntimeArtifacts(repoRoot, target);
  cleanRuntimeBuildIntermediates(repoRoot, target, options);
}

function cleanRuntimeBuildIntermediates(repoRoot, target, options) {
  const runtimeRoot = path.join(repoRoot, "apps", "desktop", "resources", "runtime");
  removePath(path.join(runtimeRoot, ".sea"), options.dryRun);
  removePath(path.join(runtimeRoot, `ade-${target}.native`), options.dryRun);
}

function ensureRepoRoot(repoRoot, options) {
  if (options.dryRun && !fs.existsSync(repoRoot)) return;
  if (!fs.existsSync(path.join(repoRoot, "apps", "desktop", "package.json"))) {
    fail(`${repoRoot} is not an ADE repo root.`);
  }
}

function packageScriptExists(repoRoot, packagePath, scriptName) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, packagePath), "utf8"));
    return typeof packageJson?.scripts?.[scriptName] === "string";
  } catch {
    return false;
  }
}

function assertPackageChannelPrereqs(repoRoot, channel, options) {
  if (options.dryRun && !fs.existsSync(repoRoot)) return;
  if (packageScriptExists(repoRoot, path.join("apps", "ade-cli", "package.json"), "build:static")) return;
  if (channel === "beta") {
    throw new Error(
      "origin/main does not include ADE's static runtime packaging script yet. " +
        "Run npm run package:beta after this branch lands on main, or build Alpha from the current checkout.",
    );
  }
  throw new Error("apps/ade-cli/package.json is missing the build:static script required for local channel packages.");
}

function prepareBetaWorktree(options) {
  const worktreeRoot = path.join(currentRepoRoot, ".ade", "build-worktrees", "beta");
  if (!options.skipFetch) {
    run("git", ["fetch", "origin", "main"], { cwd: currentRepoRoot, dryRun: options.dryRun });
  }
  run("git", ["worktree", "remove", "--force", worktreeRoot], {
    cwd: currentRepoRoot,
    dryRun: options.dryRun,
    allowFailure: true,
  });
  removePath(worktreeRoot, options.dryRun);
  run("git", ["worktree", "add", "--force", "--detach", worktreeRoot, "origin/main"], {
    cwd: currentRepoRoot,
    dryRun: options.dryRun,
  });
  return worktreeRoot;
}

function installApps(repoRoot, options) {
  if (options.skipInstall) return;
  run("npm", ["--prefix", "apps/ade-cli", "install"], { cwd: repoRoot, dryRun: options.dryRun });
  run("npm", ["--prefix", "apps/desktop", "install"], { cwd: repoRoot, dryRun: options.dryRun });
}

function findBuiltApp(outputRoot, productName) {
  const matches = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        matches.push(entryPath);
        continue;
      }
      if (entry.isDirectory()) walk(entryPath);
    }
  };
  walk(outputRoot);
  const exact = matches.find((candidate) => path.basename(candidate) === `${productName}.app`);
  return exact ?? matches[0] ?? null;
}

function zipApp(appPath, outputRoot, channel, options) {
  if (process.platform !== "darwin") return null;
  const zipPath = path.join(outputRoot, `${CHANNELS[channel].productName.replace(/\s+/g, "-")}-local.zip`);
  removePath(zipPath, options.dryRun);
  run("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], {
    cwd: path.dirname(appPath),
    dryRun: options.dryRun,
  });
  return zipPath;
}

function postprocessChannelApp(appPath, channel, config, options) {
  const resourcesRoot = path.join(appPath, "Contents", "Resources");
  const cliRoot = path.join(resourcesRoot, "ade-cli");
  const binRoot = path.join(cliRoot, "bin");
  const sourceWrapper = path.join(binRoot, "ade");
  const channelWrapper = path.join(binRoot, config.cliName);
  if (options.dryRun) {
    process.stdout.write(`[ade] stamp ${config.cliName} in ${appPath}\n`);
    return;
  }
  if (!fs.existsSync(sourceWrapper)) fail(`Packaged app is missing bundled CLI wrapper: ${sourceWrapper}`);
  fs.copyFileSync(sourceWrapper, channelWrapper);
  fs.chmodSync(sourceWrapper, 0o755);
  fs.chmodSync(channelWrapper, 0o755);
  fs.writeFileSync(path.join(cliRoot, "channel"), `${channel}\n`);
}

function buildChannel(repoRoot, channel, options) {
  const config = CHANNELS[channel];
  ensureRepoRoot(repoRoot, options);
  const desktopRoot = path.join(repoRoot, "apps", "desktop");
  const outputRoot = path.join(desktopRoot, config.outputDir);
  const env = {
    ...process.env,
    ADE_PACKAGE_CHANNEL: channel,
    ADE_DESKTOP_APP_NAME: config.productName,
    ADE_HOME: config.adeHome,
    ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
    ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY: "1",
  };

  removePath(outputRoot, options.dryRun);
  assertPackageChannelPrereqs(repoRoot, channel, options);
  installApps(repoRoot, options);
  run("npm", ["--prefix", "apps/ade-cli", "run", "build"], { cwd: repoRoot, env, dryRun: options.dryRun });
  ensureHostRuntimeResources(repoRoot, options);
  run("npm", ["--prefix", "apps/desktop", "run", "build"], { cwd: repoRoot, env, dryRun: options.dryRun });
  run("npx", [
    "electron-builder",
    "--dir",
    "--mac",
    "--publish",
    "never",
    "-c.mac.identity=null",
    "-c.mac.notarize=false",
    `-c.appId=${config.appId}`,
    `-c.productName=${config.productName}`,
    `-c.mac.icon=build/icon.${channel}.icns`,
    `-c.directories.output=${config.outputDir}`,
    `-c.extraMetadata.adePackageChannel=${channel}`,
    `-c.extraMetadata.adeCliName=${config.cliName}`,
    `-c.mac.extendInfo.LSEnvironment.ADE_PACKAGE_CHANNEL=${channel}`,
    `-c.mac.extendInfo.LSEnvironment.ADE_DESKTOP_APP_NAME=${config.productName}`,
    `-c.mac.extendInfo.LSEnvironment.ADE_HOME=${config.adeHome}`,
    "-c.mac.extendInfo.LSEnvironment.ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1",
  ], { cwd: desktopRoot, env, dryRun: options.dryRun });

  if (options.dryRun) return;
  const appPath = findBuiltApp(outputRoot, config.productName);
  if (!appPath) fail(`Build finished but no .app was found in ${outputRoot}.`);
  postprocessChannelApp(appPath, channel, config, options);
  const zipPath = zipApp(appPath, outputRoot, channel, options);
  process.stdout.write(`\n[ade] Built ${config.productName}: ${appPath}\n`);
  if (zipPath) process.stdout.write(`[ade] Zipped app: ${zipPath}\n`);
  process.stdout.write(`[ade] Bundled CLI name: ${config.cliName}\n`);
  process.stdout.write(`[ade] Channel ADE_HOME: ${config.adeHome}\n`);
}

let parsedOptions = null;
let selectedRepoRoot = null;

try {
  parsedOptions = parseArgs(process.argv.slice(2));
  selectedRepoRoot = parsedOptions.repo
    ? parsedOptions.repo
    : parsedOptions.channel === "beta"
      ? prepareBetaWorktree(parsedOptions)
      : currentRepoRoot;
  buildChannel(selectedRepoRoot, parsedOptions.channel, parsedOptions);
} catch (error) {
  if (parsedOptions?.channel === "beta" && !parsedOptions.repo && selectedRepoRoot && !parsedOptions.dryRun) {
    spawnSync("git", ["worktree", "remove", "--force", selectedRepoRoot], {
      cwd: currentRepoRoot,
      stdio: "ignore",
    });
    fs.rmSync(selectedRepoRoot, { recursive: true, force: true });
  }
  fail(error instanceof Error ? error.message : String(error));
}
