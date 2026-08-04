import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { nodePtyPrebuildTarget, shouldCopyPackageEntry } from "./native-deps-entry-filter.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(packageRoot, "package.json");
const lockfilePath = path.join(packageRoot, "package-lock.json");

function keeps(packageName, sourceRoot, relative, target) {
  return shouldCopyPackageEntry(packageName, sourceRoot, path.join(sourceRoot, relative), target);
}

// sql.js is a devDependency with no production consumer -- nothing under
// apps/ade-cli/src or the non-test apps/desktop code imports it, and both apps
// read SQLite through node:sqlite. The archive must never carry it, including
// the package directory entry itself: keeping that would leave an empty
// node_modules/sql.js in the runtime tree.
test("sql.js is excluded from the runtime archive in its entirety", () => {
  const root = "/pkg/sql.js";
  for (const relative of [
    "dist/sql-wasm.js",
    "dist/sql-wasm.wasm",
    "dist/sql-asm-debug.js",
    "dist/worker.sql-asm-debug.js",
    "dist",
    "package.json",
    "README.md",
  ]) {
    assert.equal(keeps("sql.js", root, relative, "darwin-arm64"), false, relative);
  }
  assert.equal(shouldCopyPackageEntry("sql.js", root, root, "darwin-arm64"), false);
});

test("the sql.js exclusion is scoped to sql.js", () => {
  assert.equal(keeps("other-pkg", "/pkg/other", "dist/sql-wasm.js", "darwin-arm64"), true);
  assert.equal(keeps("other-pkg", "/pkg/other", "dist/thing-debug.js", "darwin-arm64"), true);
});

test("node-pty keeps only its own prebuild subtree, directory entries included", () => {
  const root = "/pkg/node-pty";
  assert.equal(keeps("node-pty", root, "prebuilds", "darwin-arm64"), true);
  assert.equal(keeps("node-pty", root, "prebuilds/darwin-arm64", "darwin-arm64"), true);
  assert.equal(keeps("node-pty", root, "prebuilds/darwin-arm64/pty.node", "darwin-arm64"), true);
  assert.equal(keeps("node-pty", root, "prebuilds/win32-x64", "darwin-arm64"), false);
  assert.equal(nodePtyPrebuildTarget("win32-x64"), "win32-x64");
});

test("the OpenCode Windows shim stays out of non-Windows archives", () => {
  assert.equal(keeps("opencode-ai", "/pkg/opencode-ai", "bin/opencode.exe", "linux-x64"), false);
  assert.equal(keeps("opencode-ai", "/pkg/opencode-ai", "bin/opencode.exe", "win32-x64"), true);
});

// Codex, Claude and OpenCode are fetched at runtime into the pinned tools cache,
// so their native platform packages must not also ride along in the archive.
// The package directory entry itself has to be rejected too, exactly as with
// sql.js, or fs.cp walks into the tree and ships the binary anyway.
test("the runtime-fetched agent CLI platform packages are excluded in their entirety", () => {
  const platformPackages = [
    "@openai/codex-darwin-arm64",
    "@openai/codex-darwin-x64",
    "@openai/codex-linux-arm64",
    "@openai/codex-linux-x64",
    "@openai/codex-win32-arm64",
    "@openai/codex-win32-x64",
    "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    "@anthropic-ai/claude-agent-sdk-darwin-x64",
    "@anthropic-ai/claude-agent-sdk-linux-arm64",
    "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
    "@anthropic-ai/claude-agent-sdk-linux-x64",
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
    "@anthropic-ai/claude-agent-sdk-win32-arm64",
    "@anthropic-ai/claude-agent-sdk-win32-x64",
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
  for (const packageName of platformPackages) {
    const root = `/pkg/${packageName}`;
    for (const relative of ["bin/codex", "bin/opencode", "package.json", "bin"]) {
      assert.equal(keeps(packageName, root, relative, "darwin-arm64"), false, `${packageName}/${relative}`);
    }
    assert.equal(shouldCopyPackageEntry(packageName, root, root, "darwin-arm64"), false, packageName);
  }
});

// The JS launchers are what ADE actually loads: it calls query() on the Claude
// agent SDK in-process, and the other three are the thin entry points that
// resolve the fetched binary. A prefix match on the platform names would take
// @anthropic-ai/claude-agent-sdk with them and break the product.
test("the JS launcher and SDK packages still ship", () => {
  for (const packageName of [
    "@anthropic-ai/claude-agent-sdk",
    "@openai/codex",
    "opencode-ai",
    "@opencode-ai/sdk",
  ]) {
    const root = `/pkg/${packageName}`;
    assert.equal(keeps(packageName, root, "package.json", "darwin-arm64"), true, packageName);
    assert.equal(keeps(packageName, root, "dist/index.js", "darwin-arm64"), true, packageName);
    assert.equal(shouldCopyPackageEntry(packageName, root, root, "darwin-arm64"), true, packageName);
  }
});

// No target ships these -- the cache is fetched per machine, so a Windows or
// Linux archive has no more reason to carry them than a macOS one.
test("the agent CLI exclusion is target-independent", () => {
  for (const target of ["darwin-arm64", "linux-x64", "win32-x64"]) {
    assert.equal(keeps("@openai/codex-win32-x64", "/pkg/@openai/codex-win32-x64", "bin/codex.exe", target), false, target);
    assert.equal(
      keeps("@anthropic-ai/claude-agent-sdk-linux-x64", "/pkg/claude-linux-x64", "claude", target),
      false,
      target,
    );
    assert.equal(keeps("opencode-windows-x64", "/pkg/opencode-windows-x64", "bin/opencode.exe", target), false, target);
    assert.equal(keeps("@anthropic-ai/claude-agent-sdk", "/pkg/claude-agent-sdk", "sdk.mjs", target), true, target);
  }
});

// An exact-name set is only safe while it stays complete: when one of the three
// CLIs adds a platform (a new -musl or -baseline variant is the usual way this
// happens), the lockfile gains it silently and the archive would start shipping
// it again. Derive the expectation from the lockfile so that drift fails here
// rather than as an unexplained few-hundred-MB jump in artifact size.
test("every agent CLI platform package in the lockfile is excluded", async () => {
  const lockfile = JSON.parse(await fs.readFile(lockfilePath, "utf8"));
  const platformPattern =
    /^(?:@openai\/codex-(?:darwin|linux|win32)-|@anthropic-ai\/claude-agent-sdk-(?:darwin|linux|win32)-|opencode-(?:darwin|linux|windows)-)/;
  const found = new Set();
  for (const entry of Object.keys(lockfile.packages ?? {})) {
    const name = entry.replace(/^.*node_modules\//, "");
    if (platformPattern.test(name)) found.add(name);
  }

  assert.ok(found.size >= 23, `expected the lockfile to still carry the platform packages, saw ${found.size}`);
  for (const packageName of found) {
    const root = `/pkg/${packageName}`;
    assert.equal(shouldCopyPackageEntry(packageName, root, root, "darwin-arm64"), false, packageName);
  }
});

// The entry filter is the second line of defence. The first is the dependency
// walk in package-native-deps.mjs, which only follows `dependencies`, so sql.js
// must stay out of this package's runtime dependency set as well.
test("sql.js is not a runtime dependency of the CLI", async () => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(Object.hasOwn(manifest.dependencies ?? {}, "sql.js"), false);
});
