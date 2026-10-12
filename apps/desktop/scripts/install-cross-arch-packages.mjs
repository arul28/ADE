// Adds the other macOS architecture's npm platform packages to node_modules, so
// an Apple Silicon runner can package the x64 app at native speed.
//
// npm installs only the optional platform packages that match the host CPU, so
// on arm64 it skips every `*-darwin-x64` package (Cursor SDK, msgpackr,
// esbuild, ...). For each darwin package of the requested CPU in the lockfile
// whose host-arch twin is installed, this downloads the exact locked tarball,
// checks it against the lockfile's integrity hash, and unpacks it next to the
// twin. The host packages stay in place, so the build tools keep running
// natively; the afterPack hook then prunes whichever arch the target does not
// use, and validate-mac-artifacts checks every Mach-O in the bundle.
//
// Packages that compiled a native addon from source during `npm ci` (ssh2's
// crypto binding, cpu-features) built it for the host. Those are recompiled
// for the target CPU here; nothing in the build itself loads them.
//
//   node scripts/install-cross-arch-packages.mjs --cpu=x64
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { retryTransient } from "./release-retry.mjs";

const execFileAsync = promisify(execFile);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const cpuFlag = process.argv.slice(2).find((arg) => arg.startsWith("--cpu="));
const targetCpu = cpuFlag?.slice("--cpu=".length);
if (targetCpu !== "x64" && targetCpu !== "arm64") {
  throw new Error("[cross-arch] Pass --cpu=x64 or --cpu=arm64.");
}
const hostCpu = process.arch;
if (process.platform !== "darwin" || hostCpu === targetCpu) {
  console.log(`[cross-arch] Host is ${process.platform}-${hostCpu}; nothing to add for darwin-${targetCpu}.`);
  process.exit(0);
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function fetchVerified(url, integrity) {
  const [algorithm, expected] = integrity.split(/-(.*)/s);
  return retryTransient(
    `download of ${url}`,
    async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const body = Buffer.from(await response.arrayBuffer());
      const actual = crypto.createHash(algorithm).update(body).digest("base64");
      if (actual !== expected) throw new Error(`Integrity mismatch for ${url}`);
      return body;
    },
    { attempts: 4, delayMs: 5_000, isTransient: (text) => !text.includes("Integrity mismatch") },
  );
}

const lock = JSON.parse(await fs.readFile(path.join(appDir, "package-lock.json"), "utf8"));
const added = [];
for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
  if (!packagePath.includes("node_modules/")) continue;
  if (!entry.os?.includes("darwin") || entry.cpu?.length !== 1 || entry.cpu[0] !== targetCpu) continue;
  const destination = path.join(appDir, packagePath);
  if (await exists(destination)) continue;
  const twin = packagePath.replace(new RegExp(`darwin-${targetCpu}`, "g"), `darwin-${hostCpu}`);
  if (twin === packagePath || !(await exists(path.join(appDir, twin)))) continue;
  if (!entry.resolved || !entry.integrity) {
    throw new Error(`[cross-arch] ${packagePath} has no resolved URL or integrity in package-lock.json.`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-cross-arch-"));
  try {
    const tarball = path.join(tempDir, "package.tgz");
    await fs.writeFile(tarball, await fetchVerified(entry.resolved, entry.integrity));
    await execFileAsync("tar", ["-xzf", tarball, "-C", tempDir]);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(path.join(tempDir, "package"), destination, { recursive: true, verbatimSymlinks: true });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  added.push(`${packagePath.replace(/^.*node_modules\//, "")}@${entry.version}`);
}

console.log(`[cross-arch] Added ${added.length} darwin-${targetCpu} package(s):${added.map((name) => `\n  ${name}`).join("")}`);

// Find every addon node-gyp built during install: a binding.gyp with a
// build/Release/*.node beside it. Prebuilt addons (node-pty, msgpackr) have no
// build/Release and are covered by their per-arch prebuilds.
async function findCompiledAddons(dir, depth = 0, found = []) {
  if (depth > 6) return found;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "binding.gyp")) {
    const releaseDir = path.join(dir, "build", "Release");
    const addons = (await fs.readdir(releaseDir).catch(() => [])).filter((name) => name.endsWith(".node"));
    for (const addon of addons) found.push(path.join(releaseDir, addon));
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "build") {
      await findCompiledAddons(path.join(dir, entry.name), depth + 1, found);
    }
  }
  return found;
}

const nodeModules = path.join(appDir, "node_modules");
const compiled = await findCompiledAddons(nodeModules);
const packageNames = [...new Set(compiled.map((addon) => {
  const parts = path.relative(nodeModules, addon).split(path.sep);
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}))];
if (packageNames.length > 0) {
  console.log(`[cross-arch] Rebuilding install-compiled addons for ${targetCpu}: ${packageNames.join(", ")}`);
  await execFileAsync("npm", ["rebuild", ...packageNames], {
    cwd: appDir,
    maxBuffer: 1024 * 1024 * 50,
    env: { ...process.env, npm_config_arch: targetCpu, npm_config_target_arch: targetCpu },
  });
  // ssh2's installer reports a failed build as success and leaves no addon, so
  // require every addon that existed before the rebuild to exist after it.
  const rebuilt = new Set(await findCompiledAddons(nodeModules));
  const lost = compiled.filter((addon) => !rebuilt.has(addon));
  if (lost.length > 0) {
    throw new Error(`[cross-arch] Rebuilding for ${targetCpu} dropped: ${lost.map((addon) => path.relative(appDir, addon)).join(", ")}`);
  }
  const lipoArch = targetCpu === "x64" ? "x86_64" : "arm64";
  for (const addon of rebuilt) {
    const { stdout } = await execFileAsync("lipo", ["-archs", addon]);
    if (!stdout.trim().split(/\s+/).includes(lipoArch)) {
      throw new Error(`[cross-arch] ${path.relative(appDir, addon)} is ${stdout.trim()} after rebuild, not ${lipoArch}.`);
    }
    console.log(`[cross-arch] ${path.relative(appDir, addon)}: ${stdout.trim()}`);
  }
}
