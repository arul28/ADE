#!/usr/bin/env node
/**
 * Builds the `@ade-dev/runtime-*` npm platform packages from a set of released
 * runtime artifacts.
 *
 * WHY THESE EXIST. The SDK downloads its runtime from a GitHub release on first
 * run. For a signed, notarized, hardened-runtime application that is not
 * viable: the bundle is one signed artifact, and a Mach-O executable that
 * appears in `userData` afterwards is outside it. So the same bytes are also
 * published the way esbuild and swc publish theirs — one package per target,
 * each carrying `os` and `cpu`, listed as `optionalDependencies` of the
 * `@ade-dev/runtime` meta package so npm installs exactly one. The embedder
 * copies that directory into their bundle and signs it with their own identity.
 *
 * THE BINARIES IN THE PACKAGES ARE DELIBERATELY THE PUBLISHED ONES. On macOS
 * they carry ADE's Developer ID because that is what the release produced, and
 * an embedder RE-SIGNS them with their own identity as part of their own
 * bundle: a binary signed by ADE sitting inside another vendor's app invites a
 * Team ID mismatch and forces `disable-library-validation` on the host. See
 * `sdk/bundling.mdx` for the exact `codesign` lines.
 *
 * Usage:
 *   node apps/ade-cli/scripts/build-runtime-npm-packages.mjs \
 *     --artifacts-dir <dir> --version <x.y.z> --out-dir <dir> [--targets a,b]
 *
 * `--artifacts-dir` is the flat directory `release-publish.yml` assembles:
 * `ade-<target>[.exe]` and `ade-<target>.native.tar.gz` for every target.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The npm invocation shape that works on Windows and the `--json` extraction
// rule, both shared with the sibling license checker rather than re-derived
// here. See `defaultPackRunner`. That module's `main()` is behind an
// `import.meta.url === argv[1]` guard, so importing it runs nothing.
import { extractJson, resolveRunInvocation } from "../../../scripts/check-package-licenses.mjs";
// The cr-sqlite filename from the module that WRITES it, rather than a second
// opinion about it. `package-native-deps.mjs` runs nothing on import: its
// `main()` is behind an `import.meta.url === argv[1]` guard.
import { crsqliteExtensionFileName } from "./package-native-deps.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");

/** Every target `release-core.yml` builds. Kept in the same order as that matrix. */
export const RUNTIME_TARGETS = [
  { target: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { target: "darwin-x64", os: "darwin", cpu: "x64" },
  { target: "linux-x64", os: "linux", cpu: "x64" },
  { target: "linux-arm64", os: "linux", cpu: "arm64" },
  { target: "win32-x64", os: "win32", cpu: "x64" },
];

export const META_PACKAGE_NAME = "@ade-dev/runtime";

export function runtimePackageName(target) {
  return `@ade-dev/runtime-${target}`;
}

/** The two release assets that make one platform package. */
export function runtimeAssetNames(target) {
  // The Windows launcher is `ade-win32-x64.exe`. The native archive next to it
  // is `ade-win32-x64.native.tar.gz` — not `ade-win32-x64.exe.native.tar.gz`.
  // `release-core.yml` and SHA256SUMS spell it that way; gluing `.native.tar.gz`
  // onto the binary name looks for a file the release never publishes.
  if (target === "win32-x64") {
    return { binaryAsset: "ade-win32-x64.exe", archiveAsset: "ade-win32-x64.native.tar.gz" };
  }
  return { binaryAsset: `ade-${target}`, archiveAsset: `ade-${target}.native.tar.gz` };
}

/**
 * `tar` resolved through the kernel's own System32 alias on Windows, never
 * PATH. Mirrors `packages/sdk/src/windowsSystemTools.ts`: a Git Bash or MSYS
 * `tar.exe` earlier on PATH handles Windows paths differently, and PATH is
 * caller-controlled. There is deliberately no fallback.
 */
function tarExecutable() {
  if (process.platform !== "win32") return "tar";
  const kernelRoot = String.raw`\\?\GLOBALROOT\SystemRoot\System32`;
  const canonicalRoot = fs.realpathSync.native(kernelRoot);
  const canonicalTool = fs.realpathSync.native(path.win32.join(kernelRoot, "tar.exe"));
  const expected = path.win32.join(canonicalRoot, "tar.exe");
  if (
    path.win32.basename(canonicalRoot).toLowerCase() !== "system32" ||
    canonicalTool.toLowerCase() !== expected.toLowerCase()
  ) {
    throw new Error(`Refusing an untrusted Windows tar executable: ${canonicalTool}`);
  }
  return canonicalTool;
}

export function parseArgs(argv) {
  const args = {
    artifactsDir: null,
    version: null,
    outDir: null,
    targets: RUNTIME_TARGETS.map((entry) => entry.target),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value.`);
      index += 1;
      return value;
    };
    if (arg === "--artifacts-dir") args.artifactsDir = take();
    else if (arg === "--version") args.version = take();
    else if (arg === "--out-dir") args.outDir = take();
    else if (arg === "--targets") {
      args.targets = take()
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.artifactsDir) throw new Error("--artifacts-dir is required.");
  if (!args.version) throw new Error("--version is required.");
  if (!args.outDir) throw new Error("--out-dir is required.");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args.version)) {
    throw new Error(`--version must be a semantic version, got "${args.version}".`);
  }
  const known = new Set(RUNTIME_TARGETS.map((entry) => entry.target));
  for (const target of args.targets) {
    if (!known.has(target)) throw new Error(`Unknown target: ${target}`);
  }
  return args;
}

/**
 * The embedding exception travels with the runtime binary, so every runtime
 * package carries it beside the AGPL text.
 *
 * The permission is what makes these packages usable by a proprietary
 * embedder at all, and the AGPL text alone does not state it. An embedder who
 * receives only `LICENSE` reads a copyleft license and stops. The file name is
 * exported because three places have to agree on it: the manifest `files`
 * list, the packed-tarball assertion, and the test.
 */
export const EXCEPTION_FILE_NAME = "RUNTIME-EMBEDDING-EXCEPTION.md";

/** The two license documents every runtime package ships, read from the repo root. */
export function readLicenseFiles() {
  return {
    license: fs.readFileSync(path.join(repoRoot, "LICENSE"), "utf8"),
    exception: fs.readFileSync(path.join(repoRoot, EXCEPTION_FILE_NAME), "utf8"),
  };
}

/**
 * Refuses a build that was handed no exception text.
 *
 * Both writers take the text as a parameter so the tests can drive them, and a
 * missing argument would otherwise write `undefined` into the package or throw
 * from `fs.writeFileSync` with a message about a bad type rather than about
 * the licensing file it forgot.
 */
function requireLicenseText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Refusing to build a runtime package with no ${label} text. Every published runtime ` +
        `package must carry both LICENSE and ${EXCEPTION_FILE_NAME}: the root files do not ` +
        `travel in an npm tarball, and the exception is the permission an embedder relies on.`,
    );
  }
  return value;
}

export function runtimePackageManifest({ target, os: osName, cpu, version }) {
  return {
    name: runtimePackageName(target),
    version,
    description: `The ADE runtime binary and its native modules for ${target}.`,
    license: "AGPL-3.0-only",
    repository: {
      type: "git",
      url: "git+https://github.com/arul28/ADE.git",
      directory: "apps/ade-cli",
    },
    homepage: "https://github.com/arul28/ADE/tree/main/packages/sdk",
    bugs: { url: "https://github.com/arul28/ADE/issues" },
    os: [osName],
    cpu: [cpu],
    // No `exports` map: `@ade-dev/sdk` resolves this package by
    // `require.resolve("<name>/package.json")`, which an exports map would gate.
    files: ["bin", "native", "LICENSE", EXCEPTION_FILE_NAME, "README.md"],
    keywords: ["ade", "runtime", target],
  };
}

/**
 * The meta package, which always names all five platform packages.
 *
 * It deliberately ignores which targets this run built. `optionalDependencies`
 * describes the published family for `version`, not one machine's output: a run
 * limited to `--targets win32-x64` — the only run a Windows maintainer can make,
 * since building a POSIX package there is refused — used to publish a meta
 * package naming one platform, and `npm install @ade-dev/runtime` then resolved
 * NO runtime at all on macOS and Linux. A silent no-runtime install, because
 * npm skips an optional dependency that does not match rather than failing.
 *
 * npm installs exactly the one whose `os`/`cpu` match and skips the other four,
 * so naming a package this run did not build costs nothing.
 */
export function metaPackageManifest({ version }) {
  const optionalDependencies = {};
  for (const entry of RUNTIME_TARGETS) optionalDependencies[runtimePackageName(entry.target)] = version;
  return {
    name: META_PACKAGE_NAME,
    version,
    description:
      "Installs the ADE runtime binary for the current platform, for embedders bundling @ade-dev/sdk.",
    license: "AGPL-3.0-only",
    repository: {
      type: "git",
      url: "git+https://github.com/arul28/ADE.git",
      directory: "apps/ade-cli",
    },
    homepage: "https://github.com/arul28/ADE/tree/main/packages/sdk",
    bugs: { url: "https://github.com/arul28/ADE/issues" },
    // npm installs exactly the one whose `os`/`cpu` match, and skips the rest
    // without failing the install. That is the whole point of the pattern.
    optionalDependencies,
    // LICENSE as well as README: the root LICENSE does not travel in an npm
    // tarball, and this package is built into runtime-packages/, which
    // scripts/check-package-licenses.mjs never walks. npm-packlist
    // force-includes a LICENSE today, but that is npm's behaviour, not this
    // manifest's statement of intent. The embedding exception is listed for the
    // same reason: it is the permission this package exists to deliver.
    files: ["README.md", "LICENSE", EXCEPTION_FILE_NAME],
    keywords: ["ade", "runtime"],
  };
}

function runtimePackageReadme(target) {
  return `# ${runtimePackageName(target)}

The ADE runtime binary for \`${target}\`, plus the native modules it dlopens.

You do not import this package. \`@ade-dev/sdk\` finds it automatically through
\`resolveBundledRuntime()\`, which is step 2 of its runtime resolution order.

    bin/ade${target === "win32-x64" ? ".exe" : ""}   the runtime binary
    native/          ADE_RUNTIME_ROOT
    native/node_modules   ADE_RUNTIME_NODE_MODULES

Install \`@ade-dev/runtime\` rather than this package directly: it lists all five
platform packages as \`optionalDependencies\`, so npm installs exactly the one
that matches the machine.

If you ship this inside a signed application, sign the binary and every Mach-O
file under \`native/\` with your own identity. See the SDK bundling guide:
https://www.ade-app.dev/docs/sdk/bundling

## License

AGPL-3.0-only with the ADE Runtime Embedding Exception.

Shipping this binary unmodified inside a larger work, consumed through the
documented \`@ade-dev/sdk\` interface, does not by itself make that work subject
to the AGPL. Re-signing it with your own identity does not count as modifying
it. See \`LICENSE\` and \`${EXCEPTION_FILE_NAME}\` in this package, and
https://www.ade-app.dev/docs/sdk/license
`;
}

function metaPackageReadme(version) {
  return `# ${META_PACKAGE_NAME}

Installs the ADE runtime for the current platform.

    npm install @ade-dev/runtime@${version}

npm resolves exactly one of the five platform packages through
\`optionalDependencies\`, \`os\` and \`cpu\`:

  - @ade-dev/runtime-darwin-arm64
  - @ade-dev/runtime-darwin-x64
  - @ade-dev/runtime-linux-x64
  - @ade-dev/runtime-linux-arm64
  - @ade-dev/runtime-win32-x64

\`@ade-dev/sdk\` then finds it with no configuration, and never reaches the
network on first run. Pair it with \`allowDownload: false\` so a packaging
mistake fails loudly rather than working through a silent download.

Bundling and code-signing guide: https://www.ade-app.dev/docs/sdk/bundling

## License

AGPL-3.0-only with the ADE Runtime Embedding Exception.

Shipping the runtime binary unmodified inside a larger work, consumed through
the documented \`@ade-dev/sdk\` interface, does not by itself make that work
subject to the AGPL. See \`LICENSE\` and \`${EXCEPTION_FILE_NAME}\` in this
package, and https://www.ade-app.dev/docs/sdk/license
`;
}

/**
 * The one cr-sqlite path a package for `target` may carry, as the packed
 * listing spells it: always `/`-separated, always under the target directory,
 * and always the extension that target's loader can `dlopen`.
 *
 * The target and the extension are both bound, deliberately. A regex that
 * accepted any directory and any of the three extensions passed a Windows
 * package carrying a Linux `.so` — the mislabelled-archive case the assertion
 * exists to catch, since every other check here is satisfied by it.
 *
 * The filename comes from `package-native-deps.mjs`, which writes the file. A
 * verifier that asserts the exact name the producer wrote cannot drift from it.
 */
function crsqliteExtensionPath(target) {
  return `native/vendor/crsqlite/${target}/${crsqliteExtensionFileName(target)}`;
}

/** Every file under `dir`, as paths relative to it with `/` separators. */
function listFilesRelative(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRelative(full, base));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/**
 * `npm pack --dry-run`, spawned the one way that works on every platform.
 *
 * On Windows `npm` is `npm.cmd`, and Node has refused to spawn a `.cmd` bare
 * since CVE-2024-27980. `resolveRunInvocation` builds an explicit ComSpec
 * command line rather than handing a joined string to a shell; it is the same
 * helper the sibling `scripts/check-package-licenses.mjs` uses for the same
 * `npm pack` call, and both mirror `resolveWindowsCmdLineInvocation` in
 * `apps/desktop/src/main/services/shared/processExecution.ts`.
 *
 * This script runs on Windows: `tarExecutable()` exists only for win32, and the
 * publish workflow says the first version of each package ships from a
 * maintainer machine. A spawn error here lands after the package directory is
 * already written.
 */
function defaultPackRunner(cwd) {
  const invocation = resolveRunInvocation("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  return execFileSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

/**
 * Asserts the tarball npm would publish still carries every runtime file.
 *
 * `files: ["bin","native",...]` states the intent; npm-packlist decides. It
 * honors `.gitignore` and `.npmignore` files found in SUBDIRECTORIES of the
 * packed package, and `package-native-deps.mjs` copies the dependency tree
 * verbatim. So one dependency bump that adds a `.gitignore` containing `*.node`
 * or `build/` beside a prebuilt module silently drops the native artifact from
 * the published package, and the embedder's app then dies at `dlopen` — the
 * cr-sqlite failure mode, which crashes rather than degrading.
 *
 * Parity alone is not enough, because the expected set is derived from disk: an
 * empty `native/node_modules/` produces an empty expectation and every file on
 * disk is trivially packed. So PRESENCE is asserted against the packed listing
 * too — the launcher and at least one native module — which is what catches a
 * truncated or empty `ade-<target>.native.tar.gz`. Without it the six packages
 * publish, `resolveBundledRuntime()` finds `bin/ade`, and the embedder's app
 * dies at `dlopen` on cr-sqlite: a crash rather than a degrade.
 *
 * `LICENSE` and `README.md` are asserted here as well. They are NOT covered by
 * `scripts/check-package-licenses.mjs`, whatever an earlier version of this
 * comment claimed: that script walks `packages/` only, and these packages are
 * built into `runtime-packages/`, which it never sees.
 */
export function verifyPackedRuntimeFiles({ packageDir, runPack = defaultPackRunner }) {
  // The directory name carries the target, so the launcher's name is decided,
  // not a choice of two. Accepting either one let a `runtime-win32-x64`
  // package pack a POSIX `bin/ade` and publish a runtime Windows cannot spawn.
  const target = path.basename(packageDir).replace(/^runtime-/, "");
  const targetEntry = RUNTIME_TARGETS.find((candidate) => candidate.target === target);
  // An unknown directory name decides nothing: the launcher name, the cr-sqlite
  // extension and the vendor directory all come from the target. Falling back
  // to the POSIX launcher verified the wrong contract in silence, which matters
  // because `verify-runtime-package-contents.mjs` takes directories from argv.
  if (!targetEntry) {
    throw new Error(
      `${packageDir}: "${target}" is not one of the runtime targets ` +
        `(${RUNTIME_TARGETS.map((candidate) => candidate.target).join(", ")}). The directory name ` +
        `decides which launcher and which cr-sqlite extension this package must carry, so there ` +
        `is no contract to verify against a renamed or unknown directory.`,
    );
  }
  const launcher = targetEntry.os === "win32" ? "bin/ade.exe" : "bin/ade";
  const onDisk = listFilesRelative(packageDir)
    .filter((file) => file.startsWith("bin/") || file.startsWith("native/"));
  const parsed = extractJson(runPack(packageDir));
  if (parsed === null) {
    throw new Error(
      `${packageDir}: could not parse "npm pack --dry-run --json" output; refusing to publish a ` +
        `package whose contents were never verified.`,
    );
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const packed = new Set((Array.isArray(entry?.files) ? entry.files : []).map((file) => file.path));
  const missing = onDisk.filter((file) => !packed.has(file));
  if (missing.length > 0) {
    throw new Error(
      `${packageDir}: npm would not pack ${missing.length} file(s) that exist on disk, starting ` +
        `with ${missing[0]}. npm-packlist honors .gitignore/.npmignore inside packed ` +
        `subdirectories, so a dependency shipping one of those can drop a native module from the ` +
        `published package. Missing: ${missing.join(", ")}`,
    );
  }

  // Presence, read off the PACKED listing rather than off disk, so an empty
  // disk cannot satisfy it.
  const packedFiles = [...packed];
  if (!packedFiles.includes(launcher)) {
    throw new Error(
      `${packageDir}: the packed tarball carries no ${launcher}. That is the launcher the ` +
        `package exists to ship on ${targetEntry.os}, so publishing it would install ` +
        `a runtime that cannot start.`,
    );
  }
  const nativeModuleCount = packedFiles.filter((file) => file.startsWith("native/node_modules/")).length;
  if (nativeModuleCount === 0) {
    throw new Error(
      `${packageDir}: the packed tarball carries no native/node_modules/** entry. The native ` +
        `archive extracted empty or truncated: an empty node_modules directory passes the ` +
        `existence check in buildRuntimePackage and leaves the parity check with nothing to ` +
        `compare, so this is the only place it is caught. The runtime resolves its dependency ` +
        `tree out of that directory and cannot start without it.`,
    );
  }
  // cr-sqlite is the one file whose absence is a crash rather than a degrade,
  // and it does NOT live under native/node_modules — `package-native-deps.mjs`
  // writes it to native/vendor/crsqlite/<target>/. An archive carrying
  // node_modules but no vendor/ satisfied every other check here: the parity
  // check is `onDisk ⊆ packed`, and a file on neither side is invisible to it.
  // The path is exact, not a shape: a `runtime-win32-x64` package carrying a
  // Linux `native/vendor/crsqlite/win32-x64/crsqlite.so` satisfies every other
  // check here — parity is `onDisk ⊆ packed`, node_modules is non-empty, and
  // the launcher comes from the separate binary asset — and then dies at
  // dlopen on the user's machine.
  const crsqlite = crsqliteExtensionPath(target);
  if (!packedFiles.includes(crsqlite)) {
    throw new Error(
      `${packageDir}: the packed tarball carries no ${crsqlite}. The runtime dlopens cr-sqlite ` +
        `out of that exact path, so the package would install, resolveBundledRuntime() would ` +
        `find ${launcher}, and the embedder's app would then die at dlopen. Carrying another ` +
        `platform's extension there is the same failure: found: ` +
        `${packedFiles.filter((file) => file.startsWith("native/vendor/crsqlite/")).join(", ") || "nothing under native/vendor/crsqlite/"}.`,
    );
  }
  for (const required of ["LICENSE", EXCEPTION_FILE_NAME, "README.md", "package.json"]) {
    if (!packed.has(required)) {
      throw new Error(
        `${packageDir}: the packed tarball is missing ${required}. The root LICENSE and ` +
          `${EXCEPTION_FILE_NAME} do not travel in an npm tarball, and ` +
          `scripts/check-package-licenses.mjs walks packages/ only, so it never sees these ` +
          `packages. Without the exception the embedder reads a bare AGPL and has no record of ` +
          `the permission this package exists to deliver.`,
      );
    }
  }
  return onDisk;
}

/**
 * Writes one platform package directory.
 *
 * Exported so the packaging test can drive it against a tiny fake archive: the
 * executable bit and the layout are the two things npm has silently dropped
 * before, and they are cheap to assert.
 */
export function buildRuntimePackage({
  target,
  artifactsDir,
  outDir,
  version,
  license,
  exception,
  runPack,
  hostPlatform = process.platform,
}) {
  requireLicenseText(license, "LICENSE");
  requireLicenseText(exception, EXCEPTION_FILE_NAME);
  const entry = RUNTIME_TARGETS.find((candidate) => candidate.target === target);
  if (!entry) throw new Error(`Unknown target: ${target}`);
  // Windows records no execute bit and npm packs none from a Windows host, so
  // a darwin or linux package built there publishes a `bin/ade` that arrives
  // mode 0644 and fails at spawn with EACCES. Nothing downstream catches it:
  // the file is present, the parity check passes, and the failure is the
  // embedder's, at run time. Building the win32 package on Windows is fine —
  // it needs no execute bit.
  if (hostPlatform === "win32" && entry.os !== "win32") {
    throw new Error(
      `Refusing to build runtime-${target} on a Windows host. npm records no execute bit from a ` +
        `Windows pack, so the published bin/ade would arrive mode 0644 and fail at spawn with ` +
        `EACCES. Build the ${entry.os} packages on macOS or Linux. Use --targets win32-x64 to ` +
        `build only the Windows package here.`,
    );
  }
  const { binaryAsset, archiveAsset } = runtimeAssetNames(target);
  const binarySource = path.join(artifactsDir, binaryAsset);
  const archiveSource = path.join(artifactsDir, archiveAsset);
  if (!fs.existsSync(binarySource)) throw new Error(`Missing runtime binary: ${binarySource}`);
  if (!fs.existsSync(archiveSource)) throw new Error(`Missing native archive: ${archiveSource}`);

  const packageDir = path.join(outDir, `runtime-${target}`);
  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  const nativeDir = path.join(packageDir, "native");
  fs.mkdirSync(nativeDir, { recursive: true });

  const binaryName = entry.os === "win32" ? "ade.exe" : "ade";
  const binaryTarget = path.join(packageDir, "bin", binaryName);
  fs.copyFileSync(binarySource, binaryTarget);
  // npm preserves only the executable bit, and only when it is set here. A
  // runtime that arrives mode 0644 fails at spawn with EACCES.
  fs.chmodSync(binaryTarget, 0o755);
  // `chmod` is advisory on some filesystems — an exFAT or NTFS volume mounted
  // on macOS ignores it silently. Read the mode back rather than trusting it.
  if (hostPlatform !== "win32") {
    const mode = fs.statSync(binaryTarget).mode;
    if ((mode & 0o111) === 0) {
      throw new Error(
        `${binaryTarget}: chmod 0o755 did not take (mode is ${(mode & 0o777).toString(8)}). The ` +
          `filesystem is ignoring the execute bit, so the published runtime would fail at spawn ` +
          `with EACCES. Build on a filesystem that records POSIX permissions.`,
      );
    }
  }

  execFileSync(tarExecutable(), ["-xzf", archiveSource, "-C", nativeDir], {
    stdio: "inherit",
    windowsHide: true,
  });
  const nodeModules = path.join(nativeDir, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    throw new Error(
      `${archiveAsset} extracted without a node_modules directory; the runtime dlopens its ` +
        `native modules out of ${nodeModules} and cannot start without it.`,
    );
  }

  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(runtimePackageManifest({ ...entry, version }), null, 2)}\n`,
  );
  fs.writeFileSync(path.join(packageDir, "LICENSE"), license);
  fs.writeFileSync(path.join(packageDir, EXCEPTION_FILE_NAME), exception);
  fs.writeFileSync(path.join(packageDir, "README.md"), runtimePackageReadme(target));
  // Last, because it reads the finished directory including its manifest.
  verifyPackedRuntimeFiles({ packageDir, ...(runPack ? { runPack } : {}) });
  return packageDir;
}

export function buildMetaPackage({ outDir, version, targets, license, exception, runPack }) {
  requireLicenseText(license, "LICENSE");
  requireLicenseText(exception, EXCEPTION_FILE_NAME);
  // The manifest names all five platform packages, so the meta package is only
  // honest when all five were built at this version. A run limited to
  // `--targets win32-x64` — the only run a Windows maintainer can make, since
  // building a POSIX package there is refused — publishes a meta package whose
  // other four optional dependencies do not exist at that version, and npm
  // skips an optional dependency it cannot RESOLVE for the same reason it skips
  // one whose os/cpu does not match: silently, exit 0. `resolveBundledRuntime()`
  // then finds nothing and the SDK falls through to downloading a Mach-O
  // executable into userData at run time, inside the embedder's signed and
  // notarized application. That is the failure the platform packages exist to
  // prevent, and it would be found on a user's machine.
  const built = new Set(targets ?? []);
  const uncovered = RUNTIME_TARGETS.filter((entry) => !built.has(entry.target)).map((entry) => entry.target);
  if (uncovered.length > 0) {
    throw new Error(
      `Refusing to build ${META_PACKAGE_NAME}: this run built ${built.size} of ` +
        `${RUNTIME_TARGETS.length} targets and does not cover ${uncovered.join(", ")}. The meta ` +
        `package lists all five as optionalDependencies, and npm skips one it cannot resolve as ` +
        `silently as one that does not match, so publishing it now would install no runtime at ` +
        `all on those platforms. Build every target, then the meta package.`,
    );
  }
  const packageDir = path.join(outDir, "runtime");
  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(metaPackageManifest({ version }), null, 2)}\n`,
  );
  fs.writeFileSync(path.join(packageDir, "LICENSE"), license);
  fs.writeFileSync(path.join(packageDir, EXCEPTION_FILE_NAME), exception);
  fs.writeFileSync(path.join(packageDir, "README.md"), metaPackageReadme(version));
  // The meta package was the one package nothing pack-verified: it carries no
  // bin/ or native/, so `verifyPackedRuntimeFiles` does not fit it, and the
  // workflow's verify loop globs `runtime-*/`, which does not match `runtime/`.
  verifyPackedMetaFiles({ packageDir, ...(runPack ? { runPack } : {}) });
  return packageDir;
}

/**
 * Asserts the meta package's own three files survive `npm pack`.
 *
 * It ships no binary, so the only thing that can go wrong is a `files` list
 * that drops the license or the readme — which is exactly what happened: the
 * manifest listed README.md alone, and only npm-packlist's force-include of a
 * LICENSE kept the published tarball legal.
 */
export function verifyPackedMetaFiles({ packageDir, runPack = defaultPackRunner }) {
  const parsed = extractJson(runPack(packageDir));
  if (parsed === null) {
    throw new Error(
      `${packageDir}: could not parse "npm pack --dry-run --json" output; refusing to publish a ` +
        `package whose contents were never verified.`,
    );
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const packed = new Set((Array.isArray(entry?.files) ? entry.files : []).map((file) => file.path));
  for (const required of ["LICENSE", EXCEPTION_FILE_NAME, "README.md", "package.json"]) {
    if (!packed.has(required)) {
      throw new Error(
        `${packageDir}: the packed tarball is missing ${required}. The root LICENSE and ` +
          `${EXCEPTION_FILE_NAME} do not travel in an npm tarball, and ` +
          `scripts/check-package-licenses.mjs walks packages/ only, so it never sees this package.`,
      );
    }
  }
  return [...packed];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactsDir = path.resolve(args.artifactsDir);
  const outDir = path.resolve(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const { license, exception } = readLicenseFiles();

  for (const target of args.targets) {
    const dir = buildRuntimePackage({
      target,
      artifactsDir,
      outDir,
      version: args.version,
      license,
      exception,
    });
    console.log(`[runtime-packages] built ${runtimePackageName(target)}@${args.version} at ${dir}`);
  }
  const metaDir = buildMetaPackage({
    outDir,
    version: args.version,
    targets: args.targets,
    license,
    exception,
  });
  console.log(`[runtime-packages] built ${META_PACKAGE_NAME}@${args.version} at ${metaDir}`);
  console.log(`[runtime-packages] ${args.targets.length + 1} package(s) in ${outDir}`);
}

// `pathToFileURL`, matching `scripts/check-package-licenses.mjs`. It compares
// the URL this module was loaded as rather than a resolved filesystem path, so
// a symlinked bin entry still counts as a direct invocation.
const invokedDirectly =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`[runtime-packages] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
