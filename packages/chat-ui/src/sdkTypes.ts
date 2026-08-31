/**
 * Public SDK surface that `@ade-dev/chat-ui` renders against.
 *
 * PROVENANCE: the event shapes below are a hand-trimmed subset of
 * `apps/desktop/src/shared/types/chat.ts` (`AgentChatEvent`,
 * `AgentChatEventEnvelope`), reduced to the card set this package draws:
 * user text, assistant text, reasoning, tool call/result, error, status.
 * ADE-internal event kinds (subagent lifecycle, scheduled work, plans, todo
 * updates, approvals, delegation, ade_card, work-log grouping) are deliberately
 * absent — this package has no ADE dev concepts in it.
 *
 * This file is a *copy*, not an import: the package is standalone and takes
 * `@ade-dev/sdk` only as an optional peer. `@ade-dev/sdk` is being built in parallel to
 * exactly this contract; the assumptions it must honour are listed in
 * README.md under "SDK contract assumptions".
 */

/** Stable identifier for an agent provider, e.g. `"claude"`, `"codex"`. */
export type ProviderId = string;

/** Lifecycle status of a single provider's CLI/credentials. */
export type ProviderStatus = {
  id: ProviderId;
  /** Human label. Falls back to `id` when omitted. */
  displayName?: string;
  /**
   * Provider binary/runtime is present. A host that can probe the filesystem
   * should say so honestly; `adaptSdkClient` cannot, and reports the closest
   * thing `@ade-dev/sdk` exposes (the provider has models in the catalog).
   */
  installed: boolean;
  /** Credentials are present and usable. */
  authenticated: boolean;
  /** Shell command that authenticates this provider. Rendered copyable. */
  loginCommand?: string;
  /** Shell command that installs this provider. Rendered copyable. */
  installCommand?: string;
  /** Short human explanation for the current state (e.g. "Token expired"). */
  detail?: string;
  docsUrl?: string;
};

/** One selectable model. */
export type ModelDescriptor = {
  id: string;
  providerId: ProviderId;
  displayName: string;
  shortName?: string;
  /** Secondary grouping inside a provider (e.g. a hosting vendor). */
  subProvider?: string;
  aliases?: string[];
  description?: string;
  /**
   * Explicitly false marks a model the host knows is unusable even when its
   * provider is authenticated. Undefined means "usable if the provider is".
   */
  available?: boolean;
};

/** Running state of a thread, as reported by `thread.on("status")`. */
export type ThreadStatus = {
  state: "idle" | "running" | "error";
  turnId?: string | null;
  message?: string;
};

/** Token accounting, as reported by `thread.on("usage")`. */
export type ThreadUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
};

/** An attachment handed to `send`/`steer`. Opaque to this package. */
export type ChatAttachment = {
  id: string;
  name: string;
  mimeType?: string;
  /** Local path or URL — whichever the host's SDK client understands. */
  uri?: string;
  sizeBytes?: number;
};

export type SendInput = {
  text: string;
  attachments?: ChatAttachment[];
};

export type ThreadOpenOptions = {
  modelId?: string;
  providerId?: ProviderId;
  /** Resume an existing provider-side thread rather than starting fresh. */
  resume?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

export type ToolCallStatus = "running" | "completed" | "failed" | "interrupted";

export type ChatEventUserMessage = {
  type: "user_message";
  text: string;
  displayText?: string;
  messageId?: string;
  turnId?: string;
  attachments?: ChatAttachment[];
};

export type ChatEventText = {
  type: "text";
  text: string;
  messageId?: string;
  turnId?: string;
  itemId?: string;
};

export type ChatEventReasoning = {
  type: "reasoning";
  text: string;
  turnId?: string;
  itemId?: string;
  summaryIndex?: number;
};

export type ChatEventToolCall = {
  type: "tool_call";
  tool: string;
  args: unknown;
  itemId: string;
  logicalItemId?: string;
  turnId?: string;
};

export type ChatEventToolResult = {
  type: "tool_result";
  tool: string;
  result: unknown;
  itemId: string;
  logicalItemId?: string;
  turnId?: string;
  status?: ToolCallStatus;
};

export type ChatEventError = {
  type: "error";
  message: string;
  detail?: string;
  turnId?: string;
  itemId?: string;
};

export type ChatEventStatus = {
  type: "status";
  turnStatus: "started" | "completed" | "interrupted" | "failed";
  turnId?: string;
  message?: string;
};

/** The event kinds this package draws. Everything else is dropped. */
export type RenderedChatEvent =
  | ChatEventUserMessage
  | ChatEventText
  | ChatEventReasoning
  | ChatEventToolCall
  | ChatEventToolResult
  | ChatEventError
  | ChatEventStatus;

/**
 * Any other event kind, carried but not drawn.
 *
 * ADE's own event union has ~60 members and grows every release, and `@ade-dev/sdk`
 * models it as exactly this open record. Closing it here would make an SDK
 * envelope unassignable to this one — a compile error for every embedder — and
 * would invite a runtime cast at the boundary. Open instead: the renderer
 * narrows with `RENDERED_TYPES` and ignores what it does not recognise, so a
 * newer runtime adds event kinds without breaking an older `@ade-dev/chat-ui`.
 */
export type UnknownChatEvent = { type: string; [key: string]: unknown };

export type AgentChatEvent = RenderedChatEvent | UnknownChatEvent;

export type AgentChatEventEnvelope = {
  sessionId: string;
  /** ISO-8601. Ordering is envelope-based, never provider-clock based. */
  timestamp: string;
  event: AgentChatEvent;
  sequence?: number;
};

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

/** Unsubscribe handle returned by every `on*` registration. */
export type Unsubscribe = () => void;

export interface AdeThread {
  readonly key: string;
  send(input: SendInput | string): Promise<void>;
  /** Deliver a message into an already-running turn. */
  steer(input: SendInput | string): Promise<void>;
  interrupt(): Promise<void>;
  /**
   * Switch this thread's model mid-conversation, crossing providers if the id
   * resolves to a different one. The conversation continues — the engine
   * replays the transcript rather than starting over.
   *
   * OPTIONAL on purpose. Making it required would break every hand-written
   * client implementing this interface, including hosts outside this repo, for
   * a capability their runtime may not have. `ThreadState.canSetModel` reports
   * its presence so a picker can be disabled with a reason rather than
   * accepting a click that silently does nothing.
   */
  setModel?(modelId: string): Promise<unknown>;
  history(): Promise<AgentChatEventEnvelope[]>;
  on(type: "event", cb: (envelope: AgentChatEventEnvelope) => void): Unsubscribe;
  on(type: "usage", cb: (usage: ThreadUsage) => void): Unsubscribe;
  on(type: "status", cb: (status: ThreadStatus) => void): Unsubscribe;
}

export interface AdeChatClient {
  providers: {
    status(): Promise<ProviderStatus[]>;
    onChange(cb: (statuses: ProviderStatus[]) => void): Unsubscribe;
  };
  models: {
    list(): Promise<ModelDescriptor[]>;
  };
  threads: {
    open(key: string, opts?: ThreadOpenOptions): Promise<AdeThread>;
  };
}
