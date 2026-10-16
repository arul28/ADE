import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUniversalSwiftProduct, exitIfCachedHelper } from "./native-helper-cache.mjs";

// The Mac Desktop native helper: a universal binary in resources/native,
// materialized before electron-builder runs, so the packaged app carries one
// file per helper and every helper is signed by the same pass over
// Contents/Resources/native.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(desktopRoot, "native", "ADEDesktopDriver");
const outputRoot = path.join(desktopRoot, "resources", "native");
const outputPath = path.join(outputRoot, "ade-desktop-driver");

exitIfCachedHelper(outputPath);

if (process.platform !== "darwin") {
  console.log("[desktop-driver] Skipping native helper build outside macOS.");
  process.exit(0);
}

if (process.env.ADE_SKIP_DESKTOP_DRIVER_BUILD === "1") {
  console.log("[desktop-driver] Skipping native helper build (ADE_SKIP_DESKTOP_DRIVER_BUILD=1).");
  process.exit(0);
}

buildUniversalSwiftProduct({
  packageRoot,
  product: "ade-desktop-driver",
  outputPath,
  archsEnv: "ADE_DESKTOP_DRIVER_ARCHS",
  tag: "desktop-driver",
});
