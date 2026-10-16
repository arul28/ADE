// Composer @-mention pointers to other ADE entities (chats, lanes, terminals,
// pull requests, account machines).
//
// A mention is a POINTER, not an attachment: the composer inserts a chip whose
// serialized form is `@chat:<id>` / `@lane:<id>` / `@term:<id>` / `@pr:<id>` /
// `@mac:<id>`, and the chat service expands it into a compact `<ade-mention>`
// block at SEND time. The block carries identity metadata, a small
// deterministic preview, and the exact `ade` CLI commands the agent can use to
// read more.

import type { PrChecksStatus, PrState } from "./prs";

export type ChatMentionKind = "chat" | "lane" | "terminal" | "pr" | "machine";

/** One row in the @-menu. Cheap: no transcript reads happen to build these. */
export type ChatMentionSuggestion = {
  kind: ChatMentionKind;
  /**
   * Session id / lane id / terminal id / PR row id / machine mention id
   * (`machineMentionId`). Serialized into the chip token.
   */
  id: string;
  /** Primary label (chat title, lane name, terminal title, `#12 PR title`, machine name). */
  title: string;
  /** Secondary label: lane name, provider, branch, running state, presence. */
  subtitle?: string;
  /** Epoch ms of last activity; drives recency-first ranking. */
  lastActivityAt?: number | null;
  /** PR rows only: what the menu draws as the state dot and checks glyph. */
  pr?: { number: number; state: PrState; checks: PrChecksStatus } | null;
  /** Machine rows only: directory presence, and whether it is the caller's own machine. */
  machine?: { online: boolean; isThisMachine: boolean } | null;
};

export type ChatMentionSuggestArgs = {
  /**
   * Fuzzy query typed after `@`. Empty string means "most recent, per kind".
   * A leading kind word (`pr`, `mac`, `chat`, `lane`, `term`, see
   * `parseChatMentionKindFilter`) narrows the result to that kind.
   */
  query?: string;
  /** Caller's own chat session id, so a chat never suggests itself. */
  excludeSessionId?: string;
};

export type ChatMentionSuggestResult = {
  suggestions: ChatMentionSuggestion[];
};

/** Resolved detail used to render one `<ade-mention>` expansion block. */
export type ChatMentionDetail = {
  kind: ChatMentionKind;
  id: string;
  title: string;
  /** Rendered as attributes in document order, skipping empty values. */
  attributes: Array<[string, string]>;
  /** Human sentence + the exact `ade` commands for reading more. */
  hint: string;
  /** Optional deterministic preview body (already hard-capped by the caller). */
  preview?: string | null;
  /** Label above the preview body, e.g. "Preview (most recent exchange…)". */
  previewLabel?: string | null;
};
