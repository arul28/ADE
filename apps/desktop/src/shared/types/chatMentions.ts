// Composer @-mention pointers to other ADE entities (chats, lanes, terminals,
// pull requests, account machines, MCP servers) and to people (Linear members,
// GitHub users of the project's repository).
//
// A mention is a POINTER, not an attachment: the composer inserts a chip whose
// serialized form is `@chat:<id>` / `@lane:<id>` / `@term:<id>` / `@pr:<id>` /
// `@mac:<id>` / `@mcp:<name>` / `@person:<source>.<id>`, and the chat service expands it into a compact `<ade-mention>`
// block at SEND time. The block carries identity metadata, a small
// deterministic preview, and the exact `ade` CLI commands the agent can use to
// read more.

import type { PrChecksStatus, PrState } from "./prs";
import type { McpRegistryState, McpRegistryTransport } from "../mcpRegistry";

export type ChatMentionKind = "chat" | "lane" | "terminal" | "pr" | "machine" | "mcp" | "person";

/** Where a person row comes from. A new source adds a value here. */
export type ChatMentionPersonSource = "linear" | "github";

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
  /**
   * Person rows only: the integration the person comes from, and their handle
   * there (Linear display name, GitHub login). Never an email.
   */
  person?: { source: ChatMentionPersonSource; handle: string | null } | null;
  /** MCP registry row data; contains names and status only, never secrets. */
  mcp?: {
    /** A newer brain may send a state this build does not know; render it as-is. */
    state: McpRegistryState | "needs-sign-in" | (string & {});
    transport: McpRegistryTransport | (string & {});
    toolNames: string[];
    toolCount?: number | null;
    lastError: string | null;
    lastErrorAt?: number | null;
  } | null;
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
  /**
   * Exact lookup, for the labels of chips in sent messages: only the rows
   * with these ids (of the kind the query names), uncapped, after each source's
   * full read. An older brain ignores it and answers the plain query.
   */
  ids?: string[];
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
