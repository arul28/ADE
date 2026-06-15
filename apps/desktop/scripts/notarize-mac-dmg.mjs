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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCommandOutput(error) {
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return [stdout, stderr].filter(Boolean).join("\n");
}

async function stapleDmgWithRetry(dmgPath) {
  const maxAttempts = readPositiveIntegerEnv("ADE_DMG_STAPLE_MAX_ATTEMPTS", 12);
  const retryDelayMs = readPositiveIntegerEnv("ADE_DMG_STAPLE_RETRY_DELAY_MS", 30_000);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(`[release:mac] Stapling DMG ticket (${attempt}/${maxAttempts}): ${dmgPath}`);
    try {
      await execFileAsync("xcrun", ["stapler", "staple", dmgPath], { maxBuffer: 1024 * 1024 * 10 });
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      const output = formatCommandOutput(error);
      const suffix = output ? `\n${output}` : "";
      console.warn(
        `[release:mac] DMG stapling failed; retrying in ${Math.round(retryDelayMs / 1000)}s.${suffix}`
      );
      await sleep(retryDelayMs);
    }
  }
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
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "ade-dmg-notary-preflight-"));
  try {
    await execFileAsync("hdiutil", ["attach", dmgPath, "-nobrowse", "-quiet", "-mountpoint", mountPoint], {
      maxBuffer: 1024 * 1024 * 10,
    });
    const mountedAppPath = path.join(mountPoint, "ADE.app");
    await assertPathExists(mountedAppPath, "mounted ADE.app");
    await verifyAppSignature(mountedAppPath, "mounted DMG app signature before notarization");
  } finally {
    await execFileAsync("hdiutil", ["detach", mountPoint, "-quiet"]).catch(() => {});
    await fs.rm(mountPoint, { recursive: true, force: true });
  }
}

// Per-arch builds emit one DMG per architecture. Notarize + staple each so the
// artifact validator's `stapler validate` passes for every published DMG.
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
  const { stdout: notarytoolOutput } = await execFileAsync("xcrun", buildNotarytoolArgs(dmgPath), {
    maxBuffer: 1024 * 1024 * 10,
  });
  const notaryResult = JSON.parse(notarytoolOutput);
  if (notaryResult.status !== "Accepted") {
    throw new Error(
      `[release:mac] DMG notarization failed with status ${notaryResult.status ?? "unknown"} ` +
        `for ${path.basename(dmgPath)} (${notaryResult.id ?? "no submission id"})`
    );
  }
  console.log(`[release:mac] DMG notarization accepted: ${notaryResult.id ?? path.basename(dmgPath)}`);

  await stapleDmgWithRetry(dmgPath);

  try {
    await fs.rm(`${dmgPath}.blockmap`, { force: true });
    console.log(`[release:mac] Removed stale DMG blockmap after stapling: ${path.basename(dmgPath)}.blockmap`);
  } catch {
    // ignore cleanup failures
  }
}
