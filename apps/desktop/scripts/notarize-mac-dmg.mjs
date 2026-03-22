import fs from "node:fs/promises";
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
      "--wait",
    ];
  }

  if (process.env.APPLE_KEYCHAIN_PROFILE) {
    const args = ["notarytool", "submit", dmgPath, "--keychain-profile", process.env.APPLE_KEYCHAIN_PROFILE, "--wait"];
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

const dmgPath =
  resolveAbsolute(readFlag("--dmg")) ?? (await findArtifact(/^ADE-.+-universal\.dmg$/, "mac dmg"));
const dmgBlockmapPath = `${dmgPath}.blockmap`;

await assertPathExists(dmgPath, "mac dmg artifact");

console.log(`[release:mac] Submitting DMG for notarization: ${dmgPath}`);
await execFileAsync("xcrun", buildNotarytoolArgs(dmgPath), { maxBuffer: 1024 * 1024 * 10 });

console.log(`[release:mac] Stapling DMG ticket: ${dmgPath}`);
await execFileAsync("xcrun", ["stapler", "staple", dmgPath], { maxBuffer: 1024 * 1024 * 10 });

try {
  await fs.rm(dmgBlockmapPath, { force: true });
  console.log(
    `[release:mac] Removed stale DMG blockmap after stapling: ${path.basename(dmgBlockmapPath)}`
  );
} catch {
  // ignore cleanup failures
}

