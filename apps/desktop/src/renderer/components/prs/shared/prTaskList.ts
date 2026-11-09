/** Markdown task-list boxes, found in the source text a PR body is written in. */

/** One `- [ ]` / `* [x]` box: `offset` is the character inside the brackets. */
export type PrTaskBox = { offset: number; checked: boolean };

const TASK_LINE = /^(?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/;
const FENCE = /^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(`{3,}|~{3,})/;

/** Every box in `markdown`, in order. Boxes in code fences and HTML comments do not count. */
export function findPrTaskBoxes(markdown: string): PrTaskBox[] {
  const boxes: PrTaskBox[] = [];
  let offset = 0;
  let fence: string | null = null;
  let inComment = false;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (inComment) {
      if (line.includes("-->")) inComment = false;
    } else {
      const fenceMatch = FENCE.exec(line);
      if (fence) {
        // A fence closes only with the same character, at least as long.
        if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length
          && line.trim() === fenceMatch[1]) {
          fence = null;
        }
      } else if (fenceMatch) {
        fence = fenceMatch[1]!;
      } else {
        const commentStart = line.indexOf("<!--");
        if (commentStart >= 0 && !line.includes("-->", commentStart + 4)) {
          inComment = true;
        } else {
          const task = TASK_LINE.exec(line);
          if (task) {
            const bracketChar = task[0].length - 2;
            boxes.push({ offset: offset + bracketChar, checked: task[1] !== " " });
          }
        }
      }
    }
    offset += rawLine.length + 1;
  }
  return boxes;
}

function isCheckedChar(char: string): boolean {
  return char !== " ";
}

/**
 * The body with one box set: `slice` is the text a checkbox was rendered from
 * (a description may be drawn in parts), `index` the box's place within it.
 *
 * Bodies from GitHub may use CRLF, and the renderer's slice may not, so the
 * match is made on LF text and carried back to the original offset. Returns
 * null when the box is not there as drawn: the body changed, or the slice is
 * not part of it, and toggling a guessed box would be worse than doing nothing.
 */
export function togglePrTaskInBody(
  body: string,
  slice: string,
  index: number,
  nextChecked: boolean,
): string | null {
  const sliceLf = slice.replace(/\r\n/g, "\n");
  const bodyLf = body.replace(/\r\n/g, "\n");
  const sliceStart = bodyLf.indexOf(sliceLf);
  if (sliceStart < 0) return null;
  const box = findPrTaskBoxes(sliceLf)[index];
  if (!box || box.checked === nextChecked) return null;
  // The same box as the body's parser sees it, in case the part starts mid-list.
  const absolute = sliceStart + box.offset;
  const inBody = findPrTaskBoxes(bodyLf).find((candidate) => candidate.offset === absolute);
  if (!inBody || inBody.checked === nextChecked || isCheckedChar(bodyLf[absolute]!) === nextChecked) return null;
  // Count back to the original text: every LF before the box may be a CRLF there.
  let rawOffset = -1;
  for (let i = 0, lf = 0; i < body.length; i += 1) {
    if (body[i] === "\r" && body[i + 1] === "\n") continue;
    if (lf === absolute) {
      rawOffset = i;
      break;
    }
    lf += 1;
  }
  if (rawOffset < 0) return null;
  return `${body.slice(0, rawOffset)}${nextChecked ? "x" : " "}${body.slice(rawOffset + 1)}`;
}
