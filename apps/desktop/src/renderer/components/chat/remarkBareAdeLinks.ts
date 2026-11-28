import { ADE_DEEPLINK_URL_PREFIX_SOURCE } from "../../../shared/deeplinks";

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

/** A bare `ade://` or `daex://` address in prose, not part of a longer scheme (`cascade://`). */
const BARE_ADE_LINK = new RegExp(`(?<![A-Za-z0-9+.-])${ADE_DEEPLINK_URL_PREFIX_SOURCE}[^\\s<>"'\`]+`, "gi");
const HAS_ADE_LINK = new RegExp(ADE_DEEPLINK_URL_PREFIX_SOURCE, "i");

/**
 * The address without what the sentence put after it: trailing punctuation,
 * and a `)` or `]` it never opened. A file link keeps its own brackets
 * (`ade://file/src/app/(auth)/page.tsx`).
 */
function trimLinkEnd(candidate: string): string {
  // Counted once, then kept current as the end moves: linear in the address.
  const count = (char: string) => candidate.split(char).length - 1;
  let parens = count(")") - count("(");
  let brackets = count("]") - count("[");
  let end = candidate.length;
  for (;;) {
    const last = candidate[end - 1];
    if (last && ".,:;!?'\"".includes(last)) end -= 1;
    else if (last === ")" && parens > 0) { end -= 1; parens -= 1; }
    else if (last === "]" && brackets > 0) { end -= 1; brackets -= 1; }
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
    if (!HAS_ADE_LINK.test(value)) continue;
    const parts: MdNode[] = [];
    let last = 0;
    for (const match of value.matchAll(BARE_ADE_LINK)) {
      const start = match.index ?? 0;
      const url = trimLinkEnd(match[0]);
      if (url.length <= url.indexOf("://") + 3) continue;
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
