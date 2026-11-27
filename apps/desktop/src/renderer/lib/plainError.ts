/**
 * A failed call as the person reads it: one plain sentence and the one next
 * step that fits, never Electron's "Error invoking remote method '…':" text,
 * a JSON-RPC code, or the name of an internal part.
 *
 * Every error line a person reads should come through here: Settings, PRs,
 * chat, Files, terminals, Work, lanes and onboarding already do. Pass
 * `machine` when the call went to another computer, so an older brain reads
 * "Update ADE on <machine>". A sentence a service wrote for a person is kept
 * as it is; only text written for logs is replaced.
 *
 * Not for text code then inspects (a retry decision, an error-kind check):
 * keep the raw message for that, and convert only what is shown. Areas with
 * their own formatter (Mac desktop, iOS, Music, Git actions) keep it.
 *
 * After a label ("Delete failed: …"), pass a fallback that reads as a reason
 * ("the chat did not answer."), not a second "couldn't" sentence.
 */

import { isUnsupportedAdeActionError } from "../../shared/codedError";
import { isConnectionTroubleText } from "./format";
import { machineErrorText } from "./machineErrorText";

/**
 * What the person can do about it:
 * - `retry`: it may work in a moment (a dropped link, a slow answer);
 * - `update`: the other computer's ADE is too old to answer this;
 * - `none`: nothing to press, the sentence says what to do.
 */
export type PlainErrorNext = "retry" | "update" | "none";

export type PlainError = { text: string; next: PlainErrorNext };

/** An older brain that has no such JSON-RPC method (the coded forms are `isUnsupportedAdeActionError`). */
const METHOD_NOT_FOUND_TEXT = /\bMethod not found\b|is unavailable in this runtime/i;

/** A service already said "Update ADE on that computer …" in plain words. */
const UPDATE_ADE_SENTENCE = /\bUpdate ADE on\b/i;

/** Text written for logs and developers, never for a person. */
const INTERNAL_TEXT = /^\s*(?:\[?-?32\d{3}\]?|code\s*-?32\d{3})|\brequires params\.\w+|^Domain '[^']+'|^Action '[^']+'|\bat \S+:\d+:\d+\)?$|^[A-Z][A-Za-z]+Error: /;

/**
 * `error` as a sentence and a next step. `fallback` is the sentence when the
 * error says nothing a person can use ("ADE couldn't read the links.");
 * `machine` names the other computer in the "update" sentence.
 */
export function plainError(error: unknown, options: { fallback: string; machine?: string | null }): PlainError {
  const text = error == null ? "" : machineErrorText(typeof error === "string" ? new Error(error) : error).trim();
  if (!text) return { text: options.fallback, next: "retry" };
  if (UPDATE_ADE_SENTENCE.test(text)) return { text, next: "update" };
  if (isUnsupportedAdeActionError(error) || METHOD_NOT_FOUND_TEXT.test(text)) {
    const where = options.machine?.trim();
    return {
      text: where
        ? `${where} runs an older ADE that can't do this. Update ADE on ${where}, then try again.`
        : "That computer runs an older ADE that can't do this. Update ADE on it, then try again.",
      next: "update",
    };
  }
  if (isConnectionTroubleText(text)) return { text, next: "retry" };
  if (INTERNAL_TEXT.test(text)) return { text: `${options.fallback} Try again in a moment.`, next: "retry" };
  return { text, next: "none" };
}

/** `plainError(...).text`, for a toast or a line that has no button. */
export function plainErrorText(error: unknown, fallback: string, machine?: string | null): string {
  return plainError(error, { fallback, machine }).text;
}
