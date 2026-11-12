/**
 * Exact turn status for tracked agent CLIs, from the CLIs' own signals.
 *
 * A chat knows when its turn starts, ends and waits on the person because the
 * SDK says so. A CLI in a terminal only shows a screen, so ADE used to guess
 * from output (any output = working, 12 s quiet = idle) and asked a classifier
 * whether an idle screen wanted an answer. Two CLIs say it themselves:
 *
 * - Claude Code runs hooks. ADE adds hook settings to the launch
 *   (`--settings`), and each hook runs `ade __ade-cli-turn-hook claude <id>`,
 *   which hands the hook's JSON to this runtime. UserPromptSubmit starts a
 *   turn, Stop / StopFailure end it, PermissionRequest and the permission /
 *   elicitation Notification mean it waits on the person.
 * - Codex 0.167+ prints `ESC ] 7501 ; state=<s>:app=codex ST` on every change:
 *   working, done, idle, and blocked (`kind=permission`) while it waits for an
 *   approval.
 *
 * Every other CLI keeps the old guesses; they feed the same tracker as
 * `heuristic`, so a turn's start and end are announced the same way for all.
 *
 * This module is pure: it holds no timers and touches no service.
 */

export type CliTurnPhase = "working" | "idle" | "needs-input";
export type CliTurnExactSource = "claude-hooks" | "codex-osc";
export type CliTurnSource = CliTurnExactSource | "heuristic";

export type CliTurnSignal =
  | { kind: "working"; promptId?: string | null }
  | { kind: "needs-input"; message: string; promptId?: string | null }
  | {
    kind: "ended";
    promptId?: string | null;
    /**
     * `stop`: the CLI said its turn is over. `failure`: it ended on an error.
     * `interrupted`: the person stopped it (Esc / Ctrl-C, which Claude reports
     * with no hook). `quiet`: no output long after a missed end.
     */
    reason: "stop" | "failure" | "interrupted" | "quiet";
  };

export type CliTurnState = {
  /** The best source this session has reported through; exact sources stick. */
  source: CliTurnSource;
  phase: CliTurnPhase;
  turnStartedAt: number | null;
  /** What the CLI waits on, while `phase` is `needs-input`. */
  needsInputMessage: string | null;
  /** A line was submitted since the last turn ended. */
  submittedSinceEnd: boolean;
  /**
   * A line was submitted while a Claude turn ran: Claude queues it and may run
   * it as a turn of its own without another UserPromptSubmit, so the next Stop
   * does not prove the CLI is idle.
   */
  submittedWhileWorking: boolean;
  /** This turn's start was announced, so its end is too. */
  turnAnnounced: boolean;
  /**
   * When a line was submitted to an idle Claude that reports through hooks,
   * until its UserPromptSubmit arrives. Hooks that stopped arriving (the `ade`
   * they run is gone) would otherwise leave the row idle while Claude works.
   */
  awaitingHookSince: number | null;
  /**
   * Claude prompt ids whose Stop already arrived. Hooks run asynchronously, so
   * a UserPromptSubmit can land after its own Stop; it must not reopen the turn.
   */
  endedPromptIds: string[];
};

export type CliTurnTransition = {
  from: CliTurnPhase;
  to: CliTurnPhase;
  source: CliTurnSource;
  /** Start of the turn this transition belongs to (ms), when known. */
  turnStartedAt: number | null;
  /** Announce it to turn listeners: a real turn, not startup chatter. */
  announce: boolean;
};

/**
 * A tracked CLI's turn started: it went to working from idle or from waiting
 * on the person. Startup chatter (a CLI busy before anyone typed) is not a turn.
 */
export type TrackedCliTurnStartedEvent = {
  laneId: string;
  sessionId: string;
  startedAt: string;
  source: CliTurnSource;
};

/**
 * A tracked CLI's turn stopped: it went idle (`done`, including an interrupt)
 * or it waits on the person (`needs-input`). A turn that waited and then
 * finished reports both, in that order.
 */
export type TrackedCliTurnEndedEvent = {
  laneId: string;
  sessionId: string;
  turnStartedAt: string | null;
  endedAt: string;
  outcome: "done" | "needs-input";
  source: CliTurnSource;
};

const ENDED_PROMPT_IDS_LIMIT = 16;

/**
 * `source`: a Claude launch that carries ADE's turn hooks starts as
 * `claude-hooks`, so its startup output (and a resume's replayed history) is
 * not read as a turn before its first hook. A hook that never arrives drops
 * it back to the heuristics (`cliTurnHooksOverdue`).
 */
export function createCliTurnState(source: CliTurnSource = "heuristic"): CliTurnState {
  return {
    source,
    phase: "idle",
    turnStartedAt: null,
    needsInputMessage: null,
    submittedSinceEnd: false,
    submittedWhileWorking: false,
    turnAnnounced: false,
    awaitingHookSince: null,
    endedPromptIds: [],
  };
}

/** How long a submitted line may go without its UserPromptSubmit before hooks count as lost. */
export const CLI_TURN_HOOK_OVERDUE_MS = 8_000;

/**
 * Hooks count as lost: a line was submitted to an idle Claude and no hook came
 * back in time. The caller drops the session to the heuristics, and the next
 * hook that does arrive makes it exact again. A local slash command (`/model`)
 * fires no hook either; the cost is a few seconds of guessed status.
 */
export function cliTurnHooksOverdue(state: CliTurnState, now: number): boolean {
  return state.source === "claude-hooks"
    && state.awaitingHookSince != null
    && now - state.awaitingHookSince >= CLI_TURN_HOOK_OVERDUE_MS;
}

export function isExactCliTurnSource(source: CliTurnSource): source is CliTurnExactSource {
  return source !== "heuristic";
}

/** The terminal runtime state that stands for a tracker phase. */
export function runtimeStateForCliTurnPhase(phase: CliTurnPhase): "running" | "idle" | "waiting-input" {
  return phase === "working" ? "running" : phase === "needs-input" ? "waiting-input" : "idle";
}

/**
 * A submitted line (Enter) for this session. `phaseBefore` is the phase before
 * the keystroke was applied: a line typed while Claude works is queued.
 */
export function noteCliTurnSubmit(state: CliTurnState, phaseBefore: CliTurnPhase, now: number = Date.now()): void {
  state.submittedSinceEnd = true;
  if (phaseBefore === "working" && state.source === "claude-hooks") state.submittedWhileWorking = true;
  if (phaseBefore === "idle" && state.source === "claude-hooks" && state.awaitingHookSince == null) {
    state.awaitingHookSince = now;
  }
}

/**
 * Apply one signal. `origin` is where it came from; once a session reported
 * through an exact source, heuristic signals no longer move it, except a quiet
 * end for Claude (whose interrupts and some queued turns have no hook).
 */
export function reduceCliTurn(
  state: CliTurnState,
  signal: CliTurnSignal,
  origin: CliTurnSource,
  now: number,
): CliTurnTransition | null {
  if (origin === "heuristic" && isExactCliTurnSource(state.source)) {
    const claudeFallback = state.source === "claude-hooks"
      && signal.kind === "ended"
      && (signal.reason === "quiet" || signal.reason === "interrupted");
    if (!claudeFallback) return null;
  }
  if (isExactCliTurnSource(origin) && state.source !== origin) state.source = origin;
  if (origin === "claude-hooks") state.awaitingHookSince = null;

  const promptId = signal.promptId?.trim() || null;
  const from = state.phase;
  const transition = (to: CliTurnPhase, announce: boolean): CliTurnTransition => ({
    from,
    to,
    source: state.source,
    turnStartedAt: state.turnStartedAt,
    announce,
  });

  if (signal.kind === "ended") {
    if (promptId && !state.endedPromptIds.includes(promptId)) {
      state.endedPromptIds.push(promptId);
      if (state.endedPromptIds.length > ENDED_PROMPT_IDS_LIMIT) state.endedPromptIds.shift();
    }
    if (from === "idle") return null;
    if (signal.reason === "stop" && state.submittedWhileWorking) {
      // A queued line may run as the next turn with no UserPromptSubmit. Stay
      // working; its Stop, or the quiet fallback, ends it.
      state.submittedWhileWorking = false;
      return null;
    }
    const announce = state.turnAnnounced;
    state.phase = "idle";
    state.needsInputMessage = null;
    state.submittedSinceEnd = false;
    state.submittedWhileWorking = false;
    state.turnAnnounced = false;
    const result = transition("idle", announce);
    state.turnStartedAt = null;
    return result;
  }

  if (promptId && state.endedPromptIds.includes(promptId)) return null;

  if (signal.kind === "working") {
    if (from === "working") return null;
    if (from === "idle") {
      state.turnStartedAt = now;
      // Claude's UserPromptSubmit is a turn by definition. Codex and the
      // heuristics also go "working" while starting up; only a submitted line
      // makes that a turn.
      state.turnAnnounced = state.source === "claude-hooks" || state.submittedSinceEnd;
    }
    state.phase = "working";
    state.needsInputMessage = null;
    return transition("working", state.turnAnnounced);
  }

  // needs-input. A second report of the same wait (Claude's Notification after
  // its PermissionRequest) keeps the first, more specific message.
  if (from === "needs-input") return null;
  if (from === "idle") {
    state.turnStartedAt = now;
    state.turnAnnounced = true;
  }
  state.phase = "needs-input";
  state.needsInputMessage = signal.message.trim() || "Waiting for input in the terminal";
  return transition("needs-input", state.turnAnnounced);
}

// ---------------------------------------------------------------------------
// Claude Code hooks
// ---------------------------------------------------------------------------

/** Hidden `ade` command a Claude hook runs; see apps/ade-cli/src/cliTurnHook.ts. */
export const CLI_TURN_HOOK_COMMAND = "__ade-cli-turn-hook";
/** Env var carrying the runtime endpoint the hook reports to. */
export const CLI_TURN_HOOK_SOCKET_ENV = "ADE_CLI_TURN_HOOK_SOCKET";

/** The hook events ADE listens to, and nothing else: each one costs a process. */
export const CLAUDE_TURN_HOOK_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PermissionRequest",
  "Notification",
  "Elicitation",
] as const;

/**
 * Claude settings that add ADE's turn hooks. Exec form (`command` + `args`),
 * so no shell parses it and it runs the same on Windows. `async` keeps Claude
 * from waiting on ADE; a hook that cannot reach ADE exits 0 and changes nothing.
 */
export function buildClaudeTurnHookSettings(args: { cliPath: string; sessionId: string }): {
  hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
} {
  const hook = {
    type: "command",
    command: args.cliPath,
    args: [CLI_TURN_HOOK_COMMAND, "claude", args.sessionId],
    async: true,
    timeout: 10,
  };
  const hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> = {};
  for (const event of CLAUDE_TURN_HOOK_EVENTS) hooks[event] = [{ hooks: [{ ...hook }] }];
  return { hooks };
}

/**
 * Merge ADE's hooks into a `--settings` JSON object the launch already passes
 * (fast mode, ultracode). Claude reads only the last `--settings`, so a second
 * flag would drop one of them. Hook lists are appended, never replaced.
 */
export function mergeClaudeHookSettings(
  existing: Record<string, unknown>,
  addition: { hooks: Record<string, unknown[]> },
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  const current = existing.hooks && typeof existing.hooks === "object" && !Array.isArray(existing.hooks)
    ? existing.hooks as Record<string, unknown>
    : {};
  const hooks: Record<string, unknown> = { ...current };
  for (const [event, matchers] of Object.entries(addition.hooks)) {
    const prior = Array.isArray(current[event]) ? current[event] as unknown[] : [];
    const alreadyThere = prior.some((matcher) => JSON.stringify(matcher).includes(CLI_TURN_HOOK_COMMAND));
    hooks[event] = alreadyThere ? prior : [...prior, ...matchers];
  }
  merged.hooks = hooks;
  return merged;
}

/** Parse an inline `--settings` value; null for a path or anything not an object. */
export function parseInlineClaudeSettings(value: string | undefined): Record<string, unknown> | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Claude argv with ADE's hooks: merged into an inline `--settings`, or a new
 * `--settings` in front. Unchanged (null) when `--settings` names a file, which
 * ADE does not rewrite; that launch keeps the screen heuristics.
 */
export function withClaudeTurnHookArgs(args: readonly string[], settings: { hooks: Record<string, unknown[]> }): string[] | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--settings") {
      const existing = parseInlineClaudeSettings(args[index + 1]);
      if (!existing) return null;
      const next = args.slice();
      next[index + 1] = JSON.stringify(mergeClaudeHookSettings(existing, settings));
      return next;
    }
    if (arg.startsWith("--settings=")) {
      const existing = parseInlineClaudeSettings(arg.slice("--settings=".length));
      if (!existing) return null;
      const next = args.slice();
      next[index] = `--settings=${JSON.stringify(mergeClaudeHookSettings(existing, settings))}`;
      return next;
    }
  }
  return ["--settings", JSON.stringify(settings), ...args];
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * What one Claude hook payload means for the turn, or null for events that do
 * not move it (an idle reminder, a sign-in notice).
 */
export function claudeHookTurnSignal(payload: Record<string, unknown>): CliTurnSignal | null {
  const event = stringField(payload, "hook_event_name");
  const promptId = stringField(payload, "prompt_id");
  switch (event) {
    case "UserPromptSubmit":
      return { kind: "working", promptId };
    case "Stop":
      return { kind: "ended", reason: "stop", promptId };
    case "StopFailure":
      return { kind: "ended", reason: "failure", promptId };
    case "PermissionRequest": {
      const tool = stringField(payload, "tool_name");
      const message = tool === "AskUserQuestion"
        ? "Claude is asking you a question"
        : tool === "ExitPlanMode"
          ? "Claude wants you to approve its plan"
          : tool
            ? `Claude wants permission to use ${tool}`
            : "Claude wants your permission";
      return { kind: "needs-input", message, promptId };
    }
    case "Elicitation":
      return { kind: "needs-input", message: "Claude is asking for input", promptId };
    case "Notification": {
      const type = stringField(payload, "notification_type");
      if (type !== "permission_prompt" && type !== "elicitation_dialog") return null;
      const message = stringField(payload, "message");
      return { kind: "needs-input", message: message ? clip(message) : "Claude is waiting for you", promptId };
    }
    default:
      return null;
  }
}

/** The fields of a hook payload worth sending to the runtime; the rest stays local. */
export function claudeHookPayloadSummary(payload: Record<string, unknown>): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const key of ["hook_event_name", "prompt_id", "notification_type", "tool_name", "session_id"]) {
    const value = stringField(payload, key);
    if (value) summary[key] = value.slice(0, 200);
  }
  const message = stringField(payload, "message");
  if (message) summary.message = clip(message, 300);
  return summary;
}

// ---------------------------------------------------------------------------
// Codex OSC 7501
// ---------------------------------------------------------------------------

/** What a Codex OSC 7501 state means for the turn. */
export function codexOscTurnSignal(state: string): CliTurnSignal | null {
  switch (state) {
    case "working":
      return { kind: "working" };
    case "done":
      return { kind: "ended", reason: "stop" };
    // `idle` follows `done` once the composer is touched, and ends a turn that
    // was interrupted (Esc) without a `done`.
    case "idle":
      return { kind: "ended", reason: "interrupted" };
    case "blocked":
      return { kind: "needs-input", message: "Codex is waiting for your approval" };
    default:
      return null;
  }
}
