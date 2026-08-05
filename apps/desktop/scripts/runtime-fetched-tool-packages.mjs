// The three agent CLIs ADE drives -- Codex, Claude Code and OpenCode -- are
// fetched at runtime into the machine tools cache (~/.ade/tools, or
// %LOCALAPPDATA%\ADE\tools on Windows) at the versions pinned in
// apps/ade-cli/src/services/tools/toolsManifest.generated.json. Their native
// platform packages are the entire payload of those CLIs -- ~630 MB for the
// darwin-arm64 subset alone -- so a packaged desktop app must not carry them:
// the resolvers consult the cache first and would ignore a bundled copy anyway.
//
// The name list itself lives with the brain runtime archive filter, which has
// the same exclusion for the same reason. Importing it rather than restating it
// is the point: a package that is dropped from one list and not the other is a
// silent regression worth hundreds of megabytes per installer.
import { pathToFileURL } from "node:url";

import { RUNTIME_FETCHED_TOOL_PACKAGES } from "../../ade-cli/scripts/native-deps-entry-filter.mjs";

/** Sorted package names, e.g. "@openai/codex-darwin-arm64", "opencode-linux-x64". */
export const runtimeFetchedToolPackageNames = Object.freeze(
  [...RUNTIME_FETCHED_TOOL_PACKAGES].sort(),
);

/** Package-relative path inside a node_modules tree, using POSIX separators. */
export function runtimeFetchedToolPackageRelativePath(packageName) {
  return `node_modules/${packageName}`;
}

/**
 * electron-builder `build.files` negation for one package.
 *
 * Dropping a package from `asarUnpack` is not enough to stop shipping it:
 * electron-builder copies every production dependency, so an entry that is not
 * unpacked is packed *inside* app.asar instead. Only a `!` pattern in
 * `build.files` keeps it out of the package entirely - getNodeModuleFileMatcher
 * collects exactly the negated patterns and applies them to the node_modules
 * walk.
 */
export function runtimeFetchedToolPackageFilesExclusion(packageName) {
  return `!node_modules/${packageName}/**`;
}

export const runtimeFetchedToolPackageFilesExclusions = Object.freeze(
  runtimeFetchedToolPackageNames.map(runtimeFetchedToolPackageFilesExclusion),
);

/** True when an `asarUnpack`/`files` pattern targets one of the fetched packages. */
export function matchesRuntimeFetchedToolPackage(pattern) {
  const normalized = String(pattern ?? "").replace(/^!/, "");
  return runtimeFetchedToolPackageNames.some(
    (packageName) =>
      normalized === `node_modules/${packageName}`
      || normalized.startsWith(`node_modules/${packageName}/`),
  );
}

export const RUNTIME_FETCHED_TOOL_EXPLANATION =
  "These packages are fetched into the machine tools cache at runtime (see "
  + "apps/ade-cli/src/services/tools/), not bundled. Shipping them adds hundreds of "
  + "megabytes the resolvers never read, because the cache is consulted first.";

/**
 * Escape every ERE metacharacter so a package name matches literally.
 *
 * `/` is deliberately not escaped: it is not an ERE metacharacter, and `\/` is
 * undefined in POSIX ERE -- GNU grep tolerates it, BSD grep need not, and this
 * pattern runs on both ubuntu and macos runners.
 */
function escapeEre(value) {
  return value.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
}

/**
 * An ERE matching the archive path of every runtime-fetched tool package.
 *
 * The release workflow greps a `tar -tzf` listing to prove no platform package
 * rode along in the brain runtime archive. That gate used to hardcode a single
 * `opencode-` pattern, which left the other 25 packages -- including all of
 * Codex and the Claude agent SDK natives -- completely unguarded. Deriving the
 * pattern from the canonical list here means adding a package to the list arms
 * the gate for it automatically.
 *
 * Anchored at the listing's `./node_modules/` prefix and terminated by `/` or
 * end-of-entry so that a name is never a prefix match for a longer one
 * (`opencode-linux-x64` must not claim `opencode-linux-x64-musl`'s entries --
 * both are in the list, but a partial match would misreport which one leaked).
 */
export function runtimeFetchedToolPackageGrepPattern() {
  const alternation = runtimeFetchedToolPackageNames.map(escapeEre).join("|");
  return `^\\./node_modules/(${alternation})(/|$)`;
}

// `node runtime-fetched-tool-packages.mjs --grep-pattern` prints that ERE for
// the release workflow's `grep -E`. Kept to a bare stdout write with no other
// decoration so the caller can capture it straight into a shell variable.
//
// pathToFileURL, not `file://` + argv[1]: the release workflow runs this step on
// the windows-latest matrix leg too, where argv[1] is `D:\a\...` and the naive
// concatenation never equals import.meta.url's `file:///D:/a/...`. That mismatch
// would silently skip the CLI branch, print usage, exit 2, and take the whole
// signed-Windows runtime build down with it under `set -e`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--grep-pattern")) {
    process.stdout.write(`${runtimeFetchedToolPackageGrepPattern()}\n`);
  } else {
    process.stderr.write("usage: runtime-fetched-tool-packages.mjs --grep-pattern\n");
    process.exit(2);
  }
}
