/**
 * Wire types for the ADE machine-scoped chat surface.
 *
 * PROVENANCE — every type in this file is a hand-copied subset of ADE's own
 * shared contracts. The package deliberately does NOT import across the repo
 * boundary (`apps/desktop/src/shared/**`) so it builds and publishes on its
 * own. When the engine contract moves, this file moves with it:
 *
 *   - `AgentChatEventEnvelope`, `AgentChatEvent`, `AgentChatSessionSummary`,
 *     `AgentChatCreateArgs`, `AgentChatSendArgs`, `AgentChatSteerArgs`,
 *     `AgentChatModelCatalog*`, permission-mode unions
 *       <- apps/desktop/src/shared/types/chat.ts
 *   - `PersonalChatAction`, `PersonalChatCallResponse`,
 *     `PersonalChatCapabilities`, `PersonalChatStreamEventsResult`
 *       <- apps/desktop/src/shared/types/personalChats.ts
 *   - `BufferedEvent`, drain/gap semantics
 *       <- apps/ade-cli/src/eventBuffer.ts
 *
 * The event union in `chat.ts` has ~60 members and grows every release, so it
 * is modelled here as an open record with a `type` discriminant plus narrowed
 * shapes for the members an SDK consumer actually renders. Unknown members
 * pass through untouched rather than being dropped or failing a parse.
 */

/** Chat providers ADE can drive. Kept closed at the SDK boundary on purpose. */
export type AdeProvider =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "opencode"
  | "pi";

export type AgentChatSessionStatus = "active" | "idle" | "ended";

export type AgentChatPermissionMode =
  | "default"
  | "auto"
  | "plan"
  | "edit"
  | "full-auto"
  | "config-toml";

export type AgentChatClaudePermissionMode =
  | "default"
  | "auto"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";

export type AgentChatCodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "on-failure"
  | "never";

export type AgentChatCodexSandbox =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type AgentChatOpenCodePermissionMode =
  | "plan"
  | "edit"
  | "full-auto"
  | "config-toml";

export type AgentChatDroidPermissionMode =
  | "read-only"
  | "auto-low"
  | "auto-medium"
  | "auto-high"
  | "agi";

/**
 * Which on-disk configuration layers a provider loads for a thread.
 *
 * `"none"` is the default for SDK threads and is what every 0.1.x thread got.
 * The four values are sent verbatim; the engine decides what each one means per
 * provider, and reports the answer on {@link AgentChatSessionSummary}.
 */
export type AgentChatSettingSources = "none" | "project" | "user" | "all";

/** Host instructions for one thread, in the normalized wire form. */
export type AgentChatInstructions = {
  mode: "append" | "replace";
  text: string;
};

/**
 * How completely a provider honoured a host configuration request.
 *
 * The same three-value vocabulary the MCP report uses, for the same reason:
 * four of the six providers cannot do the thing exactly, and a report that said
 * only "applied" would be a lie for most embedders.
 *
 *   - `"applied"` — the provider received the value through a first-class
 *     channel of its own.
 *   - `"best-effort"` — ADE reached the same outcome through a mechanism it
 *     already owns (a prompt prefix, a containment root), and `detail` names
 *     what that costs.
 *   - `"ignored"` — the provider has no switch for it and the value did not
 *     reach the model. `detail` says so.
 */
export type AgentChatHostConfigLevel = "applied" | "best-effort" | "ignored";

/**
 * Per-thread MCP server definition. Mirrors `AgentChatMcpServerConfig` on the
 * engine side (unit 1). Passing these sets `mcpServers` on the create call;
 * `loadUserMcpServers: false` additionally sets `strictMcpConfig: true`.
 */
export type McpServerConfig =
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

/**
 * What the provider could actually do with a caller's MCP request.
 *
 * Mirrors `AgentChatMcpCapability` in chat.ts. Only ADE's Claude adapter can
 * enforce strict mode outright; the rest are best-effort with a named residual,
 * and Pi has no MCP surface at all (a thread that asks for `mcpServers` on Pi
 * is refused by the runtime rather than silently opened without them).
 *
 * Read `strictRequested` FIRST, then `level`. `level` and `residual` describe
 * strict mode, so they only make a claim when strict mode was requested; on a
 * delivery-only thread (`loadUserMcpServers: true`) the user's own config loads
 * by design and no level value means "only my tools are loaded".
 *
 * Given `strictRequested`, `level` is the field to branch on, and `"enforced"`
 * is the ONLY value that means "nothing but the servers I supplied". Treating
 * `"best-effort"` as a synonym is the mistake this type exists to prevent —
 * four of the six providers report it, so an embedder that branches on
 * truthiness rather than on the level will overpromise for most of its users.
 *
 * Surface `residual` when it is non-null: "your servers are loaded, and so is
 * X" is a materially different guarantee from "only yours". The residual text
 * comes from the provider adapter and names the specific leak, so it is safe
 * to show verbatim.
 */
export type McpCapabilityReport = {
  /**
   * What strict mode achieved — meaningful ONLY when `strictRequested` is true.
   * Read that field first.
   */
  level: "enforced" | "best-effort" | "unsupported";
  /**
   * How the provider implemented the request, for logs and support threads.
   *
   * Describes ENFORCEMENT when `strictRequested` is true, and DELIVERY (how the
   * supplied servers were handed to the provider) when it is false.
   */
  mechanism: string;
  /**
   * What strict mode could NOT exclude, or null when nothing leaked through.
   *
   * Always null when `strictRequested` is false: nothing was asked to be
   * excluded, so nothing leaked.
   */
  residual: string | null;
  /**
   * Whether this thread asked ADE to withhold the user's and project's own MCP
   * config — i.e. `loadUserMcpServers: false`, explicitly or by supplying
   * `mcpServers` without opting back in.
   *
   * THE FIRST FIELD TO READ. When it is false the caller asked for delivery
   * only: the user's own MCP config loads by design, and `level` makes no
   * isolation claim at all — treating `level === "enforced"` as "only my tools
   * are loaded" on a delivery-only thread would be exactly backwards.
   *
   * An older runtime that predates the field omits it, and the SDK reports
   * false rather than guessing. That is the conservative direction: it
   * understates isolation instead of promising one that was never verified.
   */
  strictRequested: boolean;
  /**
   * False when the provider has no MCP surface and supplied servers were
   * dropped.
   *
   * PREFER `level`. On a current runtime this is effectively always true —
   * `create` refuses the only case that would make it false — so branching on
   * it tells you nothing that `level` does not tell you better. It is retained
   * because it is part of the published shape, not because it is useful.
   *
   * Older runtimes additionally returned false for a strict-only request
   * (strict mode with no servers) that had in fact been enforced, which made
   * `!delivered` read a success as a failure. Anything keyed on this field
   * against a pre-fix runtime is suspect; `level === "unsupported"` is the
   * check that was always correct.
   */
  delivered: boolean;
};

/** File attachment reference accepted by send/steer. */
export type AgentChatFileRef = {
  path: string;
  name?: string;
  mimeType?: string;
  bytes?: number;
};

/**
 * One transcript event. The `type` field is the discriminant; the remaining
 * fields are provider- and type-specific and are preserved verbatim.
 */
export type AgentChatEvent = {
  type: string;
  [key: string]: unknown;
};

/**
 * Which provider raised a pending input request.
 *
 * `"acp"` covers all four ACP dialects, because the permission round trip is
 * one method there. `"ade"` is a request ADE staged itself.
 */
export type PendingInputSource =
  | "claude"
  | "codex"
  | "cursor"
  | "droid"
  | "opencode"
  | "pi"
  | "acp"
  | "ade";

/**
 * What the provider is asking for.
 *
 * `"approval"` and `"permissions"` are the two approval-shaped kinds — a
 * yes/no on an action the model wants to take. The other four want prose or a
 * choice, and `AdeThread.approve` cannot answer them: render them read-only.
 */
export const PENDING_INPUT_KINDS = [
  "approval",
  "question",
  "structured_question",
  "permissions",
  "plan_approval",
  "model_selection",
] as const;

export type PendingInputKind = (typeof PENDING_INPUT_KINDS)[number];

export type PendingInputOption = {
  label: string;
  value: string;
  description?: string;
  recommended?: boolean;
  preview?: string;
  previewFormat?: "markdown" | "html";
};

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

/**
 * One unresolved request the provider is blocked on.
 *
 * Mirrors `PendingInputRequest` in chat.ts. Returned by the `pendingInputs`
 * action and mapped to the SDK's {@link ApprovalRequest} shape before it
 * reaches a caller.
 */
export type PendingInputRequest = {
  requestId: string;
  itemId?: string;
  source: PendingInputSource;
  kind: PendingInputKind;
  title?: string | null;
  description?: string | null;
  questions: PendingInputQuestion[];
  allowsFreeform: boolean;
  blocking: boolean;
  canProceedWithoutAnswer: boolean;
  options?: PendingInputOption[];
  providerMetadata?: Record<string, unknown>;
  autoResolutionMs?: number | null;
  turnId?: string | null;
};

/** Result of the `pendingInputs` action. */
export type PendingInputsResult = {
  requests: PendingInputRequest[];
};

/** The narrowed members most consumers actually branch on. */
export type KnownAgentChatEvent =
  | { type: "user_message"; text: string; displayText?: string; messageId?: string; turnId?: string }
  | { type: "text"; text: string; messageId?: string; turnId?: string }
  | { type: "reasoning"; text?: string; turnId?: string }
  | { type: "tool_call"; tool: string; args: unknown; itemId: string; turnId?: string }
  | { type: "tool_result"; tool: string; result: unknown; itemId?: string; turnId?: string }
  | { type: "tokens"; [key: string]: unknown }
  | { type: "context_usage"; [key: string]: unknown }
  | { type: "codex_token_usage"; [key: string]: unknown }
  | {
      /**
       * The provider is blocked and wants a decision. Answer it with
       * `thread.approve(itemId, …)`.
       *
       * AN UNANSWERED REQUEST BLOCKS THE TURN. There is no timeout anywhere in
       * the runtime: the turn stays parked until `approve()` or `interrupt()`.
       * A host that receives this event and renders nothing has a chat that
       * looks frozen, so render a card for every one of them.
       */
      type: "approval_request";
      itemId: string;
      logicalItemId?: string;
      kind: "command" | "file_change" | "tool_call";
      description: string;
      turnId?: string;
      detail?: unknown;
      /**
       * The finer-grained kind. `"question"` and the other prose kinds ride
       * this event because `kind` has no word for a question — they cannot be
       * answered with approve/decline, so render them read-only.
       */
      requestKind?: PendingInputKind;
    }
  | {
      /** An `approval_request` with this `itemId` is settled. Upgrade the card. */
      type: "pending_input_resolved";
      itemId: string;
      resolution: "accepted" | "declined" | "cancelled";
      answers?: Record<string, string | string[]>;
      turnId?: string;
    }
  | { type: "status"; [key: string]: unknown }
  | { type: "error"; [key: string]: unknown }
  | { type: "done"; [key: string]: unknown };

/** Event types the SDK routes to the `usage` channel of `AdeThread.on`. */
export const USAGE_EVENT_TYPES = [
  "tokens",
  "context_usage",
  "codex_token_usage",
] as const;

/** Event types the SDK routes to the `status` channel of `AdeThread.on`. */
export const STATUS_EVENT_TYPES = [
  "status",
  "done",
  "error",
  "turn_health",
  "session_meta_updated",
  "interrupt_receipt",
] as const;

export type AgentChatEventEnvelope = {
  sessionId: string;
  timestamp: string;
  event: AgentChatEvent;
  sequence?: number;
  provenance?: {
    messageId?: string;
    providerMessageId?: string;
    threadId?: string | null;
    role?: "user" | "orchestrator" | "worker" | "agent" | null;
    [key: string]: unknown;
  };
};

export type AgentChatSessionSummary = {
  sessionId: string;
  laneId: string;
  provider: string;
  model: string;
  title?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: AgentChatPermissionMode;
  status: AgentChatSessionStatus;
  startedAt: string;
  endedAt: string | null;
  archivedAt?: string | null;
  lastActivityAt: string;
  lastOutputPreview: string | null;
  summary: string | null;
  awaitingInput?: boolean;
  /**
   * The working directory the runtime actually bound the session to, echoed
   * back in its own spelling. Present only when one was requested.
   *
   * This is the canonical answer: the engine resolves the path before it
   * stores it, so a symlinked or differently-cased spelling of one directory
   * comes back as one string. A client that records the caller's spelling
   * instead reports a resume mismatch on a `cwd` that never changed.
   */
  requestedCwd?: string | null;
  /** Present only when the chat was created with an MCP request. */
  mcpCapability?: McpCapabilityReport;
  /**
   * Present only when the chat was created with `instructions`. Absent means
   * nothing was requested — NOT that the request was dropped.
   */
  instructionsCapability?: {
    level: AgentChatHostConfigLevel;
    mode: "append" | "replace";
    mechanism: string;
    detail: string | null;
  } | null;
  /** Present only when the chat was created with `settingSources`. */
  settingSourcesCapability?: {
    level: AgentChatHostConfigLevel;
    value: AgentChatSettingSources;
    mechanism: string;
    detail: string | null;
  } | null;
  /** Present only when the chat was created with a permission policy. */
  permissionCapability?: {
    level: "enforced" | "best-effort" | "unsupported";
    mechanism: string;
    residual: string | null;
  } | null;
  [key: string]: unknown;
};

/** Result shape of `personalChats.call` action `getEventHistory`. */
export type AgentChatEventHistorySnapshot = {
  events: AgentChatEventEnvelope[];
  truncated: boolean;
  hasOlderHistory?: boolean;
  [key: string]: unknown;
};

export type AgentChatModelInfo = {
  id: string;
  displayName: string;
  description?: string | null;
  isDefault: boolean;
  defaultReasoningEffort?: string | null;
  reasoningEfforts?: Array<{ effort: string; description: string }>;
  [key: string]: unknown;
};

export type AgentChatModelCatalogModel = AgentChatModelInfo & {
  runtimeModelId: string;
  provider: string;
  providerKey: string;
  groupKey: string;
  isAvailable: boolean;
  connected?: boolean;
  requiresConfiguration?: boolean;
  stale?: boolean;
};

export type AgentChatModelCatalogSubsection = {
  key: string;
  label: string;
  models: AgentChatModelCatalogModel[];
};

export type AgentChatModelCatalogProvider = {
  key: string;
  displayName: string;
  badgeColor: string;
  modelCount: number;
  subsections: AgentChatModelCatalogSubsection[];
};

export type AgentChatModelCatalogGroup = {
  key: string;
  displayName: string;
  providers: AgentChatModelCatalogProvider[];
};

export type AgentChatModelCatalog = {
  groups: AgentChatModelCatalogGroup[];
  fetchedAt: string;
  stale?: boolean;
};

/** Flattened, SDK-facing model row. */
export type ModelCatalogEntry = {
  /** Canonical ADE registry id — this is what `ThreadOpenOptions.model` takes. */
  id: string;
  displayName: string;
  provider: string;
  /** Provider-native model ref ADE sends under the hood. */
  runtimeModelId: string;
  isDefault: boolean;
  isAvailable: boolean;
  connected: boolean;
  requiresConfiguration: boolean;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  description: string | null;
};

/**
 * Per-provider installation, authentication and availability roll-up.
 *
 * READ `source` FIRST. It is the field that says how much the rest of the
 * record is worth:
 *
 *   - `"probed"` — the runtime resolved the binary the provider would actually
 *     spawn, ran `--version`, and looked at the credential files the CLI itself
 *     uses. `installed`, `binaryPath`, `version` and `authenticated` are real
 *     measurements.
 *   - `"derived"` — the runtime is older than the `providers.status` RPC, so
 *     everything here comes from the model catalog. `installed` is
 *     `modelCount > 0`, the three probe fields are null, and a UI should say
 *     "not detected" rather than "not installed".
 */
export type ProviderStatus = {
  provider: string;
  displayName: string;
  /**
   * A usable binary or package was found.
   *
   * On a derived record this is `modelCount > 0`, which answers a different
   * question — "does ADE know models for this provider" — so do not present it
   * as a filesystem fact unless `source` is `"probed"`.
   */
  installed: boolean;
  /** Absolute path the runtime would spawn. Null when not found or derived. */
  binaryPath: string | null;
  /** Verbatim first line of `--version`. Null on a timeout, or when derived. */
  version: string | null;
  /**
   * Credentials the CLI can use were found.
   *
   * On a probed record this is a credential-file check. On a derived one it
   * means "the catalog resolved at least one connected model", which a stale
   * catalog can report after the credential expired — `stale` carries that.
   */
  authenticated: boolean;
  /** How, when the probe could tell: subscription, api-key, oauth, unknown. */
  authMethod?: string | null;
  /** Remediation ADE supplies. Null on a derived record. */
  installCommand: string | null;
  loginCommand: string | null;
  docsUrl: string | null;
  /** True when at least one model is usable right now. */
  available: boolean;
  /** True when every usable path needs setup first. */
  requiresConfiguration: boolean;
  modelCount: number;
  /**
   * True when something behind this verdict was served from the cache rather
   * than probed on this call: a cached model catalog, or a cached probe record.
   * It does not mean the record is past the runtime's TTL — a record inside the
   * TTL is served from the cache and is stale by this definition.
   */
  stale: boolean;
  /** How this record was produced. Read this before trusting the rest. */
  source: "probed" | "derived";
  /** ISO timestamp of the probe, or of the derivation. */
  checkedAt: string;
  /** Human-readable note from the probe, when it had one. */
  detail?: string | null;
};

/**
 * One provider record as the `providers.status` RPC sends it.
 *
 * NOT a `Partial<ProviderStatus>`. `ProviderStatus` is this SDK's OUTPUT type
 * and carries four fields only the model catalog can answer — `available`,
 * `requiresConfiguration`, `modelCount` and the `"derived"` half of `source` —
 * which the probe never sends and `mergeProviderStatus` deliberately takes from
 * the catalog instead. Declaring them here would admit members that never
 * occur.
 *
 * Every field is optional and widely typed on purpose: this is untrusted wire
 * data, and `mergeProviderStatus` re-reads each one through its own guard. The
 * shape is the one documented in `docs/features/sdk/README.md`.
 */
export type ProviderStatusProbeRecord = {
  provider?: string;
  displayName?: string;
  installed?: boolean;
  binaryPath?: string | null;
  version?: string | null;
  authenticated?: boolean;
  authMethod?: string | null;
  installCommand?: string | null;
  loginCommand?: string | null;
  docsUrl?: string | null;
  source?: "probed";
  stale?: boolean;
  checkedAt?: string;
  detail?: string | null;
};

/** Result of the `providers.status` machine RPC. */
export type ProviderStatusRpcResult = {
  checkedAt: string;
  providers: Record<string, ProviderStatusProbeRecord>;
};

export type ThreadSummary = {
  /** Stable caller-chosen key. Null for chats created outside the SDK. */
  key: string | null;
  sessionId: string;
  provider: string;
  model: string;
  title: string | null;
  status: AgentChatSessionStatus;
  startedAt: string;
  lastActivityAt: string;
  archived: boolean;
};

export type DoctorReport = {
  ok: boolean;
  /**
   * Version of this SDK package. Reported alongside the runtime version
   * because a mismatched pair is the first thing to check when an embedder's
   * chat misbehaves: the two ship on separate cadences, and the SDK is the
   * half that lives inside the embedder's own build.
   */
  sdkVersion: string;
  binary: {
    path: string;
    /** Version string reported by `<binary> --version`, when it answered. */
    version: string | null;
    source: "option" | "path" | "download" | "cache";
    /**
     * Whether THIS client verified the binary against a published SHA256SUMS.
     *
     * False is not an accusation — a caller-supplied `binaryPath`, an `ade`
     * found on PATH, and a reuse of an earlier download are all unverified by
     * this client because it did not fetch them. It is only meaningful as
     * "provenance was checked here", which is what an operator wants to know
     * when auditing where the running binary came from.
     */
    checksumVerified: boolean;
  };
  /**
   * Runtime provenance: which of the five resolution steps produced the binary,
   * where its native modules came from, and whether the OS considers it signed.
   *
   * `binary` above is the 0.1.x view and keeps its four `source` values.
   * `source` and `signature` here are the two fields to put in a support
   * bundle: together they separate "the app is running the runtime we signed
   * and shipped" from "the app quietly downloaded one on this machine", which
   * is the difference an embedder cannot otherwise see.
   */
  runtime: {
    source:
      | "explicit"
      | "bundled-package"
      | "cached-download"
      | "path"
      | "downloaded"
      | "attached";
    binaryPath: string;
    version: string | null;
    /** `ADE_RUNTIME_ROOT` as spawned, or null when the install carries its own. */
    runtimeRoot: string | null;
    /** `ADE_RUNTIME_NODE_MODULES` as spawned. */
    nodeModulesPath: string | null;
    /**
     * macOS and Windows only. Null on Linux, in attach mode, and whenever the
     * check could not run — "not known", never "not signed".
     */
    signature: { signed: boolean; authority?: string; accepted?: boolean } | null;
    /** True only when THIS client downloaded a runtime during its lifetime. */
    downloadedThisSession: boolean;
    checksumVerified: boolean;
  };
  socket: {
    path: string;
    connected: boolean;
    /** Runtime info from the `ade/initialize` result, when the runtime sent it. */
    runtimeVersion: string | null;
    pid: number | null;
  };
  events: {
    mode: "push" | "drain" | "unavailable";
    /** Buffer epoch last observed; a change means the runtime restarted. */
    epoch: string | null;
    gapsRecovered: number;
  };
  providers: Record<string, ProviderStatus>;
  threads: { tracked: number; live: number };
  /** Most recent errors the client recorded, newest last. Capped. */
  recentErrors: Array<{ at: string; scope: string; message: string }>;
};

/** BufferedEvent as produced by `apps/ade-cli/src/eventBuffer.ts`. */
export type BufferedEvent = {
  id: number;
  timestamp: string;
  category: "orchestrator" | "dag_mutation" | "runtime" | "pty";
  payload: Record<string, unknown>;
};

export type PersonalChatStreamEventsResult = {
  events: BufferedEvent[];
  nextCursor: number;
  hasMore: boolean;
  eventEpoch?: string | null;
  gap?: boolean;
  oldestCursor?: number | null;
};

export type PersonalChatSubscribeEventsResult = PersonalChatStreamEventsResult & {
  subscriptionId: string;
};

export type PersonalChatCallResponse<T = unknown> = {
  action: string;
  result: T;
};

export type PersonalChatCapabilities = {
  version: number;
  actions: string[];
  /** Unit-1 addition: true when `personalChats.subscribeEvents` exists. */
  pushEvents?: boolean;
  /** Unit-1 addition: true when create honours `mcpServers`/`strictMcpConfig`. */
  mcpServers?: boolean;
};

export type AdeInitializeResult = {
  runtimeInfo?: {
    version?: string | null;
    buildHash?: string | null;
    pid?: number | null;
    multiProject?: boolean;
    [key: string]: unknown;
  };
  capabilities?: {
    personalChats?: PersonalChatCapabilities;
    /**
     * Present when the runtime serves the real `providers.status` RPC. Absent
     * means the SDK derives provider status from the model catalog instead.
     */
    providers?: {
      status?: boolean;
      /** How long the runtime caches a probe. Reported for documentation. */
      cacheTtlMs?: number;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** Notification payload for `runtime/event`. */
export type RuntimeEventNotification = {
  subscriptionId?: string;
  projectId?: string | null;
  scope?: "personal" | "project";
  event?: unknown;
  eventEpoch?: string | null;
};

export type Unsubscribe = () => void;
