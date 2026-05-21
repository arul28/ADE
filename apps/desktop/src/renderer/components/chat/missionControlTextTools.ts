import type { AgentChatEventEnvelope } from "../../../shared/types";

type RecoveredToolCall = {
  toolName: string;
  args: Record<string, unknown>;
  start: number;
  end: number;
};

const MISSION_CONTROL_TOOL_NAMES = new Set([
  "ask_user",
  "assign_task",
  "broadcast",
  "check_finalization_status",
  "complete_mission",
  "create_task",
  "delegate_parallel",
  "delegate_to_subagent",
  "fail_mission",
  "get_budget_status",
  "get_project_context",
  "get_worker_output",
  "insert_milestone",
  "list_tasks",
  "list_workers",
  "mark_step_complete",
  "mark_step_failed",
  "message_worker",
  "provision_lane",
  "read_file",
  "read_mission_state",
  "read_mission_status",
  "read_step_output",
  "reflection_add",
  "report_result",
  "report_status",
  "report_validation",
  "request_specialist",
  "request_user_input",
  "retry_step",
  "revise_plan",
  "search_files",
  "send_message",
  "set_current_phase",
  "skip_step",
  "spawn_worker",
  "stop_worker",
  "transfer_lane",
  "update_mission_state",
  "update_task",
  "update_tool_profiles",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeMissionControlToolName(value: string): string {
  let normalized = value.trim();
  normalized = normalized.replace(/^ade[_:.]/i, "");
  return normalized.trim();
}

export function isMissionControlToolName(value: string): boolean {
  return MISSION_CONTROL_TOOL_NAMES.has(normalizeMissionControlToolName(value));
}

function parseJsonWithoutLineComments(value: string): unknown {
  const body = value
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .trim();
  if (!body.length) return null;
  return JSON.parse(body);
}

function callsFromParsedToolBlock(
  toolName: string,
  parsed: unknown,
  start: number,
  end: number,
): RecoveredToolCall[] {
  const normalizedToolName = normalizeMissionControlToolName(toolName);
  if (/^(?:multi_tool_use\.)?parallel$/i.test(normalizedToolName)) {
    const entries = Array.isArray(parsed) ? parsed : [];
    return entries.flatMap((entry) => {
      const raw = asRecord(entry);
      const name = typeof raw?.name === "string"
        ? raw.name
        : typeof raw?.recipient_name === "string"
        ? raw.recipient_name
          : "";
      const args = asRecord(raw?.arguments ?? raw?.parameters ?? raw?.args) ?? {};
      const normalizedName = normalizeMissionControlToolName(name);
      return normalizedName && isMissionControlToolName(normalizedName)
        ? [{ toolName: normalizedName, args, start, end }]
        : [];
    });
  }

  const parsedRecord = asRecord(parsed);
  if (normalizedToolName && parsedRecord && isMissionControlToolName(normalizedToolName)) {
    return [{ toolName: normalizedToolName, args: parsedRecord, start, end }];
  }

  const embeddedName = typeof parsedRecord?.name === "string"
    ? parsedRecord.name
    : typeof parsedRecord?.recipient_name === "string"
      ? parsedRecord.recipient_name
      : "";
  const args = asRecord(parsedRecord?.arguments ?? parsedRecord?.parameters ?? parsedRecord?.args) ?? null;
  const normalizedEmbeddedName = normalizeMissionControlToolName(embeddedName);
  if (normalizedEmbeddedName && args && isMissionControlToolName(normalizedEmbeddedName)) {
    return [{ toolName: normalizedEmbeddedName, args, start, end }];
  }

  return [];
}

function findBalancedJson(value: string, startIndex: number): { json: string; end: number } | null {
  const jsonStart = value.slice(startIndex).search(/[\[{]/);
  if (jsonStart < 0) return null;
  const start = startIndex + jsonStart;
  const opener = value[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === opener) {
      depth += 1;
    } else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return { json: value.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

export function extractMissionControlTextToolCalls(text: string): RecoveredToolCall[] {
  const calls: RecoveredToolCall[] = [];
  const fencePattern = /```(?:json|js|javascript)?\s*\n([\s\S]*?)```/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fencePattern.exec(text)) !== null) {
    const body = fenceMatch[1]?.trim() ?? "";
    if (!body) continue;
    const label = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("//"))
      ?.replace(/^\/\/\s*/, "")
      .trim() ?? "";
    if (!label) continue;
    try {
      const parsed = parseJsonWithoutLineComments(body);
      calls.push(...callsFromParsedToolBlock(label, parsed, fenceMatch.index, fencePattern.lastIndex));
    } catch {
      // Ignore malformed provider text; the original message will remain visible.
    }
  }

  if (calls.length > 0) return calls;

  const linePattern = /\/\/\s*([A-Za-z0-9_.:-]+)\s*\n/g;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = linePattern.exec(text)) !== null) {
    const label = lineMatch[1] ?? "";
    if (!isMissionControlToolName(label) && !/^(?:multi_tool_use\.)?parallel$/i.test(label)) continue;
    const parsedJson = findBalancedJson(text, linePattern.lastIndex);
    if (!parsedJson) continue;
    try {
      const parsed = JSON.parse(parsedJson.json);
      calls.push(...callsFromParsedToolBlock(label, parsed, lineMatch.index, parsedJson.end));
      linePattern.lastIndex = parsedJson.end;
    } catch {
      // Leave malformed text untouched.
    }
  }

  return calls;
}

function removeRanges(value: string, ranges: Array<{ start: number; end: number }>): string {
  if (!ranges.length) return value;
  const merged = [...ranges]
    .sort((a, b) => a.start - b.start)
    .reduce<Array<{ start: number; end: number }>>((acc, range) => {
      const last = acc[acc.length - 1];
      if (!last || range.start > last.end) {
        acc.push({ ...range });
      } else {
        last.end = Math.max(last.end, range.end);
      }
      return acc;
    }, []);
  let output = "";
  let cursor = 0;
  for (const range of merged) {
    output += value.slice(cursor, range.start);
    cursor = range.end;
  }
  output += value.slice(cursor);
  return output.replace(/\n{3,}/g, "\n\n").trim();
}

export function rewriteMissionControlTextToolEvents(
  events: AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  const rewritten: AgentChatEventEnvelope[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const envelope = events[index]!;
    if (envelope.event.type !== "text") {
      rewritten.push(envelope);
      continue;
    }

    const textEvent = envelope.event;
    const group = [envelope];
    let combinedText = textEvent.text;
    let cursor = index + 1;
    while (textEvent.turnId && cursor < events.length) {
      const candidate = events[cursor]!;
      if (candidate.event.type !== "text") break;
      if (candidate.event.turnId !== textEvent.turnId) break;
      if (candidate.event.runtime !== textEvent.runtime) break;
      group.push(candidate);
      combinedText += candidate.event.text;
      cursor += 1;
    }

    const calls = extractMissionControlTextToolCalls(combinedText);
    if (!calls.length) {
      rewritten.push(...group);
      index = cursor - 1;
      continue;
    }

    const remainingText = removeRanges(combinedText, calls);
    if (remainingText.length > 0) {
      rewritten.push({
        ...envelope,
        event: {
          ...textEvent,
          text: remainingText,
        },
      });
    }

    calls.forEach((call, index) => {
      const sourceItemId = textEvent.itemId ?? textEvent.messageId ?? `${envelope.timestamp}:${index}`;
      rewritten.push({
        ...envelope,
        event: {
          type: "tool_call",
          tool: call.toolName,
          args: call.args,
          itemId: `mission-control-text:${sourceItemId}:${index}`,
          ...(textEvent.turnId ? { turnId: textEvent.turnId } : {}),
          ...(textEvent.runtime ? { runtime: textEvent.runtime } : {}),
        },
      });
    });
    index = cursor - 1;
  }

  return rewritten;
}
