import type { PendingInputRequest } from "./types/chat";

/**
 * The private secret card: an agent asks the person for a project secret, and
 * the value goes straight into the project's encrypted secrets without ever
 * entering the transcript or the agent's context.
 *
 * It rides the ordinary pending-input machinery (`requestChatInput` →
 * `respondToInput`), so every client that can answer a question can answer
 * this one. The value travels as the answer to an `isSecret` question, which
 * the transcript writer drops outright (`sanitizeAnswersForTranscript`). The
 * metadata below only tells a client that knows the card to draw it natively;
 * a client that does not falls back to a password question.
 */

/** The one name rule, shared by the service and every form that asks for a name. */
export const PROJECT_SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

export const PROJECT_SECRET_NAME_RULE =
  "Secret names must start with a letter and contain only letters, numbers, '.', '_', or '-' (max 128 characters).";

/** Null when the name is valid, else the sentence to show. */
export function projectSecretNameError(name: string | null | undefined): string | null {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return "Secret name is required.";
  return PROJECT_SECRET_NAME_PATTERN.test(trimmed) ? null : PROJECT_SECRET_NAME_RULE;
}

/** `providerMetadata` key on the card. Its presence makes the card user-only. */
export const PROJECT_SECRET_REQUEST_METADATA_KEY = "projectSecretRequest" as const;

/** The `isSecret` question whose answer is the value. */
export const PROJECT_SECRET_VALUE_QUESTION_ID = "secret_value" as const;
/** Present only when the name already exists: `keep` or `replace`. */
export const PROJECT_SECRET_ACTION_QUESTION_ID = "secret_action" as const;

export const PROJECT_SECRET_REASON_MAX_CHARS = 500;

/** The one line of copy every surface uses to say where the value goes. */
export const PROJECT_SECRET_WHERE_IT_GOES =
  "Saved encrypted to this project's secrets. The agent only sees the name.";

export type ProjectSecretRequestCard = {
  name: string;
  reason: string;
  /** The agent suggested ADE generate a value (offered first, never forced). */
  generate: boolean;
  /** The name already holds a value when the card was raised. */
  exists: boolean;
};

/** What `project_secret.request` returns. Never the value. */
export type ProjectSecretRequestResult =
  | { name: string; saved: true; replaced: boolean }
  | { name: string; saved: false; kept: true }
  | { name: string; saved: false; declined: true };

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The card's metadata, or null when this pending input is not a secret card. */
export function readProjectSecretRequestCard(
  request: Pick<PendingInputRequest, "providerMetadata"> | null | undefined,
): ProjectSecretRequestCard | null {
  const record = readRecord(request?.providerMetadata?.[PROJECT_SECRET_REQUEST_METADATA_KEY]);
  if (!record) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name || !PROJECT_SECRET_NAME_PATTERN.test(name)) return null;
  return {
    name,
    reason: typeof record.reason === "string" ? record.reason.trim() : "",
    generate: record.generate === true,
    exists: record.exists === true,
  };
}

/** 32 random bytes as hex — Web Crypto, so it runs the same on every platform. */
export function generateProjectSecretValue(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The line a person drops into the composer after adding a secret themselves:
 * the agent learns the name exists and how to use it without reading it.
 */
export function projectSecretComposerNote(name: string): string {
  return `I saved the project secret \`${name}\` (value hidden). Use it by name — e.g. \`"$(ade secrets get ${name} --text)"\` inside a command — and never print it.`;
}
