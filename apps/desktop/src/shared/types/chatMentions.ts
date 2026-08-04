// Composer @-mention pointers to other ADE entities (chats, lanes, terminals).
//
// A mention is a POINTER, not an attachment: the composer inserts a chip whose
// serialized form is `@chat:<id>` / `@lane:<id>` / `@term:<id>`, and the chat
// service expands it into a compact `<ade-mention>` block at SEND time. The
// block carries identity metadata, a small deterministic preview, and the exact
// `ade` CLI commands the agent can use to read more.

export type ChatMentionKind = "chat" | "lane" | "terminal";

/** One row in the @-menu. Cheap: no transcript reads happen to build these. */
export type ChatMentionSuggestion = {
  kind: ChatMentionKind;
  /** Session id / lane id / terminal id. Serialized into the chip token. */
  id: string;
  /** Primary label (chat title, lane name, terminal title). */
  title: string;
  /** Secondary label: lane name, provider, branch, running state. */
  subtitle?: string;
  /** Epoch ms of last activity; drives recency-first ranking. */
  lastActivityAt?: number | null;
};

export type ChatMentionSuggestArgs = {
  /** Fuzzy query typed after `@`. Empty string means "most recent". */
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
