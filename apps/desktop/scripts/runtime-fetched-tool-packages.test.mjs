import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { RUNTIME_FETCHED_TOOL_PACKAGES } from "../../ade-cli/scripts/native-deps-entry-filter.mjs";
import {
  matchesRuntimeFetchedToolPackage,
  runtimeFetchedToolPackageFilesExclusion,
  runtimeFetchedToolPackageNames,
} from "./runtime-fetched-tool-packages.mjs";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const asarUnpack = pkg.build?.asarUnpack ?? [];
const buildFiles = pkg.build?.files ?? [];

// The JS entry points ADE loads in-process or spawns as launchers. Breaking any
// of these breaks the product outright, which is a far worse failure than the
// bloat this whole exclusion exists to prevent - so they get their own gate.
const REQUIRED_SHIPPING_PACKAGES = [
  "@anthropic-ai/claude-agent-sdk",
  "@openai/codex",
  "opencode-ai",
  "@cursor/sdk",
  "node-pty",
];

test("the desktop exclusion list is the brain runtime archive list, not a copy", () => {
  assert.deepEqual(runtimeFetchedToolPackageNames, [...RUNTIME_FETCHED_TOOL_PACKAGES].sort());
  assert.equal(runtimeFetchedToolPackageNames.length, 26);
});

test("no runtime-fetched tool package is unpacked from the asar", () => {
  const offenders = asarUnpack.filter((pattern) => matchesRuntimeFetchedToolPackage(pattern));
  assert.deepEqual(offenders, []);
});

// Dropping a package from asarUnpack alone moves it *into* app.asar rather than
// out of the package: electron-builder copies every production dependency, and
// only a negated build.files pattern is applied to the node_modules walk.
test("every runtime-fetched tool package is excluded from build.files", () => {
  const missing = runtimeFetchedToolPackageNames
    .map(runtimeFetchedToolPackageFilesExclusion)
    .filter((pattern) => !buildFiles.includes(pattern));
  assert.deepEqual(missing, []);
});

test("the JS SDKs and launchers still ship", () => {
  for (const packageName of REQUIRED_SHIPPING_PACKAGES) {
    assert.ok(
      asarUnpack.some((pattern) => pattern.startsWith(`node_modules/${packageName}/`)),
      `${packageName} must stay in build.asarUnpack`,
    );
    assert.ok(
      !buildFiles.some((pattern) => pattern.replace(/^!/, "") === `node_modules/${packageName}/**`),
      `${packageName} must not be excluded from build.files`,
    );
    assert.ok(
      pkg.dependencies?.[packageName],
      `${packageName} must stay a dependency; the resolvers fall back to it in a source checkout`,
    );
  }
});

// A prefix match on "@anthropic-ai/claude-agent-sdk" would swallow the SDK that
// ADE calls query() on, and a prefix match on "opencode-" would swallow the
// opencode-ai launcher. Both are exact-name misses by construction.
test("matchesRuntimeFetchedToolPackage does not swallow the JS entry points", () => {
  assert.equal(matchesRuntimeFetchedToolPackage("node_modules/@anthropic-ai/claude-agent-sdk/**"), false);
  assert.equal(matchesRuntimeFetchedToolPackage("node_modules/@openai/codex/**"), false);
  assert.equal(matchesRuntimeFetchedToolPackage("node_modules/opencode-ai/**"), false);
  assert.equal(matchesRuntimeFetchedToolPackage("node_modules/@opencode-ai/sdk/**"), false);
  assert.equal(matchesRuntimeFetchedToolPackage("node_modules/@cursor/sdk-darwin-arm64/**"), false);

  assert.equal(matchesRuntimeFetchedToolPackage("node_modules/@openai/codex-darwin-arm64/**"), true);
  assert.equal(matchesRuntimeFetchedToolPackage("!node_modules/opencode-windows-x64-baseline/**"), true);
  assert.equal(
    matchesRuntimeFetchedToolPackage("node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/**"),
    true,
  );
});
