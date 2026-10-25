/**
 * The one line of prompt a lane screen costs, and the gate in front of it.
 *
 * The whole feature's agent-facing prompt budget is a single line, emitted only
 * when the host can provide a lane display. That is a deliberate constraint,
 * not a stylistic choice: most lanes never touch a screen, and a paragraph
 * about a capability they do not have is paid on every
 * turn, forever, by every one of them. `buildMacDesktopDirective` answers
 * `null` for those lanes, and `composeLaunchDirectives` drops nulls — so a lane
 * with the tool off produces a byte-identical prompt to one built before this
 * file existed. A capable lane is told it can start a screen before one is
 * active, then gets an updated line when it starts. The chat service keys the
 * line like its other epoch directives, so it is not repeated on every turn.
 *
 * Kept as a pure function in its own module, next to the other prompt
 * builders, so the gate can be tested without standing up a chat service.
 */

/** The line itself. Exported so a test can assert on it without rebuilding it. */
export const MAC_DESKTOP_PROMPT_LINE =
  "This lane has a private macOS screen (Mac Desktop). Drive it with `ade mac-desktop` — observe first, act on the handles it returns; read the **ade-computer-use** skill before your first action. Stop it when you finish unless the user wants to look. If it refuses, report it; do not fall back to the user's real screen.";

/** The same line for a Windows host, whose lane screen is the Windows Desktop. */
export const WINDOWS_DESKTOP_PROMPT_LINE =
  "This lane has a private Windows screen (Windows Desktop). Drive it with `ade screen` — observe first, act on the handles it returns; read the **ade-computer-use** skill before your first action. Stop it when you finish unless the user wants to look. The default seat is private; the user's main desktop needs their yes (`ade screen start --shared --reason \"…\"`); never use `--allow-prompt` or `--consent` yourself.";

const MAC_DESKTOP_CAPABILITY_PROMPT_LINE =
  "This lane can start its own private macOS screen (Mac Desktop), only for what no CLI, test or background tool reaches, such as a native Mac app or real Mac windows. Use `ade mac-desktop` — read the **ade-computer-use** skill before your first action, and stop it when you finish. If it refuses, report it; do not fall back to the user's real screen.";

const WINDOWS_DESKTOP_CAPABILITY_PROMPT_LINE =
  "This lane can start its own private Windows screen (Windows Desktop), only for what no CLI, test or background tool reaches, such as a native Windows app. Use `ade screen` — read the **ade-computer-use** skill before your first action, and stop it when you finish. The default seat is private; the user's main desktop needs their yes; never use `--allow-prompt` or `--consent` yourself.";

/**
 * @param available True when this host can provide the lane a private display.
 * @param hostPlatform The platform of the machine that owns the lane screen —
 *   the brain running this chat, which is not always the machine the user is
 *   looking at.
 * @param active True when this lane's private display is currently active.
 */
export function buildMacDesktopDirective(
  available: boolean,
  hostPlatform: NodeJS.Platform | null | undefined = "darwin",
  active = available,
): string | null {
  if (!available) return null;
  if (hostPlatform === "win32") {
    return active ? WINDOWS_DESKTOP_PROMPT_LINE : WINDOWS_DESKTOP_CAPABILITY_PROMPT_LINE;
  }
  return active ? MAC_DESKTOP_PROMPT_LINE : MAC_DESKTOP_CAPABILITY_PROMPT_LINE;
}
