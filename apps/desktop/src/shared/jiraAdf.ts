type AdfMark = { type: string; attrs?: Record<string, unknown> };
type AdfNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
};

export type JiraAdfDocument = AdfNode;

const doc = (content: AdfNode[]): JiraAdfDocument => ({ type: "doc", version: 1, content } as JiraAdfDocument);
const text = (value: string, marks?: AdfMark[]): AdfNode => ({ type: "text", text: value, ...(marks?.length ? { marks } : {}) });
const paragraph = (content: AdfNode[]): AdfNode => ({ type: "paragraph", content });

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content : [];
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]<>])/g, "\\$1");
}

function markdownInline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map((node) => {
    if (node.type === "hardBreak") return "  \n";
    if (node.type === "mention") {
      const name = typeof node.attrs?.text === "string" ? node.attrs.text : "someone";
      return name.startsWith("@") ? name : `@${name}`;
    }
    if (node.type === "media" || node.type === "mediaInline" || node.type === "mediaSingle") {
      const name = typeof node.attrs?.alt === "string" ? node.attrs.alt : "attachment";
      return `[media: ${name}]`;
    }
    if (node.type !== "text") return markdownBlocks([node]);
    const raw = node.text ?? "";
    const leading = raw.match(/^\s+/)?.[0] ?? "";
    const trailing = raw.slice(leading.length).match(/\s+$/)?.[0] ?? "";
    const core = raw.slice(leading.length, trailing ? -trailing.length : undefined);
    let value = escapeMarkdown(core);
    for (const mark of node.marks ?? []) {
      if (mark.type === "code") value = `\`${value.replace(/`/g, "\\`")}\``;
      else if (mark.type === "strong") value = `**${value}**`;
      else if (mark.type === "em") value = `_${value}_`;
      else if (mark.type === "strike") value = `~~${value}~~`;
      else if (mark.type === "link") {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
        value = href ? `[${value}](${href.replace(/[()\s]/g, (part) => encodeURIComponent(part))})` : value;
      }
    }
    return `${leading}${value}${trailing}`;
  }).join("");
}

function blockText(node: AdfNode): string {
  return markdownInline(children(node)).trimEnd();
}

function markdownList(node: AdfNode, depth: number): string {
  const ordered = node.type === "orderedList";
  let index = typeof node.attrs?.order === "number" ? node.attrs.order : 1;
  const indent = "  ".repeat(depth);
  return children(node).map((item) => {
    const itemChildren = children(item);
    const firstBlock = itemChildren.find((child) => child.type !== "bulletList" && child.type !== "orderedList");
    const first = firstBlock ? blockText(firstBlock) : "";
    const marker = ordered ? `${index++}. ` : "- ";
    const nested = itemChildren
      .filter((child) => child.type === "bulletList" || child.type === "orderedList")
      .map((child) => markdownList(child, depth + 1));
    return `${indent}${marker}${first}${nested.length ? `\n${nested.join("\n")}` : ""}`;
  }).join("\n");
}

function tableCell(node: AdfNode): string {
  return markdownInline(children(node)).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function markdownTable(node: AdfNode): string {
  const rows = children(node).map((row) => children(row).map(tableCell));
  if (!rows.length) return "";
  const width = Math.max(1, ...rows.map((row) => row.length));
  const cells = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
  const heading = cells(rows[0] ?? []);
  const separator = cells(Array.from({ length: width }, () => "---"));
  return [heading, separator, ...rows.slice(1).map(cells)].join("\n");
}

function markdownBlocks(nodes: AdfNode[] | undefined): string {
  const blocks: string[] = [];
  for (const node of nodes ?? []) {
    let value = "";
    switch (node.type) {
      case "paragraph":
        value = markdownInline(children(node));
        break;
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
        value = `${"#".repeat(level)} ${markdownInline(children(node))}`;
        break;
      }
      case "bulletList":
      case "orderedList":
        value = markdownList(node, 0);
        break;
      case "codeBlock": {
        const code = children(node).map((child) => child.text ?? "").join("");
        const fence = "`".repeat(Math.max(3, Math.max(0, ...(code.match(/`+/g) ?? []).map((part) => part.length)) + 1));
        const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
        value = `${fence}${language}\n${code.replace(/\n$/, "")}\n${fence}`;
        break;
      }
      case "blockquote":
        value = markdownBlocks(children(node)).split("\n").map((line) => `> ${line}`).join("\n");
        break;
      case "rule":
        value = "---";
        break;
      case "table":
        value = markdownTable(node);
        break;
      case "mediaSingle":
      case "media":
      case "mediaInline": {
        const media = node.type === "mediaSingle" ? children(node)[0] : node;
        const name = typeof media?.attrs?.alt === "string" ? media.attrs.alt : "attachment";
        value = `[media: ${name}]`;
        break;
      }
      default:
        value = markdownInline(children(node));
    }
    if (value.trim()) blocks.push(value.trimEnd());
  }
  return blocks.join("\n\n");
}

/** Converts Jira's Atlassian Document Format to readable markdown. */
export function jiraAdfToMarkdown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const root = value as AdfNode;
  if (root.type === "text") return markdownInline([root]);
  return markdownBlocks(root.type === "doc" ? children(root) : [root]);
}

function inlineNodes(source: string): AdfNode[] {
  const result: AdfNode[] = [];
  let position = 0;
  const token = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(`+)(.+?)\3|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\n]+)\*|_([^_\n]+)_| {2,}\n|\\([\\`*_{}\[\]<>])/g;
  for (const match of source.matchAll(token)) {
    const start = match.index ?? 0;
    if (start > position) result.push(text(source.slice(position, start)));
    if (match[1] !== undefined && match[2] !== undefined) {
      result.push(...inlineNodes(match[1]).map((node) => node.type === "text"
        ? { ...node, marks: [...(node.marks ?? []), { type: "link", attrs: { href: match[2] } }] }
        : node));
    } else if (match[3]) result.push(text(match[4] ?? "", [{ type: "code" }]));
    else if (match[5] !== undefined || match[6] !== undefined) result.push(text(match[5] ?? match[6] ?? "", [{ type: "strong" }]));
    else if (match[7] !== undefined) result.push(text(match[7], [{ type: "strike" }]));
    else if (match[8] !== undefined || match[9] !== undefined) result.push(text(match[8] ?? match[9] ?? "", [{ type: "em" }]));
    else if (match[0].endsWith("\n")) result.push({ type: "hardBreak" });
    else if (match[10] !== undefined) result.push(text(match[10]));
    position = start + match[0].length;
  }
  if (position < source.length) result.push(text(source.slice(position)));
  return result;
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function tableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseBlocks(lines: string[]): AdfNode[] {
  const result: AdfNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) { i++; continue; }
    if (/^\s*```+/.test(line) || /^\s*~~~+/.test(line)) {
      const opening = line.trim();
      const fence = opening.slice(0, opening.search(/[^`~]/) < 0 ? opening.length : opening.search(/[^`~]/));
      const language = opening.slice(fence.length).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence)) code.push(lines[i++] ?? "");
      if (i < lines.length) i++;
      result.push({ type: "codeBlock", attrs: language ? { language } : undefined, content: code.length ? [text(code.join("\n"))] : [] });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { result.push({ type: "heading", attrs: { level: heading[1]!.length }, content: inlineNodes(heading[2] ?? "") }); i++; continue; }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { result.push({ type: "rule" }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*> ?/, ""));
      result.push({ type: "blockquote", content: parseBlocks(quote) });
      continue;
    }
    if (i + 1 < lines.length && line.includes("|") && tableSeparator(lines[i + 1] ?? "")) {
      const rows = [splitTableRow(line)];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(splitTableRow(lines[i++]!));
      result.push({ type: "table", content: rows.map((row, rowIndex) => ({
        type: "tableRow",
        content: row.map((cell) => ({ type: rowIndex === 0 ? "tableHeader" : "tableCell", content: [paragraph(inlineNodes(cell))] })),
      })) });
      continue;
    }
    const listMatch = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const baseIndent = listMatch[1]!.length;
      const ordered = /^\d/.test(listMatch[2]!);
      const items: AdfNode[] = [];
      let order = ordered ? Number.parseInt(listMatch[2]!, 10) : 1;
      while (i < lines.length) {
        const current = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(lines[i] ?? "");
        if (!current || current[1]!.length < baseIndent || /^\d/.test(current[2]!) !== ordered) break;
        if (current[1]!.length !== baseIndent) break;
        const itemLine = current[3] ?? "";
        const itemBlocks: AdfNode[] = [paragraph(inlineNodes(itemLine))];
        i++;
        const nestedLines: string[] = [];
        while (i < lines.length) {
          const next = lines[i] ?? "";
          const nextList = /^(\s*)([-+*]|\d+[.)])\s+/.exec(next);
          if (nextList && nextList[1]!.length > baseIndent) { nestedLines.push(next); i++; continue; }
          if (/^\s+$/.test(next) || !next.trim()) { i++; continue; }
          break;
        }
        if (nestedLines.length) itemBlocks.push(...parseBlocks(nestedLines.map((nested) => nested.slice(Math.min(nested.length, baseIndent + 2)))));
        items.push({ type: "listItem", content: itemBlocks });
        if (ordered) order = Math.max(order, Number.parseInt(current[2]!, 10) || order);
      }
      result.push({ type: ordered ? "orderedList" : "bulletList", ...(ordered ? { attrs: { order } } : {}), content: items });
      continue;
    }
    const paragraphLines = [line.trimStart()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6})\s|^\s*```|^\s*~~~|^\s*>|^\s*(?:---+|___+|\*\*\*+)\s*$/.test(lines[i]!) && !/^(\s*)([-+*]|\d+[.)])\s+/.test(lines[i]!) && !(lines[i]!.includes("|") && tableSeparator(lines[i + 1] ?? ""))) {
      paragraphLines.push(lines[i]!.trimStart());
      i++;
    }
    result.push(paragraph(inlineNodes(paragraphLines.join("\n"))));
  }
  return result;
}

/** Converts common markdown blocks and inline marks to Jira ADF. */
export function markdownToJiraAdf(markdown: string): JiraAdfDocument {
  const source = markdown.replace(/\r\n?/g, "\n");
  return doc(parseBlocks(source.split("\n")));
}
