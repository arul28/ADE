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
};

/** Hyphen, underscore, and composer-flag aliases for the four-mode matrix. */
export function resolveAgentChatStopModeAlias(value: string): AgentChatStopMode | null {
  const key = value.trim().toLowerCase();
  return AGENT_CHAT_STOP_MODE_ALIASES[key] ?? null;
}

export function stopModeClearsQueue(mode: AgentChatStopMode): boolean {
  return mode === "stop_and_clear" || mode === "stop_and_clear_and_background";
}

export function stopModeStopsBackground(mode: AgentChatStopMode): boolean {
  return mode === "stop_and_background" || mode === "stop_and_clear_and_background";
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
): AgentChatStopModeCopy {
  const jobs = formatBackgroundJobCount(jobCount);
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
