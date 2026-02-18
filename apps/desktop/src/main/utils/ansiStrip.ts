// Minimal ANSI/control sequence stripping for terminal transcript display + pack generation.
// Avoids new deps; covers CSI/OSC + common single-byte escapes.

const OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g; // ESC ] ... BEL or ST (ESC \)
const CSI_REGEX = /\u001b\[[0-?]*[ -/]*[@-~]/g; // ESC [ ... cmd
const CHARSET_REGEX = /\u001b[\(\)][0-9A-Za-z]/g; // ESC ( B / ESC ) 0 etc
const TWO_CHAR_ESC_REGEX = /\u001b[@-Z\\-_]/g; // ESC followed by a single byte

function applyBackspaces(text: string): string {
  if (!text.includes("\b")) return text;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (ch === "\b") {
      if (out.length) out.pop();
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

export function stripAnsi(text: string): string {
  const input = typeof text === "string" ? text : String(text ?? "");
  if (!input) return "";

  // Order matters: strip complex sequences before stripping generic ESC prefixes.
  const stripped = input
    .replace(OSC_REGEX, "")
    .replace(CSI_REGEX, "")
    .replace(CHARSET_REGEX, "")
    .replace(TWO_CHAR_ESC_REGEX, "")
    .replace(/\r/g, ""); // carriage returns are typically progress updates

  return applyBackspaces(stripped);
}

