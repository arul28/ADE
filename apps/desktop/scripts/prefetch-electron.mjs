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

const maxAttempts = 5;
for (let attempt = 1; ; attempt += 1) {
  try {
    const zipPath = await downloadArtifact({ version, platform, arch, artifactName: "electron", cacheRoot });
    console.log(`[release] Electron ${version} ${platform}-${arch} is cached: ${zipPath}`);
    break;
  } catch (error) {
    if (attempt >= maxAttempts) throw error;
    const waitMs = 10_000 * attempt;
    console.warn(
      `[release] Electron download failed (attempt ${attempt}/${maxAttempts}); retrying in ${waitMs / 1000}s.\n${error?.message ?? error}`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
