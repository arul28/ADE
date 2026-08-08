import type { TerminalResumeProvider, TerminalToolType } from "../../shared/types";
import { stripAnsi } from "./ansiStrip";
import { providerFromTool } from "./terminalSessionSignals";

/**
 * Richer CLI session states, read off the PTY stream.
 *
 * Today a tracked CLI only has two states: "running" while OSC 133 prompt
 * markers or fresh output say so, "idle" after 12 s of silence
 * (`runtimeStateFromOsc133Chunk` + the idle timer in `ptyService`). Chat
 * sessions have a richer vocabulary — planning, waiting on you, failed — and
 * the UI already renders all of it. What was missing is a producer for CLIs.
 *
 * These packs are that producer: a small set of per-provider TUI markers,
 * scanned incrementally over each PTY chunk, mapped onto the SAME
 * `chatActivityMode` / `runtimeState` fields chat already uses so no surface
 * needs new rendering code.
 *
 * Two shapes of marker, because TUIs emit two shapes of evidence:
 *
 *   PLANNING is a *footer* state. Claude Code repaints `⏸ plan mode on` on
 *   essentially every frame, so it is sticky-with-decay: re-observed constantly
 *   while true, and expiring on its own once the footer stops saying it. No
 *   explicit "left plan mode" event is needed (and none is reliably printed).
 *
 *   WAITING-INPUT is an *event*. The approval prompt is painted once and then
 *   sits there; silence afterwards is the session waiting, not the session
 *   finishing. So it latches and is cleared only by evidence that work resumed:
 *   a "working" marker (`esc to interrupt`) or the user typing. A session that
 *   exits reports nothing at all — its entry is no longer live.
 *
 * FAILED needs no markers here: a nonzero exit already lands as
 * `status: "failed"` via `statusFromExit`, which `canonicalSessionState` reads
 * as the `failed` phase.
 *
 * Cost matters — this runs on every PTY chunk for every tracked session — so a
 * provider with no pack (a plain shell, an unrecognized CLI) allocates nothing
 * and does no scanning at all, and the ones that do scan see a bounded window.
 */
export type TerminalTuiActivity = "planning" | "waiting-input" | null;

/** Scan window: chunk tail plus a small carry, so a marker split across chunks still matches. */
const MAX_CHUNK_SCAN_CHARS = 8_000;
const CARRY_CHARS = 512;

/**
 * How long a planning footer stays believed after it was last painted. Long
 * enough to survive a quiet stretch mid-frame, short enough that a session that
 * left plan mode without saying so stops claiming it.
 */
const PLANNING_TTL_MS = 60_000;

/**
 * How long a waiting prompt stays believed.
 *
 * The latch is deliberately cleared only by evidence (a working marker, or the
 * user typing), and that is right for a real prompt — but a FALSE positive has
 * no such evidence coming, and without a bound it pins the session at
 * "waiting-input" across every surface forever. The window is much longer than
 * planning's because a human genuinely can leave an approval prompt sitting for
 * a while; it exists to bound a mistake, not to time out a user.
 */
const WAITING_TTL_MS = 30 * 60_000;

type MarkerPack = {
  /** Footer/banner evidence that the agent is in a plan-only mode. */
  planning: readonly RegExp[];
  /** Prompt evidence that the agent stopped and is waiting on the human. */
  waitingInput: readonly RegExp[];
  /** Evidence that work is actively running — releases the waiting-input latch. */
  working: readonly RegExp[];
};

/** Shared across packs: option-list and yes/no prompt shapes every TUI borrows. */
// Anchored toward the end of its line: a real prompt ENDS with its `(y/n)`,
// while the same characters quoted mid-sentence ("answer with (y/n) when
// asked", a diff hunk, a man page) are the false positives this used to latch
// on. Trailing space/cursor-ish punctuation is allowed because a TUI paints a
// caret after the prompt.
const YES_NO_PROMPT = /(?:\((?:y\/n|yes\/no)\)|\[(?:y\/n|yes\/no)\])[\s:>?\u2588\u258e]*(?:$|\n)/i;
const NUMBERED_YES_OPTION = /❯\s*1\.\s*Yes\b/;
const ESC_TO_INTERRUPT = /\besc(?:ape)? to interrupt\b/i;

const CLAUDE_PACK: MarkerPack = {
  // The footer Claude Code repaints while plan mode is on: `⏸ plan mode on`.
  planning: [/\bplan mode on\b/i],
  waitingInput: [
    /\bDo you want to (?:proceed|continue|make this edit|create|run|allow)\b/i,
    /\bWould you like to (?:proceed|continue)\b/i,
    /\bReady to code\?/i,
    NUMBERED_YES_OPTION,
    YES_NO_PROMPT,
  ],
  working: [ESC_TO_INTERRUPT],
};

const CODEX_PACK: MarkerPack = {
  planning: [
    /\bplan mode\b/i,
    /\bread-only mode\b/i,
  ],
  waitingInput: [
    /\bAllow (?:command|Codex)\b[^\n]{0,40}\?/i,
    /\bDo you want to (?:allow|approve|run)\b/i,
    /\bapprove this (?:command|edit)\b/i,
    NUMBERED_YES_OPTION,
    YES_NO_PROMPT,
  ],
  working: [ESC_TO_INTERRUPT, /\bWorking\b[^\n]{0,20}\(esc/i],
};

/** Best-effort: cursor-agent's prompt vocabulary is close to Claude Code's. */
const CURSOR_PACK: MarkerPack = {
  planning: [/\bplan mode\b/i, /\bask mode\b/i],
  waitingInput: [NUMBERED_YES_OPTION, YES_NO_PROMPT, /\bapprove\b[^\n]{0,30}\?/i],
  working: [ESC_TO_INTERRUPT],
};

/** Best-effort: opencode surfaces its agent name and a permission prompt. */
const OPENCODE_PACK: MarkerPack = {
  planning: [/\bplan mode\b/i, /\bagent:\s*plan\b/i],
  waitingInput: [
    /\bpermission (?:request|required)\b/i,
    /\ballow this (?:action|command|edit)\b/i,
    NUMBERED_YES_OPTION,
    YES_NO_PROMPT,
  ],
  working: [ESC_TO_INTERRUPT],
};

/** Best-effort: droid calls its plan-only mode "spec mode". */
const DROID_PACK: MarkerPack = {
  planning: [/\bspec mode\b/i, /\bplan mode\b/i],
  waitingInput: [NUMBERED_YES_OPTION, YES_NO_PROMPT, /\bapprove\b[^\n]{0,30}\?/i],
  working: [ESC_TO_INTERRUPT],
};

/** Pi's interactive CLI uses the same compact approval/plan vocabulary as its RPC surface. */
const PI_PACK: MarkerPack = {
  planning: [/\bplan mode\b/i, /\bplanning\b/i],
  waitingInput: [NUMBERED_YES_OPTION, YES_NO_PROMPT, /\bapprove\b[^\n]{0,30}\?/i],
  working: [ESC_TO_INTERRUPT],
};

const PACKS: Record<TerminalResumeProvider, MarkerPack> = {
  claude: CLAUDE_PACK,
  codex: CODEX_PACK,
  cursor: CURSOR_PACK,
  droid: DROID_PACK,
  opencode: OPENCODE_PACK,
  pi: PI_PACK,
};

export type TuiMarkerState = {
  pack: MarkerPack;
  /** Tail of the last scan window, so a marker split across chunks still matches. */
  carry: string;
  /** When the planning footer was last observed; null means never. */
  planningSeenAt: number | null;
  /**
   * When a waiting prompt was last seen, or null when nothing is pending.
   * A timestamp rather than a flag so callers can ignore a latch older than an
   * explicit settle — the same "strictly newer than" rule snooze uses for
   * errors, and what keeps a false positive from making a row unsettleable.
   */
  waitingSince: number | null;
};

/**
 * Null for anything without a pack — a plain shell, an unknown CLI. Callers
 * skip all marker work when this is null, which is what makes unrecognized
 * providers degrade to exactly today's working/idle behavior.
 */
export function createTuiMarkerState(toolType: TerminalToolType | null | undefined): TuiMarkerState | null {
  const provider = providerFromTool(toolType);
  if (!provider) return null;
  return { pack: PACKS[provider], carry: "", planningSeenAt: null, waitingSince: null };
}

const GLOBAL_PATTERNS = new WeakMap<RegExp, RegExp>();

function globalPattern(pattern: RegExp): RegExp {
  const cached = GLOBAL_PATTERNS.get(pattern);
  if (cached) return cached;
  const next = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  GLOBAL_PATTERNS.set(pattern, next);
  return next;
}

/**
 * Index of the LAST match in the window, or -1. Position is what decides
 * whether the agent is waiting or working: a window routinely contains both the
 * prompt (carried over, or painted earlier in the same repaint) and the spinner
 * that replaced it, and only the later one is the current truth.
 */
function lastMatchIndex(patterns: readonly RegExp[], text: string): number {
  let best = -1;
  for (const pattern of patterns) {
    const scanner = globalPattern(pattern);
    scanner.lastIndex = 0;
    for (;;) {
      const match = scanner.exec(text);
      if (!match) break;
      if (match.index > best) best = match.index;
      if (scanner.lastIndex === match.index) scanner.lastIndex += 1;
    }
  }
  return best;
}

/** The user typed: whatever the agent was waiting for, it has it now. */
export function clearTuiWaitingInput(state: TuiMarkerState | null): void {
  if (!state) return;
  state.waitingSince = null;
  // The carry holds the tail of the last window, and a prompt short enough to
  // fit in it would be re-matched by the very next chunk and re-latch the state
  // the user just answered. It has served its purpose (joining a marker split
  // across chunks); dropping it here costs nothing and closes that loop.
  state.carry = "";
}

export function tuiActivityFromState(
  state: TuiMarkerState | null,
  opts: {
    nowMs?: number;
    /**
     * Ignore a waiting latch no newer than this (the row's `settledAt`). A
     * session the user declared done stays done until the TUI paints a NEW
     * prompt.
     */
    waitingFloorMs?: number | null;
  } = {},
): TerminalTuiActivity {
  if (!state) return null;
  const nowMs = opts.nowMs ?? Date.now();
  const floor = opts.waitingFloorMs ?? null;
  // Waiting on the human outranks planning: it is the actionable one.
  if (
    state.waitingSince != null
    && nowMs - state.waitingSince < WAITING_TTL_MS
    && (floor == null || state.waitingSince > floor)
  ) return "waiting-input";
  if (state.planningSeenAt != null && nowMs - state.planningSeenAt < PLANNING_TTL_MS) return "planning";
  return null;
}

/**
 * Fold one PTY chunk into the marker state and return the resulting activity.
 * Bounded work: one ANSI strip and a handful of regexes over at most
 * 2 × MAX_CHUNK_SCAN_CHARS + CARRY_CHARS characters.
 */
export function scanTuiMarkers(
  state: TuiMarkerState | null,
  args: { chunk: string; nowMs?: number },
): TerminalTuiActivity {
  const nowMs = args.nowMs ?? Date.now();
  if (!state) return null;
  const chunk = args.chunk ?? "";
  if (!chunk) return tuiActivityFromState(state, { nowMs });

  // An oversized chunk is a burst of frames, and the interesting markers sit at
  // BOTH ends of it: the prompt the burst opened with (which the tail-only
  // window dropped entirely) and whatever state it came to rest in. Scanning
  // head and tail keeps the work bounded while `lastMatchIndex`'s position rule
  // still resolves them in order, because the head slice precedes the tail one.
  const scanned = chunk.length > MAX_CHUNK_SCAN_CHARS * 2
    ? `${chunk.slice(0, MAX_CHUNK_SCAN_CHARS)}\n${chunk.slice(-MAX_CHUNK_SCAN_CHARS)}`
    : chunk;
  const window = `${state.carry}${scanned}`;
  const text = stripAnsi(window);
  state.carry = window.slice(-CARRY_CHARS);

  if (lastMatchIndex(state.pack.planning, text) >= 0) {
    state.planningSeenAt = nowMs;
  }
  const waitingAt = lastMatchIndex(state.pack.waitingInput, text);
  const workingAt = lastMatchIndex(state.pack.working, text);
  if (waitingAt >= 0 && waitingAt > workingAt) {
    // EDGE only. A TUI repaints its prompt on essentially every frame, so
    // re-stamping per sighting walks `waitingSince` forward forever — past any
    // `settledAt` the user sets, which is precisely what made a settle refuse to
    // stick. The latch is armed once and re-armed only after something clears
    // it: a working marker below, or the user typing (`clearTuiWaitingInput`).
    if (state.waitingSince == null) state.waitingSince = nowMs;
  } else if (workingAt >= 0 && state.waitingSince != null) {
    // The prompt was answered (or withdrawn) and the agent is running again.
    state.waitingSince = null;
  }

  return tuiActivityFromState(state, { nowMs });
}
