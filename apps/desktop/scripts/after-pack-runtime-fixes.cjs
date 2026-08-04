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
const {
  artifactNamesForTarget,
  diffRuntimeArtifacts,
  formatRuntimeArtifactDiff,
} = require("./runtime-resource-targets.cjs");

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

// `opencode-ai` ships a 107 MB Windows executable in its own bin/ on every
// platform. The JS launcher package still ships (the resolver and the ADE CLI
// both load it), but that payload never does: OpenCode itself comes from the
// machine tools cache now, on Windows as much as anywhere else.
function pruneOpenCodeInstallShim(runtimeRoot) {
  const shimPath = path.join("node_modules", "opencode-ai", "bin", "opencode.exe");
  if (removeIfPresent(runtimeRoot, shimPath)) {
    console.log(`[afterPack] Pruned runtime-fetched OpenCode install shim: ${shimPath}`);
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

// The remote-runtime sidecar set a packaged app is allowed to carry. macOS
// per-arch builds carry only their own darwin sidecar; a universal build carries
// both darwin arches; Windows carries only win32-x64. Everything else is
// foreign-platform payload -- carrying all of it is what pushed the v1.2.52
// macOS update zip to 1054 MB, past the 1 GB Squirrel.Mac CFData cliff.
function packagedRuntimeTargetsForContext(context, platform) {
  if (platform === "win32") return ["win32-x64"];
  if (platform !== "darwin") return [];
  const appOutDir = String(context?.appOutDir || "");
  if (/mac-universal/.test(appOutDir) || context?.arch === 4) return ["darwin-arm64", "darwin-x64"];
  return [/arm64/.test(appOutDir) || context?.arch === 3 ? "darwin-arm64" : "darwin-x64"];
}

// electron-builder's extraResources filter resolves `${arch}` to "universal" on
// a universal build, so neither darwin sidecar is copied. Stage both here from
// the same source directory the filter reads.
function stageMissingUniversalDarwinSidecars(runtimeDir, targets) {
  if (targets.length < 2) return;
  const sourceDir = path.join(appDir, "resources", "runtime");
  for (const name of targets.flatMap((target) => artifactNamesForTarget(target))) {
    const destinationPath = path.join(runtimeDir, name);
    if (fs.existsSync(destinationPath)) continue;
    const sourcePath = path.join(sourceDir, name);
    requireFile(sourcePath, `staged universal runtime sidecar ${name}`);
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    console.log(`[afterPack] Staged universal runtime sidecar: ${name}`);
  }
}

// Hard gate rather than a prune: the extraResources filter is already scoped per
// platform and arch, so anything unexpected here means that scoping regressed
// and the build must fail instead of quietly shipping the extra payload.
function assertPackagedRuntimeTargets(resourcesRoot, context, platform) {
  const targets = packagedRuntimeTargetsForContext(context, platform);
  if (targets.length === 0) return;
  const runtimeDir = path.join(resourcesRoot, "runtime");
  stageMissingUniversalDarwinSidecars(runtimeDir, targets);
  const diff = diffRuntimeArtifacts(runtimeDir, targets);
  if (diff.missing.length > 0 || diff.unexpected.length > 0) {
    throw new Error(`[afterPack] ${formatRuntimeArtifactDiff(runtimeDir, targets, diff)}`);
  }
  console.log(`[afterPack] Packaged runtime sidecars for ${targets.join(", ")}: ${diff.actual.join(", ")}`);
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

// Every native platform variant of Codex, Claude Code and OpenCode -- including
// the one matching the build target. Unlike the Cursor prune above, which keeps
// the on-target arch, these three tools have no on-target copy to keep: they are
// fetched into the machine tools cache at runtime and the resolvers read the
// cache before they ever look at node_modules.
function runtimeFetchedToolPackagesToPrune(runtimeFetchedToolPackageNames) {
  return runtimeFetchedToolPackageNames.map(
    (packageName) => path.join("node_modules", ...packageName.split("/")),
  );
}

function pruneUnneededRuntimePayload(runtimeRoot, platform, runtimeFetchedToolPackageNames) {
  const commonNonRuntimePayload = [
    ...cursorNativePackagesToPrune(platform),
    ...runtimeFetchedToolPackagesToPrune(runtimeFetchedToolPackageNames),
    path.join("node_modules", "node-pty", "deps"),
    path.join("node_modules", "node-pty", "src"),
  ];
  const win32X64OnlyPayload = platform === "win32"
    ? [
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

// Every place a node_modules tree can end up in a packed app: the unpacked
// sidecar the prune above operates on, the per-arch sidecars a universal build
// leaves behind, and `resources/app` when asar is disabled.
function packagedNodeModulesRoots(resourcesRoot, runtimeRoot) {
  const roots = new Set();
  if (runtimeRoot) roots.add(path.resolve(runtimeRoot));
  if (fs.existsSync(resourcesRoot)) {
    for (const entry of fs.readdirSync(resourcesRoot)) {
      if (/^app(-[^.]+)?\.asar\.unpacked$/.test(entry) || entry === "app") {
        roots.add(path.resolve(resourcesRoot, entry));
      }
    }
  }
  return [...roots].filter((root) => fs.existsSync(root));
}

function packagedAsarArchives(resourcesRoot) {
  if (!fs.existsSync(resourcesRoot)) return [];
  return fs
    .readdirSync(resourcesRoot)
    .filter((entry) => /^app(-[^.]+)?\.asar$/.test(entry))
    .map((entry) => path.join(resourcesRoot, entry));
}

function readAsarHeader(appAsarPath) {
  try {
    return require("@electron/asar").getRawHeader(appAsarPath).header;
  } catch (error) {
    throw new Error(
      `[afterPack] Unable to read ${appAsarPath} to verify runtime-fetched tool packages: `
      + `${error?.message ?? error}`,
    );
  }
}

function asarContainsPackageDirectory(header, packageName) {
  let node = header;
  for (const segment of ["node_modules", ...packageName.split("/")]) {
    node = node?.files?.[segment];
    if (!node) return false;
  }
  return true;
}

/**
 * The regression gate. Pruning alone is not a guarantee: dropping a package from
 * `asarUnpack` without a matching `!` exclusion in `build.files` moves it *into*
 * app.asar, where a directory check on the unpacked tree would never see it, and
 * a new platform variant appearing in the dependency graph would sail straight
 * through. Both are checked, and both fail the build rather than warn - the whole
 * point of this change is that these bytes never ship again.
 */
function assertNoRuntimeFetchedToolPackages(
  resourcesRoot,
  runtimeRoot,
  runtimeFetchedToolPackageNames,
  explanation,
) {
  const offenders = [];

  for (const root of packagedNodeModulesRoots(resourcesRoot, runtimeRoot)) {
    for (const packageName of runtimeFetchedToolPackageNames) {
      const packagePath = path.join(root, "node_modules", ...packageName.split("/"));
      if (fs.existsSync(packagePath)) offenders.push(packagePath);
    }
  }

  for (const appAsarPath of packagedAsarArchives(resourcesRoot)) {
    const header = readAsarHeader(appAsarPath);
    for (const packageName of runtimeFetchedToolPackageNames) {
      if (asarContainsPackageDirectory(header, packageName)) {
        offenders.push(`${appAsarPath}!/node_modules/${packageName}`);
      }
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `[afterPack] Packaged app ships ${offenders.length} runtime-fetched agent tool package(s) `
      + `that must not be bundled:\n  ${offenders.join("\n  ")}\n${explanation}\n`
      + "Fix: remove the package from build.asarUnpack in apps/desktop/package.json and add "
      + "\"!node_modules/<name>/**\" to build.files. The authoritative name list is "
      + "RUNTIME_FETCHED_TOOL_PACKAGES in apps/ade-cli/scripts/native-deps-entry-filter.mjs.",
    );
  }

  console.log(
    `[afterPack] Verified ${runtimeFetchedToolPackageNames.length} runtime-fetched agent tool `
    + "packages are absent from the packaged app",
  );
}

module.exports = async function afterPack(context) {
  const platform = context?.electronPlatformName;
  const packageChannel = resolvePackageChannel(context);
  // Dynamic import because the single source of truth for this list is an ESM
  // module shared with the brain runtime archive filter and both validators.
  const {
    runtimeFetchedToolPackageNames,
    RUNTIME_FETCHED_TOOL_EXPLANATION,
  } = await import(
    require("node:url").pathToFileURL(
      path.join(__dirname, "runtime-fetched-tool-packages.mjs"),
    ).href
  );
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

  pruneUnneededRuntimePayload(runtimeRoot, platform, runtimeFetchedToolPackageNames);
  assertPackagedRuntimeTargets(resourcesRoot, context, platform);
  if (platform === "darwin") {
    replaceCpuFeaturesNativeAddon(runtimeRoot, context);
  }
  pruneOpenCodeInstallShim(runtimeRoot);
  assertNoRuntimeFetchedToolPackages(
    resourcesRoot,
    runtimeRoot,
    runtimeFetchedToolPackageNames,
    RUNTIME_FETCHED_TOOL_EXPLANATION,
  );

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

// Exported for after-pack-runtime-fixes.test.mjs. The gate is the whole point of
// this hook, and the regression it guards against (a package landing inside
// app.asar) cannot be reproduced by planting a directory in the unpacked tree,
// so it needs to be reachable without running electron-builder.
module.exports.assertNoRuntimeFetchedToolPackages = assertNoRuntimeFetchedToolPackages;
