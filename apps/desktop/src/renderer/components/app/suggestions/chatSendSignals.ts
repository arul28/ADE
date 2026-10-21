import { useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { parseChatMentions } from "../../../../shared/chatMentions";
import { looksLikeSecret } from "../../../../shared/secretText";
import { findSmartLinks } from "../../../../shared/smartLinks";
import { markSuggestionDone } from "../../../onboarding/situationalSuggestions";

/**
 * What a sent chat message says about which suggestion would help, read once
 * at send time from the text the user typed. It never leaves this module:
 * nothing is logged, and only hashes and kinds are kept.
 *
 * O(text) and synchronous, so it costs the send nothing that shows. It works
 * the same for a chat on any machine, because it reads only the draft. The
 * answers land in a small in-memory store that `SituationalSuggestions` reads.
 */

export type IssueTracker = "linear" | "jira" | "github";

export type ChatSendSignals = {
  /** Bumped when a message looked like it had a key or password in it. */
  secretSeq: number;
  /** Trackers whose issue links the latest such message carried, on the tab's machine. */
  issueTrackers: readonly IssueTracker[];
  issueSeq: number;
  /** Hash of a prompt sent three times this week in this project, or null. */
  repeatedPrompt: string | null;
};

/** A pasted log can be huge; the secret shapes are found near where they are pasted. */
const SECRET_SCAN_MAX_CHARS = 20_000;
const PROMPT_STORAGE_KEY = "ade.suggestions.prompts.v1";
const PROMPT_WINDOW_MS = 7 * 24 * 3_600_000;
const PROMPT_REPEATS = 3;
const PROMPT_MIN_CHARS = 20;
const PROMPT_RING_SIZE = 40;

let signals: ChatSendSignals = { secretSeq: 0, issueTrackers: [], issueSeq: 0, repeatedPrompt: null };
const listeners = new Set<() => void>();

function set(patch: Partial<ChatSendSignals>): void {
  signals = { ...signals, ...patch };
  for (const listener of listeners) listener();
}

/** FNV-1a, as hex. Enough to tell prompts apart; the text itself is never stored. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

type PromptSend = { h: string; p: string; at: number };

function readPromptRing(now: number): PromptSend[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROMPT_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PromptSend => (
      Boolean(entry)
      && typeof entry.h === "string"
      && typeof entry.p === "string"
      && typeof entry.at === "number"
      && now - entry.at < PROMPT_WINDOW_MS
    ));
  } catch {
    return [];
  }
}

/** Records the prompt's hash; returns it when this is its third send this week in this project. */
function notePromptRepeat(text: string, projectRoot: string | null): string | null {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  // Short replies ("continue", "yes, go ahead") and slash commands repeat by nature.
  if (normalized.length < PROMPT_MIN_CHARS || normalized.startsWith("/")) return null;
  const now = Date.now();
  const entry: PromptSend = { h: hashText(normalized), p: hashText(projectRoot ?? ""), at: now };
  const ring = [...readPromptRing(now), entry].slice(-PROMPT_RING_SIZE);
  try {
    window.localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(ring));
  } catch {
    // Storage unavailable: repeats are not counted.
  }
  const repeats = ring.filter((sent) => sent.h === entry.h && sent.p === entry.p).length;
  return repeats >= PROMPT_REPEATS ? entry.h : null;
}

function issueTrackersIn(text: string): IssueTracker[] {
  if (!text.includes("http")) return [];
  const trackers = new Set<IssueTracker>();
  for (const link of findSmartLinks(text)) {
    if (link.kind === "linear_issue") trackers.add("linear");
    else if (link.kind === "jira_issue") trackers.add("jira");
    else if (link.kind === "github_issue" || link.kind === "github_pr") trackers.add("github");
  }
  return [...trackers];
}

/**
 * Reads a message the user is sending. `pin` is the chat's machine (null for
 * the tab's own): tracker connections are checked on the tab's machine only,
 * because that is the one Settings connects.
 */
export function noteChatSendForSuggestions(
  text: string,
  scope: { projectRoot: string | null; pin: OpenProjectBinding | null },
): void {
  if (!text.trim()) return;
  if (text.includes("@") && parseChatMentions(text).some((mention) => mention.kind === "machine")) {
    markSuggestionDone("machine-mention");
  }
  const patch: Partial<ChatSendSignals> = {};
  if (looksLikeSecret(text.length > SECRET_SCAN_MAX_CHARS ? text.slice(0, SECRET_SCAN_MAX_CHARS) : text)) {
    patch.secretSeq = signals.secretSeq + 1;
  }
  const trackers = scope.pin ? [] : issueTrackersIn(text);
  if (trackers.length) {
    patch.issueTrackers = trackers;
    patch.issueSeq = signals.issueSeq + 1;
  }
  const repeated = notePromptRepeat(text, scope.projectRoot);
  if (repeated) patch.repeatedPrompt = repeated;
  if (Object.keys(patch).length) set(patch);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSignals = () => signals;

export function useChatSendSignals(): ChatSendSignals {
  return useSyncExternalStore(subscribe, getSignals, getSignals);
}
