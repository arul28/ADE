/**
 * The longest a child's final message may run in its parent's report. The
 * parent reads the report, not the child's transcript, so lists, code and
 * line breaks are kept; only the start of a very long reply is dropped. It
 * stays under the 4,000-character `summary` cap a wake keeps when it crosses a
 * scope or a machine (`readExternalParentWake`), with room for the notes.
 */
export const CHILD_REPORT_MAX_CHARS = 3_500;

const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
/** The longest info string kept on a reopened fence ("ts", "python title=x"). */
const MAX_FENCE_INFO = 40;

/**
 * The fence still open after `lines`, as a line that reopens it, or null. A
 * fence closes only on the same character at least as long with nothing
 * after it, so a shorter fence inside a longer one is content.
 */
function openFenceAtCut(lines: readonly string[]): string | null {
  let active: { marker: string; info: string } | null = null;
  for (const line of lines) {
    const match = FENCE_LINE.exec(line);
    if (!match) continue;
    const marker = match[1]!;
    const rest = match[2]!.trim();
    if (!active) {
      active = { marker, info: rest };
    } else if (marker[0] === active.marker[0] && marker.length >= active.marker.length && !rest) {
      active = null;
    }
  }
  return active ? `${active.marker}${active.info.slice(0, MAX_FENCE_INFO)}` : null;
}

/**
 * What a woken parent reads for one child turn: who finished, why it hears
 * from this chat when the child was relinked, then the report. The one place
 * this text is built, so a relink never edits a finished string.
 */
export function composeChildWakeText(args: {
  childTitle: string;
  childSessionId: string;
  relinkNote?: string | null;
  summary: string;
}): string {
  return [
    `Your subagent "${args.childTitle}" (${args.childSessionId}) finished a turn.`,
    ...(args.relinkNote ? [args.relinkNote] : []),
    "",
    args.summary,
  ].join("\n");
}

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
  // Only line endings and the blank edges change: inner blank lines can be
  // content (a string literal in code), and the first line's indentation can
  // make it an indented code block.
  const normalized = text.replace(/\r\n/g, "\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  if (normalized.length <= maxChars) return normalized;
  const lines = normalized.split("\n");
  // The last lines that fit `budget`; at least one.
  const tail = (budget: number): string[] => {
    const kept: string[] = [];
    let length = 0;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (kept.length > 0 && length + line.length + 1 > budget) break;
      kept.unshift(line);
      length += line.length + 1;
    }
    return kept;
  };
  // The reopened fence counts against the budget, and a smaller budget moves
  // the cut, which can change which fence is open at it: settle both together.
  // The fence is always the one open at the final cut, even if it then runs a
  // few characters over the budget.
  let opener: string | null = null;
  let kept = tail(maxChars);
  for (let round = 0; round < 4; round += 1) {
    const next = openFenceAtCut(lines.slice(0, lines.length - kept.length));
    if (next === opener) break;
    opener = next;
    kept = tail(maxChars - (opener ? opener.length + 1 : 0));
  }
  opener = openFenceAtCut(lines.slice(0, lines.length - kept.length));
  // One line longer than the budget: keep its end.
  if (kept.length === 1 && kept[0]!.length > maxChars) kept[0] = `…${kept[0]!.slice(-(maxChars - 1))}`;
  if (opener) kept.unshift(opener);
  return [
    `[The start of this reply was cut. Read all of it with: ade chat read ${options.childSessionId}]`,
    ...kept,
  ].join("\n");
}
