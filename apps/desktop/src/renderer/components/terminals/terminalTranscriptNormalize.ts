import { Terminal } from "@xterm/xterm";

/**
 * Width-normalization of raw PTY transcripts, and the mode state that survives it.
 *
 * Split out of `TerminalView` because none of it touches a runtime: given a
 * transcript string these produce a width-independent grid and the DEC private
 * modes to re-assert after it. Pure, and testable without a mounted terminal.
 */

// The smallest column count worth treating as a real measurement. Below this a
// "fit" is a pane caught mid-layout, not a viewport.
export const MIN_VALID_COLS = 20;

// Bound on the offscreen normalization grid. Wide enough for any real PTY,
// capped so a corrupt/hostile column number cannot allocate an enormous buffer.
const TRANSCRIPT_NORMALIZE_MAX_COLS = 400;
const TRANSCRIPT_NORMALIZE_ROWS = 96;

/**
 * Widest column any absolute cursor-positioning sequence in `raw` addresses.
 *
 * A transcript records the escape sequences a TUI emitted at the PTY's width at
 * the time, so the highest column it ever addresses is a lower bound on that
 * width. Used to render the replay at (at least) the width it was written for.
 */
export function inferTranscriptColumns(raw: string): number {
  let maxCol = 0;
  for (const match of raw.matchAll(/\x1b\[(\d+);(\d+)[Hf]/g)) {
    const col = Number.parseInt(match[2] ?? "", 10);
    if (Number.isFinite(col) && col > maxCol) maxCol = col;
  }
  for (const match of raw.matchAll(/\x1b\[(\d+)G/g)) {
    const col = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(col) && col > maxCol) maxCol = col;
  }
  return maxCol;
}

/**
 * DEC private modes worth restoring after a grid hydration, in emit order.
 *
 * Mouse tracking first, then its encoding (an encoding without a tracking mode
 * does nothing), then the rest. Deliberately EXCLUDES the alt-screen modes
 * (1049/47): the normalized grid is written into the MAIN buffer, so switching
 * to the alternate buffer afterwards would hide the content we just restored.
 * The real transcripts bear this out — the byte census over 2 MB of a live
 * Claude Code session found zero alt-screen toggles.
 */
const RESTORABLE_TERMINAL_MODES: readonly number[] = [
  // Mouse tracking, MOST CAPABLE FIRST — only the first still-set one is
  // emitted, and any-event ⊃ drag ⊃ vt200 ⊃ x10.
  1003, 1002, 1000, 9,
  1005, 1006, 1015, // mouse report encoding
  1, 6, 7, 45, 66, // cursor keys, origin, wraparound, reverse wraparound, keypad
  1004, // focus reporting
  2004, // bracketed paste
  25, // cursor visibility
];

/**
 * Reconstructs the DEC private modes a TUI still has set, from its transcript.
 *
 * A terminal is not just a grid of glyphs — it has MODE state, and mouse
 * tracking is the one users feel. With it set, xterm forwards wheel events to
 * the application as input and the TUI scrolls its own pane under a pinned
 * prompt; without it, the wheel scrolls xterm's scrollback instead and the app
 * never learns the user scrolled.
 *
 * The desktop gets this for free: `SerializeAddon.serialize()` appends
 * `_serializeModes()` output unless `excludeModes` is passed, and ptyService
 * (:1881) does not pass it — so a desktop snapshot carries `ESC[?1002h` and
 * friends. The web has no serialized snapshot at all; raw-transcript replay
 * carried modes only by accident (the DECSET had to fall inside the tail), and
 * grid normalization strips every escape sequence by construction. Hence this:
 * scan the raw bytes for the LAST set/reset of each mode and re-emit the ones
 * still active.
 *
 * How far back that scan can reach, and why the tail is enough:
 *
 * The obvious move — fetch the HEAD of the transcript, where a TUI "sets its
 * modes once at startup" — was measured against the real 13.6 MB log and does
 * not work: the first mouse DECSET sits 8.4% in (the transcript opens with
 * pre-TUI shell output), so a head window finds nothing at all.
 *
 * What the same measurement shows is that this class of TUI RE-ASSERTS its
 * modes continuously — 2228 mouse-mode sequences across the file, 476 of them
 * inside the last 2 MB, largest gap between assertions 1.16 MB. So the
 * `HYDRATE_TAIL_BYTES` (2 MB) window the client already receives does contain
 * current mode state, with roughly a 0.8 MB margin.
 *
 * That margin is the remaining limit, and it is real: a TUI that sets its modes
 * once and then emits more than 2 MB of quiet output would fall out of the
 * window and lose mouse tracking exactly as reported. Closing it properly needs
 * the HOST to report modes rather than the client to archaeologise them — its
 * headless mirror already knows them, and SerializeAddon reads them off
 * `terminal.modes`. See the report for the wire-field recommendation.
 */
export function inferTerminalModesFromTranscript(raw: string): string {
  if (!raw.length) return "";
  const active = new Map<number, boolean>();
  // `ESC[?1002;1006h` sets several modes at once, so split the parameters.
  for (const match of raw.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    const set = match[2] === "h";
    for (const part of (match[1] ?? "").split(";")) {
      const mode = Number.parseInt(part, 10);
      if (Number.isFinite(mode)) active.set(mode, set);
    }
  }
  if (!active.size) return "";

  let out = "";
  let trackingEmitted = false;
  for (const mode of RESTORABLE_TERMINAL_MODES) {
    if (active.get(mode) !== true) continue;
    // xterm keeps ONE mouse tracking mode; emitting several would just leave
    // the last one standing, and the transcript's own order is the truth we
    // already collapsed. Take the most capable that is still set.
    const isTracking = mode === 9 || mode === 1000 || mode === 1002 || mode === 1003;
    if (isTracking) {
      if (trackingEmitted) continue;
      trackingEmitted = true;
    }
    out += `\x1b[?${mode}h`;
  }
  // Cursor visibility is the one mode whose RESET is worth restoring: a TUI
  // that hid the cursor looks broken with a block blinking over its UI.
  if (active.get(25) === false) out += "\x1b[?25l";
  return out;
}

/**
 * Renders a raw transcript to a grid and returns that grid as plain rows.
 *
 * The desktop never replays raw PTY bytes for a live session: `terminal.preview`
 * hands it a SNAPSHOT the host produced from its own headless xterm mirror, i.e.
 * an already-rendered grid. The web adapter has no snapshot to give
 * (`sessionsPty.ts` `terminal.preview` returns `snapshot: null`), so the web
 * hydrates by replaying the transcript itself — hundreds of KB of a full-screen
 * TUI's repaints, full of absolute `ESC[row;colH` moves keyed to the width the
 * HOST's PTY had. Replay that into a viewer of a different width and the moves
 * land in the wrong cells: fragments strand at rising column offsets and line
 * tails pile against the edge — the diagonal "staircase".
 *
 * Rendering at the transcript's own width first and taking the resulting grid
 * makes the output width-independent: plain rows soft-wrap correctly in any
 * viewer, exactly as the desktop's snapshot rows do. Returns null when there is
 * nothing to gain (no absolute positioning) or the grid cannot be built, so the
 * caller falls back to writing the transcript as-is.
 */
export async function normalizeTranscriptToGrid(
  raw: string,
  options: { maxRows?: number } = {},
): Promise<string | null> {
  if (!raw.length || typeof document === "undefined") return null;
  const inferredCols = inferTranscriptColumns(raw);
  // Without absolute positioning the bytes are already width-agnostic (plain
  // text plus wrapping), and a round trip would only cost time.
  if (inferredCols < MIN_VALID_COLS) return null;

  const cols = Math.min(TRANSCRIPT_NORMALIZE_MAX_COLS, Math.max(MIN_VALID_COLS, inferredCols));
  let host: HTMLElement | null = null;
  let mirror: Terminal | null = null;
  try {
    host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:absolute;left:-99999px;top:0;width:2000px;height:600px;pointer-events:none;";
    document.body.appendChild(host);
    mirror = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cols,
      rows: TRANSCRIPT_NORMALIZE_ROWS,
      scrollback: 0,
    });
    mirror.open(host);
    mirror.resize(cols, TRANSCRIPT_NORMALIZE_ROWS);
    // `write` is ASYNCHRONOUS — xterm chunks the parse across tasks and only
    // signals completion through the callback. Reading the buffer straight
    // after the call returns an empty grid (verified: 0 non-blank rows), which
    // would silently disable this whole normalization via the null fallback.
    const mirrorTerm = mirror;
    await new Promise<void>((resolve) => {
      mirrorTerm.write(raw, () => resolve());
    });
    const buffer = mirror.buffer.active;
    const rows: string[] = [];
    for (let y = buffer.baseY; y < buffer.baseY + mirror.rows; y += 1) {
      const line = buffer.getLine(y);
      rows.push(line ? line.translateToString(true) : "");
    }
    while (rows.length && !rows[rows.length - 1]?.trim()) rows.pop();
    // The mirror is a fixed 96 rows; a browser pane is routinely shorter. Every
    // row beyond the viewer's own row count lands in xterm's SCROLLBACK, and
    // scrollback is not cosmetic here: `baseY > 0` makes xterm paint its
    // scrollbar down the pane AND makes the wheel handler take the local
    // scroll branch instead of forwarding the event to the TUI. A hydration
    // grid is a picture of the CURRENT SCREEN — the desktop's snapshot carries
    // exactly the host's rows for the same reason — so keep the last `maxRows`.
    const maxRows = options.maxRows;
    const clamped = maxRows && maxRows > 0 && rows.length > maxRows
      ? rows.slice(rows.length - maxRows)
      : rows;
    return clamped.length ? clamped.join("\r\n") : null;
  } catch {
    return null;
  } finally {
    try {
      mirror?.dispose();
    } catch {
      // a disposed terminal is not an error here
    }
    host?.remove();
  }
}

