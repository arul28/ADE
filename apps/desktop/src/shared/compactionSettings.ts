/** ADE-owned overrides. Missing fields inherit the harness's own defaults. */
export type ProviderCompactionSettings = {
  enabled?: boolean;
  atTokens?: number | null;
  reserveTokens?: number;
  keepRecentTokens?: number;
  idleMode?: "ask" | "always" | "never";
};

export function normalizeCompactionSettings(value: unknown): ProviderCompactionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: ProviderCompactionSettings = {};
  if (raw.atTokens === null) out.atTokens = null;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  for (const key of ["atTokens", "reserveTokens", "keepRecentTokens"] as const) {
    const n = raw[key];
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) out[key] = n;
  }
  if (raw.idleMode === "ask" || raw.idleMode === "always" || raw.idleMode === "never") out.idleMode = raw.idleMode;
  return out;
}

export function claudeCompactionSettings(settings: ProviderCompactionSettings): { autoCompactEnabled?: boolean; autoCompactWindow?: number } {
  return {
    ...(settings.enabled !== undefined ? { autoCompactEnabled: settings.enabled } : {}),
    ...(settings.atTokens != null ? { autoCompactWindow: Math.max(100_000, Math.min(1_000_000, settings.atTokens)) } : {}),
  };
}
