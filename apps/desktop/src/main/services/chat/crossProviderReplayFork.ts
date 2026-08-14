import type { AgentChatEvent, AgentChatEventEnvelope, AgentChatReplayForkDisclosure } from "../../../shared/types/chat";

/**
 * Cross-provider (and native-fork-unsupported) full-transcript replay.
 * The user rejected brief-style compression: this is a verbatim dump of the
 * ADE transcript, trimmed oldest-first only when it cannot fit the target
 * context window.
 */

export const CROSS_PROVIDER_REPLAY_HEADER =
  "Full prior transcript (verbatim replay; not a summary). Treat this as the conversation so far. Do not recap it unless asked.";

const CHARS_PER_TOKEN = 4;
/** Leave room for the next user turn, system prompt, and tool payloads. */
const CONTEXT_RESERVE_TOKENS = 8_000;

export type TranscriptReplayTurn = {
  text: string;
};

export type TranscriptReplayDocument = {
  header: string;
  turns: TranscriptReplayTurn[];
  turnCount: number;
  text: string;
};

export type TranscriptReplayFit = {
  text: string;
  turnCount: number;
  keptTurnCount: number;
  truncatedTurnCount: number;
  truncated: boolean;
};

/**
 * `trim()` is only ever used to decide whether a value is empty — the rendered
 * value stays byte-for-byte identical to the source, because a replay that
 * reshapes whitespace is no longer verbatim.
 */
function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.trim() ? value : null;
}

function eventText(event: AgentChatEvent): string | null {
  switch (event.type) {
    case "user_message":
      return nonEmpty(event.displayText) ?? nonEmpty(event.text);
    case "text":
      return nonEmpty(event.text);
    case "tool_result": {
      const name = nonEmpty(event.tool) ?? "tool";
      const result = typeof event.result === "string"
        ? nonEmpty(event.result)
        : event.result == null
          ? null
          : (() => {
            try {
              return nonEmpty(JSON.stringify(event.result));
            } catch {
              return nonEmpty(String(event.result));
            }
          })();
      if (!result) return `[tool result: ${name}]`;
      return `[tool result: ${name}]\n${result}`;
    }
    case "command": {
      const output = nonEmpty(event.output);
      const command = nonEmpty(event.command) ?? "command";
      return output ? `[command: ${command}]\n${output}` : `[command: ${command}]`;
    }
    case "error": {
      const message = nonEmpty(event.message);
      return message ? `[error]\n${message}` : null;
    }
    default:
      return null;
  }
}

function roleLabel(event: AgentChatEvent): "user" | "assistant" | "tool" {
  switch (event.type) {
    case "user_message":
      return "user";
    case "tool_result":
    case "command":
      return "tool";
    default:
      return "assistant";
  }
}

export function buildTranscriptReplayDocument(
  envelopes: readonly AgentChatEventEnvelope[],
): TranscriptReplayDocument {
  const turns: TranscriptReplayTurn[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (!current.length) return;
    turns.push({ text: current.join("\n") });
    current = [];
  };

  for (const envelope of envelopes) {
    const event = envelope.event;
    if (!event) continue;
    const body = eventText(event);
    if (!body) continue;
    if (event.type === "user_message") flush();
    current.push(`[${roleLabel(event)}]\n${body}`);
  }
  flush();

  const text = renderReplayDocument(CROSS_PROVIDER_REPLAY_HEADER, turns);
  return {
    header: CROSS_PROVIDER_REPLAY_HEADER,
    turns,
    turnCount: turns.length,
    text,
  };
}

function renderReplayDocument(header: string, turns: readonly TranscriptReplayTurn[]): string {
  if (!turns.length) return header;
  return `${header}\n\n${turns.map((turn) => turn.text).join("\n\n")}`;
}

export function replayBudgetChars(contextWindowTokens: number | null | undefined): number {
  const window = Number.isFinite(contextWindowTokens) && (contextWindowTokens ?? 0) > 0
    ? Math.floor(contextWindowTokens as number)
    : 128_000;
  const usableTokens = Math.max(4_000, window - CONTEXT_RESERVE_TOKENS);
  return usableTokens * CHARS_PER_TOKEN;
}

export function fitTranscriptReplayToBudget(
  document: TranscriptReplayDocument,
  maxChars: number,
): TranscriptReplayFit {
  const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (document.text.length <= budget) {
    return {
      text: document.text,
      turnCount: document.turnCount,
      keptTurnCount: document.turnCount,
      truncatedTurnCount: 0,
      truncated: false,
    };
  }

  // Newest-first, and a turn is retained only when the rendered replay actually
  // fits: the newest turn can be larger than the whole budget on its own, and
  // sending it anyway would overflow the target context window.
  const kept: TranscriptReplayTurn[] = [];
  for (let index = document.turns.length - 1; index >= 0; index -= 1) {
    const turn = document.turns[index]!;
    if (renderReplayDocument(document.header, [turn, ...kept]).length > budget) break;
    kept.unshift(turn);
  }

  // With no turns retained the header alone is the bounded representation; when
  // even that does not fit there is nothing safe left to prefix.
  const text = kept.length
    ? renderReplayDocument(document.header, kept)
    : document.header.length <= budget
      ? document.header
      : "";
  const keptTurnCount = kept.length;
  const truncatedTurnCount = Math.max(0, document.turnCount - keptTurnCount);
  return {
    text,
    turnCount: document.turnCount,
    keptTurnCount,
    truncatedTurnCount,
    truncated: text !== document.text,
  };
}

export function buildFittedTranscriptReplay(
  envelopes: readonly AgentChatEventEnvelope[],
  contextWindowTokens: number | null | undefined,
): TranscriptReplayFit {
  return fitTranscriptReplayToBudget(
    buildTranscriptReplayDocument(envelopes),
    replayBudgetChars(contextWindowTokens),
  );
}

export function toReplayForkDisclosure(fit: TranscriptReplayFit): AgentChatReplayForkDisclosure | undefined {
  if (!fit.truncated) return undefined;
  return {
    truncated: true,
    truncatedTurnCount: fit.truncatedTurnCount,
    keptTurnCount: fit.keptTurnCount,
  };
}
