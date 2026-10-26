/**
 * OSC 52: a program in the terminal asks to set the clipboard
 * (`ESC ] 52 ; <selections> ; <base64> BEL` or `... ESC \`). Vim and
 * Neovim, tmux with `set-clipboard`, Claude Code's `/copy`, and `printf` over
 * SSH all copy this way.
 *
 * xterm's parser does the framing (chunks split anywhere, BEL and ST
 * terminators, CAN/SUB aborts) and hands the text between `52;` and the
 * terminator here. This decides what that text means. It is write-only:
 * a read request (`?`) is never answered, because the reply would hand this
 * computer's clipboard to whatever process asked, on whichever machine the
 * terminal runs.
 */

/** Base64 characters accepted in one copy; about 768 KiB of text. */
export const OSC52_MAX_BASE64_CHARS = 1024 * 1024;

export type Osc52Request =
  | { kind: "write"; text: string }
  | { kind: "ignore"; reason: "query" | "empty" | "too-large" | "invalid" };

/** Selection targets a program may name: clipboard, primary, secondary, select, cut buffers 0-7. */
const SELECTION_PARAM = /^[cpqs0-7]*$/;
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Parse the OSC 52 payload (everything after `52;`). Every named selection
 * maps to the one system clipboard, as other terminals do. An empty payload
 * would clear the clipboard; ADE leaves it alone instead.
 */
export function parseOsc52Payload(data: string): Osc52Request {
  const separator = data.indexOf(";");
  if (separator < 0) return { kind: "ignore", reason: "invalid" };
  const selections = data.slice(0, separator);
  if (!SELECTION_PARAM.test(selections)) return { kind: "ignore", reason: "invalid" };
  const body = data.slice(separator + 1);
  if (body === "?") return { kind: "ignore", reason: "query" };
  if (body.length > OSC52_MAX_BASE64_CHARS) return { kind: "ignore", reason: "too-large" };
  // Some programs wrap long payloads; whitespace is never base64.
  const compact = body.replace(/[\r\n\t ]+/g, "");
  if (!compact) return { kind: "ignore", reason: "empty" };
  if (!BASE64_BODY.test(compact) || compact.length % 4 === 1) return { kind: "ignore", reason: "invalid" };
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    return { kind: "ignore", reason: "invalid" };
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  let text: string;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return { kind: "ignore", reason: "invalid" };
  }
  if (!text) return { kind: "ignore", reason: "empty" };
  return { kind: "write", text };
}

/** An OSC 52 introducer, 7-bit (`ESC ] 52 ;`) or 8-bit (`0x9d 52 ;`). */
const OSC52_START = /(?:\x1b\]|\x9d)52;/g;
/** What ends or aborts an OSC: BEL, ST (7- or 8-bit), CAN, SUB, or a new escape. */
const OSC_END = /[\x07\x9c\x18\x1a]|\x1b/;

/**
 * True when `data` stops inside an OSC 52 that is not yet terminated. xterm
 * keeps an open OSC across writes, so the next write's terminator would
 * complete a copy whose payload came from here.
 */
export function endsInsideOsc52(data: string): boolean {
  let last = -1;
  for (const match of data.matchAll(OSC52_START)) last = match.index + match[0].length;
  return last >= 0 && !OSC_END.test(data.slice(last));
}
