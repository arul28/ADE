import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUniversalSwiftProduct, exitIfCachedHelper } from "./native-helper-cache.mjs";

/**
 * Build the macOS half of the global capture helper.
 *
 * Builds both architectures in scratch paths and folds them with `lipo`. The
 * skip-off-platform guard is what lets `dist:win` run this script on a Windows box without failing. The
 * Windows half is `build-capture-helper-win.mjs`; neither can cross-compile the
 * other, so both are wired into their own platform's dist script.
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(desktopRoot, "native", "ADECaptureHelper");
const outputRoot = path.join(desktopRoot, "resources", "native");
const outputPath = path.join(outputRoot, "ade-capture-helper");

exitIfCachedHelper(outputPath);

if (process.platform !== "darwin") {
  console.log("[capture-helper] Skipping macOS capture helper build outside macOS.");
  process.exit(0);
}

if (process.env.ADE_SKIP_CAPTURE_HELPER_BUILD === "1") {
  console.log("[capture-helper] Skipping macOS capture helper build (ADE_SKIP_CAPTURE_HELPER_BUILD=1).");
  process.exit(0);
}

buildUniversalSwiftProduct({
  packageRoot,
  product: "ade-capture-helper",
  outputPath,
  archsEnv: "ADE_CAPTURE_HELPER_ARCHS",
  tag: "capture-helper",
});
