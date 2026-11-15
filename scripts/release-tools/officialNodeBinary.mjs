// Downloads an official Node.js release binary for one target, checked against
// nodejs.org's SHASUMS256.txt for that version, and returns the path of its
// `node` executable. Imports Node built-ins only.
//
// Callers: apps/desktop/scripts/materialize-runtime-resources.mjs (a local
// build whose own Node cannot make a SEA runtime) and the darwin-x64 leg of
// build-runtime-binaries in .github/workflows/release-core.yml, which builds
// the Intel runtime on Apple Silicon with this binary as the SEA host.
//
//   node scripts/release-tools/officialNodeBinary.mjs --target darwin-x64 [--version v24.1.0] [--cache-dir dir]
//
// The version defaults to the Node running this script, so a cross-built
// runtime embeds the same Node as the native one built beside it. The path is
// the only line written to stdout.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const maxDownloadRedirects = 10;
const downloadIdleTimeoutMs = 60_000;

export async function isSeaCapableNodeBinary(binaryPath) {
  try {
    const contents = await fs.readFile(binaryPath);
    return contents.includes(Buffer.from(seaFuse));
  } catch {
    return false;
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function nodeArchiveCandidates(version, target) {
  return [
    { name: `node-${version}-${target}.tar.gz`, tarFlag: "-xzf" },
    { name: `node-${version}-${target}.tar.xz`, tarFlag: "-xJf" },
  ];
}

// Writes to `<destination>.partial` and renames it when the body is complete,
// so a download that stops halfway never leaves a file a later run would take
// for a finished one. pipeline() rejects on a response that fails after its
// headers arrived, and the idle timeout ends a connection that goes silent.
async function downloadFile(url, destinationPath, redirectsRemaining = maxDownloadRedirects) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const partialPath = `${destinationPath}.partial`;
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, resolve);
    request.setTimeout(downloadIdleTimeoutMs, () => {
      request.destroy(new Error(`No data for ${downloadIdleTimeoutMs / 1000} s while downloading ${url}`));
    });
    request.once("error", reject);
  });
  if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.resume();
    if (redirectsRemaining <= 0) {
      throw new Error(`Too many redirects while downloading ${url}`);
    }
    return downloadFile(new URL(response.headers.location, url).toString(), destinationPath, redirectsRemaining - 1);
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`HTTP ${response.statusCode ?? "unknown"}`);
  }
  try {
    await pipeline(response, createWriteStream(partialPath, { mode: 0o644 }));
    await fs.rename(partialPath, destinationPath);
  } catch (error) {
    await fs.rm(partialPath, { force: true });
    throw error;
  }
}

async function sha256OfFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

// Expected SHA-256 for one Node release archive, from nodejs.org's official
// SHASUMS256.txt. The Node version is not pinned in the repo (it follows the
// caller's version, normally process.version), so the checksum manifest is
// fetched per version at build time instead of hard-coding hashes; it is
// cached next to the archives so a cached, already-verified extract keeps
// working offline.
async function officialNodeSha256(version, cacheRoot, archiveName) {
  const shasumsPath = path.join(cacheRoot, version, "SHASUMS256.txt");
  if (!(await pathExists(shasumsPath))) {
    await downloadFile(`https://nodejs.org/dist/${version}/SHASUMS256.txt`, shasumsPath);
  }
  const contents = await fs.readFile(shasumsPath, "utf8");
  for (const line of contents.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === archiveName && /^[0-9a-f]{64}$/i.test(hash ?? "")) {
      return hash.toLowerCase();
    }
  }
  throw new Error(`SHASUMS256.txt for Node ${version} has no entry for ${archiveName}`);
}

/**
 * Downloads (or reuses from `cacheRoot`) the official Node `version` for
 * `target` (darwin-arm64, darwin-x64, linux-arm64, linux-x64) and returns the
 * path of its SEA-capable `bin/node`. A checksum mismatch fails at once.
 */
export async function downloadOfficialNodeBinary({ target, version = process.version, cacheRoot, logPrefix = "[official-node]" }) {
  const normalizedVersion = version.trim().replace(/^([^v])/, "v$1");
  const log = (message) => console.error(`${logPrefix} ${message}`);
  const extractRoot = path.join(cacheRoot, normalizedVersion, target);
  const binaryPath = path.join(extractRoot, `node-${normalizedVersion}-${target}`, "bin", "node");
  if (await isSeaCapableNodeBinary(binaryPath)) {
    return binaryPath;
  }

  await fs.rm(extractRoot, { recursive: true, force: true });
  await fs.mkdir(extractRoot, { recursive: true });

  let lastError = null;
  for (const candidate of nodeArchiveCandidates(normalizedVersion, target)) {
    const archivePath = path.join(cacheRoot, normalizedVersion, candidate.name);
    const url = `https://nodejs.org/dist/${normalizedVersion}/${candidate.name}`;
    try {
      log(`Downloading official Node ${normalizedVersion} for ${target}: ${url}`);
      await downloadFile(url, archivePath);
      const expectedSha256 = await officialNodeSha256(normalizedVersion, cacheRoot, candidate.name);
      const actualSha256 = await sha256OfFile(archivePath);
      if (actualSha256 !== expectedSha256) {
        await fs.rm(archivePath, { force: true });
        const mismatch = new Error(
          `SHA-256 mismatch for ${candidate.name}: nodejs.org SHASUMS256.txt expects ${expectedSha256}, ` +
            `got ${actualSha256}. Refusing to use the unverified Node binary.`
        );
        // A hash mismatch is a tamper signal, not a fetch hiccup: abort
        // instead of falling through to the next archive format.
        mismatch.fatalIntegrityFailure = true;
        throw mismatch;
      }
      log(`Verified ${candidate.name} against nodejs.org SHASUMS256.txt (${actualSha256}).`);
      await execFileAsync("tar", [candidate.tarFlag, archivePath, "-C", extractRoot], {
        maxBuffer: 20 * 1024 * 1024,
      });
      if (await isSeaCapableNodeBinary(binaryPath)) {
        await fs.chmod(binaryPath, 0o755);
        return binaryPath;
      }
      throw new Error(`Downloaded Node binary is not SEA-capable: ${binaryPath}`);
    } catch (error) {
      if (error?.fatalIntegrityFailure) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      await fs.rm(extractRoot, { recursive: true, force: true });
      await fs.mkdir(extractRoot, { recursive: true });
    }
  }

  throw lastError ?? new Error(`Unable to download official Node ${normalizedVersion} for ${target}.`);
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const target = readOption(argv, "--target");
  if (!target || !/^(?:darwin|linux)-(?:arm64|x64)$/.test(target)) {
    console.error("Usage: node scripts/release-tools/officialNodeBinary.mjs --target <darwin|linux>-<arm64|x64> [--version vX.Y.Z] [--cache-dir dir]");
    process.exit(2);
  }
  try {
    const binaryPath = await downloadOfficialNodeBinary({
      target,
      version: readOption(argv, "--version") || process.version,
      cacheRoot: path.resolve(readOption(argv, "--cache-dir") || path.join(process.cwd(), ".cache", "official-node")),
    });
    process.stdout.write(`${binaryPath}\n`);
  } catch (error) {
    console.error(`[official-node] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
