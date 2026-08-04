#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const currentRepoRoot = path.resolve(scriptDir, "..");
const APPLE_EVENTS_USAGE_DESCRIPTION =
  "ADE launches agent terminals that can use local app automation through Codex Computer Use.";

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
    "Builds a local packaged ADE channel without using the GitHub release workflow.",
    "macOS produces a .app; Windows produces an NSIS installer, signed when the",
    "Azure signing environment is present and unsigned otherwise.",
    "",
    "Channels:",
    "  alpha    Builds the current checkout as ADE Alpha.",
    "  beta     Fetches origin/main, fast-forwards local main, and builds it as ADE Beta.",
    "",
    "Options:",
    "  --skip-install       Do not run app-local npm install before building.",
    "  --skip-fetch         For beta, do not fetch origin/main before the fast-forward check.",
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

function gitOutput(args, options = {}) {
  const cwd = options.cwd ?? currentRepoRoot;
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} exited with ${result.status ?? "unknown status"}`);
  }
  return result.stdout.trim();
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

function readDesktopVersion(repoRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "utf8"));
  const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  if (!version) fail("apps/desktop/package.json is missing a version.");
  return version;
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

function cleanHostRuntimeArtifacts(repoRoot, target, options) {
  const runtimeRoot = path.join(repoRoot, "apps", "desktop", "resources", "runtime");
  for (const name of runtimeArtifactNames(target)) {
    removePath(path.join(runtimeRoot, name), options.dryRun);
  }
}

function ensureHostRuntimeResources(repoRoot, options, baseEnv = process.env) {
  const target = currentTarget();
  const env = {
    ...baseEnv,
    ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY: "1",
  };
  cleanHostRuntimeArtifacts(repoRoot, target, options);
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

function prepareBetaCheckout(options) {
  if (!options.skipFetch) {
    run("git", ["fetch", "origin", "main"], { cwd: currentRepoRoot, dryRun: options.dryRun });
  }
  if (options.dryRun) {
    run("git", ["merge", "--ff-only", "origin/main"], { cwd: currentRepoRoot, dryRun: true });
    return currentRepoRoot;
  }
  const branch = gitOutput(["branch", "--show-current"]);
  if (branch !== "main") {
    fail("package:beta builds the local main checkout after fetching origin/main. Check out main first, or use --repo <path> for an explicit source.");
  }
  run("git", ["merge", "--ff-only", "origin/main"], { cwd: currentRepoRoot });
  const status = gitOutput(["status", "--porcelain"]);
  if (status) {
    process.stdout.write("[ade] Warning: building beta with local working tree changes. Commit or stash first for a byte-for-byte clean origin/main beta.\n");
  }
  const aheadBehind = gitOutput(["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
  const [ahead = "0"] = aheadBehind.split(/\s+/);
  if (Number(ahead) > 0) {
    process.stdout.write("[ade] Warning: local main has commits not on origin/main. Push first for a remote-main-only beta.\n");
  }
  return currentRepoRoot;
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

function adHocSignLocalMacApp(appPath) {
  if (process.platform !== "darwin") return;
  process.stdout.write(`[ade] Ad-hoc signing local app bundle: ${appPath}\n`);
  run("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], {
    cwd: path.dirname(appPath),
  });
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    cwd: path.dirname(appPath),
  });
}

const AZURE_SIGNING_ENV = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];

/**
 * Build a channel installer on Windows.
 *
 * Unlike the macOS path this does not drive electron-builder directly. The
 * Windows packaging chain (`dist:win`) also materializes and validates runtime
 * and whisper resources, runs the artifact preflight, and runs the release
 * validator afterwards — reimplementing that here would mean maintaining a
 * second copy of a contract the release path depends on. So the channel is
 * expressed purely as environment, and the maintained script does the work.
 *
 * `ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY` + `ADE_WINDOWS_TEST_BUILD` are what
 * relax the Darwin/Linux remote-runtime sidecar requirement, which a Windows
 * host cannot satisfy — it cannot build Darwin binaries. The resulting install
 * therefore cannot bootstrap a remote macOS/Linux runtime; that is a documented
 * gap of local channel builds, not of Windows itself. CI-built installers carry
 * the full sidecar set.
 */
function buildWindowsChannel(repoRoot, channel, config, env, options) {
  const missingSigningEnv = AZURE_SIGNING_ENV.filter((name) => !process.env[name]?.trim());
  const canSign = missingSigningEnv.length === 0 && Boolean(process.env.WINDOWS_SIGNING_EXPECTED_SUBJECT?.trim());
  const distScript = canSign ? "dist:win:signed" : "dist:win";

  if (canSign) {
    process.stdout.write("[ade] Azure signing credentials present - building a signed installer.\n");
  } else {
    const missing = missingSigningEnv.length > 0
      ? missingSigningEnv.join(", ")
      : "WINDOWS_SIGNING_EXPECTED_SUBJECT";
    process.stdout.write(
      `[ade] Building UNSIGNED (missing ${missing}). Windows will show a SmartScreen warning on install.\n`,
    );
  }

  run("npm", ["--prefix", "apps/desktop", "run", distScript], {
    cwd: repoRoot,
    env: {
      ...env,
      ADE_WINDOWS_TEST_BUILD: "1",
      // dist:win:signed reads the Azure service principal from the environment.
      // It is inherited rather than echoed, so no credential is ever printed by
      // the `[ade] <cwd>$ <command>` trace above.
    },
    dryRun: options.dryRun,
  });

  if (options.dryRun) return;
  const outputRoot = path.join(repoRoot, "apps", "desktop", config.outputDir);
  const installer = fs.existsSync(outputRoot)
    ? fs.readdirSync(outputRoot).find((name) => /-win-x64\.exe$/.test(name))
    : null;
  if (!installer) {
    fail(`Build finished but no Windows installer was found in ${outputRoot}.`);
  }
  process.stdout.write(`\n[ade] Built ${config.productName}: ${path.join(outputRoot, installer)}\n`);
  process.stdout.write(`[ade] Signed: ${canSign ? "yes" : "no (SmartScreen warning expected)"}\n`);
  process.stdout.write(`[ade] Bundled CLI name: ${config.cliName}\n`);
  process.stdout.write(`[ade] Channel ADE_HOME: ${config.adeHome}\n`);
  process.stdout.write("[ade] Remote macOS/Linux runtimes are unavailable in a local channel build.\n");
}

function buildChannel(repoRoot, channel, options) {
  const config = CHANNELS[channel];
  ensureRepoRoot(repoRoot, options);
  const desktopRoot = path.join(repoRoot, "apps", "desktop");
  const outputRepoRoot = channel === "beta" && !options.repo ? currentRepoRoot : repoRoot;
  const outputRoot = path.join(outputRepoRoot, "apps", "desktop", config.outputDir);
  const appVersion = readDesktopVersion(repoRoot);
  const env = {
    ...process.env,
    ADE_PACKAGE_CHANNEL: channel,
    ADE_CLI_VERSION: appVersion,
    ADE_DESKTOP_APP_NAME: config.productName,
    ADE_HOME: config.adeHome,
    ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY: "1",
  };

  removePath(outputRoot, options.dryRun);
  assertPackageChannelPrereqs(repoRoot, channel, options);
  installApps(repoRoot, options);
  run("npm", ["--prefix", "apps/ade-cli", "run", "build"], { cwd: repoRoot, env, dryRun: options.dryRun });

  if (process.platform === "win32") {
    buildWindowsChannel(repoRoot, channel, config, env, options);
    return;
  }

  ensureHostRuntimeResources(repoRoot, options, env);
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
    `-c.directories.output=${outputRoot}`,
    `-c.extraMetadata.adePackageChannel=${channel}`,
    `-c.extraMetadata.adeCliName=${config.cliName}`,
    `-c.mac.extendInfo.LSEnvironment.ADE_PACKAGE_CHANNEL=${channel}`,
    `-c.mac.extendInfo.LSEnvironment.ADE_DESKTOP_APP_NAME=${config.productName}`,
    `-c.mac.extendInfo.LSEnvironment.ADE_HOME=${config.adeHome}`,
    `-c.mac.extendInfo.NSAppleEventsUsageDescription=${APPLE_EVENTS_USAGE_DESCRIPTION}`,
  ], { cwd: desktopRoot, env, dryRun: options.dryRun });

  if (options.dryRun) return;
  const appPath = findBuiltApp(outputRoot, config.productName);
  if (!appPath) fail(`Build finished but no .app was found in ${outputRoot}.`);
  postprocessChannelApp(appPath, channel, config, options);
  adHocSignLocalMacApp(appPath);
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
      ? prepareBetaCheckout(parsedOptions)
      : currentRepoRoot;
  buildChannel(selectedRepoRoot, parsedOptions.channel, parsedOptions);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
