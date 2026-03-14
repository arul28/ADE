import type { AgentChatEvent, AgentChatEventEnvelope } from "./types";

const MATERIAL_WORKER_EVENT_TYPES = new Set<AgentChatEvent["type"]>([
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "command",
  "file_change",
]);

function compactText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function readSummaryCandidate(event: AgentChatEvent): string | null {
  switch (event.type) {
    case "text":
    case "reasoning":
      return typeof event.text === "string" ? event.text : null;
    case "error":
      return typeof event.message === "string" ? event.message : null;
    case "status":
      return typeof event.message === "string" ? event.message : null;
    default:
      return null;
  }
}

export function parseAgentChatTranscript(raw: string): AgentChatEventEnvelope[] {
  const events: AgentChatEventEnvelope[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.length) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<AgentChatEventEnvelope>;
      const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
      const timestamp = typeof parsed.timestamp === "string" && parsed.timestamp.trim().length > 0
        ? parsed.timestamp
        : new Date().toISOString();
      const event = parsed.event;
      if (!sessionId || !event || typeof event !== "object") continue;
      events.push({
        sessionId,
        timestamp,
        event: event as AgentChatEvent,
        provenance:
          parsed.provenance && typeof parsed.provenance === "object" && !Array.isArray(parsed.provenance)
            ? parsed.provenance as AgentChatEventEnvelope["provenance"]
            : undefined,
      });
    } catch {
      // Ignore malformed transcript lines.
    }
  }
  return events;
}

export function hasMaterialWorkerChatEvent(events: AgentChatEventEnvelope[]): boolean {
  return events.some((entry) => MATERIAL_WORKER_EVENT_TYPES.has(entry.event.type));
}

export function hasWorkerChatLifecycleEvent(events: AgentChatEventEnvelope[]): boolean {
  return events.some((entry) => entry.event.type !== "user_message");
}

export function deriveAgentChatTranscriptSummary(
  events: AgentChatEventEnvelope[],
  maxChars = 280,
): string | null {
  const candidates = events
    .map((entry) => readSummaryCandidate(entry.event))
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (!candidates.length) return null;
  return compactText(candidates[candidates.length - 1]!, maxChars);
}
