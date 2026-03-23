const path = require("node:path");
const { normalizeDesktopRuntimeBinaries } = require("./runtimeBinaryPermissions.cjs");

const appDir = path.resolve(__dirname, "..");
const normalized = normalizeDesktopRuntimeBinaries(appDir);

if (normalized.length === 0) {
  console.log("[runtime-binaries] No executable mode fixes were needed.");
  process.exit(0);
}

for (const entry of normalized) {
  console.log(`[runtime-binaries] Restored executable mode: ${entry.label} -> ${path.relative(appDir, entry.filePath)}`);
}
