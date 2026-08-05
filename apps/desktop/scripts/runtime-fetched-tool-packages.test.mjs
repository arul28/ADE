import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { RUNTIME_FETCHED_TOOL_PACKAGES } from "../../ade-cli/scripts/native-deps-entry-filter.mjs";
import {
  matchesRuntimeFetchedToolPackage,
  runtimeFetchedToolPackageFilesExclusion,
  runtimeFetchedToolPackageGrepPattern,
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

// The forward assertion above proves every canonical package has a negation.
// This is the reverse: every negation must trace back to the canonical list.
// Without it, a hand-added `!node_modules/...` line can quietly drop a package
// the app actually needs at runtime, and no test would notice until something
// failed to spawn in a packaged build.
//
// Nothing is exempt today -- all 26 negations are tool packages, verified by
// reading build.files. A genuinely non-tool exclusion goes here as
// `"!node_modules/foo/**", // why` -- one entry, one reason. That is the whole
// point of the allowlist: it forces the justification to be written down next
// to the exemption instead of living in a commit message nobody will find.
//
// (`build.files` stays a JSON array by deliberate choice -- migrating it to a
// generated JS config was declined -- so this test is the guardrail that keeps
// the array and the canonical list from drifting apart.)
const NON_TOOL_FILES_EXCLUSIONS = Object.freeze([]);

test("every build.files negation traces back to the canonical list", () => {
  const negations = buildFiles.filter(
    (pattern) => typeof pattern === "string" && pattern.startsWith("!"),
  );
  const unexplained = negations.filter(
    (pattern) =>
      !matchesRuntimeFetchedToolPackage(pattern)
      && !NON_TOOL_FILES_EXCLUSIONS.includes(pattern),
  );
  assert.deepEqual(
    unexplained,
    [],
    "apps/desktop/package.json build.files has a `!node_modules/...` negation that is not a "
    + "runtime-fetched tool package. A negation removes the package from the installer entirely, "
    + "so an unexplained one silently ships a broken app. Do exactly one of: (1) if the package is "
    + "fetched into the machine tools cache at runtime, add it to RUNTIME_FETCHED_TOOL_PACKAGES in "
    + "apps/ade-cli/scripts/native-deps-entry-filter.mjs -- that is the canonical list every other "
    + "gate derives from; (2) if it is excluded for some other reason, add the exact pattern string "
    + "to NON_TOOL_FILES_EXCLUSIONS in this file with a one-line comment saying why; (3) if neither "
    + "applies, delete the negation.",
  );
});

// An allowlist nobody prunes is an allowlist that eventually excuses something
// real. Every exemption must still be an exemption from something.
test("no NON_TOOL_FILES_EXCLUSIONS entry has outlived its negation", () => {
  const stale = NON_TOOL_FILES_EXCLUSIONS.filter((pattern) => !buildFiles.includes(pattern));
  assert.deepEqual(
    stale,
    [],
    "NON_TOOL_FILES_EXCLUSIONS names a pattern that is no longer in build.files; delete it.",
  );
});

// The release workflow greps a `tar -tzf` listing with this pattern to prove no
// platform package rode along in the brain runtime archive. It used to hardcode
// `opencode-`, so 25 of the 26 packages were unguarded.
test("the grep pattern matches every canonical package archive path", () => {
  const pattern = new RegExp(runtimeFetchedToolPackageGrepPattern());
  // The three entry shapes `tar -tzf` can emit for a leaked package: the
  // directory with its trailing slash, the directory without one (some tar
  // implementations omit it), and a file beneath it. The `(/|$)` tail exists for
  // the middle case, so it is the one worth pinning explicitly.
  for (const packageName of runtimeFetchedToolPackageNames) {
    for (const suffix of ["/", "", "/package.json"]) {
      assert.ok(
        pattern.test(`./node_modules/${packageName}${suffix}`),
        `${packageName} is not matched by the release archive gate as "./node_modules/${packageName}${suffix}"`,
      );
    }
  }
  assert.equal(runtimeFetchedToolPackageNames.length, 26);
});

test("the grep pattern spares the JS entry points that must ship", () => {
  const pattern = new RegExp(runtimeFetchedToolPackageGrepPattern());
  for (const packageName of REQUIRED_SHIPPING_PACKAGES) {
    assert.equal(
      pattern.test(`./node_modules/${packageName}/package.json`),
      false,
      `${packageName} must not trip the release archive gate`,
    );
  }
  // A bare name with no trailing slash must not match a longer sibling either.
  assert.equal(pattern.test("./node_modules/opencode-linux-x64-extra/x"), false);
});

// The release workflow captures this stdout straight into a shell variable under
// `set -e`, so both halves matter: the exact bytes on success, and a non-zero
// exit on a bad invocation rather than an empty pattern that matches everything.
const scriptPath = path.join(desktopRoot, "scripts", "runtime-fetched-tool-packages.mjs");

test("--grep-pattern prints the pattern and nothing else", () => {
  const stdout = execFileSync(process.execPath, [scriptPath, "--grep-pattern"], {
    encoding: "utf8",
  });
  assert.equal(stdout, `${runtimeFetchedToolPackageGrepPattern()}\n`);
});

test("running the script with no recognised flag fails loudly", () => {
  assert.throws(
    () => execFileSync(process.execPath, [scriptPath], { encoding: "utf8", stdio: "pipe" }),
    (error) => error.status === 2,
  );
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
