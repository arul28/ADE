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
  /**
   * Reasoning-effort levels this model accepts, in the order to offer them
   * (e.g. `["low", "medium", "high"]`). Absent or empty means the model takes
   * no effort setting, and `<ModelPicker>` draws no effort control for it.
   */
  reasoningEfforts?: string[];
  /** The effort the runtime uses when none is chosen. */
  defaultReasoningEffort?: string | null;
};

/**
 * The model a thread is actually bound to, as the runtime resolved it.
 *
 * This can differ from the id the host asked for: a runtime resolves a retired
 * id forward to its successor, so `modelId` here may not be in the catalog the
 * picker shows. `displayName` is the runtime's name for it, and a UI should
 * prefer it over printing a raw id. Mirrors the type of the same name in
 * `@ade-dev/sdk` >= 0.3; every field past `modelId` is optional so an older
 * SDK or a proxy that forwards less still fits.
 */
export type ThreadModelSelection = {
  modelId: string;
  displayName?: string | null;
  provider?: string;
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

/**
 * An attachment handed to `send`/`steer`. Opaque to this package.
 *
 * `id` is the attachment's identity: the composer de-duplicates its staged
 * list by it, and it is the React key the chips render under. Two different
 * files must not share one.
 */
export type ChatAttachment = {
  id: string;
  name: string;
  mimeType?: string;
  /** Local path or URL — whichever the host's SDK client understands. */
  uri?: string;
  sizeBytes?: number;
  /**
   * How the runtime should hand the file to the model. `"image"` sends the
   * bytes as an image; `"file"` sends a path hint. Omit it and `adaptSdkClient`
   * infers it with the runtime's rule (`inferAttachmentType`): an `image/*`
   * `mimeType`, else an image extension on `uri` (bmp, gif, heic, heif, ico,
   * jpeg, jpg, png, svg, tif, tiff, webp), else `"file"`.
   */
  type?: "file" | "image";
  /**
   * `false` makes the attachment reference-only: the runtime never reads its
   * bytes (no staging copy, no download of a cloud placeholder) and the model
   * gets the path. An image sent this way arrives as a path, not as pixels.
   * Omitted means the runtime default (read the file). Needs an ADE runtime
   * that understands the flag; an older one ignores it and reads the file.
   */
  hydrate?: boolean;
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
  /** SDK request id used by `thread.respond`; defaults to `itemId`. */
  requestId?: string;
  logicalItemId?: string;
  kind: ApprovalKind;
  requestKind?: string;
  description: string;
  title?: string | null;
  source?: string;
  questions?: PendingInputQuestion[];
  options?: PendingInputOption[];
  allowsFreeform?: boolean;
  canProceedWithoutAnswer?: boolean;
  providerMetadata?: Record<string, unknown>;
  turnId?: string;
  detail?: unknown;
  /**
   * Optional on purpose: the SDK always knows which provider raised a request,
   * but a proxy that only forwards the chat surface may not, and this package
   * renders the same card either way.
   */
  provider?: ProviderId;
};

/** One option in a provider's structured question. */
export type PendingInputOption = {
  label: string;
  value: string;
  description?: string;
  recommended?: boolean;
  preview?: string;
  previewFormat?: "markdown" | "html";
};

/** A question the provider is waiting for the host to answer. */
export type PendingInputQuestion = {
  id: string;
  header?: string;
  question: string;
  options?: PendingInputOption[] | null;
  multiSelect?: boolean;
  allowsFreeform?: boolean;
  isSecret?: boolean;
  defaultAssumption?: string | null;
  impact?: string | null;
};

/** Decision values accepted by the runtime's respondToInput action. */
export type PendingInputDecision = "accept" | "accept_for_session" | "decline" | "cancel";

/** Answer payload for one pending question or plan request. */
export type PendingInputResponse = {
  answers?: Record<string, string | string[]>;
  decision?: PendingInputDecision;
  responseText?: string | null;
};

/** One message waiting in the SDK steer queue. */
export type QueuedMessage = {
  id: string;
  text: string;
  /** The files sent with it, as the SDK's file references. */
  attachments?: ReadonlyArray<{ path: string; type?: "file" | "image" }>;
  createdAt?: string;
  dispatched?: boolean;
};

/** Queue methods are optional so older SDK clients remain usable. */
export type ThreadQueue = {
  list?(): Promise<readonly QueuedMessage[]>;
  cancel?(id: string): Promise<void>;
  edit?(id: string, text: string): Promise<void>;
  move?(id: string, index: number): Promise<void>;
  dispatch?(id: string): Promise<void>;
  cancelDispatched?(id: string): Promise<void>;
  restore?(): Promise<void>;
};

/** One quota window of an account ("5-hour", "Weekly", …). */
export type AccountUsageWindow = {
  type: string;
  label: string;
  percentLeft: number;
  resetsAt: string | null;
  unlimited?: boolean;
  /** Exact request meter, for providers that count requests. */
  countLeft?: number;
  countTotal?: number;
};

/** Runtime-reported usage room for one provider account. */
export type AccountUsage = {
  /** `ok` is a fresh reading; the others say why the numbers are old or missing. */
  state: "ok" | "stale" | "expired" | "signed_out" | "no_reading" | "error" | (string & {});
  readAt: string | null;
  /** Why the state is not `ok`, in a few words. */
  note: string | null;
  windows: AccountUsageWindow[];
};

/** Public account summary. Secret values are never part of this shape. */
export type AccountInfo = {
  id: string;
  provider: ProviderId;
  label: string;
  email?: string;
  plan?: string;
  signedIn: boolean;
  isDefault: boolean;
  loginBroken?: boolean;
  usage?: AccountUsage;
};

/** A provider sign-in's status, as `@ade-dev/sdk`'s `SignInStatus` reports it. */
export type SignInUpdate = {
  loginId?: string;
  state: "running" | "verifying" | "succeeded" | "failed" | "cancelled" | "expired" | (string & {});
  /** The link to finish signing in, once the provider printed it. */
  url?: string | null;
  /** True while the provider waits for a code pasted back from the browser. */
  awaitingCode?: boolean;
  /** A device code to enter on the provider's page, when it uses one. */
  deviceCode?: string;
  message?: string;
};

export interface SignInHandle {
  on(event: "update", cb: (update: SignInUpdate) => void): Unsubscribe;
  submitCode(code: string): Promise<void>;
  cancel(): Promise<void>;
  done: Promise<AccountInfo>;
}

/** Non-secret credential metadata. The API key is deliberately absent. */
export type ApiCredentialInfo = {
  credentialId: string;
  provider: ProviderId;
  label: string;
  /** The last few characters of the key, so a person can tell keys apart. */
  maskedTail?: string;
  createdAt?: string;
};

export type ProviderCapabilities = {
  permissionModes?: string[];
  reasoningEfforts?: string[];
  fastMode?: boolean;
  multipleAccounts?: boolean;
  signIn?: "cli-login" | "device-code" | "api-key" | "none";
  apiKeys?: boolean;
  presets?: boolean;
  mcp?: "full" | "partial" | "none";
};

/** Client-level notification: one thread's usage-limit state changed. */
export type UsageLimitEvent = {
  /** Thread key. */
  key: string;
  sessionId?: string;
  provider?: ProviderId;
  /** Null when the limit cleared. */
  status: UsageLimitStatus | null;
};

/** Host-agnostic subset of the runtime's live usage-limit resume status. */
export type UsageLimitStatus = {
  state: "armed" | "resuming" | "paused" | "opted_out" | "no_reset" | "limited" | (string & {});
  provider?: ProviderId;
  fireAt?: string | null;
  resetAt?: string | null;
  turnId?: string | null;
  alternateAccount?: { instanceId: string; label: string } | null;
  alternateAccounts?: Array<{ id: string; label: string }>;
};

export type SlashCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
};

export type AccountManagement = {
  list?(provider?: ProviderId): Promise<readonly AccountInfo[]>;
  add?(provider: ProviderId, options?: { label?: string }): Promise<AccountInfo>;
  remove?(id: string): Promise<void>;
  rename?(id: string, label: string): Promise<AccountInfo | void>;
  setDefault?(id: string): Promise<void>;
  signOut?(id: string): Promise<void>;
  refresh?(): Promise<readonly AccountInfo[]>;
  signIn?(id: string, options?: { deviceAuth?: boolean }): Promise<SignInHandle>;
};

export type CredentialManagement = {
  list?(provider?: ProviderId): Promise<readonly ApiCredentialInfo[]>;
  add?(input: { provider: ProviderId; key: string; label?: string }): Promise<ApiCredentialInfo>;
  remove?(credentialId: string, provider?: ProviderId): Promise<unknown>;
  verify?(provider: ProviderId): Promise<unknown>;
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

/**
 * The MCP identity a runtime attaches to a tool event when it knows it (Codex
 * does, as `mcp: { server, tool }`). Preferred over parsing the tool string.
 */
export type ChatEventMcpSource = {
  server?: string;
  tool?: string;
};

export type ChatEventToolCall = {
  type: "tool_call";
  tool: string;
  args: unknown;
  itemId: string;
  logicalItemId?: string;
  turnId?: string;
  mcp?: ChatEventMcpSource;
};

/**
 * An MCP `resource_link` content item a tool returned, carried as data rather
 * than left inside the result text. The runtime fills it when the provider
 * reports structured tool content.
 */
export type AgentChatResourceLink = {
  uri: string;
  name?: string;
  title?: string;
  mimeType?: string;
};

export type ChatEventToolResult = {
  type: "tool_result";
  tool: string;
  result: unknown;
  itemId: string;
  logicalItemId?: string;
  turnId?: string;
  status?: ToolCallStatus;
  mcp?: ChatEventMcpSource;
  /** Structured MCP `resource_link` items, when the runtime passes them on. */
  resourceLinks?: AgentChatResourceLink[];
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
  /**
   * Set only on the SDK's own `"failed"` status for a runtime that went away
   * mid-turn (`@ade-dev/sdk` >= 0.3); the runtime never sends it. It ends the
   * turn like any `"failed"`.
   */
  synthetic?: true;
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

/** Options for one `historyPage` read. */
export type HistoryPageOptions = {
  /** Return envelopes strictly older than this sequence. Omit for the newest page. */
  beforeSequence?: number;
  /** Page size. The runtime caps it. */
  limit?: number;
};

/** One page of transcript history, oldest envelope first. */
export type ThreadHistoryPage = {
  events: AgentChatEventEnvelope[];
  /** More envelopes exist before this page. */
  hasMore: boolean;
  /**
   * Pass as `beforeSequence` to read the next older page. Null or absent when
   * the runtime gave none; the hook then pages from the oldest sequence it holds.
   */
  nextBeforeSequence?: number | null;
};

/** A change to an open thread's settings (`AdeThread.update`). */
export type ThreadUpdatePatch = {
  /** New title. `null` clears the host title. */
  title?: string | null;
  /** Reasoning effort for later turns. `null` returns to the model default. */
  reasoningEffort?: string | null;
  /** Provider fast mode, where the provider has one. */
  fastMode?: boolean;
};

/**
 * What `AdeThread.update` resolves to. An SDK thread resolves `{ title, model }`;
 * only `model` is read, and a client may resolve nothing.
 */
export type ThreadUpdateReply = { model?: unknown } | null | void;

/** The runtime lifecycle events a client can report (`AdeChatClient.on`). */
export type AdeChatClientEventMap = {
  /**
   * One automatic runtime restart attempt finished (`@ade-dev/sdk`
   * `autoRestart`). `ok: true` means the runtime is back and open threads were
   * reattached. `attempt` counts from 1 per outage.
   */
  restart: { attempt: number; ok: boolean; error: string | null; final?: boolean };
  usageLimit: UsageLimitEvent;
};

export interface AdeThread {
  readonly key: string;
  send(input: SendInput | string): Promise<void>;
  /**
   * Deliver a message into an already-running turn.
   *
   * Attachments on `input` are forwarded, and an attachment-only steer (empty
   * text) is valid. Both need `@ade-dev/sdk` >= 0.3: an older SDK thread's
   * `steer(text)` ignores the attachments, and refuses an empty text.
   */
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
  /** Answer a question or plan request. Older clients render those cards read-only. */
  respond?(requestId: string, response: PendingInputResponse): Promise<void>;
  /** Optional steer queue operations. */
  queue?: ThreadQueue;
  /** Available provider slash commands, when the runtime exposes them. */
  slashCommands?(): Promise<readonly SlashCommand[]>;
  /** Per-thread usage-limit controls. */
  usageLimit?: {
    /** Answers `{ ok: false, message }` when the runtime refuses. */
    resumeNow?(): Promise<unknown>;
    continueOnAlternate?(): Promise<unknown>;
  };
  /** Switch this thread to another signed-in provider account. */
  switchAccount?(instanceId: string): Promise<unknown>;
  history(): Promise<AgentChatEventEnvelope[]>;
  /**
   * Read one page of history, newest first by page (each page oldest-first).
   *
   * OPTIONAL: `useAdeThread` uses it when present — the newest page on open,
   * older pages on demand — and falls back to one `history()` read otherwise.
   * A client without it (an SDK before 0.3, a proxy) loads the whole window.
   */
  historyPage?(request?: HistoryPageOptions): Promise<ThreadHistoryPage>;
  /**
   * The model the runtime has this thread on, resolved (see `ThreadModelSelection`).
   *
   * OPTIONAL: read after `open` and after every `setModel`. Absent or null on a
   * client that does not report it, and the UI then names the model from the
   * catalog alone.
   */
  readonly model?: ThreadModelSelection | null;
  /**
   * Change the thread's title, reasoning effort or fast mode
   * (`@ade-dev/sdk` >= 0.3 `thread.update`).
   *
   * OPTIONAL for the same reason as `setModel`. `ThreadState.canUpdate`
   * reports its presence. A reasoning or fast-mode change is refused while a
   * turn runs (`AdeError` code `turn_in_flight` on `@ade-dev/sdk` >= 0.4).
   */
  update?(patch: ThreadUpdatePatch): Promise<ThreadUpdateReply>;
  /**
   * Run the last user message again (`@ade-dev/sdk` >= 0.4 `thread.retry`).
   * The runtime rolls the provider conversation back to before that message,
   * removes the old turn from the transcript, and sends the message again.
   * Files the old turn changed are not restored.
   *
   * OPTIONAL like `setModel`; `ThreadState.canRetry` reports its presence. A
   * provider that cannot roll back (only Claude and Codex can) rejects with
   * code `unsupported`, and a running turn with `turn_in_flight`.
   */
  retry?(): Promise<unknown>;
  /**
   * Like `retry`, with new text for the last user message. `attachments`
   * replaces the original message's attachments; an empty list removes them,
   * and leaving it out keeps them.
   */
  editLast?(input: SendInput | string): Promise<unknown>;
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
    capabilities?(provider: ProviderId): Promise<ProviderCapabilities | null>;
  };
  models: {
    list(): Promise<ModelDescriptor[]>;
  };
  threads: {
    open(key: string, opts?: ThreadOpenOptions): Promise<AdeThread>;
  };
  /** Account management is optional and disabled for untrusted renderers by default. */
  accounts?: AccountManagement;
  /** Credential operations accept a key but never return one. */
  credentials?: CredentialManagement;
  /**
   * Runtime lifecycle events.
   *
   * OPTIONAL: a client without a runtime it can restart has nothing to report.
   * `useAdeThread` subscribes to `restart` and, after a successful restart,
   * re-opens the thread and re-reads its history, so the transcript shows what
   * the runtime has rather than what this view held before the outage.
   */
  on?<E extends keyof AdeChatClientEventMap>(
    event: E,
    cb: (payload: AdeChatClientEventMap[E]) => void,
  ): Unsubscribe;
}
