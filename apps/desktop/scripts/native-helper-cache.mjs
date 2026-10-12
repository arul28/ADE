import fs from "node:fs";
import path from "node:path";

// Release jobs restore the universal Swift helpers from a cache keyed on their
// sources (.github/actions/release-cache-keys, filled by
// warm-release-caches.yml) and set ADE_NATIVE_HELPERS_CACHED=1 on a hit. The
// build script then reuses the restored binary instead of compiling it again.
export function exitIfCachedHelper(outputPath) {
  if (process.platform !== "darwin" || process.env.ADE_NATIVE_HELPERS_CACHED !== "1") return;
  if (!fs.existsSync(outputPath)) return;
  console.log(`[native-helpers] Reusing cached ${path.basename(outputPath)}.`);
  process.exit(0);
}
