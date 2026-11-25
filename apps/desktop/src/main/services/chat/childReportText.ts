/**
 * The longest a child's final message may run in its parent's report. The
 * parent reads the report, not the child's transcript, so lists, code and
 * line breaks are kept; only the start of a very long reply is dropped. It
 * stays under the 4,000-character `summary` cap a wake keeps when it crosses a
 * scope or a machine (`readExternalParentWake`), with room for the notes.
 */
export const CHILD_REPORT_MAX_CHARS = 3_500;

const FENCE_LINE = /^\s*(```|~~~)/;

/**
 * The end of a child's final message, newlines kept. A reply longer than
 * `maxChars` keeps its last lines (the closing summary lives there) behind a
 * line saying the start was cut and how to read it all. A cut that lands
 * inside a code block reopens the block, so the kept part still renders as
 * code.
 */
export function boundChildReport(
  text: string,
  options: { childSessionId: string; maxChars?: number },
): string {
  const maxChars = options.maxChars ?? CHILD_REPORT_MAX_CHARS;
  const trimmed = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (trimmed.length <= maxChars) return trimmed;
  const lines = trimmed.split("\n");
  const kept: string[] = [];
  let length = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (kept.length > 0 && length + line.length + 1 > maxChars) break;
    kept.unshift(line);
    length += line.length + 1;
  }
  // One line longer than the budget: keep its end.
  if (kept.length === 1 && kept[0]!.length > maxChars) kept[0] = `…${kept[0]!.slice(-(maxChars - 1))}`;
  const droppedLines = lines.slice(0, lines.length - kept.length);
  const openFence = droppedLines.filter((line) => FENCE_LINE.test(line)).length % 2 === 1;
  if (openFence) {
    const opener = [...droppedLines].reverse().find((line) => FENCE_LINE.test(line))?.trim() ?? "```";
    kept.unshift(opener);
  }
  return [
    `[The start of this reply was cut. Read all of it with: ade chat read ${options.childSessionId}]`,
    ...kept,
  ].join("\n");
}
