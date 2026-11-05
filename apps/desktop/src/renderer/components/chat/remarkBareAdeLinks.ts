type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

/** A bare `ade://` address in prose, not part of a longer scheme (`cascade://`). */
const BARE_ADE_LINK = /(?<![A-Za-z0-9+.-])ade:\/\/[^\s<>"'`]+/gi;

/**
 * The address without what the sentence put after it: trailing punctuation,
 * and a `)` or `]` it never opened. A file link keeps its own brackets
 * (`ade://file/src/app/(auth)/page.tsx`).
 */
function trimLinkEnd(candidate: string): string {
  let end = candidate.length;
  const unopened = (close: string, open: string) => {
    const head = candidate.slice(0, end);
    return head.split(close).length > head.split(open).length;
  };
  for (;;) {
    const last = candidate[end - 1];
    if (last && ".,:;!?'\"".includes(last)) end -= 1;
    else if (last === ")" && unopened(")", "(")) end -= 1;
    else if (last === "]" && unopened("]", "[")) end -= 1;
    else break;
  }
  return candidate.slice(0, end);
}

/**
 * GFM links bare `https://` and `www.` addresses only, so an agent that writes
 * `ade://settings/mcp.servers` in prose got plain text where the same link in
 * `[…](…)` form is a chip. This links bare `ade://` addresses the same way;
 * the renderer's `a` override then draws them as chips (or as plain words when
 * the target is unknown). Text inside a link or code is left alone. Run it
 * after remark-gfm.
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
      const url = trimLinkEnd(match[0]);
      if (url.length <= "ade://".length) continue;
      if (start > last) parts.push({ type: "text", value: value.slice(last, start) });
      parts.push({ type: "link", url, children: [{ type: "text", value: url }] });
      last = start + url.length;
    }
    if (!parts.length) continue;
    if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
    children.splice(index, 1, ...parts);
    index += parts.length - 1;
  }
}
