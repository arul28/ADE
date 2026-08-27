// A cloud run's conversation: read the stream, fold it into turns, dedupe it
// against what ADE already holds, and decide when to look again.
//
// Ported from `apps/desktop/src/main/services/chat/cursorCloudConversation.ts`.
// The fingerprint rules and the backoff ladder are kept EXACTLY as core had
// them: a chat that was hydrated by the built-in path and is then re-read by
// this plugin must not double every message.
//
// The SDK's own `run.conversation()` consumes the same stream and accumulates
// the same turns, so this is the SDK's shape with the SDK's 26 MB removed.

"use strict";

/** Attempts and gap for a hydrate that raced the run's own first bytes. */
const CONVERSATION_RETRY_ATTEMPTS = 8;
const CONVERSATION_RETRY_MS = 2_000;

/**
 * Presence-gated poll ladder. Cursor has no webhook on create, so the plugin
 * reads the stream only while somebody is looking at that chat. Fresh activity
 * resets to the floor; a quiet chat stretches out.
 */
const MIRROR_BACKOFF_MS = [3_000, 8_000, 20_000, 45_000];

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readTextField(value) {
  if (typeof value === "string") return value.trim();
  const record = asRecord(value);
  return typeof record?.text === "string" ? record.text.trim() : "";
}

const WRAPPED_TURN_KEYS = ["turns", "messages", "conversation", "content", "items", "result"];

const LONE_TURN_TYPES = new Set([
  "agent",
  "shell",
  "agentConversationTurn",
  "shellConversationTurn",
]);

/**
 * Find the turn array inside whatever shape answered.
 *
 * Tolerant on purpose: ADE has seen bare arrays, `{turns}`, `{result: {items}}`
 * and a lone turn object, and a hydrate that returns nothing because the
 * envelope moved is indistinguishable to the reader from a conversation that
 * is empty.
 */
function flattenConversationMessages(conversation) {
  if (!conversation) return [];
  if (Array.isArray(conversation)) return conversation;
  const record = asRecord(conversation);
  if (!record) return [];
  if (typeof record.type === "string" && LONE_TURN_TYPES.has(record.type)) return [conversation];
  for (const key of WRAPPED_TURN_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    const nested = asRecord(value);
    if (!nested) continue;
    for (const innerKey of WRAPPED_TURN_KEYS) {
      const inner = nested[innerKey];
      if (Array.isArray(inner)) return inner;
    }
  }
  return [];
}

/** One turn, reduced to the two shapes ADE renders. `null` for anything else. */
function unwrapConversationTurn(raw) {
  const wrapper = asRecord(raw);
  if (!wrapper) return null;
  const type = typeof wrapper.type === "string" ? wrapper.type : "";
  const payload = asRecord(wrapper.turn) ?? wrapper;

  if (type === "shellConversationTurn" || type === "shell") {
    const commandRecord = asRecord(payload.shellCommand) ?? asRecord(payload.command) ?? payload;
    const outputRecord = asRecord(payload.shellOutput) ?? asRecord(payload.output);
    const command = typeof commandRecord.command === "string" ? commandRecord.command.trim() : "";
    if (!command) return null;
    return {
      kind: "shell",
      command,
      cwd: typeof commandRecord.workingDirectory === "string" ? commandRecord.workingDirectory : null,
      stdout: typeof outputRecord?.stdout === "string" ? outputRecord.stdout : "",
      stderr: typeof outputRecord?.stderr === "string" ? outputRecord.stderr : "",
      exitCode: typeof outputRecord?.exitCode === "number" ? outputRecord.exitCode : null,
    };
  }

  if (
    type === "agentConversationTurn"
    || type === "agent"
    || Array.isArray(payload.steps)
    || payload.userMessage != null
  ) {
    return {
      kind: "agent",
      userText: readTextField(payload.userMessage),
      steps: Array.isArray(payload.steps) ? payload.steps : [],
    };
  }
  return null;
}

/** The dedupe key for one turn, or `null` when it has nothing to compare. */
function turnFingerprint(turn) {
  if (turn.kind === "shell") return turn.command ? `shell:${turn.command}` : null;
  if (turn.userText) return `user:${turn.userText}`;
  for (const rawStep of turn.steps) {
    const step = asRecord(rawStep);
    if (!step) continue;
    if (step.type !== "assistantMessage") continue;
    const text = readTextField(step.message);
    if (text) return `text:${text}`;
  }
  return null;
}

/**
 * Suffix-tolerant match, because a streamed reply ADE already holds may be a
 * prefix or a suffix of the finished text the API later returns.
 */
function fingerprintAlreadyHydrated(fingerprints, candidate) {
  if (fingerprints.has(candidate)) return true;
  const separator = candidate.indexOf(":");
  if (separator < 0) return false;
  const kind = candidate.slice(0, separator);
  const value = candidate.slice(separator + 1);
  if (!value) return false;
  for (const existing of fingerprints) {
    if (!existing.startsWith(`${kind}:`)) continue;
    const known = existing.slice(kind.length + 1);
    if (value === known || value.endsWith(known) || known.endsWith(value)) return true;
  }
  return false;
}

function stepHasVisibleContent(rawStep) {
  const step = asRecord(rawStep);
  if (!step) return false;
  const stepType = typeof step.type === "string" ? step.type : "";
  if (stepType === "assistantMessage" || stepType === "thinkingMessage" || stepType === "thinking") {
    return Boolean(readTextField(step.message));
  }
  return stepType === "toolCall";
}

function conversationHasTurns(conversation) {
  return flattenConversationMessages(conversation).some((raw) => {
    const turn = unwrapConversationTurn(raw);
    if (!turn) return false;
    if (turn.kind === "shell") return Boolean(turn.command);
    return Boolean(turn.userText) || turn.steps.some(stepHasVisibleContent);
  });
}

function isRunStillLive(status) {
  if (!status) return false;
  const lower = String(status).toLowerCase();
  return lower === "creating" || lower === "running" || lower === "queued";
}

/**
 * Where the ladder goes next.
 *
 * `new` resets to the floor (something happened, look again soon), `unchanged`
 * steps out one rung, and `skipped` holds — a poll that never ran must not
 * spend a rung.
 */
function nextMirrorDelay(currentDelayMs, result) {
  const floor = MIRROR_BACKOFF_MS[0];
  if (result === "new") return floor;
  if (result === "skipped") return currentDelayMs && currentDelayMs > 0 ? currentDelayMs : floor;
  if (currentDelayMs == null || currentDelayMs <= 0) return floor;
  const index = MIRROR_BACKOFF_MS.indexOf(currentDelayMs);
  if (index < 0) return MIRROR_BACKOFF_MS[1] ?? floor;
  return MIRROR_BACKOFF_MS[Math.min(index + 1, MIRROR_BACKOFF_MS.length - 1)];
}

/* ── The stream ─────────────────────────────────────────────────────────── */

/**
 * Parse a server-sent-event body into its `data:` payloads.
 *
 * Written against a whole body rather than a live socket because that is what
 * a mirror read is: the plugin asks for the run's events, folds them, and
 * closes. A live tail is the same parser over a reader; `readEventStream`
 * below is the one that streams.
 */
function parseEventStream(text) {
  const events = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let id = null;
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") dataLines.push(value);
      else if (field === "id") id = value;
    }
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") continue;
    try {
      events.push({ id, message: JSON.parse(payload) });
    } catch {
      // A frame this build cannot read is one frame, not a broken transcript.
    }
  }
  return events;
}

/**
 * Fold the run's messages into `ConversationTurn`s — the shape
 * `unwrapConversationTurn` above already speaks.
 *
 * One agent turn per user message, with every assistant, thinking and tool
 * step that followed it attached; a `tool_call` naming a shell becomes its own
 * shell turn, which is how the built-in transcript drew it.
 */
function conversationFromStreamMessages(messages) {
  const turns = [];
  let current = null;

  const openAgentTurn = (userText) => {
    current = { type: "agentConversationTurn", turn: { userMessage: { text: userText }, steps: [] } };
    turns.push(current);
    return current;
  };

  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    switch (message.type) {
      case "user": {
        const parts = Array.isArray(message.message?.content) ? message.message.content : [];
        const text = parts
          .filter((part) => asRecord(part)?.type === "text")
          .map((part) => String(part.text ?? ""))
          .join("")
          .trim();
        openAgentTurn(text);
        break;
      }
      case "assistant": {
        const parts = Array.isArray(message.message?.content) ? message.message.content : [];
        const text = parts
          .filter((part) => asRecord(part)?.type === "text")
          .map((part) => String(part.text ?? ""))
          .join("")
          .trim();
        if (!text) break;
        if (!current) openAgentTurn("");
        current.turn.steps.push({ type: "assistantMessage", message: { text } });
        break;
      }
      case "thinking": {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (!text) break;
        if (!current) openAgentTurn("");
        current.turn.steps.push({ type: "thinkingMessage", message: { text } });
        break;
      }
      case "tool_call": {
        const name = typeof message.name === "string" ? message.name : "";
        const args = asRecord(message.args);
        const command = typeof args?.command === "string" ? args.command.trim() : "";
        if (command) {
          const result = asRecord(message.result);
          turns.push({
            type: "shellConversationTurn",
            turn: {
              shellCommand: {
                command,
                ...(typeof args.workingDirectory === "string"
                  ? { workingDirectory: args.workingDirectory }
                  : {}),
              },
              shellOutput: {
                stdout: typeof result?.stdout === "string" ? result.stdout : "",
                stderr: typeof result?.stderr === "string" ? result.stderr : "",
                exitCode: typeof result?.exitCode === "number" ? result.exitCode : 0,
              },
            },
          });
          // A shell turn ends the agent turn's run of steps, exactly as the
          // built-in transcript interleaved them.
          current = null;
          break;
        }
        if (!name) break;
        if (!current) openAgentTurn("");
        current.turn.steps.push({ type: "toolCall", name });
        break;
      }
      default:
        break;
    }
  }
  return turns;
}

/** The latest status the stream reported, or `null` when it reported none. */
function statusFromStreamMessages(messages) {
  let status = null;
  for (const raw of messages) {
    const message = asRecord(raw);
    if (message?.type === "status" && typeof message.status === "string") status = message.status;
  }
  return status;
}

/**
 * Turn a stream `Response` into `{messages, lastEventId}`.
 *
 * Reads the whole body: a mirror read is bounded by the run it is reading, and
 * the caller closes the response when it has what it came for.
 */
async function readEventStream(response) {
  const text = await response.text();
  const events = parseEventStream(text);
  let lastEventId = null;
  for (const event of events) if (event.id) lastEventId = event.id;
  return { messages: events.map((event) => event.message), lastEventId };
}

/**
 * Everything a hydrate needs from one run, in one shape.
 *
 * `transcript` is already in `ade.chat.hydrate` order — oldest first — and
 * `fingerprint` is on every entry, so the host's own suffix-tolerant dedupe
 * does the work a second read would otherwise duplicate.
 */
function transcriptFromTurns(turns) {
  const entries = [];
  for (const raw of turns) {
    const turn = unwrapConversationTurn(raw);
    if (!turn) continue;
    if (turn.kind === "shell") {
      const fingerprint = turnFingerprint(turn);
      entries.push({
        role: "assistant",
        parts: [{ kind: "tool", name: "shell", detail: turn.command }],
        ...(fingerprint ? { fingerprint } : {}),
      });
      continue;
    }
    if (turn.userText) {
      entries.push({ role: "user", text: turn.userText, fingerprint: `user:${turn.userText}` });
    }
    const parts = [];
    let firstText = "";
    for (const rawStep of turn.steps) {
      const step = asRecord(rawStep);
      if (!step) continue;
      if (step.type === "assistantMessage") {
        const text = readTextField(step.message);
        if (!text) continue;
        if (!firstText) firstText = text;
        parts.push({ kind: "text", text });
      } else if (step.type === "thinkingMessage" || step.type === "thinking") {
        const text = readTextField(step.message);
        if (text) parts.push({ kind: "thinking", text });
      } else if (step.type === "toolCall") {
        const name = typeof step.name === "string" ? step.name : "tool";
        parts.push({ kind: "tool", name });
      }
    }
    if (parts.length) {
      entries.push({
        role: "assistant",
        parts,
        ...(firstText ? { fingerprint: `text:${firstText}` } : {}),
      });
    }
  }
  return entries;
}

module.exports = {
  CONVERSATION_RETRY_ATTEMPTS,
  CONVERSATION_RETRY_MS,
  MIRROR_BACKOFF_MS,
  conversationFromStreamMessages,
  conversationHasTurns,
  fingerprintAlreadyHydrated,
  flattenConversationMessages,
  isRunStillLive,
  nextMirrorDelay,
  parseEventStream,
  readEventStream,
  readTextField,
  statusFromStreamMessages,
  transcriptFromTurns,
  turnFingerprint,
  unwrapConversationTurn,
};
