/** Unescape literal `\n`, `\r\n`, `\r`, and `\t` sequences in PR markdown text. */
export function normalizeEscapedMarkdownNewlines(text: string): string {
  if (!text.includes("\\")) return text;
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t");
}
