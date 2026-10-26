/**
 * Terminal watch: a chat asks ADE to wake it when an ADE terminal prints
 * something new, instead of polling `ade terminal read`.
 *
 * This module is the all-client half: the wire types every surface reads, and
 * the pure parsers the brain and the CLI share. The watch itself runs in
 * `main/services/pty/terminalWatchService.ts`, on the brain that owns the chat
 * and the terminal.
 */

/** Why a watch ended. */
export type TerminalWatchStopReason =
  /** `ade terminal unwatch`, the Stop button, or the agent's own tool. */
  | "unwatched"
  /** The terminal's process exited. */
  | "terminal_exited"
  /** The watch outlived its lifetime. */
  | "expired"
  /** It woke the chat too often in an hour. */
  | "wake_limit"
  /** Wakes could not be delivered several times in a row. */
  | "delivery_failed"
  /** The chat was archived or deleted. */
  | "chat_gone"
  /** A newer watch on the same terminal from the same chat replaced it. */
  | "replaced";

/** What a chat shows about one of its terminal watches. */
export type TerminalWatchSummary = {
  watchId: string;
  /** The chat that is woken. */
  chatSessionId: string;
  /** The watched terminal's session id. */
  terminalId: string;
  terminalTitle: string;
  /** The filter as the caller gave it (`error`, `ready|listening`), or null for any output. */
  match: string | null;
  armedBy: "agent" | "user";
  status: "active" | "stopped";
  startedAt: string;
  expiresAt: string;
  stoppedAt: string | null;
  stopReason: TerminalWatchStopReason | null;
  wakeCount: number;
  lastWokeAt: string | null;
  /** New output seen since the watch started (UTF-8 bytes). */
  bytesSeen: number;
  /** True while output is held for a busy or settled chat. */
  holding: boolean;
};

export type TerminalWatchArgs = {
  /** The chat to wake. Agents pass their own (`ADE_CHAT_SESSION_ID`). */
  chatSessionId: string;
  /** Terminal session id (or a PTY id). Omit to watch the chat's active shell, or with `command`. */
  terminalId?: string | null;
  ptyId?: string | null;
  /**
   * Start this command in a new ADE shell in the chat's lane and watch it from
   * its first byte. Mutually exclusive with `terminalId` / `ptyId`.
   */
  command?: string | null;
  /** Lane for `command`; defaults to the chat's lane. */
  laneId?: string | null;
  /** Wake only on lines containing this text (case-insensitive); `|` separates alternatives. */
  match?: string | null;
  /** How long the watch lives: minutes as a number, or `30m`, `2h`, `1d`. */
  lifetime?: string | number | null;
  armedBy?: "agent" | "user";
};

export type TerminalWatchResult = {
  watch: TerminalWatchSummary;
  /** A watch on this terminal from this chat was already on; it was replaced. */
  replaced: boolean;
};

export type TerminalUnwatchArgs = {
  watchId?: string | null;
  /** With `chatSessionId`: stop that chat's watch on this terminal. */
  terminalId?: string | null;
  /** Alone: stop every watch this chat has. */
  chatSessionId?: string | null;
};

export type TerminalUnwatchResult = {
  stopped: TerminalWatchSummary[];
};

export type TerminalListWatchesArgs = {
  chatSessionId?: string | null;
  terminalId?: string | null;
};

/**
 * Read watch arguments from an untyped caller (IPC, a runtime action). Each
 * text field must be a string or absent; anything else is refused by name
 * instead of failing later inside the service.
 */
function optionalText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`Terminal watch '${key}' must be text.`);
  return value;
}

function argsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readTerminalWatchArgs(value: unknown): TerminalWatchArgs {
  const record = argsRecord(value);
  const lifetime = record.lifetime;
  if (lifetime != null && typeof lifetime !== "string" && typeof lifetime !== "number") {
    throw new Error("Terminal watch 'lifetime' must be minutes or a duration such as 30m.");
  }
  const armedBy = record.armedBy;
  return {
    chatSessionId: optionalText(record, "chatSessionId") ?? "",
    terminalId: optionalText(record, "terminalId"),
    ptyId: optionalText(record, "ptyId"),
    command: optionalText(record, "command"),
    laneId: optionalText(record, "laneId"),
    match: optionalText(record, "match"),
    lifetime: lifetime ?? null,
    ...(armedBy === "agent" || armedBy === "user" ? { armedBy } : {}),
  };
}

export function readTerminalUnwatchArgs(value: unknown): TerminalUnwatchArgs {
  const record = argsRecord(value);
  return {
    watchId: optionalText(record, "watchId"),
    terminalId: optionalText(record, "terminalId"),
    chatSessionId: optionalText(record, "chatSessionId"),
  };
}

export function readTerminalListWatchesArgs(value: unknown): TerminalListWatchesArgs {
  const record = argsRecord(value);
  return {
    chatSessionId: optionalText(record, "chatSessionId"),
    terminalId: optionalText(record, "terminalId"),
  };
}

export const TERMINAL_WATCH_DEFAULT_LIFETIME_MS = 2 * 60 * 60_000;
export const TERMINAL_WATCH_MAX_LIFETIME_MS = 24 * 60 * 60_000;
export const TERMINAL_WATCH_MIN_LIFETIME_MS = 60_000;
/** Longest `match` pattern accepted. */
export const TERMINAL_WATCH_MATCH_MAX_CHARS = 200;

const LIFETIME_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * Parse a lifetime: a bare number is minutes; `90s`, `30m`, `2h`, `1d` carry a
 * unit. Clamped to [1 minute, 24 hours]. Null/empty means the default.
 */
export function parseTerminalWatchLifetimeMs(value: unknown): number {
  if (value == null || value === "") return TERMINAL_WATCH_DEFAULT_LIFETIME_MS;
  let ms: number;
  if (typeof value === "number") {
    ms = value * 60_000;
  } else {
    const text = String(value).trim().toLowerCase();
    const parsed = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)?$/.exec(text);
    if (!parsed) {
      throw new Error(`Couldn't read lifetime "${String(value)}". Use minutes (90) or a unit: 30m, 2h, 1d.`);
    }
    const amount = Number(parsed[1]);
    // The regex admits only these units, so the first letter names each one.
    const unit = (parsed[2] ?? "m")[0] as keyof typeof LIFETIME_UNIT_MS;
    ms = amount * LIFETIME_UNIT_MS[unit];
  }
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error("Lifetime must be a positive duration, such as 30m or 2h.");
  }
  return Math.min(TERMINAL_WATCH_MAX_LIFETIME_MS, Math.max(TERMINAL_WATCH_MIN_LIFETIME_MS, Math.round(ms)));
}

export type TerminalWatchMatcher = {
  /** As given, for display. */
  label: string;
  test: (line: string) => boolean;
};

/**
 * Compile a `match` filter: case-insensitive text, with `|` between
 * alternatives (`error|failed`). Null/empty means "any output".
 *
 * Plain text on purpose, not regular expressions: the brain tests every line a
 * busy process prints on its main thread, and no up-front check reliably
 * refuses a pattern that backtracks for seconds (`^(a|a)*$`). Substring tests
 * are linear in the line.
 */
export function compileTerminalWatchMatch(value: unknown): TerminalWatchMatcher | null {
  if (value == null) return null;
  const raw = String(value);
  if (!raw.trim()) return null;
  if (raw.length > TERMINAL_WATCH_MATCH_MAX_CHARS) {
    throw new Error(`The match filter is too long (max ${TERMINAL_WATCH_MATCH_MAX_CHARS} characters).`);
  }
  if (/^\/.+\/[a-z]*$/s.test(raw.trim())) {
    throw new Error("Match takes plain text, not a regular expression. Separate alternatives with |, as in error|failed.");
  }
  const needles = raw.split("|").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return null;
  return {
    label: raw.trim(),
    test: (line) => {
      const lower = line.toLowerCase();
      return needles.some((needle) => lower.includes(needle));
    },
  };
}

export function describeTerminalWatchStop(reason: TerminalWatchStopReason, exitCode?: number | null): string {
  switch (reason) {
    case "terminal_exited":
      return exitCode == null ? "the terminal exited" : `the terminal exited with code ${exitCode}`;
    case "expired":
      return "the watch reached the end of its lifetime";
    case "wake_limit":
      return "the watch woke you too many times in an hour";
    case "delivery_failed":
      return "ADE could not deliver its wakes";
    case "chat_gone":
      return "the chat was archived or deleted";
    case "replaced":
      return "a newer watch on this terminal replaced it";
    default:
      return "the watch was stopped";
  }
}
