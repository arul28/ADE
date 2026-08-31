/**
 * A deliberately small markdown renderer.
 *
 * The package ships zero runtime dependencies, so assistant text is parsed
 * here rather than by `marked`/`react-markdown`. It covers what agents
 * actually emit: fenced code, headings, lists, blockquotes, rules, and inline
 * code/bold/italic/links. Everything is rendered as React elements — no
 * `dangerouslySetInnerHTML` anywhere, so raw HTML in a model response is text,
 * not markup.
 *
 * Hosts that want full CommonMark pass their own `renderMarkdown` to
 * `<Transcript>`.
 */

import { Fragment, type ReactNode } from "react";

type Block =
  | { kind: "code"; language: string | null; text: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "paragraph"; text: string };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const UNORDERED = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

export function parseMarkdownBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const language = fence[2] || null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(marker)) {
        body.push(lines[index]!);
        index += 1;
      }
      // An unterminated fence still renders as a code block — a streaming
      // response is a partial document by definition.
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language, text: body.join("\n") });
      continue;
    }

    if (!line.trim().length) {
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!.trim(),
      });
      index += 1;
      continue;
    }

    const listMatch = UNORDERED.exec(line) ?? ORDERED.exec(line);
    if (listMatch) {
      const ordered = UNORDERED.exec(line) === null;
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index]!;
        const match = ordered ? ORDERED.exec(candidate) : UNORDERED.exec(candidate);
        if (!match) break;
        items.push(match[1]!);
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index]!);
        if (!match) break;
        body.push(match[1]!);
        index += 1;
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index]!;
      if (
        !candidate.trim().length
        || FENCE.test(candidate)
        || HEADING.test(candidate)
        || UNORDERED.test(candidate)
        || ORDERED.test(candidate)
        || QUOTE.test(candidate)
        || RULE.test(candidate)
      ) break;
      paragraph.push(candidate.trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "em"; value: string }
  | { kind: "link"; value: string; href: string };

const INLINE =
  /(`+)([^`]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"')]+)/g;

export function parseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  INLINE.lastIndex = 0;

  for (let match = INLINE.exec(source); match; match = INLINE.exec(source)) {
    if (match.index > lastIndex) {
      tokens.push({ kind: "text", value: source.slice(lastIndex, match.index) });
    }
    if (match[2] !== undefined) tokens.push({ kind: "code", value: match[2] });
    else if (match[3] !== undefined) tokens.push({ kind: "strong", value: match[3] });
    else if (match[4] !== undefined) tokens.push({ kind: "strong", value: match[4] });
    else if (match[5] !== undefined) tokens.push({ kind: "em", value: match[5] });
    else if (match[6] !== undefined) tokens.push({ kind: "em", value: match[6] });
    else if (match[7] !== undefined && match[8] !== undefined) {
      tokens.push({ kind: "link", value: match[7], href: match[8] });
    } else if (match[9] !== undefined) {
      tokens.push({ kind: "link", value: match[9], href: match[9] });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < source.length) tokens.push({ kind: "text", value: source.slice(lastIndex) });
  return tokens;
}

/**
 * A protocol-relative reference: two leading slashes, or either backslash
 * variant browsers normalise into them (`\\host`, `/\host`, `\/host`).
 *
 * These read as site-root paths but resolve against another origin entirely, so
 * they must be rejected before the `/` branch of the allowlist accepts them.
 */
const PROTOCOL_RELATIVE = /^[/\\]{2}/;

/**
 * `javascript:` and `data:` hrefs never reach the DOM. Anything not obviously
 * safe renders as plain text.
 */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (PROTOCOL_RELATIVE.test(trimmed)) return null;
  if (/^(https?:|mailto:|tel:|#|\/|\.)/i.test(trimmed)) return trimmed;
  return null;
}

function renderInline(source: string, keyPrefix: string): ReactNode {
  return parseInline(source).map((token, index) => {
    const key = `${keyPrefix}:${index}`;
    switch (token.kind) {
      case "code":
        return <code key={key} className="adechat-code-inline">{token.value}</code>;
      case "strong":
        return <strong key={key}>{token.value}</strong>;
      case "em":
        return <em key={key}>{token.value}</em>;
      case "link": {
        const href = safeHref(token.href);
        if (!href) return <Fragment key={key}>{token.value}</Fragment>;
        return (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {token.value}
          </a>
        );
      }
      default:
        return <Fragment key={key}>{token.value}</Fragment>;
    }
  });
}

/** Render markdown text as React nodes. The default for assistant messages. */
export function renderMarkdown(source: string): ReactNode {
  return parseMarkdownBlocks(source).map((block, index) => {
    const key = `block:${index}`;
    switch (block.kind) {
      case "code":
        return (
          <pre key={key} className="adechat-code-block" data-language={block.language ?? undefined}>
            <code>{block.text}</code>
          </pre>
        );
      case "heading": {
        const Tag = (`h${block.level}`) as "h1" | "h2" | "h3";
        return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
      }
      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return (
          <Tag key={key}>
            {block.items.map((item, itemIndex) => (
              <li key={`${key}:${itemIndex}`}>{renderInline(item, `${key}:${itemIndex}`)}</li>
            ))}
          </Tag>
        );
      }
      case "quote":
        return <blockquote key={key}>{renderInline(block.text, key)}</blockquote>;
      case "rule":
        return <hr key={key} />;
      default:
        return <p key={key}>{renderInline(block.text, key)}</p>;
    }
  });
}
