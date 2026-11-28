// The packages the CLI bundles name, checked against what this package itself
// installs (`verify-built-cli.mjs` runs it after every `npm run build`).
//
// The standalone runtime's build job installs `apps/ade-cli` only
// (release-core.yml, ci.yml runtime-packaging): no `apps/desktop/node_modules`.
// The bundles inline code from `apps/desktop/src`, and a package that only the
// desktop installs then cannot be found there. For an `import()` with a
// `.catch()`, or a `require()` inside `try`, esbuild only warns and leaves the
// import external, so the runtime shipped a bare `import("@github/copilot-sdk")`
// and every Copilot chat on it failed at its first turn. In a checkout the same
// import resolves from `apps/desktop/node_modules`, so nothing local saw it.
//
// So, from esbuild's metafile:
//   - every package a bundle inlines must be in this package's lockfile, where
//     a runtime build can install it;
//   - every package a bundle leaves external must be one of this package's
//     production installs (a non-dev lockfile entry), the set the runtime's
//     native archive carries (`package-native-deps.mjs`).
import { isBuiltin } from "node:module";

const NODE_MODULES = "node_modules/";

/** `@scope/name` or `name` from a bare import path; null for a relative or absolute one. */
export function packageNameOf(specifier) {
  if (typeof specifier !== "string" || !specifier || specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (/^[A-Za-z]:[\\/]/.test(specifier) || specifier.includes("\\")) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

/** The package an esbuild input path lives in, and whether that path is outside this package. */
function inputPackage(inputPath) {
  const normalized = inputPath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf(NODE_MODULES);
  if (index === -1) return null;
  const name = packageNameOf(normalized.slice(index + NODE_MODULES.length));
  if (!name) return null;
  return { name, outside: !normalized.startsWith(NODE_MODULES) };
}

/** Lockfile package names: every install, and the production (non-dev) ones. */
function lockPackageNames(lock) {
  const all = new Set();
  const production = new Set();
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    const index = key.lastIndexOf(NODE_MODULES);
    if (index === -1) continue;
    const name = key.slice(index + NODE_MODULES.length);
    all.add(name);
    // Only top-level entries resolve for a bare import from the runtime's own code.
    if (!entry?.dev && key === `${NODE_MODULES}${name}`) production.add(name);
  }
  return { all, production };
}

/**
 * Packages the built bundles need that a runtime build of this package cannot
 * have, one entry per package and reason, sorted. Empty when every one is
 * installed here.
 *
 * @param {{ metafile: { inputs?: Record<string, unknown>, outputs?: Record<string, { imports?: Array<{ path: string, external?: boolean }> }> }, lock: { packages?: Record<string, { dev?: boolean }> } }} args
 * @returns {Array<{ name: string, reason: "external-not-installed" | "inlined-from-outside", outputs: string[] }>}
 */
export function findUnshippedBundlePackages({ metafile, lock }) {
  const { all, production } = lockPackageNames(lock);
  const problems = new Map();
  const note = (name, reason, output) => {
    const key = `${reason}\0${name}`;
    const entry = problems.get(key) ?? { name, reason, outputs: [] };
    if (output && !entry.outputs.includes(output)) entry.outputs.push(output);
    problems.set(key, entry);
  };

  for (const [output, meta] of Object.entries(metafile?.outputs ?? {})) {
    if (output.endsWith(".map")) continue;
    for (const entry of meta?.imports ?? []) {
      if (!entry?.external || isBuiltin(entry.path)) continue;
      const name = packageNameOf(entry.path);
      if (name && !production.has(name)) note(name, "external-not-installed", output);
    }
  }
  for (const inputPath of Object.keys(metafile?.inputs ?? {})) {
    const found = inputPackage(inputPath);
    if (found?.outside && !all.has(found.name)) note(found.name, "inlined-from-outside", null);
  }

  return [...problems.values()]
    .map((entry) => ({ ...entry, outputs: entry.outputs.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.reason.localeCompare(b.reason));
}

/** The build failure for `problems`, or null when there are none. */
export function unshippedBundlePackagesMessage(problems) {
  if (!problems.length) return null;
  const lines = problems.map((problem) => problem.reason === "external-not-installed"
    ? `  - ${problem.name}: left external in ${problem.outputs.join(", ")}, but not a dependency of apps/ade-cli, so the standalone runtime cannot load it`
    : `  - ${problem.name}: inlined from outside apps/ade-cli, which a runtime build (npm ci in apps/ade-cli only) does not install`);
  return [
    "[ade-cli:build] The CLI bundles need packages that apps/ade-cli does not install:",
    ...lines,
    "Add each one to apps/ade-cli/package.json at the desktop's version (inlined packages go in tsup noExternal and",
    "RUNTIME_INLINED_PACKAGES), or stop importing it from code the CLI bundles.",
  ].join("\n");
}
