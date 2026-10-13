import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isAppleNetworkError, retryTransient } from "./release-retry.mjs";

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const releaseDir = path.join(appDir, "release");

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

function buildNotarytoolArgs(dmgPath) {
  if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) {
    return [
      "notarytool",
      "submit",
      dmgPath,
      "--key",
      process.env.APPLE_API_KEY,
      "--key-id",
      process.env.APPLE_API_KEY_ID,
      "--issuer",
      process.env.APPLE_API_ISSUER,
      "--output-format",
      "json",
      "--wait",
    ];
  }

  if (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) {
    return [
      "notarytool",
      "submit",
      dmgPath,
      "--apple-id",
      process.env.APPLE_ID,
      "--password",
      process.env.APPLE_APP_SPECIFIC_PASSWORD,
      "--team-id",
      process.env.APPLE_TEAM_ID,
      "--output-format",
      "json",
      "--wait",
    ];
  }

  if (process.env.APPLE_KEYCHAIN_PROFILE) {
    const args = [
      "notarytool",
      "submit",
      dmgPath,
      "--keychain-profile",
      process.env.APPLE_KEYCHAIN_PROFILE,
      "--output-format",
      "json",
      "--wait",
    ];
    if (process.env.APPLE_KEYCHAIN) {
      args.push("--keychain", process.env.APPLE_KEYCHAIN);
    }
    return args;
  }

  throw new Error(
    "[release:mac] Missing notarization credentials for DMG notarization. " +
      "Provide APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, " +
      "or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, " +
      "or APPLE_KEYCHAIN_PROFILE."
  );
}

function readPositiveIntegerEnv(name, fallback) {
  const rawValue = process.env[name];
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[release:mac] ${name} must be a positive integer, received: ${rawValue}`);
  }
  return parsed;
}

async function stapleDmgWithRetry(dmgPath) {
  const maxAttempts = readPositiveIntegerEnv("ADE_DMG_STAPLE_MAX_ATTEMPTS", 12);
  const retryDelayMs = readPositiveIntegerEnv("ADE_DMG_STAPLE_RETRY_DELAY_MS", 30_000);
  console.log(`[release:mac] Stapling DMG ticket: ${dmgPath}`);
  // A fresh ticket can take minutes to reach the CDN, so every staple failure
  // is retried on a fixed delay, not only network errors.
  await retryTransient(
    `stapling ${path.basename(dmgPath)}`,
    () => execFileAsync("xcrun", ["stapler", "staple", dmgPath], { maxBuffer: 1024 * 1024 * 10 }),
    { attempts: maxAttempts, delayMs: () => retryDelayMs },
  );
}

async function verifyAppSignature(appPath, description) {
  console.log(`[release:mac] Verifying ${description}: ${appPath}`);
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath], {
    maxBuffer: 1024 * 1024 * 10,
  });
  await execFileAsync(
    "codesign",
    ["--verify", "--strict", "--verbose=4", path.join(appPath, "Contents", "MacOS", "ADE")],
    { maxBuffer: 1024 * 1024 * 10 }
  );
}

async function verifyDmgBeforeNotarization(dmgPath) {
  // Verify the SOURCE app on disk (release/mac[-arm64]/ADE.app), NOT the app
  // mounted from the dmg. `codesign --verify` on an app inside a read-only,
  // compressed DMG returns a FALSE "code object is not signed at all" for the
  // large Electron Framework — even when the app is validly signed AND
  // Apple-notarized (notarization would reject an unsigned app). The on-disk
  // source app the dmg was built from verifies reliably.
  const name = path.basename(dmgPath);
  let archDir = "mac";
  if (name.includes("universal")) {
    archDir = "mac-universal";
  } else if (name.includes("arm64")) {
    archDir = "mac-arm64";
  }
  const sourceApp = path.join(releaseDir, archDir, "ADE.app");
  await assertPathExists(sourceApp, `source app for ${name} (${archDir}/ADE.app)`);
  await verifyAppSignature(sourceApp, `source app signature before notarizing ${name}`);
}

// Local recovery only (release-mac-local.mjs): CI no longer notarizes DMGs
// separately, since the app inside is notarized and stapled. Per-arch builds
// emit one DMG per architecture; notarize and staple each.
const explicitDmg = resolveAbsolute(readFlag("--dmg"));
const dmgPaths = explicitDmg
  ? [explicitDmg]
  : (await fs.readdir(releaseDir))
      .filter((name) => name.endsWith(".dmg"))
      .map((name) => path.join(releaseDir, name))
      .sort();
if (dmgPaths.length === 0) {
  throw new Error(`[release:mac] No .dmg artifacts found to notarize in ${releaseDir}`);
}

for (const dmgPath of dmgPaths) {
  await assertPathExists(dmgPath, "mac dmg artifact");
  await verifyDmgBeforeNotarization(dmgPath);

  console.log(`[release:mac] Submitting DMG for notarization: ${dmgPath}`);
  // Retry the submit on network errors; a real Invalid/Rejected verdict
  // throws on the first attempt.
  const notaryResult = await retryTransient(
    `notarization submit for ${path.basename(dmgPath)}`,
    async () => {
      const { stdout } = await execFileAsync("xcrun", buildNotarytoolArgs(dmgPath), { maxBuffer: 1024 * 1024 * 10 });
      const parsed = JSON.parse(stdout);
      if (parsed.status !== "Accepted") {
        throw new Error(
          `[release:mac] DMG notarization failed with status ${parsed.status ?? "unknown"} ` +
            `for ${path.basename(dmgPath)} (${parsed.id ?? "no submission id"})`,
        );
      }
      return parsed;
    },
    { attempts: 6, delayMs: (attempt) => Math.min(120_000, 10_000 * 2 ** (attempt - 1)), isTransient: isAppleNetworkError },
  );
  console.log(`[release:mac] DMG notarization accepted: ${notaryResult.id ?? path.basename(dmgPath)}`);

  await stapleDmgWithRetry(dmgPath);

  try {
    await fs.rm(`${dmgPath}.blockmap`, { force: true });
    console.log(`[release:mac] Removed stale DMG blockmap after stapling: ${path.basename(dmgPath)}.blockmap`);
  } catch {
    // ignore cleanup failures
  }
}
