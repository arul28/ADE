// Downloads the Electron zip for one release target into ELECTRON_CACHE, with
// retries, before electron-builder runs.
//
// electron-builder fetches Electron itself and fails the whole build on a single
// network error; one release lost its x64 job to a DNS failure that way. The
// cache layout (<cacheRoot>/<sha256 of the release URL>/<zip>) is the one
// electron-builder reads, so once this has run the build finds the zip and does
// not download it. @electron/get also verifies the zip against Electron's
// published checksums.
//
//   node scripts/prefetch-electron.mjs --platform=darwin --arch=x64
import { createRequire } from "node:module";
import { retryTransient } from "./release-retry.mjs";

const require = createRequire(import.meta.url);
const { downloadArtifact } = require("@electron/get");

function readFlag(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (!arg) throw new Error(`[release] Missing --${name}=`);
  return arg.slice(prefix.length);
}

const platform = readFlag("platform");
const arch = readFlag("arch");
const cacheRoot = process.env.ELECTRON_CACHE;
if (!cacheRoot) throw new Error("[release] ELECTRON_CACHE must be set so electron-builder finds the prefetched zip.");
const version = require("electron/package.json").version;

// Retry every failure, including a checksum mismatch: refetching a corrupt
// download is the fix.
const zipPath = await retryTransient(
  `Electron ${version} ${platform}-${arch} download`,
  () => downloadArtifact({ version, platform, arch, artifactName: "electron", cacheRoot }),
  { attempts: 5, delayMs: 10_000 },
);
console.log(`[release] Electron ${version} ${platform}-${arch} is cached: ${zipPath}`);
