import fs from "node:fs";
import path from "node:path";
import { AdeError } from "./errors.js";
import { isDirectory, isFile } from "./fsProbe.js";

/**
 * The runtime a host copied into its own app bundle.
 *
 * A signed, notarized app carries the runtime as `extraResources`, at
 * `<resourcesPath>/ade-runtime/{bin,native}` — the layout of an
 * `@ade-dev/runtime-<target>` package, copied whole. Every such host then
 * wrote the same three `path.join` calls by hand and reported
 * `doctor().runtime.source` as `"explicit"`, which says nothing about whether
 * the app ran the copy it signed. This helper owns the layout and the label.
 */

/** Options for {@link resolvePackagedRuntime}. */
export type ResolvePackagedRuntimeOptions = {
  /** Directory under `resourcesPath` that holds the runtime. Defaults to `"ade-runtime"`. */
  dir?: string;
  /** Defaults to `process.platform`. Decides the binary name and the Mach-O check. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.arch`. The architecture the binary must be able to run. */
  arch?: string;
};

/**
 * Spread straight into `createAdeChat`:
 *
 *   createAdeChat({ ...resolvePackagedRuntime(process.resourcesPath), home, allowDownload: false })
 *
 * The field names ARE the `createAdeChat` option names, which is the point:
 * no host-side mapping to get wrong. `source: "packaged"` makes
 * `doctor().runtime.source` report `"packaged"`.
 */
export type PackagedRuntime = {
  /** Absolute path of `bin/ade` (`bin/ade.exe` on Windows). */
  binaryPath: string;
  /** Absolute path of `native/`, which becomes `ADE_RUNTIME_ROOT`. */
  runtimeRoot: string;
  /** Absolute path of `native/node_modules`, which becomes `ADE_RUNTIME_NODE_MODULES`. */
  runtimeNodeModules: string;
  source: "packaged";
};

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

const CPU_TYPE_BY_ARCH: Record<string, number> = { arm64: CPU_TYPE_ARM64, x64: CPU_TYPE_X86_64 };

/**
 * The CPU types a Mach-O file contains, or null when the header is not one
 * this function recognizes (not Mach-O, unreadable, truncated).
 *
 * Reads the first 4 KiB only. A universal binary lists every slice's CPU type
 * in its fat header, which always fits.
 */
function machOCpuTypes(filePath: string): number[] | null {
  let header: Buffer;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      header = Buffer.alloc(4096);
      const read = fs.readSync(fd, header, 0, header.length, 0);
      header = header.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  if (header.length < 8) return null;
  const magicBE = header.readUInt32BE(0);
  if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
    const count = header.readUInt32BE(4);
    const entrySize = magicBE === FAT_MAGIC_64 ? 32 : 20;
    const types: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const offset = 8 + index * entrySize;
      if (offset + 4 > header.length) break;
      types.push(header.readUInt32BE(offset));
    }
    return types.length > 0 ? types : null;
  }
  const magicLE = header.readUInt32LE(0);
  if (magicLE === MH_MAGIC_64) return [header.readUInt32LE(4)];
  if (magicLE === MH_CIGAM_64) return [header.readUInt32BE(4)];
  return null;
}

/**
 * Resolve the runtime a host bundled under its resources directory.
 *
 * Returns null — so the caller can fall back to `resolveBundledRuntime()` in
 * development — when:
 *   - `<resourcesPath>/<dir>/bin/ade[.exe]` does not exist; or
 *   - on macOS, the binary's Mach-O header names no slice for `arch`. An
 *     arm64-only runtime inside an app running under Rosetta on Intel would
 *     otherwise fail at spawn with an error that names neither architecture.
 *     A universal binary matches when it contains the arch. A header this
 *     function does not recognize is not treated as a mismatch.
 *
 * Throws `AdeError("binary_not_found")`, naming the path, when the binary is
 * there but `native/node_modules` is not: the binary dlopens those modules,
 * so a bundle missing them is a packaging mistake to fail on, not a fallback
 * to take quietly.
 */
export function resolvePackagedRuntime(
  resourcesPath: string,
  opts: ResolvePackagedRuntimeOptions = {},
): PackagedRuntime | null {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const dir = opts.dir?.trim() || "ade-runtime";
  if (typeof resourcesPath !== "string" || !resourcesPath.trim()) return null;
  const root = path.resolve(resourcesPath, dir);
  const binaryPath = path.join(root, "bin", platform === "win32" ? "ade.exe" : "ade");
  if (!isFile(binaryPath)) return null;

  if (platform === "darwin") {
    const wanted = CPU_TYPE_BY_ARCH[arch];
    const types = machOCpuTypes(binaryPath);
    if (wanted !== undefined && types && !types.includes(wanted)) return null;
  }

  const runtimeRoot = path.join(root, "native");
  const runtimeNodeModules = path.join(runtimeRoot, "node_modules");
  if (!isDirectory(runtimeNodeModules)) {
    throw new AdeError(
      "binary_not_found",
      `The packaged ADE runtime at ${binaryPath} has no native modules at ${runtimeNodeModules}. ` +
        `Copy the whole runtime package (bin/ and native/) into the app's resources.`,
    );
  }
  return { binaryPath, runtimeRoot, runtimeNodeModules, source: "packaged" };
}
