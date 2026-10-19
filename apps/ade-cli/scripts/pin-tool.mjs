#!/usr/bin/env node
/**
 * Pin one vendor-distributed agent tool by writing `scripts/pins/<tool>.json`,
 * then regenerate the tools manifest.
 *
 * These tools are not in any ADE lockfile, so their per-target URL and
 * integrity come from the vendor: npm registry metadata (droid, grok), the
 * vendor's own checksum list (qwen `SHA256SUMS`, kimi `.sha256` sidecars
 * cross-checked against GitHub's asset digests, devin `manifest.json`), a
 * locked dependency tree (pi), or, for Antigravity, which publishes no
 * checksum at all, a sha256 this script computes by downloading every target
 * (trust on first download; re-pinning the same version must reproduce it).
 * This is the only step that talks to the network; the generator reads the
 * file this writes and stays offline. Muse keeps `tools:muse-pin`.
 *
 * With no version it pins the vendor's newest stable release, the same one
 * `--latest-version` prints. `--latest-version` reads only small metadata
 * documents, prints that one version and changes no file (the scheduled pin
 * workflow compares it with the pinned one). Needs nothing installed: only
 * Node built-ins, plus the `npm` CLI for pi's tree. qwen and kimi read the
 * GitHub API, which allows 60 unauthenticated requests an hour per IP; set
 * GITHUB_TOKEN in CI.
 *
 *   npm run tools:pin -- <tool> [version] [--no-manifest]
 *   npm run tools:pin -- <tool> --latest-version
 *   npm run tools:pin -- devin 3000.11.3
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NPM_REGISTRY_HOST, VENDOR_DOWNLOAD_HOSTS } from "./file-pin-host.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pinsDir = path.join(packageRoot, "scripts", "pins");
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];
const USER_AGENT = "ADE tools pin";

function fail(message) {
  process.stderr.write(`tools:pin: ${message}\n`);
  process.exit(1);
}

function note(message) {
  process.stderr.write(`tools:pin: ${message}\n`);
}

async function fetchOk(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { "user-agent": USER_AGENT, ...init.headers }, redirect: "follow" });
  if (!response.ok) fail(`${init.method ?? "GET"} ${url} answered HTTP ${response.status}.`);
  return response;
}

async function fetchJson(url, init) {
  const response = await fetchOk(url, init);
  try {
    return await response.json();
  } catch (error) {
    fail(`${url} did not return JSON: ${error.message}`);
  }
}

async function fetchText(url) {
  return await (await fetchOk(url)).text();
}

async function contentLength(url) {
  const response = await fetchOk(url, { method: "HEAD" });
  const size = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (!Number.isSafeInteger(size) || size <= 0) fail(`HEAD ${url} sent no Content-Length.`);
  return size;
}

/** Streams a download through a hash without keeping it; returns the digest and size. */
async function hashDownload(url, algorithm = "sha256", encoding = "hex") {
  const response = await fetchOk(url);
  const hash = createHash(algorithm);
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { digest: hash.digest(encoding), size };
}

function requireHost(url, hosts, label) {
  const { protocol, host } = new URL(url);
  if (protocol !== "https:" || host !== hosts[0]) fail(`${label} must be an https URL on ${hosts[0]}, got ${url}.`);
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} has no lowercase hex sha256.`);
  return value;
}

/** Limits concurrent network work to `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

async function npmVersionManifest(name, version) {
  return await fetchJson(`https://${NPM_REGISTRY_HOST}/${name}/${encodeURIComponent(version)}`);
}

async function npmLatest(name) {
  const doc = await fetchJson(`https://${NPM_REGISTRY_HOST}/${name}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  return doc["dist-tags"]?.latest ?? fail(`${name} has no latest dist-tag.`);
}

async function npmPlatformPin(packageName, version, decompress) {
  const manifest = await npmVersionManifest(packageName, version);
  const { tarball, integrity } = manifest.dist ?? {};
  requireHost(tarball, [NPM_REGISTRY_HOST], `${packageName}@${version} tarball`);
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) fail(`${packageName}@${version} has no sha512 integrity.`);
  return {
    format: "npm-tarball",
    package: packageName,
    version,
    tarball,
    integrity,
    ...(decompress ? { decompress } : {}),
  };
}

// --- per-tool pinners --------------------------------------------------------

/**
 * Factory's npm platform packages. x64 always takes the `-baseline` build,
 * which does not need AVX2: ADE cannot run Factory's CPU probe before it
 * picks a download, and the AVX2 build dies with an illegal instruction on
 * older CPUs and many VMs.
 */
async function pinDroid(resolvedVersion) {
  const packages = {
    "darwin-arm64": "@factory/cli-darwin-arm64",
    "darwin-x64": "@factory/cli-darwin-x64-baseline",
    "linux-arm64": "@factory/cli-linux-arm64",
    "linux-x64": "@factory/cli-linux-x64-baseline",
    "win32-x64": "@factory/cli-win32-x64-baseline",
  };
  const targets = {};
  for (const target of TARGETS) targets[target] = await npmPlatformPin(packages[target], resolvedVersion);
  return { version: resolvedVersion, source: `npm droid@${resolvedVersion} platform packages`, targets };
}

/** xAI's npm platform packages ship the binary brotli-compressed; ADE inflates it after the integrity check. */
async function pinGrok(resolvedVersion) {
  const targets = {};
  for (const target of TARGETS) {
    const binary = target.startsWith("win32") ? "bin/grok.exe" : "bin/grok";
    targets[target] = await npmPlatformPin(`@xai-official/grok-${target}`, resolvedVersion, [
      { algorithm: "brotli", from: `${binary}.br`, to: binary },
    ]);
  }
  return { version: resolvedVersion, source: `npm @xai-official/grok@${resolvedVersion} platform packages`, targets };
}

async function githubRelease(repo, tag) {
  const url = tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return await fetchJson(url, { headers });
}

function githubAsset(release, name) {
  const asset = release.assets?.find((candidate) => candidate.name === name);
  if (!asset) fail(`${release.tag_name} has no asset ${name}.`);
  return asset;
}

/** GitHub's own sha256 of an asset, which must agree with the vendor's published one. */
function githubDigest(asset) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "");
  return match ? match[1] : null;
}

/**
 * Qwen's standalone bundles (their own Node + the CLI), checked against the
 * release's `SHA256SUMS`. Every bundle has one `qwen-code/` root, stripped.
 */
/**
 * The newest published, non-prerelease release whose tag is the CLI's own:
 * both repos also release other packages (Qwen's TypeScript SDK), and GitHub's
 * "latest" can point at one of those.
 */
async function latestGithubVersion(repo, tagPattern) {
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const releases = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
  const versions = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => tagPattern.exec(release.tag_name)?.[1])
    .filter(Boolean)
    .sort(compareDottedVersions);
  if (!versions.length) fail(`${repo} has no stable release tagged like ${tagPattern}.`);
  return versions[versions.length - 1];
}

function compareDottedVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

async function pinQwen(version) {
  const release = await githubRelease("QwenLM/qwen-code", `v${version.replace(/^v/, "")}`);
  const resolvedVersion = release.tag_name.replace(/^v/, "");
  const sums = new Map();
  for (const line of (await fetchText(githubAsset(release, "SHA256SUMS").browser_download_url)).split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  const assets = {
    "darwin-arm64": "qwen-code-darwin-arm64.tar.gz",
    "darwin-x64": "qwen-code-darwin-x64.tar.gz",
    "linux-arm64": "qwen-code-linux-arm64.tar.gz",
    "linux-x64": "qwen-code-linux-x64.tar.gz",
    "win32-x64": "qwen-code-win-x64.zip",
  };
  const targets = {};
  for (const target of TARGETS) {
    const asset = githubAsset(release, assets[target]);
    const sha256 = requireSha256(sums.get(asset.name), `SHA256SUMS ${asset.name}`);
    const digest = githubDigest(asset);
    if (digest && digest !== sha256) fail(`${asset.name}: SHA256SUMS says ${sha256}, GitHub says ${digest}.`);
    requireHost(asset.browser_download_url, VENDOR_DOWNLOAD_HOSTS.qwen, asset.name);
    targets[target] = {
      format: "archive",
      package: `qwen-code-${target}`,
      version: resolvedVersion,
      url: asset.browser_download_url,
      archive: asset.name.endsWith(".zip") ? "zip" : "tar.gz",
      stripComponents: 1,
      sha256,
      size: asset.size,
    };
  }
  return { version: resolvedVersion, source: `github QwenLM/qwen-code ${release.tag_name} SHA256SUMS`, targets };
}

/**
 * Kimi Code's per-target `.tar.gz` (Windows `.zip`), each one top-level
 * `kimi[.exe]`: a third the size of the raw CDN binary. Checked against the
 * vendor's `.sha256` sidecar and GitHub's digest, which must agree.
 */
const KIMI_TAG_PREFIX = "@moonshot-ai/kimi-code@";

async function pinKimi(version) {
  const release = await githubRelease("MoonshotAI/kimi-code", `${KIMI_TAG_PREFIX}${version}`);
  const resolvedVersion = release.tag_name.slice(KIMI_TAG_PREFIX.length);
  if (!/^\d+\.\d+\.\d+$/.test(resolvedVersion)) fail(`unexpected kimi-code release tag ${release.tag_name}.`);
  const targets = {};
  for (const target of TARGETS) {
    const name = `kimi-code-${target}.${target.startsWith("win32") ? "zip" : "tar.gz"}`;
    const asset = githubAsset(release, name);
    const sidecar = (await fetchText(githubAsset(release, `${name}.sha256`).browser_download_url)).trim().split(/\s+/)[0];
    const sha256 = requireSha256(sidecar, `${name}.sha256`);
    const digest = githubDigest(asset);
    if (digest && digest !== sha256) fail(`${name}: sidecar says ${sha256}, GitHub says ${digest}.`);
    requireHost(asset.browser_download_url, VENDOR_DOWNLOAD_HOSTS.kimi, name);
    targets[target] = {
      format: "archive",
      package: `kimi-code-${target}`,
      version: resolvedVersion,
      url: asset.browser_download_url,
      archive: target.startsWith("win32") ? "zip" : "tar.gz",
      stripComponents: 0,
      sha256,
      size: asset.size,
    };
  }
  return { version: resolvedVersion, source: `github MoonshotAI/kimi-code ${release.tag_name} .sha256 sidecars`, targets };
}

/** Devin's archives from its CDN, checked against the vendor's per-version `manifest.json`. */
async function pinDevin(resolvedVersion) {
  const manifest = await fetchJson(`https://static.devin.ai/cli/${encodeURIComponent(resolvedVersion)}/manifest.json`);
  if (manifest.version !== resolvedVersion) fail(`devin manifest describes ${manifest.version}, not ${resolvedVersion}.`);
  const triples = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux",
    "linux-x64": "x86_64-unknown-linux",
    "win32-x64": "x86_64-pc-windows",
  };
  const targets = {};
  for (const target of TARGETS) {
    const platform = manifest.platforms?.[triples[target]];
    if (!platform) fail(`devin ${resolvedVersion} has no ${triples[target]} build.`);
    requireHost(platform.url, VENDOR_DOWNLOAD_HOSTS.devin, `devin ${triples[target]}`);
    targets[target] = {
      format: "archive",
      package: `devin-${target}`,
      version: resolvedVersion,
      url: platform.url,
      archive: platform.url.endsWith(".zip") ? "zip" : "tar.gz",
      stripComponents: 0,
      sha256: requireSha256(platform.sha256, `devin ${triples[target]}`),
      size: await contentLength(platform.url),
    };
  }
  return { version: resolvedVersion, source: `static.devin.ai/cli/${resolvedVersion}/manifest.json`, targets };
}

/**
 * Google's Antigravity ACP server zips. Google publishes no checksum, so the
 * pin is the sha256 of what this script downloads now. Re-pinning a version
 * that is already pinned must reproduce every hash, or the script refuses.
 */
/** Google publishes no version feed; the ACP registry's entry names the current server build. */
const ACP_REGISTRY_RAW = "https://raw.githubusercontent.com/agentclientprotocol/registry/main";

async function acpRegistryVersion(id) {
  const version = (await fetchJson(`${ACP_REGISTRY_RAW}/${id}/agent.json`)).version;
  if (typeof version !== "string" || !version) fail(`the ACP registry's ${id} entry names no version.`);
  return version;
}

async function pinAntigravity(version, existing) {
  const assets = {
    "darwin-arm64": `macos/agy-acp-server-${version}-darwin-arm64.zip`,
    "darwin-x64": `macos/agy-acp-server-${version}-darwin-x86_64.zip`,
    "linux-arm64": `linux/agy-acp-server-${version}-linux-arm64.zip`,
    "linux-x64": `linux/agy-acp-server-${version}-linux-x86_64.zip`,
    "win32-x64": `windows/agy-acp-server-${version}-windows-x86_64.zip`,
  };
  const targets = {};
  for (const target of TARGETS) {
    const url = `https://dl.google.com/agy-extensions/releases/${assets[target]}`;
    note(`hashing ${url}`);
    const { digest: sha256, size } = await hashDownload(url);
    const previous = existing?.version === version ? existing.targets?.[target] : null;
    if (previous && (previous.sha256 !== sha256 || previous.size !== size)) {
      fail(`${url} changed since it was pinned: was ${previous.sha256} (${previous.size} B), now ${sha256} (${size} B).`);
    }
    targets[target] = {
      format: "archive",
      package: `antigravity-acp-${target}`,
      version,
      url,
      archive: "zip",
      stripComponents: 0,
      sha256,
      size,
    };
  }
  return { version, source: "dl.google.com/agy-extensions (sha256 computed by tools:pin)", targets };
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** npm's own platform rule for `os`/`cpu`: a list of allowed values, or of `!`-negated ones. */
function platformAllows(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const negated = list.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1));
  if (negated.includes(value)) return false;
  const allowed = list.filter((entry) => !entry.startsWith("!"));
  return allowed.length === 0 || allowed.includes(value);
}

function packageFitsTarget(entry, target) {
  const [platform, arch] = target.split("-");
  if (!platformAllows(entry.os, platform) || !platformAllows(entry.cpu, arch)) return false;
  // ADE's Linux targets are glibc.
  if (Array.isArray(entry.libc) && entry.libc.length && (platform !== "linux" || !entry.libc.includes("glibc"))) return false;
  return true;
}

/**
 * Pi's SDK and its whole dependency tree, locked by npm itself in a scratch
 * directory against the public registry with no user npmrc and no scripts.
 * Each target lists the lockfile's packages that fit it; nothing else is
 * installed, and install scripts never run.
 */
async function pinPi(resolvedVersion) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ade-pin-pi-"));
  let lock;
  try {
    writeFileSync(path.join(scratch, "package.json"), JSON.stringify({
      name: "ade-pi-pin",
      private: true,
      dependencies: { [PI_PACKAGE]: resolvedVersion },
    }));
    writeFileSync(path.join(scratch, ".npmrc-empty"), "");
    execFileSync("npm", [
      "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund",
      `--registry=https://${NPM_REGISTRY_HOST}/`,
    ], {
      cwd: scratch,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, npm_config_userconfig: path.join(scratch, ".npmrc-empty") },
      shell: process.platform === "win32",
    });
    lock = JSON.parse(readFileSync(path.join(scratch, "package-lock.json"), "utf8"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const root = lock.packages?.[`node_modules/${PI_PACKAGE}`];
  if (root?.version !== resolvedVersion) fail(`the lockfile resolved ${PI_PACKAGE}@${String(root?.version)}, not ${resolvedVersion}.`);

  const entries = Object.entries(lock.packages)
    .filter(([key, entry]) => key !== "" && !entry.dev && !entry.inBundle)
    .map(([key, entry]) => {
      if (entry.link) fail(`${key} is a link; a tree pin only holds registry packages.`);
      requireHost(entry.resolved, [NPM_REGISTRY_HOST], key);
      return { key, entry };
    });
  note(`measuring ${entries.length} packages`);
  const measured = await mapLimit(entries, 8, async ({ key, entry }) => {
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    // Downloaded whole: the registry sends no Content-Length on HEAD, and
    // hashing the bytes proves the integrity this pin will enforce.
    const [{ digest, size }, manifest] = await Promise.all([
      hashDownload(entry.resolved, "sha512", "base64"),
      npmVersionManifest(name, entry.version),
    ]);
    // `--package-lock-only` leaves some nested entries without integrity; the
    // registry's own version manifest has it, and must agree when both do.
    const integrity = entry.integrity ?? manifest.dist?.integrity;
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) fail(`${key} has no sha512 integrity.`);
    if (entry.integrity && manifest.dist?.integrity && entry.integrity !== manifest.dist.integrity) {
      fail(`${key}: the lockfile and the registry disagree on its integrity.`);
    }
    if (manifest.dist?.tarball !== entry.resolved) fail(`${key}: the lockfile resolved a different tarball than the registry lists.`);
    if (integrity !== `sha512-${digest}`) fail(`${key}: the downloaded tarball does not match ${integrity}.`);
    return { key, entry: { ...entry, integrity }, size, unpackedSize: manifest.dist?.unpackedSize ?? size * 4 };
  });

  const targets = {};
  for (const target of TARGETS) {
    const fitting = measured.filter(({ entry }) => packageFitsTarget(entry, target));
    targets[target] = {
      format: "npm-tree",
      package: `pi-coding-agent-${target}`,
      version: resolvedVersion,
      packages: fitting.map(({ key, entry, size }) => ({ path: key, tarball: entry.resolved, integrity: entry.integrity, size })),
      unpackedSize: fitting.reduce((sum, { unpackedSize }) => sum + unpackedSize, 0),
    };
  }
  return { version: resolvedVersion, source: `npm ${PI_PACKAGE}@${resolvedVersion} dependency tree (npm --package-lock-only)`, targets };
}

/**
 * The interactive GitHub Copilot CLI that ADE terminals run, separate from the
 * `copilot` runtime the SDK worker spawns: one native binary per target.
 */
async function pinCopilotCli(resolvedVersion) {
  const targets = {};
  for (const target of TARGETS) targets[target] = await npmPlatformPin(`@github/copilot-${target}`, resolvedVersion);
  return { version: resolvedVersion, source: `npm @github/copilot@${resolvedVersion} platform packages`, targets };
}

/**
 * Cursor's own install script names the build it installs
 * (`downloads.cursor.com/lab/<YYYY.MM.DD-commit>/`); the CLI's updater asks an
 * authenticated API for the same thing.
 */
async function latestCursorCli() {
  const script = await fetchText("https://cursor.com/install");
  const match = /https:\/\/downloads\.cursor\.com\/lab\/(\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]+)\//.exec(script);
  if (!match) fail("https://cursor.com/install names no downloads.cursor.com/lab/<version>/ build.");
  return match[1];
}

/**
 * Cursor's agent CLI package: its own Node plus the bundled CLI under one
 * `dist-package/` root. Cursor publishes no checksum, so like Antigravity the
 * pin is the sha256 of what this script downloads, and re-pinning a pinned
 * version must reproduce it.
 */
async function pinCursorCli(version, existing) {
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]+$/.test(version)) fail(`cursor-cli versions look like 2026.10.16-e3cb207, got ${version}.`);
  const paths = {
    "darwin-arm64": "darwin/arm64/agent-cli-package.tar.gz",
    "darwin-x64": "darwin/x64/agent-cli-package.tar.gz",
    "linux-arm64": "linux/arm64/agent-cli-package.tar.gz",
    "linux-x64": "linux/x64/agent-cli-package.tar.gz",
    "win32-x64": "windows/x64/agent-cli-package.zip",
  };
  const targets = {};
  for (const target of TARGETS) {
    const url = `https://downloads.cursor.com/lab/${version}/${paths[target]}`;
    note(`hashing ${url}`);
    const { digest: sha256, size } = await hashDownload(url);
    const previous = existing?.version === version ? existing.targets?.[target] : null;
    if (previous && (previous.sha256 !== sha256 || previous.size !== size)) {
      fail(`${url} changed since it was pinned: was ${previous.sha256} (${previous.size} B), now ${sha256} (${size} B).`);
    }
    targets[target] = {
      format: "archive",
      package: `cursor-agent-${target}`,
      version,
      url,
      archive: url.endsWith(".zip") ? "zip" : "tar.gz",
      stripComponents: 1,
      sha256,
      size,
    };
  }
  return { version, source: "downloads.cursor.com/lab (sha256 computed by tools:pin)", targets };
}

/** The Node release line ADE ships for JS-only CLIs. Pi needs >= 22.19. */
const NODE_MAJOR = 24;

async function latestNode() {
  const releases = await fetchJson("https://nodejs.org/dist/index.json");
  const newest = releases.find((release) => release.lts && release.version.startsWith(`v${NODE_MAJOR}.`));
  if (!newest) fail(`nodejs.org lists no Node ${NODE_MAJOR} LTS release.`);
  return newest.version.slice(1);
}

/** Official Node.js builds, checked against the release's `SHASUMS256.txt`; the `node-v<v>-<os>-<arch>/` root is stripped. */
async function pinNode(version) {
  const resolvedVersion = version.replace(/^v/, "");
  const base = `https://nodejs.org/dist/v${resolvedVersion}`;
  const sums = new Map();
  for (const line of (await fetchText(`${base}/SHASUMS256.txt`)).split("\n")) {
    const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  const files = {
    "darwin-arm64": `node-v${resolvedVersion}-darwin-arm64.tar.gz`,
    "darwin-x64": `node-v${resolvedVersion}-darwin-x64.tar.gz`,
    "linux-arm64": `node-v${resolvedVersion}-linux-arm64.tar.gz`,
    "linux-x64": `node-v${resolvedVersion}-linux-x64.tar.gz`,
    "win32-x64": `node-v${resolvedVersion}-win-x64.zip`,
  };
  const targets = {};
  for (const target of TARGETS) {
    const url = `${base}/${files[target]}`;
    targets[target] = {
      format: "archive",
      package: `node-${target}`,
      version: resolvedVersion,
      url,
      archive: url.endsWith(".zip") ? "zip" : "tar.gz",
      stripComponents: 1,
      sha256: requireSha256(sums.get(files[target]), `SHASUMS256.txt ${files[target]}`),
      size: await contentLength(url),
    };
  }
  return { version: resolvedVersion, source: `nodejs.org/dist/v${resolvedVersion}/SHASUMS256.txt`, targets };
}

/**
 * Per tool: the vendor's newest stable version (small metadata reads only),
 * and the pinner. A version-less pin uses `latest`, so the two always agree.
 */
const TOOLS = {
  droid: { latest: () => npmLatest("droid"), pin: pinDroid },
  grok: { latest: () => npmLatest("@xai-official/grok"), pin: pinGrok },
  qwen: { latest: () => latestGithubVersion("QwenLM/qwen-code", /^v(\d+\.\d+\.\d+)$/), pin: pinQwen },
  kimi: { latest: () => latestGithubVersion("MoonshotAI/kimi-code", /^@moonshot-ai\/kimi-code@(\d+\.\d+\.\d+)$/), pin: pinKimi },
  devin: { latest: async () => (await fetchJson("https://static.devin.ai/cli/current/manifest.json")).version, pin: pinDevin },
  antigravity: { latest: () => acpRegistryVersion("antigravity-acp"), pin: pinAntigravity },
  pi: { latest: () => npmLatest(PI_PACKAGE), pin: pinPi },
  "copilot-cli": { latest: () => npmLatest("@github/copilot"), pin: pinCopilotCli },
  "cursor-cli": { latest: latestCursorCli, pin: pinCursorCli },
  node: { latest: latestNode, pin: pinNode },
};

const [tool, ...rest] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!tool || !TOOLS[tool]) {
  fail(`usage: npm run tools:pin -- <${Object.keys(TOOLS).join("|")}> [version | --latest-version] [--no-manifest]`);
}
if (process.argv.includes("--latest-version")) {
  const latest = await TOOLS[tool].latest();
  if (typeof latest !== "string" || !latest) fail(`${tool} has no latest version.`);
  process.stdout.write(`${latest}\n`);
  process.exit(0);
}
const version = rest[0] ?? await TOOLS[tool].latest();

const pinPath = path.join(pinsDir, `${tool}.json`);
let existing = null;
try {
  existing = JSON.parse(readFileSync(pinPath, "utf8"));
} catch {
  existing = null;
}
const pinned = await TOOLS[tool].pin(version, existing);
mkdirSync(pinsDir, { recursive: true });
writeFileSync(pinPath, `${JSON.stringify({ tool, version: pinned.version, source: pinned.source, targets: pinned.targets }, null, 2)}\n`, "utf8");
process.stdout.write(`pinned ${tool} ${pinned.version} -> ${path.relative(packageRoot, pinPath)}\n`);

if (!process.argv.includes("--no-manifest")) {
  execFileSync(process.execPath, [path.join(packageRoot, "scripts", "generate-tools-manifest.mjs")], { stdio: "inherit" });
}
