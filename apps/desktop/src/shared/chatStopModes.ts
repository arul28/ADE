import { providerDisplayLabel } from "./pendingInputLabels";

/**
 * Canonical chat stop matrix: queue axis × background axis.
 *
 * `AgentChatStopMode` used to be queue-only (`stop_and_clear` | `stop_only`).
 * After Claude Agent SDK `perTaskStopAffordance`, an interrupt can spare
 * running background tasks — so the mode must name both axes, and the
 * composer / iOS menus must spell them out. iOS hand-mirrors this table in
 * `WorkChatStopCapability` because it cannot import TS.
 *
 * Default remains `stop_and_clear` (stop the turn and cancel queued messages;
 * background jobs keep running once the per-task stop controls exist).
 */

export const AGENT_CHAT_STOP_MODES = [
  "stop_only",
  "stop_and_clear",
  "stop_and_background",
  "stop_and_clear_and_background",
  // A third axis: also stop the chats this chat spawned, depth-first, each
  // with the same mode. Never the default, for any provider.
  "stop_and_clear_and_children",
  "stop_everything_and_children",
] as const;

export type AgentChatStopMode = (typeof AGENT_CHAT_STOP_MODES)[number];

export const DEFAULT_AGENT_CHAT_STOP_MODE: AgentChatStopMode = "stop_and_clear";

/**
 * Settle teardown keeps the user's queued prompts (those are unrecoverable)
 * and still stops background work (the reason settle exists). After the
 * matrix, that combination is `stop_and_background`, not `stop_only`.
 */
export const SETTLE_TEARDOWN_STOP_MODE: AgentChatStopMode = "stop_and_background";

export function isAgentChatStopMode(value: unknown): value is AgentChatStopMode {
  return typeof value === "string"
    && (AGENT_CHAT_STOP_MODES as readonly string[]).includes(value);
}

export function parseAgentChatStopMode(
  value: unknown,
  fallback: AgentChatStopMode = DEFAULT_AGENT_CHAT_STOP_MODE,
): AgentChatStopMode {
  return isAgentChatStopMode(value) ? value : fallback;
}

const AGENT_CHAT_STOP_MODE_ALIASES: Record<string, AgentChatStopMode> = {
  stop_only: "stop_only",
  "stop-only": "stop_only",
  "--stop-only": "stop_only",
  "keep-queue": "stop_only",
  "--keep-queue": "stop_only",
  stop_and_clear: "stop_and_clear",
  "stop-and-clear": "stop_and_clear",
  "clear-queue": "stop_and_clear",
  "--clear-queue": "stop_and_clear",
  stop_and_background: "stop_and_background",
  "stop-and-background": "stop_and_background",
  background: "stop_and_background",
  "turn-and-background": "stop_and_background",
  stop_and_clear_and_background: "stop_and_clear_and_background",
  "stop-and-clear-and-background": "stop_and_clear_and_background",
  "clear-and-background": "stop_and_clear_and_background",
  stop_and_clear_and_children: "stop_and_clear_and_children",
  "stop-and-clear-and-children": "stop_and_clear_and_children",
  children: "stop_and_clear_and_children",
  "clear-and-children": "stop_and_clear_and_children",
  stop_everything_and_children: "stop_everything_and_children",
  "stop-everything-and-children": "stop_everything_and_children",
  everything: "stop_everything_and_children",
};

/** Hyphen, underscore, and composer-flag aliases for the four-mode matrix. */
export function resolveAgentChatStopModeAlias(value: string): AgentChatStopMode | null {
  const key = value.trim().toLowerCase();
  return AGENT_CHAT_STOP_MODE_ALIASES[key] ?? null;
}

/**
 * Whether the Stop control offers the choice menu. Every provider does: the
 * menu disables the choices a provider cannot honour and says why
 * (`providerStopModeSupport`), instead of hiding them.
 */
export function providerSupportsStopModeChoice(provider: string | null | undefined): boolean {
  return String(provider ?? "").trim().length > 0;
}

/** Providers whose runtime can stop one background task (`chat.stopTask`). */
export function providerSupportsPerTaskStop(provider: string | null | undefined): boolean {
  return provider === "claude" || provider === "opencode";
}

/** What each mode stops besides the active turn. */
const STOP_MODE_EFFECTS: Record<AgentChatStopMode, { clearsQueue: boolean; stopsBackground: boolean; stopsChildren: boolean }> = {
  stop_only: { clearsQueue: false, stopsBackground: false, stopsChildren: false },
  stop_and_clear: { clearsQueue: true, stopsBackground: false, stopsChildren: false },
  stop_and_background: { clearsQueue: false, stopsBackground: true, stopsChildren: false },
  stop_and_clear_and_background: { clearsQueue: true, stopsBackground: true, stopsChildren: false },
  stop_and_clear_and_children: { clearsQueue: true, stopsBackground: false, stopsChildren: true },
  stop_everything_and_children: { clearsQueue: true, stopsBackground: true, stopsChildren: true },
};

export function stopModeClearsQueue(mode: AgentChatStopMode): boolean {
  return STOP_MODE_EFFECTS[mode].clearsQueue;
}

export function stopModeStopsBackground(mode: AgentChatStopMode): boolean {
  return STOP_MODE_EFFECTS[mode].stopsBackground;
}

/** Also stop the chats this chat spawned (`orchestrationParentSessionId`). */
export function stopModeStopsChildren(mode: AgentChatStopMode): boolean {
  return STOP_MODE_EFFECTS[mode].stopsChildren;
}

/** The queue × background mode a provider runtime acts on; children are ADE's job. */
export function stopModeProviderMode(mode: AgentChatStopMode): AgentChatStopMode {
  if (mode === "stop_and_clear_and_children") return "stop_and_clear";
  if (mode === "stop_everything_and_children") return "stop_and_clear_and_background";
  return mode;
}

export type AgentChatStopModeSupport =
  | { supported: true }
  | { supported: false; reason: string };

/**
 * What each provider can actually do for each Stop choice, from its own
 * interrupt semantics:
 *
 * - Background work: Claude stops tasks one by one (`stopTask`) or resets the
 *   query; OpenCode stops child sessions and kills its background shells;
 *   Codex ends its background terminals (`thread/backgroundTerminals/clean`).
 *   Cursor, Droid, Pi, and ACP agents expose no way to stop background work.
 * - Keeping the queue: Pi and ACP agents drop queued messages on interrupt, so
 *   a Stop that keeps them cannot be offered there.
 * - Child chats are ADE chats, so every provider can stop them.
 *
 * iOS hand-mirrors this table in `WorkChatStopCapability`.
 */
export function providerStopModeSupport(
  provider: string | null | undefined,
  mode: AgentChatStopMode,
): AgentChatStopModeSupport {
  const key = String(provider ?? "").trim().toLowerCase();
  const name = providerDisplayLabel(provider, "This provider");
  const stopsBackground = key === "claude" || key === "opencode" || key === "codex";
  const keepsQueue = key === "claude" || key === "opencode" || key === "codex" || key === "cursor" || key === "droid";
  if (stopModeStopsBackground(mode) && !stopsBackground) {
    return { supported: false, reason: `${name} can't stop background work its agent started.` };
  }
  if (!stopModeClearsQueue(mode) && !keepsQueue) {
    return { supported: false, reason: `${name} drops queued messages when stopped.` };
  }
  return { supported: true };
}

/**
 * Whether the Stop menu offers this mode: the provider can do it, and the
 * child-chat modes only while this chat has child chats.
 */
export function stopModeAvailable(
  provider: string | null | undefined,
  mode: AgentChatStopMode,
  childChatCount: number,
): boolean {
  if (stopModeStopsChildren(mode) && childChatCount <= 0) return false;
  return providerStopModeSupport(provider, mode).supported;
}

export function formatBackgroundJobCount(count: number): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return n === 1 ? "1 job" : `${n} jobs`;
}

export type AgentChatStopModeCopy = {
  label: string;
  description: string;
};

/**
 * Wireframe labels. Job count is live: "Turn + background (3 jobs)".
 */
export function chatStopModeCopy(
  mode: AgentChatStopMode,
  jobCount: number,
  childChatCount = 0,
): AgentChatStopModeCopy {
  const jobs = formatBackgroundJobCount(jobCount);
  const n = Number.isFinite(childChatCount) ? Math.max(0, Math.floor(childChatCount)) : 0;
  const children = n === 1 ? "1 child chat" : `${n} child chats`;
  switch (mode) {
    case "stop_only":
      return {
        label: "Turn only",
        description: "Stop the active turn. Keep queued messages and background jobs.",
      };
    case "stop_and_clear":
      return {
        label: "Turn + queue",
        description: "Stop the active turn and cancel queued messages. Background jobs keep running.",
      };
    case "stop_and_background":
      return {
        label: `Turn + background (${jobs})`,
        description: `Stop the active turn and stop ${jobs}. Keep queued messages.`,
      };
    case "stop_and_clear_and_background":
      return {
        label: `Turn + queue + background (${jobs})`,
        description: `Stop the active turn, cancel queued messages, and stop ${jobs}.`,
      };
    case "stop_and_clear_and_children":
      return {
        label: `Turn + queue + child chats (${n})`,
        description: `Stop the active turn, cancel queued messages, and stop ${children} this chat started. Background jobs keep running.`,
      };
    case "stop_everything_and_children":
      return {
        label: `Everything + child chats (${n})`,
        description: `Stop the turn, queued messages, ${jobs}, and ${children} this chat started.`,
      };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

/**
 * `perTaskStopAffordance` makes interrupt spare background tasks. Declaring it
 * before the user can stop those tasks individually is strictly worse than
 * today. Both gates must be true.
 */
export function shouldDeclarePerTaskStopAffordance(args: {
  stopTaskExposed: boolean;
  stopControlsReachable: boolean;
}): boolean {
  return args.stopTaskExposed === true && args.stopControlsReachable === true;
}

/** True once this branch exposes `chat.stopTask` and the subagent/job stop UI. */
export const CLAUDE_PER_TASK_STOP_CONTROLS_REACHABLE = true;
