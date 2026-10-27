/**
 * What to tell the user when Claude Code serves a Fast request at standard
 * speed. The composer keeps showing Fast, because that is the user's choice;
 * this says what Claude Code did with it.
 *
 * Claude Code reports `fast_mode_state` (`on`, `off`, `cooldown`) and
 * `fast_mode_disabled_reason` on each turn result. Older builds send only the
 * reason, which is present exactly when something blocks Fast.
 */

export type ClaudeFastModeFallback = {
  /** Same key on the next turn means the same news: say it once. */
  key: string;
  message: string;
};

const OFF_MESSAGE = "Fast mode is off, so Claude is answering at standard speed.";

const REASON_DETAIL: Record<string, string> = {
  free: "Fast mode needs a paid Claude plan.",
  preference: "Your organization has turned Fast mode off.",
  extra_usage_disabled: "It needs extra usage turned on for this Claude account.",
  network_error: "Claude Code could not reach Anthropic to check Fast mode.",
  not_first_party: "Fast mode works only with an Anthropic account, not through this provider.",
  disabled_by_env: "CLAUDE_CODE_DISABLE_FAST_MODE is set in this environment.",
  model_not_allowed: "This model does not offer Fast mode.",
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

/**
 * The notice a turn result calls for, or null when Fast was served, nothing
 * was decided yet, or the result says nothing about Fast.
 */
export function claudeFastModeFallback(result: {
  fast_mode_state?: unknown;
  fast_mode_disabled_reason?: unknown;
}): ClaudeFastModeFallback | "served" | null {
  const state = readString(result.fast_mode_state);
  const reason = readString(result.fast_mode_disabled_reason);
  if (state === "on") return "served";
  if (state === "cooldown") {
    return {
      key: "cooldown",
      message: "Fast mode is cooling down after a rate limit, so Claude is answering at standard speed for now.",
    };
  }
  // `pending`: Claude Code has not decided yet, so there is nothing to say.
  if (reason === "pending") return null;
  if (state !== "off" && !reason) return null;
  const detail = reason ? REASON_DETAIL[reason] : undefined;
  return {
    key: `off:${reason ?? ""}`,
    message: detail ? `${OFF_MESSAGE} ${detail}` : OFF_MESSAGE,
  };
}
