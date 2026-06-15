import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const releaseDir = path.join(appDir, "release");
const defaultAppPath = path.join(releaseDir, "mac-universal", "ADE.app");

function readFlag(name) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length).trim();
    }
  }
  return null;
}

function resolveAbsolute(input) {
  if (!input) return null;
  return path.isAbsolute(input) ? input : path.resolve(appDir, input);
}

async function assertPathExists(targetPath, description) {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(`[release:mac] Missing ${description}: ${targetPath}`);
  }
}

async function run(command, args) {
  await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 20 });
}

async function readPackageVersion() {
  const packageJson = JSON.parse(await fs.readFile(path.join(appDir, "package.json"), "utf8"));
  if (!packageJson.version) {
    throw new Error("[release:mac] package.json is missing version");
  }
  return packageJson.version;
}

async function verifyAppSignature(appPath, description) {
  console.log(`[release:mac] Verifying ${description}: ${appPath}`);
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
  await run("codesign", [
    "--verify",
    "--strict",
    "--verbose=4",
    path.join(appPath, "Contents", "MacOS", "ADE"),
  ]);
}

const version = readFlag("--version") ?? (await readPackageVersion());
const appPath = resolveAbsolute(readFlag("--app")) ?? defaultAppPath;
// --arch names the dmg per-architecture (ADE-<version>-<arch>.dmg). Falls back to
// the universal name for the legacy universal flow.
const arch = readFlag("--arch");
const dmgPath =
  resolveAbsolute(readFlag("--dmg")) ??
  path.join(releaseDir, `ADE-${version}-${arch || "universal"}.dmg`);
const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-dmg-stage-"));

await assertPathExists(appPath, "universal ADE.app bundle");
await fs.mkdir(releaseDir, { recursive: true });
await fs.rm(dmgPath, { force: true });
await fs.rm(`${dmgPath}.blockmap`, { force: true });

try {
  const stagedAppPath = path.join(stagingDir, "ADE.app");
  console.log(`[release:mac] Staging DMG app with ditto: ${appPath}`);
  await run("ditto", ["--rsrc", "--extattr", "--acl", appPath, stagedAppPath]);
  await fs.symlink("/Applications", path.join(stagingDir, "Applications"));
  await verifyAppSignature(stagedAppPath, "staged DMG app signature");

  console.log(`[release:mac] Creating ${arch || "universal"} DMG with hdiutil: ${dmgPath}`);
  await run("hdiutil", [
    "create",
    "-volname",
    "ADE",
    "-srcfolder",
    stagingDir,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ]);
  // The staged app (signed via ditto --extattr, verified above) is what hdiutil
  // packs, so the dmg's app signature is intact. We deliberately do NOT re-verify
  // by mounting the dmg: codesign --verify on an app inside a read-only mounted
  // dmg returns a false "not signed at all" for the Electron Framework.
  console.log(`[release:mac] ${arch || "universal"} DMG created with intact signature: ${dmgPath}`);
} finally {
  await fs.rm(stagingDir, { recursive: true, force: true });
}
