const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeDesktopRuntimeBinaries,
  resolvePackagedRuntimeRoot,
} = require("./runtimeBinaryPermissions.cjs");

function resolveUnpackedRuntimeRoot(context) {
  const productFilename = context?.packager?.appInfo?.productFilename || "ADE";
  const appBundlePath = path.join(context?.appOutDir || "", `${productFilename}.app`);

  if (fs.existsSync(appBundlePath)) {
    return { runtimeRoot: resolvePackagedRuntimeRoot(appBundlePath), appBundlePath };
  }

  const resourcesRoot = path.join(context?.appOutDir || "", "resources", "app.asar.unpacked");
  if (!fs.existsSync(resourcesRoot)) {
    throw new Error(
      `[afterPack] Missing unpacked runtime payload (tried ${appBundlePath} and ${resourcesRoot})`,
    );
  }
  return { runtimeRoot: resourcesRoot, appBundlePath: null };
}

function resolveExtraResourcesRoot(context, appBundlePath) {
  if (appBundlePath) return path.join(appBundlePath, "Contents", "Resources");
  return path.join(context?.appOutDir || "", "resources");
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[afterPack] Missing ${label}: ${filePath}`);
  }
}

module.exports = async function afterPack(context) {
  const { runtimeRoot, appBundlePath } = resolveUnpackedRuntimeRoot(context);
  if (!fs.existsSync(runtimeRoot)) {
    throw new Error(`[afterPack] Missing unpacked runtime payload: ${runtimeRoot}`);
  }

  const resourcesRoot = resolveExtraResourcesRoot(context, appBundlePath);
  const bundledCliPath = path.join(resourcesRoot, "ade-cli", "cli.cjs");
  requireFile(bundledCliPath, "bundled ADE CLI entry");

  const bundledCliBinPath = path.join(resourcesRoot, "ade-cli", "bin", "ade");
  const bundledCliInstallerPath = path.join(resourcesRoot, "ade-cli", "install-path.sh");
  requireFile(bundledCliBinPath, "bundled ADE CLI wrapper");
  requireFile(bundledCliInstallerPath, "bundled ADE CLI PATH installer");
  requireFile(path.join(resourcesRoot, "ade-cli", "bin", "ade.cmd"), "bundled ADE CLI Windows wrapper");
  requireFile(path.join(resourcesRoot, "ade-cli", "install-path.cmd"), "bundled ADE CLI Windows PATH installer");
  fs.chmodSync(bundledCliBinPath, 0o755);
  fs.chmodSync(bundledCliInstallerPath, 0o755);

  const normalized = normalizeDesktopRuntimeBinaries(runtimeRoot);
  for (const entry of normalized) {
    console.log(`[afterPack] Restored executable mode: ${entry.label} -> ${path.relative(runtimeRoot, entry.filePath)}`);
  }

  const requiredScripts = [
    path.join(runtimeRoot, "dist", "main", "packagedRuntimeSmoke.cjs"),
    path.join(runtimeRoot, "vendor", "crsqlite", "darwin-arm64", "crsqlite.dylib"),
    path.join(runtimeRoot, "vendor", "crsqlite", "win32-x64", "crsqlite.dll"),
  ];

  for (const scriptPath of requiredScripts) {
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`[afterPack] Missing unpacked runtime entry: ${scriptPath}`);
    }
  }
};
