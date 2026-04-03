import {
  createDynamicDroidCliModelDescriptor,
  sortDroidCliDescriptorsForPicker,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { spawnAsync } from "../shared/utils";

/** Default catalog when `droid` does not expose a machine-readable model list. */
export const DROID_DEFAULT_MODEL_IDS: string[] = [
  "claude-opus-4-6",
  "claude-opus-4-6-fast",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gemini-3-pro-preview",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "glm-4.7",
  "glm-5",
  "kimi-k2.5",
  "minimax-m2.5",
];

let cached: { at: number; models: string[] } | null = null;
const TTL_MS = 120_000;

/**
 * Best-effort: ask the Droid CLI for models (flags vary by version).
 */
export async function listDroidModelIdsFromCli(droidPath: string): Promise<string[]> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS && cached.models.length) {
    return cached.models;
  }

  const probes: string[][] = [
    ["models", "--json"],
    ["model", "list", "--json"],
    ["models"],
  ];

  for (const args of probes) {
    try {
      const result = await spawnAsync(droidPath, args, { timeout: 15_000 });
      if (result.status !== 0) continue;
      const stdout = (result.stdout ?? "").trim();
      if (!stdout) continue;

      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (Array.isArray(parsed)) {
          const ids: string[] = [];
          for (const row of parsed) {
            if (typeof row === "string" && row.trim()) {
              ids.push(row.trim());
              continue;
            }
            if (row && typeof row === "object") {
              const r = row as Record<string, unknown>;
              const id = typeof r.id === "string" ? r.id.trim() : typeof r.model === "string" ? r.model.trim() : "";
              if (id) ids.push(id);
            }
          }
          if (ids.length) {
            cached = { at: now, models: ids };
            return ids;
          }
        }
      } catch {
        // not JSON
      }

      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !/^usage:/i.test(l) && !/^options:/i.test(l));
      const bare: string[] = [];
      const seen = new Set<string>();
      for (const line of lines) {
        const m = line.match(/^([a-z0-9][\w.-]*)$/i);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          bare.push(m[1]);
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

  return [];
}

export function clearDroidCliModelsCache(): void {
  cached = null;
}

export async function discoverDroidCliModelDescriptors(droidPath: string): Promise<ModelDescriptor[]> {
  const fromCli = await listDroidModelIdsFromCli(droidPath);
  const ids = fromCli.length ? fromCli : DROID_DEFAULT_MODEL_IDS;
  const seen = new Set<string>();
  const descriptors: ModelDescriptor[] = [];
  for (const id of ids) {
    const trimmed = String(id ?? "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    descriptors.push(createDynamicDroidCliModelDescriptor(trimmed));
  }
  return sortDroidCliDescriptorsForPicker(descriptors);
}
