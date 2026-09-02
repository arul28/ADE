import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildRuntimePackage,
  runtimeAssetNames,
} from "./build-runtime-npm-packages.mjs";

/**
 * The wrapper's exit contract is what `publish-runtime-packages.yml` relies on
 * between build and publish, and nothing tested it. The script is run as a real
 * process because the contract IS the exit code.
 */
const script = fileURLToPath(new URL("./verify-runtime-package-contents.mjs", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

/** The cr-sqlite extension that target's loader can `dlopen`. */
function crsqliteName(target) {
  if (target.startsWith("win32-")) return "crsqlite.dll";
  if (target.startsWith("darwin-")) return "crsqlite.dylib";
  return "crsqlite.so";
}

/** The same tiny stand-in the build test uses: one native module, one extension. */
function writeFakeArtifacts(dir, target) {
  const { binaryAsset, archiveAsset } = runtimeAssetNames(target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, binaryAsset), "#!/bin/sh\necho ade\n", { mode: 0o644 });

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ade-verify-staging-"));
  try {
    fs.mkdirSync(path.join(staging, "node_modules", "better-sqlite3"), { recursive: true });
    fs.writeFileSync(path.join(staging, "node_modules", "better-sqlite3", "index.js"), "module.exports = {};\n");
    fs.mkdirSync(path.join(staging, "vendor", "crsqlite", target), { recursive: true });
    fs.writeFileSync(path.join(staging, "vendor", "crsqlite", target, crsqliteName(target)), "binary");
    fs.mkdirSync(path.join(staging, "tuiClient"), { recursive: true });
    fs.writeFileSync(
      path.join(staging, "tuiClient", "cli.mjs"),
      "export async function runAdeCodeCli() { return 0; }\n",
    );
    // `execFileSync`, not `spawnSync`: a missing or failing `tar` must throw
    // here. Discarding the result left an absent archive and failed the test
    // later with an unrelated message.
    execFileSync("tar", ["-czf", path.join(dir, archiveAsset), "-C", staging, "."], {
      windowsHide: true,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function withTempDirs(body) {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "ade-verify-artifacts-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ade-verify-out-"));
  try {
    return body({ artifacts, out });
  } finally {
    fs.rmSync(artifacts, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test("exits 2 with a usage line when given no directory", () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: verify-runtime-package-contents\.mjs/);
});

test("exits 0 for a package that packs everything", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const dir = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    const result = run([dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /files all packed/);
  });
});

test("exits 1 and annotates the failure when a package is missing its launcher", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const dir = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    fs.rmSync(path.join(dir, "bin", "ade"));
    const result = run([dir]);
    assert.equal(result.status, 1);
    // `::error::` is what makes the failure visible in the workflow log.
    assert.match(result.stderr, /::error::/);
    assert.match(result.stderr, /carries no bin\/ade/);
  });
});

test("checks every directory given and fails once for the whole run", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const good = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    const result = run([good, path.join(out, "runtime-linux-arm64")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::/);
    // The healthy package is still reported, so one bad directory does not hide
    // the state of the others.
    assert.match(result.stdout, /files all packed/);
  });
});

test("refuses a directory whose name is not a runtime target", () => {
  // This wrapper takes directories from argv, so a renamed or hand-made copy
  // reaches the check. Verifying it against the POSIX launcher would assert the
  // wrong contract in silence.
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const dir = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    const renamed = path.join(out, "runtime-copy");
    fs.renameSync(dir, renamed);
    const result = run([renamed]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not one of the runtime targets/);
  });
});
