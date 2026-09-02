import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXCEPTION_FILE_NAME,
  META_PACKAGE_NAME,
  NPM_PACK_MAX_BUFFER_BYTES,
  RUNTIME_TARGETS,
  buildMetaPackage,
  buildRuntimePackage,
  metaPackageManifest,
  parseArgs,
  readLicenseFiles,
  runtimeAssetNames,
  runtimePackageManifest,
  runtimePackageName,
  verifyPackedMetaFiles,
  verifyPackedRuntimeFiles,
} from "./build-runtime-npm-packages.mjs";

/**
 * The cr-sqlite extension that target's loader can `dlopen`.
 *
 * The name is part of the contract, not decoration: a Windows package carrying
 * a Linux `.so` under its own target directory installs and then dies at
 * dlopen, and every other check in `verifyPackedRuntimeFiles` passes it.
 */
function crsqliteName(target) {
  if (target.startsWith("win32-")) return "crsqlite.dll";
  if (target.startsWith("darwin-")) return "crsqlite.dylib";
  return "crsqlite.so";
}

/**
 * A tiny stand-in for `ade-<target>.native.tar.gz`: a `node_modules` tree with
 * one file. The layout is what the packaging must reproduce; the contents are
 * not.
 */
function writeFakeArtifacts(dir, target) {
  const { binaryAsset, archiveAsset } = runtimeAssetNames(target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, binaryAsset), "#!/bin/sh\necho ade\n", { mode: 0o644 });

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ade-native-staging-"));
  try {
    fs.mkdirSync(path.join(staging, "node_modules", "better-sqlite3"), { recursive: true });
    fs.writeFileSync(
      path.join(staging, "node_modules", "better-sqlite3", "index.js"),
      "module.exports = {};\n",
    );
    fs.mkdirSync(path.join(staging, "vendor", "crsqlite", target), { recursive: true });
    fs.writeFileSync(path.join(staging, "vendor", "crsqlite", target, crsqliteName(target)), "binary");
    execFileSync("tar", ["-czf", path.join(dir, archiveAsset), "-C", staging, "."], {
      windowsHide: true,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function withTempDirs(run) {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "ade-artifacts-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ade-runtime-packages-"));
  try {
    return run({ artifacts, out });
  } finally {
    fs.rmSync(artifacts, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test("builds the documented platform-package layout", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const packageDir = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "LICENSE TEXT",
      exception: "EXCEPTION TEXT",
    });

    assert.equal(path.basename(packageDir), "runtime-linux-x64");
    for (const relative of [
      "package.json",
      "bin/ade",
      "native/node_modules/better-sqlite3/index.js",
      "native/vendor/crsqlite/linux-x64/crsqlite.so",
      "LICENSE",
      "RUNTIME-EMBEDDING-EXCEPTION.md",
      "README.md",
    ]) {
      assert.ok(
        fs.existsSync(path.join(packageDir, ...relative.split("/"))),
        `expected ${relative} in the package`,
      );
    }
    assert.equal(fs.readFileSync(path.join(packageDir, "LICENSE"), "utf8"), "LICENSE TEXT");
  });
});

test("sets the executable bit on the runtime binary", () => {
  // npm preserves only this bit, and only when the packed file carries it. A
  // runtime that arrives mode 0644 fails at spawn with EACCES.
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "darwin-arm64");
    const packageDir = buildRuntimePackage({
      target: "darwin-arm64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    const mode = fs.statSync(path.join(packageDir, "bin", "ade")).mode & 0o777;
    assert.equal(mode & 0o111, 0o111, `expected an executable binary, got mode ${mode.toString(8)}`);
  });
});

test("npm pack dry-run buffer is large enough for a real native tree", () => {
  assert.ok(NPM_PACK_MAX_BUFFER_BYTES >= 50 * 1024 * 1024);
  const source = fs.readFileSync(new URL("./build-runtime-npm-packages.mjs", import.meta.url), "utf8");
  assert.match(source, /maxBuffer:\s*NPM_PACK_MAX_BUFFER_BYTES/);
});

test("Windows native archive is ade-win32-x64.native.tar.gz, not glued onto .exe", () => {
  assert.deepEqual(runtimeAssetNames("win32-x64"), {
    binaryAsset: "ade-win32-x64.exe",
    archiveAsset: "ade-win32-x64.native.tar.gz",
  });
  assert.deepEqual(runtimeAssetNames("linux-x64"), {
    binaryAsset: "ade-linux-x64",
    archiveAsset: "ade-linux-x64.native.tar.gz",
  });
});

test("publish workflow checksum step uses runtimeAssetNames", () => {
  const workflow = fs.readFileSync(
    new URL("../../../.github/workflows/publish-runtime-packages.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /runtimeAssetNames/);
  assert.doesNotMatch(workflow, /ade-win32-x64\\.exe\(\\\.native\\.tar\\.gz\)\?/);
});

test("names the Windows binary ade.exe", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "win32-x64");
    const packageDir = buildRuntimePackage({
      target: "win32-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    assert.ok(fs.existsSync(path.join(packageDir, "bin", "ade.exe")));
    assert.ok(!fs.existsSync(path.join(packageDir, "bin", "ade")));
  });
});

test("refuses an archive that carries no node_modules", () => {
  withTempDirs(({ artifacts, out }) => {
    const { binaryAsset, archiveAsset } = runtimeAssetNames("linux-arm64");
    fs.writeFileSync(path.join(artifacts, binaryAsset), "x");
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ade-empty-native-"));
    fs.writeFileSync(path.join(staging, "readme.txt"), "no modules here");
    execFileSync("tar", ["-czf", path.join(artifacts, archiveAsset), "-C", staging, "."], {
      windowsHide: true,
    });
    fs.rmSync(staging, { recursive: true, force: true });

    assert.throws(
      () =>
        buildRuntimePackage({
          target: "linux-arm64",
          artifactsDir: artifacts,
          outDir: out,
          version: "1.2.3",
          license: "L",
          exception: "EXCEPTION TEXT",
        }),
      /node_modules/,
    );
  });
});

/**
 * The same fake archive, plus a dependency that ships a `.gitignore` matching
 * its own prebuilt module.
 *
 * This is the shape one dependency bump produces. npm-packlist honors a
 * `.gitignore` found inside a packed SUBDIRECTORY, so `crsqlite.node` is on
 * disk, listed by `files: ["native"]`, and still absent from the tarball.
 */
function writeArtifactsWithIgnoredNativeModule(dir, target) {
  const { binaryAsset, archiveAsset } = runtimeAssetNames(target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, binaryAsset), "#!/bin/sh\necho ade\n", { mode: 0o644 });

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ade-native-ignored-"));
  try {
    const pkg = path.join(staging, "node_modules", "x");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "index.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(pkg, ".gitignore"), "*.node\n");
    fs.writeFileSync(path.join(pkg, "crsqlite.node"), "ELF");
    execFileSync("tar", ["-czf", path.join(dir, archiveAsset), "-C", staging, "."], {
      windowsHide: true,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

test("fails the build when a dependency .gitignore drops a native module from the tarball", () => {
  withTempDirs(({ artifacts, out }) => {
    writeArtifactsWithIgnoredNativeModule(artifacts, "linux-x64");
    assert.throws(
      () =>
        buildRuntimePackage({
          target: "linux-x64",
          artifactsDir: artifacts,
          outDir: out,
          version: "1.2.3",
          license: "L",
          exception: "EXCEPTION TEXT",
        }),
      (error) => {
        assert.match(error.message, /native\/node_modules\/x\/crsqlite\.node/);
        assert.match(error.message, /npm-packlist honors \.gitignore/);
        return true;
      },
    );
    // The file really is on disk: the build wrote it and only the tarball
    // listing disagrees, which is the whole reason the check is needed.
    assert.ok(
      fs.existsSync(path.join(out, "runtime-linux-x64", "native", "node_modules", "x", "crsqlite.node")),
    );
  });
});

/**
 * The archive the empty/truncated-release case produces: a `node_modules`
 * directory and nothing inside it.
 *
 * `buildRuntimePackage`'s own guard only asserts the DIRECTORY exists, which an
 * empty one satisfies, and the parity check derives its expectation from disk,
 * so an empty tree expects nothing and trivially passes. This archive is the
 * shape that used to publish.
 */
function writeArtifactsWithEmptyNodeModules(dir, target) {
  const { binaryAsset, archiveAsset } = runtimeAssetNames(target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, binaryAsset), "#!/bin/sh\necho ade\n", { mode: 0o644 });

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ade-native-empty-"));
  try {
    fs.mkdirSync(path.join(staging, "node_modules"), { recursive: true });
    execFileSync("tar", ["-czf", path.join(dir, archiveAsset), "-C", staging, "."], {
      windowsHide: true,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

test("fails the build when the native archive carries an empty node_modules", () => {
  withTempDirs(({ artifacts, out }) => {
    writeArtifactsWithEmptyNodeModules(artifacts, "linux-x64");
    assert.throws(
      () =>
        buildRuntimePackage({
          target: "linux-x64",
          artifactsDir: artifacts,
          outDir: out,
          version: "1.2.3",
          license: "L",
          exception: "EXCEPTION TEXT",
        }),
      (error) => {
        assert.match(error.message, /no native\/node_modules\/\*\* entry/);
        assert.match(error.message, /resolves its dependency tree out of that directory/);
        return true;
      },
    );
    // The directory guard in buildRuntimePackage passed: an empty node_modules
    // satisfies it, which is why the packed-listing check is the one that
    // catches this.
    assert.ok(
      fs.existsSync(path.join(out, "runtime-linux-x64", "native", "node_modules")),
    );
  });
});

/**
 * A `runPack` stub that reports exactly the files given, in npm's own shape.
 *
 * Used where the interesting case is what the TARBALL carries rather than what
 * the build wrote, which is the distinction the presence checks exist for.
 */
function packedListing(files) {
  return () => JSON.stringify([{ files: files.map((file) => ({ path: file })) }]);
}

test("fails the build when the packed tarball carries no launcher", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const packageDir = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    // Removed from disk as well, so the parity check has nothing to say and the
    // presence check is what answers. A build step that failed to copy the
    // binary leaves exactly this.
    fs.rmSync(path.join(packageDir, "bin", "ade"));
    assert.throws(
      () =>
        verifyPackedRuntimeFiles({
          packageDir,
          runPack: packedListing([
            "package.json",
            "LICENSE",
            "RUNTIME-EMBEDDING-EXCEPTION.md",
            "README.md",
            "native/node_modules/better-sqlite3/index.js",
            "native/vendor/crsqlite/linux-x64/crsqlite.so",
          ]),
        }),
      /carries no bin\/ade\. That is the launcher/,
    );
  });
});

test("fails the build when the packed tarball carries no cr-sqlite extension", () => {
  // cr-sqlite does not live under native/node_modules — package-native-deps
  // writes it to native/vendor/crsqlite/<target>/. An archive carrying
  // node_modules but no vendor/ satisfied every other check: the parity check
  // is `onDisk ⊆ packed`, and a file on neither side is invisible to it.
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const packageDir = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    fs.rmSync(path.join(packageDir, "native", "vendor"), { recursive: true, force: true });
    assert.throws(
      () =>
        verifyPackedRuntimeFiles({
          packageDir,
          runPack: packedListing([
            "package.json",
            "LICENSE",
            "RUNTIME-EMBEDDING-EXCEPTION.md",
            "README.md",
            "bin/ade",
            "native/node_modules/better-sqlite3/index.js",
          ]),
        }),
      /carries no native\/vendor\/crsqlite\/linux-x64\/crsqlite\.so/,
    );
  });
});

test("accepts the cr-sqlite extension at the exact path its target implies", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const packageDir = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    // No throw: the real layout passes.
    verifyPackedRuntimeFiles({
      packageDir,
      runPack: packedListing([
        "package.json",
        "LICENSE",
        "RUNTIME-EMBEDDING-EXCEPTION.md",
        "README.md",
        "bin/ade",
        "native/node_modules/better-sqlite3/index.js",
        "native/vendor/crsqlite/linux-x64/crsqlite.so",
      ]),
    });
  });
});

test("refuses another platform's cr-sqlite extension in a target's own directory", () => {
  // The release assembly mislabels one native archive and the Windows package
  // ships a Linux `.so`. Parity is `onDisk ⊆ packed`, node_modules is
  // non-empty, and `bin/ade.exe` comes from the separate binary asset, so this
  // assertion is the only one left that can catch it.
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "win32-x64");
    const packageDir = buildRuntimePackage({
      target: "win32-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
      hostPlatform: "win32",
    });
    // The mislabelled archive extracted a Linux `.so` into the Windows
    // package's own vendor directory, so disk and listing agree and the parity
    // check has nothing to say.
    const vendorDir = path.join(packageDir, "native", "vendor", "crsqlite", "win32-x64");
    fs.renameSync(path.join(vendorDir, "crsqlite.dll"), path.join(vendorDir, "crsqlite.so"));
    assert.throws(
      () =>
        verifyPackedRuntimeFiles({
          packageDir,
          runPack: packedListing([
            "package.json",
            "LICENSE",
            "RUNTIME-EMBEDDING-EXCEPTION.md",
            "README.md",
            "bin/ade.exe",
            "native/node_modules/better-sqlite3/index.js",
            "native/vendor/crsqlite/win32-x64/crsqlite.so",
          ]),
        }),
      /carries no native\/vendor\/crsqlite\/win32-x64\/crsqlite\.dll/,
    );
  });
});

test("refuses a package directory whose name is not a runtime target", () => {
  // `verify-runtime-package-contents.mjs` takes directories from argv, so a
  // renamed or hand-made copy reaches here. Falling back to the POSIX launcher
  // verified the wrong contract in silence.
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const packageDir = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    const renamed = path.join(out, "runtime-linux-x65");
    fs.renameSync(packageDir, renamed);
    assert.throws(
      () => verifyPackedRuntimeFiles({ packageDir: renamed, runPack: packedListing([]) }),
      /is not one of the runtime targets/,
    );
  });
});

test("requires the launcher name the target implies, not either one", () => {
  // A runtime-win32-x64 package carrying only `bin/ade` used to pass, and it
  // installs a runtime Windows cannot spawn.
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "win32-x64");
    const packageDir = buildRuntimePackage({
      target: "win32-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
      hostPlatform: "win32",
    });
    // Removed from disk too, so the parity check has nothing to say and the
    // presence check is what answers.
    fs.rmSync(path.join(packageDir, "bin", "ade.exe"));
    const listing = [
      "package.json",
      "LICENSE",
      "RUNTIME-EMBEDDING-EXCEPTION.md",
      "README.md",
      "native/node_modules/better-sqlite3/index.js",
      "native/vendor/crsqlite/win32-x64/crsqlite.dll",
    ];
    assert.throws(
      () => verifyPackedRuntimeFiles({ packageDir, runPack: packedListing([...listing, "bin/ade"]) }),
      /carries no bin\/ade\.exe/,
    );
    // The right name passes.
    verifyPackedRuntimeFiles({ packageDir, runPack: packedListing([...listing, "bin/ade.exe"]) });
  });
});

test("refuses to build a POSIX target on a Windows host", () => {
  // npm records no execute bit from a Windows pack, so the published bin/ade
  // would arrive mode 0644 and fail at spawn with EACCES. Nothing downstream
  // catches that: the file is present and the parity check passes.
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    assert.throws(
      () =>
        buildRuntimePackage({
          target: "linux-x64",
          artifactsDir: artifacts,
          outDir: out,
          version: "1.2.3",
          license: "L",
          exception: "EXCEPTION TEXT",
          hostPlatform: "win32",
        }),
      /Refusing to build runtime-linux-x64 on a Windows host/,
    );
  });
});

test("allows the win32 package to be built on a Windows host", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "win32-x64");
    const dir = buildRuntimePackage({
      target: "win32-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
      hostPlatform: "win32",
    });
    assert.ok(fs.existsSync(path.join(dir, "bin", "ade.exe")));
  });
});

test("gives the launcher an execute bit on a POSIX host", () => {
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
    assert.ok((fs.statSync(path.join(dir, "bin", "ade")).mode & 0o111) !== 0);
  });
});

test("fails the meta package when its packed tarball drops LICENSE", () => {
  // The meta package was the one package nothing pack-verified: it carries no
  // bin/ or native/, and the workflow's verify loop globs `runtime-*/`, which
  // does not match `runtime/`.
  withTempDirs(({ out }) => {
    assert.throws(
      () =>
        buildMetaPackage({
          outDir: out,
          version: "1.2.3",
          targets: RUNTIME_TARGETS.map((entry) => entry.target),
          license: "L",
          exception: "EXCEPTION TEXT",
          runPack: packedListing(["package.json", "README.md"]),
        }),
      /missing LICENSE/,
    );
  });
});

test("names LICENSE and the embedding exception in the meta package's own files list", () => {
  const manifest = metaPackageManifest({ version: "1.2.3" });
  assert.ok(manifest.files.includes("LICENSE"));
  assert.ok(manifest.files.includes(EXCEPTION_FILE_NAME));
  assert.ok(manifest.files.includes("README.md"));
  const packed = verifyPackedMetaFiles({
    packageDir: "/tmp/does-not-matter",
    runPack: packedListing(["package.json", "README.md", "LICENSE", EXCEPTION_FILE_NAME]),
  });
  assert.deepEqual(packed.sort(), ["LICENSE", "README.md", EXCEPTION_FILE_NAME, "package.json"]);
});

test("fails the meta package when its packed tarball drops the embedding exception", () => {
  // The AGPL text alone tells an embedder they may not ship the runtime. The
  // exception is the permission the package exists to deliver, and the root
  // copy does not travel in an npm tarball.
  withTempDirs(({ out }) => {
    assert.throws(
      () =>
        buildMetaPackage({
          outDir: out,
          version: "1.2.3",
          targets: RUNTIME_TARGETS.map((entry) => entry.target),
          license: "L",
          exception: "EXCEPTION TEXT",
          runPack: packedListing(["package.json", "README.md", "LICENSE"]),
        }),
      /missing RUNTIME-EMBEDDING-EXCEPTION\.md/,
    );
  });
});

test("fails the build when the packed tarball drops LICENSE, the exception, or README", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const packageDir = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    // LICENSE, the exception and README are on disk but are NOT in the parity
    // set, which covers bin/ and native/ only — so nothing else would catch
    // their loss.
    const runtimeFiles = [
      "bin/ade",
      "native/node_modules/better-sqlite3/index.js",
      "native/vendor/crsqlite/linux-x64/crsqlite.so",
    ];
    assert.throws(
      () =>
        verifyPackedRuntimeFiles({
          packageDir,
          runPack: packedListing([...runtimeFiles, "package.json", "README.md", EXCEPTION_FILE_NAME]),
        }),
      /missing LICENSE/,
    );
    assert.throws(
      () =>
        verifyPackedRuntimeFiles({
          packageDir,
          runPack: packedListing([...runtimeFiles, "package.json", "README.md", "LICENSE"]),
        }),
      /missing RUNTIME-EMBEDDING-EXCEPTION\.md/,
    );
    assert.throws(
      () =>
        verifyPackedRuntimeFiles({
          packageDir,
          runPack: packedListing([...runtimeFiles, "package.json", "LICENSE", EXCEPTION_FILE_NAME]),
        }),
      /missing README\.md/,
    );
  });
});

test("writes both license documents into a platform package", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const packageDir = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "LICENSE TEXT",
      exception: "EXCEPTION TEXT",
    });
    assert.equal(fs.readFileSync(path.join(packageDir, "LICENSE"), "utf8"), "LICENSE TEXT");
    assert.equal(
      fs.readFileSync(path.join(packageDir, EXCEPTION_FILE_NAME), "utf8"),
      "EXCEPTION TEXT",
    );
    const readme = fs.readFileSync(path.join(packageDir, "README.md"), "utf8");
    assert.ok(readme.includes("AGPL-3.0-only with the ADE Runtime Embedding Exception"));
    assert.ok(readme.includes(EXCEPTION_FILE_NAME));
  });
});

test("writes both license documents into the meta package", () => {
  withTempDirs(({ out }) => {
    const dir = buildMetaPackage({
      outDir: out,
      version: "1.2.3",
      targets: RUNTIME_TARGETS.map((entry) => entry.target),
      license: "LICENSE TEXT",
      exception: "EXCEPTION TEXT",
      runPack: packedListing(["package.json", "README.md", "LICENSE", EXCEPTION_FILE_NAME]),
    });
    assert.equal(fs.readFileSync(path.join(dir, "LICENSE"), "utf8"), "LICENSE TEXT");
    assert.equal(fs.readFileSync(path.join(dir, EXCEPTION_FILE_NAME), "utf8"), "EXCEPTION TEXT");
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    assert.ok(readme.includes("AGPL-3.0-only with the ADE Runtime Embedding Exception"));
  });
});

test("refuses to build a package with no exception text", () => {
  // A caller that forgot the argument would otherwise write `undefined` into
  // the package, or throw about a bad argument type rather than about the
  // licensing file it dropped.
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    assert.throws(
      () =>
        buildRuntimePackage({
          target: "linux-x64",
          artifactsDir: artifacts,
          outDir: out,
          version: "1.2.3",
          license: "L",
        }),
      /no RUNTIME-EMBEDDING-EXCEPTION\.md text/,
    );
    assert.throws(
      () =>
        buildMetaPackage({
          outDir: out,
          version: "1.2.3",
          targets: RUNTIME_TARGETS.map((entry) => entry.target),
          license: "L",
        }),
      /no RUNTIME-EMBEDDING-EXCEPTION\.md text/,
    );
  });
});

test("readLicenseFiles returns the repository's own two license documents", () => {
  // The script writes what the repo root holds. A rename of either file must
  // fail here rather than publish a package missing one of them.
  const { license, exception } = readLicenseFiles();
  assert.ok(license.includes("GNU AFFERO GENERAL PUBLIC LICENSE"));
  assert.ok(exception.includes("ADE Runtime Embedding Exception"));
});

test("verifyPackedRuntimeFiles reports an unparseable npm pack output rather than passing", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "linux-x64");
    const packageDir = buildRuntimePackage({
      target: "linux-x64",
      artifactsDir: artifacts,
      outDir: out,
      version: "1.2.3",
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    assert.throws(
      () => verifyPackedRuntimeFiles({ packageDir, runPack: () => "npm ERR! nope\n" }),
      /could not parse/,
    );
  });
});

test("names the missing artifact rather than failing later", () => {
  withTempDirs(({ artifacts, out }) => {
    assert.throws(
      () =>
        buildRuntimePackage({
          target: "darwin-x64",
          artifactsDir: artifacts,
          outDir: out,
          version: "1.2.3",
          license: "L",
          exception: "EXCEPTION TEXT",
        }),
      /Missing runtime binary.*ade-darwin-x64/s,
    );
  });
});

test("declares os and cpu so npm installs exactly one package", () => {
  for (const entry of RUNTIME_TARGETS) {
    const manifest = runtimePackageManifest({ ...entry, version: "4.5.6" });
    assert.equal(manifest.name, runtimePackageName(entry.target));
    assert.equal(manifest.version, "4.5.6");
    assert.deepEqual(manifest.os, [entry.os]);
    assert.deepEqual(manifest.cpu, [entry.cpu]);
    assert.equal(manifest.license, "AGPL-3.0-only");
    assert.deepEqual(manifest.files, ["bin", "native", "LICENSE", EXCEPTION_FILE_NAME, "README.md"]);
    // An exports map would gate `require.resolve("<name>/package.json")`, which
    // is exactly how the SDK finds the package.
    assert.equal(manifest.exports, undefined);
    assert.ok(manifest.repository.url.includes("arul28/ADE"));
  }
});

test("pins every optional dependency of the meta package to the same version", () => {
  const targets = RUNTIME_TARGETS.map((entry) => entry.target);
  const manifest = metaPackageManifest({ version: "4.5.6" });
  assert.equal(manifest.name, META_PACKAGE_NAME);
  assert.deepEqual(Object.keys(manifest.optionalDependencies).sort(), targets.map(runtimePackageName).sort());
  for (const version of Object.values(manifest.optionalDependencies)) {
    assert.equal(version, "4.5.6");
  }
});

test("names all five platform packages even when one target was built", () => {
  // A Windows maintainer can only run `--targets win32-x64`, because building a
  // POSIX package on a Windows host is refused. A meta package naming one
  // platform resolves NO runtime on macOS and Linux: npm skips an optional
  // dependency that does not match rather than failing, so the install is
  // silent and `resolveBundledRuntime()` finds nothing.
  const manifest = metaPackageManifest({ version: "7.8.9" });
  assert.deepEqual(
    Object.keys(manifest.optionalDependencies).sort(),
    RUNTIME_TARGETS.map((entry) => runtimePackageName(entry.target)).sort(),
  );
});

test("the Windows-host refusal says how to build only the Windows package", () => {
  withTempDirs(({ artifacts, out }) => {
    writeFakeArtifacts(artifacts, "darwin-arm64");
    assert.throws(
      () =>
        buildRuntimePackage({
          target: "darwin-arm64",
          artifactsDir: artifacts,
          outDir: out,
          version: "1.2.3",
          license: "L",
          exception: "EXCEPTION TEXT",
          hostPlatform: "win32",
        }),
      /--targets win32-x64/,
    );
  });
});

test("writes the meta package with a README naming every platform package", () => {
  withTempDirs(({ out }) => {
    const dir = buildMetaPackage({
      outDir: out,
      version: "1.2.3",
      targets: RUNTIME_TARGETS.map((entry) => entry.target),
      license: "L",
      exception: "EXCEPTION TEXT",
    });
    assert.equal(path.basename(dir), "runtime");
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    for (const entry of RUNTIME_TARGETS) {
      assert.ok(readme.includes(runtimePackageName(entry.target)), entry.target);
    }
  });
});

test("refuses the meta package when the run did not build every target", () => {
  // The manifest names all five. A Windows maintainer can only run
  // `--targets win32-x64`, and the other four optional dependencies would not
  // exist at that version: npm skips one it cannot resolve as silently as one
  // that does not match, so `npm install @ade-dev/runtime` succeeds and
  // installs no runtime at all on macOS and Linux.
  withTempDirs(({ out }) => {
    assert.throws(
      () =>
        buildMetaPackage({
          outDir: out,
          version: "1.2.3",
          targets: ["win32-x64"],
          license: "L",
          exception: "EXCEPTION TEXT",
          runPack: packedListing(["package.json", "README.md", "LICENSE", "RUNTIME-EMBEDDING-EXCEPTION.md"]),
        }),
      /does not cover darwin-arm64, darwin-x64, linux-x64, linux-arm64/,
    );
    assert.equal(fs.existsSync(path.join(out, "runtime", "package.json")), false);
  });
});

test("builds the meta package when the run covers every target", () => {
  withTempDirs(({ out }) => {
    const dir = buildMetaPackage({
      outDir: out,
      version: "1.2.3",
      targets: RUNTIME_TARGETS.map((entry) => entry.target),
      license: "L",
      exception: "EXCEPTION TEXT",
      runPack: packedListing(["package.json", "README.md", "LICENSE", "RUNTIME-EMBEDDING-EXCEPTION.md"]),
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.deepEqual(
      Object.keys(manifest.optionalDependencies).sort(),
      RUNTIME_TARGETS.map((entry) => runtimePackageName(entry.target)).sort(),
    );
  });
});

test("parseArgs requires the three inputs and validates them", () => {
  const parsed = parseArgs([
    "--artifacts-dir",
    "/a",
    "--version",
    "1.2.3",
    "--out-dir",
    "/o",
  ]);
  assert.equal(parsed.version, "1.2.3");
  assert.deepEqual(parsed.targets, RUNTIME_TARGETS.map((entry) => entry.target));

  assert.throws(() => parseArgs(["--version", "1.2.3", "--out-dir", "/o"]), /--artifacts-dir/);
  assert.throws(
    () => parseArgs(["--artifacts-dir", "/a", "--version", "v1.2.3", "--out-dir", "/o"]),
    /semantic version/,
  );
  assert.throws(
    () => parseArgs(["--artifacts-dir", "/a", "--version", "1.2.3", "--out-dir", "/o", "--targets", "aix-ppc"]),
    /Unknown target/,
  );
});

test("accepts only the five targets the release matrix builds", () => {
  assert.deepEqual(
    RUNTIME_TARGETS.map((entry) => entry.target),
    ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"],
  );
});
