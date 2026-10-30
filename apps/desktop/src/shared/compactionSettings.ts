/**
 * ADE-owned overrides. Missing fields inherit the harness's own defaults.
 * Compaction itself is always on: a chat that cannot compact only overflows.
 * An `enabled: false` saved before that is dropped on read.
 */
export type ProviderCompactionSettings = {
  atTokens?: number | null;
  /** Claude only: where subagents compact. It can only lower the main chat's window. */
  subagentAtTokens?: number | null;
  reserveTokens?: number;
  keepRecentTokens?: number;
  idleMode?: "ask" | "always" | "never";
};

/**
 * The Compact first mode a provider runs with when nothing is stored. Claude
 * has shown the offer since it shipped; every other provider starts at `never`,
 * so nobody who never opened the setting meets one. One definition, read by the
 * brain and by the Settings select, so the shown default and the effective
 * default cannot drift.
 */
export function compactionIdleModeDefault(provider: string | null | undefined): "ask" | "never" {
  return provider === "claude" ? "ask" : "never";
}

export function normalizeCompactionSettings(value: unknown): ProviderCompactionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: ProviderCompactionSettings = {};
  if (raw.atTokens === null) out.atTokens = null;
  if (raw.subagentAtTokens === null) out.subagentAtTokens = null;
  for (const key of ["atTokens", "subagentAtTokens", "reserveTokens", "keepRecentTokens"] as const) {
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

export function claudeCompactionSettings(settings: ProviderCompactionSettings): { autoCompactWindow?: number } {
  const window = claudeCompactWindow(settings.atTokens);
  return window !== undefined ? { autoCompactWindow: window } : {};
}

/**
 * A subagent window at or above the main chat's never applies: the SDK only
 * lets a subagent compact earlier than the window it inherits. Unknown when
 * the main chat is on Auto, whose window depends on the model.
 */
export function claudeSubagentWindowIneffective(settings: ProviderCompactionSettings): boolean {
  const main = claudeCompactWindow(settings.atTokens);
  const subagent = claudeCompactWindow(settings.subagentAtTokens);
  return main !== undefined && subagent !== undefined && subagent >= main;
}

/**
 * The settings a running process was started with. Only fields the provider's
 * process reads count, so changing `idleMode` (a send-time choice) never
 * restarts a runtime.
 */
export function compactionRuntimeSignature(provider: string, settings: ProviderCompactionSettings): string {
  switch (provider) {
    case "claude": return JSON.stringify([claudeCompactWindow(settings.atTokens), claudeCompactWindow(settings.subagentAtTokens)]);
    case "codex":
    case "copilot": return JSON.stringify([settings.atTokens]);
    case "pi":
    case "opencode": return JSON.stringify([settings.reserveTokens, settings.keepRecentTokens]);
    default: return "";
  }
}
