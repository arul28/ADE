/**
 * Which lines of a markdown text sit inside a fenced code block.
 *
 * A fence opens on a line of three or more backticks or tildes and closes on a
 * line of the same character, at least as long, with nothing after it. So a
 * four-backtick fence can hold a three-backtick one, which is how a document
 * shows a fence as an example.
 */
export type MarkdownFenceLine = {
  line: string;
  /** `open` and `close` are the fence's own lines; `inside` is its content. */
  fence: "open" | "inside" | "close" | null;
  /** The info string's first word, lower case, on every line of a fence. */
  language: string;
};

export function markdownFenceLines(markdown: string): MarkdownFenceLine[] {
  const out: MarkdownFenceLine[] = [];
  let open: { char: string; length: number; language: string } | null = null;
  for (const line of markdown.split("\n")) {
    const mark = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (!open) {
      if (mark) {
        open = { char: mark[1]![0]!, length: mark[1]!.length, language: (mark[2] ?? "").toLowerCase() };
        out.push({ line, fence: "open", language: open.language });
      } else {
        out.push({ line, fence: null, language: "" });
      }
      continue;
    }
    const closes = mark !== null && mark[1]![0] === open.char && mark[1]!.length >= open.length && !mark[2];
    out.push({ line, fence: closes ? "close" : "inside", language: open.language });
    if (closes) open = null;
  }
  return out;
}
