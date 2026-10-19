import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ToolResolution, type ToolsContext, tryResolveTool } from "./install";
import { RETIRED_PACKAGE_GRACE_MS } from "./ledger";
import { type ToolPin, type ToolsManifest, findToolPin, findToolTargetPin, loadToolsManifest, parseToolsManifest } from "./manifest";
import { type ToolTarget, assertSafePackageCoordinates, detectToolTarget, isToolTarget, resolveMachineToolsRoot } from "./paths";

/**
 * A newer vendor build ADE runs in place of a pin the vendor refused.
 *
 * ADE runs only its pinned copies, with one approved exception: when the
 * vendor provably refuses the pin as too old (Claude Code, Codex and Muse;
 * see `claudeFallForward.ts`, `codexFallForward.ts` and `museFallForward.ts`
 * in desktop), ADE installs the vendor's newest build
 * into the tools cache as its own version directory, probes it, and records it
 * here. The record names the pin it replaces, so it ends by itself when an ADE
 * update moves the pin: resolution honours it only while `pinnedVersion` is
 * still the manifest's pin for the host and its install is complete.
 *
 * One file per tools root (`.version-overrides.json`), so it lives on the
 * machine whose brain runs the chat and is shared by every ADE channel there.
 * Records are keyed by tool, target and the pin they replace; a channel that
 * pins something else ignores them. `gcTools` keeps the directory of every
 * record and refreshes the records its own manifest still uses; a record no
 * channel has used for the ledger's grace period is dropped. Writes are
 * tmp-file + rename.
 */
const OVERRIDES_FILE = ".version-overrides.json";
const OVERRIDES_SCHEMA_VERSION = 1;

export type ToolVersionOverride = {
  tool: string;
  target: ToolTarget;
  packageName: string;
  /** The manifest pin (package version) this override replaces. */
  pinnedVersion: string;
  /** The package version installed and run instead. */
  overrideVersion: string;
  /**
   * How the override installs: an npm tarball (`tarball` + `integrity`, the
   * default) or a bare vendor file (`url` + `sha256` + `size`, Muse).
   */
  format: "npm-tarball" | "file";
  /** Registry tarball and SRI the override was installed from and verified against (npm). Empty for a file. */
  tarball: string;
  integrity: string;
  /** Vendor URL, sha256 and byte size the override was installed from (file). */
  url?: string;
  sha256?: string;
  size?: number;
  /** What the refusal was limited to, when it was (Codex: the model). */
  scope?: string | null;
  /** The vendor's signal that refused the pin (e.g. `startup_min_version`). */
  reason: string;
  /** The tool's own version the vendor required, when it named one. */
  requiredVersion: string | null;
  /** The tool's own version the vendor refused (what the pin runs). */
  rejectedToolVersion: string | null;
  /** The tool's own version the override reported when probed. */
  overrideToolVersion: string | null;
  /** When the override was recorded (ISO). */
  at: string;
  /** Epoch ms an ADE build that pins `pinnedVersion` last collected garbage; GC grace runs from here. */
  lastUsedAt: number;
};

function overridesPath(toolsRoot: string): string {
  return path.join(toolsRoot, OVERRIDES_FILE);
}

function rootFor(context: ToolsContext): string {
  return context.toolsRoot ? path.resolve(context.toolsRoot) : resolveMachineToolsRoot(context.env ?? process.env, context.platform ?? process.platform);
}

function parseOverride(raw: unknown): ToolVersionOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const text = (key: string): string | null => (typeof value[key] === "string" && (value[key] as string).trim() ? value[key] as string : null);
  const tool = text("tool");
  const target = text("target");
  const packageName = text("packageName");
  const pinnedVersion = text("pinnedVersion");
  const overrideVersion = text("overrideVersion");
  const format = value.format === "file" ? "file" : value.format === undefined || value.format === "npm-tarball" ? "npm-tarball" : null;
  const tarball = text("tarball");
  const integrity = text("integrity");
  const url = text("url");
  const sha256 = text("sha256");
  const size = typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size > 0 ? value.size : null;
  const reason = text("reason");
  const at = text("at");
  if (!tool || !target || !isToolTarget(target) || !packageName || !pinnedVersion || !overrideVersion || !format || !reason || !at) {
    return null;
  }
  if (format === "npm-tarball" ? !tarball || !integrity : !url || !sha256 || size == null) return null;
  try {
    // Both become path segments under the tools root.
    assertSafePackageCoordinates(packageName, pinnedVersion);
    assertSafePackageCoordinates(packageName, overrideVersion);
  } catch {
    return null;
  }
  return {
    tool,
    target,
    packageName,
    pinnedVersion,
    overrideVersion,
    format,
    tarball: tarball ?? "",
    integrity: integrity ?? "",
    ...(format === "file" ? { url: url!, sha256: sha256!, size: size! } : {}),
    scope: text("scope"),
    reason,
    requiredVersion: text("requiredVersion"),
    rejectedToolVersion: text("rejectedToolVersion"),
    overrideToolVersion: text("overrideToolVersion"),
    at,
    lastUsedAt: typeof value.lastUsedAt === "number" && Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : 0,
  };
}

function parseOverrides(raw: unknown): ToolVersionOverride[] {
  const list = (raw as { overrides?: unknown } | null)?.overrides;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const parsed = parseOverride(entry);
    return parsed ? [parsed] : [];
  });
}

let readCache: { file: string; mtimeMs: number; size: number; overrides: ToolVersionOverride[] } | null = null;

/**
 * Every recorded override under the tools root. Synchronous and cached on the
 * file's mtime, because executable resolvers read it on every spawn. A
 * missing or unreadable file is no overrides.
 */
export function readToolVersionOverrides(context: ToolsContext = {}): ToolVersionOverride[] {
  const file = overridesPath(rootFor(context));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  if (readCache && readCache.file === file && readCache.mtimeMs === stat.mtimeMs && readCache.size === stat.size) {
    return readCache.overrides;
  }
  let overrides: ToolVersionOverride[] = [];
  try {
    overrides = parseOverrides(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    overrides = [];
  }
  readCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, overrides };
  return overrides;
}

async function writeOverrides(toolsRoot: string, overrides: readonly ToolVersionOverride[]): Promise<void> {
  await fsp.mkdir(toolsRoot, { recursive: true });
  const target = overridesPath(toolsRoot);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify({ schemaVersion: OVERRIDES_SCHEMA_VERSION, overrides }, null, 2)}\n`, "utf8");
  try {
    await fsp.rename(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sameSlot(left: Pick<ToolVersionOverride, "tool" | "target" | "pinnedVersion">, right: Pick<ToolVersionOverride, "tool" | "target" | "pinnedVersion">): boolean {
  return left.tool === right.tool && left.target === right.target && left.pinnedVersion === right.pinnedVersion;
}

/** Record (or replace) the override for its tool, target and pin. */
export async function writeToolVersionOverride(override: ToolVersionOverride, context: ToolsContext = {}): Promise<void> {
  const toolsRoot = rootFor(context);
  const kept = readToolVersionOverrides({ ...context, toolsRoot }).filter((existing) => !sameSlot(existing, override));
  await writeOverrides(toolsRoot, [...kept, override]);
}

/**
 * The manifest with `override` as the tool's pin for its target: what
 * installs and resolves the override through the tools cache's own
 * npm-tarball path (registry host lock, SRI check, sentinel). Validated like
 * the bundled manifest, so a record cannot point a download anywhere else.
 */
export function manifestWithOverride(
  override: Pick<ToolVersionOverride, "tool" | "target" | "packageName" | "overrideVersion" | "tarball" | "integrity">
    & Partial<Pick<ToolVersionOverride, "format" | "url" | "sha256" | "size">>,
  base: ToolsManifest = loadToolsManifest(),
): ToolsManifest {
  const pin: ToolPin = findToolPin(base, override.tool);
  const targetPin = override.format === "file"
    ? {
      format: "file",
      package: override.packageName,
      version: override.overrideVersion,
      url: override.url,
      sha256: override.sha256,
      size: override.size,
    }
    : {
      package: override.packageName,
      version: override.overrideVersion,
      tarball: override.tarball,
      integrity: override.integrity,
    };
  return parseToolsManifest({
    schemaVersion: base.schemaVersion,
    generatedFrom: `version override of ${override.tool}`,
    tools: [{
      name: pin.name,
      description: pin.description,
      entry: pin.entry,
      targets: { [override.target]: targetPin },
    }],
  });
}

/** The override in force for `name` on this host, and its installed copy. */
export type ActiveToolVersionOverride = { override: ToolVersionOverride; resolution: ToolResolution };

/**
 * The override for `name` that resolution should run now, or null: only one
 * recorded for this host's target and the manifest's current pin of `name`
 * (same package, same version), whose install is complete. Never throws,
 * never touches the network.
 */
export function resolveActiveToolVersionOverride(name: string, context: ToolsContext = {}): ActiveToolVersionOverride | null {
  try {
    const manifest = context.manifest ?? loadToolsManifest();
    const target = context.target ?? detectToolTarget(context.platform ?? process.platform, context.arch ?? os.arch());
    const pin = findToolTargetPin(manifest, name, target);
    if (pin.format !== "npm-tarball" && pin.format !== "file") return null;
    const override = readToolVersionOverrides(context).find((entry) =>
      entry.tool === name && entry.target === target && entry.packageName === pin.package && entry.pinnedVersion === pin.version
      && entry.format === pin.format);
    if (!override) return null;
    const resolution = tryResolveTool(name, { ...context, target, manifest: manifestWithOverride(override, manifest) });
    return resolution ? { override, resolution } : null;
  } catch {
    return null;
  }
}

/**
 * For `gcTools`: the override version of each package to keep, after
 * refreshing the records this manifest still uses and dropping those no ADE
 * build has used within the grace period. The kept directories stay out of
 * the "newest superseded version" ranking, so the real previous pin is still
 * kept beside them.
 */
export async function collectToolVersionOverrides(
  toolsRoot: string,
  pinnedVersionsByPackage: ReadonlyMap<string, ReadonlySet<string>>,
  options: { dryRun: boolean; now?: number },
): Promise<Map<string, Set<string>>> {
  const now = options.now ?? Date.now();
  const overrides = readToolVersionOverrides({ toolsRoot });
  const kept: ToolVersionOverride[] = [];
  let changed = false;
  for (const override of overrides) {
    const inUse = pinnedVersionsByPackage.get(override.packageName)?.has(override.pinnedVersion) === true;
    if (inUse) {
      kept.push({ ...override, lastUsedAt: now });
      changed = true;
    } else if (now - override.lastUsedAt < RETIRED_PACKAGE_GRACE_MS) {
      kept.push(override);
    } else {
      changed = true;
    }
  }
  if (changed && !options.dryRun) await writeOverrides(toolsRoot, kept).catch(() => undefined);
  const keep = new Map<string, Set<string>>();
  for (const override of kept) {
    const versions = keep.get(override.packageName) ?? new Set<string>();
    versions.add(override.overrideVersion);
    keep.set(override.packageName, versions);
  }
  return keep;
}
