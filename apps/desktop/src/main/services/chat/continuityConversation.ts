import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";

/**
 * The conversation a rebuilt provider thread is handed when the provider lost
 * the original one: every user message and every assistant reply, word for
 * word, in order. Tool work is kept as one short line per call (with a short
 * excerpt of its output), because the model needs to know what it already did,
 * not to re-read every log. A summary made of clipped snippets lost too much:
 * a replacement thread forgot decisions and repeated work.
 *
 * When the whole conversation does not fit `budgetBytes`, the first user
 * message (the task) and the latest one are kept, the newest entries fill the
 * rest, and one line marks each run of entries that was left out.
 */

const TOOL_ARGS_MAX_CHARS = 240;
const TOOL_OUTPUT_MAX_CHARS = 320;

/** `dialogue` is what was said; `work` is a tool step, kept only as room allows. */
type Entry = { text: string; kind: "dialogue" | "work"; fromUser?: boolean };

function clip(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isHostOnlyUserMessage(event: Extract<AgentChatEvent, { type: "user_message" }>): boolean {
  // An earlier recovery's own hand-off is not part of the conversation.
  return event.metadata?.kind === "continuity_recovery";
}

function userMessageText(event: Extract<AgentChatEvent, { type: "user_message" }>): string {
  // A message whose full prompt is hidden (a brief, a wake) is shown to the
  // user by its display text; that is also the right size here.
  if (event.metadata?.hideFullPrompt === true) return event.displayText?.trim() || "";
  return event.text.trim() || event.displayText?.trim() || "";
}

function isAdeAuthored(event: Extract<AgentChatEvent, { type: "user_message" }>): boolean {
  const metadata = event.metadata;
  if (!metadata) return false;
  return Boolean(
    metadata.hostContinuation
    || metadata.scheduledWake
    || metadata.prWatchWake
    || metadata.terminalWatchWake
    || metadata.spawnCompletion
    || metadata.agentRelay
    || metadata.usageLimitResume
    || metadata.automationRun
    || metadata.boardMove,
  );
}

/** Turns the transcript into one entry per user message, reply, or tool step. */
function conversationEntries(envelopes: readonly AgentChatEventEnvelope[]): Entry[] {
  const entries: Entry[] = [];
  let reply: { key: string; parts: string[] } | null = null;
  const flushReply = () => {
    const text = reply?.parts.join("").trim();
    if (text) entries.push({ text: `Assistant:\n${text}`, kind: "dialogue" });
    reply = null;
  };

  for (const { event } of envelopes) {
    if (event.type === "text") {
      // Text arrives as streamed pieces of one message.
      const key = `${event.turnId ?? ""}\0${event.messageId ?? event.itemId ?? ""}`;
      if (!reply || reply.key !== key) {
        flushReply();
        reply = { key, parts: [] };
      }
      reply.parts.push(event.text);
      continue;
    }
    if (event.type === "reasoning" || event.type === "context_usage" || event.type === "activity") continue;
    if (event.type === "user_message") {
      if (isHostOnlyUserMessage(event)) continue;
      const text = userMessageText(event);
      if (!text) continue;
      flushReply();
      const adeAuthored = isAdeAuthored(event);
      entries.push({
        text: adeAuthored ? `ADE (on the user's behalf):\n${text}` : `User:\n${text}`,
        kind: "dialogue",
        fromUser: !adeAuthored,
      });
      continue;
    }
    if (event.type === "tool_call") {
      flushReply();
      const args = clip(stringifyValue(event.args), TOOL_ARGS_MAX_CHARS);
      entries.push({ text: `[tool ${event.tool}] ${args}`, kind: "work" });
      continue;
    }
    if (event.type === "tool_result") {
      const output = clip(stringifyValue(event.result), TOOL_OUTPUT_MAX_CHARS);
      if (output) entries.push({ text: `[result${event.status === "failed" ? ", failed" : ""}] ${output}`, kind: "work" });
      continue;
    }
    if (event.type === "command") {
      if (event.status === "running") continue;
      flushReply();
      const exit = event.exitCode == null ? "" : ` (exit ${event.exitCode})`;
      const output = clip(event.output ?? "", TOOL_OUTPUT_MAX_CHARS);
      entries.push({ text: `[ran] ${clip(event.command, TOOL_ARGS_MAX_CHARS)}${exit}${output ? `\n${output}` : ""}`, kind: "work" });
      continue;
    }
    if (event.type === "file_change") {
      if (event.status === "running") continue;
      flushReply();
      entries.push({ text: `[${event.kind === "create" ? "created" : event.kind === "delete" ? "deleted" : "edited"}] ${event.path}`, kind: "work" });
      continue;
    }
    if (event.type === "plan") {
      flushReply();
      const steps = event.steps.map((step) => `- [${step.status}] ${step.text}`).join("\n");
      entries.push({ text: `[plan]${event.explanation ? ` ${event.explanation.trim()}` : ""}\n${steps}`, kind: "dialogue" });
      continue;
    }
    if (event.type === "error") {
      flushReply();
      entries.push({ text: `[error] ${clip(event.message, TOOL_OUTPUT_MAX_CHARS)}`, kind: "work" });
    }
  }
  flushReply();
  return entries;
}

export function formatContinuityConversation(
  envelopes: readonly AgentChatEventEnvelope[],
  budgetBytes: number,
): { text: string; omittedEntries: number } {
  const entries = conversationEntries(envelopes);
  const size = (entry: Entry) => Buffer.byteLength(entry.text, "utf8") + 2;
  const keep = new Array<boolean>(entries.length).fill(false);
  // Room for the "left out" marker lines between kept entries.
  let used = 16 * 1024;

  // The task (the first user message) and the user's latest message, which
  // the rebuilt thread is told to answer, are always kept.
  const userIndexes = entries.flatMap((entry, index) => (entry.fromUser ? [index] : []));
  for (const index of [userIndexes[0] ?? -1, userIndexes.at(-1) ?? -1]) {
    if (index < 0 || keep[index]) continue;
    keep[index] = true;
    used += size(entries[index]!);
  }
  // Then what was said, then tool steps, each newest first. An entry too big
  // for what is left is skipped, so one huge paste does not cost the rest.
  for (const kind of ["dialogue", "work"] as const) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (keep[index] || entry.kind !== kind) continue;
      if (used + size(entry) > budgetBytes) continue;
      keep[index] = true;
      used += size(entry);
    }
  }

  const parts: string[] = [];
  let skipped = 0;
  let omittedEntries = 0;
  const flushGap = () => {
    if (skipped > 0) parts.push(`[… ${skipped} older ${skipped === 1 ? "step" : "steps"} left out …]`);
    skipped = 0;
  };
  entries.forEach((entry, index) => {
    if (keep[index]) {
      flushGap();
      parts.push(entry.text);
    } else {
      skipped += 1;
      omittedEntries += 1;
    }
  });
  flushGap();
  return { text: parts.join("\n\n"), omittedEntries };
}
