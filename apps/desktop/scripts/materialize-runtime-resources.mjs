import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveNpmInvocation } from "../../../scripts/dev-shared.mjs";
import { downloadOfficialNodeBinary, isSeaCapableNodeBinary } from "../../../scripts/release-tools/officialNodeBinary.mjs";
import runtimeResourceTargets from "./runtime-resource-targets.cjs";

const {
  RUNTIME_TARGET_ENV,
  artifactNamesForTarget,
  diffRuntimeArtifacts,
  hostRuntimeTarget: currentTarget,
  isRuntimeArtifactName,
  isRuntimeBinaryName,
  resolveRuntimeTargets,
} = runtimeResourceTargets;

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const cliRoot = path.join(repoRoot, "apps", "ade-cli");
const runtimeRoot = path.join(desktopRoot, "resources", "runtime");
const cliDistStaticRoot = path.join(cliRoot, "dist-static");
const runtimeTargetSet = resolveRuntimeTargets();
const allowHostOnlyRuntimeResources = runtimeTargetSet.mode === "host-only";

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const entry of paths) {
    if (!entry) continue;
    const resolved = path.resolve(entry);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

// Version: ADE_STATIC_NODE_VERSION, else the Node running this script.
async function downloadOfficialNodeBinaryForHost(target) {
  return downloadOfficialNodeBinary({
    target,
    version: process.env.ADE_STATIC_NODE_VERSION?.trim() || process.version,
    cacheRoot: path.resolve(
      process.env.ADE_STATIC_NODE_CACHE_DIR?.trim() || path.join(desktopRoot, ".cache", "runtime-node")
    ),
    logPrefix: "[runtime-resources]",
  });
}

async function resolveSeaNodeBinaryForHostBuild(target) {
  const explicit = process.env.ADE_STATIC_NODE_BINARY?.trim();
  if (explicit) {
    if (await isSeaCapableNodeBinary(explicit)) return explicit;
    throw new Error(`ADE_STATIC_NODE_BINARY is not SEA-capable: ${explicit}`);
  }
  if (await isSeaCapableNodeBinary(process.execPath)) return null;
  if (process.env.ADE_RUNTIME_DISABLE_NODE_DOWNLOAD === "1") {
    throw new Error(
      "This local source build needs to create ADE's bundled runtime helper, but this machine's Node install " +
        `cannot build it (${process.execPath}) and automatic helper-tool download is disabled. ` +
        "This does not affect people downloading ADE releases; release downloads already include the helper."
    );
  }
  return downloadOfficialNodeBinaryForHost(target);
}

async function walkFiles(rootPath, files = []) {
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(entryPath, files);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function collectArtifacts(rootPath) {
  const files = await walkFiles(rootPath);
  const matches = new Map();
  for (const filePath of files.sort((a, b) => a.localeCompare(b))) {
    const name = path.basename(filePath);
    if (!isRuntimeArtifactName(name) || matches.has(name)) continue;
    matches.set(name, filePath);
  }
  return matches;
}

async function copyArtifactsFrom(rootPath) {
  if (!(await pathExists(rootPath))) {
    console.log(`[runtime-resources] Artifact source missing, skipping: ${rootPath}`);
    return 0;
  }

  const artifacts = await collectArtifacts(rootPath);
  let copied = 0;
  await fs.mkdir(runtimeRoot, { recursive: true });

  for (const [name, sourcePath] of artifacts) {
    const destinationPath = path.join(runtimeRoot, name);
    if (path.resolve(sourcePath) !== path.resolve(destinationPath)) {
      await fs.copyFile(sourcePath, destinationPath);
      copied += 1;
    }
    if (isRuntimeBinaryName(name)) {
      await fs.chmod(destinationPath, 0o755);
    }
  }

  if (artifacts.size > 0) {
    console.log(`[runtime-resources] Materialized ${artifacts.size} artifact(s) from ${rootPath}.`);
  }
  return copied;
}

async function missingArtifactsForTarget(target) {
  const missing = [];
  for (const name of artifactNamesForTarget(target)) {
    const artifactPath = path.join(runtimeRoot, name);
    if (!(await pathExists(artifactPath))) {
      missing.push(name);
    }
  }
  return missing;
}

async function missingArtifacts() {
  const missing = [];
  for (const target of runtimeTargetSet.targets) {
    missing.push(...await missingArtifactsForTarget(target));
  }
  return missing;
}

// In pinned-target mode every other target's sidecar is deleted rather than
// merely left unrequested, so a re-widened CI artifact download cannot leave a
// foreign payload behind for electron-builder to pick up.
async function pruneForeignArtifacts() {
  if (!runtimeTargetSet.exclusive) return;
  const { unexpected } = diffRuntimeArtifacts(runtimeRoot, runtimeTargetSet.targets);
  for (const name of unexpected) {
    await fs.rm(path.join(runtimeRoot, name), { force: true });
  }
  if (unexpected.length > 0) {
    console.log(
      `[runtime-resources] Pruned ${unexpected.length} non-target runtime artifact(s) for `
      + `${runtimeTargetSet.targets.join(", ")}: ${unexpected.join(", ")}`
    );
  }
}

async function buildHostArtifactsIfNeeded() {
  const target = currentTarget();
  if (!runtimeTargetSet.targets.includes(target)) return false;

  const missingHostArtifacts = await missingArtifactsForTarget(target);
  if (missingHostArtifacts.length === 0) return false;

  console.log(
    `[runtime-resources] Missing host runtime artifact(s) for ${target}; building ${missingHostArtifacts.join(", ")}.`
  );
  const env = { ...process.env };
  const seaNodeBinary = await resolveSeaNodeBinaryForHostBuild(target);
  if (seaNodeBinary) {
    env.ADE_STATIC_NODE_BINARY = seaNodeBinary;
    console.log(`[runtime-resources] Using SEA-capable Node binary for ${target}: ${seaNodeBinary}`);
  }
  let stdout = "";
  let stderr = "";
  try {
    // Windows npm is a `.cmd` shim, and naming it `npm.cmd` is not enough: Node
    // has refused to spawn `.cmd`/`.bat` without a shell since CVE-2024-27980,
    // so `execFile` fails with EINVAL either way. Both measured.
    // `resolveNpmInvocation` sidesteps the shim by running npm's own JavaScript
    // entry point under this process's `node` — no shell, so no command-line
    // re-parsing, and a checkout under "C:\Users\First Last\..." survives
    // unquoted.
    const npm = resolveNpmInvocation([
      "--prefix",
      cliRoot,
      "run",
      "build:static",
      "--",
      "--target",
      target,
      "--out-dir",
      runtimeRoot,
    ]);
    const result = await execFileAsync(npm.command, npm.args, {
      cwd: desktopRoot,
      env,
      maxBuffer: 100 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
    stderr = typeof error?.stderr === "string" ? error.stderr : "";
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[runtime-resources] Failed to build host runtime artifacts for ${target}. ` +
        "This only affects local source builds; ADE release downloads already include these files. " +
        "Provide prebuilt runtime artifacts, or allow the script to download the official build helper. " +
        `Original error: ${message}`
    );
  }
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return true;
}

function formatMissing(missing) {
  return missing.map((name) => `  - ${name}`).join("\n");
}

async function main() {
  await fs.mkdir(runtimeRoot, { recursive: true });
  const artifactRoots = uniquePaths([
    process.env.ADE_RUNTIME_ARTIFACTS_DIR?.trim() || null,
    cliDistStaticRoot,
  ]);

  for (const artifactRoot of artifactRoots) {
    await copyArtifactsFrom(artifactRoot);
  }

  await buildHostArtifactsIfNeeded();
  await pruneForeignArtifacts();

  const missing = await missingArtifacts();
  if (missing.length > 0) {
    if (runtimeTargetSet.exclusive) {
      throw new Error(
        `[runtime-resources] ${RUNTIME_TARGET_ENV}=${runtimeTargetSet.targets.join(",")} but the runtime `
          + `artifact(s) below are missing:\n${formatMissing(missing)}\n`
          + "\nThe packaging job must download its own `ade-runtime-<target>` artifact before packaging."
      );
    }
    if (allowHostOnlyRuntimeResources) {
      console.warn(
        "[runtime-resources] Host-only local package mode is enabled; missing remote runtime artifact(s):\n" +
          `${formatMissing(missing)}\n` +
          "\nRemote runtime bootstrap to those targets will be unavailable in this local package. " +
          "Release builds still require the full runtime artifact set."
      );
      return;
    }
    throw new Error(
      "[runtime-resources] Missing remote ADE runtime artifact(s):\n" +
        `${formatMissing(missing)}\n` +
        "\nThis only affects local source builds; ADE release downloads already include these files. " +
        "For local packaging, point ADE_RUNTIME_ARTIFACTS_DIR at the CI runtime artifacts, or run the " +
        "runtime-binary workflow and download the `ade-runtime-*` artifacts before packaging."
    );
  }

  console.log(
    `[runtime-resources] Materialized ${runtimeTargetSet.mode} runtime resources for `
    + `${runtimeTargetSet.targets.length} target(s): ${runtimeTargetSet.targets.join(", ")}.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
