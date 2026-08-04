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
