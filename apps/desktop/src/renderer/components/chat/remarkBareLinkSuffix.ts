type MdPoint = { line: number; column: number; offset?: number };

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  position?: { start: MdPoint; end: MdPoint };
};

/** The `_`/`~` run GFM cut off, when sentence punctuation, a space or the end follows it. */
const CUT_SUFFIX = /^[_~]+(?=$|[\s.,:;!?'")\]])/;
/** Web links only: a mail address does not end in `_`. */
const WEB_LINK = /^(?:https?:\/\/|www\.)/i;

/**
 * GFM leaves trailing `_` and `~` out of a bare link, as it does a full stop,
 * so `https://x.com/name_` links to `https://x.com/name`. A trailing `_` or `~`
 * is a real part of a URL far more often than the end of a sentence, so this
 * puts it back into the link: for bare links only, and only when the source
 * text right after the link is exactly that run (not an escape or an entity).
 * A `_` or `~` that closes emphasis or strikethrough is markup, not text, so
 * it never reaches here. Run it right after remark-gfm.
 */
export function remarkBareLinkSuffix() {
  return (tree: MdNode, file: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : null;
    if (source) extendBareLinks(tree, source);
  };
}

function extendBareLinks(node: MdNode, source: string): void {
  const children = node.children;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (child.type !== "link") {
      extendBareLinks(child, source);
      continue;
    }
    const next = children[index + 1];
    if (next?.type !== "text" || !next.value) continue;
    const only = child.children?.length === 1 ? child.children[0] : undefined;
    const label = only?.type === "text" ? only : null;
    const position = child.position;
    const start = position?.start.offset;
    const end = position?.end.offset;
    if (!label?.value || !child.url || !position || start == null || end == null) continue;
    if (!WEB_LINK.test(label.value)) continue;
    // A bare link's source is its label; `[text](url)` and `<url>` are longer.
    if (source.slice(start, end) !== label.value) continue;
    const suffix = CUT_SUFFIX.exec(next.value)?.[0];
    if (!suffix || source.slice(end, end + suffix.length) !== suffix) continue;
    child.url += suffix;
    label.value += suffix;
    next.value = next.value.slice(suffix.length);
    shiftPoint(position.end, suffix.length);
    if (label.position) shiftPoint(label.position.end, suffix.length);
    if (next.position) shiftPoint(next.position.start, suffix.length);
    if (!next.value) {
      children.splice(index + 1, 1);
    }
  }
}

/** Moves a point forward along one line; a link never spans a line break. */
function shiftPoint(point: MdPoint, by: number): void {
  point.column += by;
  if (point.offset != null) point.offset += by;
}

/** A bare `ade://` link in prose; sentence punctuation after it is not part of it. */
const BARE_ADE_LINK = /ade:\/\/[^\s<>"'`()[\]]+?(?=[.,:;!?]*(?:$|[\s<>"'`()[\]]))/gi;

/**
 * GFM links bare `https://` and `www.` addresses only, so an agent that writes
 * `ade://settings/mcp.servers` in prose got plain text where the same link in
 * `[…](…)` form is a chip. This links bare `ade://` addresses the same way;
 * the renderer's `a` override then draws them as chips (or as plain words when
 * the target is unknown). Text inside a link or code is left alone.
 */
export function remarkBareAdeLinks() {
  return (tree: MdNode) => {
    linkBareAdeText(tree);
  };
}

function linkBareAdeText(node: MdNode): void {
  const children = node.children;
  if (!children || node.type === "link" || node.type === "linkReference") return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (child.type !== "text") {
      linkBareAdeText(child);
      continue;
    }
    const value = child.value ?? "";
    if (!/ade:\/\//i.test(value)) continue;
    const parts: MdNode[] = [];
    let last = 0;
    for (const match of value.matchAll(BARE_ADE_LINK)) {
      const start = match.index ?? 0;
      if (start > last) parts.push({ type: "text", value: value.slice(last, start) });
      parts.push({ type: "link", url: match[0], children: [{ type: "text", value: match[0] }] });
      last = start + match[0].length;
    }
    if (!parts.length) continue;
    if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
    children.splice(index, 1, ...parts);
    index += parts.length - 1;
  }
}
