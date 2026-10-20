import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logging/logger";

/**
 * ADE's own "next prompt" suggestion, for providers that do not send one.
 *
 * Claude Code suggests the next prompt natively (`promptSuggestions` on the
 * SDK query, forwarded as a `prompt_suggestion` event). Every other provider
 * gets one from ADE when the project turns it on for this machine
 * (`ai.chat.promptSuggestionsEnabled` in `.ade/local.yaml`): after a turn
 * completes, one call to the same model ADE names chats with — the cheap
 * helper for Codex and Cursor, the chat's own model for everything else, at
 * the lowest effort the model offers. The answer goes out as the same
 * live-only `prompt_suggestion` event, so every client shows it the same way.
 */

/** A suggestion is a convenience: past this, the user is already typing. */
const SUGGESTION_TIMEOUT_MS = 15_000;
const RECENT_USER_MESSAGES = 4;
const MAX_USER_MESSAGE_CHARS = 1_500;
const MAX_REPLY_CHARS = 6_000;
/** One short line in the composer, not a paragraph. */
export const MAX_PROMPT_SUGGESTION_CHARS = 120;

export const PROMPT_SUGGESTION_SYSTEM_PROMPT = `Predict the next message the user will send to their coding agent.

Return a JSON object with one key: suggestion.

Rules:
- Write it as the user, in their voice and phrasing style, addressed to the agent.
- Pick the single most likely next step given where the agent left off: answering a question it asked, approving a proposed plan, asking for the obvious follow-up, or asking it to verify, commit, or open a PR.
- One short sentence on one line, at most ${MAX_PROMPT_SUGGESTION_CHARS} characters. No quotes, no markdown, no preamble.
- If the agent asked the user to choose between options, pick the one the user most likely wants.
- Return an empty string if there is no clear next step.`;

export const PROMPT_SUGGESTION_JSON_SCHEMA = {
  type: "object",
  properties: { suggestion: { type: "string" } },
  required: ["suggestion"],
  additionalProperties: false,
} as const;

function clip(text: string, chars: number, keep: "head" | "tail"): string {
  const trimmed = text.trim();
  if (trimmed.length <= chars) return trimmed;
  return keep === "head" ? `${trimmed.slice(0, chars)}…` : `…${trimmed.slice(trimmed.length - chars)}`;
}

export function buildPromptSuggestionPrompt(input: {
  /** Oldest first, so the model sees how the user tends to phrase requests. */
  recentUserMessages: readonly string[];
  lastAssistantMessage: string;
}): string {
  const userMessages = input.recentUserMessages
    .map((message) => clip(message, MAX_USER_MESSAGE_CHARS, "head"))
    .filter(Boolean)
    .slice(-RECENT_USER_MESSAGES);
  return [
    "Recent user messages, oldest first:",
    ...(userMessages.length ? userMessages.map((message) => `- ${message}`) : ["(none)"]),
    "",
    // The ending is what the next message answers, so keep the tail.
    "The agent's latest reply:",
    clip(input.lastAssistantMessage, MAX_REPLY_CHARS, "tail"),
  ].join("\n");
}

/**
 * One line, no wrapping quotes. `maxChars` caps a generated suggestion so it
 * fits the composer as one line; a native one keeps its full text (Tab fills
 * it in whole) and the composer only draws it on one line.
 */
export function sanitizePromptSuggestion(
  raw: string | null | undefined,
  maxChars: number = Number.POSITIVE_INFINITY,
): string {
  const firstLine = String(raw ?? "").trim().split(/\r?\n/)[0] ?? "";
  const unquoted = firstLine.trim().replace(/^["'`“”]+|["'`“”]+$/g, "").replace(/\s+/g, " ").trim();
  if (unquoted.length <= maxChars) return unquoted;
  // Cut at a word, without an ellipsis: Tab puts this text in the draft.
  const cut = unquoted.slice(0, maxChars);
  const atWord = cut.lastIndexOf(" ");
  return (atWord > maxChars / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:–—-]+$/, "");
}

export function parsePromptSuggestion(structured: unknown, text: string | null | undefined): string {
  if (structured && typeof structured === "object") {
    const value = (structured as { suggestion?: unknown }).suggestion;
    if (typeof value === "string") return sanitizePromptSuggestion(value, MAX_PROMPT_SUGGESTION_CHARS);
  }
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw) as { suggestion?: unknown };
    if (typeof parsed?.suggestion === "string") return sanitizePromptSuggestion(parsed.suggestion, MAX_PROMPT_SUGGESTION_CHARS);
  } catch {
    // Not JSON: a model that ignored the schema answered in plain text.
  }
  return raw.startsWith("{") ? "" : sanitizePromptSuggestion(raw, MAX_PROMPT_SUGGESTION_CHARS);
}

/** What the chat service knows about a turn when its `done` arrives. */
export type PromptSuggestionTurnFacts = {
  sessionId: string;
  turnId: string | null | undefined;
  completed: boolean;
  /** A subagent's next message comes from the agent that spawned it. */
  isSubagentWithParent: boolean;
  /** Read per turn, so flipping the setting applies to the next turn. */
  enabled: boolean;
  /** The provider sends its own suggestion (Claude Code). */
  nativeSuggestions: boolean;
  /** Oldest first; the last entry is the reply that just settled. */
  entries: ReadonlyArray<{ role: "user" | "assistant"; text: string; displayText?: string; turnId?: string }>;
  /** False once the chat is deleted or replaced by another managed session. */
  isStillCurrent: () => boolean;
};

export type NextPromptSuggestionDeps = {
  logger: Logger;
  /**
   * Runs the prompt on the chat's helper model. Returns null when the chat has
   * no model to run it on.
   */
  runPrompt: (args: {
    sessionId: string;
    cwd: string;
    systemPrompt: string;
    prompt: string;
    jsonSchema: unknown;
    timeoutMs: number;
  }) => Promise<{ structuredOutput?: unknown; text?: string | null } | null>;
  /** Live-only: a suggestion is never written to the transcript. */
  emitSuggestion: (sessionId: string, suggestion: string, turnId: string) => void;
  /** True while an approval card or question waits: the next message is its answer. */
  hasPendingInput: (sessionId: string) => boolean;
};

export type NextPromptSuggestion = {
  /** Any user message or turn start makes an answer still in flight stale. */
  onTurnActivity: (sessionId: string) => void;
  onTurnDone: (facts: PromptSuggestionTurnFacts) => void;
  forget: (sessionId: string) => void;
};

export function createNextPromptSuggestion(deps: NextPromptSuggestionDeps): NextPromptSuggestion {
  const { logger } = deps;
  /** The turn whose suggestion is being generated, per chat. */
  const pendingTurnBySession = new Map<string, string>();

  const run = async (facts: PromptSuggestionTurnFacts, turnId: string, prompt: string): Promise<void> => {
    const { sessionId } = facts;
    const startedAt = Date.now();
    let suggestion = "";
    let cwd: string | null = null;
    try {
      // A fresh scratch directory: the helper must load no repo, no
      // CLAUDE.md or AGENTS.md, no hooks. It only answers the prompt.
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ade-next-prompt-"));
      const result = await deps.runPrompt({
        sessionId,
        cwd,
        systemPrompt: PROMPT_SUGGESTION_SYSTEM_PROMPT,
        prompt,
        jsonSchema: PROMPT_SUGGESTION_JSON_SCHEMA,
        timeoutMs: SUGGESTION_TIMEOUT_MS,
      });
      if (result) suggestion = parsePromptSuggestion(result.structuredOutput, result.text);
    } catch (error) {
      // Fail quiet: no suggestion is the same as an empty one.
      logger.warn("agent_chat.prompt_suggestion_failed", {
        sessionId,
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
    }
    // Shown only if nothing happened since the turn ended: no user message or
    // new turn (either clears the pending entry), same live chat, no card.
    const stillOpen = pendingTurnBySession.get(sessionId) === turnId
      && facts.isStillCurrent()
      && !deps.hasPendingInput(sessionId);
    if (pendingTurnBySession.get(sessionId) === turnId) pendingTurnBySession.delete(sessionId);
    logger.info("agent_chat.prompt_suggestion", {
      sessionId,
      turnId,
      offered: Boolean(suggestion) && stillOpen,
      empty: !suggestion,
      stillOpen,
      durationMs: Date.now() - startedAt,
    });
    if (suggestion && stillOpen) deps.emitSuggestion(sessionId, suggestion, turnId);
  };

  return {
    onTurnActivity(sessionId) {
      pendingTurnBySession.delete(sessionId);
    },

    onTurnDone(facts) {
      const { sessionId } = facts;
      pendingTurnBySession.delete(sessionId);
      const turnId = facts.turnId?.trim();
      if (!facts.enabled || facts.nativeSuggestions) return;
      if (!facts.completed || !turnId || facts.isSubagentWithParent) return;
      if (deps.hasPendingInput(sessionId)) return;
      const last = facts.entries[facts.entries.length - 1];
      if (!last || last.role !== "assistant" || (last.turnId && last.turnId !== turnId)) return;
      const reply = last.text.trim();
      if (!reply) return;
      const recentUserMessages = facts.entries
        .filter((entry) => entry.role === "user")
        .map((entry) => (entry.displayText ?? entry.text).trim())
        .filter(Boolean)
        .slice(-RECENT_USER_MESSAGES);
      pendingTurnBySession.set(sessionId, turnId);
      void run(facts, turnId, buildPromptSuggestionPrompt({ recentUserMessages, lastAssistantMessage: reply }));
    },

    forget(sessionId) {
      pendingTurnBySession.delete(sessionId);
    },
  };
}
