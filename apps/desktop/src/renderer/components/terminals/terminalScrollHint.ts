import type { TerminalToolType } from "../../../shared/types";

/**
 * Keyboard-scroll hints for CLI/TUI sessions viewed in the web client.
 *
 * Every agent CLI we launch runs on the terminal's ALTERNATE screen with mouse
 * reporting on, so the wheel is forwarded to the app as mouse reports rather
 * than scrolling xterm's scrollback. Over sync each of those reports is one
 * ACK-gated round trip (`webclient/sync/client.ts` — the terminal input queue
 * sends `queue[0]` and waits for its ack), so a wheel spin advances a few lines
 * per network round trip. A `PgUp` is one keystroke that moves half a screen
 * for the same single trip, which is why the keyboard feels instant and the
 * wheel does not.
 *
 * The hint is therefore only worth showing where we KNOW the keys work. Copy is
 * per provider and taken from vendor documentation, not from guessing:
 *
 *   claude    PgUp/PgDn scroll by half a screen; on Mac keyboards Fn+↑/Fn+↓
 *             send PgUp/PgDn. (code.claude.com/docs/en/fullscreen)
 *   opencode  `messages_page_up` / `messages_page_down` are bound to
 *             pageup/pagedown by default. (opencode.ai/docs/keybinds)
 *   codex     Scrolling lives in the transcript overlay: Ctrl+T opens it, and
 *             the pager keymap (`pager.page_up` / `pager.page_down`) drives it.
 *             A bare PgUp hint would be wrong here.
 *
 * droid and cursor-agent are deliberately absent: their binaries carry
 * pageup/pagedown handling, but neither vendor documents transcript scrolling,
 * and an unverified key hint is worse than no hint.
 */
export type TerminalScrollHintCopy = {
  /** Provider whose keys these are — also the dismissal-memory key. */
  toolType: TerminalToolType;
  /** Short label rendered in the pill. */
  keys: string;
};

const HINTS: Partial<Record<TerminalToolType, { keys: string; macKeys: string }>> = {
  claude: { keys: "PgUp / PgDn", macKeys: "Fn+↑ / Fn+↓" },
  opencode: { keys: "PgUp / PgDn", macKeys: "Fn+↑ / Fn+↓" },
  codex: { keys: "Ctrl+T, then PgUp / PgDn", macKeys: "Ctrl+T, then Fn+↑ / Fn+↓" },
};

/**
 * Mac keyboards have no dedicated PgUp/PgDn, so naming those keys on macOS
 * sends people looking for a key they do not have.
 */
export function isAppleKeyboardPlatform(platform: string | undefined = typeof navigator !== "undefined" ? navigator.platform : ""): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "");
}

export function terminalScrollHintFor(
  toolType: TerminalToolType | null | undefined,
  options: { applePlatform?: boolean } = {},
): TerminalScrollHintCopy | null {
  if (!toolType) return null;
  const hint = HINTS[toolType];
  if (!hint) return null;
  const applePlatform = options.applePlatform ?? isAppleKeyboardPlatform();
  return { toolType, keys: applePlatform ? hint.macKeys : hint.keys };
}

const DISMISSED_STORAGE_KEY = "ade.terminal.scrollHintDismissed.v1";

/**
 * Dismissal is remembered PER PROVIDER, not globally: the keys genuinely
 * differ (Codex needs its transcript overlay first), so learning Claude's
 * shortcut teaches you nothing about Codex's.
 */
export function readDismissedScrollHints(storage: Pick<Storage, "getItem"> | null | undefined): Set<string> {
  try {
    const raw = storage?.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeDismissedScrollHint(
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
  toolType: TerminalToolType,
): Set<string> {
  const next = readDismissedScrollHints(storage);
  next.add(toolType);
  try {
    storage?.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // A full or unavailable localStorage must not break the terminal.
  }
  return next;
}
