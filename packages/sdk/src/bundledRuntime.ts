import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeTarget } from "./download.js";
import { AdeError } from "./errors.js";
import { isDirectory, isFile } from "./fsProbe.js";

/**
 * Resolution of a runtime shipped as an npm platform package.
 *
 * A downloaded runtime cannot live inside a signed and notarized application:
 * the bundle is one signed artifact, and a Mach-O executable that appears in
 * `userData` after the fact is outside it. So the runtime is also published the
 * way esbuild and swc publish theirs — one package per target, each carrying
 * `os` and `cpu`, listed as `optionalDependencies` of `@ade-dev/runtime` so npm
 * installs exactly one. The embedder copies that directory into their bundle
 * and signs it with their own identity.
 *
 * Layout, which this module both expects and documents:
 *
 *   @ade-dev/runtime-<target>/
 *     package.json          { os: [...], cpu: [...], version: <ade release> }
 *     bin/ade[.exe]         the runtime binary, mode 0755
 *     native/               the extracted contents of <binary>.native.tar.gz
 *       node_modules/       the modules the binary dlopens
 *       vendor/crsqlite/... the cr-sqlite extension
 *       tuiClient/
 *     LICENSE
 *     README.md
 *
 * `runtimeRoot` is `<pkg>/native`, which is what `ADE_RUNTIME_ROOT` must point
 * at; `nodeModulesPath` is `<pkg>/native/node_modules`, which is
 * `ADE_RUNTIME_NODE_MODULES`. The two are reported separately rather than
 * derived at the call site because an embedder is free to relocate either half
 * inside their bundle, and `createAdeChat` accepts both.
 */

export type BundledRuntime = {
  /** Absolute path of the runtime binary inside the platform package. */
  binaryPath: string;
  /** Absolute path that `ADE_RUNTIME_ROOT` must name. */
  runtimeRoot: string;
  /** Absolute path that `ADE_RUNTIME_NODE_MODULES` must name. */
  nodeModulesPath: string;
  /** e.g. `@ade-dev/runtime-darwin-arm64`. */
  packageName: string;
  /** The ADE release version the package was cut from. */
  version: string;
};

export type ResolveBundledRuntimeOptions = {
  /**
   * Directory or file to resolve the package from. Defaults to this module's
   * own location, which is what an embedder wants: the runtime package sits
   * beside `@ade-dev/sdk` in the same `node_modules` tree.
   */
  resolveFrom?: string;
  platform?: NodeJS.Platform;
  arch?: string;
};

/** The platform package name for a runtime target, e.g. `darwin-arm64`. */
export function bundledRuntimePackageName(target: string): string {
  return `@ade-dev/runtime-${target}`;
}

/**
 * `createRequire` needs a *file* to anchor resolution. In the ESM build that is
 * this module's own URL; esbuild rewrites `import.meta` to an empty object in
 * the CJS output, so the read below yields `undefined` there instead of
 * throwing and the `__filename` branch takes over. The cwd fallback exists only
 * for an exotic host that provides neither, and it is still a real anchor
 * rather than a crash.
 */
declare const __filename: string | undefined;

function defaultResolveAnchor(): string {
  const meta = import.meta as unknown as { url?: unknown } | undefined;
  const metaUrl = typeof meta?.url === "string" ? meta.url : null;
  if (metaUrl && metaUrl.startsWith("file:")) {
    try {
      return fileURLToPath(metaUrl);
    } catch {
      // A malformed URL is not worth failing resolution over.
    }
  }
  if (typeof __filename === "string" && __filename.length > 0) return __filename;
  return path.join(process.cwd(), "ade-sdk-resolution-anchor.cjs");
}

/**
 * A caller may hand us a directory (`resolveFrom: app.getAppPath()`), which
 * `createRequire` would treat as a file and resolve from its *parent*. Append a
 * sentinel filename so `<dir>/node_modules` is searched, which is what every
 * caller means.
 */
function anchorFile(resolveFrom: string): string {
  const resolved = path.resolve(resolveFrom);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, "ade-sdk-resolution-anchor.cjs");
    }
  } catch {
    // Not on disk: treat a trailing separator as the directory intent, and
    // anything else as a file path, which is `createRequire`'s own rule.
    if (resolved.endsWith(path.sep)) {
      return path.join(resolved, "ade-sdk-resolution-anchor.cjs");
    }
  }
  return resolved;
}

/**
 * Resolve the runtime from an installed `@ade-dev/runtime-*` package.
 *
 * Returns `null` when no matching package is installed — the caller falls
 * through to the cache, PATH, or a download. Throws `binary_not_found` only
 * when a package IS installed but does not carry what it promises, because the
 * alternative is a dlopen failure several seconds later that names no path and
 * that nobody can act on.
 */
export function resolveBundledRuntime(
  options: ResolveBundledRuntimeOptions = {},
): BundledRuntime | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  let target: string;
  try {
    target = resolveRuntimeTarget(platform, arch).target;
  } catch {
    // No runtime is published for this platform, so no package can be
    // installed for it. That is the same answer as "not installed", and the
    // caller's next step reports the unsupported platform with its own message.
    return null;
  }

  const packageName = bundledRuntimePackageName(target);
  const anchor = options.resolveFrom ? anchorFile(options.resolveFrom) : defaultResolveAnchor();

  let manifestPath: string;
  try {
    manifestPath = createRequire(anchor).resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }

  const packageRoot = path.dirname(manifestPath);
  const binaryName = platform === "win32" ? "ade.exe" : "ade";
  const binaryPath = path.join(packageRoot, "bin", binaryName);
  const runtimeRoot = path.join(packageRoot, "native");
  const nodeModulesPath = path.join(runtimeRoot, "node_modules");

  if (!isFile(binaryPath)) {
    throw new AdeError(
      "binary_not_found",
      `${packageName} is installed at ${packageRoot} but carries no runtime binary at ${binaryPath}. ` +
        `Reinstall the package, or pass binaryPath explicitly.`,
    );
  }
  if (!isDirectory(nodeModulesPath)) {
    throw new AdeError(
      "binary_not_found",
      `${packageName} is installed at ${packageRoot} but carries no native modules at ${nodeModulesPath}. ` +
        `The binary dlopens them, so it cannot start without that directory.`,
    );
  }

  let version = "";
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version?: unknown };
    if (typeof manifest.version === "string") version = manifest.version;
  } catch {
    // A version we cannot read is a reporting gap, not a resolution failure.
  }

  return { binaryPath, runtimeRoot, nodeModulesPath, packageName, version };
}
