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
  throw new Error("Usage: node scripts/notarize-static-runtime.mjs --binary=/path/to/ade-darwin-arm64");
}

const binaryPath = path.resolve(binary);
await assertExists(binaryPath, "ADE runtime binary");

if (process.platform !== "darwin") {
  throw new Error("Static runtime notarization must run on macOS.");
}

const identity = await findDeveloperIdIdentity();
console.log(`[runtime:notarize] Signing ${binaryPath} with ${identity}`);
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

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-runtime-notary-"));
const zipPath = path.join(workDir, `${path.basename(binaryPath)}.zip`);
try {
  console.log(`[runtime:notarize] Creating notarization archive ${zipPath}`);
  await run("ditto", ["-c", "-k", "--keepParent", binaryPath, zipPath]);

  console.log(`[runtime:notarize] Submitting ${path.basename(binaryPath)} to notarytool`);
  await run("xcrun", buildNotarytoolArgs(zipPath));

  console.log(`[runtime:notarize] Stapling ${binaryPath}`);
  await run("xcrun", ["stapler", "staple", binaryPath]);
  await run("spctl", ["--assess", "--type", "execute", "--verbose=4", binaryPath]);
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
