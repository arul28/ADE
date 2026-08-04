#!/usr/bin/env node
/**
 * Generate `src/services/tools/toolsManifest.generated.json` from
 * `package-lock.json`.
 *
 * The manifest pins the agent CLI platform packages ADE no longer vendors, so
 * that a fresh install can fetch them from the npm registry instead of shipping
 * ~650 MB of binaries inside the app and the brain runtime tarball. Versions,
 * tarball URLs, and sha512 integrity all come from the lockfile — nothing here
 * is invented, and nothing talks to the network.
 *
 *   node scripts/generate-tools-manifest.mjs           # write
 *   node scripts/generate-tools-manifest.mjs --check   # fail if stale (CI)
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lockPath = path.join(packageRoot, "package-lock.json");
const outputPath = path.join(packageRoot, "src", "services", "tools", "toolsManifest.generated.json");

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
 * - `@opencode-ai/sdk` — pure JS, ESM-only, force-inlined for the same reason.
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
      "darwin-arm64": "opencode-darwin-arm64",
      "darwin-x64": "opencode-darwin-x64",
      "linux-arm64": "opencode-linux-arm64",
      "linux-x64": "opencode-linux-x64",
      // NOT `opencode-windows-x64`. The desktop bundle excludes that package
      // outright (`"!node_modules/opencode-windows-x64/**"` in
      // apps/desktop/package.json) and `openCodeBinaryManager.ts` maps win32/x64
      // to the baseline build, which does not require AVX2. Shipping the
      // non-baseline build would crash on pre-Haswell CPUs.
      "win32-x64": "opencode-windows-x64-baseline",
    },
  },
];

function fail(message) {
  process.stderr.write(`generate-tools-manifest: ${message}\n`);
  process.exit(1);
}

function readLockPackages() {
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    fail(`could not read ${lockPath}: ${error.message}`);
  }
  if (!lock.packages || typeof lock.packages !== "object") {
    fail(`${lockPath} has no "packages" map; lockfileVersion 2+ is required.`);
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

function buildManifest() {
  const packages = readLockPackages();
  const tools = TOOLS.map((tool) => {
    const targets = {};
    for (const target of TARGETS) {
      const packageName = tool.packages[target];
      if (!packageName) {
        fail(`${tool.name} has no package mapped for supported target ${target}.`);
      }
      targets[target] = pinFor(packages, tool.name, target, packageName);
    }
    const entry = tool.entry.windowsPath
      ? { kind: tool.entry.kind, path: tool.entry.path, windowsPath: tool.entry.windowsPath }
      : { kind: tool.entry.kind, path: tool.entry.path };
    return { name: tool.name, description: tool.description, entry, targets };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedFrom: "apps/ade-cli/package-lock.json",
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
    fail(`${outputPath} is out of date with package-lock.json. Run: npm run tools:manifest`);
  }
  process.stdout.write("tools manifest is up to date\n");
} else {
  writeFileSync(outputPath, serialized, "utf8");
  process.stdout.write(`wrote ${path.relative(packageRoot, outputPath)}\n`);
}
