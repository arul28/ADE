import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** Markdown task-list boxes, found in the source text a PR body is written in. */

/** One `- [ ]` / `* [x]` box: `offset` is the character inside the brackets. */
export type PrTaskBox = { offset: number; checked: boolean };

type MarkdownNode = {
  type: string;
  checked?: boolean | null;
  position?: { start: { offset?: number } };
  children?: MarkdownNode[];
};

const LIST_ITEM_START = /^(?:[-+*]|\d{1,9}[.)])[ \t]+\[[ xX]\]/;
const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * Every box in `markdown`, in the order the renderer numbers them. Parsed with
 * the renderer's own grammar: a look-alike in a fence, an indented code block
 * or an HTML block must not shift the count, or a click ticks the wrong box.
 */
export function findPrTaskBoxes(markdown: string): PrTaskBox[] {
  if (!/\[[ xX]\]/.test(markdown)) return [];
  const boxes: PrTaskBox[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "listItem" && typeof node.checked === "boolean") {
      const start = node.position?.start.offset ?? -1;
      const marker = start >= 0 ? LIST_ITEM_START.exec(markdown.slice(start, start + 24)) : null;
      // Still counted when unreadable, so the boxes after it keep their numbers.
      boxes.push({ offset: marker ? start + marker[0].length - 2 : -1, checked: node.checked });
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(markdown) as MarkdownNode);
  return boxes;
}

/**
 * The body with one box set: `slice` is the text a checkbox was rendered from
 * (a description may be drawn in parts), `index` the box's place within it.
 *
 * Bodies from GitHub may use CRLF, and the renderer's slice may not, so the
 * match is made on LF text and carried back to the original offset. Returns
 * null when the box cannot be named exactly: the body changed, the slice is
 * not part of it, or the same text appears twice with the box in the same
 * state. Toggling a guessed box would be worse than doing nothing.
 */
export function togglePrTaskInBody(
  body: string,
  slice: string,
  index: number,
  nextChecked: boolean,
): string | null {
  const sliceLf = slice.replace(/\r\n/g, "\n");
  const box = findPrTaskBoxes(sliceLf)[index];
  if (!box || box.offset < 0 || box.checked === nextChecked) return null;
  const bodyLf = body.replace(/\r\n/g, "\n");
  const bodyBoxes = new Map(findPrTaskBoxes(bodyLf).map((candidate) => [candidate.offset, candidate]));
  const targets: number[] = [];
  for (let at = bodyLf.indexOf(sliceLf); at >= 0; at = bodyLf.indexOf(sliceLf, at + 1)) {
    const candidate = bodyBoxes.get(at + box.offset);
    if (candidate && candidate.checked !== nextChecked) targets.push(candidate.offset);
  }
  if (targets.length !== 1) return null;
  const absolute = targets[0]!;
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
