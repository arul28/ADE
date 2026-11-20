import type { UpdateBlockHolder } from "./types/sync";

/** At most this many processes ride with a blocked update (the installer lists 8). */
export const MAX_UPDATE_BLOCK_HOLDERS = 8;

/**
 * The processes in a blocked-update report, from the installer's file or off
 * the wire: each needs a whole pid and a name; anything else is dropped.
 */
export function readUpdateBlockHolders(raw: unknown): UpdateBlockHolder[] {
  if (!Array.isArray(raw)) return [];
  const holders: UpdateBlockHolder[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const pid = typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : null;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (pid == null || !name) continue;
    const holderPath = typeof record.path === "string" && record.path.trim() ? record.path.trim() : null;
    holders.push({ pid, name, path: holderPath });
    if (holders.length === MAX_UPDATE_BLOCK_HOLDERS) break;
  }
  return holders;
}
