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

function materializeChannelCliWrapper(resourcesRoot, channel) {
  if (!channel) return null;
  const cliRoot = path.join(resourcesRoot, "ade-cli");
  const binRoot = path.join(cliRoot, "bin");
  const sourcePath = path.join(binRoot, "ade");
  const targetPath = path.join(binRoot, channelCliName(channel));
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
  // afterPack runs per-arch on darwin; pruning here would race the
  // electron-universal merge and ENOENT on deleted paths. Skip on darwin
  // until a post-merge prune step exists.
  if (platform === "darwin") return;
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
  const bundledCliPath = path.join(resourcesRoot, "ade-cli", "cli.cjs");
  const bundledCliBootstrapPath = path.join(resourcesRoot, "ade-cli", "bootstrap.cjs");
  const bundledCliRpcPath = path.join(resourcesRoot, "ade-cli", "adeRpcServer.cjs");
  const bundledCliTuiPath = path.join(resourcesRoot, "ade-cli", "tuiClient", "cli.mjs");
  requireFile(bundledCliPath, "bundled ADE CLI entry");
  requireFile(bundledCliBootstrapPath, "bundled ADE CLI bootstrap entry");
  requireFile(bundledCliRpcPath, "bundled ADE CLI RPC entry");
  requireFile(bundledCliTuiPath, "bundled ADE CLI TUI entry");

  if (platform === "darwin") {
    const bundledCliBinPath = path.join(resourcesRoot, "ade-cli", "bin", "ade");
    const bundledCliInstallerPath = path.join(resourcesRoot, "ade-cli", "install-path.sh");
    const iosSimHelperRoot = path.join(resourcesRoot, "native", "ios-sim-helpers");
    const iosSimHelperBuildScript = path.join(iosSimHelperRoot, "build.sh");
    requireFile(bundledCliBinPath, "bundled ADE CLI wrapper");
    requireFile(bundledCliInstallerPath, "bundled ADE CLI PATH installer");
    requireFile(iosSimHelperBuildScript, "bundled iOS simulator helper build script");
    requireFile(path.join(iosSimHelperRoot, "sim-capture.swift"), "bundled iOS simulator capture helper source");
    requireFile(path.join(iosSimHelperRoot, "sim-input.m"), "bundled iOS simulator input helper source");
    fs.chmodSync(bundledCliBinPath, 0o755);
    fs.chmodSync(bundledCliInstallerPath, 0o755);
    fs.chmodSync(iosSimHelperBuildScript, 0o755);
    const channelWrapperPath = materializeChannelCliWrapper(resourcesRoot, packageChannel);
    if (channelWrapperPath) {
      console.log(`[afterPack] Added channel CLI wrapper: ${path.basename(channelWrapperPath)}`);
    }
  } else if (platform === "win32") {
    requireFile(path.join(resourcesRoot, "ade-cli", "bin", "ade.cmd"), "bundled ADE CLI Windows wrapper");
    requireFile(path.join(resourcesRoot, "ade-cli", "install-path.cmd"), "bundled ADE CLI Windows PATH installer");
  } else {
    requireFile(path.join(resourcesRoot, "ade-cli", "bin", "ade"), "bundled ADE CLI wrapper");
    requireFile(path.join(resourcesRoot, "ade-cli", "install-path.sh"), "bundled ADE CLI PATH installer");
    requireFile(path.join(resourcesRoot, "ade-cli", "bin", "ade.cmd"), "bundled ADE CLI Windows wrapper");
    requireFile(path.join(resourcesRoot, "ade-cli", "install-path.cmd"), "bundled ADE CLI Windows PATH installer");
  }

  pruneUnneededRuntimePayload(runtimeRoot, platform);

  const normalized = normalizeDesktopRuntimeBinaries(runtimeRoot);
  for (const entry of normalized) {
    console.log(`[afterPack] Restored executable mode: ${entry.label} -> ${path.relative(runtimeRoot, entry.filePath)}`);
  }

  const requiredScripts = [path.join(runtimeRoot, "dist", "main", "packagedRuntimeSmoke.cjs")];
  if (platform === "darwin") {
    requiredScripts.push(path.join(runtimeRoot, "vendor", "crsqlite", "darwin-arm64", "crsqlite.dylib"));
  } else if (platform === "win32") {
    requiredScripts.push(path.join(runtimeRoot, "vendor", "crsqlite", "win32-x64", "crsqlite.dll"));
  }

  for (const scriptPath of requiredScripts) {
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`[afterPack] Missing unpacked runtime entry: ${scriptPath}`);
    }
  }
};
