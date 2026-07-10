import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";

const MAX_ENVELOPE_REPAIR_BYTES = 64 * 1024 * 1024;

export type ChatEnvelopeSpliceRepairResult = {
  changed: boolean;
  repairedTurns: number;
};

const NO_REPAIR: ChatEnvelopeSpliceRepairResult = { changed: false, repairedTurns: 0 };

type ParsedTextEnvelope = {
  envelope: AgentChatEventEnvelope;
  messageId: string;
  text: string;
  turnId: string;
};

type SdkAssistantMessage = {
  id: string;
  text: string;
  normalizedText: string;
};

function parseTextEnvelope(line: string): ParsedTextEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const envelope = parsed as AgentChatEventEnvelope;
  if (!envelope.event || envelope.event.type !== "text") return null;
  const turnId = envelope.event.turnId?.trim() ?? "";
  const messageId = envelope.event.messageId?.trim() ?? "";
  if (!turnId || !messageId || typeof envelope.event.text !== "string") return null;
  return { envelope, messageId, text: envelope.event.text, turnId };
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "");
}

function extractSdkMessageId(message: SessionMessage): string | null {
  const payload = message.message;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && id.trim().length ? id.trim() : null;
}

function extractSdkAssistantText(message: SessionMessage): string {
  const payload = message.message;
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const content = (payload as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const record = block as { type?: unknown; text?: unknown };
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("");
}

function sdkAssistantMessages(messages: SessionMessage[]): SdkAssistantMessage[] {
  return messages.flatMap((message) => {
    if (message.type !== "assistant") return [];
    const id = extractSdkMessageId(message);
    const text = extractSdkAssistantText(message);
    const normalizedText = normalizeText(text);
    return id && normalizedText ? [{ id, text, normalizedText }] : [];
  });
}

function findSdkMatch(
  runText: string,
  messages: SdkAssistantMessage[],
  startAt: number,
): { messages: SdkAssistantMessage[]; nextIndex: number } | null {
  const normalizedRun = normalizeText(runText);
  if (!normalizedRun) return null;

  for (let start = startAt; start < messages.length; start += 1) {
    let combined = "";
    for (let end = start; end < messages.length; end += 1) {
      combined = normalizeText(`${combined}${messages[end]!.normalizedText}`);
      // Only an EXACT match may rebuild. A superset match (SDK text merely
      // starting with the run) could splice content the ADE transcript never
      // showed into history; a partial match (SDK covering only a prefix of
      // the run) would drop the run's uncovered tail. Both fall back to the
      // caller's lossless local merge instead.
      if (combined === normalizedRun) {
        return { messages: messages.slice(start, end + 1), nextIndex: end + 1 };
      }
      if (normalizedRun.startsWith(combined)) continue;
      break;
    }
  }
  return null;
}

function rebuiltLine(
  first: AgentChatEventEnvelope,
  messageId: string,
  text: string,
  sequenceOffset = 0,
): string {
  const event = first.event.type === "text"
    ? { ...first.event, text, messageId }
    : first.event;
  const envelope: AgentChatEventEnvelope = {
    ...first,
    event,
    ...(typeof first.sequence === "number" ? { sequence: first.sequence + sequenceOffset } : {}),
  };
  return JSON.stringify(envelope);
}

/**
 * Repair the historical Claude stream-fragment splice signature in ADE JSONL.
 * Unknown/non-envelope lines and every non-text envelope are retained verbatim.
 */
export function repairSplicedEnvelopeLines(
  lines: string[],
  sdkMessages: SessionMessage[],
): { lines: string[]; changed: boolean; repairedTurns: number } {
  const assistants = sdkAssistantMessages(sdkMessages);
  const output: string[] = [];
  let sdkCursor = 0;
  const repairedTurnIds = new Set<string>();

  for (let index = 0; index < lines.length;) {
    const first = parseTextEnvelope(lines[index] ?? "");
    if (!first) {
      output.push(lines[index] ?? "");
      index += 1;
      continue;
    }

    const run: ParsedTextEnvelope[] = [first];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const next = parseTextEnvelope(lines[nextIndex] ?? "");
      if (!next || next.turnId !== first.turnId) break;
      run.push(next);
      nextIndex += 1;
    }

    const distinctIds = new Set(run.map((entry) => entry.messageId));
    const detected = run.length >= 3 && distinctIds.size === run.length;
    if (!detected) {
      output.push(...lines.slice(index, nextIndex));
      index = nextIndex;
      continue;
    }

    const runText = run.map((entry) => entry.text).join("");
    const sdkMatch = findSdkMatch(runText, assistants, sdkCursor);
    if (sdkMatch) {
      output.push(...sdkMatch.messages.map((message, offset) =>
        rebuiltLine(first.envelope, message.id, message.text, offset)));
      sdkCursor = sdkMatch.nextIndex;
    } else {
      output.push(rebuiltLine(first.envelope, first.messageId, runText));
    }
    repairedTurnIds.add(first.turnId);
    index = nextIndex;
  }

  const changed = output.length !== lines.length
    || output.some((line, index) => line !== lines[index]);

  return {
    lines: changed ? output : lines.slice(),
    changed,
    repairedTurns: changed ? repairedTurnIds.size : 0,
  };
}

/** Bounded, best-effort, atomic file wrapper. Never throws. */
export function repairSplicedEnvelopeFileSync(
  filePath: string,
  sdkMessages: SessionMessage[],
  options?: { onSkip?: (reason: "oversize" | "read_failed" | "write_failed", detail?: unknown) => void },
): ChatEnvelopeSpliceRepairResult {
  try {
    if (!filePath || !fs.existsSync(filePath)) return NO_REPAIR;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return NO_REPAIR;
    if (stat.size > MAX_ENVELOPE_REPAIR_BYTES) {
      options?.onSkip?.("oversize", stat.size);
      return NO_REPAIR;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const repaired = repairSplicedEnvelopeLines(raw.split("\n"), sdkMessages);
    if (!repaired.changed) return NO_REPAIR;

    const backupPath = `${filePath}.splice.bak`;
    if (!fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(filePath, backupPath);
      } catch {
        // Backup is best-effort; the atomic replacement remains safe.
      }
    }

    const tempPath = `${filePath}.splice-${process.pid}-${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, repaired.lines.join("\n"), "utf8");
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup failure.
      }
      options?.onSkip?.("write_failed", error);
      return NO_REPAIR;
    }
    return { changed: true, repairedTurns: repaired.repairedTurns };
  } catch (error) {
    options?.onSkip?.("read_failed", error);
    return NO_REPAIR;
  }
}
