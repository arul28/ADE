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
//   node scripts/install-cross-arch-packages.mjs --cpu=x64
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const body = Buffer.from(await response.arrayBuffer());
      const actual = crypto.createHash(algorithm).update(body).digest("base64");
      if (actual !== expected) throw new Error(`Integrity mismatch for ${url}`);
      return body;
    } catch (error) {
      if (attempt >= 4 || /Integrity mismatch/.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
    }
  }
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
