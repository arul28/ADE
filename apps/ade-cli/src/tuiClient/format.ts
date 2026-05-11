import path from "node:path";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../desktop/src/shared/types/chat";
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
};

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

function multiLine(value: unknown, maxLines = 18): string {
  if (typeof value === "string") return value.split(/\r?\n/).slice(0, maxLines).join("\n");
  return renderObject(value, maxLines);
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
  for (const notice of args.notices) {
    lines.push({
      id: notice.id,
      tone: notice.tone === "error" ? "error" : "notice",
      header: `- ade code · ${timeLabel(notice.timestamp)} ${"-".repeat(20)}`,
      body: notice.text,
    });
  }
  for (const [index, envelope] of args.events.entries()) {
    const event = envelope.event;
    const id = chatEventLineId(envelope, index);
    const expanded = args.expandedLineIds?.has(id) ?? false;
    if (event.type === "user_message") {
      lines.push({
        id,
        tone: "user",
        header: `- you · ${timeLabel(envelope.timestamp)} ${"-".repeat(32)}`,
        body: event.displayText ?? event.text,
      });
      continue;
    }
    if (event.type === "text") {
      lines.push({
        id,
        tone: "assistant",
        header: `- ade · ${timeLabel(envelope.timestamp)} · ${args.activeSession?.model ?? "model"} ${"-".repeat(18)}`,
        body: event.text,
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
        body: `- context compacted · ${event.trigger}${preTokens} ${"-".repeat(24)}`,
      });
      continue;
    }
    if (event.type === "system_notice") {
      lines.push({
        id,
        tone: "notice",
        body: singleLine((event as { message?: unknown }).message, 160),
      });
    }
  }
  return lines.slice(-(args.maxLines ?? 80));
}

export function formatLaneLabel(lane: LaneSummary | null): string {
  if (!lane) return "no lane";
  const dirty = lane.status?.dirty ? "*" : "";
  const ahead = lane.status?.ahead ? ` ${lane.status.ahead}↑` : "";
  return `${lane.name}${dirty}${ahead}`;
}

export function formatSessionLabel(session: AgentChatSessionSummary): string {
  const label = (session.title ?? session.goal ?? session.summary ?? session.sessionId).trim();
  let state = "";
  if (session.awaitingInput) state = " ?";
  else if (session.status === "active") state = " ●";
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
  let files: unknown[] = [];
  if (Array.isArray(record.files)) files = record.files;
  else if (Array.isArray(record.changes)) files = record.changes;
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
