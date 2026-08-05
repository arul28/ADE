import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import packagedAdeCliResourcesModule from "./packaged-ade-cli-resources.cjs";
import runtimeResourceTargets from "./runtime-resource-targets.cjs";
import { AUTHENTICODE_PROBE_ERROR_STATUS, createAuthenticodeProbe } from "./windows-authenticode.mjs";
import {
  matchesRuntimeFetchedToolPackage,
  runtimeFetchedToolPackageFilesExclusion,
  runtimeFetchedToolPackageNames,
  RUNTIME_FETCHED_TOOL_EXPLANATION,
} from "./runtime-fetched-tool-packages.mjs";
import { createPackagedTreeAssertions, findNodePtyAddon } from "./validate-packaged-tree.mjs";
import {
  isGithubSafeAssetName,
  resolveWindowsPackageIdentity,
  windowsInstallerArtifactName,
  windowsInstallerPattern,
} from "./windows-package-identity.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(desktopRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const {
  missingRequiredPackagedAdeCliPayloadPaths,
  packagedAdeCliPayloadFiles,
} = packagedAdeCliResourcesModule;
const { RUNTIME_TARGETS, runtimeBinaryNameForTarget } = runtimeResourceTargets;
const packageIdentity = resolveWindowsPackageIdentity(process.env.ADE_PACKAGE_CHANNEL);
const productName = packageIdentity.productName;
const DEFAULT_MAX_APP_ASAR_BYTES = 900 * 1024 * 1024;
// The unpacked runtime includes node-pty, the Cursor native helpers, the Claude
// Agent SDK's JS payload and ONNX. It no longer includes any Codex / Claude Code
// / OpenCode native platform package: those are fetched into the machine tools
// cache at runtime. Keep a ceiling to catch runaway bloat; it is deliberately
// looser than the current payload rather than retuned by guess, since the actual
// Windows number is only measurable on a Windows package host.
const DEFAULT_MAX_UNPACKED_BYTES = 1000 * 1024 * 1024;
// A Windows bundle carries ONLY the win32-x64 sidecar. It used to carry all
// five targets, which is most of why the installer reached 1716 MB.
const REMOTE_RUNTIME_TARGETS = ["win32-x64"];
const EXCLUDED_REMOTE_RUNTIME_TARGETS = RUNTIME_TARGETS.filter(
  (target) => !REMOTE_RUNTIME_TARGETS.includes(target),
);

const remoteRuntimeBinaryName = runtimeBinaryNameForTarget;
const isLocalWindowsTestBuild =
  process.platform === "win32" &&
  process.env.ADE_WINDOWS_TEST_BUILD === "1" &&
  process.env.ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY === "1";

// The cross-platform half of this validator. `fail` is injected so the shared
// assertions keep this file's "[validate-win-artifacts]" prefix.
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
} = createPackagedTreeAssertions({ fail: (message) => fail(message) });

function resolveBundledAdeCliFiles(options = {}) {
  return packagedAdeCliPayloadFiles({
    desktopRoot,
    packageJson: pkg,
    ...options,
  });
}

function assertRequiredBundledAdeCliFiles(payloadFiles) {
  const missing = missingRequiredPackagedAdeCliPayloadPaths(payloadFiles);
  if (missing.length > 0) {
    fail(
      `package.json build.extraResources omits required ADE CLI payload: ${missing.join(", ")}`,
    );
  }
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

function shouldRequireSignedArtifacts() {
  return hasFlag("--require-signed") || process.env.ADE_REQUIRE_WIN_SIGNING === "1";
}

function normalizeCertificateThumbprint(value) {
  return value?.replace(/\s+/g, "").toUpperCase() ?? "";
}

// Azure Artifact Signing never releases the signing certificate: it mints a
// short-lived leaf per profile, renews it daily, and expires it after 72 hours.
// A pinned thumbprint would therefore reject every release within days, so the
// publisher pin is the certificate Subject and only the Subject. The thumbprint
// name is rejected outright rather than quietly ignored, so nobody sets it and
// then discovers days later that it pinned nothing.
function expectedWindowsSigningIdentity() {
  if (!shouldRequireSignedArtifacts()) return null;
  const subject = process.env.WINDOWS_SIGNING_EXPECTED_SUBJECT?.trim() ?? "";
  if (process.env.WINDOWS_SIGNING_EXPECTED_THUMBPRINT?.trim()) {
    fail(
      "WINDOWS_SIGNING_EXPECTED_THUMBPRINT is not supported by the Azure Artifact Signing pipeline. " +
        "The service renews its certificate daily and expires it after 72 hours, so a pinned thumbprint " +
        "would fail every release within days. Unset it and pin WINDOWS_SIGNING_EXPECTED_SUBJECT instead.",
    );
  }
  if (!subject) {
    fail(
      "Signed Windows validation requires WINDOWS_SIGNING_EXPECTED_SUBJECT " +
        "so the release cannot be signed by an unexpected publisher.",
    );
  }
  return { subject };
}

function resolveAbsolute(input) {
  if (!input) return null;
  return path.isAbsolute(input) ? input : path.resolve(desktopRoot, input);
}

function fail(message) {
  throw new Error(`[validate-win-artifacts] ${message}`);
}

async function collectMatchingPaths(rootPath, predicate, matches = []) {
  let entries;
  try {
    entries = await fsp.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return matches;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (predicate(entryPath, entry)) {
      matches.push(entryPath);
    }
    if (entry.isDirectory()) {
      await collectMatchingPaths(entryPath, predicate, matches);
    }
  }

  return matches;
}

function formatRelativeSample(rootPath, entries) {
  return entries
    .slice(0, 12)
    .map((entry) => path.relative(rootPath, entry) || path.basename(entry))
    .join(", ");
}

// Resolver sources that name a concrete file on disk, so the smoke can stat and
// run it. "fallback-command" (bare command name for PATH lookup) and OpenCode's
// "missing" do not, and are the expected result on a package host whose tools
// cache has never been populated - which is every CI runner.
const ON_DISK_TOOL_SOURCES = new Set(["tools-cache", "auth", "common-dir", "path", "env", "user-installed"]);

/**
 * The packaged smoke used to require source === "bundled" for all three agent
 * CLIs. That expectation is now inverted: a bundled copy means the packaging
 * exclusions regressed. What the smoke still proves is that the resolver runs
 * inside the packaged app and reports a source, and that whatever it does
 * resolve is a real, runnable file.
 *
 * Returns the executable path when it is worth executing, otherwise null.
 */
async function assertFetchedToolResolution(label, source, executablePath) {
  if (typeof source !== "string" || source.trim().length === 0) {
    fail(`Packaged smoke did not report a ${label} executable source`);
  }
  if (source === "bundled") {
    fail(
      `${label} resolved to a bundled copy (source="bundled") at ${String(executablePath)}; `
      + "the packaged app must not carry the native platform packages. "
      + RUNTIME_FETCHED_TOOL_EXPLANATION,
    );
  }
  if (!ON_DISK_TOOL_SOURCES.has(source)) {
    console.log(
      `[validate-win-artifacts] ${label} resolved to "${source}" on this package host; `
      + "the tools cache is empty here and the binary is fetched on first use.",
    );
    return null;
  }
  await assertPathExists(executablePath, `${label} executable resolved from ${source}`);
  return executablePath;
}

async function assertExecutable(targetPath, description) {
  if (process.platform === "win32") {
    return;
  }
  const stat = await fsp.stat(targetPath);
  if ((stat.mode & 0o111) !== 0o111) {
    fail(`Expected ${description} to be executable: ${targetPath}`);
  }
}

function requireFile(relativePath, label) {
  const absolutePath = path.join(desktopRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`Missing ${label}: ${absolutePath}`);
  }
}

function parseWinTargets() {
  const targets = pkg.build?.win?.target;
  if (!Array.isArray(targets)) return [];
  return targets.map((entry) => {
    if (typeof entry === "string") {
      return { target: entry, arch: [] };
    }
    const arch = Array.isArray(entry?.arch)
      ? entry.arch.filter(Boolean)
      : entry?.arch
        ? [entry.arch]
        : [];
    return {
      target: entry?.target ?? null,
      arch,
    };
  });
}

function resolveExpectedReleaseRepository() {
  const configured = (
    process.env.ADE_RELEASE_REPOSITORY?.trim()
    || `${pkg.build?.publish?.owner ?? ""}/${pkg.build?.publish?.repo ?? ""}`
  ).replace(/^\/+|\/+$/g, "");
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(configured);
  if (!match) {
    fail(`Expected ADE_RELEASE_REPOSITORY to be owner/repo, received: ${configured || "empty"}`);
  }
  return { owner: match[1], repo: match[2] };
}

function runtimeResourceFilter() {
  return [
    ...(Array.isArray(pkg.build?.extraResources) ? pkg.build.extraResources : []),
    ...(Array.isArray(pkg.build?.win?.extraResources) ? pkg.build.win.extraResources : []),
  ].filter((entry) => entry?.to === "runtime")
    .flatMap((entry) => Array.isArray(entry?.filter) ? entry.filter : []);
}
function validatePreflight() {
  requireFile("build/icon.ico", "Windows app icon");
  requireFile("scripts/ade-cli-windows-wrapper.cmd", "Windows ADE CLI wrapper");
  requireFile("scripts/ade-cli-install-path.cmd", "Windows ADE CLI PATH installer");
  requireFile("scripts/windows-install-setup.ps1", "Windows install setup script");
  requireFile("scripts/windows-uninstall-cleanup.ps1", "Windows uninstall cleanup script");
  requireFile("scripts/windows-firewall-rules.ps1", "Windows firewall rule script");
  requireFile("build/installer.nsh", "Windows NSIS customization");
  requireFile("vendor/crsqlite/win32-x64/crsqlite.dll", "Windows cr-sqlite extension");

  assertRequiredBundledAdeCliFiles(resolveBundledAdeCliFiles({ allowMissingSources: true }));
  if (!Array.isArray(pkg.build?.asarUnpack) || !pkg.build.asarUnpack.includes("vendor/crsqlite/**")) {
    fail("package.json build.asarUnpack must unpack vendor/crsqlite/**");
  }
  if (!Array.isArray(pkg.build?.asarUnpack) || !pkg.build.asarUnpack.includes("node_modules/opencode-ai/**")) {
    fail("package.json build.asarUnpack must unpack node_modules/opencode-ai/** for the bundled OpenCode CLI");
  }
  // Codex, Claude Code and OpenCode native platform packages are fetched into
  // the machine tools cache at runtime. Unpacking one would ship it: nothing
  // resolves a bundled copy any more, because every resolver checks the cache
  // first.
  const unpackedFetchedTools = (Array.isArray(pkg.build?.asarUnpack) ? pkg.build.asarUnpack : [])
    .filter((pattern) => matchesRuntimeFetchedToolPackage(pattern));
  if (unpackedFetchedTools.length > 0) {
    fail(
      `package.json build.asarUnpack must not unpack runtime-fetched agent tool packages: ${unpackedFetchedTools.join(", ")}. `
      + RUNTIME_FETCHED_TOOL_EXPLANATION,
    );
  }
  // Dropping a package from asarUnpack is not enough to stop shipping it:
  // electron-builder always copies production dependencies, so a package that is
  // not unpacked is embedded *inside* app.asar instead - hundreds of megabytes of
  // binary that can never be executed from there and that nothing resolves. Only a
  // `!` pattern in build.files keeps it out of the package entirely
  // (getNodeModuleFileMatcher collects exactly the negated patterns and applies
  // them to the node_modules walk).
  const buildFiles = Array.isArray(pkg.build?.files) ? pkg.build.files : [];
  const missingFilesExclusions = runtimeFetchedToolPackageNames
    .map(runtimeFetchedToolPackageFilesExclusion)
    .filter((pattern) => !buildFiles.includes(pattern));
  if (missingFilesExclusions.length > 0) {
    fail(
      `package.json build.files must exclude every runtime-fetched agent tool package; missing: ${missingFilesExclusions.join(", ")}. `
      + RUNTIME_FETCHED_TOOL_EXPLANATION,
    );
  }
  if (pkg.build?.win?.icon !== "build/icon.ico") {
    fail("package.json build.win.icon must point to build/icon.ico");
  }
  // ${productName} expands to "ADE Beta" on channel builds. electron-builder
  // would then write the installer with a space while rewriting latest.yml's
  // url/path to the space-free name it would have used for its own GitHub
  // upload, and `gh release upload` publishes the on-disk name instead - so the
  // updater feed would point at a file that was never published.
  const stableArtifactName = windowsInstallerArtifactName(resolveWindowsPackageIdentity("stable"));
  if (pkg.build?.win?.artifactName !== stableArtifactName) {
    fail(
      `package.json build.win.artifactName must be ${stableArtifactName} so the installer name never inherits a space from productName`,
    );
  }
  if (
    pkg.build?.nsis?.oneClick !== false
    || pkg.build?.nsis?.perMachine !== false
    || pkg.build?.nsis?.allowElevation !== false
    || pkg.build?.nsis?.runAfterFinish !== false
  ) {
    fail("package.json build.nsis must pin the Windows installer to a non-elevating per-user lifecycle");
  }
  // electron-builder defaults uninstallDisplayName to "${productName} ${version}",
  // which writes an Add/Remove Programs DisplayName that changes on every
  // release and reads as a different product each time. Windows expects
  // DisplayName to carry the product and DisplayVersion to carry the version,
  // and Stable/Beta side-by-side installs are only distinguishable when each
  // channel owns one stable DisplayName.
  // eslint-disable-next-line no-template-curly-in-string
  if (pkg.build?.nsis?.uninstallDisplayName !== "${productName}") {
    fail(
      "package.json build.nsis.uninstallDisplayName must be ${productName} so each channel keeps one version-independent Add/Remove Programs entry",
    );
  }

  const winTargets = parseWinTargets();
  if (winTargets.length === 0) {
    fail("package.json build.win.target must define at least one Windows target");
  }
  if (!winTargets.every((entry) => entry.target === "nsis" && entry.arch.length === 1 && entry.arch[0] === "x64")) {
    fail("package.json build.win.target must pin NSIS to x64 until a Windows ARM64 cr-sqlite binary is bundled");
  }

  if (typeof pkg.scripts?.["package:win"] !== "string" || !/\s--x64(?:\s|$)/.test(pkg.scripts["package:win"])) {
    fail("package.json scripts.package:win must pass --x64 until a Windows ARM64 cr-sqlite binary is bundled");
  }
  if (typeof pkg.scripts?.["dist:win"] !== "string" || !pkg.scripts["dist:win"].includes("validate:win:release")) {
    fail("package.json scripts.dist:win must validate the packaged Windows release output");
  }

  const runtimeFilter = new Set(runtimeResourceFilter());
  for (const target of REMOTE_RUNTIME_TARGETS) {
    for (const fileName of [remoteRuntimeBinaryName(target), `ade-${target}.native.tar.gz`]) {
      if (!runtimeFilter.has(fileName)) {
        fail(`package.json build.win.extraResources runtime filter must include ${fileName}`);
      }
    }
  }
  for (const target of EXCLUDED_REMOTE_RUNTIME_TARGETS) {
    for (const fileName of [remoteRuntimeBinaryName(target), `ade-${target}.native.tar.gz`]) {
      if (runtimeFilter.has(fileName)) {
        fail(
          `package.json runtime filter must not ship ${fileName} in the Windows bundle; `
          + "foreign-platform sidecars are published as standalone release assets instead",
        );
      }
    }
  }

  const staticUpdateResource = pkg.build?.extraResources?.find((entry) => entry?.to === "app-update.yml");
  if (staticUpdateResource) {
    fail("app-update.yml must be generated from electron-builder publish configuration, not copied as a static extraResource");
  }

  console.log("[validate-win-artifacts] Windows package inputs are present.");
}

async function findArtifact(releaseDir, regex, description) {
  const entries = await fsp.readdir(releaseDir, { withFileTypes: true });
  const matches = entries
    .filter((entry) => entry.isFile() && regex.test(entry.name))
    .map((entry) => path.join(releaseDir, entry.name))
    .sort();

  if (matches.length === 0) {
    fail(`Unable to find ${description} in ${releaseDir}`);
  }
  if (matches.length > 1) {
    fail(
      `Found multiple ${description} artifacts in ${releaseDir}: ${matches
        .map((filePath) => path.basename(filePath))
        .join(", ")}`,
    );
  }

  return matches[0];
}

function collectLatestReferencedFiles(latest) {
  return new Set(
    [
      latest?.path,
      ...(Array.isArray(latest?.files)
        ? latest.files.map((file) => file?.url ?? file?.path ?? null)
        : []),
    ].filter(Boolean),
  );
}

async function validateLatestYaml(latestPath, installerPath) {
  await assertPathExists(latestPath, "latest.yml");
  const latest = parseYaml(await fsp.readFile(latestPath, "utf8"));
  const expectedInstallerName = path.basename(installerPath);
  const referencedFiles = collectLatestReferencedFiles(latest);

  if (!referencedFiles.has(expectedInstallerName)) {
    fail(
      `latest.yml does not reference ${expectedInstallerName}. ` +
        `Referenced entries: ${Array.from(referencedFiles).join(", ") || "none"}`,
    );
  }

  const hasSha512 =
    Boolean(latest?.sha512) ||
    (Array.isArray(latest?.files) && latest.files.some((file) => Boolean(file?.sha512)));
  if (!hasSha512) {
    fail("latest.yml is missing sha512 metadata for the installer artifact");
  }
}

function createCommandError(command, args, status, stdout, stderr) {
  const rendered = [command, ...args].join(" ");
  const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return new Error(
    `[validate-win-artifacts] Command failed (${status ?? "null"}): ${rendered}` +
      (details ? `\n${details}` : ""),
  );
}

const DEFAULT_RUN_COMMAND_TIMEOUT_MS = 3 * 60 * 1000;

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_COMMAND_TIMEOUT_MS;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore best-effort kill
      }
      const rendered = [command, ...args].join(" ");
      const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      reject(new Error(
        `[validate-win-artifacts] Command timed out after ${timeoutMs}ms: ${rendered}` +
          (details ? `\n${details}` : ""),
      ));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!timedOut) reject(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (status === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(createCommandError(command, args, status, stdout, stderr));
    });
  });
}

async function assertRemoteRuntimeBundle(resourcesPath) {
  const runtimeRoot = path.join(resourcesPath, "runtime");
  await assertPathExists(runtimeRoot, "remote runtime bundle directory");
  for (const target of REMOTE_RUNTIME_TARGETS) {
    const binaryPath = path.join(runtimeRoot, remoteRuntimeBinaryName(target));
    const nativeArchivePath = path.join(runtimeRoot, `ade-${target}.native.tar.gz`);
    await assertPathExists(binaryPath, `remote runtime binary ${target}`);
    await assertExecutable(binaryPath, `remote runtime binary ${target}`);
    await assertPathExists(nativeArchivePath, `remote runtime native dependency archive ${target}`);
    const { stdout } = await runCommand("tar", ["-tzf", nativeArchivePath]);
    if (!stdout.split(/\r?\n/).some((entry) => entry.startsWith("./node_modules/"))) {
      fail(`Remote runtime native archive for ${target} does not contain ./node_modules/: ${nativeArchivePath}`);
    }
    if (!stdout.split(/\r?\n/).includes("./tuiClient/cli.mjs")) {
      fail(`Remote runtime native archive for ${target} does not contain ./tuiClient/cli.mjs: ${nativeArchivePath}`);
    }
  }
  for (const target of EXCLUDED_REMOTE_RUNTIME_TARGETS) {
    await assertPathMissing(
      path.join(runtimeRoot, runtimeBinaryNameForTarget(target)),
      `non-target remote runtime binary ${target}`,
    );
    await assertPathMissing(
      path.join(runtimeRoot, `ade-${target}.native.tar.gz`),
      `non-target remote runtime native archive ${target}`,
    );
  }
}

function createNodePathValue(paths, options = {}) {
  return paths.filter((entry) => options.includeMissing || fs.existsSync(entry)).join(";");
}

function assertAdeCliHelp(stdout, label) {
  if (!stdout.includes("Agent-focused command-line interface for ADE")) {
    fail(`${label} did not print ADE CLI help`);
  }
}

async function validatePackageHygiene(resourcesPath) {
  const appAsarPath = path.join(resourcesPath, "app.asar");
  const unpackedPath = path.join(resourcesPath, "app.asar.unpacked");
  await assertPackagedTreeSizeBudget({
    appAsarPath,
    unpackedPaths: [unpackedPath],
    maxAppAsarBytes: readByteLimit("ADE_MAX_APP_ASAR_BYTES", DEFAULT_MAX_APP_ASAR_BYTES),
    maxUnpackedBytes: readByteLimit("ADE_MAX_APP_ASAR_UNPACKED_BYTES", DEFAULT_MAX_UNPACKED_BYTES),
    unpackedLabel: "app.asar.unpacked",
  });

  // Source-map and binary-package hygiene checks are paused until the
  // perf-fixes packaging changes are reapplied with proper exclusions.

  await assertPathMissing(path.join(unpackedPath, "node_modules", "node-pty", "deps"), "node-pty source dependency tree");
  await assertPathMissing(path.join(unpackedPath, "node_modules", "node-pty", "src"), "node-pty source tree");
  await assertPathMissing(path.join(unpackedPath, "node_modules", "node-pty", "prebuilds", "darwin-arm64"), "macOS node-pty arm64 prebuild in Windows package");
  await assertPathMissing(path.join(unpackedPath, "node_modules", "node-pty", "prebuilds", "darwin-x64"), "macOS node-pty x64 prebuild in Windows package");
  await assertPathMissing(path.join(unpackedPath, "node_modules", "node-pty", "prebuilds", "win32-arm64"), "Windows arm64 node-pty prebuild in Windows x64 package");
  // Every native platform variant of Codex, Claude Code and OpenCode, including
  // the win32-x64 ones: all three CLIs are fetched into the machine tools cache
  // at runtime, so no variant has any business in the package.
  await assertNoRuntimeFetchedToolPackages({
    nodeModulesPath: path.join(unpackedPath, "node_modules"),
    report: "first-offender",
  });
  await assertPathMissing(path.join(unpackedPath, "node_modules", "@cursor", "sdk-darwin-arm64"), "Cursor macOS arm64 payload in Windows package");
  await assertPathMissing(path.join(unpackedPath, "node_modules", "@cursor", "sdk-darwin-x64"), "Cursor macOS x64 payload in Windows package");
  await assertPathExists(path.join(unpackedPath, "node_modules", "@cursor", "sdk-win32-x64", "bin", "rg.exe"), "Cursor Windows x64 ripgrep helper");
  await assertPathExists(path.join(unpackedPath, "node_modules", "@cursor", "sdk-win32-x64", "bin", "cursorsandbox.exe"), "Cursor Windows x64 sandbox helper");
  await assertPathMissing(path.join(unpackedPath, "node_modules", "node-pty", "build", "Release", "conpty"), "duplicate node-pty build conpty payload in Windows package");
  await assertPathMissing(
    path.join(unpackedPath, "node_modules", "node-pty", "third_party", "conpty", "1.23.251008001", "win10-arm64"),
    "node-pty Windows arm64 conpty payload in Windows x64 package",
  );
  // `opencode-ai` still ships (the resolver and the ADE CLI both load the JS
  // launcher), but the 107 MB Windows executable it carries in its own bin/ is
  // pruned: OpenCode comes from the tools cache now.
  await assertPathMissing(path.join(unpackedPath, "node_modules", "opencode-ai", "bin", "opencode.exe"), "runtime-fetched OpenCode install shim");
  // The JS entry points must survive the exclusions above.
  await assertRuntimeToolJsEntryPointsPresent({
    nodeModulesPath: path.join(unpackedPath, "node_modules"),
    labelSuffix: " package",
  });
  await assertAsarEmbedsNoRuntimeFetchedToolPayload(appAsarPath);
  await assertPathMissing(path.join(unpackedPath, "vendor", "crsqlite", "darwin-arm64"), "macOS arm64 cr-sqlite payload in Windows package");
  await assertPathMissing(path.join(unpackedPath, "vendor", "crsqlite", "darwin-x64"), "macOS x64 cr-sqlite payload in Windows package");

  console.log("[validate-win-artifacts] Package hygiene passed.");
}

async function validatePackagedUpdateAuthority(resourcesPath) {
  const appUpdatePath = path.join(resourcesPath, "app-update.yml");
  await assertPathExists(appUpdatePath, "electron-builder app-update.yml");
  const updateConfig = parseYaml(await fsp.readFile(appUpdatePath, "utf8"));
  const expected = resolveExpectedReleaseRepository();
  if (
    updateConfig?.provider !== "github"
    || updateConfig?.owner !== expected.owner
    || updateConfig?.repo !== expected.repo
  ) {
    fail(
      `Packaged update authority must be github:${expected.owner}/${expected.repo}, got `
      + `${String(updateConfig?.provider)}:${String(updateConfig?.owner)}/${String(updateConfig?.repo)}`,
    );
  }
}
async function validatePackagedRuntime(appDir) {
  const appExe = path.join(appDir, `${productName}.exe`);
  const resourcesPath = path.join(appDir, "resources");
  const appAsarPath = path.join(resourcesPath, "app.asar");
  const unpackedPath = path.join(resourcesPath, "app.asar.unpacked");
  const adeCliBinPath = path.join(resourcesPath, "ade-cli", "bin", "ade.cmd");
  const adeCliInstallerPath = path.join(resourcesPath, "ade-cli", "install-path.cmd");
  const uninstallCleanupPath = path.join(resourcesPath, "ade-cli", "windows-uninstall-cleanup.ps1");
  const adeCliTuiPath = path.join(resourcesPath, "ade-cli", "tuiClient", "cli.mjs");
  const bundledAgentSkillsRoot = path.join(resourcesPath, "agent-skills");
  const nodeModulesPath = path.join(unpackedPath, "node_modules");
  const nodePtyModulePath = path.join(nodeModulesPath, "node-pty");
  const smokeScriptPath = path.join(unpackedPath, "dist", "main", "packagedRuntimeSmoke.cjs");
  const crsqliteDllPath = path.join(unpackedPath, "vendor", "crsqlite", "win32-x64", "crsqlite.dll");
  const bundledAdeCliFiles = resolveBundledAdeCliFiles();
  assertRequiredBundledAdeCliFiles(bundledAdeCliFiles);

  await assertPathExists(appExe, "packaged Windows app executable");
  await assertPathExists(appAsarPath, "app.asar payload");
  await assertPathExists(unpackedPath, "app.asar.unpacked runtime payload");
  await assertPathExists(uninstallCleanupPath, "packaged Windows uninstall cleanup script");
  for (const resource of bundledAdeCliFiles) {
    await assertPathExists(
      path.join(resourcesPath, resource.to),
      `bundled ADE CLI resource ${resource.to}`,
    );
  }
  await assertBundledAgentSkills(bundledAgentSkillsRoot);
  await assertPathExists(nodePtyModulePath, "unpacked node-pty module");
  await assertPathExists(smokeScriptPath, "unpacked packaged runtime smoke script");
  await assertPathExists(crsqliteDllPath, "unpacked Windows cr-sqlite extension");
  assertPackagedTuiEsmShims(await fsp.readFile(adeCliTuiPath, "utf8"));
  if (isLocalWindowsTestBuild) {
    console.warn(
      "[validate-win-artifacts] Local test build: skipping the remote runtime sidecar assertion.",
    );
  } else {
    await assertRemoteRuntimeBundle(resourcesPath);
  }
  await validatePackagedUpdateAuthority(resourcesPath);
  await validatePackageHygiene(resourcesPath);

  const nodePtyAddon = await findNodePtyAddon(nodePtyModulePath);
  if (!nodePtyAddon) {
    fail(`Missing node-pty native addon under ${nodePtyModulePath}`);
  }

  if (process.platform !== "win32" || hasFlag("--skip-live-runtime")) {
    console.log("[validate-win-artifacts] Skipping live Windows runtime validation on this host.");
    return;
  }

  const runtimeNodePath = createNodePathValue([
    path.join(resourcesPath, "app.asar.unpacked", "node_modules"),
    path.join(resourcesPath, "app.asar", "node_modules"),
  ], { includeMissing: true });

  const { stdout: smokeStdout } = await runCommand(appExe, [smokeScriptPath], {
    cwd: unpackedPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: runtimeNodePath,
    },
  });

  const payload = JSON.parse(smokeStdout.trim());
  if (payload?.nodePty !== "function") {
    fail(`Packaged smoke expected node-pty.spawn to be a function, got ${String(payload?.nodePty)}`);
  }
  if (!payload?.ptyProbe?.ok) {
    fail("Packaged smoke failed to execute a PTY probe");
  }
  if (!payload?.crsqliteProbe?.ok || Number(payload.crsqliteProbe.changeRows) < 1) {
    fail("Packaged smoke failed to load crsqlite.dll and record a CRR change");
  }
  if (payload?.claudeQuery !== "function") {
    fail(`Packaged smoke expected Claude SDK query() to be available, got ${String(payload?.claudeQuery)}`);
  }
  if (typeof payload?.claudeExecutablePath !== "string" || payload.claudeExecutablePath.trim().length === 0) {
    fail("Packaged smoke did not report a Claude executable path");
  }
  await assertFetchedToolResolution("Claude", payload?.claudeExecutableSource, payload?.claudeExecutablePath);
  if (!payload?.claudeStartup || typeof payload.claudeStartup !== "object") {
    fail("Packaged smoke did not report a Claude startup result");
  }
  if (payload.claudeStartup.state === "binary-missing") {
    // Expected on a package host with an empty tools cache and no user-installed
    // Claude: the binary is fetched on first use. A resolver that silently
    // returned nothing at all is still caught above.
    console.log(
      "[validate-win-artifacts] Claude CLI is not present on this package host (empty tools cache); "
      + "skipping the live Claude startup check.",
    );
  } else if (payload.claudeStartup.state === "runtime-failed") {
    fail(`Packaged smoke could not start Claude from the packaged app: ${String(payload.claudeStartup.message || "unknown error")}`);
  }
  if (payload?.codexExecutable !== "function") {
    fail(`Packaged smoke expected Codex executable resolver to be available, got ${String(payload?.codexExecutable)}`);
  }
  const codexPath = await assertFetchedToolResolution("Codex", payload?.codexExecutableSource, payload?.codexExecutablePath);
  if (codexPath) {
    await runCommand(codexPath, ["--version"], { timeoutMs: 20_000 });
  }
  if (payload?.openCodeExecutable !== "function") {
    fail(`Packaged smoke expected OpenCode executable resolver to be available, got ${String(payload?.openCodeExecutable)}`);
  }
  const openCodePath = await assertFetchedToolResolution("OpenCode", payload?.openCodeExecutableSource, payload?.openCodeExecutablePath);
  if (openCodePath) {
    await runCommand(openCodePath, ["--version"], { timeoutMs: 20_000 });
  }
  if (payload?.cursorSdkCreateAgentPlatform !== "function") {
    fail(`Packaged smoke expected Cursor SDK createAgentPlatform() to be available, got ${String(payload?.cursorSdkCreateAgentPlatform)}`);
  }
  await assertPathExists(payload.cursorNativeRgPath, "packaged Cursor ripgrep helper");
  await assertPathExists(payload.cursorNativeSandboxPath, "packaged Cursor sandbox helper");
  await runCommand(payload.cursorNativeRgPath, ["--version"], { timeoutMs: 20_000 });
  if (payload?.droidSdkCreateSession !== "function") {
    fail(`Packaged smoke expected Droid SDK createSession() to be available, got ${String(payload?.droidSdkCreateSession)}`);
  }
  if (payload?.droidExecutableSource !== "fallback-command") {
    await assertPathExists(payload.droidExecutablePath, "resolved user-installed Droid executable");
    await runCommand(payload.droidExecutablePath, ["--version"], { timeoutMs: 20_000 });
  } else {
    console.log("[validate-win-artifacts] Droid SDK loaded; the optional user-managed Droid CLI is not installed on this package host.");
  }

  const defaultHelp = await runCommand(adeCliBinPath, ["--help"], {
    cwd: resourcesPath,
    env: { ...process.env },
  });
  assertAdeCliHelp(defaultHelp.stdout, "Bundled ADE CLI wrapper");

  const tuiSmokeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-win-tui-smoke-"));
  try {
    const tuiRunnerPath = path.join(tuiSmokeDir, "run-tui-help.mjs");
    await fsp.writeFile(
      tuiRunnerPath,
      `const tui = await import(${JSON.stringify(pathToFileURL(adeCliTuiPath).href)});\n` +
        "process.exitCode = await tui.runAdeCodeCli(['--help']);\n",
      "utf8",
    );
    const tuiHelp = await runCommand(appExe, [tuiRunnerPath], {
      cwd: resourcesPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_PATH: "",
      },
    });
    if (!tuiHelp.stdout.includes("Terminal-native ADE Work chat.")) {
      fail("Bundled ADE code TUI did not print help");
    }
  } finally {
    await fsp.rm(tuiSmokeDir, { recursive: true, force: true });
  }

  const nodeOverrideHelp = await runCommand(adeCliBinPath, ["--help"], {
    cwd: resourcesPath,
    env: {
      ...process.env,
      ADE_CLI_NODE: process.execPath,
    },
  });
  assertAdeCliHelp(nodeOverrideHelp.stdout, "Bundled ADE CLI wrapper with ADE_CLI_NODE");

  const disabledAppExe = `${appExe}.bak`;
  await fsp.rename(appExe, disabledAppExe);
  try {
    const plainNodeHelp = await runCommand(adeCliBinPath, ["--help"], {
      cwd: resourcesPath,
      env: { ...process.env },
    });
    assertAdeCliHelp(plainNodeHelp.stdout, "Bundled ADE CLI wrapper with plain node fallback");
  } finally {
    await fsp.rename(disabledAppExe, appExe);
  }

  const installRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-win-install-"));
  const installedCommandPath = path.join(installRoot, "bin", "ade.cmd");
  try {
    await runCommand(adeCliInstallerPath, [installedCommandPath], {
      cwd: resourcesPath,
      env: {
        ...process.env,
        ADE_BIN: adeCliBinPath,
        // This runs the REAL shipped PATH installer, which derives its target
        // from the shim's directory and persists it to HKCU. The temp dir is
        // deleted below, but the PATH entry it wrote is not — so every
        // validation run left a permanent dead `%TEMP%\ade-win-install-*\bin`
        // in the user's PATH. Six had accumulated on one machine. The real
        // installer snapshots and restores PATH; this one had no such guard,
        // so use the installer's own opt-out instead. The --help assertion
        // below invokes the shim by absolute path and does not need PATH.
        ADE_SKIP_USER_PATH_UPDATE: "1",
      },
    });
    await assertPathExists(installedCommandPath, "installed ADE CLI shim");

    const installedHelp = await runCommand(installedCommandPath, ["--help"], {
      cwd: resourcesPath,
      env: { ...process.env },
    });
    assertAdeCliHelp(installedHelp.stdout, "Installed ADE CLI shim");
  } finally {
    await fsp.rm(installRoot, { recursive: true, force: true });
  }

  console.log(`[validate-win-artifacts] Windows packaged runtime smoke passed: ${path.relative(appDir, nodePtyAddon)}`);
}

async function validateAuthenticodeSignature(filePath, description, expectedIdentity) {
  if (!shouldRequireSignedArtifacts()) return null;
  if (process.platform !== "win32") {
    fail(`Cannot verify Authenticode signature for ${description} on ${process.platform}; run signed Windows validation on Windows.`);
  }

  // powershell.exe joins every token after -Command into the command text.
  // Passing filePath as a trailing argv value therefore turns it into source
  // code instead of $args[0]. Carry it in the child environment so paths with
  // spaces and PowerShell metacharacters remain data.
  //
  // Retried because the failure the probe reports as AdeProbeError is
  // environmental, not a verdict about the artifact: the first signed release
  // run died here on a file that existed and had just been signed, with the
  // cmdlet throwing rather than answering — the shape of a scanner holding a
  // just-written multi-GB installer. A real bad signature answers immediately
  // ("NotSigned", "HashMismatch") and is never retried.
  const probe = createAuthenticodeProbe(filePath);
  let payload;
  let lastStderr = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { stdout, stderr } = await runCommand(probe.command, probe.args, { env: probe.env });
    lastStderr = stderr.trim();
    try {
      payload = JSON.parse(stdout.trim());
    } catch {
      fail(
        `Unable to parse Authenticode signature status for ${description}: ${stdout.trim() || "empty output"}` +
          (lastStderr ? `\nprobe stderr: ${lastStderr}` : ""),
      );
    }
    const retryable = payload?.Status === AUTHENTICODE_PROBE_ERROR_STATUS || !payload?.Status;
    if (!retryable || attempt === 3) break;
    console.log(
      `[validate-win-artifacts] Signature probe for ${description} failed transiently ` +
        `(${payload?.StatusMessage || lastStderr || "no detail"}); retrying in ${attempt * 10}s.`,
    );
    await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
  }

  if (payload?.Status !== "Valid") {
    fail(
      `${description} is not Authenticode signed with a valid signature: ` +
        `${payload?.Status || "unknown"} ${payload?.StatusMessage ?? ""}`.trim() +
        (lastStderr ? `\nprobe stderr: ${lastStderr}` : ""),
    );
  }
  if (!payload?.TimestampSubject) {
    fail(`${description} has no trusted Authenticode timestamp`);
  }
  const identity = {
    subject: String(payload?.Subject ?? "").trim(),
    thumbprint: normalizeCertificateThumbprint(String(payload?.Thumbprint ?? "")),
  };
  if (!identity.subject || !identity.thumbprint) {
    fail(`${description} has no readable Authenticode signer identity`);
  }
  if (identity.subject.toLocaleLowerCase("en-US") !== expectedIdentity.subject.toLocaleLowerCase("en-US")) {
    fail(
      `${description} was signed by an unexpected publisher. ` +
        `Expected "${expectedIdentity.subject}", received "${identity.subject}".`,
    );
  }
  return identity;
}

/**
 * Where electron-builder wrote this build.
 *
 * Channel builds get their own output tree — `release-beta`, `release-alpha` —
 * because installer filenames are disambiguated but `latest.yml` and
 * `win-unpacked/` are not, so a channel build would otherwise overwrite the
 * updater manifest a Stable build left behind. This has to derive the directory
 * the same way run-electron-builder.mjs does, or the validator scans an empty
 * `release/` and reports the build missing when it succeeded.
 */
function defaultReleaseDir() {
  const { packageChannel } = packageIdentity;
  return path.join(desktopRoot, packageChannel === "stable" ? "release" : `release-${packageChannel}`);
}

async function validateReleaseArtifacts() {
  const releaseDir = resolveAbsolute(readFlag("--release-dir")) ?? defaultReleaseDir();
  const installerRegex = windowsInstallerPattern(packageIdentity);
  const installerPath =
    resolveAbsolute(readFlag("--installer")) ?? (await findArtifact(releaseDir, installerRegex, "Windows installer"));
  const installerBlockmapPath =
    resolveAbsolute(readFlag("--installer-blockmap")) ?? `${installerPath}.blockmap`;
  const latestPath = resolveAbsolute(readFlag("--latest")) ?? path.join(releaseDir, "latest.yml");
  const appDir = resolveAbsolute(readFlag("--app")) ?? path.join(releaseDir, "win-unpacked");

  await assertPathExists(releaseDir, "release output directory");
  await assertPathExists(installerPath, "Windows installer");
  const installerName = path.basename(installerPath);
  if (!isGithubSafeAssetName(installerName)) {
    fail(
      `Windows installer name must contain only letters, digits, dots, dashes, and underscores so the built file, `
        + `latest.yml, and the published GitHub release asset stay byte-identical: ${installerName}`,
    );
  }
  await assertPathExists(installerBlockmapPath, "Windows installer blockmap");
  await assertPathExists(appDir, "win-unpacked app directory");
  await validateLatestYaml(latestPath, installerPath);
  await validatePackagedRuntime(appDir);
  const expectedIdentity = expectedWindowsSigningIdentity();
  const installerIdentity = await validateAuthenticodeSignature(
    installerPath,
    "Windows installer",
    expectedIdentity,
  );
  const appIdentity = await validateAuthenticodeSignature(
    path.join(appDir, `${productName}.exe`),
    "packaged Windows app executable",
    expectedIdentity,
  );
  // Both artifacts are pinned to the same Subject above, but a Subject match
  // alone would still accept two different certificates carrying that Subject.
  // Requiring one thumbprint across the pair proves the installer and the
  // executable it installs came from the same signing operation. Azure Artifact
  // Signing rotates the leaf daily, so a build that straddles a rotation is the
  // one legitimate way this can trip; rerun the build rather than relaxing it.
  if (
    installerIdentity
    && appIdentity
    && installerIdentity.thumbprint !== appIdentity.thumbprint
  ) {
    fail(
      "Windows installer and packaged executable were signed by different certificates: " +
        `${installerIdentity.thumbprint} versus ${appIdentity.thumbprint}.`,
    );
  }

  console.log("[validate-win-artifacts] Windows release artifacts passed updater and packaged-runtime checks.");
}

const mode = readFlag("--mode") ?? "preflight";

try {
  if (mode === "preflight") {
    validatePreflight();
  } else if (mode === "release") {
    validatePreflight();
    await validateReleaseArtifacts();
  } else {
    fail(`Unknown mode: ${mode}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
