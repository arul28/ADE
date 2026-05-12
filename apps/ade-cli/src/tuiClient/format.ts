import path from "node:path";
import { getModelById } from "../../../desktop/src/shared/modelRegistry";
import type { AgentChatEventEnvelope, AgentChatProvider, AgentChatSessionSummary } from "../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import { glyphFor } from "./theme";
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
      const statusGlyph = event.status === "running" ? "…" : event.status === "failed" ? "x" : "✓";
      const head = `${statusGlyph} web ${singleLine(event.query, 96)}`;
      const actionLines = event.actions?.length
        ? event.actions.map((action) => {
          const kind = action.type || "action";
          const detail = action.title ?? action.url ?? action.query ?? "";
          return `   ${kind.padEnd(12, " ")} ${singleLine(detail, 96)}`.trimEnd();
        })
        : event.action ? [`   ${event.action}`] : [];
      lines.push({
        id,
        tone: event.status === "failed" ? "error" : "tool",
        body: actionLines.length ? `${head}\n${actionLines.join("\n")}` : head,
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
        body: `${event.status === "running" ? "…" : event.status === "failed" ? "x" : "✓"} ${isGeneration ? "image generated" : "image"}  ${singleLine(title, 120)}`,
      });
      continue;
    }
    // codex_goal_updated / codex_goal_cleared: rendered as amber banner above
    // chat by app.tsx — suppress here. codex_token_usage: rendered in
    // ContextMeter footer — suppress here too.
    if (event.type === "codex_goal_updated" || event.type === "codex_goal_cleared") {
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
    if (event.type === "status") {
      const tone = event.turnStatus === "failed"
        ? "error" as const
        : event.turnStatus === "interrupted" ? "error" as const : "notice" as const;
      lines.push({ id, tone, body: `[status] ${event.turnStatus}${event.message ? ` · ${singleLine(event.message, 120)}` : ""}` });
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
      // Surface severity-bearing notices with an error tone while keeping
      // non-blocking telemetry, including allowed Claude rate-limit events,
      // in the normal notice channel.
      const noticeKind = (event as { noticeKind?: string }).noticeKind;
      const severity = (event as { severity?: string }).severity;
      const tone: "notice" | "error" = severity === "error"
        || (!severity && (
          noticeKind === "error"
          || noticeKind === "thread_error"
          || noticeKind === "provider_health"
          || noticeKind === "rate_limit"
        ))
        ? "error"
        : "notice";
      lines.push({
        id,
        tone,
        header: `${providerEventLabel(args.activeSession?.provider)} · ${timeLabel(envelope.timestamp)}`,
        body: singleLine((event as { message?: unknown }).message, 160),
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
