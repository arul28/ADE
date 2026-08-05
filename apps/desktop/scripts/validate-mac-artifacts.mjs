import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import asar from "@electron/asar";
import { parse as parseYaml } from "yaml";
import packagedAdeCliResourcesModule from "./packaged-ade-cli-resources.cjs";
import runtimeResourceTargets from "./runtime-resource-targets.cjs";
import { RUNTIME_FETCHED_TOOL_EXPLANATION } from "./runtime-fetched-tool-packages.mjs";
import { createPackagedTreeAssertions, findNodePtyAddon } from "./validate-packaged-tree.mjs";

const { RUNTIME_TARGETS, runtimeBinaryNameForTarget } = runtimeResourceTargets;

// Every failure in this validator is prefixed "[release:mac]". The shared
// packaged-tree assertions report through this, so their messages read exactly
// as the hand-written ones they replaced.
function fail(message) {
  throw new Error(`[release:mac] ${message}`);
}

const {
  assertAsarEmbedsNoRuntimeFetchedToolPayload,
  assertBundledAgentSkills,
  assertNoRuntimeFetchedToolPackages,
  assertPackagedTreeSizeBudget,
  assertPackagedTuiEsmShims,
  assertPathExists,
  assertPathMissing,
  assertRuntimeToolJsEntryPointsPresent,
  readByteLimit,
} = createPackagedTreeAssertions({ fail });

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const releaseDir = path.join(appDir, "release");
const DEFAULT_MAX_APP_ASAR_BYTES = 900 * 1024 * 1024;
// Per-arch macOS builds carry only their own arch's agent runtimes + remote
// runtime sidecar. Universal builds carry both darwin runtime payloads.
const DEFAULT_MAX_UNPACKED_BYTES = 1280 * 1024 * 1024;
const DEFAULT_MAX_UNIVERSAL_UNPACKED_BYTES = 1600 * 1024 * 1024;
const EXPECTED_APPLICATION_IDENTIFIER = "VQ372F39G6.com.ade.desktop";
const EXPECTED_KEYCHAIN_ACCESS_GROUP = "VQ372F39G6.com.ade.desktop.webauthn";
const ALLOWED_KEYCHAIN_ACCESS_GROUP = "VQ372F39G6.*";
const {
  missingRequiredPackagedAdeCliPayloadPaths,
  packagedAdeCliPayloadFiles,
} = packagedAdeCliResourcesModule;
const bundledAdeCliFiles = packagedAdeCliPayloadFiles({ desktopRoot: appDir })
  .map((resource) => [
    resource.relativePath,
    `bundled ADE CLI resource ${resource.to}`,
  ]);
const missingRequiredBundledAdeCliFiles = missingRequiredPackagedAdeCliPayloadPaths(
  bundledAdeCliFiles.map(([relativePath]) => ({ relativePath })),
);
if (missingRequiredBundledAdeCliFiles.length > 0) {
  throw new Error(
    `[release:mac] package.json build.extraResources omits required ADE CLI payload: ` +
      missingRequiredBundledAdeCliFiles.join(", "),
  );
}

function readFlag(name) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length).trim();
    }
  }
  return null;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function currentTarget() {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${platform}-${arch}`;
}

function resolveAbsolute(input) {
  if (!input) return null;
  return path.isAbsolute(input) ? input : path.resolve(appDir, input);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRuntimeUnpackedPath(resourcesPath) {
  const archAsarPath = path.join(resourcesPath, process.arch === "arm64" ? "app-arm64.asar.unpacked" : "app-x64.asar.unpacked");
  if (await pathExists(archAsarPath)) {
    return archAsarPath;
  }
  return path.join(resourcesPath, "app.asar.unpacked");
}

async function resolveRuntimeUnpackedPaths(resourcesPath) {
  const candidates = [
    path.join(resourcesPath, "app.asar.unpacked"),
    path.join(resourcesPath, "app-arm64.asar.unpacked"),
    path.join(resourcesPath, "app-x64.asar.unpacked"),
  ];
  const existing = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

async function assertExecutable(targetPath, description) {
  const stat = await fs.stat(targetPath);
  if ((stat.mode & 0o111) !== 0o111) {
    throw new Error(`[release:mac] Expected ${description} to be executable: ${targetPath}`);
  }
}

async function assertRemoteRuntimeBundle(resourcesPath, description, expectedArch) {
  const runtimeRoot = path.join(resourcesPath, "runtime");
  // A macOS bundle carries ONLY its own darwin sidecar; universal carries both
  // darwin arches. Every other target -- including win32-x64, which used to ride
  // along and cost ~500 MB of the update zip -- must be absent.
  const requiredTargets =
    expectedArch === "universal" ? ["darwin-arm64", "darwin-x64"] : [`darwin-${expectedArch}`];
  const excludedTargets = RUNTIME_TARGETS.filter((target) => !requiredTargets.includes(target));
  await assertPathExists(runtimeRoot, `remote runtime bundle directory for ${description}`);
  for (const requiredTarget of requiredTargets) {
    const binaryPath = path.join(runtimeRoot, `ade-${requiredTarget}`);
    const nativeArchivePath = path.join(runtimeRoot, `ade-${requiredTarget}.native.tar.gz`);
    await assertPathExists(binaryPath, `remote runtime binary ${requiredTarget} for ${description}`);
    await assertExecutable(binaryPath, `remote runtime binary ${requiredTarget}`);
    await assertPathExists(nativeArchivePath, `remote runtime native dependency archive ${requiredTarget} for ${description}`);
    const { stdout } = await execFileAsync("tar", ["-tzf", nativeArchivePath]);
    const archiveEntries = stdout.split(/\r?\n/);
    if (!archiveEntries.some((entry) => entry.startsWith("./node_modules/"))) {
      throw new Error(`[release:mac] Remote runtime native archive for ${requiredTarget} does not contain ./node_modules/: ${nativeArchivePath}`);
    }
    if (!archiveEntries.includes("./tuiClient/cli.mjs")) {
      throw new Error(`[release:mac] Remote runtime native archive for ${requiredTarget} does not contain ./tuiClient/cli.mjs: ${nativeArchivePath}`);
    }
    if (!archiveEntries.includes(`./vendor/crsqlite/${requiredTarget}/crsqlite.dylib`)) {
      throw new Error(`[release:mac] Remote runtime native archive for ${requiredTarget} does not contain cr-sqlite: ${nativeArchivePath}`);
    }
  }
  for (const target of excludedTargets) {
    await assertPathMissing(path.join(runtimeRoot, runtimeBinaryNameForTarget(target)), `non-target remote runtime binary ${target} for ${description}`);
    await assertPathMissing(path.join(runtimeRoot, `ade-${target}.native.tar.gz`), `non-target remote runtime native archive ${target} for ${description}`);
  }
  const runtimeEntries = await fs.readdir(runtimeRoot, { withFileTypes: true });
  const stagingDirectories = runtimeEntries
    .filter((entry) => entry.isDirectory() && (entry.name === ".sea" || entry.name.endsWith(".native")))
    .map((entry) => entry.name)
    .sort();
  if (stagingDirectories.length > 0) {
    throw new Error(
      `[release:mac] Remote runtime bundle for ${description} contains staging directories: ${stagingDirectories.join(", ")}`
    );
  }
}

/**
 * The packaged smoke used to require source === "bundled" for all three agent
 * CLIs. That expectation is now inverted: "bundled" means the packaging
 * exclusions regressed and the build is shipping payload the resolver would
 * never have reached anyway (the tools cache is consulted first). Everything
 * else - a populated cache, a user install, or the not-yet-fetched fallback - is
 * a working resolver.
 */
function assertFetchedToolResolution(label, source, executablePath, appPath) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error(`[release:mac] Packaged smoke did not report a ${label} executable source`);
  }
  if (source === "bundled") {
    // Only a bundled copy INSIDE the app under validation is a packaging leak.
    // On a build/CI host the packaged app sits inside the repo checkout, so the
    // resolvers' dev fallback legitimately finds the checkout's node_modules —
    // an environmental artifact, not shipped bytes. The asar/unpacked content
    // gates (assertNoRuntimeFetchedToolPayload) prove the artifact itself is
    // clean either way.
    const resolved = path.resolve(String(executablePath ?? ""));
    const appRoot = path.resolve(appPath) + path.sep;
    if (resolved.startsWith(appRoot)) {
      throw new Error(
        `[release:mac] ${label} resolved to a bundled copy inside the packaged app at ${resolved}; `
        + `the packaged app must not carry the native platform packages. ${RUNTIME_FETCHED_TOOL_EXPLANATION}`,
      );
    }
    console.log(
      `[release:mac] ${label} resolved to the build host's checkout copy at ${resolved} (outside the app); `
      + "environmental on CI, absent on user machines.",
    );
    return;
  }
  console.log(`[release:mac] ${label} executable resolved from "${source}".`);
}

/**
 * Codex, Claude Code and OpenCode native platform packages are fetched into the
 * machine tools cache at runtime, so none of them may ship - not even the
 * on-target arch. The JS entry points still must, and are checked here too:
 * over-broad `!` exclusions in build.files would take the SDK out with the
 * native siblings, and that breaks the product rather than merely bloating it.
 */
async function assertNoRuntimeFetchedToolPayload(nodeModulesPath, description) {
  await assertNoRuntimeFetchedToolPackages({
    nodeModulesPath,
    report: "aggregate",
    description,
  });
  await assertRuntimeToolJsEntryPointsPresent({
    nodeModulesPath,
    labelSuffix: ` for ${description}`,
  });
}

async function assertBundledCrsqliteRuntime(unpackedPath, description, expectedArch) {
  const arches = expectedArch === "universal" ? ["arm64", "x64"] : [expectedArch];
  for (const arch of arches) {
    const dylibPath = path.join(unpackedPath, "vendor", "crsqlite", `darwin-${arch}`, "crsqlite.dylib");
    await assertPathExists(dylibPath, `bundled cr-sqlite runtime for ${description}`);
  }
}

async function assertBundledAttentionNotch(resourcesPath, description) {
  const helperPath = path.join(resourcesPath, "native", "ade-attention-notch");
  const resourceBundlePath = path.join(
    resourcesPath,
    "native",
    "ADEAttentionNotch_ADEAttentionNotch.bundle",
  );
  await assertPathExists(helperPath, `native Attention Notch helper for ${description}`);
  await assertExecutable(helperPath, `native Attention Notch helper for ${description}`);
  await assertPathExists(
    resourceBundlePath,
    `native Attention Notch resource bundle for ${description}`,
  );
  const { stdout } = await execFileAsync("lipo", ["-archs", helperPath]);
  const architectures = new Set(stdout.trim().split(/\s+/).filter(Boolean));
  for (const architecture of ["arm64", "x86_64"]) {
    if (!architectures.has(architecture)) {
      throw new Error(
        `[release:mac] Native Attention Notch helper for ${description} is missing ${architecture}: ${helperPath}`,
      );
    }
  }
}

function assertAppAsarContains(appAsarPath, relativePaths, description) {
  const entries = new Set(asar.listPackage(appAsarPath));
  const missing = relativePaths.filter((relativePath) => !entries.has(`/${relativePath}`));
  if (missing.length > 0) {
    throw new Error(
      `[release:mac] Missing startup runtime module(s) in app.asar for ${description}: ${missing.join(", ")}`
    );
  }
}

function assertPackagedStartupModules(appAsarPath, description) {
  assertAppAsarContains(appAsarPath, [
    "node_modules/electron-updater/out/main.js",
    "node_modules/fs-extra/lib/fs/index.js",
    "node_modules/graceful-fs/graceful-fs.js",
    "node_modules/jsonfile/index.js",
    "node_modules/universalify/index.js",
  ], description);
}

function pathReferencesPackedAsar(targetPath) {
  const normalized = targetPath.split(path.sep).join("/");
  return normalized.split("/").some((segment) => segment.endsWith(".asar") && !segment.endsWith(".asar.unpacked"));
}

async function findNodePtySpawnHelper(moduleRootPath) {
  const candidateRoots = [
    path.join(moduleRootPath, "build", "Release"),
    path.join(moduleRootPath, "build", "Debug"),
    path.join(moduleRootPath, "prebuilds", "darwin-arm64"),
    path.join(moduleRootPath, "prebuilds", "darwin-x64"),
  ];

  for (const candidateRoot of candidateRoots) {
    try {
      await fs.access(candidateRoot);
    } catch {
      continue;
    }

    const helperPath = path.join(candidateRoot, "spawn-helper");
    try {
      await fs.access(helperPath);
      return helperPath;
    } catch {
      // keep looking
    }
  }

  return null;
}

async function findArtifact(regex, description) {
  const entries = await fs.readdir(releaseDir, { withFileTypes: true });
  const matches = entries
    .filter((entry) => entry.isFile() && regex.test(entry.name))
    .map((entry) => path.join(releaseDir, entry.name))
    .sort();

  if (matches.length === 0) {
    throw new Error(`[release:mac] Unable to find ${description} in ${releaseDir}`);
  }

  if (matches.length > 1) {
    throw new Error(
      `[release:mac] Found multiple ${description} artifacts in ${releaseDir}: ${matches
        .map((filePath) => path.basename(filePath))
        .join(", ")}`
    );
  }

  return matches[0];
}

async function validateSignedApp(appPath, description) {
  console.log(`[release:mac] Validating ${description}: ${appPath}`);
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
  await execFileAsync("xcrun", ["stapler", "validate", appPath]);
  await execFileAsync("spctl", ["-a", "-vvv", "--type", "execute", appPath]);
}

async function validateProvisionedWebAuthnEntitlement(appPath, description) {
  const embeddedProfilePath = path.join(appPath, "Contents", "embedded.provisionprofile");
  await assertPathExists(embeddedProfilePath, `embedded Developer ID provisioning profile for ${description}`);

  const { stdout: profileXml } = await execFileAsync("security", ["cms", "-D", "-i", embeddedProfilePath]);
  if (!profileXml.includes(`<string>${EXPECTED_APPLICATION_IDENTIFIER}</string>`)) {
    throw new Error(
      `[release:mac] Embedded provisioning profile for ${description} does not authorize ${EXPECTED_APPLICATION_IDENTIFIER}`,
    );
  }
  if (
    !profileXml.includes(`<string>${EXPECTED_KEYCHAIN_ACCESS_GROUP}</string>`) &&
    !profileXml.includes(`<string>${ALLOWED_KEYCHAIN_ACCESS_GROUP}</string>`)
  ) {
    throw new Error(
      `[release:mac] Embedded provisioning profile for ${description} does not authorize ${EXPECTED_KEYCHAIN_ACCESS_GROUP}`,
    );
  }

  const { stdout: entitlementStdout, stderr: entitlementStderr } = await execFileAsync(
    "codesign",
    ["--display", "--entitlements", ":-", appPath],
  );
  const signedEntitlements = `${entitlementStdout}\n${entitlementStderr}`;
  if (!signedEntitlements.includes(`<string>${EXPECTED_KEYCHAIN_ACCESS_GROUP}</string>`)) {
    throw new Error(
      `[release:mac] Signed ${description} is missing keychain access group ${EXPECTED_KEYCHAIN_ACCESS_GROUP}`,
    );
  }

  console.log(`[release:mac] Provisioned WebAuthn entitlement passed for ${description}`);
}

async function validatePackageHygiene(appPath, description, expectedArch) {
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const appAsarPath = path.join(resourcesPath, "app.asar");
  const unpackedPaths = await resolveRuntimeUnpackedPaths(resourcesPath);

  if (unpackedPaths.length === 0) {
    throw new Error(`[release:mac] Missing unpacked runtime payload for ${description}: ${resourcesPath}`);
  }

  await assertPackagedTreeSizeBudget({
    appAsarPath,
    unpackedPaths,
    maxAppAsarBytes: readByteLimit("ADE_MAX_APP_ASAR_BYTES", DEFAULT_MAX_APP_ASAR_BYTES),
    maxUnpackedBytes: readByteLimit(
      "ADE_MAX_APP_ASAR_UNPACKED_BYTES",
      expectedArch === "universal" ? DEFAULT_MAX_UNIVERSAL_UNPACKED_BYTES : DEFAULT_MAX_UNPACKED_BYTES,
    ),
    unpackedLabel: "unpacked runtime payload",
    subject: ` for ${description}`,
  });

  // NEW on macOS, and the one behaviour this extraction adds rather than moves.
  // The check existed only on the Windows side, yet the regression it catches is
  // platform-independent: a package dropped from asarUnpack without a matching
  // build.files negation is packed *into* the archive, where the unpacked-tree
  // assertions above cannot see it. A universal bundle carries a per-arch asar
  // next to the shared one, so every archive that has an unpacked sibling is
  // checked, not just app.asar.
  const asarPaths = new Set([
    appAsarPath,
    ...unpackedPaths.map((unpackedPath) => unpackedPath.replace(/\.unpacked$/, "")),
  ]);
  for (const asarPath of asarPaths) {
    if (await pathExists(asarPath)) {
      await assertAsarEmbedsNoRuntimeFetchedToolPayload(asarPath);
    }
  }

  console.log(`[release:mac] Package hygiene passed for ${description}`);
}

async function validatePackagedRuntime(appPath, description, expectedArch, options = {}) {
  // The executable smoke runs the packaged app; only do it for the arch matching
  // the validating host (running an x64 app under Rosetta on an arm64 CI runner
  // is unreliable). The non-host arch still gets full structural validation.
  const deepSmoke = options.deepSmoke !== false;
  const appName = path.basename(appPath, ".app");
  const executablePath = path.join(appPath, "Contents", "MacOS", appName);
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const appAsarPath = path.join(resourcesPath, "app.asar");
  const unpackedPath = await resolveRuntimeUnpackedPath(resourcesPath);
  const adeCliTuiPath = path.join(resourcesPath, "ade-cli", "tuiClient", "cli.mjs");
  const adeCliBinPath = path.join(resourcesPath, "ade-cli", "bin", "ade");
  const adeCliInstallerPath = path.join(resourcesPath, "ade-cli", "install-path.sh");
  const bundledAgentSkillsRoot = path.join(resourcesPath, "agent-skills");
  const nodeModulesPath = path.join(unpackedPath, "node_modules");
  const nodePtyModulePath = path.join(nodeModulesPath, "node-pty");
  const smokeScriptPath = path.join(unpackedPath, "dist", "main", "packagedRuntimeSmoke.cjs");

  console.log(`[release:mac] Smoke testing packaged runtime payload for ${description}`);
  await assertPathExists(executablePath, "packaged app executable");
  await assertPathExists(appAsarPath, "app.asar payload");
  await assertPathExists(unpackedPath, "unpacked runtime payload");
  assertPackagedStartupModules(appAsarPath, description);
  for (const [relativePath, label] of bundledAdeCliFiles) {
    await assertPathExists(path.join(resourcesPath, "ade-cli", relativePath), label);
  }
  await assertBundledAgentSkills(bundledAgentSkillsRoot);
  await assertExecutable(adeCliBinPath, "bundled ADE CLI wrapper");
  await assertExecutable(adeCliInstallerPath, "bundled ADE CLI PATH installer");
  await assertPathExists(nodePtyModulePath, "unpacked node-pty module");
  await assertPathExists(smokeScriptPath, "unpacked packaged runtime smoke script");
  await assertBundledAttentionNotch(resourcesPath, description);
  await assertNoRuntimeFetchedToolPayload(nodeModulesPath, description);
  await assertBundledCrsqliteRuntime(unpackedPath, description, expectedArch);
  assertPackagedTuiEsmShims(await fs.readFile(adeCliTuiPath, "utf8"));
  await assertRemoteRuntimeBundle(resourcesPath, description, expectedArch);
  await validatePackageHygiene(appPath, description, expectedArch);

  // Named prebuild directories rather than "whatever is under prebuilds/": a
  // macOS bundle must resolve its addon from a darwin prebuild, and a foreign
  // one sitting there is a packaging bug this must not paper over.
  const nodePtyAddon = await findNodePtyAddon(nodePtyModulePath, {
    prebuildDirNames: ["darwin-arm64", "darwin-x64"],
  });
  if (!nodePtyAddon) {
    throw new Error(`[release:mac] Missing node-pty native addon under ${nodePtyModulePath}`);
  }
  const nodePtySpawnHelper = await findNodePtySpawnHelper(nodePtyModulePath);
  if (!nodePtySpawnHelper) {
    throw new Error(`[release:mac] Missing node-pty spawn-helper under ${nodePtyModulePath}`);
  }
  await assertExecutable(nodePtySpawnHelper, "node-pty spawn-helper");

  if (!deepSmoke) {
    console.log(
      `[release:mac] ${description}: structural runtime checks passed; skipping executable smoke (non-host arch).`,
    );
    return;
  }

  const { stdout } = await execFileAsync(executablePath, [smokeScriptPath], {
    cwd: unpackedPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: nodeModulesPath,
    },
  });

  const payload = JSON.parse(stdout.trim());
  if (payload?.nodePty !== "function") {
    throw new Error(`[release:mac] Packaged smoke expected node-pty.spawn to be a function, got ${String(payload?.nodePty)}`);
  }
  if (!payload?.ptyProbe?.ok) {
    throw new Error("[release:mac] Packaged smoke failed to execute a PTY probe");
  }
  if (payload?.claudeQuery !== "function") {
    throw new Error(`[release:mac] Packaged smoke expected Claude SDK query() to be available, got ${String(payload?.claudeQuery)}`);
  }
  if (typeof payload?.claudeExecutablePath !== "string" || payload.claudeExecutablePath.trim().length === 0) {
    throw new Error("[release:mac] Packaged smoke did not report a Claude executable path");
  }
  assertFetchedToolResolution("Claude", payload?.claudeExecutableSource, payload?.claudeExecutablePath, appPath);
  if (pathReferencesPackedAsar(payload.claudeExecutablePath)) {
    throw new Error(
      `[release:mac] Packaged smoke resolved Claude to a packed app.asar path instead of app.asar.unpacked: ${payload.claudeExecutablePath}`
    );
  }
  if (!payload?.claudeStartup || typeof payload.claudeStartup !== "object") {
    throw new Error("[release:mac] Packaged smoke did not report a Claude startup result");
  }
  if (payload.claudeStartup.state === "binary-missing") {
    console.warn(
      `[release:mac] Claude CLI is not installed on this machine; skipping live Claude startup check for ${description}.`
    );
  }
  if (payload.claudeStartup.state === "runtime-failed") {
    throw new Error(
      `[release:mac] Packaged smoke could not start Claude from the packaged app: ${String(payload.claudeStartup.message || "unknown error")}`
    );
  }
  if (payload?.codexExecutable !== "function") {
    throw new Error(`[release:mac] Packaged smoke expected Codex executable resolver to be available, got ${String(payload?.codexExecutable)}`);
  }
  if (payload?.openCodeExecutable !== "function") {
    throw new Error(`[release:mac] Packaged smoke expected OpenCode executable resolver to be available, got ${String(payload?.openCodeExecutable)}`);
  }
  assertFetchedToolResolution("OpenCode", payload?.openCodeExecutableSource, payload?.openCodeExecutablePath, appPath);
  assertFetchedToolResolution("Codex", payload?.codexExecutableSource, payload?.codexExecutablePath, appPath);

  const { stdout: adeCliHelp } = await execFileAsync(adeCliBinPath, ["--help"], {
    cwd: resourcesPath,
    env: {
      ...process.env,
    },
  });
  if (!adeCliHelp.includes("Agent-focused command-line interface for ADE")) {
    throw new Error("[release:mac] Bundled ADE CLI wrapper did not print ADE CLI help");
  }

  const tuiSmokeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-mac-tui-smoke-"));
  try {
    const tuiRunnerPath = path.join(tuiSmokeDir, "run-tui-help.mjs");
    await fs.writeFile(
      tuiRunnerPath,
      `const tui = await import(${JSON.stringify(pathToFileURL(adeCliTuiPath).href)});\n` +
        "process.exitCode = await tui.runAdeCodeCli(['--help']);\n",
      "utf8",
    );
    const { stdout: adeCodeHelp } = await execFileAsync(executablePath, [tuiRunnerPath], {
      cwd: resourcesPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_PATH: "",
      },
    });
    if (!adeCodeHelp.includes("Terminal-native ADE Work chat.")) {
      throw new Error("[release:mac] Bundled ADE code TUI did not print help");
    }
  } finally {
    await fs.rm(tuiSmokeDir, { recursive: true, force: true });
  }

  console.log(`[release:mac] Packaged runtime smoke passed for ${description}: ${path.relative(appPath, nodePtyAddon)}`);
}

async function validateAppUpdateYaml(resourcesPath, description) {
  const appUpdatePath = path.join(resourcesPath, "app-update.yml");
  await assertPathExists(appUpdatePath, `packaged updater feed config for ${description}`);

  const appUpdate = parseYaml(await fs.readFile(appUpdatePath, "utf8"));
  const provider = String(appUpdate?.provider ?? "");
  const owner = String(appUpdate?.owner ?? "");
  const repo = String(appUpdate?.repo ?? "");
  if (provider !== "github" || owner !== "arul28" || repo !== "ADE") {
    throw new Error(
      `[release:mac] Invalid packaged updater feed config for ${description}: ` +
        `provider=${provider || "missing"} owner=${owner || "missing"} repo=${repo || "missing"}`
    );
  }
}

// Validate the updater feed: it must reference one update zip per shipped arch,
// each with sha512, and each referenced zip must exist on disk.
async function validateLatestMacFeed(latestMacPath) {
  await assertPathExists(latestMacPath, "latest-mac.yml");
  const latestMac = parseYaml(await fs.readFile(latestMacPath, "utf8"));
  const entries = [];
  if (Array.isArray(latestMac?.files)) {
    for (const file of latestMac.files) {
      const url = file?.url ?? file?.path;
      if (url) entries.push({ url, sha512: file?.sha512 });
    }
  }
  if (latestMac?.path && !entries.some((entry) => entry.url === latestMac.path)) {
    entries.push({ url: latestMac.path, sha512: latestMac.sha512 });
  }
  const zipEntries = entries.filter((entry) => entry.url.endsWith(".zip"));
  if (zipEntries.length === 0) {
    throw new Error("[release:mac] latest-mac.yml references no update zip artifacts");
  }
  for (const entry of zipEntries) {
    if (!entry.sha512) {
      throw new Error(`[release:mac] latest-mac.yml entry ${entry.url} is missing sha512 metadata`);
    }
    await assertPathExists(
      path.join(releaseDir, entry.url),
      `published update zip ${entry.url} referenced by latest-mac.yml`,
    );
  }
  console.log(
    `[release:mac] latest-mac.yml references ${zipEntries.length} update zip(s): ${zipEntries.map((entry) => entry.url).join(", ")}`,
  );
}

// Confirm a DMG is notarized + stapled (no mount needed — the per-arch .app it
// wraps is already validated directly).
async function validateDmgStapled(dmgPath, description) {
  await assertPathExists(dmgPath, description);
  await execFileAsync("xcrun", ["stapler", "validate", dmgPath]);
  try {
    await execFileAsync("spctl", ["-a", "-vvv", "--type", "open", dmgPath]);
  } catch (error) {
    const combinedOutput = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    if (!combinedOutput.includes("source=Insufficient Context")) {
      throw error;
    }
    console.warn(
      `[release:mac] DMG Gatekeeper open assessment for ${description} returned 'Insufficient Context' ` +
        "(expected for some locally-built, non-quarantined DMGs); notarization staple already validated.",
    );
  }
}

const ARCH_OUTPUT_DIRS = [
  { arch: "universal", dir: "mac-universal" },
  { arch: "arm64", dir: "mac-arm64" },
  { arch: "x64", dir: "mac" },
];
const skipDmg = hasFlag("--skip-dmg");
const hostArch = process.arch === "arm64" ? "arm64" : "x64";

// Discover the per-arch app bundles electron-builder produced (arm64 ->
// release/mac-arm64, x64 -> release/mac). An explicit --app (with optional
// --arch) still works for a single-bundle run.
const archApps = [];
const explicitApp = resolveAbsolute(readFlag("--app"));
if (explicitApp) {
  archApps.push({ arch: readFlag("--arch") || hostArch, appPath: explicitApp });
} else {
  for (const { arch, dir } of ARCH_OUTPUT_DIRS) {
    const candidate = path.join(releaseDir, dir, "ADE.app");
    if (await pathExists(candidate)) archApps.push({ arch, appPath: candidate });
  }
}
if (archApps.length === 0) {
  throw new Error(
    `[release:mac] No mac app bundles found under ${releaseDir} (looked for mac-universal/ADE.app, mac-arm64/ADE.app, and mac/ADE.app)`,
  );
}

for (const { arch, appPath } of archApps) {
  const label = `signed ${arch} app bundle`;
  await assertPathExists(appPath, label);
  await validateSignedApp(appPath, label);
  await validateProvisionedWebAuthnEntitlement(appPath, label);
  await validateAppUpdateYaml(path.join(appPath, "Contents", "Resources"), label);
  await validatePackagedRuntime(appPath, label, arch, { deepSmoke: arch === "universal" || arch === hostArch });
}

const latestMacPath = resolveAbsolute(readFlag("--latest")) ?? path.join(releaseDir, "latest-mac.yml");
await validateLatestMacFeed(latestMacPath);

if (!skipDmg) {
  for (const { arch } of archApps) {
    const dmgPath =
      resolveAbsolute(readFlag("--dmg")) ?? (await findArtifact(new RegExp(`^ADE-.+-${arch}\\.dmg$`), `${arch} mac dmg`));
    await validateDmgStapled(dmgPath, `${arch} dmg artifact`);
  }
}

console.log(
  `[release:mac] macOS release artifacts passed signature, notarization, Gatekeeper, updater, and packaged runtime checks ` +
    `for arch(es): ${archApps.map((entry) => entry.arch).join(", ")} (deep smoke on host arch ${hostArch})` +
    (skipDmg ? " — DMG validation skipped" : ""),
);
