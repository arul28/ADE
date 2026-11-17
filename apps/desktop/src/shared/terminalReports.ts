// The replies a terminal emulator sends by itself, matched exactly so that a key
// the user pressed (arrows, function keys, Esc) is never mistaken for one:
// focus in/out, mouse reports (SGR and legacy), cursor-position and device
// attribute replies, status and mode reports, window-size replies, kitty
// keyboard flag replies, and any OSC, DCS or APC answer.
const TERMINAL_REPORT = new RegExp(
  [
    String.raw`\x1b\[[IO]`,
    String.raw`\x1b\[<\d+;\d+;\d+[Mm]`,
    String.raw`\x1b\[M[\s\S]{3}`,
    String.raw`\x1b\[\??\d+;\d+(?:;\d+)?R`,
    String.raw`\x1b\[[?>=][\d;]*c`,
    String.raw`\x1b\[\??\d*n`,
    String.raw`\x1b\[\??[\d;]*\$y`,
    String.raw`\x1b\[\d+(?:;\d+)*t`,
    String.raw`\x1b\[\?\d*u`,
    String.raw`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`,
    String.raw`\x1b[P_][\s\S]*?\x1b\\`,
  ].join("|"),
  "g",
);

/**
 * True when a write is made only of replies the terminal emulator sent on its
 * own (a CLI's startup queries, focus changes, mouse moves), so nobody typed.
 * Narrower than `!writeCarriesTypedInput`: a lone arrow or function key is a
 * person at the keyboard and is not a report.
 */
export function writeIsTerminalReport(data: string): boolean {
  return data.length > 0 && data.replace(TERMINAL_REPORT, "").length === 0;
}
