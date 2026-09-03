/**
 * Public SDK surface that `@ade-dev/chat-ui` renders against.
 *
 * PROVENANCE: the event shapes below are a hand-trimmed subset of
 * `apps/desktop/src/shared/types/chat.ts` (`AgentChatEvent`,
 * `AgentChatEventEnvelope`), reduced to the card set this package draws:
 * user text, assistant text, reasoning, tool call/result, error, status, and
 * the two approval events. ADE-internal event kinds (subagent lifecycle,
 * scheduled work, plans, todo updates, delegation, ade_card, work-log grouping)
 * are deliberately absent — this package has no ADE dev concepts in it.
 *
 * Approvals are the exception to "internal", because they are not an ADE dev
 * concept at all: they are the provider asking the person at the keyboard for
 * permission, and the turn stays blocked until someone answers.
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
   * Provider binary/runtime is present.
   *
   * Read this together with `source`. A runtime that probes the filesystem
   * reports it directly (`source: "probed"`), and `installed: false` then means
   * "looked, found nothing". A runtime that cannot probe leaves the adapter to
   * derive it from the model catalog (`source: "derived"`), where the same
   * `false` only means "ADE knows no models for it" — which is why the card
   * says "Not detected" rather than "Not installed" in that case.
   */
  installed: boolean;
  /** Credentials are present and usable. */
  authenticated: boolean;
  /** Absolute path of the binary the runtime would spawn. Probed hosts only. */
  binaryPath?: string;
  /** Version string the provider reported, verbatim. Probed hosts only. */
  version?: string;
  /** How `installed`, `binaryPath` and `version` were established. */
  source?: "probed" | "derived";
  /** ISO-8601 time the status was established. */
  checkedAt?: string;
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

/* -------------------------------------------------------------------------- */
/* Approvals                                                                   */
/* -------------------------------------------------------------------------- */

/** What the provider wants confirmed. */
export type ApprovalKind = "command" | "file_change" | "tool_call";

/**
 * The three answers this package can send.
 *
 * `accept_always` is the one that makes approvals bearable over a long session:
 * it settles this request and stops the provider asking again for the same
 * thing. The client maps these onto whatever its runtime spells them.
 */
export type ApprovalDecision = "accept" | "accept_always" | "reject";

/** An outstanding approval, as `thread.pendingApprovals()` reports one. */
export type ApprovalRequest = {
  itemId: string;
  logicalItemId?: string;
  kind: ApprovalKind;
  requestKind?: string;
  description: string;
  turnId?: string;
  detail?: unknown;
  /**
   * Optional on purpose: the SDK always knows which provider raised a request,
   * but a proxy that only forwards the chat surface may not, and this package
   * renders the same card either way.
   */
  provider?: ProviderId;
};

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

/**
 * The provider is blocked on a person answering. The turn does not proceed
 * until `thread.approve()` settles it or `thread.interrupt()` ends the turn, so
 * a host that receives one and draws nothing looks frozen.
 */
export type ChatEventApprovalRequest = {
  type: "approval_request";
  itemId: string;
  /** Stable across a provider renumbering items; preferred for matching. */
  logicalItemId?: string;
  /** The shape of the thing being confirmed. */
  kind: ApprovalKind;
  /**
   * The finer request type. `kind` has no word for a question, so a provider
   * asking for prose rides this event with `requestKind: "question"`. Those
   * cannot be answered with accept/reject and render read-only here.
   */
  requestKind?: string;
  description: string;
  turnId?: string;
  /** Provider payload: the command string, the patch, the tool input. */
  detail?: unknown;
};

/** An `approval_request` reached a decision — by this host or by another one. */
export type ChatEventPendingInputResolved = {
  type: "pending_input_resolved";
  itemId: string;
  /** Matched when `itemId` finds no card, for a provider that renumbers items. */
  logicalItemId?: string;
  resolution: "accepted" | "declined" | "cancelled";
  turnId?: string;
};

/** The event kinds this package draws. Everything else is dropped. */
export type RenderedChatEvent =
  | ChatEventUserMessage
  | ChatEventText
  | ChatEventReasoning
  | ChatEventToolCall
  | ChatEventToolResult
  | ChatEventError
  | ChatEventStatus
  | ChatEventApprovalRequest
  | ChatEventPendingInputResolved;

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
  /**
   * Answer an approval the thread emitted.
   *
   * OPTIONAL for the same reason as `setModel`: a client whose runtime has no
   * answer path must be able to say so, and `ThreadState.canApprove` reports
   * its presence so the card renders read-only instead of offering a button
   * that would throw. Resolves once the runtime accepts the decision, not once
   * the tool has run.
   */
  approve?(itemId: string, decision: ApprovalDecision, responseText?: string): Promise<void>;
  /** Outstanding requests, so a host re-rendering after a reload restores cards. */
  pendingApprovals?(): Promise<readonly ApprovalRequest[]>;
  history(): Promise<AgentChatEventEnvelope[]>;
  on(type: "event", cb: (envelope: AgentChatEventEnvelope) => void): Unsubscribe;
  on(type: "usage", cb: (usage: ThreadUsage) => void): Unsubscribe;
  on(type: "status", cb: (status: ThreadStatus) => void): Unsubscribe;
}

export interface AdeChatClient {
  providers: {
    status(): Promise<ProviderStatus[]>;
    onChange(cb: (statuses: ProviderStatus[]) => void): Unsubscribe;
    /**
     * Re-probe now, bypassing whatever cache the runtime keeps.
     *
     * OPTIONAL: a client that derives statuses from a catalog has nothing to
     * re-probe. A host renders a "Check again" button only when it is present.
     */
    refresh?(): Promise<ProviderStatus[]>;
  };
  models: {
    list(): Promise<ModelDescriptor[]>;
  };
  threads: {
    open(key: string, opts?: ThreadOpenOptions): Promise<AdeThread>;
  };
}
