import generatedManifest from "./toolsManifest.generated.json";
import { ToolError } from "./errors";
import { TOOL_TARGETS, type ToolTarget, assertSafePackageCoordinates, isToolTarget } from "./paths";

export const TOOLS_MANIFEST_SCHEMA_VERSION = 1;

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
};

export type ToolTargetPin = {
  /**
   * The npm *install directory* name — what consumers expect to find in a
   * `node_modules` tree. This is not always the published package name:
   * `@openai/codex-darwin-arm64` is an npm alias whose tarball is published
   * under `@openai/codex` at version `0.144.5-darwin-arm64`.
   */
  package: string;
  version: string;
  tarball: string;
  /** Subresource-integrity string from package-lock.json, always `sha512-…`. */
  integrity: string;
};

export type ToolPin = {
  name: string;
  description: string;
  entry: ToolEntry;
  targets: Partial<Record<ToolTarget, ToolTargetPin>>;
};

export type ToolsManifest = {
  schemaVersion: number;
  generatedFrom: string;
  tools: ToolPin[];
};

const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolError(`Invalid tools manifest: ${label} must be a non-empty string.`, { kind: "manifest" });
  }
  return value;
}

function assertSafeEntryPath(value: string, label: string): void {
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\")) {
    throw new ToolError(`Invalid tools manifest: ${label} must be a relative POSIX path.`, { kind: "manifest" });
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ToolError(`Invalid tools manifest: ${label} must not contain empty or traversal segments.`, {
      kind: "manifest",
    });
  }
}

function parseEntry(raw: unknown, toolName: string): ToolEntry {
  if (!isRecord(raw)) {
    throw new ToolError(`Invalid tools manifest: ${toolName}.entry must be an object.`, { kind: "manifest" });
  }
  const kind = requireString(raw.kind, `${toolName}.entry.kind`);
  if (kind !== "binary" && kind !== "directory") {
    throw new ToolError(`Invalid tools manifest: ${toolName}.entry.kind must be "binary" or "directory".`, {
      kind: "manifest",
      tool: toolName,
    });
  }
  const entryPath = requireString(raw.path, `${toolName}.entry.path`);
  assertSafeEntryPath(entryPath, `${toolName}.entry.path`);
  let windowsPath: string | undefined;
  if (raw.windowsPath !== undefined) {
    windowsPath = requireString(raw.windowsPath, `${toolName}.entry.windowsPath`);
    assertSafeEntryPath(windowsPath, `${toolName}.entry.windowsPath`);
  }
  return windowsPath ? { kind, path: entryPath, windowsPath } : { kind, path: entryPath };
}

function parseTargetPin(raw: unknown, toolName: string, target: string): ToolTargetPin {
  if (!isRecord(raw)) {
    throw new ToolError(`Invalid tools manifest: ${toolName}.targets.${target} must be an object.`, {
      kind: "manifest",
      tool: toolName,
    });
  }
  const packageName = requireString(raw.package, `${toolName}.targets.${target}.package`);
  const version = requireString(raw.version, `${toolName}.targets.${target}.version`);
  assertSafePackageCoordinates(packageName, version);
  const tarball = requireString(raw.tarball, `${toolName}.targets.${target}.tarball`);
  if (!tarball.startsWith("https://")) {
    throw new ToolError(`Invalid tools manifest: ${toolName}.targets.${target}.tarball must be an https URL.`, {
      kind: "manifest",
      tool: toolName,
      packageName,
    });
  }
  const integrity = requireString(raw.integrity, `${toolName}.targets.${target}.integrity`);
  if (!INTEGRITY_PATTERN.test(integrity)) {
    throw new ToolError(
      `Invalid tools manifest: ${toolName}.targets.${target}.integrity must be a base64 sha512 SRI string.`,
      { kind: "manifest", tool: toolName, packageName, version },
    );
  }
  return { package: packageName, version, tarball, integrity };
}

export function parseToolsManifest(raw: unknown): ToolsManifest {
  if (!isRecord(raw)) {
    throw new ToolError("Invalid tools manifest: expected an object.", { kind: "manifest" });
  }
  if (raw.schemaVersion !== TOOLS_MANIFEST_SCHEMA_VERSION) {
    throw new ToolError(
      `Unsupported tools manifest schemaVersion ${String(raw.schemaVersion)}; this ADE build understands ${TOOLS_MANIFEST_SCHEMA_VERSION}.`,
      { kind: "manifest" },
    );
  }
  const generatedFrom = requireString(raw.generatedFrom, "generatedFrom");
  if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
    throw new ToolError("Invalid tools manifest: tools must be a non-empty array.", { kind: "manifest" });
  }

  const seen = new Set<string>();
  const tools = raw.tools.map((rawTool) => {
    if (!isRecord(rawTool)) {
      throw new ToolError("Invalid tools manifest: every tool must be an object.", { kind: "manifest" });
    }
    const name = requireString(rawTool.name, "tool.name");
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new ToolError(`Invalid tools manifest: ${JSON.stringify(name)} is not a valid tool name.`, {
        kind: "manifest",
      });
    }
    if (seen.has(name)) {
      throw new ToolError(`Invalid tools manifest: duplicate tool ${name}.`, { kind: "manifest", tool: name });
    }
    seen.add(name);
    const description = requireString(rawTool.description, `${name}.description`);
    const entry = parseEntry(rawTool.entry, name);
    if (!isRecord(rawTool.targets)) {
      throw new ToolError(`Invalid tools manifest: ${name}.targets must be an object.`, {
        kind: "manifest",
        tool: name,
      });
    }
    const targets: Partial<Record<ToolTarget, ToolTargetPin>> = {};
    for (const [target, rawPin] of Object.entries(rawTool.targets)) {
      if (!isToolTarget(target)) {
        throw new ToolError(
          `Invalid tools manifest: ${name}.targets.${target} is not a supported target (${TOOL_TARGETS.join(", ")}).`,
          { kind: "manifest", tool: name },
        );
      }
      targets[target] = parseTargetPin(rawPin, name, target);
    }
    if (Object.keys(targets).length === 0) {
      throw new ToolError(`Invalid tools manifest: ${name} pins no targets.`, { kind: "manifest", tool: name });
    }
    return { name, description, entry, targets } satisfies ToolPin;
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
export function entryPathForPlatform(entry: ToolEntry, platform: NodeJS.Platform): string {
  return platform === "win32" && entry.windowsPath ? entry.windowsPath : entry.path;
}
