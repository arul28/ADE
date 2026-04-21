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
  const bundledCliPath = path.join(appBundlePath, "Contents", "Resources", "ade-cli", "cli.cjs");
  const bundledCliBinPath = path.join(appBundlePath, "Contents", "Resources", "ade-cli", "bin", "ade");
  const bundledCliInstallerPath = path.join(appBundlePath, "Contents", "Resources", "ade-cli", "install-path.sh");
  if (!fs.existsSync(runtimeRoot)) {
    throw new Error(`[afterPack] Missing unpacked runtime payload: ${runtimeRoot}`);
  }
  if (!fs.existsSync(bundledCliPath)) {
    throw new Error(`[afterPack] Missing bundled ADE CLI entry: ${bundledCliPath}`);
  }
  if (!fs.existsSync(bundledCliBinPath)) {
    throw new Error(`[afterPack] Missing bundled ADE CLI wrapper: ${bundledCliBinPath}`);
  }
  if (!fs.existsSync(bundledCliInstallerPath)) {
    throw new Error(`[afterPack] Missing bundled ADE CLI PATH installer: ${bundledCliInstallerPath}`);
  }
  fs.chmodSync(bundledCliBinPath, 0o755);
  fs.chmodSync(bundledCliInstallerPath, 0o755);

  const normalized = normalizeDesktopRuntimeBinaries(runtimeRoot);
  for (const entry of normalized) {
    console.log(`[afterPack] Restored executable mode: ${entry.label} -> ${path.relative(appBundlePath, entry.filePath)}`);
  }

  const requiredScripts = [
    path.join(runtimeRoot, "dist", "main", "packagedRuntimeSmoke.cjs"),
  ];

  for (const scriptPath of requiredScripts) {
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`[afterPack] Missing unpacked runtime entry: ${scriptPath}`);
    }
  }
};
