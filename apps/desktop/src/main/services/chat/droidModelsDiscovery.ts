import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createSession } from "@factory/droid-sdk";
import {
  createDynamicDroidCliModelDescriptor,
  sortDroidCliDescriptorsForPicker,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { spawnAsync } from "../shared/utils";

export type DroidExecHelpModelRow = {
  id: string;
  displayName: string;
  /** True when sourced from ~/.factory/config.json (vibeproxy / custom proxy). */
  customProxy?: boolean;
};
type DroidCliModelDiscoveryMode = "probe" | "cached-or-fallback";

let cached: { at: number; models: DroidExecHelpModelRow[] } | null = null;
let inflight: Promise<DroidExecHelpModelRow[]> | null = null;
const TTL_MS = 120_000;

export function parseDroidExecHelpModels(stdout: string): DroidExecHelpModelRow[] {
  const lines = stdout.split(/\r?\n/);
  const rows: DroidExecHelpModelRow[] = [];
  const seen = new Set<string>();
  let inModelSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(Available Models|Custom Models):$/i.test(trimmed)) {
      inModelSection = true;
      continue;
    }
    if (!inModelSection) continue;
    if (!trimmed.length) continue;
    if (
      /^(Model details|Authentication|Examples|Autonomy Levels|Mission Mode|Session Flags|Tool Controls):$/i.test(trimmed)
      || /^[-A-Z][\w -]+:$/i.test(trimmed)
    ) {
      break;
    }
    const match = line.match(/^\s{2,}([a-z0-9][\w.:()+-]*)\s{2,}(.+?)\s*$/i);
    if (!match) continue;
    const id = match[1].trim();
    const displayName = match[2].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, displayName });
  }

  return rows;
}

export function parseDroidExecHelpModelIds(stdout: string): string[] {
  return parseDroidExecHelpModels(stdout).map((row) => row.id);
}

/**
 * Best-effort: ask the Droid CLI for models (flags vary by version).
 */
export async function listDroidModelIdsFromCli(droidPath: string): Promise<string[]> {
  return (await listDroidModelsFromCli(droidPath)).map((row) => row.id);
}

async function listDroidModelsFromCli(droidPath: string): Promise<DroidExecHelpModelRow[]> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) {
    return cached.models;
  }
  if (inflight) {
    return inflight;
  }
  inflight = listDroidModelsFromCliInner(droidPath).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function listDroidModelsFromCliInner(droidPath: string): Promise<DroidExecHelpModelRow[]> {
  const now = Date.now();
  try {
    const helpResult = await spawnAsync(droidPath, ["exec", "--help"], { timeout: 8_000, maxOutputBytes: 64_000 });
    if (helpResult.status === 0) {
      const rows = parseDroidExecHelpModels(helpResult.stdout ?? "");
      if (rows.length) {
        cached = { at: now, models: rows };
        return rows;
      }
    }
  } catch {
    // Fall through to legacy probes below.
  }

  const probes: string[][] = [
    ["models", "--json"],
    ["model", "list", "--json"],
    ["models"],
  ];

  for (const args of probes) {
    try {
      const result = await spawnAsync(droidPath, args, { timeout: 2_500 });
      if (result.status !== 0) continue;
      const stdout = (result.stdout ?? "").trim();
      if (!stdout) continue;

      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (Array.isArray(parsed)) {
          const rows: DroidExecHelpModelRow[] = [];
          for (const row of parsed) {
            if (typeof row === "string" && row.trim()) {
              const id = row.trim();
              rows.push({ id, displayName: id });
              continue;
            }
            if (row && typeof row === "object") {
              const r = row as Record<string, unknown>;
              const id = typeof r.id === "string" ? r.id.trim() : typeof r.model === "string" ? r.model.trim() : "";
              const displayName = typeof r.name === "string" && r.name.trim().length ? r.name.trim() : id;
              if (id) rows.push({ id, displayName });
            }
          }
          if (rows.length) {
            cached = { at: now, models: rows };
            return rows;
          }
        }
      } catch {
        // not JSON
      }

      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^usage:/i.test(l) && !/^options:/i.test(l));
      const bare: DroidExecHelpModelRow[] = [];
      const seen = new Set<string>();
      for (const line of lines) {
        const m = line.match(/^([a-z0-9][\w.-]*)$/i);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          bare.push({ id: m[1], displayName: m[1] });
        }
      }
      if (bare.length >= 3) {
        cached = { at: now, models: bare };
        return bare;
      }
    } catch {
      // try next probe
    }
  }

  cached = { at: now, models: [] };
  return [];
}

function readSdkModelRows(initResult: unknown): DroidExecHelpModelRow[] {
  const record = initResult && typeof initResult === "object" ? initResult as Record<string, unknown> : null;
  const raw = Array.isArray(record?.availableModels) ? record.availableModels : [];
  const seen = new Set<string>();
  const rows: DroidExecHelpModelRow[] = [];
  for (const entry of raw) {
    const model = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!model) continue;
    const id = typeof model.id === "string" && model.id.trim().length
      ? model.id.trim()
      : typeof model.modelId === "string"
        ? model.modelId.trim()
        : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = typeof model.displayName === "string" && model.displayName.trim().length
      ? model.displayName.trim()
      : typeof model.shortDisplayName === "string" && model.shortDisplayName.trim().length
        ? model.shortDisplayName.trim()
        : id;
    rows.push({
      id,
      displayName,
      customProxy: model.isCustom === true,
    });
  }
  return rows;
}

async function listDroidModelsFromSdk(droidPath: string): Promise<DroidExecHelpModelRow[]> {
  const now = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const session = await createSession({
      execPath: droidPath,
      cwd: process.cwd(),
      abortSignal: controller.signal,
    });
    try {
      const rows = readSdkModelRows(session.initResult);
      cached = { at: now, models: rows };
      return rows;
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function clearDroidCliModelsCache(): void {
  cached = null;
  inflight = null;
}

function getCachedDroidModels(): DroidExecHelpModelRow[] | null {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) {
    return cached.models;
  }
  return null;
}

/**
 * Read custom models from `~/.factory/config.json`.
 *
 * Vibeproxy (and other tools) inject custom models into the Droid CLI by
 * writing entries to this file.  Each entry carries the raw model ID, a
 * human-readable display name, and a `custom:` prefixed ID that the CLI
 * uses internally.
 */
async function readFactoryConfigCustomModels(): Promise<DroidExecHelpModelRow[]> {
  try {
    const configPath = join(homedir(), ".factory", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const customModels = parsed.custom_models;
    if (!Array.isArray(customModels)) return [];
    const rows: DroidExecHelpModelRow[] = [];
    for (const entry of customModels) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const model = typeof e.model === "string" ? e.model.trim() : "";
      const displayName = typeof e.model_display_name === "string" ? e.model_display_name.trim() : "";
      if (!model) continue;
      // The droid CLI wraps custom models with a "custom:" prefix.
      const id = `custom:${model}`;
      rows.push({ id, displayName: displayName || id, customProxy: true });
    }
    return rows;
  } catch {
    return [];
  }
}

export async function discoverDroidCliModelDescriptors(
  droidPath: string,
  options?: { mode?: DroidCliModelDiscoveryMode },
): Promise<ModelDescriptor[]> {
  const fromSdk = options?.mode === "cached-or-fallback"
    ? getCachedDroidModels() ?? []
    : await listDroidModelsFromSdk(droidPath).catch(() => []);
  const baseRows: DroidExecHelpModelRow[] = fromSdk;

  // Merge custom models from ~/.factory/config.json so vibeproxy-injected
  // models appear even when the CLI help output doesn't list them.
  const customRows = await readFactoryConfigCustomModels();

  const seen = new Set<string>();
  const descriptors: ModelDescriptor[] = [];
  for (const row of [...baseRows, ...customRows]) {
    const trimmed = String(row.id ?? "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    descriptors.push(createDynamicDroidCliModelDescriptor(trimmed, row.displayName, { customProxy: row.customProxy }));
  }
  return sortDroidCliDescriptorsForPicker(descriptors);
}

export const discoverDroidSdkModelDescriptors = discoverDroidCliModelDescriptors;
