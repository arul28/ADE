#!/usr/bin/env node
/**
 * Pin Meta's `muse` binary to the build that pairs with the locked
 * `@muse-code/sdk`, by writing `scripts/muse-release.json`.
 *
 * The binary is not on npm, so its per-target URL, sha256 and size come from
 * Meta's versioned release manifest. This is the only step that talks to the
 * network; `generate-tools-manifest.mjs` reads the file this writes and stays
 * offline.
 *
 * SDK `X.Y.Z` pairs with binary `X.Y.Z-R<build>`. The build is taken from
 * `--version`, else from the current muse-stable channel, else from the
 * existing muse-release.json. Anything that does not pair is refused.
 *
 *   npm run tools:muse-pin                               # pin + regenerate the tools manifest
 *   npm run tools:muse-pin -- --version 1.4.7-R6101.1    # pin an exact build
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lockPath = path.join(packageRoot, "package-lock.json");
const releasePath = path.join(packageRoot, "scripts", "muse-release.json");

const CHANNEL_URL = "https://api.meta.ai/muse-code/channels/muse-stable";
const versionedManifestUrl = (version) =>
  `https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${encodeURIComponent(version)}&file=manifest.json`;

/** ADE tools target -> Meta artifact key. */
const TARGET_ARTIFACTS = {
  "darwin-arm64": "aarch64_macos",
  "darwin-x64": "x86_macos",
  "linux-arm64": "aarch64_linux",
  "linux-x64": "x86_linux",
  "win32-x64": "x86_windows",
};

function fail(message) {
  process.stderr.write(`tools:muse-pin: ${message}\n`);
  process.exit(1);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function lockedSdkVersion() {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const version = lock.packages?.["node_modules/@muse-code/sdk"]?.version;
  if (typeof version !== "string") fail("@muse-code/sdk is not in apps/ade-cli/package-lock.json.");
  return version;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "user-agent": "ADE muse pin" }, redirect: "follow" });
  if (!response.ok) fail(`GET ${url} answered HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch (error) {
    fail(`GET ${url} did not return JSON: ${error.message}`);
  }
}

function readExistingRelease() {
  try {
    return JSON.parse(readFileSync(releasePath, "utf8"));
  } catch {
    return null;
  }
}

async function chooseVersion(sdkVersion) {
  const pairs = (version) => typeof version === "string" && version.startsWith(`${sdkVersion}-R`);
  const explicit = argValue("--version");
  if (explicit) {
    if (!pairs(explicit)) fail(`--version ${explicit} does not pair with @muse-code/sdk@${sdkVersion} (want ${sdkVersion}-R…).`);
    return explicit;
  }
  const channel = await fetchJson(CHANNEL_URL);
  if (pairs(channel.version)) return channel.version;
  const existing = readExistingRelease();
  if (pairs(existing?.version)) {
    process.stderr.write(
      `tools:muse-pin: muse-stable is at ${channel.version}; keeping the existing pairing ${existing.version}.\n`,
    );
    return existing.version;
  }
  fail(
    `@muse-code/sdk@${sdkVersion} has no paired muse build: muse-stable is at ${String(channel.version)}. `
    + `Pass --version ${sdkVersion}-R<build>, or move the SDK to the channel's version.`,
  );
}

function readSdkFingerprint() {
  // Optional cross-check: the fingerprint the SDK was written against.
  for (const candidate of [
    path.join(packageRoot, "node_modules", "@muse-code", "sdk", "dist", "src", "fingerprint.js"),
    path.join(packageRoot, "..", "node_modules", "@muse-code", "sdk", "dist", "src", "fingerprint.js"),
  ]) {
    try {
      const match = /EXPECTED_SCHEMA_FINGERPRINT\s*=\s*"([^"]+)"/.exec(readFileSync(candidate, "utf8"));
      if (match) return match[1];
    } catch {
      // not installed here
    }
  }
  return null;
}

const sdkVersion = lockedSdkVersion();
const version = await chooseVersion(sdkVersion);
const manifestUrl = versionedManifestUrl(version);
const manifest = await fetchJson(manifestUrl);

if (manifest.version !== version) fail(`${manifestUrl} describes ${String(manifest.version)}, not ${version}.`);
if (manifest.checksum_algorithm !== "sha256") {
  fail(`${manifestUrl} uses checksum algorithm ${String(manifest.checksum_algorithm)}; only sha256 is supported.`);
}

const targets = {};
for (const [target, artifactKey] of Object.entries(TARGET_ARTIFACTS)) {
  const artifact = manifest.artifacts?.[artifactKey];
  if (!artifact) fail(`${manifestUrl} has no ${artifactKey} artifact for ${target}.`);
  const { url, checksum, size } = artifact;
  if (typeof url !== "string" || !url.startsWith("https://")) fail(`${artifactKey} has no https url.`);
  if (typeof checksum !== "string" || !/^[0-9a-fA-F]{64}$/.test(checksum)) fail(`${artifactKey} has no sha256 hex checksum.`);
  if (!Number.isSafeInteger(size) || size <= 0) fail(`${artifactKey} has no byte size.`);
  targets[target] = { artifact: artifactKey, url, sha256: checksum.toLowerCase(), size };
}

const mspSchemaFingerprint = typeof manifest.msp_schema_fingerprint === "string" ? manifest.msp_schema_fingerprint : null;
const sdkFingerprint = readSdkFingerprint();
if (sdkFingerprint && mspSchemaFingerprint && sdkFingerprint !== mspSchemaFingerprint) {
  // The SDK treats a mismatch as a warning (additive-optional evolution), so do too.
  process.stderr.write(
    `tools:muse-pin: warning: muse ${version} serves MSP schema ${mspSchemaFingerprint}, `
    + `@muse-code/sdk@${sdkVersion} was written against ${sdkFingerprint}.\n`,
  );
}

const release = {
  sdkVersion,
  version,
  manifestUrl,
  mspSchemaFingerprint,
  targets,
};
writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`, "utf8");
process.stdout.write(`pinned muse ${version} for @muse-code/sdk@${sdkVersion} -> ${path.relative(packageRoot, releasePath)}\n`);

if (!process.argv.includes("--no-manifest")) {
  execFileSync(process.execPath, [path.join(packageRoot, "scripts", "generate-tools-manifest.mjs")], {
    stdio: "inherit",
  });
}
