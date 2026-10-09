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

/** Claude Code accepts an auto-compact window from 100k to 1M; ADE clamps the same way everywhere it shows it. */
export function claudeCompactWindow(atTokens: number | null | undefined): number | undefined {
  return atTokens != null ? Math.max(100_000, Math.min(1_000_000, atTokens)) : undefined;
}

export function claudeCompactionSettings(settings: ProviderCompactionSettings): { autoCompactEnabled?: boolean; autoCompactWindow?: number } {
  const window = claudeCompactWindow(settings.atTokens);
  return {
    ...(settings.enabled !== undefined ? { autoCompactEnabled: settings.enabled } : {}),
    ...(window !== undefined ? { autoCompactWindow: window } : {}),
  };
}

/**
 * The settings a running process was started with. Only fields the provider's
 * process reads count, so changing `idleMode` (a send-time choice) never
 * restarts a runtime.
 */
export function compactionRuntimeSignature(provider: string, settings: ProviderCompactionSettings): string {
  switch (provider) {
    case "claude": return JSON.stringify([settings.enabled, claudeCompactWindow(settings.atTokens)]);
    case "codex": return JSON.stringify([settings.atTokens]);
    case "pi":
    case "opencode": return JSON.stringify([settings.enabled, settings.reserveTokens, settings.keepRecentTokens]);
    default: return "";
  }
}
