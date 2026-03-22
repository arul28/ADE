import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

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

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
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

async function validateSignedApp(appPath, description) {
  console.log(`[release:mac] Validating ${description}: ${appPath}`);
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
  await execFileAsync("xcrun", ["stapler", "validate", appPath]);
  await execFileAsync("spctl", ["-a", "-vvv", "--type", "execute", appPath]);
}

async function validateLatestMacYaml(latestMacPath, zipPath) {
  await assertPathExists(latestMacPath, "latest-mac.yml");
  const latestMac = parseYaml(await fs.readFile(latestMacPath, "utf8"));
  const expectedZipName = path.basename(zipPath);
  const referencedFiles = new Set(
    [
      latestMac?.path,
      ...(Array.isArray(latestMac?.files)
        ? latestMac.files.map((file) => file?.url ?? file?.path ?? null)
        : []),
    ].filter(Boolean)
  );

  if (!referencedFiles.has(expectedZipName)) {
    throw new Error(
      `[release:mac] latest-mac.yml does not reference ${expectedZipName}. ` +
        `Referenced entries: ${Array.from(referencedFiles).join(", ") || "none"}`
    );
  }

  const hasSha512 =
    Boolean(latestMac?.sha512) ||
    (Array.isArray(latestMac?.files) && latestMac.files.some((file) => Boolean(file?.sha512)));

  if (!hasSha512) {
    throw new Error("[release:mac] latest-mac.yml is missing sha512 metadata for the zip artifact");
  }
}

async function validateZip(zipPath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ade-release-zip-"));

  try {
    await execFileAsync("ditto", ["-x", "-k", zipPath, tempDir]);
    const entries = await fs.readdir(tempDir, { withFileTypes: true });
    const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    if (!appEntry) {
      throw new Error(`[release:mac] Extracted zip does not contain an .app bundle: ${zipPath}`);
    }

    const appPath = path.join(tempDir, appEntry.name);
    await validateSignedApp(appPath, "zip artifact");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function validateDmg(dmgPath) {
  const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "ade-release-dmg-"));

  try {
    await execFileAsync("xcrun", ["stapler", "validate", dmgPath]);
    try {
      await execFileAsync("spctl", ["-a", "-vvv", "--type", "open", dmgPath]);
    } catch (error) {
      const combinedOutput = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      if (!combinedOutput.includes("source=Insufficient Context")) {
        throw error;
      }

      console.warn(
        "[release:mac] DMG Gatekeeper open assessment returned 'Insufficient Context'. " +
          "This is expected for some locally-built, non-quarantined DMGs; continuing with mounted-app validation."
      );
    }

    await execFileAsync("hdiutil", ["attach", dmgPath, "-nobrowse", "-quiet", "-mountpoint", mountPoint]);

    const appPath = path.join(mountPoint, "ADE.app");
    await assertPathExists(appPath, "mounted ADE.app");
    await validateSignedApp(appPath, "mounted dmg artifact");
  } finally {
    await execFileAsync("hdiutil", ["detach", mountPoint, "-quiet"]).catch(() => {});
    await fs.rm(mountPoint, { recursive: true, force: true });
  }
}

const skipDmg = hasFlag("--skip-dmg");
const appPath =
  resolveAbsolute(readFlag("--app")) ?? path.join(releaseDir, "mac-universal", "ADE.app");
const zipPath =
  resolveAbsolute(readFlag("--zip")) ?? (await findArtifact(/^ADE-.+-universal-mac\.zip$/, "mac zip"));
const dmgPath = skipDmg
  ? null
  : resolveAbsolute(readFlag("--dmg")) ?? (await findArtifact(/^ADE-.+-universal\.dmg$/, "mac dmg"));
const latestMacPath = resolveAbsolute(readFlag("--latest")) ?? path.join(releaseDir, "latest-mac.yml");

await assertPathExists(appPath, "signed universal app bundle");
await assertPathExists(zipPath, "mac zip artifact");
if (dmgPath) {
  await assertPathExists(dmgPath, "mac dmg artifact");
}

await validateSignedApp(appPath, "signed universal app bundle");
await validateLatestMacYaml(latestMacPath, zipPath);
await validateZip(zipPath);
if (dmgPath) {
  await validateDmg(dmgPath);
}

console.log(
  `[release:mac] macOS release artifacts passed signature, notarization, Gatekeeper, and updater checks` +
    (skipDmg ? " (DMG validation skipped)" : "")
);
