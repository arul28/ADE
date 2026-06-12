import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { signAsync } from "@electron/osx-sign";

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const releaseDir = path.join(appDir, "release");
const defaultAppPath = path.join(releaseDir, "mac-universal", "ADE.app");
const entitlementsPath = path.join(appDir, "build", "entitlements.mac.plist");

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
  await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 10 });
}

async function verifyAppSignature(appPath, label) {
  console.log(`[release:mac] Verifying ${label}: ${appPath}`);
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  await run("codesign", ["--verify", "--strict", "--verbose=2", path.join(appPath, "Contents", "MacOS", "ADE")]);
}

const appPath = resolveAbsolute(readFlag("--app")) ?? defaultAppPath;
await assertPathExists(appPath, "universal ADE.app bundle");
await assertPathExists(entitlementsPath, "macOS entitlements");

let appNeedsRepair = false;
try {
  await verifyAppSignature(appPath, "pre-repair universal app signature");
  console.log("[release:mac] Universal app signature was already valid.");
} catch (error) {
  appNeedsRepair = true;
  const output = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
  const suffix = output ? `\n${output}` : "";
  console.warn(`[release:mac] Universal app signature verification failed; re-signing.${suffix}`);
}

if (appNeedsRepair) {
  await signAsync({
    app: appPath,
    platform: "darwin",
    entitlements: entitlementsPath,
    hardenedRuntime: true,
    strictVerify: true,
  });
}

await verifyAppSignature(appPath, "post-repair universal app signature");
console.log("[release:mac] Universal ADE.app signature is valid.");
