// Minimal ANSI/control sequence stripping for terminal transcript display + pack generation.
// Avoids new deps; covers CSI/OSC + common single-byte escapes.

// ESC ] ... BEL or ST (ESC \). The body stops at the first ESC: a greedy body ran
// to the last ST in the text and ate the link text between OSC 8 hyperlinks.
// Like xterm, an ESC that does not start ST ends the string and begins the
// next sequence.
const OSC_REGEX = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|(?=\u001b))/g;
// DCS, SOS, PM and APC end the same way OSC does.
const APC_REGEX = /\u001b_[^\u0007\u001b]*(?:\u0007|\u001b\\|(?=\u001b))/g; // ESC _ ... (Kitty graphics protocol)
const DCS_REGEX = /\u001bP[^\u0007\u001b]*(?:\u0007|\u001b\\|(?=\u001b))/g; // ESC P ...
const SOS_REGEX = /\u001bX[^\u0007\u001b]*(?:\u0007|\u001b\\|(?=\u001b))/g; // ESC X ...
const PM_REGEX = /\u001b\^[^\u0007\u001b]*(?:\u0007|\u001b\\|(?=\u001b))/g; // ESC ^ ...
const CSI_REGEX = /\u001b\[[0-?]*[ -/]*[@-~]/g; // ESC [ ... cmd
// ECMA-35: intermediate bytes (0x20-0x2F) and one final byte, as in ESC ( B,
// ESC # 8 or ESC % G. A control or ESC after the intermediates is not a final
// byte, so the sequence ends before it and that byte is still processed.
const INTERMEDIATE_ESC_REGEX = /\u001b[ -/]+[0-~]?/g;
// A second ESC restarts the sequence, so the first one is dropped.
const RESTARTED_ESC_REGEX = /\u001b+(?=\u001b)/g;
const TWO_CHAR_ESC_REGEX = /\u001b(?:[@-Z\\-_]|[0-9=>])/g; // ESC followed by a single byte

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
  return stripAnsiWithOptions(text);
}

export function stripAnsiWithOptions(
  text: string,
  options?: {
    preserveCarriageReturns?: boolean;
  }
): string {
  const input = typeof text === "string" ? text : String(text ?? "");
  if (!input) return "";

  // Order matters: strip complex sequences before stripping generic ESC prefixes.
  const strippedEscapes = input
    .replace(OSC_REGEX, "")
    .replace(APC_REGEX, "")
    .replace(DCS_REGEX, "")
    .replace(SOS_REGEX, "")
    .replace(PM_REGEX, "")
    .replace(RESTARTED_ESC_REGEX, "")
    .replace(INTERMEDIATE_ESC_REGEX, "")
    .replace(CSI_REGEX, "")
    .replace(TWO_CHAR_ESC_REGEX, "");

  const stripped = options?.preserveCarriageReturns ? strippedEscapes : strippedEscapes.replace(/\r/g, "");

  return applyBackspaces(stripped);
}
