import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../../shared/types";
import {
  externalImportEnvelope,
  type ExternalChatHistoryImportOptions,
} from "../../chat/externalChatHistoryImport";
import { cleanExternalSessionUserText } from "../discoveryUtils";

export type JsonRecord = Record<string, unknown>;

/**
 * What a converter gets for one byte window of a JSONL store. `records[i]` is
 * line `i` of the window (`null` when it did not parse), `lineKeys[i]` is a key
 * for that line that stays the same across windows (its byte offset), and
 * `fallbackMs(i)` dates a record that carries no timestamp of its own.
 */
export type ConvertContext = {
  options: ExternalChatHistoryImportOptions;
  lineKeys: readonly string[];
  fallbackMs: (index: number) => number;
};

export type JsonlConverter = (records: readonly unknown[], ctx: ConvertContext) => AgentChatEventEnvelope[];

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value : null;
}

export function toIso(value: unknown, fallbackMs: number): string {
  if (typeof value === "string" && value.trim().length) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

export function maybeParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** Plain text of a string, a content block, or an array of blocks. */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(textOf).filter((part) => part.trim().length > 0).join("\n").trim();
  }
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return textOf(value.content);
  if (typeof value.output === "string") return value.output;
  return "";
}

/**
 * Builds envelopes for one converter run. Every envelope carries the import
 * provenance (lane, source session) exactly as `externalChatHistoryImport`
 * writes it.
 */
/**
 * Removes the indent every line of a prompt shares. A pasted or templated
 * prompt indented by four spaces rendered as one wide code block, because
 * Markdown reads that indent as code. Real code fences keep their content.
 */
export function dedentUserText(text: string): string {
  const lines = text.split("\n");
  let indent: number | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const width = line.length - line.trimStart().length;
    indent = indent == null ? width : Math.min(indent, width);
    if (indent === 0) return text;
  }
  if (!indent) return text;
  return lines.map((line) => line.slice(Math.min(indent!, line.length - line.trimStart().length))).join("\n");
}

export class EnvelopeSink {
  readonly out: AgentChatEventEnvelope[] = [];

  constructor(private readonly options: ExternalChatHistoryImportOptions) {}

  push(event: AgentChatEvent, timestamp: string, messageId?: string | null): void {
    this.out.push(externalImportEnvelope(event, this.options, timestamp, messageId));
  }

  user(rawText: string, timestamp: string, messageId: string): void {
    const text = dedentUserText(cleanExternalSessionUserText(rawText) ?? "");
    if (!text.trim().length) return;
    this.push({ type: "user_message", text, messageId }, timestamp, messageId);
  }

  text(text: string, timestamp: string, itemId: string, turnId?: string | null): void {
    if (!text.trim().length) return;
    this.push({ type: "text", text, itemId, ...(turnId ? { turnId } : {}) }, timestamp, itemId);
  }

  reasoning(text: string, timestamp: string, itemId: string, turnId?: string | null): void {
    if (!text.trim().length) return;
    this.push({ type: "reasoning", text, itemId, ...(turnId ? { turnId } : {}) }, timestamp, itemId);
  }

  toolCall(tool: string, args: unknown, timestamp: string, itemId: string, turnId?: string | null): void {
    this.push({ type: "tool_call", tool, args: args ?? {}, itemId, ...(turnId ? { turnId } : {}) }, timestamp, itemId);
  }

  toolResult(
    tool: string,
    result: unknown,
    timestamp: string,
    itemId: string,
    failed: boolean,
    turnId?: string | null,
  ): void {
    this.push({
      type: "tool_result",
      tool,
      result: result ?? "",
      itemId,
      status: failed ? "failed" : "completed",
      ...(turnId ? { turnId } : {}),
    }, timestamp, itemId);
  }
}
