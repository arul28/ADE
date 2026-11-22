import type { Terminal } from "@xterm/xterm";

/**
 * Type-ahead for a terminal on a slow link: what you type shows at once,
 * dimmed and underlined, until the machine's echo arrives.
 *
 * It only draws a layer over the terminal. Nothing goes into the terminal's
 * own screen, so a wrong guess can never change what the terminal holds: the
 * layer goes away and the real echo stays. Rules, after mosh:
 * - Only plain characters are guessed. Enter, Tab, arrows, control keys and
 *   escapes clear every guess.
 * - After Enter, or after any clear, nothing shows until one guess on the new
 *   line comes back as an echo. A prompt that hides input (a password) never
 *   echoes, so it never shows a guess.
 * - A guess with no echo in time clears the line again.
 * - No guesses in the alternate screen, with the cursor hidden, with mouse
 *   reporting on, or while the view is scrolled up. Full-screen programs
 *   (Claude Code, Codex, vim) draw their own input and get none.
 * - Wide characters (CJK, emoji) are not guessed: their width is not known.
 */

const MAX_PENDING = 64;
const MIN_ECHO_WAIT_MS = 1_000;
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[()*+][0-~]|.)/g;
const CURSOR_VISIBILITY = /\x1b\[\?25([hl])/g;

type Pending = { ch: string; at: number };

export type TerminalTypeAhead = {
  /** Whether the link wants guesses, and its round trip for the echo wait. */
  setWanted: (wanted: boolean, rttMs: number | null) => void;
  /** Keys sent to the terminal's program. */
  noteInput: (data: string) => void;
  /** Output from the program, before the terminal writes it. */
  noteOutput: (data: string) => void;
  /** The terminal's screen was replaced (hydration): clears every guess. */
  reset: () => void;
  dispose: () => void;
};

/** Plain text of terminal output: escape sequences and control characters removed. */
function terminalPrintableText(data: string): string {
  return data.replace(ESCAPE_SEQUENCE, "").replace(/[\x00-\x1f\x7f]/g, "");
}

function isNarrowPrintable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return false;
  if (code >= 0x80 && code < 0xa0) return false;
  // East Asian wide, emoji and other ranges whose cell width xterm decides.
  return code < 0x1100;
}

/**
 * Whether the terminal hides its cursor now. xterm keeps this state, also for
 * a screen restored from a snapshot, but has no public read of it; the output
 * scan is the fallback.
 */
function terminalCursorHidden(term: Terminal, scanned: boolean): boolean {
  const core = (term as unknown as { _core?: { coreService?: { isCursorHidden?: unknown } } })._core;
  const hidden = core?.coreService?.isCursorHidden;
  return typeof hidden === "boolean" ? hidden : scanned;
}

export function createTerminalTypeAhead(deps: {
  term: Terminal;
  now?: () => number;
}): TerminalTypeAhead {
  const { term } = deps;
  const now = deps.now ?? Date.now;
  let wanted = false;
  let echoWaitMs = MIN_ECHO_WAIT_MS;
  let pending: Pending[] = [];
  let lineConfirmed = false;
  let cursorHidden = false;
  let layer: HTMLSpanElement | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const eligible = (): boolean => {
    if (!wanted || disposed || terminalCursorHidden(term, cursorHidden)) return false;
    // Mouse reporting on: the program reads the mouse and draws its own screen.
    if (term.modes.mouseTrackingMode !== "none") return false;
    const buffer = term.buffer.active;
    if (buffer.type !== "normal") return false;
    // Scrolled up: the cursor row is not on screen.
    return buffer.viewportY === buffer.baseY;
  };

  const hide = () => {
    if (layer) layer.style.display = "none";
  };

  const clear = () => {
    pending = [];
    lineConfirmed = false;
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    hide();
  };

  const armExpiry = () => {
    if (expiryTimer || pending.length === 0) return;
    const wait = Math.max(0, pending[0]!.at + echoWaitMs - now());
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      if (pending.length === 0) return;
      if (now() - pending[0]!.at >= echoWaitMs) {
        // No echo in time: the input may be hidden, or the program does not
        // echo where the cursor is. Show nothing more on this line.
        clear();
        return;
      }
      armExpiry();
    }, wait);
  };

  const render = () => {
    if (disposed) return;
    if (!lineConfirmed || pending.length === 0 || !eligible()) {
      hide();
      return;
    }
    const host = term.element;
    const screen = host?.querySelector<HTMLElement>(".xterm-screen");
    if (!host || !screen || term.cols <= 0 || term.rows <= 0) {
      hide();
      return;
    }
    const cellWidth = screen.clientWidth / term.cols;
    const cellHeight = screen.clientHeight / term.rows;
    if (!(cellWidth > 0) || !(cellHeight > 0)) {
      hide();
      return;
    }
    const buffer = term.buffer.active;
    const row = buffer.cursorY;
    const column = buffer.cursorX;
    if (row < 0 || row >= term.rows || column >= term.cols) {
      hide();
      return;
    }
    if (!layer) {
      layer = document.createElement("span");
      layer.setAttribute("aria-hidden", "true");
      layer.dataset.terminalTypeAhead = "";
      Object.assign(layer.style, {
        position: "absolute",
        zIndex: "6",
        pointerEvents: "none",
        whiteSpace: "pre",
        overflow: "hidden",
        opacity: "0.6",
        textDecoration: "underline dotted",
        textUnderlineOffset: "2px",
      } satisfies Partial<CSSStyleDeclaration>);
    }
    if (layer.parentElement !== host) host.appendChild(layer);
    const theme = term.options.theme ?? {};
    const text = pending.map((entry) => entry.ch).join("").slice(0, term.cols - column);
    layer.textContent = text;
    Object.assign(layer.style, {
      display: "block",
      left: `${screen.offsetLeft + column * cellWidth}px`,
      top: `${screen.offsetTop + row * cellHeight}px`,
      height: `${cellHeight}px`,
      lineHeight: `${cellHeight}px`,
      width: `${text.length * cellWidth}px`,
      fontFamily: term.options.fontFamily ?? "monospace",
      fontSize: `${term.options.fontSize ?? 13}px`,
      letterSpacing: `${Math.max(0, cellWidth - measureCharWidth())}px`,
      color: theme.foreground ?? "inherit",
      background: theme.background ?? "transparent",
    });
  };

  let measuredFont = "";
  let measuredWidth = 0;
  const measureCharWidth = (): number => {
    const font = `${term.options.fontSize ?? 13}px ${term.options.fontFamily ?? "monospace"}`;
    if (font === measuredFont) return measuredWidth;
    measuredFont = font;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) {
      measuredWidth = 0;
      return 0;
    }
    context.font = font;
    measuredWidth = context.measureText("W").width;
    return measuredWidth;
  };

  // Drawn after the terminal took in output, so the cursor is where the
  // echo left it.
  const parsedSub = term.onWriteParsed(render);
  const resizeSub = term.onResize(render);
  const scrollSub = term.onScroll(render);

  return {
    setWanted(next, rttMs) {
      echoWaitMs = Math.max(MIN_ECHO_WAIT_MS, 3 * (rttMs ?? 0));
      if (next === wanted) return;
      wanted = next;
      clear();
    },
    noteInput(data) {
      if (disposed) return;
      if (!eligible()) {
        if (pending.length || lineConfirmed) clear();
        return;
      }
      if (data === "\x7f" || data === "\b") {
        // Only a guess is taken back; real characters wait for the machine.
        if (pending.length) {
          pending.pop();
          render();
        }
        return;
      }
      const chars = Array.from(data);
      if (!chars.every(isNarrowPrintable)) {
        clear();
        return;
      }
      for (const ch of chars) {
        if (pending.length >= MAX_PENDING) break;
        pending.push({ ch, at: now() });
      }
      armExpiry();
      render();
    },
    noteOutput(data) {
      if (disposed) return;
      // Off, this runs on every output chunk of every terminal: the cursor
      // scan is only worth it while a guess may be waiting.
      if (!wanted) return;
      for (const match of data.matchAll(CURSOR_VISIBILITY)) cursorHidden = match[1] === "l";
      // Output that starts a new line ends the line a guess was confirmed on.
      // A program asking for a password writes its prompt there and never
      // echoes, so nothing on the next line may be guessed.
      if (/[\r\n]/.test(data)) {
        clear();
        return;
      }
      if (pending.length === 0) return;
      const text = terminalPrintableText(data);
      // Only a chunk shaped like the echo itself confirms the line: what was
      // typed, in order, and nothing else. A prompt that happens to start with
      // the same letters ("P", then "Password: ") is other output, and a
      // password never shows.
      const shown = text.length > 0 && text.length <= pending.length
        && pending.slice(0, text.length).every((entry, index) => entry.ch === text[index]);
      if (!shown) return;
      pending = pending.slice(text.length);
      // A line shows guesses only once an echo came back where the program
      // writes first: plain shell echo, not other output.
      lineConfirmed = true;
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
      }
      armExpiry();
      if (pending.length === 0 || !eligible()) hide();
    },
    reset() {
      clear();
    },
    dispose() {
      disposed = true;
      clear();
      parsedSub.dispose();
      resizeSub.dispose();
      scrollSub.dispose();
      layer?.remove();
      layer = null;
    },
  };
}
