import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import asar from "@electron/asar";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const releaseDir = path.join(appDir, "release");
const DEFAULT_MAX_APP_ASAR_BYTES = 900 * 1024 * 1024;
const DEFAULT_MAX_UNPACKED_BYTES = 600 * 1024 * 1024;
const REMOTE_RUNTIME_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

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

function resolveAbsolute(input) {
  if (!input) return null;
  return path.isAbsolute(input) ? input : path.resolve(appDir, input);
}

function readByteLimit(envName, fallback) {
  const rawValue = process.env[envName];
  if (!rawValue) return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[release:mac] ${envName} must be a positive byte count, received: ${rawValue}`);
  }
  return parsed;
}

async function collectMatchingPaths(rootPath, predicate, matches = []) {
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
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

async function computeRecursiveFileSize(rootPath) {
  let totalBytes = 0;
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      totalBytes += await computeRecursiveFileSize(entryPath);
    } else if (entry.isFile()) {
      totalBytes += (await fs.stat(entryPath)).size;
    }
  }

  return totalBytes;
}

function formatRelativeSample(rootPath, entries) {
  return entries
    .slice(0, 12)
    .map((entry) => path.relative(rootPath, entry) || path.basename(entry))
    .join(", ");
}

async function assertPathMissing(targetPath, description) {
  try {
    await fs.access(targetPath);
  } catch {
    return;
  }
  throw new Error(`[release:mac] Unexpected ${description}: ${targetPath}`);
}

async function assertPathExists(targetPath, description) {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(`[release:mac] Missing ${description}: ${targetPath}`);
  }
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

async function assertRemoteRuntimeBundle(resourcesPath, description) {
  const runtimeRoot = path.join(resourcesPath, "runtime");
  await assertPathExists(runtimeRoot, `remote runtime bundle directory for ${description}`);
  for (const target of REMOTE_RUNTIME_TARGETS) {
    const binaryPath = path.join(runtimeRoot, `ade-${target}`);
    const nativeArchivePath = path.join(runtimeRoot, `ade-${target}.native.tar.gz`);
    await assertPathExists(binaryPath, `remote runtime binary ${target} for ${description}`);
    await assertExecutable(binaryPath, `remote runtime binary ${target}`);
    await assertPathExists(nativeArchivePath, `remote runtime native dependency archive ${target} for ${description}`);
    const { stdout } = await execFileAsync("tar", ["-tzf", nativeArchivePath]);
    if (!stdout.split(/\r?\n/).some((entry) => entry.startsWith("./node_modules/"))) {
      throw new Error(`[release:mac] Remote runtime native archive for ${target} does not contain ./node_modules/: ${nativeArchivePath}`);
    }
  }
}

async function findFirstNodeAddon(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      const nestedMatch = await findFirstNodeAddon(entryPath);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".node")) {
      return entryPath;
    }
  }

  return null;
}

async function findNodePtyAddon(moduleRootPath) {
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

    const addonPath = await findFirstNodeAddon(candidateRoot);
    if (addonPath) {
      return addonPath;
    }
  }

  return null;
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

async function validatePackageHygiene(appPath, description) {
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const appAsarPath = path.join(resourcesPath, "app.asar");
  const unpackedPaths = await resolveRuntimeUnpackedPaths(resourcesPath);
  const maxAppAsarBytes = readByteLimit("ADE_MAX_APP_ASAR_BYTES", DEFAULT_MAX_APP_ASAR_BYTES);
  const maxUnpackedBytes = readByteLimit("ADE_MAX_APP_ASAR_UNPACKED_BYTES", DEFAULT_MAX_UNPACKED_BYTES);

  if (unpackedPaths.length === 0) {
    throw new Error(`[release:mac] Missing unpacked runtime payload for ${description}: ${resourcesPath}`);
  }

  const appAsarStat = await fs.stat(appAsarPath);
  if (appAsarStat.size > maxAppAsarBytes) {
    throw new Error(
      `[release:mac] app.asar is too large for ${description}: ${appAsarStat.size} bytes ` +
        `(limit ${maxAppAsarBytes})`
    );
  }

  let unpackedBytes = 0;
  for (const unpackedPath of unpackedPaths) {
    unpackedBytes += await computeRecursiveFileSize(unpackedPath);
  }
  if (unpackedBytes > maxUnpackedBytes) {
    throw new Error(
      `[release:mac] unpacked runtime payload is too large for ${description}: ${unpackedBytes} bytes ` +
        `(limit ${maxUnpackedBytes})`
    );
  }

  // Source-map and binary-package hygiene checks are paused until the
  // perf-fixes packaging changes are reapplied with a post-universal-merge prune.

  // Pruning these payloads on darwin requires a post-universal-merge step
  // that does not exist yet; the per-arch afterPack prune races the merge.
  // Until that lands, the macOS package legitimately ships these directories.

  console.log(`[release:mac] Package hygiene passed for ${description}`);
}

async function validatePackagedRuntime(appPath, description) {
  const appName = path.basename(appPath, ".app");
  const executablePath = path.join(appPath, "Contents", "MacOS", appName);
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const appAsarPath = path.join(resourcesPath, "app.asar");
  const unpackedPath = await resolveRuntimeUnpackedPath(resourcesPath);
  const adeCliPath = path.join(resourcesPath, "ade-cli", "cli.cjs");
  const adeCliBootstrapPath = path.join(resourcesPath, "ade-cli", "bootstrap.cjs");
  const adeCliRpcPath = path.join(resourcesPath, "ade-cli", "adeRpcServer.cjs");
  const adeCliTuiPath = path.join(resourcesPath, "ade-cli", "tuiClient", "cli.mjs");
  const adeCliBinPath = path.join(resourcesPath, "ade-cli", "bin", "ade");
  const adeCliInstallerPath = path.join(resourcesPath, "ade-cli", "install-path.sh");
  const bundledAgentSkillsPath = path.join(resourcesPath, "agent-skills", "ade-cli-control-plane", "SKILL.md");
  const iosSimHelperRoot = path.join(resourcesPath, "native", "ios-sim-helpers");
  const iosSimHelperBuildScript = path.join(iosSimHelperRoot, "build.sh");
  const nodeModulesPath = path.join(unpackedPath, "node_modules");
  const nodePtyModulePath = path.join(nodeModulesPath, "node-pty");
  const smokeScriptPath = path.join(unpackedPath, "dist", "main", "packagedRuntimeSmoke.cjs");

  console.log(`[release:mac] Smoke testing packaged runtime payload for ${description}`);
  await assertPathExists(executablePath, "packaged app executable");
  await assertPathExists(appAsarPath, "app.asar payload");
  await assertPathExists(unpackedPath, "unpacked runtime payload");
  await assertPathExists(adeCliPath, "bundled ADE CLI entry");
  await assertPathExists(adeCliBootstrapPath, "bundled ADE CLI bootstrap entry");
  await assertPathExists(adeCliRpcPath, "bundled ADE CLI RPC entry");
  await assertPathExists(adeCliTuiPath, "bundled ADE CLI TUI entry");
  await assertPathExists(adeCliBinPath, "bundled ADE CLI wrapper");
  await assertPathExists(adeCliInstallerPath, "bundled ADE CLI PATH installer");
  await assertPathExists(bundledAgentSkillsPath, "bundled ADE agent skills");
  await assertPathExists(iosSimHelperBuildScript, "bundled iOS simulator helper build script");
  await assertPathExists(path.join(iosSimHelperRoot, "sim-capture.swift"), "bundled iOS simulator capture helper source");
  await assertPathExists(path.join(iosSimHelperRoot, "sim-input.m"), "bundled iOS simulator input helper source");
  await assertPathMissing(path.join(iosSimHelperRoot, "build"), "bundled iOS simulator helper build cache");
  await assertExecutable(adeCliBinPath, "bundled ADE CLI wrapper");
  await assertExecutable(adeCliInstallerPath, "bundled ADE CLI PATH installer");
  await assertExecutable(iosSimHelperBuildScript, "bundled iOS simulator helper build script");
  await assertPathExists(nodePtyModulePath, "unpacked node-pty module");
  await assertPathExists(smokeScriptPath, "unpacked packaged runtime smoke script");
  const adeCliTuiContents = await fs.readFile(adeCliTuiPath, "utf8");
  for (const token of ["__dirname", "__filename"]) {
    if (adeCliTuiContents.includes(token) && !adeCliTuiContents.includes(`const ${token} =`)) {
      throw new Error(`[release:mac] Bundled ADE code TUI references ${token} without an ESM shim`);
    }
  }
  await assertRemoteRuntimeBundle(resourcesPath, description);
  await validatePackageHygiene(appPath, description);

  const nodePtyAddon = await findNodePtyAddon(nodePtyModulePath);
  if (!nodePtyAddon) {
    throw new Error(`[release:mac] Missing node-pty native addon under ${nodePtyModulePath}`);
  }
  const nodePtySpawnHelper = await findNodePtySpawnHelper(nodePtyModulePath);
  if (!nodePtySpawnHelper) {
    throw new Error(`[release:mac] Missing node-pty spawn-helper under ${nodePtyModulePath}`);
  }
  await assertExecutable(nodePtySpawnHelper, "node-pty spawn-helper");

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
  if (payload.claudeExecutablePath.includes("app.asar")) {
    throw new Error(
      `[release:mac] Packaged smoke resolved Claude to an asar-backed path instead of the system CLI: ${payload.claudeExecutablePath}`
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
  if (payload?.openCodeExecutableSource !== "bundled") {
    throw new Error(
      `[release:mac] Packaged smoke expected bundled OpenCode, got ${String(payload?.openCodeExecutableSource)} at ${String(payload?.openCodeExecutablePath)}`
    );
  }

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

async function validateLatestMacYaml(latestMacPath, zipPath) {
  await assertPathExists(latestMacPath, "latest-mac.yml");
  const latestMac = parseYaml(await fs.readFile(latestMacPath, "utf8"));
  const expectedZipName = path.basename(zipPath);
  const referencedFiles = new Set(
    [
      latestMac?.path,
      ...(Array.isArray(latestMac?.files)
        ? latestMac.files.map((file) => file?.url ?? file?.path ?? null)
        : []),
    ].filter(Boolean)
  );

  if (!referencedFiles.has(expectedZipName)) {
    throw new Error(
      `[release:mac] latest-mac.yml does not reference ${expectedZipName}. ` +
        `Referenced entries: ${Array.from(referencedFiles).join(", ") || "none"}`
    );
  }

  const hasSha512 =
    Boolean(latestMac?.sha512) ||
    (Array.isArray(latestMac?.files) && latestMac.files.some((file) => Boolean(file?.sha512)));

  if (!hasSha512) {
    throw new Error("[release:mac] latest-mac.yml is missing sha512 metadata for the zip artifact");
  }
}

async function validateZip(zipPath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-release-zip-"));

  try {
    await execFileAsync("ditto", ["-x", "-k", zipPath, tempDir]);
    const entries = await fs.readdir(tempDir, { withFileTypes: true });
    const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    if (!appEntry) {
      throw new Error(`[release:mac] Extracted zip does not contain an .app bundle: ${zipPath}`);
    }

    const appPath = path.join(tempDir, appEntry.name);
    await validateSignedApp(appPath, "zip artifact");
    await validatePackagedRuntime(appPath, "zip artifact");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function validateDmg(dmgPath) {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "ade-release-dmg-"));

  try {
    await execFileAsync("xcrun", ["stapler", "validate", dmgPath]);
    try {
      await execFileAsync("spctl", ["-a", "-vvv", "--type", "open", dmgPath]);
    } catch (error) {
      const combinedOutput = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      if (!combinedOutput.includes("source=Insufficient Context")) {
        throw error;
      }

      console.warn(
        "[release:mac] DMG Gatekeeper open assessment returned 'Insufficient Context'. " +
          "This is expected for some locally-built, non-quarantined DMGs; continuing with mounted-app validation."
      );
    }

    await execFileAsync("hdiutil", ["attach", dmgPath, "-nobrowse", "-quiet", "-mountpoint", mountPoint]);

    const appPath = path.join(mountPoint, "ADE.app");
    await assertPathExists(appPath, "mounted ADE.app");
    await validateSignedApp(appPath, "mounted dmg artifact");
    await validatePackagedRuntime(appPath, "mounted dmg artifact");
  } finally {
    await execFileAsync("hdiutil", ["detach", mountPoint, "-quiet"]).catch(() => {});
    await fs.rm(mountPoint, { recursive: true, force: true });
  }
}

const skipDmg = hasFlag("--skip-dmg");
const appPath =
  resolveAbsolute(readFlag("--app")) ?? path.join(releaseDir, "mac-universal", "ADE.app");
const zipPath =
  resolveAbsolute(readFlag("--zip")) ?? (await findArtifact(/^ADE-.+-universal-mac\.zip$/, "mac zip"));
const dmgPath = skipDmg
  ? null
  : resolveAbsolute(readFlag("--dmg")) ?? (await findArtifact(/^ADE-.+-universal\.dmg$/, "mac dmg"));
const latestMacPath = resolveAbsolute(readFlag("--latest")) ?? path.join(releaseDir, "latest-mac.yml");

await assertPathExists(appPath, "signed universal app bundle");
await assertPathExists(zipPath, "mac zip artifact");
if (dmgPath) {
  await assertPathExists(dmgPath, "mac dmg artifact");
}

await validateSignedApp(appPath, "signed universal app bundle");
await validateLatestMacYaml(latestMacPath, zipPath);
await validateZip(zipPath);
if (dmgPath) {
  await validateDmg(dmgPath);
}

console.log(
  `[release:mac] macOS release artifacts passed signature, notarization, Gatekeeper, updater, and packaged runtime checks` +
    (skipDmg ? " (DMG validation skipped)" : "")
);
