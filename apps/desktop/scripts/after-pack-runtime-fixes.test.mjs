import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import asar from "@electron/asar";
import {
  runtimeFetchedToolPackageNames,
  RUNTIME_FETCHED_TOOL_EXPLANATION,
} from "./runtime-fetched-tool-packages.mjs";

const require = createRequire(import.meta.url);
const { assertNoRuntimeFetchedToolPackages } = require("./after-pack-runtime-fixes.cjs");

function makeResources(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-afterpack-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesRoot = path.join(root, "Resources");
  const runtimeRoot = path.join(resourcesRoot, "app.asar.unpacked");
  fs.mkdirSync(path.join(runtimeRoot, "node_modules"), { recursive: true });
  return { root, resourcesRoot, runtimeRoot };
}

function writeAsar(root, resourcesRoot, files) {
  const staging = path.join(root, "asar-src");
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(staging, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return asar.createPackage(staging, path.join(resourcesRoot, "app.asar"));
}

function run(resourcesRoot, runtimeRoot) {
  return assertNoRuntimeFetchedToolPackages(
    resourcesRoot,
    runtimeRoot,
    runtimeFetchedToolPackageNames,
    RUNTIME_FETCHED_TOOL_EXPLANATION,
  );
}

test("a clean packaged tree passes the gate", async (t) => {
  const { root, resourcesRoot, runtimeRoot } = makeResources(t);
  fs.mkdirSync(path.join(runtimeRoot, "node_modules", "@openai", "codex"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "node_modules", "opencode-ai"), { recursive: true });
  await writeAsar(root, resourcesRoot, {
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs": "export const query = () => {};\n",
    "node_modules/@opencode-ai/sdk/index.js": "module.exports = {};\n",
  });

  assert.doesNotThrow(() => run(resourcesRoot, runtimeRoot));
});

test("a native tool package left in the unpacked tree fails the build", async (t) => {
  const { root, resourcesRoot, runtimeRoot } = makeResources(t);
  fs.mkdirSync(
    path.join(runtimeRoot, "node_modules", "@openai", "codex-darwin-arm64", "vendor"),
    { recursive: true },
  );
  await writeAsar(root, resourcesRoot, { "package.json": "{}\n" });

  assert.throws(
    () => run(resourcesRoot, runtimeRoot),
    (error) => {
      assert.match(error.message, /@openai\/codex-darwin-arm64/);
      assert.match(error.message, /fetched into the machine tools cache at runtime/);
      return true;
    },
  );
});

// The regression the gate actually exists for. Dropping a package from
// `asarUnpack` without a matching `!` exclusion in `build.files` does not remove
// it - electron-builder packs it *inside* app.asar, where no directory check on
// the unpacked tree can see it, and where the afterPack prune cannot reach it
// either.
test("a native tool package packed inside app.asar fails the build", async (t) => {
  const { root, resourcesRoot, runtimeRoot } = makeResources(t);
  await writeAsar(root, resourcesRoot, {
    "node_modules/opencode-windows-x64-baseline/bin/opencode.exe": "MZ\n",
    "node_modules/opencode-ai/package.json": "{}\n",
  });

  assert.throws(
    () => run(resourcesRoot, runtimeRoot),
    (error) => {
      assert.match(error.message, /app\.asar!\/node_modules\/opencode-windows-x64-baseline/);
      return true;
    },
  );
});

// A universal build leaves per-arch sidecars beside the merged app; a scan that
// only looked at the one runtimeRoot electron-builder handed the hook would miss
// half the payload.
test("the gate scans per-arch sidecars a universal build leaves behind", async (t) => {
  const { root, resourcesRoot, runtimeRoot } = makeResources(t);
  fs.mkdirSync(
    path.join(resourcesRoot, "app-x64.asar.unpacked", "node_modules", "opencode-darwin-x64"),
    { recursive: true },
  );
  await writeAsar(root, resourcesRoot, { "package.json": "{}\n" });

  assert.throws(
    () => run(resourcesRoot, runtimeRoot),
    (error) => {
      assert.match(error.message, /app-x64\.asar\.unpacked.*opencode-darwin-x64/s);
      return true;
    },
  );
});

// The `!` patterns in build.files are the mechanism that keeps these packages out
// of the package in the first place. This drives electron-builder's own matcher
// with the real config, so an over-broad pattern that also swallowed the JS SDK
// (or a missing pattern) is caught without a full packaged build.
test("build.files drops exactly the native tool packages and nothing else", () => {
  let fileMatcher;
  try {
    fileMatcher = require("app-builder-lib/out/fileMatcher.js");
  } catch {
    // app-builder-lib is only present where packaging is possible.
    return;
  }
  const pkg = require("../package.json");
  const appDir = path.sep === "\\" ? "C:\\app" : "/app";
  // Mirrors getNodeModuleFileMatcher: keep only the negations, then prepend **/*.
  const matcher = new fileMatcher.FileMatcher(appDir, path.join(appDir, "out"), (value) => value);
  for (const pattern of pkg.build.files) {
    if (typeof pattern === "string" && pattern.startsWith("!")) matcher.addPattern(pattern);
  }
  assert.ok(!matcher.isEmpty(), "build.files must carry the exclusion patterns");
  matcher.prependPattern("**/*");
  const filter = matcher.createFilter();
  const ships = (relativePath) =>
    filter(path.join(appDir, relativePath), { isDirectory: () => false, isFile: () => true });

  for (const packageName of runtimeFetchedToolPackageNames) {
    assert.equal(
      ships(path.join("node_modules", ...packageName.split("/"), "package.json")),
      false,
      `${packageName} must be excluded by build.files`,
    );
  }
  for (const relativePath of [
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "node_modules/@openai/codex/bin/codex.js",
    "node_modules/opencode-ai/package.json",
    "node_modules/@opencode-ai/sdk/index.js",
    "node_modules/@cursor/sdk-darwin-arm64/bin/rg",
    "node_modules/cpu-features/build/Release/cpufeatures.node",
    "node_modules/node-pty/lib/index.js",
  ]) {
    assert.equal(ships(relativePath), true, `${relativePath} must keep shipping`);
  }
});
