import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatProvider,
  AgentChatReplayForkDisclosure,
} from "../../../shared/types/chat";
import { canonicalSteerRows, isDroppedSteerDeliveryState } from "../../../shared/chatTranscript";

/**
 * Cross-provider (and native-fork-unsupported) full-transcript replay.
 * The user rejected brief-style compression: this is a verbatim dump of the
 * ADE transcript, trimmed oldest-first only when it cannot fit the target
 * context window or provider input limit.
 */

export const CROSS_PROVIDER_REPLAY_HEADER =
  "Full prior transcript (verbatim replay; not a summary). Treat this as the conversation so far. Do not recap it unless asked.";

/**
 * Codex app-server rejects a `turn/start` request whose aggregate text input
 * exceeds 1,048,576 characters. Keep replay below that wire limit and leave
 * room for the next prompt and continuity context.
 */
export const CODEX_REPLAY_MAX_CHARS = 1_000_000;
export const CODEX_APP_SERVER_INPUT_MAX_CHARS = 1_048_576;

export function replayMaxCharsForProvider(
  provider: AgentChatProvider | null | undefined,
): number | undefined {
  return provider === "codex" ? CODEX_REPLAY_MAX_CHARS : undefined;
}

/**
 * Characters per token for mixed transcript text.
 *
 * A replay is code, diffs and JSON tool output, not English prose. Those run
 * about 2.5-3 characters per token, so the 4 this used to assume let a 1M-token
 * window accept ~3.9M characters — about 1.4M real tokens. Estimate low.
 */
export const REPLAY_CHARS_PER_TOKEN = 3;

/**
 * The replay is never the whole prompt. The system prompt, the tool
 * definitions, the ADE continuity context and the first user message all
 * arrive with it, and none of them are counted by the fit.
 */
export const REPLAY_RESERVE_MIN_TOKENS = 32_000;
const REPLAY_RESERVE_WINDOW_FRACTION = 0.15;

/** A replay never takes more than this share of the target context window. */
export const REPLAY_MAX_WINDOW_FRACTION = 0.6;

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** Conservative token estimate for already-rendered replay text. */
export function estimateReplayTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / REPLAY_CHARS_PER_TOKEN);
}

function normalizeContextWindow(contextWindowTokens: number | null | undefined): number {
  return Number.isFinite(contextWindowTokens) && (contextWindowTokens ?? 0) > 0
    ? Math.floor(contextWindowTokens as number)
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function replayReserveTokens(contextWindowTokens: number | null | undefined): number {
  const window = normalizeContextWindow(contextWindowTokens);
  return Math.max(
    REPLAY_RESERVE_MIN_TOKENS,
    Math.floor(window * REPLAY_RESERVE_WINDOW_FRACTION),
  );
}

/** Tokens the replay itself may occupy in the target context window. */
export function replayBudgetTokens(contextWindowTokens: number | null | undefined): number {
  const window = normalizeContextWindow(contextWindowTokens);
  const cap = Math.floor(window * REPLAY_MAX_WINDOW_FRACTION);
  const usable = Math.min(Math.max(0, window - replayReserveTokens(window)), cap);
  // A window smaller than the reserve still carries the newest turn or the
  // header; returning zero would strip a handoff of all of its history.
  return Math.max(Math.min(4_000, cap), usable);
}

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

  // A steer writes one row per lifecycle state (`queued`, `accepted`, then
  // `inline`, `processed`, or `delivered`). It is one user message, replayed
  // once where the model got it (see `canonicalSteerRows`). A steer that
  // settled without reaching the model (`failed`, Codex's `unprocessed`) is not
  // replayed: the new model would answer a message the old one never saw.
  const steerRows = canonicalSteerRows(envelopes);
  for (let index = 0; index < envelopes.length; index += 1) {
    let event = envelopes[index]!.event;
    if (!event) continue;
    if (event.type === "user_message") {
      const steerRow = steerRows.get(index);
      if (steerRow === null) continue;
      if (steerRow?.event.type === "user_message") {
        if (isDroppedSteerDeliveryState(steerRow.event.deliveryState)) continue;
        event = steerRow.event;
      }
    }
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

/**
 * What share of the target context window a rendered replay takes, as a whole
 * percent, or null when the window is unknown. Never rounds to 0: a replay that
 * reached the model occupies some of it.
 */
export function replayContextSharePercent(
  text: string,
  contextWindowTokens: number | null | undefined,
): number | null {
  if (!Number.isFinite(contextWindowTokens) || (contextWindowTokens ?? 0) <= 0) return null;
  const window = normalizeContextWindow(contextWindowTokens);
  return Math.max(1, Math.round((estimateReplayTokens(text) / window) * 100));
}

export function replayBudgetChars(contextWindowTokens: number | null | undefined): number {
  return replayBudgetTokens(contextWindowTokens) * REPLAY_CHARS_PER_TOKEN;
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
  /** Optional provider wire cap; the effective budget is the lower of both limits. */
  maxChars?: number,
): TranscriptReplayFit {
  const contextBudget = replayBudgetChars(contextWindowTokens);
  const budget = maxChars === undefined
    ? contextBudget
    : Math.min(contextBudget, maxChars);
  return fitTranscriptReplayToBudget(
    buildTranscriptReplayDocument(envelopes),
    budget,
  );
}

/**
 * Apply a final, dispatch-time cap to a previously-rendered replay. This is
 * needed when the next user turn or continuity context consumes part of the
 * Codex app-server's aggregate text-input budget. Keep the replay header and
 * newest available turn content whenever the earlier fit has to be reduced
 * again.
 */
export function fitTranscriptReplayTextToBudget(
  text: string,
  maxChars: number,
): string {
  const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (text.length <= budget) return text;
  if (budget === 0) return "";

  const headerOnlyReplay = buildTranscriptReplayDocument([]).text;
  if (text === headerOnlyReplay) {
    return CROSS_PROVIDER_REPLAY_HEADER.slice(0, budget);
  }

  const headerPrefix = `${CROSS_PROVIDER_REPLAY_HEADER}\n\n`;
  if (!text.startsWith(headerPrefix)) return text.slice(-budget);
  if (budget < headerPrefix.length) {
    return CROSS_PROVIDER_REPLAY_HEADER.slice(0, budget);
  }

  const bodyBudget = budget - headerPrefix.length;
  const body = text.slice(headerPrefix.length);
  const suffixStart = Math.max(0, body.length - bodyBudget);
  const newestTurnStart = body.indexOf("\n\n[user]\n", suffixStart);
  const suffix = newestTurnStart >= 0
    ? body.slice(newestTurnStart + 2)
    : body.slice(suffixStart);
  return `${headerPrefix}${suffix.length <= bodyBudget ? suffix : suffix.slice(-bodyBudget)}`;
}

export function toReplayForkDisclosure(fit: TranscriptReplayFit): AgentChatReplayForkDisclosure | undefined {
  if (!fit.truncated) return undefined;
  return {
    truncated: true,
    truncatedTurnCount: fit.truncatedTurnCount,
    keptTurnCount: fit.keptTurnCount,
  };
}
