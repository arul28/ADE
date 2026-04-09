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

export type DroidExecHelpModelRow = {
  id: string;
  displayName: string;
};

let cached: { at: number; models: DroidExecHelpModelRow[] } | null = null;
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

export function clearDroidCliModelsCache(): void {
  cached = null;
}

export async function discoverDroidCliModelDescriptors(droidPath: string): Promise<ModelDescriptor[]> {
  const fromCli = await listDroidModelsFromCli(droidPath);
  const rows = fromCli.length
    ? fromCli
    : DROID_DEFAULT_MODEL_IDS.map((id) => ({ id, displayName: id }));
  const seen = new Set<string>();
  const descriptors: ModelDescriptor[] = [];
  for (const row of rows) {
    const trimmed = String(row.id ?? "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    descriptors.push(createDynamicDroidCliModelDescriptor(trimmed, row.displayName));
  }
  return sortDroidCliDescriptorsForPicker(descriptors);
}
