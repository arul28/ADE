/**
 * The one line of system prompt Mac Desktop costs, and the gate in front of it.
 *
 * The whole feature's agent-facing prompt budget is a single line, emitted only
 * when the lane actually has a display (or has been granted the tool). That is
 * a deliberate constraint, not a stylistic one: most lanes never touch a
 * screen, and a paragraph about a capability they do not have is paid on every
 * turn, forever, by every one of them. `buildMacDesktopDirective` answers
 * `null` for those lanes, and `composeLaunchDirectives` drops nulls — so a lane
 * with the tool off produces a byte-identical prompt to one built before this
 * file existed. `macDesktopDirectiveOffPromptIsUnchanged` in the tests is what
 * holds that.
 *
 * Kept as a pure function in its own module, next to the other prompt
 * builders, so the gate can be tested without standing up a chat service.
 */

/** The line itself. Exported so a test can assert on it without rebuilding it. */
export const MAC_DESKTOP_PROMPT_LINE =
  "This lane has a private macOS screen (Mac Desktop). Drive it with `ade mac-desktop` — observe first, act on the handles it returns; read the **ade-desktop** skill before your first action.";

/**
 * @param enabled True when this lane has a Mac Desktop display right now. The
 *   caller asks the runtime service directly, so there is one answer rather
 *   than a state object two callers could fill in differently.
 */
export function buildMacDesktopDirective(enabled: boolean): string | null {
  return enabled ? MAC_DESKTOP_PROMPT_LINE : null;
}
