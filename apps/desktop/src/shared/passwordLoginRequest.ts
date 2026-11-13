import type { PendingInputRequest } from "./types/chat";

/**
 * The secure sign-in card: an agent needs to sign in to a site that has no
 * saved login, and asks the person in its chat. The person either types the
 * username and password into the card (ADE saves them to Passwords, then the
 * agent's `ade browser signin` fills the page), or chooses to type them into
 * the browser page themselves.
 *
 * Like the private secret card (`projectSecretRequest.ts`), it rides the
 * ordinary pending-input machinery. Both values are answers to `isSecret`
 * questions, which the transcript writer drops outright, so neither ever
 * reaches the transcript or the agent. A client that does not draw the card
 * natively falls back to the plain questions.
 */

/** `providerMetadata` key on the card. */
export const PASSWORD_LOGIN_REQUEST_METADATA_KEY = "passwordLoginRequest" as const;

/** `save` (save to Passwords, then the agent fills) or `self` (the person types it into the page). */
export const PASSWORD_LOGIN_CHOICE_QUESTION_ID = "login_choice" as const;
export const PASSWORD_LOGIN_USERNAME_QUESTION_ID = "login_username" as const;
export const PASSWORD_LOGIN_PASSWORD_QUESTION_ID = "login_password" as const;

export type PasswordLoginChoice = "save" | "self";

export const PASSWORD_LOGIN_REASON_MAX_CHARS = 300;

export type PasswordLoginRequestCard = {
  /** The registrable site the login is for, e.g. "vercel.com". */
  site: string;
  /** The exact page origin it will be filled on, e.g. "https://vercel.com". */
  origin: string;
  reason: string;
};

/** What `passwords.requestLogin` returns. Never a value. */
export type PasswordLoginRequestResult =
  | { site: string; saved: true; itemId: string }
  | { site: string; saved: false; signInYourself: true }
  | { site: string; saved: false; declined: true };

/** The one line every surface uses to say where the values go. */
export const PASSWORD_LOGIN_WHERE_IT_GOES = (site: string): string =>
  `Saved to Passwords and filled directly into ${site}. The agent never sees it.`;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The card's metadata, or null when this pending input is not a sign-in card. */
export function readPasswordLoginRequestCard(
  request: Pick<PendingInputRequest, "providerMetadata"> | null | undefined,
): PasswordLoginRequestCard | null {
  const record = readRecord(request?.providerMetadata?.[PASSWORD_LOGIN_REQUEST_METADATA_KEY]);
  if (!record) return null;
  const site = typeof record.site === "string" ? record.site.trim() : "";
  const origin = typeof record.origin === "string" ? record.origin.trim() : "";
  if (!site || !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return null;
  return { site, origin, reason: typeof record.reason === "string" ? record.reason.trim() : "" };
}
