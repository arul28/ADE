import fs from "node:fs";
import path from "node:path";

import { isValidPluginId } from "../../../shared/plugins/manifest";
import { isRecord } from "../../../shared/plugins/parse";
import type { PluginInstallRecord, PluginInstallSource } from "../../../shared/plugins/sdk";

/**
 * The one reader for `<plugins root>/state.json`.
 *
 * Four places used to parse this file, and they disagreed in ways only a user
 * could see: the CLI read an unrecognized `source.kind` as a LOCAL install
 * pointing at the plugin directory while the install service read it as a
 * builtin, the CLI dropped `disabledContributions` so `ade plugin list` showed
 * contributions the desktop had switched off, and the storage doctor re-parsed
 * the file by hand purely to tell "no registry" from "unreadable registry".
 * Those are the same question asked four times, so it is answered here once.
 *
 * Pure filesystem reads: no logger, no clock beyond the fallback below, and no
 * writes. The install service still owns every mutation — this module exists so
 * a reader that cannot hold that service still reads what the service wrote.
 */

export const PLUGIN_STATE_FILE = "state.json";

export type PluginRegistryFileContents = {
  version: 1;
  plugins: Record<string, PluginInstallRecord>;
  /** Builtin ids the user removed on purpose; seeding must not revive them. */
  removedBuiltins: string[];
};

/**
 * Why the tri-state matters: `absent` is the real answer "nothing has ever been
 * installed on this machine", and a caller may act on it — the storage doctor
 * DELETES every plugin row in a project when it holds that answer. `unreadable`
 * is "the file is there and this build could not parse it", and acting on it
 * the same way destroys a working install's data. Anything that folds the two
 * into an empty list is one corrupt file away from data loss.
 */
export type PluginRegistryFileRead =
  | { kind: "absent" }
  | { kind: "unreadable"; error: string }
  | { kind: "present"; contents: PluginRegistryFileContents };

export function pluginRegistryFilePath(pluginsRoot: string): string {
  return path.join(pluginsRoot, PLUGIN_STATE_FILE);
}

export function emptyPluginRegistryContents(): PluginRegistryFileContents {
  return { version: 1, plugins: {}, removedBuiltins: [] };
}

/**
 * An install's origin.
 *
 * Anything this build does not recognize reads as `builtin`, which is the
 * conservative answer: a builtin is re-seeded from the bundle rather than
 * re-cloned from a path or URL that the record failed to describe.
 */
export function parsePluginInstallSource(raw: unknown): PluginInstallSource {
  if (isRecord(raw)) {
    if (raw.kind === "local" && typeof raw.path === "string") return { kind: "local", path: raw.path };
    if (raw.kind === "git" && typeof raw.url === "string") {
      return { kind: "git", url: raw.url, ...(typeof raw.ref === "string" ? { ref: raw.ref } : {}) };
    }
  }
  return { kind: "builtin" };
}

export function parsePluginInstallRecord(pluginId: string, raw: unknown): PluginInstallRecord | null {
  if (!isRecord(raw)) return null;
  const installedAt = typeof raw.installedAt === "string" ? raw.installedAt : new Date().toISOString();
  const disabled = Array.isArray(raw.disabledContributions)
    ? [...new Set(raw.disabledContributions.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  return {
    pluginId,
    version: typeof raw.version === "string" ? raw.version : "0.0.0",
    enabled: raw.enabled !== false,
    source: parsePluginInstallSource(raw.source),
    installedAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : installedAt,
    // Always present after a read, so nothing downstream has to distinguish
    // "no field" from "nothing disabled" — they mean the same thing.
    disabledContributions: disabled,
  };
}

export function parsePluginRegistryContents(decoded: unknown): PluginRegistryFileContents {
  if (!isRecord(decoded) || !isRecord(decoded.plugins)) return emptyPluginRegistryContents();
  const plugins: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, raw] of Object.entries(decoded.plugins)) {
    // The registry is the source of truth for what is installed, so a key that
    // could not be a directory name is dropped here rather than defended
    // against at every path join downstream.
    if (!isValidPluginId(pluginId)) continue;
    const record = parsePluginInstallRecord(pluginId, raw);
    if (record) plugins[pluginId] = record;
  }
  const removedBuiltins = Array.isArray(decoded.removedBuiltins)
    ? [...new Set(decoded.removedBuiltins.filter(isValidPluginId))]
    : [];
  return { version: 1, plugins, removedBuiltins };
}

/** The tri-state read. Use this when "absent" and "unreadable" differ to you. */
export function readPluginRegistryFile(pluginsRoot: string): PluginRegistryFileRead {
  let text: string;
  try {
    text = fs.readFileSync(pluginRegistryFilePath(pluginsRoot), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { kind: "present", contents: parsePluginRegistryContents(JSON.parse(text)) };
  } catch (error) {
    return { kind: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The lenient read: an absent or unparseable registry yields an empty one.
 *
 * Correct for "show me what is installed" — a registry this build cannot read
 * lists nothing rather than failing the command — and WRONG for anything that
 * deletes on an empty answer. Those callers use {@link readPluginRegistryFile}.
 */
export function readPluginRegistryContents(pluginsRoot: string): PluginRegistryFileContents {
  const read = readPluginRegistryFile(pluginsRoot);
  return read.kind === "present" ? read.contents : emptyPluginRegistryContents();
}

/** Installed records by plugin id, in registry order. Lenient (see above). */
export function readPluginInstallRecords(pluginsRoot: string): Map<string, PluginInstallRecord> {
  return new Map(Object.entries(readPluginRegistryContents(pluginsRoot).plugins));
}
