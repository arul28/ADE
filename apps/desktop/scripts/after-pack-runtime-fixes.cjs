const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeDesktopRuntimeBinaries,
  resolvePackagedRuntimeRoot,
} = require("./runtimeBinaryPermissions.cjs");
const {
  missingRequiredPackagedAdeCliPayloadPaths,
  packagedAdeCliPayloadFiles,
} = require("./packaged-ade-cli-resources.cjs");

const appDir = path.resolve(__dirname, "..");

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

function darwinCrsqliteTargetsForContext(context) {
  const appOutDir = String(context?.appOutDir || "");
  if (/mac-universal/.test(appOutDir) || context?.arch === 4) {
    return ["darwin-arm64", "darwin-x64"];
  }
  const isArm64 = /arm64/.test(appOutDir) || context?.arch === 3;
  return [isArm64 ? "darwin-arm64" : "darwin-x64"];
}

function darwinPackageArchForContext(context) {
  const appOutDir = String(context?.appOutDir || "");
  const appOutDirName = path.basename(appOutDir);
  if (appOutDirName === "mac-universal" || context?.arch === 4) return null;
  if (/arm64/.test(appOutDir) || context?.arch === 3) return "darwin-arm64";
  return "darwin-x64";
}

function copyDirectoryIfPresent(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) return false;
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
  return true;
}

function openCodeNativePackagesForPlatform(platform) {
  if (platform === "darwin") return ["opencode-darwin-arm64", "opencode-darwin-x64"];
  if (platform === "win32") return ["opencode-windows-x64", "opencode-windows-arm64"];
  if (platform === "linux") {
    return [
      "opencode-linux-arm64",
      "opencode-linux-arm64-musl",
      "opencode-linux-x64",
      "opencode-linux-x64-baseline",
      "opencode-linux-x64-baseline-musl",
      "opencode-linux-x64-musl",
    ];
  }
  return [];
}

function openCodeBinaryName(platform) {
  return platform === "win32" ? "opencode.exe" : "opencode";
}

function ensureOpenCodeRuntimePackages(runtimeRoot, platform) {
  const sourceNodeModules = path.join(appDir, "node_modules");
  const targetNodeModules = path.join(runtimeRoot, "node_modules");
  const copied = [];

  if (copyDirectoryIfPresent(
    path.join(sourceNodeModules, "opencode-ai"),
    path.join(targetNodeModules, "opencode-ai"),
  )) {
    copied.push("opencode-ai");
  }

  for (const packageName of openCodeNativePackagesForPlatform(platform)) {
    if (copyDirectoryIfPresent(
      path.join(sourceNodeModules, packageName),
      path.join(targetNodeModules, packageName),
    )) {
      copied.push(packageName);
    }
  }

  if (!copied.includes("opencode-ai")) {
    throw new Error(`[afterPack] Missing source OpenCode package: ${path.join(sourceNodeModules, "opencode-ai")}`);
  }

  const nativePackages = copied.filter((packageName) => (
    packageName !== "opencode-ai" && packageName.startsWith("opencode-")
  ));
  if (nativePackages.length === 0) {
    throw new Error(`[afterPack] Missing source OpenCode native package for ${platform}: ${sourceNodeModules}`);
  }

  const binaryName = openCodeBinaryName(platform);
  for (const packageName of nativePackages) {
    requireFile(
      path.join(targetNodeModules, packageName, "bin", binaryName),
      `bundled OpenCode native binary ${packageName}`,
    );
  }

  console.log(`[afterPack] Bundled OpenCode runtime packages: ${copied.join(", ")}`);
}

function pruneOpenCodeInstallShim(runtimeRoot, platform) {
  const shimPath = path.join("node_modules", "opencode-ai", "bin", "opencode.exe");
  if (removeIfPresent(runtimeRoot, shimPath)) {
    const reason = platform === "win32" ? "duplicate" : "non-target";
    console.log(`[afterPack] Pruned ${reason} OpenCode install shim: ${shimPath}`);
  }
}

function replaceCpuFeaturesNativeAddon(runtimeRoot, context) {
  const packageArch = darwinPackageArchForContext(context);
  if (!packageArch) return;

  const preparedAddonPath = path.join(
    appDir,
    "node_modules",
    ".ade-universal",
    "cpu-features",
    packageArch,
    "cpufeatures.node",
  );
  const packagedAddonPath = path.join(
    runtimeRoot,
    "node_modules",
    "cpu-features",
    "build",
    "Release",
    "cpufeatures.node",
  );
  requireFile(packagedAddonPath, "packaged cpu-features native addon");

  if (!fs.existsSync(preparedAddonPath)) {
    console.log(
      `[afterPack] Keeping packaged cpu-features native addon for ${packageArch}; ` +
        `no prepared replacement found at ${preparedAddonPath}`,
    );
    return;
  }

  fs.copyFileSync(preparedAddonPath, packagedAddonPath);
  console.log(`[afterPack] Replaced cpu-features native addon for ${packageArch}`);
}

function normalizePackageChannel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "alpha" || normalized === "beta" ? normalized : null;
}

function resolvePackageChannel(context) {
  const explicit = normalizePackageChannel(process.env.ADE_PACKAGE_CHANNEL);
  if (explicit) return explicit;
  const appInfo = context?.packager?.appInfo;
  const candidates = [
    appInfo?.productName,
    appInfo?.productFilename,
    appInfo?.id,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || "").toLowerCase();
    if (text.includes("alpha")) return "alpha";
    if (text.includes("beta")) return "beta";
  }
  return null;
}

function channelCliName(channel) {
  if (channel === "alpha") return "ade-alpha";
  if (channel === "beta") return "ade-beta";
  return "ade";
}

function materializeChannelCliWrapper(resourcesRoot, channel, platform = "darwin") {
  if (!channel) return null;
  const cliRoot = path.join(resourcesRoot, "ade-cli");
  const binRoot = path.join(cliRoot, "bin");
  const extension = platform === "win32" ? ".cmd" : "";
  const sourcePath = path.join(binRoot, `ade${extension}`);
  const targetPath = path.join(binRoot, `${channelCliName(channel)}${extension}`);
  requireFile(sourcePath, "bundled ADE CLI wrapper");
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, 0o755);
  fs.writeFileSync(path.join(cliRoot, "channel"), `${channel}\n`);
  return targetPath;
}

function removeIfPresent(rootPath, relativePath) {
  const targetPath = path.join(rootPath, relativePath);
  if (!fs.existsSync(targetPath)) return false;
  fs.rmSync(targetPath, { recursive: true, force: true });
  return true;
}

// Per-arch builds bundle only their matching remote-runtime sidecar. CI stages
// BOTH ade-darwin-arm64 and ade-darwin-x64 into resources/runtime; here we drop
// the non-matching arch so each per-arch app only carries its own (~300 MB
// saved — the main reason the per-arch update zip fits Squirrel's download
// path). Universal builds keep both.
function pruneNonMatchingDarwinRuntimeSidecar(resourcesRoot, context) {
  const appOutDir = String(context?.appOutDir || "");
  if (/mac-universal/.test(appOutDir) || context?.arch === 4) return;
  const isArm64 = /arm64/.test(appOutDir) || context?.arch === 3;
  const otherArch = isArm64 ? "x64" : "arm64";
  const runtimeDir = path.join(resourcesRoot, "runtime");
  const pruned = [];
  for (const name of [`ade-darwin-${otherArch}`, `ade-darwin-${otherArch}.native.tar.gz`]) {
    if (removeIfPresent(runtimeDir, name)) pruned.push(name);
  }
  if (pruned.length > 0) {
    console.log(
      `[afterPack] Pruned non-target runtime sidecar for ${isArm64 ? "arm64" : "x64"}: ${pruned.join(", ")}`,
    );
  }
}

function claudeNativePackagesToPrune(platform) {
  const byPlatform = {
    darwin: [
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-x64"),
    ],
    linux: [
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk-linux-arm64"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk-linux-arm64-musl"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64-musl"),
    ],
    win32: [
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk-win32-arm64"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64"),
    ],
  };
  return Object.entries(byPlatform)
    .filter(([targetPlatform]) => targetPlatform !== platform)
    .flatMap(([, packages]) => packages);
}

function codexNativePackagesToPrune(platform) {
  const byPlatform = {
    darwin: [
      path.join("node_modules", "@openai", "codex-darwin-arm64"),
      path.join("node_modules", "@openai", "codex-darwin-x64"),
    ],
    linux: [
      path.join("node_modules", "@openai", "codex-linux-arm64"),
      path.join("node_modules", "@openai", "codex-linux-x64"),
    ],
    win32: [
      path.join("node_modules", "@openai", "codex-win32-arm64"),
      path.join("node_modules", "@openai", "codex-win32-x64"),
    ],
  };
  return Object.entries(byPlatform)
    .filter(([targetPlatform]) => targetPlatform !== platform)
    .flatMap(([, packages]) => packages);
}

function cursorNativePackagesToPrune(platform) {
  const byPlatform = {
    darwin: [
      path.join("node_modules", "@cursor", "sdk-darwin-arm64"),
      path.join("node_modules", "@cursor", "sdk-darwin-x64"),
    ],
    linux: [
      path.join("node_modules", "@cursor", "sdk-linux-arm64"),
      path.join("node_modules", "@cursor", "sdk-linux-x64"),
    ],
    win32: [
      path.join("node_modules", "@cursor", "sdk-win32-x64"),
    ],
  };
  return Object.entries(byPlatform)
    .filter(([targetPlatform]) => targetPlatform !== platform)
    .flatMap(([, packages]) => packages);
}

function openCodeNativePackagesToPrune() {
  const packages = [
    "opencode-darwin-arm64",
    "opencode-darwin-x64",
    "opencode-darwin-x64-baseline",
    "opencode-linux-arm64",
    "opencode-linux-arm64-musl",
    "opencode-linux-x64",
    "opencode-linux-x64-baseline",
    "opencode-linux-x64-baseline-musl",
    "opencode-linux-x64-musl",
    "opencode-windows-arm64",
    "opencode-windows-x64",
    "opencode-windows-x64-baseline",
  ];
  return packages.map((packageName) => path.join("node_modules", packageName));
}

function pruneUnneededRuntimePayload(runtimeRoot, platform) {
  const commonNonRuntimePayload = [
    ...claudeNativePackagesToPrune(platform),
    ...codexNativePackagesToPrune(platform),
    ...cursorNativePackagesToPrune(platform),
    ...openCodeNativePackagesToPrune(),
    path.join("node_modules", "node-pty", "deps"),
    path.join("node_modules", "node-pty", "src"),
  ];
  const win32X64OnlyPayload = platform === "win32"
    ? [
        path.join("node_modules", "@anthropic-ai", "claude-agent-sdk-win32-arm64"),
        path.join("node_modules", "@openai", "codex-win32-arm64"),
        path.join("node_modules", "node-pty", "build", "Release", "conpty"),
        path.join("node_modules", "node-pty", "third_party", "conpty", "1.23.251008001", "win10-arm64"),
        path.join("node_modules", "node-pty", "prebuilds", "win32-arm64"),
      ]
    : [];
  const platformPayload = {
    darwin: [
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "audio-capture", "arm64-linux"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "audio-capture", "arm64-win32"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "audio-capture", "x64-linux"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "audio-capture", "x64-win32"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep", "arm64-linux"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep", "x64-linux"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "tree-sitter-bash", "arm64-linux"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "tree-sitter-bash", "arm64-win32"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "tree-sitter-bash", "x64-linux"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "tree-sitter-bash", "x64-win32"),
      path.join("node_modules", "node-pty", "prebuilds", "win32-arm64"),
      path.join("node_modules", "node-pty", "prebuilds", "win32-x64"),
      path.join("vendor", "crsqlite", "win32-x64"),
    ],
    win32: [
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "audio-capture", "arm64-darwin"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "audio-capture", "arm64-linux"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "audio-capture", "x64-darwin"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "audio-capture", "x64-linux"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep", "arm64-darwin"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep", "arm64-linux"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep", "x64-darwin"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep", "x64-linux"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "tree-sitter-bash", "arm64-darwin"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "tree-sitter-bash", "arm64-linux"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "tree-sitter-bash", "x64-darwin"),
      path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "tree-sitter-bash", "x64-linux"),
      path.join("node_modules", "node-pty", "prebuilds", "darwin-arm64"),
      path.join("node_modules", "node-pty", "prebuilds", "darwin-x64"),
      path.join("vendor", "crsqlite", "darwin-arm64"),
      path.join("vendor", "crsqlite", "darwin-x64"),
    ],
  };
  const candidates = [
    ...commonNonRuntimePayload,
    ...win32X64OnlyPayload,
    ...(platformPayload[platform] ?? []),
  ];
  const removed = candidates.filter((relativePath) => removeIfPresent(runtimeRoot, relativePath));
  if (removed.length > 0) {
    console.log(`[afterPack] Pruned ${removed.length} non-target runtime payload entries`);
    for (const relativePath of removed) {
      console.log(`[afterPack] Pruned: ${relativePath}`);
    }
  }
}

module.exports = async function afterPack(context) {
  const platform = context?.electronPlatformName;
  const packageChannel = resolvePackageChannel(context);
  const { runtimeRoot, appBundlePath } = resolveUnpackedRuntimeRoot(context);
  if (!fs.existsSync(runtimeRoot)) {
    throw new Error(`[afterPack] Missing unpacked runtime payload: ${runtimeRoot}`);
  }

  const resourcesRoot = resolveExtraResourcesRoot(context, appBundlePath);
  const bundledAdeCliFiles = packagedAdeCliPayloadFiles({ desktopRoot: appDir });
  const missingRequiredPayload = missingRequiredPackagedAdeCliPayloadPaths(bundledAdeCliFiles);
  if (missingRequiredPayload.length > 0) {
    throw new Error(
      `[afterPack] ADE CLI resources omit required payload: ${missingRequiredPayload.join(", ")}`,
    );
  }
  for (const resource of bundledAdeCliFiles) {
    requireFile(
      path.join(resourcesRoot, resource.to),
      `bundled ADE CLI resource ${resource.to}`,
    );
  }

  if (platform === "darwin") {
    const bundledCliBinPath = path.join(resourcesRoot, "ade-cli", "bin", "ade");
    const bundledCliInstallerPath = path.join(resourcesRoot, "ade-cli", "install-path.sh");
    requireFile(bundledCliBinPath, "bundled ADE CLI wrapper");
    requireFile(bundledCliInstallerPath, "bundled ADE CLI PATH installer");
    fs.chmodSync(bundledCliBinPath, 0o755);
    fs.chmodSync(bundledCliInstallerPath, 0o755);
    const channelWrapperPath = materializeChannelCliWrapper(resourcesRoot, packageChannel, platform);
    if (channelWrapperPath) {
      console.log(`[afterPack] Added channel CLI wrapper: ${path.basename(channelWrapperPath)}`);
    }
  } else if (platform === "win32") {
    requireFile(path.join(resourcesRoot, "ade-cli", "bin", "ade.cmd"), "bundled ADE CLI Windows wrapper");
    requireFile(path.join(resourcesRoot, "ade-cli", "install-path.cmd"), "bundled ADE CLI Windows PATH installer");
    requireFile(path.join(resourcesRoot, "ade-cli", "windows-uninstall-cleanup.ps1"), "bundled Windows uninstall cleanup script");
    requireFile(path.join(resourcesRoot, "ade-cli", "windows-install-setup.ps1"), "bundled Windows install setup script");
    requireFile(path.join(resourcesRoot, "ade-cli", "windows-firewall-rules.ps1"), "bundled Windows firewall rule script");
    const channelWrapperPath = materializeChannelCliWrapper(resourcesRoot, packageChannel, platform);
    if (channelWrapperPath) {
      console.log(`[afterPack] Added channel CLI wrapper: ${path.basename(channelWrapperPath)}`);
    }
  } else {
    requireFile(path.join(resourcesRoot, "ade-cli", "bin", "ade"), "bundled ADE CLI wrapper");
    requireFile(path.join(resourcesRoot, "ade-cli", "install-path.sh"), "bundled ADE CLI PATH installer");
    requireFile(path.join(resourcesRoot, "ade-cli", "bin", "ade.cmd"), "bundled ADE CLI Windows wrapper");
    requireFile(path.join(resourcesRoot, "ade-cli", "install-path.cmd"), "bundled ADE CLI Windows PATH installer");
  }

  pruneUnneededRuntimePayload(runtimeRoot, platform);
  if (platform === "darwin") {
    pruneNonMatchingDarwinRuntimeSidecar(resourcesRoot, context);
    replaceCpuFeaturesNativeAddon(runtimeRoot, context);
  }
  ensureOpenCodeRuntimePackages(runtimeRoot, platform);
  pruneOpenCodeInstallShim(runtimeRoot, platform);

  const normalized = normalizeDesktopRuntimeBinaries(runtimeRoot);
  for (const entry of normalized) {
    console.log(`[afterPack] Restored executable mode: ${entry.label} -> ${path.relative(runtimeRoot, entry.filePath)}`);
  }

  const requiredScripts = [path.join(runtimeRoot, "dist", "main", "packagedRuntimeSmoke.cjs")];
  if (platform === "darwin") {
    for (const target of darwinCrsqliteTargetsForContext(context)) {
      requiredScripts.push(path.join(runtimeRoot, "vendor", "crsqlite", target, "crsqlite.dylib"));
    }
  } else if (platform === "win32") {
    requiredScripts.push(path.join(runtimeRoot, "vendor", "crsqlite", "win32-x64", "crsqlite.dll"));
  }

  for (const scriptPath of requiredScripts) {
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`[afterPack] Missing unpacked runtime entry: ${scriptPath}`);
    }
  }
};
