import generatedManifest from "./toolsManifest.generated.json";
import { ToolError, type ToolErrorContext } from "./errors";
import { TOOL_TARGETS, type ToolTarget, assertSafePackageCoordinates, isToolTarget } from "./paths";

export const TOOLS_MANIFEST_SCHEMA_VERSION = 1;

/** A named file a tool needs besides its main entry (Antigravity's harness, Qwen's script). */
export type ToolEntryFile = {
  /** Package-relative POSIX path; literal, never a `*` glob. */
  path: string;
  windowsPath?: string;
  /** Marked executable after install, off Windows. */
  executable?: boolean;
};

/** Where a consumer finds the thing it actually wants inside the package. */
export type ToolEntry = {
  kind: "binary" | "directory";
  /**
   * Package-relative POSIX-separated path. A `*` segment matches exactly one
   * directory level and is expanded at resolve time — `@openai/codex-*` nests
   * its binary under a Rust target triple (`vendor/aarch64-apple-darwin/bin`)
   * that the manifest generator cannot know without unpacking the tarball, and
   * `codexExecutable.ts` already probes it as a glob.
   */
  path: string;
  /** Windows spelling, when the executable carries a `.exe` suffix. */
  windowsPath?: string;
  /**
   * Further files that must exist for the install to count, by name. Each is
   * resolved to an absolute path next to `entryPath` (`ToolResolution.files`),
   * so a caller never rebuilds a path inside the cache by hand.
   */
  files?: Record<string, ToolEntryFile>;
};

/**
 * A file inside the unpacked payload that ships brotli-compressed and is
 * decompressed in place after extraction. Grok's npm platform packages carry
 * `bin/grok.br`; their own postinstall inflates it, and ADE runs no install
 * scripts. The archive's integrity covers the compressed bytes, so the
 * inflated file is as trusted as the download.
 */
export type ToolDecompressStep = {
  algorithm: "brotli";
  from: string;
  to: string;
};

/**
 * A tool published as an npm platform package. The tarball is unpacked with
 * npm's `package/` root stripped, so the cache directory mirrors a
 * `node_modules/<pkg>` tree.
 */
export type NpmTarballTargetPin = {
  format: "npm-tarball";
  /**
   * The npm *install directory* name — what consumers expect to find in a
   * `node_modules` tree. This is not always the published package name:
   * `@openai/codex-darwin-arm64` is an npm alias whose tarball is published
   * under `@openai/codex` at version `0.164.0-darwin-arm64`.
   */
  package: string;
  version: string;
  tarball: string;
  /** Subresource-integrity string from package-lock.json, always `sha512-…`. */
  integrity: string;
  decompress?: ToolDecompressStep[];
};

/**
 * A tool published as one bare executable (Meta's `muse`). The downloaded file
 * *is* the binary: nothing is unpacked, it is written to the entry path and
 * marked executable. Pins come from the vendor's own release manifest, which
 * publishes a sha256 and a byte size per artifact.
 */
export type FileTargetPin = {
  format: "file";
  /** Cache directory name; not an npm package, only a path segment. */
  package: string;
  version: string;
  url: string;
  /** Lowercase hex sha256 of the whole file. */
  sha256: string;
  /** Exact byte size, used for the disk-space preflight and a truncation check. */
  size: number;
};

/**
 * A vendor release archive (`.tar.gz` or `.zip`) from the vendor's own host:
 * Devin, Kimi, Qwen's standalone bundle, Antigravity. Checked against the
 * pinned sha256 and size before a single entry is unpacked.
 */
export type ArchiveTargetPin = {
  format: "archive";
  /** Cache directory name; not an npm package, only a path segment. */
  package: string;
  version: string;
  url: string;
  archive: "tar.gz" | "zip";
  /** Leading path segments dropped from every member, like tar's `--strip-components`. */
  stripComponents: number;
  /** Lowercase hex sha256 of the whole archive. */
  sha256: string;
  size: number;
  decompress?: ToolDecompressStep[];
};

/** One package of an `npm-tree` pin, exactly as the lockfile places it. */
export type NpmTreePackage = {
  /** The lockfile key, e.g. `node_modules/@scope/name/node_modules/dep`. */
  path: string;
  tarball: string;
  integrity: string;
  /** Tarball bytes, for the disk preflight, progress, and a truncation check. */
  size: number;
};

/**
 * A pure-JS package with its whole dependency tree (Pi's SDK), recreated as
 * the exact `node_modules` layout of a lockfile. Every package is its own
 * registry tarball checked by its own SRI; nothing runs install scripts, and
 * the generator has already dropped packages whose os/cpu exclude the target.
 */
export type NpmTreeTargetPin = {
  format: "npm-tree";
  /** Cache directory name; not an npm package, only a path segment. */
  package: string;
  version: string;
  packages: NpmTreePackage[];
  /** Sum of the packages' published unpacked sizes, for the disk preflight. */
  unpackedSize: number;
};

export type ToolTargetPin = NpmTarballTargetPin | FileTargetPin | ArchiveTargetPin | NpmTreeTargetPin;

/**
 * The npm registry, the only host an npm-format pin may download from (lockfile
 * `resolved` URLs never leave it).
 */
const NPM_REGISTRY_HOSTS = ["registry.npmjs.org"] as const;

/** GitHub release downloads 302 to a signed, short-lived URL on its asset CDN. */
const GITHUB_RELEASE_HOSTS = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"] as const;

/**
 * Where a vendor-hosted (`file` / `archive`) pin of each tool may download
 * from. The pinned URL must be on the first host; redirects may land only on
 * a host in the same list, and only over HTTPS. A tool missing from this table
 * cannot have a vendor-hosted pin at all. `scripts/file-pin-host.mjs` holds the
 * same table for the pin scripts and the generator (they cannot import
 * TypeScript); the two must stay identical.
 */
const VENDOR_DOWNLOAD_HOSTS: Readonly<Record<string, readonly string[]>> = {
  muse: ["lookaside.facebook.com"],
  devin: ["static.devin.ai"],
  antigravity: ["dl.google.com"],
  kimi: GITHUB_RELEASE_HOSTS,
  qwen: GITHUB_RELEASE_HOSTS,
  "cursor-cli": ["downloads.cursor.com"],
  node: ["nodejs.org"],
};

/**
 * Every host a download of this pin may touch, the pinned URL's own host first.
 * The downloader refuses a redirect anywhere else.
 */
export function allowedDownloadHosts(toolName: string, pin: ToolTargetPin): readonly string[] {
  if (pin.format === "npm-tarball" || pin.format === "npm-tree") return NPM_REGISTRY_HOSTS;
  return VENDOR_DOWNLOAD_HOSTS[toolName] ?? [];
}

export type ToolPin = {
  name: string;
  description: string;
  entry: ToolEntry;
  /**
   * True when a source checkout already has this tool in its `node_modules`
   * (the lockfile pins it), so a dev run never downloads it. Absent for tools
   * that exist only as a download.
   */
  checkoutCopy?: boolean;
  targets: Partial<Record<ToolTarget, ToolTargetPin>>;
};

export type ToolsManifest = {
  schemaVersion: number;
  generatedFrom: string;
  tools: ToolPin[];
};

const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ENTRY_FILE_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;
/** Deep enough for every vendor layout, shallow enough to catch a typo. */
const MAX_STRIP_COMPONENTS = 3;
/** `node_modules/<name>` repeated, each name an npm package name with at most one scope. */
const NPM_TREE_PATH_PATTERN =
  /^node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function manifestError(message: string, context: Omit<ToolErrorContext, "kind"> = {}): ToolError {
  return new ToolError(`Invalid tools manifest: ${message}`, { kind: "manifest", ...context });
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw manifestError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string, context: Omit<ToolErrorContext, "kind">): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw manifestError(`${label} must be a positive integer.`, context);
  }
  return value;
}

function assertSafeEntryPath(value: string, label: string): void {
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\")) {
    throw manifestError(`${label} must be a relative POSIX path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw manifestError(`${label} must not contain empty or traversal segments.`);
  }
}

function assertLiteralPath(value: string, label: string): void {
  if (value.split("/").includes("*")) throw manifestError(`${label} must be a literal path, without a * segment.`);
}

function parseOptionalPath(raw: Record<string, unknown>, key: string, label: string): string | undefined {
  if (raw[key] === undefined) return undefined;
  const value = requireString(raw[key], `${label}.${key}`);
  assertSafeEntryPath(value, `${label}.${key}`);
  return value;
}

function parseEntryFiles(raw: unknown, toolName: string): Record<string, ToolEntryFile> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    throw manifestError(`${toolName}.entry.files must be a non-empty object.`, { tool: toolName });
  }
  const files: Record<string, ToolEntryFile> = {};
  for (const [name, rawFile] of Object.entries(raw)) {
    const label = `${toolName}.entry.files.${name}`;
    if (!ENTRY_FILE_NAME_PATTERN.test(name)) throw manifestError(`${label} is not a valid file name.`, { tool: toolName });
    if (!isRecord(rawFile)) throw manifestError(`${label} must be an object.`, { tool: toolName });
    const filePath = requireString(rawFile.path, `${label}.path`);
    assertSafeEntryPath(filePath, `${label}.path`);
    assertLiteralPath(filePath, `${label}.path`);
    const windowsPath = parseOptionalPath(rawFile, "windowsPath", label);
    if (windowsPath) assertLiteralPath(windowsPath, `${label}.windowsPath`);
    if (rawFile.executable !== undefined && typeof rawFile.executable !== "boolean") {
      throw manifestError(`${label}.executable must be a boolean.`, { tool: toolName });
    }
    files[name] = {
      path: filePath,
      ...(windowsPath ? { windowsPath } : {}),
      ...(rawFile.executable === true ? { executable: true } : {}),
    };
  }
  return files;
}

function parseEntry(raw: unknown, toolName: string): ToolEntry {
  if (!isRecord(raw)) {
    throw manifestError(`${toolName}.entry must be an object.`);
  }
  const kind = requireString(raw.kind, `${toolName}.entry.kind`);
  if (kind !== "binary" && kind !== "directory") {
    throw manifestError(`${toolName}.entry.kind must be "binary" or "directory".`, { tool: toolName });
  }
  const entryPath = requireString(raw.path, `${toolName}.entry.path`);
  assertSafeEntryPath(entryPath, `${toolName}.entry.path`);
  const windowsPath = parseOptionalPath(raw, "windowsPath", `${toolName}.entry`);
  const files = parseEntryFiles(raw.files, toolName);
  return {
    kind,
    path: entryPath,
    ...(windowsPath ? { windowsPath } : {}),
    ...(files ? { files } : {}),
  };
}

type PinContext = { tool: string; packageName: string; version?: string };

/**
 * The URL must be HTTPS and on the first host this pin may use: the npm
 * registry for npm formats, the tool's vendor host otherwise.
 */
function requirePinnedUrl(value: unknown, label: string, hosts: readonly string[], context: PinContext): string {
  const url = requireString(value, label);
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.protocol !== "https:") {
    throw manifestError(`${label} must be an https URL.`, { ...context, packageName: context.packageName });
  }
  const origin = hosts[0];
  if (!origin) {
    throw manifestError(`${label}: ${context.tool} has no download host ADE allows for a vendor-hosted pin.`, context);
  }
  if (parsed.host !== origin) {
    throw manifestError(`${label} must be on ${origin}.`, context);
  }
  return url;
}

function requireSha256(value: unknown, label: string, context: PinContext): string {
  const sha256 = requireString(value, label);
  if (!SHA256_HEX_PATTERN.test(sha256)) {
    throw manifestError(`${label} must be 64 lowercase hex characters.`, context);
  }
  return sha256;
}

function requireIntegrity(value: unknown, label: string, context: PinContext): string {
  const integrity = requireString(value, label);
  if (!INTEGRITY_PATTERN.test(integrity)) {
    throw manifestError(`${label} must be a base64 sha512 SRI string.`, context);
  }
  return integrity;
}

function parseDecompress(raw: unknown, label: string, context: PinContext): ToolDecompressStep[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw manifestError(`${label} must be a non-empty array.`, context);
  return raw.map((rawStep, index) => {
    const stepLabel = `${label}[${index}]`;
    if (!isRecord(rawStep) || rawStep.algorithm !== "brotli") {
      throw manifestError(`${stepLabel}.algorithm must be "brotli".`, context);
    }
    const from = requireString(rawStep.from, `${stepLabel}.from`);
    const to = requireString(rawStep.to, `${stepLabel}.to`);
    for (const [value, key] of [[from, "from"], [to, "to"]] as const) {
      assertSafeEntryPath(value, `${stepLabel}.${key}`);
      assertLiteralPath(value, `${stepLabel}.${key}`);
    }
    if (from === to) throw manifestError(`${stepLabel} must write a different path than it reads.`, context);
    return { algorithm: "brotli", from, to };
  });
}

function parseNpmTreePackages(raw: unknown, label: string, context: PinContext): NpmTreePackage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw manifestError(`${label} must be a non-empty array.`, context);
  const seen = new Set<string>();
  return raw.map((rawPackage, index) => {
    const packageLabel = `${label}[${index}]`;
    if (!isRecord(rawPackage)) throw manifestError(`${packageLabel} must be an object.`, context);
    const treePath = requireString(rawPackage.path, `${packageLabel}.path`);
    if (!NPM_TREE_PATH_PATTERN.test(treePath)) {
      throw manifestError(`${packageLabel}.path must be a lockfile node_modules path.`, context);
    }
    if (seen.has(treePath)) throw manifestError(`${packageLabel}.path ${treePath} is listed twice.`, context);
    seen.add(treePath);
    return {
      path: treePath,
      tarball: requirePinnedUrl(rawPackage.tarball, `${packageLabel}.tarball`, NPM_REGISTRY_HOSTS, context),
      integrity: requireIntegrity(rawPackage.integrity, `${packageLabel}.integrity`, context),
      size: requirePositiveInteger(rawPackage.size, `${packageLabel}.size`, context),
    };
  });
}

function parseTargetPin(raw: unknown, toolName: string, target: string): ToolTargetPin {
  if (!isRecord(raw)) {
    throw manifestError(`${toolName}.targets.${target} must be an object.`, { tool: toolName });
  }
  const label = `${toolName}.targets.${target}`;
  const packageName = requireString(raw.package, `${label}.package`);
  const version = requireString(raw.version, `${label}.version`);
  assertSafePackageCoordinates(packageName, version);
  const context: PinContext = { tool: toolName, packageName, version };
  // Absent means npm-tarball: every pin written before other formats existed.
  const format = raw.format ?? "npm-tarball";
  const vendorHosts = VENDOR_DOWNLOAD_HOSTS[toolName] ?? [];
  if (format === "file") {
    return {
      format: "file",
      package: packageName,
      version,
      url: requirePinnedUrl(raw.url, `${label}.url`, vendorHosts, context),
      sha256: requireSha256(raw.sha256, `${label}.sha256`, context),
      size: requirePositiveInteger(raw.size, `${label}.size`, context),
    };
  }
  if (format === "archive") {
    const archive = raw.archive;
    if (archive !== "tar.gz" && archive !== "zip") {
      throw manifestError(`${label}.archive must be "tar.gz" or "zip".`, context);
    }
    const stripComponents = raw.stripComponents;
    if (
      typeof stripComponents !== "number"
      || !Number.isInteger(stripComponents)
      || stripComponents < 0
      || stripComponents > MAX_STRIP_COMPONENTS
    ) {
      throw manifestError(`${label}.stripComponents must be an integer from 0 to ${MAX_STRIP_COMPONENTS}.`, context);
    }
    const decompress = parseDecompress(raw.decompress, `${label}.decompress`, context);
    return {
      format: "archive",
      package: packageName,
      version,
      url: requirePinnedUrl(raw.url, `${label}.url`, vendorHosts, context),
      archive,
      stripComponents,
      sha256: requireSha256(raw.sha256, `${label}.sha256`, context),
      size: requirePositiveInteger(raw.size, `${label}.size`, context),
      ...(decompress ? { decompress } : {}),
    };
  }
  if (format === "npm-tree") {
    return {
      format: "npm-tree",
      package: packageName,
      version,
      packages: parseNpmTreePackages(raw.packages, `${label}.packages`, context),
      unpackedSize: requirePositiveInteger(raw.unpackedSize, `${label}.unpackedSize`, context),
    };
  }
  if (format !== "npm-tarball") {
    throw manifestError(`${label}.format must be "npm-tarball", "file", "archive" or "npm-tree".`, context);
  }
  const decompress = parseDecompress(raw.decompress, `${label}.decompress`, context);
  return {
    format: "npm-tarball",
    package: packageName,
    version,
    tarball: requirePinnedUrl(raw.tarball, `${label}.tarball`, NPM_REGISTRY_HOSTS, context),
    integrity: requireIntegrity(raw.integrity, `${label}.integrity`, context),
    ...(decompress ? { decompress } : {}),
  };
}

export function parseToolsManifest(raw: unknown): ToolsManifest {
  if (!isRecord(raw)) {
    throw manifestError("expected an object.");
  }
  if (raw.schemaVersion !== TOOLS_MANIFEST_SCHEMA_VERSION) {
    throw new ToolError(
      `Unsupported tools manifest schemaVersion ${String(raw.schemaVersion)}; this ADE build understands ${TOOLS_MANIFEST_SCHEMA_VERSION}.`,
      { kind: "manifest" },
    );
  }
  const generatedFrom = requireString(raw.generatedFrom, "generatedFrom");
  if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
    throw manifestError("tools must be a non-empty array.");
  }

  const seen = new Set<string>();
  const tools = raw.tools.map((rawTool) => {
    if (!isRecord(rawTool)) {
      throw manifestError("every tool must be an object.");
    }
    const name = requireString(rawTool.name, "tool.name");
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw manifestError(`${JSON.stringify(name)} is not a valid tool name.`);
    }
    if (seen.has(name)) {
      throw manifestError(`duplicate tool ${name}.`, { tool: name });
    }
    seen.add(name);
    const description = requireString(rawTool.description, `${name}.description`);
    const entry = parseEntry(rawTool.entry, name);
    if (rawTool.checkoutCopy !== undefined && typeof rawTool.checkoutCopy !== "boolean") {
      throw manifestError(`${name}.checkoutCopy must be a boolean.`, { tool: name });
    }
    if (!isRecord(rawTool.targets)) {
      throw manifestError(`${name}.targets must be an object.`, { tool: name });
    }
    const targets: Partial<Record<ToolTarget, ToolTargetPin>> = {};
    for (const [target, rawPin] of Object.entries(rawTool.targets)) {
      if (!isToolTarget(target)) {
        throw manifestError(
          `${name}.targets.${target} is not a supported target (${TOOL_TARGETS.join(", ")}).`,
          { tool: name },
        );
      }
      targets[target] = parseTargetPin(rawPin, name, target);
    }
    if (Object.keys(targets).length === 0) {
      throw manifestError(`${name} pins no targets.`, { tool: name });
    }
    const hasFilePin = Object.values(targets).some((targetPin) => targetPin?.format === "file");
    // A file pin is written straight to its entry path, so that path has to
    // name one concrete file: no glob segment to expand, no directory entry,
    // nothing else beside it.
    if (
      hasFilePin
      && (
        entry.kind !== "binary"
        || entry.files !== undefined
        || [entry.path, entry.windowsPath].some((value) => value?.split("/").includes("*"))
      )
    ) {
      throw manifestError(`${name} pins a bare file, so its entry must be one binary with a literal path.`, {
        tool: name,
      });
    }
    return {
      name,
      description,
      entry,
      ...(rawTool.checkoutCopy === true ? { checkoutCopy: true } : {}),
      targets,
    } satisfies ToolPin;
  });

  return { schemaVersion: TOOLS_MANIFEST_SCHEMA_VERSION, generatedFrom, tools };
}

let cachedManifest: ToolsManifest | null = null;

/** The manifest generated from `package-lock.json` and bundled with the CLI. */
export function loadToolsManifest(): ToolsManifest {
  if (!cachedManifest) cachedManifest = parseToolsManifest(generatedManifest);
  return cachedManifest;
}

export function findToolPin(manifest: ToolsManifest, name: string): ToolPin {
  const pin = manifest.tools.find((tool) => tool.name === name);
  if (!pin) {
    const known = manifest.tools.map((tool) => tool.name).join(", ");
    throw new ToolError(`Unknown ADE agent tool ${JSON.stringify(name)}. Pinned tools: ${known}.`, {
      kind: "manifest",
      tool: name,
    });
  }
  return pin;
}

export function findToolTargetPin(manifest: ToolsManifest, name: string, target: ToolTarget): ToolTargetPin {
  const pin = findToolPin(manifest, name);
  const targetPin = pin.targets[target];
  if (!targetPin) {
    throw new ToolError(`ADE agent tool ${name} has no pinned build for ${target}.`, {
      kind: "unsupported-target",
      tool: name,
      target,
    });
  }
  return targetPin;
}

/** Package-relative entry path for a platform, in POSIX separators. */
export function entryPathForPlatform(entry: Pick<ToolEntry, "path" | "windowsPath">, platform: NodeJS.Platform): string {
  return platform === "win32" && entry.windowsPath ? entry.windowsPath : entry.path;
}
