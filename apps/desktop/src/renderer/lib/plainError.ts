/**
 * A failed call as the person reads it: one plain sentence and the one next
 * step that fits, never Electron's "Error invoking remote method '…':" text,
 * a JSON-RPC code, or the name of an internal part.
 *
 * Every Settings page that shows a call's failure reads it through here
 * (Integrations, MCP servers, Machines), so the same failure reads the same
 * everywhere. The sentence a service wrote for a person is kept as it is;
 * only text written for logs is replaced.
 */

import { isGithubAutolinksNotAdmin, isGithubAutolinksRefusal } from "../../shared/githubAutolinks";
import { isConnectionTroubleText } from "./format";
import { machineErrorText } from "./machineErrorText";

/**
 * What the person can do about it:
 * - `retry`: it may work in a moment (a dropped link, a slow answer);
 * - `update`: the other computer's ADE is too old to answer this;
 * - `ask_admin`: someone with more rights has to do it;
 * - `none`: nothing to press, the sentence says what to do.
 */
export type PlainErrorNext = "retry" | "update" | "ask_admin" | "none";

export type PlainError = { text: string; next: PlainErrorNext };

/** The other computer's ADE does not have this method or action yet (text written for logs). */
const OLDER_ADE_TEXT = /\bMethod not found\b|is unavailable in this runtime|is not callable|is not exposed/i;

/** A service already said "Update ADE on that computer …" in plain words. */
const UPDATE_ADE_SENTENCE = /\bUpdate ADE on\b/i;

/** Text written for logs and developers, never for a person. */
const INTERNAL_TEXT = /^\s*(?:\[?-?32\d{3}\]?|code\s*-?32\d{3})|\brequires params\.\w+|^Domain '[^']+'|^Action '[^']+'|\bat \S+:\d+:\d+\)?$|^[A-Z][A-Za-z]+Error: /;

/**
 * `error` as a sentence and a next step. `fallback` is the sentence when the
 * error says nothing a person can use ("Couldn't load the links."); `machine`
 * names the other computer in the "update" sentence.
 */
export function plainError(error: unknown, options: { fallback: string; machine?: string | null }): PlainError {
  const text = machineErrorText(error).trim();
  if (!text) return { text: options.fallback, next: "retry" };
  if (isGithubAutolinksRefusal(text)) {
    return { text, next: isGithubAutolinksNotAdmin(text) ? "ask_admin" : "none" };
  }
  if (UPDATE_ADE_SENTENCE.test(text)) return { text, next: "update" };
  if (OLDER_ADE_TEXT.test(text)) {
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
