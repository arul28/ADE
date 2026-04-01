import {
  createDynamicCursorCliModelDescriptor,
  sortCursorCliDescriptorsForPicker,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { spawnAsync } from "../shared/utils";

export type CursorCliModelRow = { id: string; displayName?: string };

let cached: { at: number; models: CursorCliModelRow[] } | null = null;
const TTL_MS = 120_000;

const FALLBACK_SDK_IDS = ["auto", "composer-2"];

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Parse `agent models` table output (`id - Label (current)`) and bare id lines.
 * Exported for unit tests.
 */
export function parseCursorCliModelsStdout(stdout: string): CursorCliModelRow[] {
  const text = stripAnsi(stdout);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: CursorCliModelRow[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (/^loading models/i.test(line) || /^available models/i.test(line)) continue;
    const table = line.match(/^([a-z0-9][\w.-]*)\s+-\s+(.+)$/i);
    if (table) {
      const id = table[1].trim();
      const label = table[2].replace(/\s*\(current\)\s*$/i, "").trim();
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, displayName: label });
      }
      continue;
    }
    if (/^[\w.-]+$/.test(line) && !seen.has(line)) {
      seen.add(line);
      out.push({ id: line });
    }
  }
  return out;
}

export function clearCursorCliModelsCache(): void {
  cached = null;
}

/**
 * Best-effort: run `agent models` (and JSON variants) and parse stdout.
 */
export async function listCursorModelsFromCli(agentPath: string): Promise<CursorCliModelRow[]> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS && cached.models.length) {
    return cached.models;
  }

  const probes: string[][] = [
    ["models", "--json"],
    ["models", "-json"],
    ["models"],
    ["--list-models"],
  ];

  for (const args of probes) {
    try {
      const result = await spawnAsync(agentPath, args, { timeout: 12_000 });
      if (result.status !== 0) continue;
      const stdout = (result.stdout ?? "").trim();
      if (!stdout) continue;

      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (Array.isArray(parsed)) {
          const models: CursorCliModelRow[] = [];
          for (const row of parsed) {
            if (typeof row === "string" && row.trim()) {
              models.push({ id: row.trim() });
              continue;
            }
            if (row && typeof row === "object") {
              const r = row as Record<string, unknown>;
              const id = (typeof r.id === "string" && r.id) || (typeof r.model === "string" && r.model) || "";
              const displayName = (typeof r.name === "string" ? r.name : undefined)
                ?? (typeof r.displayName === "string" ? r.displayName : undefined);
              if (id.trim()) models.push({ id: id.trim(), displayName });
            }
          }
          if (models.length) {
            cached = { at: now, models };
            return models;
          }
        }
      } catch {
        // not JSON
      }

      const parsedLines = parseCursorCliModelsStdout(stdout);
      if (parsedLines.length) {
        cached = { at: now, models: parsedLines };
        return parsedLines;
      }
    } catch {
      // try next probe
    }
  }

  return [];
}

/**
 * Full list of Cursor CLI models as registry descriptors (for AI status + chat pickers).
 */
export async function discoverCursorCliModelDescriptors(agentPath: string): Promise<ModelDescriptor[]> {
  const rows = await listCursorModelsFromCli(agentPath);
  const useRows: CursorCliModelRow[] = rows.length ? rows : FALLBACK_SDK_IDS.map((id) => ({ id }));
  const seen = new Set<string>();
  const descriptors: ModelDescriptor[] = [];
  for (const row of useRows) {
    const id = String(row.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    descriptors.push(createDynamicCursorCliModelDescriptor(id, row.displayName));
  }
  return sortCursorCliDescriptorsForPicker(descriptors);
}
