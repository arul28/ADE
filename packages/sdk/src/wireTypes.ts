/**
 * The runtime's wire shapes the SDK decodes internally: the event buffer, the
 * `personalChats.call` envelope, and the `ade/initialize` answer. None of them
 * reaches a public signature except through `types.ts`, which re-exports them
 * so existing imports keep working.
 */

/**
 * The categories `apps/ade-cli/src/eventBuffer.ts` carried when this SDK
 * version was written. Listed for autocomplete, not for exhaustiveness.
 *
 * `runtime` is the only one the SDK decodes: it is the chat-envelope channel.
 * `pty` is terminal bytes the SDK has no surface for, and `cto_voice` is live
 * CTO call state — which carries a call's running transcript, is fail-closed to
 * the `cto` role at the runtime, and never reaches an `agent`-role sidecar like
 * this one. Neither is ever handed to a subscriber.
 */
export type KnownBufferedEventCategory =
  | "orchestrator"
  | "dag_mutation"
  | "runtime"
  | "pty"
  | "cto_voice";

/**
 * BufferedEvent as produced by `apps/ade-cli/src/eventBuffer.ts`.
 *
 * `category` is deliberately OPEN. The runtime is downloaded and can be newer
 * than the SDK that drives it, so a category this build has never heard of is
 * an ordinary event, not a bug — and the drain fallback polls
 * `personalChats.streamEvents` without a category filter, so it sees every one
 * the buffer holds. `chatEnvelopeFromBufferedEvent` gates on `"runtime"`
 * exactly, which is what keeps an unknown category from ever being mistaken for
 * chat. A closed union here would have made that tolerance unstateable.
 */
export type BufferedEvent = {
  id: number;
  timestamp: string;
  category: KnownBufferedEventCategory | (string & {});
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
  /**
   * True when `updateSession` accepts `mcpServers` for a personal session,
   * replacing the caller servers wholesale. Absent on runtimes before 1.2.81.
   */
  updateMcpServers?: boolean;
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
