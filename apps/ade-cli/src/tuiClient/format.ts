import path from "node:path";
import { Lexer, type Token, type Tokens } from "marked";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import { highlightCode, type HighlightedToken } from "./highlightCache";
import { glyphFor } from "./theme";
import type { LocalNotice } from "./types";
import { appendStreamingText, isCodexSubagentMessageId, shouldMergeAssistantText } from "./assistantTextIdentity";
import { terminalReasonLabel } from "./terminalReason";

export type { HighlightedToken } from "./highlightCache";

function singleLine(value: unknown, max = 96): string {
  const text = (() => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  })();
  return (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Web-search results (Codex) render as compact `title — domain` previews under
// the search line. Domain is derived defensively so a malformed url can never
// throw. Shared by renderChatLines (subagent pane) and ChatView (work log) so
// both surfaces show the same lines.
export function webSearchResultDomain(url: string | undefined | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    const host = url.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0] ?? "";
    return host.replace(/^www\./, "");
  }
}

export function webSearchResultPreviewLines(
  results: ReadonlyArray<{ title?: string; url?: string }> | undefined,
  resultsTotal: number | undefined,
  max = 3,
): string[] {
  if (!results || results.length === 0) return [];
  const shown = results.slice(0, max);
  const lines = shown
    .map((result) => {
      const domain = webSearchResultDomain(result.url);
      const title = (result.title ?? "").trim() || domain || (result.url ?? "").trim();
      if (!title) return "";
      return domain && title !== domain ? `${title} — ${domain}` : title;
    })
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const total = typeof resultsTotal === "number" && resultsTotal > lines.length ? resultsTotal : results.length;
  const remaining = total - shown.length;
  if (remaining > 0) {
    lines[lines.length - 1] = `${lines[lines.length - 1]}  +${remaining} more`;
  }
  return lines;
}

function summarizeCommandOutput(output: unknown): string {
  const text = singleLine(output, 160);
  const passed = /\b(\d+)\s+passed\b/i.exec(text)?.[1];
  const failed = /\b(\d+)\s+failed\b/i.exec(text)?.[1];
  if (passed || failed) {
    return [
      passed ? `${passed} passed` : null,
      failed ? `${failed} failed` : null,
    ].filter(Boolean).join(" · ");
  }
  return text;
}

function compactTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function compactPath(value: string, max = 42): string {
  if (value.length <= max) return value;
  const base = path.basename(value);
  if (base.length + 3 >= max) return `...${base.slice(-(max - 3))}`;
  return `.../${base}`;
}

export type RenderedChatLine = {
  id: string;
  tone: "user" | "assistant" | "tool" | "error" | "notice" | "reasoning" | "approval";
  header?: string;
  body: string;
  blocks?: AssistantMarkdownBlock[];
  // Carried on assistant-text lines so coalesceLines only fuses deltas from the
  // SAME streamed message — concurrent parent + subagent messages interleave by
  // timestamp and must not be concatenated into one scrambled paragraph.
  messageId?: string;
  turnId?: string;
  itemId?: string;
};

type TimelineEntry =
  | { kind: "notice"; timestamp: string; index: number; notice: LocalNotice }
  | { kind: "event"; timestamp: string; index: number; envelope: AgentChatEventEnvelope };

export type AssistantMarkdownBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "numbered"; number: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; language?: string; lines: string[]; tokens?: HighlightedToken[][] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "hr" };

export type InlineRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
  href?: string;
  color?: string;
  dim?: boolean;
};

type InlineFlags = { bold?: boolean; italic?: boolean; code?: boolean; link?: boolean; href?: string };

function pushInlineRun(runs: InlineRun[], text: string, flags: InlineFlags): void {
  if (!text.length) return;
  const last = runs[runs.length - 1];
  const sameFlags = last
    && (last.bold ?? false) === (flags.bold ?? false)
    && (last.italic ?? false) === (flags.italic ?? false)
    && (last.code ?? false) === (flags.code ?? false)
    && (last.link ?? false) === (flags.link ?? false)
    && last.href === flags.href;
  if (sameFlags && last) {
    last.text += text;
    return;
  }
  const run: InlineRun = { text };
  if (flags.bold) run.bold = true;
  if (flags.italic) run.italic = true;
  if (flags.code) run.code = true;
  if (flags.link) run.link = true;
  if (flags.href) run.href = flags.href;
  runs.push(run);
}

function walkInlineTokens(tokens: Token[], runs: InlineRun[], flags: InlineFlags): void {
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        if (text.tokens && text.tokens.length) walkInlineTokens(text.tokens, runs, flags);
        else pushInlineRun(runs, text.text, flags);
        break;
      }
      case "escape":
        pushInlineRun(runs, (token as Tokens.Escape).text, flags);
        break;
      case "codespan":
        pushInlineRun(runs, (token as Tokens.Codespan).text, { ...flags, code: true });
        break;
      case "strong": {
        const strong = token as Tokens.Strong;
        walkInlineTokens(strong.tokens, runs, { ...flags, bold: true });
        break;
      }
      case "em": {
        const em = token as Tokens.Em;
        walkInlineTokens(em.tokens, runs, { ...flags, italic: true });
        break;
      }
      case "del": {
        const del = token as Tokens.Del;
        walkInlineTokens(del.tokens, runs, flags);
        break;
      }
      case "link": {
        const link = token as Tokens.Link;
        const child: InlineRun[] = [];
        const href = typeof link.href === "string" ? link.href : undefined;
        if (link.tokens && link.tokens.length) walkInlineTokens(link.tokens, child, { ...flags, link: true, href });
        else pushInlineRun(child, link.text, { ...flags, link: true, href });
        for (const c of child) runs.push(c);
        break;
      }
      case "image":
        pushInlineRun(runs, (token as Tokens.Image).text, flags);
        break;
      case "br":
        pushInlineRun(runs, "\n", flags);
        break;
      case "html":
        pushInlineRun(runs, (token as Tokens.HTML).text, flags);
        break;
      default: {
        const generic = token as Tokens.Generic;
        if (generic.tokens && generic.tokens.length) {
          walkInlineTokens(generic.tokens, runs, flags);
        } else if (typeof generic.text === "string") {
          pushInlineRun(runs, generic.text, flags);
        } else if (typeof generic.raw === "string") {
          pushInlineRun(runs, generic.raw, flags);
        }
        break;
      }
    }
  }
}

export function parseInlineRuns(text: string): InlineRun[] {
  if (!text.length) return [{ text: "" }];
  try {
    const tokens = Lexer.lexInline(text);
    const runs: InlineRun[] = [];
    walkInlineTokens(tokens, runs, {});
    if (!runs.length) return [{ text }];
    return runs;
  } catch {
    return [{ text }];
  }
}

export function chatEventLineId(envelope: AgentChatEventEnvelope, index = 0): string {
  return `${envelope.sequence ?? index}:${envelope.event.type}:${envelope.timestamp}`;
}

function isFailedExpandableEvent(envelope: AgentChatEventEnvelope): boolean {
  const event = envelope.event;
  if (event.type === "tool_result") return event.status === "failed";
  if (event.type === "file_change") return event.status === "failed";
  if (event.type === "command") return event.status === "failed" || (event.exitCode ?? 0) !== 0;
  return false;
}

function statusGlyph(status: string | undefined): string {
  if (status === "running") return "…";
  if (status === "failed") return "x";
  return "✓";
}

function isLowValueHookNotice(noticeKind: string | undefined, message: string): boolean {
  if (noticeKind !== "hook") return false;
  const trimmed = message.trim();
  return /^hook:\s+.+\s+started$/i.test(trimmed)
    || trimmed.toLowerCase() === "trimmed large tool output before sending it back to claude.";
}

function multiLine(value: unknown, maxLines = 18): string {
  if (typeof value === "string") return value.split(/\r?\n/).slice(0, maxLines).join("\n");
  return renderObject(value, maxLines);
}

function flattenInlineTokensToText(tokens: Token[] | undefined): string {
  if (!tokens || !tokens.length) return "";
  let out = "";
  for (const token of tokens) {
    const generic = token as Tokens.Generic;
    // Preserve inline markdown markers so the downstream re-tokenization in
    // parseInlineRuns can re-create the styled runs (codespan, bold, italic).
    // Without this, code spans like `LaneRuntimeBar` get flattened to plain
    // text and lose their violet inline-code styling in the renderer.
    if (token.type === "codespan") {
      const text = typeof generic.text === "string" ? generic.text : "";
      out += `\`${text}\``;
      continue;
    }
    if (token.type === "strong") {
      out += `**${flattenInlineTokensToText(generic.tokens)}**`;
      continue;
    }
    if (token.type === "em") {
      out += `*${flattenInlineTokensToText(generic.tokens)}*`;
      continue;
    }
    if (token.type === "link") {
      const link = generic as unknown as { href?: unknown; text?: unknown; tokens?: Tokens.Generic[] };
      const href = typeof link.href === "string" ? link.href : "";
      const label = flattenInlineTokensToText(generic.tokens) || (typeof generic.text === "string" ? generic.text : href);
      out += href ? `[${label}](${href})` : label;
      continue;
    }
    if (generic.tokens && generic.tokens.length) {
      out += flattenInlineTokensToText(generic.tokens);
    } else if (typeof generic.text === "string") {
      out += generic.text;
    } else if (typeof generic.raw === "string") {
      out += generic.raw;
    }
  }
  return out;
}

function blockTokenToText(token: Token): string {
  const generic = token as Tokens.Generic;
  if (generic.tokens && generic.tokens.length) {
    const inline = flattenInlineTokensToText(generic.tokens);
    if (inline.length) return inline;
  }
  if (typeof generic.text === "string") return generic.text;
  if (typeof generic.raw === "string") return generic.raw.trim();
  return "";
}

function listItemText(item: Tokens.ListItem): string {
  if (item.tokens && item.tokens.length) {
    const parts: string[] = [];
    for (const child of item.tokens) {
      if (child.type === "list") continue;
      parts.push(blockTokenToText(child));
    }
    const joined = parts.filter((p) => p.length).join(" ");
    if (joined.length) return joined;
  }
  return item.text ?? "";
}

function stripTaskCheckboxPrefix(value: string): string {
  return value.replace(/^\[([ xX])\]\s*/, "");
}

function appendListBlocks(list: Tokens.List, blocks: AssistantMarkdownBlock[]): void {
  let counter = typeof list.start === "number" && list.start > 0 ? list.start : 1;
  for (const item of list.items) {
    const checkboxPrefix = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
    const rawText = listItemText(item).replace(/\s+/g, " ").trim();
    const baseText = item.task ? stripTaskCheckboxPrefix(rawText) : rawText;
    const text = `${checkboxPrefix}${baseText}`.trim();
    if (list.ordered) {
      blocks.push({ kind: "numbered", number: String(counter), text });
      counter += 1;
    } else {
      blocks.push({ kind: "bullet", text });
    }
    if (item.tokens) {
      for (const child of item.tokens) {
        if (child.type === "list") {
          appendListBlocks(child as Tokens.List, blocks);
        }
      }
    }
  }
}

function appendBlockTokens(tokens: Token[], blocks: AssistantMarkdownBlock[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        const text = flattenInlineTokensToText(heading.tokens) || heading.text;
        blocks.push({ kind: "heading", level: heading.depth, text: text.trim() });
        break;
      }
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        const text = flattenInlineTokensToText(paragraph.tokens) || paragraph.text;
        const normalized = text.replace(/\s+/g, " ").trim();
        if (normalized.length) blocks.push({ kind: "paragraph", text: normalized });
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        const language = code.lang?.trim() || undefined;
        const rawLines = code.text.split("\n");
        const block: AssistantMarkdownBlock = language
          ? { kind: "code", language, lines: rawLines }
          : { kind: "code", lines: rawLines };
        const highlighted = highlightCode(code.text, language);
        if (language && highlighted.length === rawLines.length) {
          (block as { tokens?: HighlightedToken[][] }).tokens = highlighted;
        }
        blocks.push(block);
        break;
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        const text = flattenInlineTokensToText(quote.tokens) || quote.text;
        blocks.push({ kind: "quote", text: text.replace(/\s+/g, " ").trim() });
        break;
      }
      case "list":
        appendListBlocks(token as Tokens.List, blocks);
        break;
      case "hr":
        blocks.push({ kind: "hr" });
        break;
      case "table": {
        const table = token as Tokens.Table;
        const headers = table.header.map((cell) => (flattenInlineTokensToText(cell.tokens) || cell.text).trim());
        const rows = table.rows.map((row) => row.map((cell) => (flattenInlineTokensToText(cell.tokens) || cell.text).trim()));
        blocks.push({ kind: "table", headers, rows });
        break;
      }
      case "html": {
        const html = token as Tokens.HTML;
        const text = html.text.trim();
        if (text.length) blocks.push({ kind: "paragraph", text });
        break;
      }
      case "text": {
        const text = token as Tokens.Text;
        const value = flattenInlineTokensToText(text.tokens) || text.text;
        const normalized = value.replace(/\s+/g, " ").trim();
        if (normalized.length) blocks.push({ kind: "paragraph", text: normalized });
        break;
      }
      default: {
        const generic = token as Tokens.Generic;
        if (generic.tokens && generic.tokens.length) appendBlockTokens(generic.tokens, blocks);
        break;
      }
    }
  }
}

const MARKDOWN_CACHE_MAX_ENTRIES = 500;
const MARKDOWN_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const markdownCache = new Map<string, { blocks: AssistantMarkdownBlock[]; bytes: number }>();
let markdownCacheBytes = 0;

function estimateMarkdownBytes(text: string, blocks: AssistantMarkdownBlock[]): number {
  let bytes = text.length * 2 + 32;
  for (const block of blocks) {
    bytes += 48;
    switch (block.kind) {
      case "code":
        bytes += (block.language?.length ?? 0) * 2;
        for (const line of block.lines) bytes += line.length * 2 + 16;
        break;
      case "table":
        for (const header of block.headers) bytes += header.length * 2 + 16;
        for (const row of block.rows) {
          for (const cell of row) bytes += cell.length * 2 + 16;
        }
        break;
      case "heading":
      case "paragraph":
      case "quote":
      case "bullet":
      case "numbered":
        bytes += block.text.length * 2;
        break;
      case "hr":
        break;
      default:
        break;
    }
  }
  return bytes;
}

function rememberMarkdownParse(text: string, blocks: AssistantMarkdownBlock[]): AssistantMarkdownBlock[] {
  const bytes = estimateMarkdownBytes(text, blocks);
  markdownCache.set(text, { blocks, bytes });
  markdownCacheBytes += bytes;
  while (markdownCache.size > MARKDOWN_CACHE_MAX_ENTRIES || markdownCacheBytes > MARKDOWN_CACHE_MAX_BYTES) {
    const oldest = markdownCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = markdownCache.get(oldest);
    markdownCache.delete(oldest);
    if (evicted) markdownCacheBytes -= evicted.bytes;
    if (markdownCache.size === 0) {
      markdownCacheBytes = 0;
      break;
    }
  }
  return blocks;
}

function parseAssistantMarkdownUncached(text: string): AssistantMarkdownBlock[] {
  const blocks: AssistantMarkdownBlock[] = [];
  try {
    const tokens = Lexer.lex(text.replace(/\r\n/g, "\n"));
    appendBlockTokens(tokens, blocks);
  } catch {
    // Marked lexer is robust; on the off chance it throws, fall through.
  }
  if (!blocks.length && text.trim().length) {
    blocks.push({ kind: "paragraph", text: text.trim() });
  }
  return blocks;
}

export function parseAssistantMarkdown(text: string): AssistantMarkdownBlock[] {
  if (!text.length) return [];
  const hit = markdownCache.get(text);
  if (hit) {
    markdownCache.delete(text);
    markdownCache.set(text, hit);
    return hit.blocks;
  }
  return rememberMarkdownParse(text, parseAssistantMarkdownUncached(text));
}

export function __clearAssistantMarkdownCacheForTests(): void {
  markdownCache.clear();
  markdownCacheBytes = 0;
}

export function __getAssistantMarkdownCacheStatsForTests(): { entries: number; bytes: number } {
  return { entries: markdownCache.size, bytes: markdownCacheBytes };
}

export function latestExpandableFailureId(events: AgentChatEventEnvelope[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const envelope = events[index]!;
    if (isFailedExpandableEvent(envelope)) return chatEventLineId(envelope, index);
  }
  return null;
}

export function renderChatLines(args: {
  events: AgentChatEventEnvelope[];
  notices: LocalNotice[];
  activeSession: AgentChatSessionSummary | null;
  expandedLineIds?: Set<string>;
  maxLines?: number;
}): RenderedChatLine[] {
  const lines: RenderedChatLine[] = [];
  const terminalReasonByTurnId = new Map<string, string>();
  for (const envelope of args.events) {
    const event = envelope.event;
    if (event.type !== "done" || event.status === "completed") continue;
    const label = terminalReasonLabel(event.terminalReason);
    if (label) terminalReasonByTurnId.set(event.turnId, label);
  }
  const timeline: TimelineEntry[] = [
    ...args.events.map((envelope, index): TimelineEntry => ({
      kind: "event",
      timestamp: envelope.timestamp,
      index,
      envelope,
    })),
    ...args.notices.map((notice, index): TimelineEntry => ({
      kind: "notice",
      timestamp: notice.timestamp,
      index,
      notice,
    })),
  ].sort((a, b) => {
    const aTime = new Date(a.timestamp).getTime();
    const bTime = new Date(b.timestamp).getTime();
    const safeATime = Number.isNaN(aTime) ? 0 : aTime;
    const safeBTime = Number.isNaN(bTime) ? 0 : bTime;
    if (safeATime !== safeBTime) return safeATime - safeBTime;
    if (a.kind !== b.kind) return a.kind === "event" ? -1 : 1;
    return a.index - b.index;
  });

  const pushLine = (line: RenderedChatLine): void => {
    const last = lines[lines.length - 1];
    if (
      last
      && last.tone === line.tone
      && last.body === line.body
      && (last.header ?? null) === (line.header ?? null)
    ) {
      return;
    }
    lines.push(line);
  };

  for (const entry of timeline) {
    if (entry.kind === "notice") {
      const notice = entry.notice;
      pushLine({
        id: notice.id,
        tone: notice.tone === "error" ? "error" : "notice",
        body: notice.text,
      });
      continue;
    }

    const { envelope, index } = entry;
    const event = envelope.event;
    const id = chatEventLineId(envelope, index);
    const expanded = args.expandedLineIds?.has(id) ?? false;
    if (event.type === "user_message") {
      lines.push({
        id,
        tone: "user",
        body: event.displayText ?? event.text,
      });
      continue;
    }
    if (event.type === "transcript_retraction") {
      const retractedIds = new Set(event.messageIds.map((messageId) => messageId.trim()).filter(Boolean));
      if (!retractedIds.size) continue;
      for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
        const line = lines[lineIndex];
        if (line?.tone === "assistant" && line.messageId && retractedIds.has(line.messageId)) {
          lines.splice(lineIndex, 1);
        }
      }
      continue;
    }
    if (event.type === "text") {
      // Codex subagent child content is namespaced `codex-subagent:` and belongs
      // in the subagent transcript, not the parent chat — mirror desktop, which
      // filters these out of the parent transcript via provenance.
      if (isCodexSubagentMessageId(event.messageId)) continue;
      lines.push({
        id,
        tone: "assistant",
        body: event.text,
        blocks: parseAssistantMarkdown(event.text),
        messageId: event.messageId,
        turnId: event.turnId,
        itemId: event.itemId,
      });
      continue;
    }
    if (event.type === "reasoning") {
      lines.push({
        id,
        tone: "reasoning",
        body: `thinking ${singleLine(event.text, 120)}`,
      });
      continue;
    }
    if (event.type === "tool_call") {
      lines.push({
        id,
        tone: "tool",
        body: `> ${event.tool}  ${singleLine(event.args, 96)}`,
      });
      continue;
    }
    if (event.type === "tool_result") {
      const failed = event.status === "failed";
      lines.push({
        id,
        tone: failed ? "error" : "tool",
        body: failed && expanded
          ? `x ${event.tool}\n${multiLine(event.result, 18)}`
          : `${failed ? "x" : "✓"} ${event.tool}  ${singleLine(event.result, 120)}${failed ? "  ↵ expands" : ""}`,
      });
      continue;
    }
    if (event.type === "file_change") {
      const diffLines = event.diff.split(/\r?\n/).slice(0, event.status === "failed" && expanded ? 24 : 10).join("\n");
      lines.push({
        id,
        tone: event.status === "failed" ? "error" : "tool",
        body: `> edit ${compactPath(event.path)}  ${event.kind}${event.status === "failed" && !expanded ? "  ↵ expands" : ""}\n${diffLines}`,
      });
      continue;
    }
    if (event.type === "command") {
      const failed = event.status === "failed" || (event.exitCode ?? 0) !== 0;
      lines.push({
        id,
        tone: failed ? "error" : "tool",
        body: failed && expanded
          ? `x run ${event.command}  ${event.durationMs ? `${event.durationMs}ms` : ""}\n${multiLine(event.output, 24)}`
          : `${failed ? "x" : "✓"} run ${event.command}  ${event.durationMs ? `${event.durationMs}ms` : ""}${failed ? "  ↵ expands" : ""}\n${summarizeCommandOutput(event.output)}`,
      });
      continue;
    }
    if (event.type === "plan") {
      const completed = event.steps.filter((step) => step.status === "completed").length;
      const header = event.streamingText
        ? `plan ${event.state ?? "updated"}  ${singleLine(event.streamingText, 110)}`
        : `plan ${completed}/${event.steps.length} complete`;
      const steps = event.steps
        .slice(0, 8)
        .map((step) => `${glyphFor(step.status)} ${step.text}`)
        .join("\n");
      lines.push({
        id,
        tone: "notice",
        body: steps ? `${header}\n${steps}` : header,
      });
      continue;
    }
    if (event.type === "web_search") {
      const head = `${statusGlyph(event.status)} web ${singleLine(event.query, 96)}`;
      const actionLines = event.actions?.length
        ? event.actions.map((action) => {
          const kind = action.type || "action";
          const detail = action.title ?? action.url ?? action.query ?? action.queries?.[0] ?? "";
          return `   ${kind.padEnd(12, " ")} ${singleLine(detail, 96)}`.trimEnd();
        })
        : event.action ? [`   ${event.action}`] : [];
      const resultLines = webSearchResultPreviewLines(event.results, event.resultsTotal, 3)
        .map((line) => `   ${singleLine(line, 96)}`);
      const bodyLines = [head, ...actionLines, ...resultLines];
      lines.push({
        id,
        tone: event.status === "failed" ? "error" : "tool",
        body: bodyLines.join("\n"),
      });
      continue;
    }
    if (event.type === "codex_safety_buffering") {
      const model = event.state.fasterModel ?? event.state.model ?? "";
      lines.push({
        id,
        tone: "notice",
        body: `safety buffering${model ? ` · ${singleLine(model, 64)}` : ""}`,
      });
      continue;
    }
    if (event.type === "codex_moderation_metadata") {
      lines.push({ id, tone: "notice", body: "moderation checked" });
      continue;
    }
    if (event.type === "codex_sleep") {
      const duration = typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
        ? event.durationMs < 1000
          ? `${Math.max(1, Math.round(event.durationMs))}ms`
          : `${Math.round(event.durationMs / 1000)}s`
        : "";
      lines.push({
        id,
        tone: "notice",
        body: `${statusGlyph(event.status)} wait${duration ? ` ${duration}` : ""}`,
      });
      continue;
    }
    if (event.type === "codex_thread_deleted") {
      lines.push({ id, tone: "error", body: "thread deleted upstream · next message starts fresh" });
      continue;
    }
    if (event.type === "codex_turn_stalled") {
      lines.push({
        id,
        tone: "error",
        body: `recovery · ${singleLine(event.message, 140)}\n   /recover wait · nudge · retry · resume`,
      });
      continue;
    }
    if (event.type === "codex_image_generation" || event.type === "codex_image_view") {
      const isGeneration = event.type === "codex_image_generation";
      const title = isGeneration
        ? event.revisedPrompt ?? event.prompt ?? "image"
        : event.title ?? event.url ?? event.path ?? "image";
      lines.push({
        id,
        tone: event.status === "failed" ? "error" : "tool",
        body: `${statusGlyph(event.status)} ${isGeneration ? "image generated" : "image"}  ${singleLine(title, 120)}`,
      });
      continue;
    }
    // Provider goal events render as the amber banner above chat in app.tsx.
    if (event.type === "codex_goal_updated" || event.type === "codex_goal_cleared"
      || event.type === "claude_goal_updated" || event.type === "claude_goal_cleared") {
      continue;
    }
    if (event.type === "codex_token_usage") {
      continue;
    }
    if (event.type === "approval_request") {
      const record = event as unknown as Record<string, unknown>;
      const files = Array.isArray(record.files) ? record.files : [];
      const additions = typeof record.totalAdditions === "number" ? record.totalAdditions : 0;
      const deletions = typeof record.totalDeletions === "number" ? record.totalDeletions : 0;
      lines.push({
        id,
        tone: "approval",
        body: `approval needed  ${files.length} files  +${additions} -${deletions}`,
      });
      continue;
    }
    if (event.type === "context_compact") {
      if (event.state === "started") {
        lines.push({ id, tone: "notice", body: `⟳ compacting · ${event.trigger}` });
        continue;
      }
      const preTokens = typeof event.preTokens === "number" ? ` · before ${event.preTokens.toLocaleString()} tokens` : "";
      lines.push({
        id,
        tone: "notice",
        body: `context compacted · ${event.trigger}${preTokens}`,
      });
      continue;
    }
    if (event.type === "codex_context_compaction") {
      const verb = event.state === "started" ? "compacting" : "compacted";
      lines.push({
        id,
        tone: "notice",
        body: `⟳ ${verb} · ${event.trigger}`,
      });
      continue;
    }
    if (event.type === "conversation_reset") {
      lines.push({ id, tone: "notice", body: "conversation reset" });
      continue;
    }
    if (event.type === "interrupt_receipt") {
      const count = event.stillQueuedUuids.length;
      if (count > 0) {
        lines.push({
          id,
          tone: "notice",
          body: `stopped — ${count} queued message${count === 1 ? "" : "s"} will still run`,
        });
      }
      continue;
    }
    if (event.type === "command_lifecycle") {
      if (event.status === "cancelled" || event.status === "discarded") {
        const verb = event.status === "discarded" ? "discarded" : "cancelled";
        lines.push({
          id,
          tone: "notice",
          body: `queued message ${verb}${event.preview ? ` · ${singleLine(event.preview, 120)}` : ""}`,
        });
      }
      continue;
    }
    if (event.type === "status") {
      // The interrupted state is conveyed by the dedicated "Interrupted · chat to continue"
      // suffix row, so suppress the redundant [status] interrupted transcript line.
      if (event.turnStatus === "interrupted") {
        continue;
      }
      const tone: "error" | "notice" = event.turnStatus === "failed" ? "error" : "notice";
      const terminalReason = event.turnStatus !== "completed" && event.turnId
        ? terminalReasonByTurnId.get(event.turnId) ?? null
        : null;
      lines.push({
        id,
        tone,
        body: `[status] ${event.turnStatus}${terminalReason ? ` · ${terminalReason}` : ""}${event.message ? ` · ${singleLine(event.message, 120)}` : ""}`,
      });
      continue;
    }
    if (event.type === "error") {
      lines.push({ id, tone: "error", body: `[error] ${singleLine(event.message, 160)}` });
      continue;
    }
    if (event.type === "done") {
      const usage = event.usage ?? {};
      const inputTokens = compactTokenCount(usage.inputTokens);
      const outputTokens = compactTokenCount(usage.outputTokens);
      const parts = [
        event.status !== "completed" ? terminalReasonLabel(event.terminalReason) : null,
        inputTokens ? `in ${inputTokens}` : null,
        outputTokens ? `out ${outputTokens}` : null,
        typeof event.costUsd === "number" ? `$${event.costUsd.toFixed(2)}` : null,
      ].filter(Boolean);
      lines.push({
        id,
        tone: "notice",
        body: `[done] ${event.status}${parts.length ? ` · ${parts.join(" · ")}` : ""}`,
      });
      continue;
    }
    if (event.type === "activity") {
      lines.push({ id, tone: "notice", body: `· ${event.activity}${event.detail ? ` ${singleLine(event.detail, 96)}` : ""}` });
      continue;
    }
    if (event.type === "tokens") {
      // Tokens drive the ContextMeter footer; do not render in chat.
      continue;
    }
    if (event.type === "cloud_artifact") {
      lines.push({ id, tone: "notice", body: `[cloud] artifact · ${compactPath(event.path)}` });
      continue;
    }
    if (event.type === "cloud_status") {
      lines.push({
        id,
        tone: event.status === "error" ? "error" : "notice",
        body: `[cloud] ${event.status}${event.detail ? ` · ${singleLine(event.detail, 96)}` : ""}`,
      });
      continue;
    }
    if (event.type === "step_boundary") {
      lines.push({ id, tone: "notice", body: `── step ${event.stepNumber} ──` });
      continue;
    }
    if (event.type === "todo_update") {
      const todoLines = event.items
        .slice(0, 12)
        .map((todo) => `${glyphFor(todo.status)} ${todo.description}`);
      lines.push({ id, tone: "notice", body: `todos\n${todoLines.join("\n")}` });
      continue;
    }
    if (event.type === "subagent_started") {
      lines.push({ id, tone: "notice", body: `[agent] ${singleLine(event.description, 96)} (started)` });
      continue;
    }
    if (event.type === "subagent_progress") {
      lines.push({
        id,
        tone: "notice",
        body: `[agent] ${singleLine(event.description ?? event.summary, 80)} (working)`,
      });
      continue;
    }
    if (event.type === "subagent_result") {
      lines.push({
        id,
        tone: event.status === "failed" ? "error" : "notice",
        body: `[agent] ${singleLine(event.summary, 96)} (${event.status})`,
      });
      continue;
    }
    if (event.type === "structured_question") {
      lines.push({ id, tone: "approval", body: `[?] ${singleLine(event.question, 160)}` });
      continue;
    }
    if (event.type === "tool_use_summary") {
      lines.push({ id, tone: "notice", body: `[tools] ${singleLine(event.summary, 160)}` });
      continue;
    }
    if (event.type === "completion_report") {
      lines.push({ id, tone: "notice", body: `[done] turn summary: ${singleLine(event.report.summary, 160)}` });
      continue;
    }
    if (event.type === "auto_approval_review") {
      lines.push({
        id,
        tone: "notice",
        body: `[auto-approval] ${event.reviewStatus}${event.action ? ` · ${event.action}` : ""}`,
      });
      continue;
    }
    if (event.type === "prompt_suggestion") {
      lines.push({ id, tone: "notice", body: `💡 ${singleLine(event.suggestion, 160)}` });
      continue;
    }
    if (event.type === "turn_diff_summary") {
      lines.push({
        id,
        tone: "notice",
        body: `[diff] +${event.totalAdditions}/-${event.totalDeletions} across ${event.files.length} file${event.files.length === 1 ? "" : "s"}`,
      });
      continue;
    }
    if (event.type === "pending_input_resolved") {
      continue;
    }
    if (event.type === "delegation_state") {
      const label = event.message ?? event.contract?.status ?? event.contract?.workerIntent ?? "state";
      lines.push({ id, tone: "notice", body: `[delegation] ${singleLine(label, 160)}` });
      continue;
    }
    if (event.type === "system_notice") {
      const noticeKind = (event as { noticeKind?: string }).noticeKind;
      const severity = (event as { severity?: string }).severity;
      const message = singleLine((event as { message?: unknown }).message, 160);
      const normalizedMessage = message.trim().toLowerCase();
      if (!normalizedMessage) continue;
      if (noticeKind === "info" && normalizedMessage === "session ready") continue;
      if (isLowValueHookNotice(noticeKind, message)) continue;

      // Surface the severity-bearing noticeKinds with an error tone so the TUI
      // colorizes them distinctively. Guardian warnings, rate limits, thread
      // errors, and provider health issues map to `tone: "error"`; warnings and
      // config issues keep the default notice tone.
      const tone: "notice" | "error" = severity === "error"
        || (!severity && (
          noticeKind === "error"
          || noticeKind === "rate_limit"
          || noticeKind === "thread_error"
          || noticeKind === "provider_health"
          || (noticeKind === "auth" && /\b(?:fail|failed|error|invalid|expired|denied)\b/i.test(message))
        ))
        ? "error"
        : "notice";
      pushLine({
        id,
        tone,
        body: message,
      });
      continue;
    }
  }
  return coalesceLines(lines).slice(-(args.maxLines ?? 80));
}

function headerSpeakerKey(header: string | undefined): string {
  if (!header) return "";
  const first = header.split("·")[0];
  return first ? first.trim() : "";
}

// Streamed chunks may break mid-word ("Consolid" + "ated"), so fragments join
// without inserted whitespace; appendStreamingText additionally dedupes
// cumulative/tail re-emits of the same message (overlap-aware, desktop parity).
const smartConcat = appendStreamingText;

function coalesceLines(lines: RenderedChatLine[]): RenderedChatLine[] {
  const out: RenderedChatLine[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (
      last
      && line.tone === "assistant"
      && last.tone === "assistant"
      && headerSpeakerKey(line.header) === headerSpeakerKey(last.header)
      // Only fuse deltas from the SAME streamed message. Without this, the
      // interleaved deltas of concurrent parent + subagent messages (sorted by
      // timestamp) collapse into one scrambled paragraph.
      && shouldMergeAssistantText(last, line)
    ) {
      const body = smartConcat(last.body, line.body);
      out[out.length - 1] = {
        ...last,
        body,
        blocks: parseAssistantMarkdown(body),
        // Preserve the message identity so a later delta still matches.
        messageId: last.messageId ?? line.messageId,
        turnId: last.turnId ?? line.turnId,
        itemId: last.itemId ?? line.itemId,
      };
      continue;
    }
    out.push(line);
  }
  return out;
}

export function formatLaneLabel(lane: LaneSummary | null): string {
  if (!lane) return "no lane";
  const dirty = lane.status?.dirty ? "*" : "";
  const ahead = lane.status?.ahead ? ` ${lane.status.ahead}↑` : "";
  return `${lane.name}${dirty}${ahead}`;
}

export function formatSessionLabel(session: AgentChatSessionSummary): string {
  const label = (session.title ?? session.goal ?? session.summary ?? session.sessionId).trim();
  const tag = session.orchestrationTag ? ` #${session.orchestrationTag}` : "";
  const completion = session.completion?.status;
  const state = session.archivedAt
    ? " ×"
    : session.awaitingInput
      ? " ?"
      : session.status === "active"
        ? " ●"
        : completion === "blocked"
          ? " !"
          : completion === "partial"
            ? " ◐"
            : completion === "completed"
              ? " ✓"
              : "";
  return `${label}${tag}${state}`;
}

export function renderObject(value: unknown, maxLines = 24): string {
  if (value == null) return "No data.";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2).split(/\r?\n/).slice(0, maxLines).join("\n");
  } catch {
    return String(value);
  }
}

export function summarizeDiffChanges(value: unknown): Array<{ path: string; additions?: number; deletions?: number; body?: string }> {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const files = Array.isArray(record.files) ? record.files : Array.isArray(record.changes) ? record.changes : [];
  return files
    .map((entry) => {
      const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      const filePath = String(item.path ?? item.filePath ?? item.relativePath ?? "unknown");
      return {
        path: filePath,
        additions: typeof item.additions === "number" ? item.additions : undefined,
        deletions: typeof item.deletions === "number" ? item.deletions : undefined,
        body: typeof item.diff === "string" ? item.diff : undefined,
      };
    })
    .slice(0, 20);
}

/**
 * Classify a single unified-diff line so the renderer can colorize it.
 * Pure + theme-free so it stays testable; the caller maps the kind to a
 * theme token. File-meta lines (`diff --git`, `index`, the `+++`/`---`
 * header pair) are distinguished from real `+`/`-` content so they don't
 * paint the whole file header green/red.
 */
export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ") ||
    line.startsWith("\\ No newline")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}
