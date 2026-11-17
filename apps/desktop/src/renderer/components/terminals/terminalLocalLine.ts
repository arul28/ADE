import { writeIsTerminalReport } from "../../../shared/terminalReports";
import { TERMINAL_BRACKETED_PASTE_END, TERMINAL_BRACKETED_PASTE_START } from "./terminalBracketedPaste";

/**
 * The local line of an agent CLI terminal on a slow link.
 *
 * An agent CLI (Claude Code, Codex, ...) draws its own input box and hides the
 * cursor, so type-ahead cannot guess its echo, and on a 700 ms link each key
 * shows most of a second late. With the local line on, plain text stays in
 * ADE and shows at once; Enter sends the whole line to the terminal's machine,
 * which types it into the CLI and presses Enter (`chat.typeIntoCli` with
 * `when: "now"`).
 *
 * The terminal's own replies (focus changes, mouse reports, answers to a
 * CLI's queries) go to the CLI and leave the line as it is.
 *
 * Every other key works as it does today, in the same order:
 * - Enter with an empty line, and every key with an empty line, go to the CLI.
 * - Backspace, Ctrl+U, Ctrl+W and Option+Backspace edit a line that has text.
 * - Shift+Enter adds a line break to a line that has text.
 * - Any other key (Esc, Tab, arrows, Ctrl keys) first hands the line to the
 *   CLI as if it had been typed there, then sends the key. So Tab completes
 *   the typed command, Esc and Ctrl+C reach a running turn, and arrows move
 *   in the CLI's own input: the result is what typing in the CLI gives.
 */
export type TerminalLocalLineAction =
  | { kind: "write"; data: string }
  | { kind: "submit"; text: string };

export type TerminalLocalLine = {
  readonly text: () => string;
  /** Keys from the terminal (xterm `onData`). Empty when the line took them. */
  input: (data: string, options?: { handOver?: boolean }) => TerminalLocalLineAction[];
  /** Shift+Enter. False when the line is empty: the key goes to the CLI. */
  newline: () => boolean;
  /** Pasted text joins the line. */
  paste: (text: string) => void;
  /** Text joins the line after what is already in it (a queued line its send skipped). */
  append: (text: string) => void;
  /** The line as keys for the CLI (the line turned off): typed, or a paste with line breaks. */
  takeForHandOver: () => string;
  /** A submit that failed: its text goes back in front of what came since. */
  restore: (text: string) => void;
};

const SINGLE_KEY_LOCAL_EDITS = new Set(["\x7f", "\b", "\x15", "\x17", "\x1b\x7f"]);

/** Text a person typed: no control characters, no escape sequences. */
function isPlainText(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}

function dropLastCharacter(text: string): string {
  const chars = Array.from(text);
  chars.pop();
  return chars.join("");
}

function dropLastWord(text: string): string {
  return text.replace(/\S+\s*$/u, "");
}

/** The line as the keys typing it in the CLI would have sent. */
export function localLineAsKeys(text: string): string {
  // A line break must stay one message, and a tab must stay text rather than
  // the CLI's completion key: both go as a bracketed paste.
  if (!text.includes("\n") && !text.includes("\t")) return text;
  const pasted = text.replace(/\r?\n/g, "\r").replace(/\x1b/g, "␛");
  return `${TERMINAL_BRACKETED_PASTE_START}${pasted}${TERMINAL_BRACKETED_PASTE_END}`;
}

export function createTerminalLocalLine(onChange: () => void): TerminalLocalLine {
  let text = "";
  const set = (next: string) => {
    if (next === text) return;
    text = next;
    onChange();
  };
  const take = () => {
    const taken = text;
    set("");
    return taken;
  };
  return {
    text: () => text,
    input(data, options) {
      if (writeIsTerminalReport(data)) return [{ kind: "write", data }];
      if (isPlainText(data)) {
        set(text + data);
        return [];
      }
      if (!text) return [{ kind: "write", data }];
      if (data === "\r") return [{ kind: "submit", text: take() }];
      if (SINGLE_KEY_LOCAL_EDITS.has(data)) {
        if (data === "\x15") set("");
        else if (data === "\x17" || data === "\x1b\x7f") set(dropLastWord(text));
        else set(dropLastCharacter(text));
        return [];
      }
      // A line whose send is in doubt is not handed over (`handOver: false`):
      // the key still reaches the CLI, the line waits for Enter.
      if (options?.handOver === false) return [{ kind: "write", data }];
      return [{ kind: "write", data: `${localLineAsKeys(take())}${data}` }];
    },
    newline() {
      if (!text) return false;
      set(`${text}\n`);
      return true;
    },
    paste(pasted) {
      if (!pasted) return;
      // A pasted control character is text here, not a key: a tab or a line
      // break is kept, ESC is shown, and the rest is dropped, so a paste can
      // never interrupt the CLI or move its cursor (`input()` refuses them too).
      const lines = pasted
        .replace(/\r\n?/g, "\n")
        .replace(/\x1b/g, "\u241b")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      if (lines) set(text + lines);
    },
    append(added) {
      if (added) set(text + added);
    },
    takeForHandOver: () => localLineAsKeys(take()),
    restore(failed) {
      if (failed) set(text ? `${failed}${text}` : failed);
    },
  };
}
