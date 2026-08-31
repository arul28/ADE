/**
 * Activity labels: how a raw agent event is named for an end user.
 *
 * The host embedding this chat does not want "Bash(rg -n invoice)" in front of
 * its customers. It wants "Searching your invoices…". This module turns an
 * event into that string, entirely from configuration.
 *
 * Resolution order for a given key (first hit wins):
 *   1. `resolve(event)` — full escape hatch, may return null to fall through
 *   2. exact `map` entry              e.g. "server.tool"
 *   3. longest matching wildcard      e.g. "server.*" then "*"
 *   4. `null` — the caller falls back to the raw tool name
 */

import type { AgentChatEvent } from "../sdkTypes";
import type { ToolChipRow } from "../transcript/transcriptRows";

/** The phase a label is being rendered for. */
export type ActivityPhase = "running" | "done" | "error";

/**
 * A map entry is either one string (used for the running phase only — done and
 * error fall back to the raw name) or an explicit per-phase set.
 */
export type ActivityLabelEntry =
  | string
  | {
      running?: string;
      done?: string;
      error?: string;
    };

export type ActivityLabelSource =
  | { kind: "tool"; tool: string; phase: ActivityPhase; event: ToolChipRow }
  | { kind: "error"; tool: null; phase: "error"; event: Extract<AgentChatEvent, { type: "error" }> }
  | { kind: "thinking"; tool: null; phase: "running"; event: null };

export type ActivityLabelConfig = {
  /** Keyed by tool name. Supports trailing `*` wildcards and a bare `"*"`. */
  map?: Record<string, ActivityLabelEntry>;
  /** Runs before `map`. Return null to fall through to the map. */
  resolve?: (source: ActivityLabelSource) => string | null;
  /** Keyed the same way as `map`, including wildcards. */
  icons?: Record<string, unknown>;
  /** Shown while a turn is running and no tool is active. */
  thinkingLabel?: string;
  /**
   * Elapsed-time suffix appears once a phase has been running this long.
   * Locked default: 3s.
   */
  elapsedAfterMs?: number;
};

export const DEFAULT_ELAPSED_AFTER_MS = 3000;
export const DEFAULT_THINKING_LABEL = "Working…";

/**
 * Wildcard specificity: an exact key beats `a.b.*` beats `a.*` beats `*`.
 * Returns the matching key, or null.
 */
export function matchLabelKey(
  keys: readonly string[],
  candidate: string,
): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const key of keys) {
    if (key === candidate) return key;
    if (!key.endsWith("*")) continue;
    const prefix = key.slice(0, -1);
    if (prefix.length > 0 && !candidate.startsWith(prefix)) continue;
    // A bare "*" has prefix "" and matches everything at the lowest score.
    if (prefix.length >= bestScore) {
      best = key;
      bestScore = prefix.length;
    }
  }
  return best;
}

function entryForPhase(entry: ActivityLabelEntry, phase: ActivityPhase): string | null {
  if (typeof entry === "string") {
    // A single string is the running verb only. Terminal phases keep the raw
    // tool name so "Searching your invoices…" never lingers after it finished.
    return phase === "running" ? entry : null;
  }
  const value = entry[phase];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Resolve the display label for one activity source. Null means "no override". */
export function resolveActivityLabel(
  source: ActivityLabelSource,
  config: ActivityLabelConfig | undefined,
): string | null {
  if (!config) return null;

  const custom = config.resolve?.(source);
  if (typeof custom === "string" && custom.length > 0) return custom;

  if (source.kind === "thinking") {
    return config.thinkingLabel ?? null;
  }

  const key = source.tool;
  if (!key || !config.map) return null;
  const matched = matchLabelKey(Object.keys(config.map), key);
  if (!matched) return null;
  return entryForPhase(config.map[matched]!, source.phase);
}

/** Resolve a configured icon for a tool key, honouring the same wildcards. */
export function resolveActivityIcon(
  tool: string | null,
  config: ActivityLabelConfig | undefined,
): unknown {
  if (!tool || !config?.icons) return undefined;
  const matched = matchLabelKey(Object.keys(config.icons), tool);
  return matched ? config.icons[matched] : undefined;
}

/** Map a chip's status onto the phase its label should use. */
export function phaseForToolStatus(status: ToolChipRow["status"]): ActivityPhase {
  if (status === "running") return "running";
  if (status === "failed") return "error";
  return "done";
}

/**
 * Elapsed suffix. Under the threshold this returns null so short activities
 * never flash a timer. Seconds under a minute, then `m s`.
 */
export function formatElapsed(
  elapsedMs: number,
  elapsedAfterMs: number = DEFAULT_ELAPSED_AFTER_MS,
): string | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < elapsedAfterMs) return null;
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Full label for a tool chip, including the elapsed suffix when it applies.
 * `fallback` is used when nothing in the config matches — normally the raw
 * tool name.
 */
export function describeToolActivity(input: {
  chip: ToolChipRow;
  config?: ActivityLabelConfig;
  elapsedMs?: number;
}): { label: string; elapsed: string | null; icon: unknown } {
  const { chip, config } = input;
  const phase = phaseForToolStatus(chip.status);
  const label =
    resolveActivityLabel({ kind: "tool", tool: chip.tool, phase, event: chip }, config)
    ?? chip.tool;
  const elapsed =
    phase === "running" && typeof input.elapsedMs === "number"
      ? formatElapsed(input.elapsedMs, config?.elapsedAfterMs ?? DEFAULT_ELAPSED_AFTER_MS)
      : null;
  return { label, elapsed, icon: resolveActivityIcon(chip.tool, config) };
}
