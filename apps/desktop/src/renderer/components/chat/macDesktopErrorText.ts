/**
 * The sentence a Mac Desktop failure should show a person.
 *
 * Two layers add machine-readable noise to every error that crosses the
 * daemon boundary, and neither is meant for a panel:
 *
 *   1. The service tags its errors `MAC_DESKTOP_NO_DISPLAY: …` so the CLI can
 *      look up a recovery hint from a flattened `message` string.
 *   2. Electron wraps anything thrown inside an IPC handler as
 *      `Error invoking remote method 'ade.localRuntime.callAction': Error: …`.
 *
 * Both are useful in a log and useless in a chip that is 180px wide, so this
 * is the one place that peels them off. Pure and string-in/string-out: the
 * renderer has no business deciding what a code means, only that the person
 * reading the panel should not have to.
 */

/** `MAC_DESKTOP_NO_DISPLAY: `, and the driver's lowercase `window_not_ready: `. */
const CODE_PREFIX = /^(?:MAC_DESKTOP_[A-Z0-9_]+|[a-z][a-z0-9_]*(?:_[a-z0-9_]+)+):\s*/;

/** Electron's IPC wrapper, however many `Error:` hops it stacked up. */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const ERROR_LABEL = /^(?:[A-Za-z]*Error):\s*/;

export function macDesktopErrorText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text.length) return null;
  // Order matters: the wrapper sits outside the `Error:` labels, which sit
  // outside the service's own code prefix.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    text = text.replace(IPC_WRAPPER, "").replace(ERROR_LABEL, "").replace(CODE_PREFIX, "").trim();
    if (text === before) break;
  }
  return text.length ? text : null;
}
