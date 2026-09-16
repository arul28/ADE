import {
  CTO_VOICE_SPOKEN_CONFIRM_WINDOW_MS,
  isDestructiveVoiceTool,
  type CtoVoiceConfirmation,
} from "../../../shared/types/ctoVoice";

/**
 * Whether a spoken "yes" counts.
 *
 * An open microphone is an open door: the CTO's own audio comes back through
 * the speakers, a podcast in the background says "yeah do it", someone walks
 * past. So a spoken approval is only honoured when it is demonstrably an answer
 * to a question the CTO actually asked:
 *
 *  - the question is still pending,
 *  - the words arrived AFTER it was asked and inside a short window,
 *  - they belong to a different utterance than the one that prompted it,
 *  - and the action is not destructive.
 *
 * Anything destructive needs a tap, always. A misheard word must not be able to
 * force-push over someone's work.
 */

const AFFIRMATIVE = [
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "go ahead", "do it",
  "please do", "sounds good", "confirmed", "affirmative", "go for it",
];

const NEGATIVE = ["no", "nope", "don't", "do not", "stop", "cancel", "wait", "hold on", "not now"];

export type SpokenDecision = "approve" | "deny" | "none";

/** Strip punctuation so "yes." and "yes!" read the same as "yes". */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
}

function containsPhrase(haystack: string, phrase: string): boolean {
  return new RegExp(`(^|\\s)${phrase.replace(/ /g, "\\s+")}($|\\s)`).test(haystack);
}

/**
 * Read a decision out of one user utterance.
 *
 * Negatives are checked first: "no, don't do it" contains "do it", and reading
 * that as approval would be the worst possible failure mode.
 */
export function classifySpokenReply(text: string): SpokenDecision {
  const normalized = normalize(text);
  if (!normalized.length) return "none";
  if (NEGATIVE.some((phrase) => containsPhrase(normalized, phrase))) return "deny";
  if (AFFIRMATIVE.some((phrase) => containsPhrase(normalized, phrase))) return "approve";
  return "none";
}

export type SpokenConfirmationInput = {
  confirmation: CtoVoiceConfirmation | null;
  /** The user utterance being evaluated. */
  utteranceId: string;
  text: string;
  nowMs: number;
};

export type SpokenConfirmationOutcome =
  | { kind: "approved" }
  | { kind: "denied" }
  | { kind: "ignored"; reason: string };

export function resolveSpokenConfirmation(input: SpokenConfirmationInput): SpokenConfirmationOutcome {
  const { confirmation } = input;
  if (!confirmation) return { kind: "ignored", reason: "nothing pending" };
  if (confirmation.destructive) {
    return { kind: "ignored", reason: "destructive actions need a tap" };
  }
  if (input.nowMs > confirmation.expiresAtMs) {
    return { kind: "ignored", reason: "the question has expired" };
  }
  // The utterance that CAUSED the question cannot also answer it. Without this,
  // "force-push it" would both raise the confirmation and approve it.
  if (confirmation.utteranceId && confirmation.utteranceId === input.utteranceId) {
    return { kind: "ignored", reason: "same utterance that raised the question" };
  }
  const decision = classifySpokenReply(input.text);
  if (decision === "approve") return { kind: "approved" };
  if (decision === "deny") return { kind: "denied" };
  return { kind: "ignored", reason: "no decision in the reply" };
}

export function buildConfirmation(args: {
  id: string;
  toolName: string;
  prompt: string;
  utteranceId: string | null;
  nowMs: number;
  approvalItemId?: string | null;
  /**
   * The verdict, when the caller could see more than the tool's name.
   *
   * A real approval rarely names an ADE operation: a bash approval arrives as
   * "Run command: git push --force origin main", and the name alone
   * (`Bash`, `command`) says nothing about blast radius. `describeVoiceApproval`
   * reads the command text and decides; this is where that decision lands.
   * Omitted, the name is all there is to go on.
   */
  destructive?: boolean;
}): CtoVoiceConfirmation {
  return {
    id: args.id,
    prompt: args.prompt,
    toolName: args.toolName,
    destructive: args.destructive ?? isDestructiveVoiceTool(args.toolName),
    utteranceId: args.utteranceId,
    expiresAtMs: args.nowMs + CTO_VOICE_SPOKEN_CONFIRM_WINDOW_MS,
    ...(args.approvalItemId ? { approvalItemId: args.approvalItemId } : {}),
  };
}
