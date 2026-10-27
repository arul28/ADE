#!/usr/bin/env node
/**
 * Generate `src/services/tools/toolsManifest.generated.json` from
 * `package-lock.json`, `../desktop/package-lock.json` (the Copilot runtime) and
 * `scripts/muse-release.json`.
 *
 * The manifest pins the agent CLI platform packages ADE no longer vendors, so
 * that a fresh install can fetch them from the npm registry instead of shipping
 * ~650 MB of binaries inside the app and the brain runtime tarball. Versions,
 * tarball URLs, and sha512 integrity all come from the lockfile — nothing here
 * is invented, and nothing talks to the network.
 *
 * Tools that are in no ADE lockfile (droid, grok, qwen, kimi, devin,
 * antigravity, pi) are pinned from `scripts/pins/<tool>.json`, which
 * `npm run tools:pin -- <tool> [version]` writes from the vendor's metadata.
 * The generator only validates and copies those files.
 *
 * Meta's `muse` binary is not on npm. Its pins (url + sha256 + size per target)
 * come from the checked-in `scripts/muse-release.json`, which
 * `npm run tools:muse-pin` writes from Meta's versioned release manifest. This
 * generator stays offline: it only reads that file, and refuses it when its
 * `sdkVersion` no longer matches the locked `@muse-code/sdk`, so a bumped SDK
 * without a re-pinned binary fails `tools:manifest:check` in CI.
 *
 *   node scripts/generate-tools-manifest.mjs           # write
 *   node scripts/generate-tools-manifest.mjs --check   # fail if stale (CI)
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_PIN_HOST, NPM_REGISTRY_HOST, VENDOR_DOWNLOAD_HOSTS } from "./file-pin-host.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lockPath = path.join(packageRoot, "package-lock.json");
// The Copilot SDK is a desktop dependency (its worker is bundled from desktop
// source), so its runtime is pinned from the lockfile that actually installs it.
// Reading it there rather than mirroring the dependency here means a bumped SDK
// fails `tools:manifest:check` until the runtime pin moves with it.
const desktopLockPath = path.join(packageRoot, "..", "desktop", "package-lock.json");
const outputPath = path.join(packageRoot, "src", "services", "tools", "toolsManifest.generated.json");
const museReleasePath = path.join(packageRoot, "scripts", "muse-release.json");
const pinsDir = path.join(packageRoot, "scripts", "pins");

const SCHEMA_VERSION = 1;
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];

/**
 * The tools that move to fetch-on-install, and where their payload lives inside
 * the unpacked package.
 *
 * Deliberately excluded, with reasons:
 *
 * - `@cursor/sdk` — the 24 MB half is the JS package itself, which every
 *   consumer reaches through a bare `import("@cursor/sdk")`
 *   (`services/ai/cursorSdkLoader.ts`). Moving it out of `node_modules` means
 *   rewiring module resolution, not just a path lookup, and the platform half
 *   (`@cursor/sdk-darwin-arm64`) is only ~7.6 MB. All risk, ~1% of the saving.
 * - `@factory/droid-sdk` — pure JS, ~15 MB, and it is force-inlined into the
 *   ade-cli bundle (`noExternal` in tsup.config.ts). There is no platform
 *   package to fetch.
 * - `@opencode/client` — pure JS, ESM-only, force-inlined for the same reason.
 *   Only opencode's *native* binary is fetched.
 */
const TOOLS = [
  {
    name: "codex",
    description: "OpenAI Codex CLI native binary, spawned as `codex app-server`.",
    entry: { kind: "binary", path: "vendor/*/bin/codex", windowsPath: "vendor/*/bin/codex.exe" },
    packages: {
      "darwin-arm64": "@openai/codex-darwin-arm64",
      "darwin-x64": "@openai/codex-darwin-x64",
      "linux-arm64": "@openai/codex-linux-arm64",
      "linux-x64": "@openai/codex-linux-x64",
      "win32-x64": "@openai/codex-win32-x64",
    },
  },
  {
    name: "claude-code",
    description: "Claude Code native binary that the Claude agent SDK spawns via pathToClaudeCodeExecutable.",
    entry: { kind: "binary", path: "claude", windowsPath: "claude.exe" },
    packages: {
      "darwin-arm64": "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "darwin-x64": "@anthropic-ai/claude-agent-sdk-darwin-x64",
      "linux-arm64": "@anthropic-ai/claude-agent-sdk-linux-arm64",
      "linux-x64": "@anthropic-ai/claude-agent-sdk-linux-x64",
      "win32-x64": "@anthropic-ai/claude-agent-sdk-win32-x64",
    },
  },
  {
    name: "opencode",
    description: "OpenCode native binary.",
    entry: { kind: "binary", path: "bin/opencode", windowsPath: "bin/opencode.exe" },
    packages: {
      "darwin-arm64": "@opencode/cli-darwin-arm64",
      "darwin-x64": "@opencode/cli-darwin-x64",
      "linux-arm64": "@opencode/cli-linux-arm64",
      "linux-x64": "@opencode/cli-linux-x64",
      // NOT `@opencode/cli-windows-x64`. The desktop bundle excludes that package
      // outright (`"!node_modules/@opencode/cli-windows-x64/**"` in
      // apps/desktop/package.json) and `openCodeBinaryManager.ts` maps win32/x64
      // to the baseline build, which does not require AVX2. Shipping the
      // non-baseline build would crash on pre-Haswell CPUs.
      "win32-x64": "@opencode/cli-windows-x64-baseline",
    },
  },
  {
    name: "copilot",
    description: "GitHub Copilot runtime that the Copilot SDK worker spawns (`--headless --stdio`).",
    entry: { kind: "binary", path: "prebuilds/*/copilot-runtime", windowsPath: "prebuilds/*/copilot-runtime.exe" },
    lockPath: desktopLockPath,
    packages: {
      "darwin-arm64": "@github/copilot-sdk-darwin-arm64",
      "darwin-x64": "@github/copilot-sdk-darwin-x64",
      "linux-arm64": "@github/copilot-sdk-linux-arm64",
      "linux-x64": "@github/copilot-sdk-linux-x64",
      "win32-x64": "@github/copilot-sdk-win32-x64",
    },
  },
];

/**
 * Tools published as one bare executable per target, pinned from a checked-in
 * release file rather than the lockfile. `pairedPackage` is the npm package
 * whose locked version the release must match.
 */
const FILE_TOOLS = [
  {
    name: "muse",
    description: "Meta Muse Code CLI native binary, spawned as `muse serve` and in ADE terminals.",
    entry: { kind: "binary", path: "muse", windowsPath: "muse.exe" },
    releasePath: museReleasePath,
    pairedPackage: "@muse-code/sdk",
    cacheDirPrefix: "muse-code",
  },
];

/**
 * Tools pinned from the vendor rather than a lockfile, in manifest order, and
 * where their entry lives once unpacked. The per-target URLs and checksums
 * come from `scripts/pins/<name>.json` (`npm run tools:pin`).
 */
const VENDOR_PINNED_TOOLS = [
  {
    name: "droid",
    description: "Factory Droid CLI native binary, which the Droid SDK worker spawns (`droid exec`).",
    entry: { kind: "binary", path: "bin/droid", windowsPath: "bin/droid.exe" },
  },
  {
    name: "grok",
    description: "xAI Grok CLI native binary, spawned as `grok stdio` (shipped brotli-compressed, inflated on install).",
    entry: { kind: "binary", path: "bin/grok", windowsPath: "bin/grok.exe" },
  },
  {
    name: "qwen",
    description: "Qwen Code standalone bundle: its own Node runs `lib/cli-entry.js --acp`.",
    entry: {
      kind: "binary",
      path: "node/bin/node",
      windowsPath: "node/node.exe",
      files: { script: { path: "lib/cli-entry.js" } },
    },
  },
  {
    name: "kimi",
    description: "Kimi Code CLI native binary, spawned as `kimi acp`.",
    entry: { kind: "binary", path: "kimi", windowsPath: "kimi.exe" },
  },
  {
    name: "devin",
    description: "Devin CLI native binary, spawned as `devin acp`.",
    entry: { kind: "binary", path: "bin/devin", windowsPath: "bin/devin.exe" },
  },
  {
    name: "antigravity",
    description: "Google Antigravity ACP server; its local harness must sit beside it.",
    entry: {
      kind: "binary",
      path: "agy_acp_server.par",
      windowsPath: "agy_acp_server.exe",
      files: { harness: { path: "localharness_external", windowsPath: "localharness_external.exe", executable: true } },
    },
  },
  {
    name: "pi",
    description: "Pi coding agent SDK and its dependency tree, imported by the Pi SDK worker.",
    entry: {
      kind: "directory",
      path: "node_modules/@earendil-works/pi-coding-agent",
      files: {
        module: { path: "node_modules/@earendil-works/pi-coding-agent/dist/index.js" },
        // The package's `bin.pi`, which a terminal runs under the pinned `node`.
        // Pi 1.x ships it as the bundled runtime; re-check on a Pi bump.
        cli: { path: "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" },
      },
    },
  },
  {
    name: "copilot-cli",
    description: "GitHub Copilot CLI native binary that ADE terminals run (the SDK runtime is the `copilot` tool).",
    entry: { kind: "binary", path: "copilot", windowsPath: "copilot.exe" },
  },
  {
    name: "cursor-cli",
    description: "Cursor agent CLI: its bundled Node runs `index.js`, which is all the vendor launchers do.",
    entry: {
      kind: "binary",
      path: "node",
      windowsPath: "node.exe",
      files: { script: { path: "index.js" } },
    },
  },
  {
    // Fetched only when a recording needs a demo and the machine has no ffmpeg
    // of its own (agentToolDemand has no rule for it, so launch never fetches it).
    name: "ffmpeg",
    // BtbN publishes no macOS build, and macOS renders demos with ade-media.
    targets: ["linux-arm64", "linux-x64", "win32-x64"],
    description: "Static FFmpeg (BtbN GPL build) that renders demo videos where neither ade-media nor the desktop app's engine exists.",
    entry: {
      kind: "binary",
      path: "bin/ffmpeg",
      windowsPath: "bin/ffmpeg.exe",
      files: { ffprobe: { path: "bin/ffprobe", windowsPath: "bin/ffprobe.exe", executable: true } },
    },
  },
  {
    name: "node",
    description: "Official Node.js runtime for JS-only CLIs ADE runs in terminals (Pi's `dist/bundle/cli.js`).",
    entry: { kind: "binary", path: "bin/node", windowsPath: "node.exe" },
  },
];

function fail(message) {
  process.stderr.write(`generate-tools-manifest: ${message}\n`);
  process.exit(1);
}

function readLockPackages(file = lockPath) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`could not read ${file}: ${error.message}`);
  }
  if (!lock.packages || typeof lock.packages !== "object") {
    fail(`${file} has no "packages" map; lockfileVersion 2+ is required.`);
  }
  return lock.packages;
}

function pinFor(packages, toolName, target, packageName) {
  const entry = packages[`node_modules/${packageName}`];
  if (!entry) {
    fail(
      `${toolName} has no lockfile entry for ${packageName} (target ${target}). `
      + `Install it, or correct the target mapping in this script — a missing platform `
      + `variant must never be silently dropped from the manifest.`,
    );
  }
  const { version, resolved, integrity } = entry;
  if (typeof version !== "string" || version.length === 0) {
    fail(`${packageName} has no version in the lockfile.`);
  }
  if (typeof resolved !== "string" || !resolved.startsWith("https://")) {
    fail(`${packageName} has no https tarball URL in the lockfile (got ${String(resolved)}).`);
  }
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    fail(`${packageName} has no sha512 integrity in the lockfile (got ${String(integrity)}).`);
  }
  return { package: packageName, version, tarball: resolved, integrity };
}

function readFileToolRelease(packages, tool) {
  const relative = path.relative(packageRoot, tool.releasePath);
  let release;
  try {
    release = JSON.parse(readFileSync(tool.releasePath, "utf8"));
  } catch (error) {
    fail(`could not read ${relative}: ${error.message}. Run: npm run tools:muse-pin`);
  }
  const locked = packages[`node_modules/${tool.pairedPackage}`]?.version;
  if (typeof locked !== "string") {
    fail(`${tool.pairedPackage} is not in package-lock.json; ${tool.name} cannot be paired with it.`);
  }
  if (release.sdkVersion !== locked) {
    fail(
      `${relative} pins ${tool.name} for ${tool.pairedPackage}@${String(release.sdkVersion)}, `
      + `but package-lock.json has ${locked}. Run: npm run tools:muse-pin`,
    );
  }
  if (typeof release.version !== "string" || !release.version.startsWith(`${locked}-`)) {
    fail(`${relative} version ${String(release.version)} does not pair with ${tool.pairedPackage}@${locked}.`);
  }
  const targets = {};
  for (const target of TARGETS) {
    const pin = release.targets?.[target];
    if (!pin) fail(`${relative} has no ${tool.name} build for supported target ${target}.`);
    if (typeof pin.url !== "string" || !pin.url.startsWith("https://")) {
      fail(`${relative} ${target} has no https url.`);
    }
    if (new URL(pin.url).hostname !== FILE_PIN_HOST) {
      fail(`${relative} ${target} downloads from ${new URL(pin.url).hostname}; a file pin must be on ${FILE_PIN_HOST}.`);
    }
    if (typeof pin.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pin.sha256)) {
      fail(`${relative} ${target} has no lowercase hex sha256.`);
    }
    if (!Number.isSafeInteger(pin.size) || pin.size <= 0) fail(`${relative} ${target} has no byte size.`);
    targets[target] = {
      format: "file",
      package: `${tool.cacheDirPrefix}-${target}`,
      version: release.version,
      url: pin.url,
      sha256: pin.sha256,
      size: pin.size,
    };
  }
  return { name: tool.name, description: tool.description, entry: tool.entry, targets };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SRI_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

function requireUrlOn(url, host, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${label} is not a URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.host !== host) fail(`${label} must be an https URL on ${host}, got ${url}.`);
  return url;
}

function requirePositive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer.`);
  return value;
}

function copyDecompress(steps, label) {
  if (steps === undefined) return {};
  if (!Array.isArray(steps) || !steps.length) fail(`${label}.decompress must be a non-empty array.`);
  return {
    decompress: steps.map((step) => {
      if (step?.algorithm !== "brotli" || typeof step.from !== "string" || typeof step.to !== "string") {
        fail(`${label}.decompress entries must be { algorithm: "brotli", from, to }.`);
      }
      return { algorithm: "brotli", from: step.from, to: step.to };
    }),
  };
}

/**
 * One target of a vendor pin file, re-validated and rebuilt with a fixed key
 * order, so a hand-edited or stale pin file fails here rather than at
 * `parseToolsManifest` on a user's machine.
 */
function copyVendorTargetPin(toolName, pin, label, version) {
  if (pin?.version !== version) fail(`${label} pins ${String(pin?.version)}, but the file pins ${version}.`);
  if (typeof pin.package !== "string" || !pin.package) fail(`${label} has no package.`);
  const base = { format: pin.format, package: pin.package, version: pin.version };
  if (pin.format === "npm-tarball") {
    if (!SRI_PATTERN.test(pin.integrity ?? "")) fail(`${label} has no sha512 integrity.`);
    return {
      ...base,
      tarball: requireUrlOn(pin.tarball, NPM_REGISTRY_HOST, `${label}.tarball`),
      integrity: pin.integrity,
      ...copyDecompress(pin.decompress, label),
    };
  }
  if (pin.format === "archive") {
    const hosts = VENDOR_DOWNLOAD_HOSTS[toolName];
    if (!hosts) fail(`${toolName} has no vendor download host in file-pin-host.mjs.`);
    if (pin.archive !== "tar.gz" && pin.archive !== "tar.xz" && pin.archive !== "zip") fail(`${label}.archive must be tar.gz, tar.xz or zip.`);
    if (!Number.isInteger(pin.stripComponents) || pin.stripComponents < 0) fail(`${label}.stripComponents must be >= 0.`);
    if (!SHA256_PATTERN.test(pin.sha256 ?? "")) fail(`${label} has no lowercase hex sha256.`);
    return {
      ...base,
      url: requireUrlOn(pin.url, hosts[0], `${label}.url`),
      archive: pin.archive,
      stripComponents: pin.stripComponents,
      sha256: pin.sha256,
      size: requirePositive(pin.size, `${label}.size`),
      ...copyDecompress(pin.decompress, label),
    };
  }
  if (pin.format === "npm-tree") {
    if (!Array.isArray(pin.packages) || !pin.packages.length) fail(`${label}.packages must be a non-empty array.`);
    return {
      ...base,
      packages: pin.packages.map((entry, index) => {
        const entryLabel = `${label}.packages[${index}]`;
        if (typeof entry?.path !== "string" || !entry.path.startsWith("node_modules/")) fail(`${entryLabel}.path is not a lockfile path.`);
        if (!SRI_PATTERN.test(entry.integrity ?? "")) fail(`${entryLabel} has no sha512 integrity.`);
        return {
          path: entry.path,
          tarball: requireUrlOn(entry.tarball, NPM_REGISTRY_HOST, `${entryLabel}.tarball`),
          integrity: entry.integrity,
          size: requirePositive(entry.size, `${entryLabel}.size`),
        };
      }),
      unpackedSize: requirePositive(pin.unpackedSize, `${label}.unpackedSize`),
    };
  }
  fail(`${label}.format ${String(pin.format)} is not a vendor pin format.`);
}

function readVendorPin(tool) {
  const pinPath = path.join(pinsDir, `${tool.name}.json`);
  const relative = path.relative(packageRoot, pinPath);
  let pinFile;
  try {
    pinFile = JSON.parse(readFileSync(pinPath, "utf8"));
  } catch (error) {
    fail(`could not read ${relative}: ${error.message}. Run: npm run tools:pin -- ${tool.name}`);
  }
  if (pinFile.tool !== tool.name || typeof pinFile.version !== "string") {
    fail(`${relative} is not a ${tool.name} pin.`);
  }
  const targets = {};
  // A tool that names its targets is pinned only there; elsewhere it resolves
  // as "unavailable" and its consumer falls back.
  for (const target of tool.targets ?? TARGETS) {
    const pin = pinFile.targets?.[target];
    if (!pin) fail(`${relative} has no ${tool.name} build for supported target ${target}.`);
    targets[target] = copyVendorTargetPin(tool.name, pin, `${relative} ${target}`, pinFile.version);
  }
  return { name: tool.name, description: tool.description, entry: tool.entry, targets };
}

function buildManifest() {
  const packages = readLockPackages();
  const desktopPackages = readLockPackages(desktopLockPath);
  const tools = TOOLS.map((tool) => {
    const lockPackages = tool.lockPath === desktopLockPath ? desktopPackages : packages;
    const targets = {};
    for (const target of TARGETS) {
      const packageName = tool.packages[target];
      if (!packageName) {
        fail(`${tool.name} has no package mapped for supported target ${target}.`);
      }
      targets[target] = pinFor(lockPackages, tool.name, target, packageName);
    }
    const entry = tool.entry.windowsPath
      ? { kind: tool.entry.kind, path: tool.entry.path, windowsPath: tool.entry.windowsPath }
      : { kind: tool.entry.kind, path: tool.entry.path };
    // Locked in a package-lock.json, so a source checkout has it in node_modules.
    return { name: tool.name, description: tool.description, entry, checkoutCopy: true, targets };
  });
  for (const tool of FILE_TOOLS) tools.push(readFileToolRelease(packages, tool));
  for (const tool of VENDOR_PINNED_TOOLS) tools.push(readVendorPin(tool));

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedFrom:
      "apps/ade-cli/package-lock.json + apps/desktop/package-lock.json + apps/ade-cli/scripts/muse-release.json + apps/ade-cli/scripts/pins/*.json",
    tools,
  };
}

// Key order is fixed by construction above and TARGETS is a literal array, so
// JSON.stringify output is byte-stable across runs and machines.
const serialized = `${JSON.stringify(buildManifest(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outputPath, "utf8");
  } catch {
    fail(`${outputPath} is missing. Run: npm run tools:manifest`);
  }
  if (current !== serialized) {
    fail(`${outputPath} is out of date with package-lock.json, muse-release.json or scripts/pins/*.json. Run: npm run tools:manifest`);
  }
  process.stdout.write("tools manifest is up to date\n");
} else {
  writeFileSync(outputPath, serialized, "utf8");
  process.stdout.write(`wrote ${path.relative(packageRoot, outputPath)}\n`);
}
