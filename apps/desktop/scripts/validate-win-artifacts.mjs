import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(desktopRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const productName = pkg.build?.productName ?? pkg.productName ?? "ADE";

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
  return path.isAbsolute(input) ? input : path.resolve(desktopRoot, input);
}

function fail(message) {
  throw new Error(`[validate-win-artifacts] ${message}`);
}

async function assertPathExists(targetPath, description) {
  try {
    await fsp.access(targetPath);
  } catch {
    fail(`Missing ${description}: ${targetPath}`);
  }
}

function requireFile(relativePath, label) {
  const absolutePath = path.join(desktopRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`Missing ${label}: ${absolutePath}`);
  }
}

function hasExtraResource(to) {
  return Array.isArray(pkg.build?.extraResources)
    && pkg.build.extraResources.some((entry) => entry && entry.to === to);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function validatePreflight() {
  requireFile("build/icon.ico", "Windows app icon");
  requireFile("scripts/ade-cli-windows-wrapper.cmd", "Windows ADE CLI wrapper");
  requireFile("scripts/ade-cli-install-path.cmd", "Windows ADE CLI PATH installer");
  requireFile("vendor/crsqlite/win32-x64/crsqlite.dll", "Windows cr-sqlite extension");

  if (!hasExtraResource("ade-cli/bin/ade.cmd")) {
    fail("package.json build.extraResources must ship ade-cli/bin/ade.cmd");
  }
  if (!hasExtraResource("ade-cli/install-path.cmd")) {
    fail("package.json build.extraResources must ship ade-cli/install-path.cmd");
  }
  if (!Array.isArray(pkg.build?.asarUnpack) || !pkg.build.asarUnpack.includes("vendor/crsqlite/**")) {
    fail("package.json build.asarUnpack must unpack vendor/crsqlite/**");
  }
  if (!Array.isArray(pkg.build?.asarUnpack) || !pkg.build.asarUnpack.includes("node_modules/sql.js/**/*")) {
    fail("package.json build.asarUnpack must unpack node_modules/sql.js/**/* for the plain node fallback");
  }
  if (pkg.build?.win?.icon !== "build/icon.ico") {
    fail("package.json build.win.icon must point to build/icon.ico");
  }

  const winTargets = parseWinTargets();
  if (winTargets.length === 0) {
    fail("package.json build.win.target must define at least one Windows target");
  }
  if (!winTargets.every((entry) => entry.target === "nsis" && entry.arch.length === 1 && entry.arch[0] === "x64")) {
    fail("package.json build.win.target must pin NSIS to x64 until a Windows ARM64 cr-sqlite binary is bundled");
  }

  if (typeof pkg.scripts?.["dist:win"] !== "string" || !/\s--x64(?:\s|$)/.test(pkg.scripts["dist:win"])) {
    fail("package.json scripts.dist:win must pass --x64 until a Windows ARM64 cr-sqlite binary is bundled");
  }
  if (typeof pkg.scripts?.["dist:win"] !== "string" || !pkg.scripts["dist:win"].includes("validate:win:release")) {
    fail("package.json scripts.dist:win must validate the packaged Windows release output");
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

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(createCommandError(command, args, status, stdout, stderr));
    });
  });
}

async function findFirstNodeAddon(rootPath) {
  const entries = await fsp.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = await findFirstNodeAddon(entryPath);
      if (nestedMatch) return nestedMatch;
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
  ];

  try {
    const prebuildRoot = path.join(moduleRootPath, "prebuilds");
    const prebuildDirs = await fsp.readdir(prebuildRoot, { withFileTypes: true });
    for (const entry of prebuildDirs) {
      if (entry.isDirectory()) candidateRoots.push(path.join(prebuildRoot, entry.name));
    }
  } catch {
    // Keep the explicit candidate roots only.
  }

  for (const candidateRoot of candidateRoots) {
    try {
      await fsp.access(candidateRoot);
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

function createNodePathValue(paths, options = {}) {
  return paths.filter((entry) => options.includeMissing || fs.existsSync(entry)).join(";");
}

function assertAdeCliHelp(stdout, label) {
  if (!stdout.includes("Agent-focused command-line interface for ADE")) {
    fail(`${label} did not print ADE CLI help`);
  }
}

async function validatePackagedRuntime(appDir) {
  const appExe = path.join(appDir, `${productName}.exe`);
  const resourcesPath = path.join(appDir, "resources");
  const appAsarPath = path.join(resourcesPath, "app.asar");
  const unpackedPath = path.join(resourcesPath, "app.asar.unpacked");
  const adeCliPath = path.join(resourcesPath, "ade-cli", "cli.cjs");
  const adeCliBinPath = path.join(resourcesPath, "ade-cli", "bin", "ade.cmd");
  const adeCliInstallerPath = path.join(resourcesPath, "ade-cli", "install-path.cmd");
  const nodeModulesPath = path.join(unpackedPath, "node_modules");
  const nodePtyModulePath = path.join(nodeModulesPath, "node-pty");
  const sqlJsModulePath = path.join(nodeModulesPath, "sql.js");
  const smokeScriptPath = path.join(unpackedPath, "dist", "main", "packagedRuntimeSmoke.cjs");
  const crsqliteDllPath = path.join(unpackedPath, "vendor", "crsqlite", "win32-x64", "crsqlite.dll");

  await assertPathExists(appExe, "packaged Windows app executable");
  await assertPathExists(appAsarPath, "app.asar payload");
  await assertPathExists(unpackedPath, "app.asar.unpacked runtime payload");
  await assertPathExists(adeCliPath, "bundled ADE CLI entry");
  await assertPathExists(adeCliBinPath, "bundled ADE CLI wrapper");
  await assertPathExists(adeCliInstallerPath, "bundled ADE CLI PATH installer");
  await assertPathExists(nodePtyModulePath, "unpacked node-pty module");
  await assertPathExists(sqlJsModulePath, "unpacked sql.js module");
  await assertPathExists(smokeScriptPath, "unpacked packaged runtime smoke script");
  await assertPathExists(crsqliteDllPath, "unpacked Windows cr-sqlite extension");

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
  if (payload?.claudeQuery !== "function") {
    fail(`Packaged smoke expected Claude SDK query() to be available, got ${String(payload?.claudeQuery)}`);
  }
  if (typeof payload?.claudeExecutablePath !== "string" || payload.claudeExecutablePath.trim().length === 0) {
    fail("Packaged smoke did not report a Claude executable path");
  }
  if (!payload?.claudeStartup || typeof payload.claudeStartup !== "object") {
    fail("Packaged smoke did not report a Claude startup result");
  }
  if (payload.claudeStartup.state === "binary-missing") {
    console.warn("[validate-win-artifacts] Claude CLI is not installed on this machine; skipping live Claude startup check.");
  } else if (payload.claudeStartup.state === "runtime-failed") {
    fail(`Packaged smoke could not start Claude from the packaged app: ${String(payload.claudeStartup.message || "unknown error")}`);
  }
  if (payload?.codexExecutable !== "function") {
    fail(`Packaged smoke expected Codex executable resolver to be available, got ${String(payload?.codexExecutable)}`);
  }

  const defaultHelp = await runCommand(adeCliBinPath, ["--help"], {
    cwd: resourcesPath,
    env: { ...process.env },
  });
  assertAdeCliHelp(defaultHelp.stdout, "Bundled ADE CLI wrapper");

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

async function validateReleaseArtifacts() {
  const releaseDir = resolveAbsolute(readFlag("--release-dir")) ?? path.join(desktopRoot, "release");
  const installerRegex = new RegExp(`^${escapeRegExp(productName)}-.+-win-x64\\.exe$`);
  const installerPath =
    resolveAbsolute(readFlag("--installer")) ?? (await findArtifact(releaseDir, installerRegex, "Windows installer"));
  const installerBlockmapPath =
    resolveAbsolute(readFlag("--installer-blockmap")) ?? `${installerPath}.blockmap`;
  const latestPath = resolveAbsolute(readFlag("--latest")) ?? path.join(releaseDir, "latest.yml");
  const appDir = resolveAbsolute(readFlag("--app")) ?? path.join(releaseDir, "win-unpacked");

  await assertPathExists(releaseDir, "release output directory");
  await assertPathExists(installerPath, "Windows installer");
  await assertPathExists(installerBlockmapPath, "Windows installer blockmap");
  await assertPathExists(appDir, "win-unpacked app directory");
  await validateLatestYaml(latestPath, installerPath);
  await validatePackagedRuntime(appDir);

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
