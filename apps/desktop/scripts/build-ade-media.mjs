import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUniversalSwiftProduct, exitIfCachedHelper } from "./native-helper-cache.mjs";

// `ade-media`, the macOS demo-video engine (analyze + render), built the way
// the Mac Desktop driver is: a universal binary in resources/native,
// materialized before electron-builder runs and shipped by the same
// `resources/native` extraResources entry. There is no Windows half: the
// chromium engine renders demos off macOS.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(desktopRoot, "native", "ADEMedia");
const outputRoot = path.join(desktopRoot, "resources", "native");
const outputPath = path.join(outputRoot, "ade-media");

exitIfCachedHelper(outputPath);

if (process.platform !== "darwin") {
  console.log("[ade-media] Skipping the demo engine build outside macOS.");
  process.exit(0);
}

if (process.env.ADE_SKIP_ADE_MEDIA_BUILD === "1") {
  console.log("[ade-media] Skipping the demo engine build (ADE_SKIP_ADE_MEDIA_BUILD=1).");
  process.exit(0);
}

buildUniversalSwiftProduct({
  packageRoot,
  product: "ade-media",
  outputPath,
  archsEnv: "ADE_MEDIA_ARCHS",
  tag: "ade-media",
});
