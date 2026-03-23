const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeDesktopRuntimeBinaries,
  resolvePackagedRuntimeRoot,
} = require("./runtimeBinaryPermissions.cjs");

module.exports = async function afterPack(context) {
  const productFilename = context?.packager?.appInfo?.productFilename || "ADE";
  const appBundlePath = path.join(context?.appOutDir || "", `${productFilename}.app`);
  if (!appBundlePath || !fs.existsSync(appBundlePath)) {
    throw new Error(`[afterPack] Missing packaged app bundle: ${String(appBundlePath)}`);
  }

  const runtimeRoot = resolvePackagedRuntimeRoot(appBundlePath);
  if (!fs.existsSync(runtimeRoot)) {
    throw new Error(`[afterPack] Missing unpacked runtime payload: ${runtimeRoot}`);
  }

  const normalized = normalizeDesktopRuntimeBinaries(runtimeRoot);
  for (const entry of normalized) {
    console.log(`[afterPack] Restored executable mode: ${entry.label} -> ${path.relative(appBundlePath, entry.filePath)}`);
  }

  const requiredScripts = [
    path.join(runtimeRoot, "dist", "main", "adeMcpProxy.cjs"),
    path.join(runtimeRoot, "dist", "main", "packagedRuntimeSmoke.cjs"),
  ];

  for (const scriptPath of requiredScripts) {
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`[afterPack] Missing unpacked runtime entry: ${scriptPath}`);
    }
  }
};
