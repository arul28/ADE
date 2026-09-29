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
 *
 * MCP tool keys are matched on the tool's identity, not its spelling (see
 * `matchLabelKey`): `mcp:versic:*`, `versic:search`, `mcp__versic__search` and
 * a bare `search` all reach a Claude `mcp__versic__search` and a Codex
 * `versic:search` alike. A tool reported by its bare name (`search`) with an
 * MCP source naming `versic` is matched as `versic`'s tool too.
 */

import type { AgentChatEvent } from "../sdkTypes";
import type { ToolChipRow } from "../transcript/transcriptRows";
import { parseToolIdentity, type ToolIdentity } from "./toolIdentity";

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
  /**
   * Keyed by tool name. Supports trailing `*` wildcards and a bare `"*"`.
   *
   * MCP tools may be keyed in any spelling — the policy form `mcp:srv:tool` /
   * `mcp:srv:*`, Claude's `mcp__srv__tool`, Codex's `srv:tool`, or the bare
   * `tool` — and one key matches the tool under every provider. A
   * server-qualified key beats a bare one for the same tool.
   *
   * A server-qualified key matches a tool the provider reported by its bare
   * name only when the event carries an MCP source naming that server
   * (`tool_call.mcp.server`, surfaced as `ToolChipRow.identity`). A bare name
   * with no MCP source has no server, so only a bare key (`tool`, `tool*`)
   * matches it.
   */
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

/** Score tiers for `matchLabelKey`; a higher tier always wins. */
const TIER = 1_000_000;
const QUALIFIED_WILDCARD_BONUS = 10_000;

/** Specificity of one key against one candidate, or -1 when it does not match. */
function scoreLabelKey(
  key: string,
  candidate: string,
  identity: ToolIdentity,
): number {
  // The spelling the host wrote, verbatim: nothing is more specific.
  if (key === candidate) return 4 * TIER;
  const parsed = parseToolIdentity(key);
  const wildcard = parsed.tool.endsWith("*");
  const toolPrefix = wildcard ? parsed.tool.slice(0, -1) : parsed.tool;

  if (parsed.server !== null) {
    // A server-qualified key only ever matches that server's tools.
    if (identity.server !== parsed.server) return -1;
    if (!wildcard) return parsed.tool === identity.tool ? 3 * TIER : -1;
    if (!identity.tool.startsWith(toolPrefix)) return -1;
    return TIER + QUALIFIED_WILDCARD_BONUS + toolPrefix.length;
  }

  // A bare key: compared with the raw candidate (what 0.2 did) and with the
  // tool name under its server prefix, so `search` reaches `mcp__srv__search`.
  if (!wildcard) {
    return identity.server !== null && key === identity.tool ? 2 * TIER : -1;
  }
  let best = -1;
  // A bare "*" has prefix "" and matches everything at the lowest score.
  if (candidate.startsWith(toolPrefix)) best = TIER + toolPrefix.length;
  if (identity.server !== null && identity.tool.startsWith(toolPrefix)) {
    best = Math.max(best, TIER + toolPrefix.length);
  }
  return best;
}

/**
 * The best map key for a tool name, or null.
 *
 * Specificity, highest first:
 *   1. the key spelled exactly like the candidate
 *   2. a server-qualified key for the same server and tool, in any spelling
 *      (`mcp:srv:tool`, `mcp__srv__tool`, `srv:tool`)
 *   3. a bare key equal to the tool name without its server (`tool`)
 *   4. wildcards — server-qualified (`mcp:srv:*`) before bare, then the longest
 *      prefix; a bare `"*"` last. On a tie the later key wins.
 *
 * This is the one matcher: labels, icons and hosts' own lookups all use it, so
 * a tool never has to be listed once per provider spelling.
 *
 * `identity` is the tool's known `{ server, tool }` when the event says which
 * MCP server ran it (`ToolChipRow.identity`, from the event's `mcp` source).
 * Pass it: some providers report an MCP tool by its bare name (`search`), and
 * only the event's MCP source tells the matcher that a server-qualified key
 * (`mcp:srv:search`, `mcp:srv:*`) applies. Without it the identity is parsed
 * from `candidate`, so a bare name has no server and matches only bare keys.
 */
export function matchLabelKey(
  keys: readonly string[],
  candidate: string,
  identity: ToolIdentity = parseToolIdentity(candidate),
): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const key of keys) {
    const score = scoreLabelKey(key, candidate, identity);
    if (score < 0) continue;
    if (score >= 4 * TIER) return key;
    if (score >= bestScore) {
      best = key;
      bestScore = score;
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
  const identity = source.kind === "tool" ? source.event.identity : undefined;
  const matched = matchLabelKey(Object.keys(config.map), key, identity);
  if (!matched) return null;
  return entryForPhase(config.map[matched]!, source.phase);
}

/** Resolve a configured icon for a tool key, honouring the same wildcards. */
export function resolveActivityIcon(
  tool: string | null,
  config: ActivityLabelConfig | undefined,
  identity?: ToolIdentity,
): unknown {
  if (!tool || !config?.icons) return undefined;
  const matched = matchLabelKey(Object.keys(config.icons), tool, identity);
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
  return { label, elapsed, icon: resolveActivityIcon(chip.tool, config, chip.identity) };
}
