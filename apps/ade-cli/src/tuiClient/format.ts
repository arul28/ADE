import path from "node:path";
import { getModelById } from "../../../desktop/src/shared/modelRegistry";
import type { AgentChatEventEnvelope, AgentChatProvider, AgentChatSessionSummary } from "../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import type { LocalNotice } from "./types";

function timeLabel(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
  | { kind: "code"; language?: string; lines: string[] }
  | { kind: "hr" };

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

function providerEventLabel(provider: AgentChatProvider | null | undefined): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "opencode") return "OpenCode";
  if (provider === "cursor") return "Cursor";
  if (provider === "droid") return "Droid";
  return "ADE";
}

function stripTerminalCodes(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\[[0-9;]*m\]?/g, "")
    .trim();
}

function sessionModelLabel(session: AgentChatSessionSummary | null): string {
  const descriptor = session?.modelId ? getModelById(session.modelId) : undefined;
  if (descriptor) return descriptor.displayName;
  return stripTerminalCodes(session?.model ?? "") || "model";
}

function multiLine(value: unknown, maxLines = 18): string {
  if (typeof value === "string") return value.split(/\r?\n/).slice(0, maxLines).join("\n");
  return renderObject(value, maxLines);
}

function isMarkdownBoundary(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0
    || /^```/.test(trimmed)
    || /^#{1,6}\s+/.test(trimmed)
    || /^>\s?/.test(trimmed)
    || /^[-*+]\s+/.test(trimmed)
    || /^\d+[.)]\s+/.test(trimmed)
    || /^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)
  );
}

export function parseAssistantMarkdown(text: string): AssistantMarkdownBlock[] {
  const sourceLines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: AssistantMarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const value = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (value.length) blocks.push({ kind: "paragraph", text: value });
    paragraph = [];
  };

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed.length) {
      flushParagraph();
      continue;
    }

    const fence = /^```([\w.+-]*)\s*$/.exec(trimmed);
    if (fence) {
      flushParagraph();
      const codeLines: string[] = [];
      const language = fence[1]?.trim() || undefined;
      index += 1;
      for (; index < sourceLines.length; index += 1) {
        const codeLine = sourceLines[index] ?? "";
        if (/^```\s*$/.test(codeLine.trim())) break;
        codeLines.push(codeLine.replace(/\s+$/g, ""));
      }
      blocks.push({ kind: "code", ...(language ? { language } : {}), lines: codeLines });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2]?.trim() ?? "" });
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ kind: "hr" });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: "quote", text: quote[1]?.trim() ?? "" });
      continue;
    }

    const bullet = /^[-*+]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      blocks.push({ kind: "bullet", text: bullet[1]?.trim() ?? "" });
      continue;
    }

    const numbered = /^(\d+)[.)]\s+(.+)$/.exec(trimmed);
    if (numbered) {
      flushParagraph();
      blocks.push({ kind: "numbered", number: numbered[1] ?? "1", text: numbered[2]?.trim() ?? "" });
      continue;
    }

    if (paragraph.length && isMarkdownBoundary(sourceLines[index - 1] ?? "")) {
      flushParagraph();
    }
    paragraph.push(trimmed);
  }

  flushParagraph();
  if (!blocks.length && text.trim().length) {
    blocks.push({ kind: "paragraph", text: text.trim() });
  }
  return blocks;
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

  for (const entry of timeline) {
    if (entry.kind === "notice") {
      const notice = entry.notice;
      lines.push({
        id: notice.id,
        tone: notice.tone === "error" ? "error" : "notice",
        header: `ADE Code · ${timeLabel(notice.timestamp)}`,
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
        header: `you · ${timeLabel(envelope.timestamp)}`,
        body: event.displayText ?? event.text,
      });
      continue;
    }
    if (event.type === "text") {
      lines.push({
        id,
        tone: "assistant",
        header: `${providerEventLabel(args.activeSession?.provider)} · ${timeLabel(envelope.timestamp)} · ${sessionModelLabel(args.activeSession)}`,
        body: event.text,
        blocks: parseAssistantMarkdown(event.text),
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
      const preTokens = typeof event.preTokens === "number" ? ` · before ${event.preTokens.toLocaleString()} tokens` : "";
      lines.push({
        id,
        tone: "notice",
        body: `context compacted · ${event.trigger}${preTokens}`,
      });
      continue;
    }
    if (event.type === "system_notice") {
      lines.push({
        id,
        tone: "notice",
        header: `${providerEventLabel(args.activeSession?.provider)} · ${timeLabel(envelope.timestamp)}`,
        body: singleLine((event as { message?: unknown }).message, 160),
      });
    }
  }
  return coalesceLines(lines).slice(-(args.maxLines ?? 80));
}

function headerSpeakerKey(header: string | undefined): string {
  if (!header) return "";
  const first = header.split("·")[0];
  return first ? first.trim() : "";
}

function smartConcat(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  if (/\s$/.test(prev) || /^\s/.test(next)) return `${prev}${next}`;
  if (/\n$/.test(prev) || /^\n/.test(next)) return `${prev}${next}`;
  return `${prev} ${next}`;
}

function coalesceLines(lines: RenderedChatLine[]): RenderedChatLine[] {
  const out: RenderedChatLine[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (
      last
      && line.tone === "assistant"
      && last.tone === "assistant"
      && headerSpeakerKey(line.header) === headerSpeakerKey(last.header)
    ) {
      const body = smartConcat(last.body, line.body);
      out[out.length - 1] = { ...last, body, blocks: parseAssistantMarkdown(body) };
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
  const state = session.awaitingInput ? " ?" : session.status === "active" ? " ●" : "";
  return `${label}${state}`;
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
