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
  /** Present only when the chat was created with an MCP request. */
  mcpCapability?: McpCapabilityReport;
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
 * Per-provider authentication/availability roll-up.
 *
 * DERIVED, not reported: the machine scope has no dedicated provider-auth RPC
 * (confirmed with the engine agent for unit 1), so this is computed from the
 * model catalog's `connected` / `isAvailable` / `requiresConfiguration` flags.
 * If a real `providers.status` method lands, swap the derivation for it.
 */
export type ProviderStatus = {
  provider: string;
  displayName: string;
  /** True when at least one model of the provider reports `connected`. */
  authenticated: boolean;
  /** True when at least one model is usable right now. */
  available: boolean;
  /** True when every usable path needs setup first. */
  requiresConfiguration: boolean;
  modelCount: number;
  /** True when the catalog rows behind this verdict were served stale. */
  stale: boolean;
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
