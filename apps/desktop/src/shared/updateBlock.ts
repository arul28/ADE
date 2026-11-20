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

/**
 * What kept a failed update from installing, as a closed answer for analytics
 * (`ade_update_install_did_not_land.blocked_by`): no report for that version,
 * a program from outside the install folder holding its files (the usual
 * cause: a dev copy of ADE, an editor, a shell), only ADE's own programs, or a
 * report that named nothing.
 */
export const UPDATE_BLOCK_CAUSES = ["none", "outside_process", "ade_process", "unknown"] as const;
export type UpdateBlockCause = (typeof UPDATE_BLOCK_CAUSES)[number];

/** `raw` is the installer's parsed `update-blocked.json`; `targetVersion` the update that did not land. */
export function updateBlockCause(raw: unknown, targetVersion: string): UpdateBlockCause {
  if (!raw || typeof raw !== "object") return "none";
  const record = raw as Record<string, unknown>;
  const reported = typeof record.targetVersion === "string" ? record.targetVersion.trim() : "";
  if (!reported || reported !== targetVersion.trim()) return "none";
  const holders = readUpdateBlockHolders(record.holders);
  if (holders.length === 0) return "unknown";
  const installDir = typeof record.installDir === "string" ? normalizeWindowsDir(record.installDir) : "";
  const inside = (holderPath: string | null) =>
    Boolean(installDir && holderPath && normalizeWindowsDir(holderPath).startsWith(installDir));
  return holders.some((holder) => !inside(holder.path)) ? "outside_process" : "ade_process";
}

function normalizeWindowsDir(value: string): string {
  return `${value.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()}\\`;
}
