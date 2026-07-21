import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function readFlag(name) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length).trim();
  }
  return null;
}

function hasEnv(name) {
  return Boolean(process.env[name] && String(process.env[name]).trim().length > 0);
}

async function assertExists(filePath, label) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

async function findDeveloperIdIdentity() {
  const { stdout } = await run("security", ["find-identity", "-v", "-p", "codesigning"]);
  const explicit = process.env.ADE_RUNTIME_CODESIGN_IDENTITY || process.env.CSC_NAME;
  if (explicit?.trim()) return explicit.trim();

  for (const line of stdout.split(/\r?\n/)) {
    const match = /"([^"]*Developer ID Application[^"]*)"/.exec(line);
    if (match?.[1]) return match[1];
  }
  throw new Error("Unable to find a Developer ID Application signing identity.");
}

async function walkFiles(rootPath, files = []) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
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

async function isMachO(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 4) return false;
    return [
      "feedface",
      "feedfacf",
      "cefaedfe",
      "cffaedfe",
      "cafebabe",
      "bebafeca",
      "cafebabf",
      "bfbafeca",
    ].includes(buffer.toString("hex"));
  } finally {
    await handle.close();
  }
}

async function signBinary(binaryPath, identity) {
  await run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--sign",
    identity,
    binaryPath,
  ]);
  await run("codesign", ["--verify", "--strict", "--verbose=4", binaryPath]);
}

async function signNativeArchiveIfPresent(binaryPath, identity) {
  const archivePath = `${binaryPath}.native.tar.gz`;
  if (!(await pathExists(archivePath))) {
    return;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-runtime-native-sign-"));
  try {
    console.log(`[runtime:notarize] Signing Mach-O payloads in ${archivePath}`);
    await run("tar", ["-xzf", archivePath, "-C", workDir]);

    const files = await walkFiles(workDir);
    let signed = 0;
    for (const filePath of files) {
      if (!(await isMachO(filePath))) continue;
      await signBinary(filePath, identity);
      signed += 1;
    }

    if (signed === 0) {
      console.log(`[runtime:notarize] No Mach-O payloads found in ${path.basename(archivePath)}`);
    } else {
      console.log(`[runtime:notarize] Signed ${signed} Mach-O payload(s) in ${path.basename(archivePath)}`);
    }

    const nextArchivePath = `${archivePath}.tmp`;
    await fs.rm(nextArchivePath, { force: true });
    await run("tar", ["-czf", nextArchivePath, "-C", workDir, "."]);
    await fs.rename(nextArchivePath, archivePath);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function verifyNativeArchiveIfPresent(binaryPath) {
  const archivePath = `${binaryPath}.native.tar.gz`;
  if (!(await pathExists(archivePath))) {
    return;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-runtime-native-verify-"));
  try {
    console.log(`[runtime:notarize] Verifying pre-signed Mach-O payloads in ${archivePath}`);
    await run("tar", ["-xzf", archivePath, "-C", workDir]);

    const files = await walkFiles(workDir);
    let verified = 0;
    for (const filePath of files) {
      if (!(await isMachO(filePath))) continue;
      await run("codesign", ["--verify", "--strict", "--verbose=4", filePath]);
      verified += 1;
    }

    if (verified === 0) {
      console.log(`[runtime:notarize] No Mach-O payloads found in ${path.basename(archivePath)}`);
    } else {
      console.log(`[runtime:notarize] Verified ${verified} Mach-O payload(s) in ${path.basename(archivePath)}`);
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function stapleBinaryIfSupported(binaryPath) {
  let stapled = false;
  try {
    console.log(`[runtime:notarize] Stapling ${binaryPath}`);
    await run("xcrun", ["stapler", "staple", binaryPath]);
    stapled = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[runtime:notarize] Notarization was accepted, but stapling the raw runtime binary failed. " +
        "Continuing because stapler may reject non-bundle executables; desktop app notarization " +
        `will validate the packaged runtime payload. Original error: ${message}`,
      );
  }
  if (stapled) {
    await run("spctl", ["--assess", "--type", "execute", "--verbose=4", binaryPath]);
  }
}

function buildNotarytoolArgs(zipPath) {
  if (hasEnv("APPLE_API_KEY") && hasEnv("APPLE_API_KEY_ID") && hasEnv("APPLE_API_ISSUER")) {
    return [
      "notarytool",
      "submit",
      zipPath,
      "--key",
      process.env.APPLE_API_KEY,
      "--key-id",
      process.env.APPLE_API_KEY_ID,
      "--issuer",
      process.env.APPLE_API_ISSUER,
      "--wait",
    ];
  }

  if (hasEnv("APPLE_ID") && hasEnv("APPLE_APP_SPECIFIC_PASSWORD") && hasEnv("APPLE_TEAM_ID")) {
    return [
      "notarytool",
      "submit",
      zipPath,
      "--apple-id",
      process.env.APPLE_ID,
      "--password",
      process.env.APPLE_APP_SPECIFIC_PASSWORD,
      "--team-id",
      process.env.APPLE_TEAM_ID,
      "--wait",
    ];
  }

  if (hasEnv("APPLE_KEYCHAIN_PROFILE")) {
    const args = ["notarytool", "submit", zipPath, "--keychain-profile", process.env.APPLE_KEYCHAIN_PROFILE, "--wait"];
    if (hasEnv("APPLE_KEYCHAIN")) args.push("--keychain", process.env.APPLE_KEYCHAIN);
    return args;
  }

  throw new Error(
    "Missing notarization credentials. Provide APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, " +
      "or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or APPLE_KEYCHAIN_PROFILE.",
  );
}

const binary = readFlag("--binary");
if (!binary) {
  throw new Error("Usage: node scripts/notarize-static-runtime.mjs --binary=/path/to/ade-darwin-arm64 [--sign-native-only|--verify-native-only]");
}
const signNativeOnly = process.argv.includes("--sign-native-only");
const verifyNativeOnly = process.argv.includes("--verify-native-only");
if (signNativeOnly && verifyNativeOnly) {
  throw new Error("Use only one of --sign-native-only or --verify-native-only.");
}

const binaryPath = path.resolve(binary);
await assertExists(binaryPath, "ADE runtime binary");

if (process.platform !== "darwin") {
  throw new Error("Static runtime notarization must run on macOS.");
}

if (signNativeOnly) {
  const identity = await findDeveloperIdIdentity();
  console.log(`[runtime:notarize] Signing native archive payloads for ${binaryPath} with ${identity}`);
  await signNativeArchiveIfPresent(binaryPath, identity);
  process.exit(0);
}

if (verifyNativeOnly) {
  console.log(`[runtime:notarize] Verifying pre-signed native archive payloads for ${binaryPath}`);
  await verifyNativeArchiveIfPresent(binaryPath);
  process.exit(0);
}

const identity = await findDeveloperIdIdentity();
console.log(`[runtime:notarize] Signing ${binaryPath} with ${identity}`);
await signBinary(binaryPath, identity);
await signNativeArchiveIfPresent(binaryPath, identity);

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-runtime-notary-"));
const zipPath = path.join(workDir, `${path.basename(binaryPath)}.zip`);
try {
  console.log(`[runtime:notarize] Creating notarization archive ${zipPath}`);
  await run("ditto", ["-c", "-k", "--keepParent", binaryPath, zipPath]);

  console.log(`[runtime:notarize] Submitting ${path.basename(binaryPath)} to notarytool`);
  await run("xcrun", buildNotarytoolArgs(zipPath));

  await stapleBinaryIfSupported(binaryPath);
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
