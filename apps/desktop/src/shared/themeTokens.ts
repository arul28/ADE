/**
 * Theme values that something outside the renderer has to know.
 *
 * The renderer reads its colours from CSS custom properties, which is exactly
 * right for the renderer and useless to the main process: a tap ring is
 * composited into a recording by a Swift helper running in a process with no
 * document, no stylesheet, and no window. Rather than let the recorder invent
 * its own blue — which is what "the accent" meant until now — the one value it
 * needs is stated here, in `shared/`, where both sides can reach it.
 *
 * `themeTokens.test.ts` reads `renderer/index.css` and fails if this drifts
 * from `--color-accent`, so the mirror cannot rot quietly.
 */

/**
 * ADE's primary accent — `--color-accent` in the default (dark) theme.
 *
 * Deliberately the default theme's value rather than "whatever theme is on":
 * the recording is composited on the machine that owns the device, which may
 * not be the machine anyone is looking at, and a proof video whose tap rings
 * change colour depending on which desktop happened to be open would be worse
 * than one consistent accent.
 */
export const ADE_ACCENT_COLOR = "#A78BFA";
