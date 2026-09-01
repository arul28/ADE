/**
 * Plugin SDK v0 — the contract between ADE and plugin code.
 *
 * Pure types and pure helpers. Imported by the daemon (which implements the
 * host half), by the child bootstrap (which implements the `ade` global), by
 * `apps/ade-cli` (the `ade plugin` command) and by the desktop renderer.
 *
 * The stability promise, in three parts:
 *
 * 1. **`SDK_VERSION` is the compatibility handshake, and it is additive.** The
 *    host announces it in the child's `hello` frame. A plugin written against
 *    v0 keeps working when the host moves to v1: methods are added, never
 *    removed or re-shaped. Anything that would break a shipped plugin needs a
 *    new method name, not a new signature on the old one.
 * 2. **Every budget is enforced by the WRITER, inside its transaction.** The
 *    constants below are not advice to the plugin — they are the numbers the
 *    host checks before a row lands, and a plugin that exceeds one gets a typed
 *    {@link PluginSdkErrorCode} refusal it can act on, never a silent truncation.
 *    `dbMaintenanceApi.ts`'s doctor pass re-exports these rather than
 *    redeclaring them, so the writer and the doctor can never disagree about
 *    a ceiling.
 * 3. **Transport is NDJSON over the child's stdio, one JSON object per line.**
 *    stdin is open for the RPC channel and nothing else; the child never reads
 *    user input, and the host gates every write on `writable`. Errors cross the
 *    boundary as {@link PluginStructuralError}, never as a stringified stack.
 *
 * Plugin code runs ONLY on the machine that owns the plugin. There is no
 * remote-execution path in v0: a device that lacks the plugin renders nothing
 * for it, and the data-owning machine computes every contribution.
 */

import { PLUGIN_URL_MAX_CHARS, bounded, httpsUrl, isRecord, oneOf } from "./parse";
import { isValidPluginManifestIdentifier } from "./manifest";
import type {
  PluginAuthCallbackKind,
  PluginManifest,
  PluginManifestAutomationStep,
  PluginManifestAutomationTrigger,
  PluginManifestKeybinding,
  PluginManifestSearchProvider,
  PluginManifestSetting,
  PluginManifestUrlMatcher,
  PluginSurfaceKind,
} from "./manifest";
import type { PluginRegistryEntry } from "./registryIndex";
// Re-exported below so a plugin author types `sessionSetup` from the SDK entry
// point rather than reaching into a host module path.
import type { PluginSessionContextFile, PluginSessionSetup } from "./sessionSetup";
import type { IssueRef } from "../issueRef";
import type {
  IssueLink,
  IssueLinkRole,
  LaneIcon,
  LaneStatus,
  LaneSummary,
  LaneType,
} from "../types/lanes";
import { isPluginDialogField } from "./sockets";
import type {
  PluginDialogField,
  PluginDialogKind,
  PluginEntityKind,
  PluginSocketKind,
  PluginSurfaceId,
} from "./sockets";

/** SDK surface version announced to the child in `hello`. */
export const PLUGIN_SDK_VERSION = 0;

export type { PluginSessionContextFile, PluginSessionSetup };

// ---------------------------------------------------------------------------
// Budgets (writer-enforced — see the module header)
// ---------------------------------------------------------------------------

/** Total `plugin_collections` bytes one plugin may hold on one machine. */
export const PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN = 2 * 1024 * 1024;

/** Total `plugin_collections` rows one plugin may hold. */
export const PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN = 4_000;

/** Largest single collection value. */
export const PLUGIN_COLLECTION_VALUE_MAX_BYTES = 64 * 1024;

/**
 * Rows one `collections.put` may evict before it gives up and refuses.
 *
 * A bound rather than "delete until it fits" because eviction runs inside the
 * write transaction: an unbounded loop on a plugin whose next value is enormous
 * would hold the write lock while it emptied the collection row by row, and on
 * a CRR every one of those deletes is a replicated change. 200 is far more than
 * a plugin storing sanely-sized values ever needs to free one slot, and a write
 * that cannot fit inside it is a write that should be refused rather than paid
 * for by the rest of the collection.
 */
export const PLUGIN_COLLECTION_MAX_EVICTIONS_PER_PUT = 200;

/** Total `plugin_contributions` rows one plugin may publish. */
export const PLUGIN_CONTRIBUTIONS_MAX_PER_PLUGIN = 2_000;

/** Largest single contribution payload. Contributions are glances, not pages. */
export const PLUGIN_CONTRIBUTION_PAYLOAD_MAX_BYTES = 4 * 1024;

/** Panels one plugin may register. */
export const PLUGIN_PANELS_MAX_PER_PLUGIN = 32;

/** Largest panel schema. Matches the vocabulary contract's own schema ceiling. */
export const PLUGIN_PANEL_SCHEMA_MAX_BYTES = 64 * 1024;

/** Collection and key names: identifiers, never paths. */
export const PLUGIN_COLLECTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
export const PLUGIN_COLLECTION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

/** Secret names, matching the project-secret store's own rule. */
export const PLUGIN_SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

// ---------------------------------------------------------------------------
// Webhook ingress budgets (see `main/services/plugins/pluginWebhookIngressService.ts`)
// ---------------------------------------------------------------------------

/**
 * The secret ADE registers with the relay on a plugin's behalf, in the plugin's
 * own secret namespace.
 *
 * Reserved: `secrets.set`/`delete` refuse it, because a plugin that overwrote
 * it would silently deauthorize its own ingress and the relay would keep
 * accepting posts nobody could read. It is generated by the host, never by the
 * plugin, and never returned to the child.
 */
export const PLUGIN_WEBHOOK_SECRET_NAME = "ADE_WEBHOOK_RELAY_SECRET";

/** Relay-registered secret length, matching the relay's own floor. */
export const PLUGIN_WEBHOOK_SECRET_BYTES = 32;

/**
 * The channel a plugin gets when it names none.
 *
 * Its URL has no channel segment at all — `/plugin/<id>/webhook` — so a plugin
 * with one integration hands the user the shortest thing that can work.
 */
export const PLUGIN_WEBHOOK_DEFAULT_CHANNEL = "default";

/**
 * Largest webhook body one delivery carries to a plugin child.
 *
 * Far below the relay's own 1 MiB ceiling on purpose: the relay is storing, the
 * child is being WRITTEN TO, one NDJSON line at a time, over a pipe shared with
 * every other frame that child gets. A body past this is delivered truncated
 * with `truncated: true` rather than dropped — a plugin told nothing arrived
 * would go looking for a delivery failure that did not happen.
 */
export const PLUGIN_WEBHOOK_BODY_MAX_BYTES = 64 * 1024;

/**
 * Headers a delivery may carry to the child.
 *
 * An allowlist rather than a denylist, and narrower than the relay's own stored
 * set, because this is the boundary that matters: everything past here is read
 * by third-party code. Authorization, cookies and anything else a sender
 * attached are dropped without being named.
 */
export const PLUGIN_WEBHOOK_HEADER_ALLOWLIST = [
  "content-type",
  "user-agent",
  "x-webhook-event",
  "x-webhook-id",
  "x-webhook-timestamp",
  "x-github-event",
  "x-github-delivery",
  "x-event-key",
  "x-request-id",
  "x-idempotency-key",
] as const;

/** Longest header value delivered. Past this the value is clipped, not dropped. */
export const PLUGIN_WEBHOOK_HEADER_VALUE_MAX_CHARS = 512;

/**
 * Deliveries handed to one plugin inside one drain tick.
 *
 * The same ceiling `automations.emitTrigger` uses on bursts, for the same
 * reason: a backlog drain that woke a plugin four hundred times in one tick
 * would be indistinguishable from an attack on it. The rest wait for the next
 * tick, which is seconds away.
 */
export const PLUGIN_WEBHOOK_DELIVERIES_PER_TICK = 20;

/**
 * Attempts before a delivery is abandoned.
 *
 * At-least-once means a delivery the plugin never acks is REDELIVERED, so a
 * plugin whose handler throws on one malformed body would otherwise be woken
 * with it forever. Five tries across five ticks is generous for a transient
 * failure and short enough that a poison delivery stops costing anything.
 */
export const PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX = 5;

/**
 * How long the local delivery ledger keeps a row.
 *
 * Twice the relay's own seven-day retention, deliberately: the ledger is the
 * replay guard, and pruning it below what the relay can still serve would let a
 * cursor reset re-deliver events the plugin already handled. The 2026-07 daemon
 * wedge came from an ingress table with NO retention at all, so this is a cap
 * rather than an exemption — bounded on both axes, by age and by rows.
 */
export const PLUGIN_WEBHOOK_LEDGER_RETENTION_DAYS = 14;

/** Ledger rows kept per plugin. Oldest acked rows evict first. */
export const PLUGIN_WEBHOOK_LEDGER_ROWS_MAX = 5_000;

/**
 * Drain cadence.
 *
 * 45 seconds, matching the Cursor Cloud drain this generalizes. Ingress is
 * deliberately the FAST path: `sdk.schedules` has a 60-second floor
 * ({@link PLUGIN_SCHEDULE_MIN_INTERVAL_MS}), so a plugin that polled its own
 * third party on a schedule could never be as fresh as one that receives.
 */
export const PLUGIN_WEBHOOK_POLL_INTERVAL_MS = 45_000;

/** Lines the host keeps per plugin for `ade plugin logs`. */
export const PLUGIN_LOG_RING_CAPACITY = 500;

/** Bytes retained per log line before truncation. */
export const PLUGIN_LOG_LINE_MAX_BYTES = 2_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The one string a budget refusal ever carries.
 *
 * Declared here rather than beside the budget-pruning constants in
 * `dbMaintenanceApi.ts` (which re-exports it) because both the SDK path and the
 * wire path have to agree, and only this module is importable from all of
 * them — daemon, child runtime, renderer and `apps/ade-cli`. A second spelling
 * would mean a caller branches correctly on one route and falls through to
 * "internal error" on the other.
 */
export const PLUGIN_BUDGET_EXCEEDED_CODE = "plugin_budget_exceeded";

export type PluginSdkErrorCode =
  | "plugin_not_found"
  | "plugin_disabled"
  | "plugin_no_entry"
  | "plugin_crashed"
  | "plugin_timeout"
  | "invalid_args"
  | typeof PLUGIN_BUDGET_EXCEEDED_CODE
  | "not_permitted"
  | "unsupported_method"
  | "internal_error"
  /**
   * A refused microphone capture, as its own vocabulary.
   *
   * Part of this union rather than a code smuggled in the message, because
   * `code` is the only field that survives the child boundary intact
   * (`pluginChildSupervisor` rebuilds a rejection from `PluginSdkError`'s code)
   * and a plugin has to tell "the user dismissed the pill" from "the recording
   * failed" — one is a quiet no-op, the other is worth a sentence.
   */
  | PluginAudioCaptureErrorCode
  /**
   * Refusals from the capabilities the host performs on a plugin's behalf, for
   * the same reason the audio codes are here: `code` is the only field that
   * survives the child boundary, and every one of these is an outcome a plugin
   * should handle rather than report as a failure.
   */
  | PluginHostCapabilityErrorCode;

/**
 * How an error crosses the child boundary. Structural, never a stack string:
 * the host logs `stack` and shows `message`, and callers branch on `code`.
 */
export type PluginStructuralError = {
  code: PluginSdkErrorCode;
  message: string;
  /** Populated for `budget_exceeded`: which ceiling, and where the plugin sits. */
  detail?: { budget?: string; limit?: number; actual?: number } & Record<string, unknown>;
  stack?: string;
};

export class PluginSdkError extends Error {
  readonly code: PluginSdkErrorCode;
  readonly detail: PluginStructuralError["detail"];

  constructor(code: PluginSdkErrorCode, message: string, detail?: PluginStructuralError["detail"]) {
    super(message);
    this.name = "PluginSdkError";
    this.code = code;
    this.detail = detail;
  }
}

export function toPluginStructuralError(error: unknown): PluginStructuralError {
  if (error instanceof PluginSdkError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  if (error instanceof Error) {
    return {
      code: "internal_error",
      message: error.message || "Unknown plugin error",
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { code: "internal_error", message: String(error) };
}

export function fromPluginStructuralError(payload: PluginStructuralError | undefined): PluginSdkError {
  const error = new PluginSdkError(
    payload?.code ?? "internal_error",
    payload?.message ?? "Unknown plugin error",
    payload?.detail,
  );
  if (payload?.stack) error.stack = payload.stack;
  return error;
}

export function budgetExceeded(budget: string, limit: number, actual: number): PluginSdkError {
  return new PluginSdkError(
    PLUGIN_BUDGET_EXCEEDED_CODE,
    `Plugin ${budget} budget exceeded: ${actual} of ${limit}.`,
    { budget, limit, actual },
  );
}

/**
 * True when `error` is a budget refusal, however it was relayed.
 *
 * Reads `code` off any shape rather than testing `instanceof PluginSdkError`:
 * the same refusal reaches callers as a `PluginSdkError` in-process, as a
 * `codedError` from a sync-side writer, and as a rehydrated
 * {@link PluginStructuralError} after crossing the child boundary. All three
 * carry the one code, and all three have to answer this question the same way.
 */
export function isPluginBudgetExceeded(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === PLUGIN_BUDGET_EXCEEDED_CODE;
}

// ---------------------------------------------------------------------------
// SDK surface (what plugin code sees as the `ade` global)
// ---------------------------------------------------------------------------

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export type PluginCollectionRow = {
  collection: string;
  key: string;
  value: unknown;
  updatedAt: string;
};

/**
 * What a `collections.put` should do when the write would take the plugin past
 * its row or byte budget.
 *
 * `"fail"` is the default and is exactly what every plugin written before this
 * option existed gets: the typed budget refusal, nothing written. `"evictOldest"`
 * is the opt-in self-healing write — the host frees room by deleting the oldest
 * rows of the SAME collection until the new value fits, then writes it, all in
 * one transaction.
 *
 * The choice is the plugin's because only the plugin knows what its collection
 * is. A cache of rendered rows wants `"evictOldest"` and should never stall its
 * plugin at a ceiling; a collection of the user's saved items wants `"fail"`,
 * because silently dropping the oldest one would be data loss the user never
 * asked for. The platform's job is to make the first case a single argument
 * rather than something each author reimplements — and to make the second case
 * what you get by not asking.
 */
export const PLUGIN_COLLECTION_IF_FULL_MODES = ["fail", "evictOldest"] as const;

export type PluginCollectionIfFull = (typeof PLUGIN_COLLECTION_IF_FULL_MODES)[number];

/**
 * Narrow an over-the-wire `ifFull`. Unknown strings are NOT quietly read as
 * `"fail"`: a plugin that shipped a typo would then behave like a plugin that
 * asked for the default, and it would look like it was working right up until
 * the collection filled. The host rejects the call instead.
 */
export function isPluginCollectionIfFull(value: unknown): value is PluginCollectionIfFull {
  return PLUGIN_COLLECTION_IF_FULL_MODES.some((mode) => mode === value);
}

export type PluginCollectionPutOptions = {
  /** Omitted means `"fail"` — see {@link PLUGIN_COLLECTION_IF_FULL_MODES}. */
  ifFull?: PluginCollectionIfFull;
};

/**
 * The `collections.put` params frame, as the child puts it on the wire.
 *
 * Here rather than inline at the one call site because the compatibility
 * promise is a property of the FRAME, not of the caller: a put that names no
 * option must serialize to exactly the three keys it always did, so a plugin
 * built against a newer SDK still speaks to an older host, and the host's
 * `options` parse still sees "absent" rather than an empty object it would have
 * to decide the meaning of.
 */
export function pluginCollectionPutParams(
  collection: string,
  key: string,
  value: unknown,
  options?: PluginCollectionPutOptions,
): Record<string, unknown> {
  return {
    collection,
    key,
    value,
    ...(options?.ifFull ? { options: { ifFull: options.ifFull } } : {}),
  };
}

/** "Something in this entity family moved; re-read it." */
export type PluginChangeEventName = "lane.changed" | "pr.changed" | "session.changed" | "install.changed";

/**
 * Runtime hooks — the coding agent's turn lifecycle, as it happens.
 *
 * **These are OBSERVE-ONLY and that is the whole design, not a first
 * iteration's shortcut.** A hook delivery is one fire-and-forget line on the
 * child's stdin. The host never waits for a listener, never reads a return
 * value, and never lets a slow, wedged or crashed plugin delay a turn by a
 * millisecond — a plugin that stops reading its input has its hook deliveries
 * DROPPED (counted in the host log), because the alternative is a plugin able
 * to stall the user's agent. Nothing a listener does can veto a turn, change a
 * tool call, or alter what the agent sees.
 *
 * Vetoing a tool call is a permission question rather than an API one: the
 * user's yes/no over what an agent may do is core (`sockets.ts`'s invariant on
 * approvals), and a hook that could answer it would move that decision into
 * code the user installed on an agent's advice. If a veto tier ever ships it
 * will be a different, explicitly-granted capability, not a return value from
 * these.
 *
 * **Payloads are metadata only — never content.** No message text, no tool
 * arguments, no tool results, no file paths, no prompts. This is deliberate:
 * the observe tier answers "what is happening, and how often", which is enough
 * to build a cost guard, a turn timer, a tool-usage dashboard or a lint
 * trigger, and it does so without every installed plugin becoming a reader of
 * everything the user types. Exposing content is a separate permission
 * decision, and it belongs to whatever grants it, not to this event.
 *
 * A plugin that needs the transcript already has a supported door with its own
 * gate: `ade.actions.invoke("chat", "readTranscript", …)`.
 */
export const PLUGIN_RUNTIME_HOOK_EVENTS = ["turn.start", "turn.end", "tool.before"] as const;

export type PluginRuntimeHookName = (typeof PLUGIN_RUNTIME_HOOK_EVENTS)[number];

export function isPluginRuntimeHookName(value: unknown): value is PluginRuntimeHookName {
  return PLUGIN_RUNTIME_HOOK_EVENTS.some((name) => name === value);
}

/**
 * Push events — something arrived FOR this plugin from outside ADE.
 *
 * Unlike a change event, which says "re-read something you can already see",
 * and unlike a runtime hook, which is metadata about a turn, a push event
 * carries a payload that exists nowhere else: if the child does not read it,
 * nobody does. That difference is why these are the only events that are
 * ACKNOWLEDGED. The host holds a delivery until the child calls
 * {@link AdePluginSdk.webhooks}`.ack`, redelivers it on the next drain tick if
 * it does not, and gives up after
 * {@link PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX} attempts.
 *
 * The contract is AT-LEAST-ONCE, never exactly-once, and the `id` on the
 * payload is what makes that survivable: an ack that never reaches the host —
 * a crash between the handler returning and the ack being written — replays the
 * delivery with the SAME id, so a plugin that records ids it has handled
 * behaves correctly and one that does not, double-processes. Say so in the
 * plugin's own docs; the platform cannot do it for them.
 *
 * Like the runtime hooks, these are delivered ONLY to a child that subscribed.
 * A plugin that declares `webhookIngress` and never calls
 * `ade.events.on("webhook.received", …)` still gets its relay registration and
 * its URL — the events simply queue, get their attempts, and age out.
 */
export const PLUGIN_PUSH_EVENTS = ["webhook.received"] as const;

export type PluginPushEventName = (typeof PLUGIN_PUSH_EVENTS)[number];

export function isPluginPushEventName(value: unknown): value is PluginPushEventName {
  return PLUGIN_PUSH_EVENTS.some((name) => name === value);
}

/**
 * The chat runtime's own events — the user's side of a conversation a plugin
 * owns.
 *
 * A THIRD delivery class, and the difference from the two above is the whole
 * point. Change events are coalesced hints. Runtime hooks are observe-only and
 * DROPPED when a child stops draining its stdin, because no plugin may stall a
 * turn. Neither contract works here: `chat.turn` IS the user's message, and a
 * message the host quietly dropped is a chat that silently stops answering.
 *
 * So `chat.turn` and `chat.interrupt` are delivered on the RELIABLE path — the
 * same request/response frame `plugin.invoke` uses, with a request id, a
 * timeout and a real rejection the host turns into a failed turn the user can
 * see. They start a stopped child rather than skipping it. A plugin that
 * throws from its listener fails that turn, visibly, instead of losing it.
 *
 * `chat.opened` and `chat.closed` keep the cheap fire-and-forget contract,
 * because they are a hint by nature: they say somebody is (or is no longer)
 * looking at this conversation, so the plugin can poll fast while it matters
 * and stop when it does not. A missed presence event costs a poll interval,
 * never a message. This is the fast path that `ade.schedules` cannot be —
 * schedules are floored at {@link PLUGIN_SCHEDULE_MIN_INTERVAL_MS} and know
 * nothing about who is watching.
 */
export const PLUGIN_CHAT_RUNTIME_EVENTS = [
  "chat.turn",
  "chat.interrupt",
  "chat.opened",
  "chat.closed",
] as const;

export type PluginChatRuntimeEventName = (typeof PLUGIN_CHAT_RUNTIME_EVENTS)[number];

export function isPluginChatRuntimeEventName(value: unknown): value is PluginChatRuntimeEventName {
  return PLUGIN_CHAT_RUNTIME_EVENTS.some((name) => name === value);
}

/**
 * True for the two chat events the host delivers reliably rather than by the
 * droppable queue. See {@link PLUGIN_CHAT_RUNTIME_EVENTS}.
 */
export function isPluginChatReliableEventName(value: unknown): value is "chat.turn" | "chat.interrupt" {
  return value === "chat.turn" || value === "chat.interrupt";
}

/**
 * The reserved `invoke` action one reliable chat event arrives as.
 *
 * The host has exactly one request/response frame — `invoke` — and reusing it
 * costs nothing and buys the timeout, the request id and the structured
 * rejection. The child routes these to the plugin's
 * `ade.events.on("chat.turn", …)` listeners, so plugin authors never see the
 * action name at all and the transport stays one concept, not two.
 *
 * See {@link PLUGIN_RESERVED_ACTION_PREFIX} for why the prefix is safe.
 */
export const PLUGIN_CHAT_DELIVERY_ACTION_PREFIX = "ade:";

/**
 * The whole `ade:` prefix belongs to the host. Nothing else may use it.
 *
 * Sharing one `invoke` frame between the host's own delivery and a plugin's
 * handlers means the ACTION NAME is what tells them apart, so the namespace has
 * to have an owner. Two different attacks close with one rule:
 *
 * - A plugin that declared a handler, socket `actionId`, CLI word or tool named
 *   `ade:chat.turn` would sit exactly where the host's delivery is routed.
 * - Anything that can reach `plugin.invoke` — a published vocabulary node's
 *   `action` string, a schedule, a remote command — could otherwise hand a
 *   child a FORGED `chat.turn` naming any session it liked.
 *
 * The second is the reason this is enforced at the host's invoke door and not
 * only in the manifest parser: a published node's action is runtime data that
 * no manifest parser ever sees.
 *
 * Reserved as a whole prefix rather than as the two names in use today, so a
 * later reserved verb cannot be squatted before it ships. Today's identifier
 * pattern happens to exclude `:` already; this does not depend on that, because
 * a widened charset must not silently open the namespace.
 */
export const PLUGIN_RESERVED_ACTION_PREFIX = "ade:";

/** True for an action name only the host may use. See {@link PLUGIN_RESERVED_ACTION_PREFIX}. */
export function isReservedPluginActionName(value: unknown): boolean {
  return typeof value === "string"
    && value.trim().toLowerCase().startsWith(PLUGIN_RESERVED_ACTION_PREFIX);
}

/** The refusal every reserved-name attempt gets, worded the same at each door. */
export function reservedPluginActionMessage(name: string): string {
  return `"${name}" uses the reserved "${PLUGIN_RESERVED_ACTION_PREFIX}" prefix, which belongs to ADE.`;
}

export function pluginChatDeliveryAction(event: "chat.turn" | "chat.interrupt"): string {
  return `${PLUGIN_CHAT_DELIVERY_ACTION_PREFIX}${event}`;
}

/** The chat event a reserved action name carries, or null for a plugin's own action. */
export function readPluginChatDeliveryAction(action: string): "chat.turn" | "chat.interrupt" | null {
  if (!action.startsWith(PLUGIN_CHAT_DELIVERY_ACTION_PREFIX)) return null;
  const event = action.slice(PLUGIN_CHAT_DELIVERY_ACTION_PREFIX.length);
  return isPluginChatReliableEventName(event) ? event : null;
}

/**
 * The one event a sign-in the host ran delivers back.
 *
 * A FOURTH delivery class, and it earns the separation the same way the chat
 * runtime's did. A change event is a coalesced hint and a runtime hook may be
 * dropped; neither contract is acceptable here, because this payload is the
 * only copy of an authorization code that exists and it is single-use. It is
 * delivered to the one child that began the flow, exactly once, and a child
 * that is not draining its stdin holds it in the queue rather than losing it.
 */
export type PluginAuthEventName = "auth.completed";

export function isPluginAuthEventName(value: unknown): value is PluginAuthEventName {
  return value === "auth.completed";
}

export type PluginEventName =
  | PluginChangeEventName
  | PluginRuntimeHookName
  | PluginPushEventName
  | PluginChatRuntimeEventName
  | PluginAuthEventName;

export function isPluginEventName(value: unknown): value is PluginEventName {
  return value === "lane.changed"
    || value === "pr.changed"
    || value === "session.changed"
    || value === "install.changed"
    || isPluginAuthEventName(value)
    || isPluginRuntimeHookName(value)
    || isPluginPushEventName(value)
    || isPluginChatRuntimeEventName(value);
}

/**
 * A pull request's lifecycle position, as a change event reports it.
 *
 * Two fields rather than one because `state` is the provider's vocabulary and
 * `merged` is the question every consumer actually asks. A plugin that only
 * wants "did this just merge" compares `from.merged` with `to.merged` and never
 * has to know which spelling of `closed` a merge leaves behind.
 */
export type PluginPrEventState = {
  /** `open`, `merged`, `closed`, `draft` — whatever the PR carries. */
  state: string;
  merged: boolean;
};

/**
 * What one entity actually did, when the producer knew.
 *
 * ## The gap this closes
 *
 * A change event is a coalesced hint: ids and no history. So "the PR just
 * merged" — the trigger behind every PR→Done rule — could only be recovered by
 * reading each named PR back and comparing it against whatever the plugin last
 * remembered. That re-read is racy in both directions: a PR merged and reverted
 * inside one coalesce window reads as never-merged, and a plugin that lost its
 * memory (a restart, a reinstall) treats every open PR as newly transitioned.
 *
 * The producer already holds the previous state — it is the same value ADE's
 * own merge handling reads — so it says so, and nobody has to re-derive it.
 *
 * ## What it is not
 *
 * Not a ledger and not a guarantee. It is ABSENT whenever the producer had no
 * previous state to compare against, and absent for a delivery whose `ids`
 * overflowed the cap, because a partial transition list next to a truncated id
 * list is the one shape a reader could mistake for complete. Both cases mean
 * the same thing: fall back to reading the entities named in `ids`.
 */
export type PluginPrTransition = {
  /** The PR id, which also appears in the payload's `ids`. */
  id: string;
  /** Where it was when the producer last looked. */
  from: PluginPrEventState;
  /** Where it is now. */
  to: PluginPrEventState;
};

export type PluginEventPayload = {
  event: PluginChangeEventName;
  /** Entity ids that changed since the last delivery, capped and deduped. */
  ids: string[];
  projectId: string | null;
  /**
   * What some of those ids DID, when the producer knew — see
   * {@link PluginPrTransition}. Only `pr.changed` carries it today.
   *
   * Additive and always optional, so a plugin compiled against the older
   * payload keeps working and a plugin written for this one still has to handle
   * its absence. Never present alongside `overflow`, and never longer than
   * `ids`: a transition is only ever reported for an id the payload also names.
   *
   * Coalescing keeps the FIRST-seen `from` and the latest `to`, so a PR that
   * moved twice inside one window reports the whole journey rather than only
   * its last step.
   */
  transitions?: PluginPrTransition[];
  /**
   * `ids` was truncated at the delivery cap. Absent, never `false`, when it
   * was not — additive so a plugin compiled against the two-field payload
   * keeps working.
   *
   * `ids` is not a diff a listener can trust once this is set: more changed
   * than the cap carries, so the honest read is "the install set moved,
   * treat this the same as `install.changed` with no ids at all" — re-read
   * the roster (`plugin.list`) rather than acting only on the ids present.
   *
   * `transitions` is dropped whenever this is set, for the same reason: a
   * transition list that covered only the ids that fitted would look complete.
   */
  overflow?: true;
};

/**
 * How a turn stopped.
 *
 * Three outcomes rather than the transcript's own vocabulary, because a plugin
 * counting failures should not have to track which runtime spells an interrupt
 * which way: `cancelled` is the user stopping the agent (never an error to
 * report), `error` is the turn failing, `completed` is everything else.
 */
export type PluginTurnOutcome = "completed" | "error" | "cancelled";

type PluginRuntimeHookBase = {
  /** The chat session the turn ran in. */
  sessionId: string;
  /**
   * Which project, spelled exactly as {@link PluginEventPayload.projectId} is
   * — one identifier for "which project" across the whole event surface. Null
   * when the turn ran in a project this host has no binding for.
   */
  projectId: string | null;
  /** The coding agent: `claude`, `codex`, `cursor`, `droid`, `pi`, `opencode`. */
  runtime: string;
};

export type PluginRuntimeHookPayload =
  | (PluginRuntimeHookBase & {
    event: "turn.start";
    /** The model the session is set to, when it names one. */
    model?: string;
  })
  | (PluginRuntimeHookBase & {
    event: "turn.end";
    outcome: PluginTurnOutcome;
    /**
     * Wall time from this turn's `turn.start` to here. Absent when the host
     * never saw the matching start — a turn already running when the plugin
     * subscribed, or one whose runtime opened it without a turn id.
     */
    durationMs?: number;
  })
  | (PluginRuntimeHookBase & {
    event: "tool.before";
    /**
     * The tool the agent is about to run, by name only. `before` names the
     * ORDER, not a veto: the call is already on its way and this delivery does
     * not gate it.
     */
    toolName: string;
  });

/**
 * One webhook, as the plugin child sees it.
 *
 * Everything here has already been through the host's gates: the body is capped
 * at {@link PLUGIN_WEBHOOK_BODY_MAX_BYTES}, the headers are filtered to
 * {@link PLUGIN_WEBHOOK_HEADER_ALLOWLIST}, and — when the channel declares
 * `verify` — the third party's signature has been checked constant-time against
 * a plugin secret. A delivery that fails verification never becomes one of
 * these; it is dropped at the host and counted, because a plugin handed an
 * unverified body it believes is verified is worse than one handed nothing.
 */
export type PluginWebhookPayload = {
  event: "webhook.received";
  /**
   * Delivery id. Stable across redeliveries and the argument to `webhooks.ack`.
   * A plugin that records handled ids gets effectively-once out of an
   * at-least-once channel; one that does not, does not.
   */
  id: string;
  /** The manifest channel this arrived on — which integration spoke. */
  channel: string;
  /** Sender-declared event kind (`x-webhook-event`), or `"webhook"`. */
  eventType: string;
  /** When the RELAY accepted it, ISO-8601. Not when the host drained it. */
  receivedAt: string;
  /** Allowlisted request headers, lowercased. */
  headers: Record<string, string>;
  /** The raw body, as text. Parse it yourself; the host does not guess. */
  body: string;
  /** Set only when the body was clipped at the cap. Never `false`. */
  truncated?: true;
  /** Which attempt this is, starting at 1. Above 1 means a previous ack was lost. */
  attempt: number;
};

/**
 * One file the user attached to a turn, as the plugin child sees it.
 *
 * A path on this machine, not bytes: an attachment can be a hundred megabytes
 * and the NDJSON frame is not a file transport. The path is inside the
 * session's lane, the plugin already reaches the filesystem, and a plugin that
 * does not want the file simply never opens it.
 */
export type PluginChatAttachment = {
  /** Absolute path on this machine. */
  path: string;
  /** What to call it in the plugin's own UI. Defaults to the basename. */
  name?: string;
  bytes?: number;
  mimeType?: string;
};

type PluginChatRuntimeEventBase = {
  /** The ADE chat session. Every write the plugin makes back names this. */
  sessionId: string;
  /** Spelled exactly as {@link PluginEventPayload.projectId} is. */
  projectId: string | null;
  /** Which of this plugin's declared `chatRuntimes` owns the session. */
  runtimeId: string;
  /** The plugin's own id for the conversation, as it supplied at bind time. */
  externalId: string;
};

/**
 * What a chat event carries into the plugin.
 *
 * `chat.turn` carries the user's message TEXT, unlike every runtime hook,
 * which carries metadata only. That is not an inconsistency: a runtime hook
 * observes a conversation between the user and ADE's own agent, and the plugin
 * is a bystander there. Here the plugin IS the agent — the user typed into a
 * conversation the plugin owns and expects it to answer — so withholding the
 * message would leave nothing to answer with. The user's consent is the act of
 * opening a chat on that runtime, and the seam is narrow by construction: a
 * plugin is told about sessions its own `runtimeRef` names, and no others.
 */
export type PluginChatRuntimeEventPayload =
  | (PluginChatRuntimeEventBase & {
    event: "chat.turn";
    /** The host's turn id. Echo it on writes so they land on this turn. */
    turnId: string;
    /** What the user typed. */
    message: string;
    /** Files the user attached. See {@link PluginChatAttachment}. */
    attachments: PluginChatAttachment[];
    /** True when this is a follow-up into an existing conversation. */
    followUp: boolean;
  })
  | (PluginChatRuntimeEventBase & {
    event: "chat.interrupt";
    /** The turn the user asked to stop; null when the host knows of none. */
    turnId: string | null;
  })
  | (PluginChatRuntimeEventBase & {
    event: "chat.opened";
    /** Always true. Present so one listener can read both events the same way. */
    watching: true;
  })
  | (PluginChatRuntimeEventBase & {
    event: "chat.closed";
    /** Always false. */
    watching: false;
  });

/**
 * Why a sign-in ended without a code.
 *
 * Named outcomes rather than a message, because a plugin acts differently on
 * each: `canceled` is silent (the user closed the window and knows they did),
 * `expired` is worth an "it took too long, try again", and `denied` is the
 * provider's own refusal, which is the only one where the plugin's own
 * configuration is likely at fault. `state_mismatch` is the host refusing a
 * callback whose `state` it did not mint — a plugin can do nothing about it and
 * should say so plainly rather than retry into the same wall.
 */
export type PluginAuthFailureReason = "canceled" | "expired" | "denied" | "state_mismatch";

/**
 * The result of one sign-in, delivered to the child that began it.
 *
 * `params` is what came back on the redirect, MINUS `state`. The plugin does
 * not get `state` because it has nothing to do with it: the host minted it, the
 * host compared it, and a copy in the child would only invite a second,
 * weaker check that disagrees with the host's. What is left is the provider's
 * own vocabulary — `code` for a standard OAuth flow, whatever else that
 * provider sends — passed through as data with no interpretation.
 */
export type PluginAuthCompletedPayload = {
  event: PluginAuthEventName;
  /** The `authSessions[].id` this completion answers. */
  sessionId: string;
  /**
   * Which begin this answers.
   *
   * A plugin that cancels and starts again must not act on the first flow's
   * late callback. One live attempt per flow makes that rare; the field makes
   * it impossible.
   */
  attempt: string;
} & (
  | { ok: true; params: Record<string, string> }
  | { ok: false; reason: PluginAuthFailureReason; message?: string }
);

/** Everything an `event` frame can carry. */
export type PluginAnyEventPayload =
  | PluginEventPayload
  | PluginRuntimeHookPayload
  | PluginWebhookPayload
  | PluginChatRuntimeEventPayload
  | PluginAuthCompletedPayload;

/** The payload shape one event name delivers. */
export type PluginEventPayloadFor<E extends PluginEventName> =
  E extends PluginRuntimeHookName ? Extract<PluginRuntimeHookPayload, { event: E }>
    : E extends PluginAuthEventName ? PluginAuthCompletedPayload
      : E extends PluginPushEventName ? PluginWebhookPayload
        : E extends PluginChatRuntimeEventName ? Extract<PluginChatRuntimeEventPayload, { event: E }>
          : PluginEventPayload;

// ---------------------------------------------------------------------------
// Chat runtime — what a plugin writes back
// ---------------------------------------------------------------------------

/**
 * The most bytes one transcript write may carry.
 *
 * Per CALL, not per turn: a streaming runtime sends many small chunks and this
 * ceiling is about frame size, not about how much a plugin may ultimately say.
 * A plugin pasting a whole file into one chunk is refused and should stream it.
 */
export const PLUGIN_CHAT_TEXT_MAX_BYTES = 128 * 1024;

/**
 * How many transcript writes one session takes from one plugin per minute.
 *
 * Far above the ade-card burst ({@link PLUGIN_ADE_CARDS_PER_SESSION_BURST}) and
 * deliberately so — a card is a discrete event a user reads, while these are
 * the token-by-token chunks of a streaming reply, and holding a stream to 30 a
 * minute would make every plugin runtime look broken. It is still a ceiling:
 * a runaway child cannot write an unbounded transcript to the user's disk.
 */
export const PLUGIN_CHAT_WRITES_PER_SESSION_BURST = 900;
export const PLUGIN_CHAT_WRITE_BURST_WINDOW_MS = 60_000;

/** Most transcript entries one `chat.hydrate` CALL may backfill. Page past it. */
export const PLUGIN_CHAT_HYDRATE_MAX_ENTRIES = 500;

/**
 * Most entries one backfill SWEEP may write, across all of its pages.
 *
 * The per-call cap bounds a frame; this bounds the whole operation, because
 * paging without a total is just an unbounded write with extra steps. Ten
 * thousand turns is far past any real conversation — a plugin that reaches it
 * is looping, not backfilling, and gets a refusal that says so instead of
 * quietly filling the user's disk.
 */
export const PLUGIN_CHAT_HYDRATE_SWEEP_MAX_ENTRIES = 10_000;

/**
 * How one `hydrate` call relates to the ones around it.
 *
 * A Cursor Cloud conversation can run past the per-call cap, so backfill is
 * paged. Pages are ordered OLDEST FIRST and each one appends after the last —
 * the host does not re-sort, because only the plugin knows the true order of a
 * conversation it read from somebody else's API.
 */
export type PluginChatHydrateOptions = {
  /**
   * True for every page after the first of one sweep.
   *
   * The first page (absent or `false`) starts a sweep and resets its running
   * total. A continuation carries it forward, which is what makes
   * {@link PLUGIN_CHAT_HYDRATE_SWEEP_MAX_ENTRIES} a real ceiling rather than
   * one a plugin escapes by calling again. Getting it wrong is not dangerous:
   * the fingerprint dedupe still stops a page landing twice.
   */
  append?: boolean;
};

/**
 * What a `hydrate` page actually did.
 *
 * Returned rather than assumed, because "nothing landed" is the normal answer
 * on a re-read after a reconnect and a plugin needs to tell that from a page it
 * got wrong. Read `accepted === 0 && skipped > 0` as "ADE already had this" and
 * stop paging.
 */
export type PluginChatHydrateResult = {
  /** Entries written to the transcript. */
  accepted: number;
  /** Entries the host already had, matched by fingerprint or by text. */
  skipped: number;
  /** Entries this sweep has written so far, across every page. */
  sweepTotal: number;
};

/** Most parts one `appendAssistant` chunk may carry. */
export const PLUGIN_CHAT_PARTS_MAX = 64;

/** Most artifacts one `setArtifacts` call may list. */
export const PLUGIN_CHAT_ARTIFACTS_MAX = 50;

/**
 * A piece of an assistant turn.
 *
 * Three kinds rather than the transcript's full event vocabulary. A plugin
 * runtime is answering the user, not driving ADE's tool loop, and the parts it
 * can express are the ones a reader distinguishes: what was said, what was
 * thought, and what was run. Everything richer is an `ade_card`, which already
 * has a schema, a budget and four client renderers.
 */
export type PluginChatPart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; detail?: string };

/**
 * One streamed piece of the assistant's reply.
 *
 * Chunked calls coalesce into ONE turn in the transcript: the host appends
 * rather than starting a new bubble per call, exactly as ADE's own runtimes
 * stream. `done: true` closes the turn — without it the host closes it when
 * the plugin reports a terminal {@link PluginChatStatus}, and a plugin that
 * reports neither leaves a turn open, which the user reads as a chat still
 * thinking.
 */
export type PluginChatAssistantChunk = {
  /** Shorthand for a single `{kind:"text"}` part. */
  text?: string;
  /** See {@link PluginChatPart}. Combined with `text` if both are given. */
  parts?: PluginChatPart[];
  /** The turn from `chat.turn`. Defaults to the session's open plugin turn. */
  turnId?: string;
  /** Close this turn. */
  done?: boolean;
};

/**
 * A user turn ADE did not originate — history the plugin is backfilling.
 *
 * `fingerprint` is the dedupe key, matched suffix-tolerantly by the host, so
 * re-reading a foreign conversation after a reconnect does not double every
 * message. Every plugin gets that matching for free rather than reimplementing
 * it, which is the only reason this field is on the platform and not in the
 * plugin.
 */
export type PluginChatUserAppend = {
  text: string;
  fingerprint?: string;
  turnId?: string;
};

/**
 * What the plugin says its conversation is doing.
 *
 * This is what makes an owned session behave in ADE's settled lifecycle:
 * `running` keeps the chat live and the spinner honest, `idle` settles it,
 * `failed` marks the last turn failed, and `finished` settles it AND says the
 * external run is over, which is what wakes the "ready for you" treatment.
 * A plugin that never reports leaves a session that spins forever, so the host
 * closes an open turn on the child's crash rather than trusting it to.
 */
export const PLUGIN_CHAT_STATUS_STATES = ["running", "idle", "failed", "finished"] as const;

export type PluginChatStatusState = (typeof PLUGIN_CHAT_STATUS_STATES)[number];

export function isPluginChatStatusState(value: unknown): value is PluginChatStatusState {
  return PLUGIN_CHAT_STATUS_STATES.some((state) => state === value);
}

export type PluginChatStatus = {
  state: PluginChatStatusState;
  /** One short sentence the client may show: "Cloud run cancelled." */
  detail?: string;
  turnId?: string;
};

/** One file the plugin materialized into the lane, for the proof-artifact card. */
export type PluginChatArtifact = {
  /** Path relative to the lane worktree. Absolute paths are refused. */
  path: string;
  label?: string;
  bytes?: number;
};

/** One historical turn, for {@link AdePluginSdk.chat.hydrate}. */
export type PluginChatTranscriptEntry = {
  role: "user" | "assistant";
  text?: string;
  parts?: PluginChatPart[];
  /** Epoch millis the turn happened at, for ordering. */
  at?: number;
  /** Dedupe key. See {@link PluginChatUserAppend.fingerprint}. */
  fingerprint?: string;
};

/**
 * Bind a chat session to this plugin's runtime.
 *
 * `pluginId` is absent on purpose and always will be: the host stamps it from
 * the child connection that asked. A plugin naming its own owner would make
 * every ownership check in this seam a check against a value the checked party
 * supplied.
 */
export type PluginChatSessionCreateInput = {
  /** One of this plugin's declared `chatRuntimes` ids. */
  runtimeId: string;
  /** The plugin's own id for the conversation. Opaque to ADE. */
  externalId: string;
  /** Which lane the chat belongs to. */
  laneId: string;
  /** Adopt an EXISTING session instead of creating one, when it is unowned. */
  sessionId?: string;
  title?: string;
  /** Shown in the model slot. Free text; ADE does not resolve it to a model. */
  modelLabel?: string;
};

export type PluginChatSessionRef = {
  sessionId: string;
  runtimeId: string;
  externalId: string;
  /** True when this call created the session rather than adopting one. */
  created: boolean;
};

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/**
 * A lane as a PLUGIN sees it.
 *
 * Deliberately not `LaneSummary`. The internal shape carries `worktreePath`,
 * `attachedRootPath` and `devicesOpen` — an absolute path into the user's
 * filesystem and a roster of the machines they have the lane open on. None of
 * that is needed to link an issue, and all of it would be read by any plugin
 * that ever called `lanes.list()`. So the projection is a fixed allowlist
 * ({@link toPluginLaneSummary}) rather than a delete-list, which is the version
 * that stays correct when a field is added to `LaneSummary` later.
 *
 * A plugin that genuinely needs the worktree already has the filesystem and
 * knows where it put its own files; it does not need ADE to hand it a path.
 */
export type PluginLaneSummary = {
  id: string;
  name: string;
  laneType: LaneType;
  baseRef: string;
  branchRef: string;
  parentLaneId: string | null;
  status: LaneStatus;
  color: string | null;
  icon: LaneIcon;
  tags: string[];
  folder: string | null;
  createdAt: string;
  archivedAt: string | null;
  /** The lane's primary issue, on whichever tracker owns it. */
  primaryIssue: IssueRef | null;
  /** Every issue link on the lane, across trackers. */
  issueLinks: IssueLink[];
};

/**
 * The lane fields a plugin may see, as a list rather than as a set of
 * exclusions. Exported so the host, the child and the tests all agree on it.
 */
export const PLUGIN_LANE_SUMMARY_FIELDS = [
  "id",
  "name",
  "laneType",
  "baseRef",
  "branchRef",
  "parentLaneId",
  "status",
  "color",
  "icon",
  "tags",
  "folder",
  "createdAt",
  "archivedAt",
  "primaryIssue",
  "issueLinks",
] as const satisfies readonly (keyof PluginLaneSummary)[];

/**
 * The issue-link fields a plugin may see, as a list rather than as a set of
 * exclusions — the same rule {@link PLUGIN_LANE_SUMMARY_FIELDS} follows, and
 * for the same reason: a field added to `IssueLink` later must not reach a
 * plugin because nobody remembered to delete it here.
 *
 * `IssueLink` carries no path and no device marker today. The projection is
 * therefore a no-op on every field it copies, and that is the point: it is the
 * guard that stays correct on the day one is added.
 */
export const PLUGIN_ISSUE_LINK_FIELDS = [
  "id",
  "laneId",
  "sessionId",
  "issue",
  "role",
  "source",
  "includeInPr",
  "closeOnMerge",
  "evidence",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof IssueLink)[];

/** Project one issue link down to what a plugin may see. */
export function toPluginIssueLink(link: IssueLink): IssueLink {
  return {
    id: link.id,
    laneId: link.laneId,
    sessionId: link.sessionId,
    issue: link.issue,
    role: link.role,
    source: link.source,
    includeInPr: link.includeInPr,
    closeOnMerge: link.closeOnMerge,
    evidence: link.evidence ?? null,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

/**
 * Every issue linked to ONE chat or CLI session inside a lane.
 *
 * ## Why this is not already in `PluginLaneSummary`
 *
 * A lane summary carries `primaryIssue` and `issueLinks`, and both are
 * LANE-scoped. An issue a person attached to a single chat inside the lane
 * lives in a different table and appears in neither — so a plugin reproducing
 * ADE's "the merged PR moves its issues to Done" rule off a lane summary alone
 * silently skips exactly those issues. Core does not skip them: it unions the
 * lane's links with `listLinearIssuesForLaneSessions`, and this verb is that
 * second half, made generic.
 *
 * ## Why the links and not bare refs
 *
 * `closeOnMerge` is the flag core filters session links on, and it lives on the
 * LINK rather than on the ref. A shape carrying only `IssueRef`s would let a
 * plugin see the issues and not the rule, so every reproduction of core's
 * behaviour would move issues the user asked it to leave alone.
 */
export type PluginSessionIssues = {
  /** The chat or CLI session the links hang off. */
  sessionId: string;
  /** Its links, across every tracker, projected by {@link toPluginIssueLink}. */
  issueLinks: IssueLink[];
};

/** Project a lane down to what a plugin may see. See {@link PluginLaneSummary}. */
export function toPluginLaneSummary(lane: LaneSummary): PluginLaneSummary {
  return {
    id: lane.id,
    name: lane.name,
    laneType: lane.laneType,
    baseRef: lane.baseRef,
    branchRef: lane.branchRef,
    parentLaneId: lane.parentLaneId,
    status: lane.status,
    color: lane.color,
    icon: lane.icon,
    tags: lane.tags ?? [],
    folder: lane.folder ?? null,
    createdAt: lane.createdAt,
    archivedAt: lane.archivedAt ?? null,
    primaryIssue: lane.primaryIssue ?? null,
    // Projected rather than passed through, so the lane surface has ONE rule
    // about what an issue link may carry rather than one per verb.
    issueLinks: (lane.issueLinks ?? []).map(toPluginIssueLink),
  };
}

/**
 * The issue a plugin hands to {@link AdePluginSdk.lanes.linkIssue}.
 *
 * `pluginId` is absent on purpose and always will be, exactly as it is on
 * {@link PluginChatSessionCreateInput}: the host stamps it from the child
 * connection that asked. It is also what `lanes.unlinkIssue` checks ownership
 * against, and a plugin naming its own owner would make that check a check
 * against a value the checked party supplied.
 */
export type PluginIssueRefInput = Omit<IssueRef, "pluginId">;

/** A link as it comes back from the host. `issue.pluginId` is host-stamped. */
export type PluginIssueLink = IssueLink;

/** Where a link hangs: exactly one of the two. */
export type PluginIssueLinkTarget = {
  laneId?: string;
  sessionId?: string;
};

export type PluginIssueLinkInput = PluginIssueLinkTarget & {
  issue: PluginIssueRefInput;
  /** Defaults to `"referenced"`. */
  role?: IssueLinkRole;
  /** Mention the issue in the PR body this lane opens. */
  includeInPr?: boolean;
  /** Ask the tracker to close the issue when that PR merges. */
  closeOnMerge?: boolean;
};

export type PluginIssueUnlinkInput = PluginIssueLinkTarget & {
  provider: string;
  issueId: string;
};

/**
 * The `ade` global inside a plugin child process.
 *
 * Every method is async and every one can reject with a {@link PluginSdkError}.
 * There is no synchronous escape hatch: the host owns the database, the
 * secrets, and the action bridge, and a plugin reaches all three by asking.
 */
export type AdePluginSdk = {
  readonly pluginId: string;
  readonly sdkVersion: number;
  readonly manifest: PluginManifest;

  actions: {
    /**
     * Invoke an ADE action. The plugin authenticates at `agent` role, so
     * CTO-only actions are refused — a plugin is not the operator.
     * Project-scoped domains require `projectId`.
     *
     * `chat.createSession` and `chat.launchCli` additionally accept
     * `sessionSetup: `{@link PluginSessionSetup}, which injects environment
     * variables and one context file into the agent process the call starts —
     * the generic form of the reach the built-in Linear integration has through
     * `ADE_LINEAR_ISSUE_IDS` / `ADE_LINEAR_CONTEXT_FILE`. The host validates it
     * (see `sessionSetup.ts`), writes the file, hands the child its path in
     * `ADE_PLUGIN_CONTEXT_FILE`, and names the calling plugin in
     * `ADE_PLUGIN_SOURCE_ID`. No new consent card: launching a session is
     * already gated on the agent permission the plugin holds.
     */
    invoke(domain: string, action: string, args?: Record<string, unknown>): Promise<unknown>;
  };

  collections: {
    get(collection: string, key: string): Promise<unknown>;
    /**
     * Store a value, rejecting with a `plugin_budget_exceeded`
     * {@link PluginSdkError} when it would take the plugin past a budget.
     * Pass `{ ifFull: "evictOldest" }` to have the host make room in this
     * collection instead of refusing.
     */
    put(
      collection: string,
      key: string,
      value: unknown,
      options?: PluginCollectionPutOptions,
    ): Promise<void>;
    delete(collection: string, key: string): Promise<void>;
    list(collection: string, options?: { keyPrefix?: string; limit?: number }): Promise<PluginCollectionRow[]>;
  };

  /** Namespaced to `plugin:<id>:<NAME>` in the machine credential store. */
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
    /**
     * Read a provider API key the USER gave to ADE, brokered by the host.
     *
     * Only for a provider this plugin's manifest lists in `providerKeys`, and
     * only after the person approved that line on the install card. An
     * undeclared provider rejects with `not_permitted`; a provider ADE does not
     * store keys for rejects with `invalid_args`.
     *
     * Resolves `null` when the provider is declared and approved but the user
     * has no key connected. That is a normal state, not a failure — say so and
     * point at Settings rather than reporting an error.
     *
     * The key arrives here and nowhere else: it is never written to the plugin
     * secret store, never put in a collection, a panel schema or the sync
     * layer, and never logged. Hold it in memory for the call that needs it.
     */
    getProviderKey(provider: string): Promise<string | null>;
    /**
     * Is a declared provider's key connected, without reading it?
     *
     * For the panel that wants to draw "connect your Cursor key in Settings"
     * instead of a broken list. Same declaration and approval rules as
     * {@link getProviderKey}.
     */
    hasProviderKey(provider: string): Promise<boolean>;
  };

  /**
   * Signing the user in, and inheriting a connection ADE already has.
   *
   * The division of labour is the whole design. The HOST opens the browser or
   * the phone's in-app auth view, owns the loopback listener or the relay
   * bounce, mints and checks `state`, and hands back the callback parameters as
   * data. The PLUGIN chooses the provider (in its manifest, before install),
   * supplies the query parameters, exchanges the code for a token over a host
   * it declared in `network`, and stores that token in its own
   * {@link AdePluginSdk.secrets}.
   *
   * ADE therefore never holds a token it brokered: it brokers the
   * AUTHORIZATION, and the credential is the plugin's from the moment it
   * exists. That is not a limitation to work around — a host that held the
   * token would have to refresh it, and refreshing a grant it cannot use is a
   * responsibility with no matching capability.
   */
  auth: {
    /**
     * Start one declared sign-in flow, and get back everything except the URL.
     *
     * Return `{ authSession: { sessionId } }` from the action handler that
     * calls this: the host fills in the live URL on the way to whichever client
     * the user is on, and that client presents it — the system browser on
     * desktop, an in-app auth session on the phone. A plugin cannot open a
     * browser itself and should not try; `openUrl` leaves the app with no way
     * back, which is the gap this verb exists to close.
     *
     * `params` are appended to the manifest's `authorizeUrl` — `client_id`,
     * `scope`, `code_challenge` and anything else the provider wants. PKCE is
     * the plugin's to run, because only the plugin performs the exchange and so
     * only the plugin can hold the verifier. `redirect_uri` and `state` are
     * refused by name ({@link PLUGIN_AUTH_RESERVED_PARAMS}) — they are the
     * host's.
     *
     * Rejects with `not_permitted` for a `sessionId` the manifest does not
     * declare, `auth_session_busy` when a flow of that id is already running,
     * and `auth_unavailable` when nothing on this machine can show a window.
     * The result arrives later as an `auth.completed` event; subscribe BEFORE
     * calling this.
     */
    beginSession(input: {
      sessionId: string;
      params?: Record<string, string>;
      /**
       * Force one transport instead of letting the host pick.
       *
       * Almost never wanted. The host chooses `loopback` when it has a browser
       * on this machine and `app` when the request came from a phone, which is
       * the right answer in both cases. Naming one the manifest does not
       * declare is `invalid_args`.
       */
      transport?: PluginAuthCallbackKind;
    }): Promise<PluginAuthSessionStart>;

    /**
     * Give up on a running flow. Idempotent, and safe for a flow that already
     * finished — there is nothing to cancel and nothing to report.
     *
     * The host stops listening and retires the `state`, so a callback that
     * arrives afterwards is refused rather than delivered late.
     */
    cancelSession(sessionId: string): Promise<void>;

    /**
     * Ask for the credential ADE holds for a built-in surface this plugin
     * supersedes. See {@link PluginManifest.credentialHandoff}.
     *
     * This is the release-day verb: on the day an official plugin replaces a
     * compiled integration, every existing user already has a working
     * connection, and without this every one of them reconnects. The host shows
     * a card naming exactly which secrets move, and only the user's yes copies
     * anything.
     *
     * Asked ONCE per install: after an answer the same call returns that
     * answer without showing a card again. A `declined` is not an error and
     * must not be reported as one — the plugin is simply unconnected, and the
     * ordinary sign-in flow is still there.
     */
    requestHandoff(builtin: string): Promise<PluginCredentialHandoffResult>;

    /**
     * Borrow ADE's OWN registered OAuth client id for a provider ADE bundles
     * one for.
     *
     * ## The gap this closes
     *
     * `requestHandoff` moves an EXISTING connection, so it does nothing for a
     * fresh install and nothing for a user who declined. Before this verb, a
     * plugin superseding a compiled integration had no way to obtain the
     * `client_id` that identifies ADE to the provider, so on a clean machine
     * the only reachable path was a pasted API key — an OAuth button that
     * could not build an authorize URL the provider would accept.
     *
     * ## Why lending the id is safe, and lending a secret would not be
     *
     * The id is public: it is a query parameter of every authorize URL ADE has
     * ever opened. The SECRET is ADE's identity to the provider, and a plugin
     * holding it could mint tokens in ADE's name on every machine it is
     * installed on. This verb NEVER returns one — {@link
     * PluginOfficialOAuthClient} has no field for it — and the host asserts
     * that before it answers.
     *
     * ## Who may ask
     *
     * The honoured owner of the built-in surface ADE bundles the credential
     * for, and nobody else. `ade-linear` owns the `linear` surface, so it may
     * borrow the Linear client id; `ade-graph` asking for it is
     * `not_permitted`, exactly as `requestHandoff` is. Ownership comes from the
     * host's own table and never from anything the plugin says about itself.
     *
     * A community plugin does not use this at all. It registers its own OAuth
     * app with the provider and puts that app's public client id in its
     * manifest ({@link PluginManifestAuthSession.clientId}), which is the
     * supported way to ship a sign-in nobody has to configure by hand.
     *
     * Rejects with `not_permitted` for a non-owner and for a provider ADE
     * bundles no client for — one code, because both mean "this plugin cannot
     * have this" and neither is fixed by retrying.
     */
    officialClient(provider: string): Promise<PluginOfficialOAuthClient>;
  };

  contributions: {
    /**
     * Publish the value of one contribution for one entity.
     *
     * **Put an `id` in the payload if you declare more than one socket of the
     * same kind on the same surface.** A published row names its plugin, its
     * entity and its socket KIND — it has no field for which of your
     * declarations it fills, so `id` is the only thing that says so, and the
     * readers' identity ladder is `id`, then the socket kind as a coarse
     * fallback that replaces every declaration you made of that kind.
     *
     * Omitting it where you declared two of a kind is genuinely ambiguous
     * rather than merely unlabelled, and the platform refuses to guess: the row
     * resolves to a declaration only when the kind was declared ONCE, and
     * otherwise does not render at all. The host logs
     * `plugin.contribution_id_ambiguous` once per plugin and kind, because you
     * are the only one who can fix it. One declaration of a kind needs nothing.
     *
     * An `id` naming a socket you no longer declare is stale and the row drops,
     * rather than adopting a slot its author never chose.
     *
     * **Known limitation — one published value per kind per entity.** The row's
     * key is `(entityKind, entityId, pluginId, socket)`, where `socket` is the
     * KIND. So a plugin declaring two same-kind sockets on one surface can
     * publish a value for only ONE of them against any given entity: a second
     * publish for that entity and kind REPLACES the first rather than sitting
     * beside it. `id` decides which declaration the surviving row fills; the
     * other shows its manifest declaration for that entity and nothing more.
     *
     * Deliberately not fixed by widening the key. `plugin_contributions` is a
     * replicated cr-sqlite CRR table, so its primary key is a migration across
     * every synced device — a change that is designed and scheduled, never made
     * in passing to widen an addressing corner. Declare two of a kind only when
     * the second needs no per-entity value.
     */
    publish(
      entityKind: PluginEntityKind,
      entityId: string,
      socket: PluginSocketKind,
      payload: Record<string, unknown> | null,
    ): Promise<void>;
  };

  events: {
    /**
     * Subscribe to one event kind; returns an unsubscribe function.
     *
     * The change events (`*.changed`) are debounced and coalesced. The runtime
     * hooks (`turn.start`, `turn.end`, `tool.before`) are not — they are told
     * as they happen and {@link PLUGIN_RUNTIME_HOOK_EVENTS} explains what that
     * does and does not let a plugin do.
     *
     * Subscribing is not free for the host and it is not meant to be: a hook
     * kind nobody registered for is never delivered to this child at all, so
     * `tool.before` costs nothing in a plugin that does not ask for it. That
     * is why the unsubscribe function matters — dropping the last listener for
     * a kind stops the deliveries rather than merely ignoring them.
     */
    on<E extends PluginEventName>(event: E, listener: (payload: PluginEventPayloadFor<E>) => void): () => void;
  };

  panels: {
    /** Replace a panel's vocabulary schema. Rejected if the panel is undeclared. */
    update(panelId: string, schema: unknown): Promise<void>;
  };

  config: {
    /** Current values for the manifest's `settings`, defaults applied. */
    get(): Promise<Record<string, string | number | boolean | null>>;
    /**
     * Write this plugin's own settings, so a `settings-section` panel's form
     * can actually save what it renders. Answers with the new effective
     * config, defaults applied — the same shape {@link get} returns.
     *
     * Validated against the manifest's `settings`, and refused with
     * `invalid_args` when:
     * - the key is not declared (a typo would otherwise read back as a setting
     *   the plugin never sees);
     * - the value is the wrong kind for it (`toggle` wants a boolean, `number`
     *   a number, everything else text);
     * - a `select` value is not one of its declared `options`;
     * - the setting's kind is `secret` — those belong in
     *   {@link AdePluginSdk.secrets}, not in the plain config store every child
     *   is handed at spawn.
     *
     * `null` **resets**: the stored override is removed and the manifest
     * default comes back, exactly as ADE's own settings form treats it.
     *
     * Writing does not restart the plugin, so this is safe to call from inside
     * an action handler, and the very next {@link get} sees the new value.
     */
    set(key: string, value: string | number | boolean | null): Promise<Record<string, string | number | boolean | null>>;
    /** Write several settings at once. Same rules; one file write. */
    set(values: Record<string, string | number | boolean | null>): Promise<Record<string, string | number | boolean | null>>;
  };

  audio: {
    /**
     * Record a clip through ADE's microphone. See {@link PluginAudioClip}.
     *
     * Rejects with a {@link PluginAudioCaptureErrorCode} as the error's `code`
     * when the user cancels, another capture is running, or there is no
     * microphone — so a plugin branches on it rather than reading a sentence.
     */
    captureClip(options?: PluginAudioCaptureOptions): Promise<PluginAudioClip>;
  };

  notifications: {
    /**
     * Tell the user something outside ADE's window. See
     * {@link PluginNotificationInput}.
     *
     * The plugin's display name rides along with every post and is stamped by
     * the host. Rate-limited per plugin ({@link PLUGIN_NOTIFICATIONS_PER_DAY},
     * {@link PLUGIN_NOTIFICATIONS_PER_BURST}); over either ceiling rejects with
     * `plugin_budget_exceeded` carrying which one in `detail.budget`.
     */
    post(input: PluginNotificationInput): Promise<PluginNotificationResult>;
  };

  schedules: {
    /**
     * Ask the host to call one of this plugin's own actions later. See
     * {@link PluginScheduleCreateInput}.
     *
     * Rejects with `plugin_budget_exceeded` past
     * {@link PLUGIN_SCHEDULES_MAX_PER_PLUGIN} live schedules.
     */
    create(input: PluginScheduleCreateInput): Promise<PluginSchedule>;
    /** This plugin's schedules. Never another's. */
    list(): Promise<PluginSchedule[]>;
    /** Idempotent: deleting an id that is not this plugin's is a no-op, not an error. */
    delete(scheduleId: string): Promise<void>;
  };

  automations: {
    /**
     * Fire one of this plugin's declared automation triggers. See
     * {@link PluginAutomationTriggerInput}.
     *
     * The plugin says only THAT something happened; which rules care is the
     * user's business, and a plugin with no matching rule is not an error —
     * this resolves either way.
     *
     * Rejects with `invalid_args` for a `triggerId` the manifest never declared
     * (a trigger nobody could have built a rule against), and with
     * `plugin_budget_exceeded` past
     * {@link PLUGIN_AUTOMATION_TRIGGER_PAYLOAD_MAX_BYTES}.
     */
    emitTrigger(input: PluginAutomationTriggerInput): Promise<void>;
  };

  webhooks: {
    /**
     * The public URL a third party should post to for one declared channel.
     *
     * This is the string the user pastes into Stripe, GitHub, Cursor or
     * whatever else sends them events. Read it rather than building it: the
     * relay base is configurable per machine, and a plugin that hard-coded the
     * production host would send a self-hosted user's webhooks to somebody
     * else's relay.
     *
     * Rejects with `invalid_args` for a channel the manifest never declared,
     * and with `unsupported_method` on a host that runs no ingress drain.
     */
    url(channelId?: string): Promise<string>;
    /**
     * Acknowledge one delivery, by its `id`.
     *
     * Call it AFTER the work is durably done, not on receipt. An unacked
     * delivery is redelivered on the next drain tick — which is the behaviour
     * you want when your handler crashed halfway — and the redelivery carries
     * the same `id` so a plugin that records ids can tell.
     *
     * Idempotent: acking an id twice, or one that is not this plugin's, is a
     * no-op rather than an error.
     */
    ack(deliveryId: string): Promise<void>;
  };

  /**
   * Own a conversation: bind a chat session to this plugin, then write into it.
   *
   * **Every method here is refused unless this plugin owns that session.** The
   * host reads `runtimeRef.pluginId` off the session and compares it to the
   * child that asked; a mismatch, an unowned session, or a session that does
   * not exist all reject with `not_permitted` and nothing is written. This is
   * the only place in the SDK where a plugin writes words a user will read as
   * an agent's, so the check is one function, host-side, with a test that
   * proves the refusal.
   *
   * The other half of the seam is {@link PLUGIN_CHAT_RUNTIME_EVENTS}: the user
   * types, the host delivers `chat.turn`, the plugin answers with the methods
   * here. A plugin that declares a `chatRuntimes` entry and subscribes to
   * `chat.turn` is a conversation source; one that does not is not.
   */
  chat: {
    /**
     * Bind a session to one of this plugin's declared runtimes.
     *
     * Creates a new chat, or adopts the `sessionId` you name when that session
     * is not already owned by somebody. Idempotent on `{runtimeId, externalId}`
     * — calling twice for the same external conversation returns the session
     * that already exists rather than a second one, which is what makes a
     * webhook that fires before the user has opened anything safe.
     */
    createSession(input: PluginChatSessionCreateInput): Promise<PluginChatSessionRef>;
    /** Stream a piece of the assistant's reply. See {@link PluginChatAssistantChunk}. */
    appendAssistant(sessionId: string, chunk: PluginChatAssistantChunk): Promise<void>;
    /** Append a user turn ADE did not originate. See {@link PluginChatUserAppend}. */
    appendUser(sessionId: string, input: PluginChatUserAppend): Promise<void>;
    /** Report what the conversation is doing. See {@link PluginChatStatus}. */
    emitStatus(sessionId: string, status: PluginChatStatus): Promise<void>;
    /**
     * Declare the files this run produced in the lane, as a proof-artifact card.
     *
     * The plugin writes the files itself (it has the filesystem); this is how
     * they become something the user sees rather than something they would
     * have to go looking for.
     */
    setArtifacts(sessionId: string, artifacts: PluginChatArtifact[]): Promise<void>;
    /**
     * Point the session at the branch this conversation produced.
     *
     * The host fetches it into the lane worktree and records it on the session,
     * so the ordinary branch and PR affordances light up for a conversation
     * that happened somewhere else entirely.
     */
    attachBranch(sessionId: string, input: { branch: string; remote?: string }): Promise<void>;
    /**
     * Backfill a conversation that started outside ADE.
     *
     * Oldest first. Deduped against what the transcript already holds by
     * `fingerprint`, so calling this again after a reconnect adds only what is
     * new.
     *
     * **Capped at {@link PLUGIN_CHAT_HYDRATE_MAX_ENTRIES} per call — page it.**
     * Send the oldest page first with no options, then each later page with
     * `{append: true}`:
     *
     * ```js
     * let first = true;
     * for (const page of pagesOldestFirst) {
     *   const { accepted } = await ade.chat.hydrate(sessionId, page, { append: !first });
     *   first = false;
     *   if (!accepted) break; // ADE already had this far back
     * }
     * ```
     *
     * A whole sweep is bounded by
     * {@link PLUGIN_CHAT_HYDRATE_SWEEP_MAX_ENTRIES}.
     */
    hydrate(
      sessionId: string,
      transcript: PluginChatTranscriptEntry[],
      options?: PluginChatHydrateOptions,
    ): Promise<PluginChatHydrateResult>;
  };

  /**
   * The user's lanes, and the issue links on them.
   *
   * This is the seam that makes a tracker plugin a first-class one. ADE's own
   * Linear integration links an issue to a lane so the branch namer, the PR
   * body writer and the deeplink envelope all know what the work is about; a
   * plugin for Jira, Shortcut or anything else reaches the same machinery
   * through {@link IssueRef} instead of getting a second, parallel one.
   *
   * Two ownership rules, both enforced host-side:
   *
   * - The link records the plugin that created it, from the child connection
   *   that asked. `input.issue` has no `pluginId` field to fill in.
   * - `unlinkIssue` removes only links THIS plugin created. Another plugin's
   *   link, or one ADE made itself, is `not_permitted`. The user can still
   *   unlink anything from the lane UI, the CLI or the action layer — the
   *   restriction is on plugins undoing each other, not on the person.
   */
  lanes: {
    /** Every open lane in the project this plugin is bound to. */
    list(): Promise<PluginLaneSummary[]>;
    get(laneId: string): Promise<PluginLaneSummary | null>;
    /**
     * The issues linked to the SESSIONS inside one lane, grouped by session.
     *
     * The half of the picture a lane summary cannot carry — see
     * {@link PluginSessionIssues}. A lane with no session links answers an
     * empty array, and a lane this project does not have answers an empty array
     * too: "no session in that lane has a linked issue" is the same fact either
     * way, and a plugin acting on a merged PR should not have to tell them
     * apart.
     *
     * Union it with the lane's own `primaryIssue` and `issueLinks` — deduped by
     * `provider:issueId` — to see exactly what ADE's own PR→Done rule sees.
     */
    listSessionIssues(laneId: string): Promise<PluginSessionIssues[]>;
    /**
     * Link an issue to a lane or to a chat/CLI session.
     *
     * Exactly one of `laneId` and `sessionId`. Both, or neither, is
     * `invalid_args` — a link with no target is not a link, and a call naming
     * two would leave the plugin guessing which one the host picked.
     */
    linkIssue(input: PluginIssueLinkInput): Promise<PluginIssueLink>;
    /**
     * Remove a link this plugin created. `false` when there was none to
     * remove, which is not an error; `not_permitted` when the link belongs to
     * somebody else.
     */
    unlinkIssue(input: PluginIssueUnlinkInput): Promise<boolean>;
  };

  clipboard: {
    /** Whatever the user last copied, as text. See {@link PLUGIN_CLIPBOARD_TEXT_MAX_BYTES}. */
    read(): Promise<string>;
    write(text: string): Promise<void>;
  };

  dialogs: {
    /**
     * Ask the user for a path through the OS picker. See
     * {@link PluginFilePickerOptions}.
     *
     * Rejects with `dialog_cancelled` when the user dismisses it and
     * `desktop_unavailable` when ADE Desktop is not running.
     */
    pickFile(options?: PluginFilePickerOptions): Promise<string>;
  };

  /**
   * This plugin's own durable memory. See {@link PLUGIN_MEMORY_COLLECTION} for
   * what it is, and — more importantly — what it is not.
   */
  memory: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: { keyPrefix?: string; limit?: number }): Promise<PluginCollectionRow[]>;
  };

  log(level: PluginLogLevel, message: string, fields?: Record<string, unknown>): void;
};

// ---------------------------------------------------------------------------
// Action-response navigation
// ---------------------------------------------------------------------------

/**
 * Largest `context` an action may hand to the surface it navigates to.
 *
 * Small on purpose. This is a pointer — "the issue you just filed is ISS-14" —
 * not a payload: the panel it lands on reads the plugin's own collections for
 * everything else, and a context big enough to carry a page would become a
 * second, unversioned data channel that no budget accounts for. It is also the
 * cap on a `plugin` deeplink's `?ctx=`, because the two are the same value
 * arriving by different routes and a link that a plugin could not have minted
 * itself would be a strange thing to honour.
 */
export const PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES = 2 * 1024;

/**
 * Where a plugin action asks the client to go when it finishes.
 *
 * The one piece of control flow a plugin has over ADE's own navigation, and it
 * is deliberately a request rather than a command: it names a panel of the
 * plugin's OWN surface, so the worst a malicious or broken value can do is show
 * the wrong page of the plugin the user just pressed a button in.
 */
export type PluginActionNavigation = {
  /** A panel of the same plugin. Anything else is dropped by the reader. */
  panelId: string;
  /**
   * Handed to the destination panel as its render context: available to the
   * panel's schema through the `$context` binding, and attached to every action
   * that panel then dispatches. See `./vocabulary.ts`.
   */
  context?: Record<string, unknown>;
  /**
   * Where the panel should open. Absent means "wherever this client would put
   * it", which is the value almost every plugin should send.
   *
   * It exists because the default is not one place. A button pressed inside a
   * conversation asked for the panel BESIDE the conversation, and a plugin
   * cannot know whether the client it is talking to has such a place: the
   * desktop's Work tools rail is not a thing iOS or the terminal has. So the
   * client decides — a chat-scoped press opens the plugin's Work pane where the
   * plugin declares one — and this field is the override for the two cases where
   * the plugin genuinely knows better: `"tab"` for a panel too large to sit in a
   * rail, `"tools-pane"` for one that must not take the whole window.
   *
   * A client with no such place ignores it and opens the panel the one way it
   * has, which is why an unknown value drops rather than refusing the
   * navigation.
   */
  target?: PluginActionNavigationTarget;
};

/**
 * The two places a client may be asked to put a navigated-to panel.
 *
 * Deliberately not a client-specific list. `tools-pane` names the idea of a
 * panel beside the thing you were doing — the desktop's Work rail today — and a
 * client that grows its own version of that renders it there without any plugin
 * changing a manifest.
 */
export const PLUGIN_ACTION_NAVIGATION_TARGETS = ["tab", "tools-pane"] as const;

export type PluginActionNavigationTarget = (typeof PLUGIN_ACTION_NAVIGATION_TARGETS)[number];

/**
 * Read a navigation request out of whatever an action returned.
 *
 * Tolerant by design — an action's return value is the plugin's own shape and
 * most of them carry no navigation at all, so anything unrecognizable is
 * `null`, never an error. Validating here rather than at each of the four call
 * sites (panel button, socket invoke, iOS sheet, TUI pane) is what keeps the
 * ceiling and the panel-id rule from drifting apart between them.
 */
export function readPluginActionNavigation(result: unknown): PluginActionNavigation | null {
  if (!isRecord(result)) return null;
  const navigate = result.navigate;
  if (!isRecord(navigate)) return null;
  const panelId = navigate.panelId;
  if (typeof panelId !== "string" || !isValidPluginManifestIdentifier(panelId)) return null;
  // Tolerant like the context below, and for a stronger reason: `target` is a
  // preference, not an address. A value this build has never heard of drops and
  // the client falls back to its own default, so a plugin naming a place a
  // future ADE has still lands the reader on the panel.
  const target = oneOf(navigate.target, PLUGIN_ACTION_NAVIGATION_TARGETS);
  const placement = target ? { target } : {};
  const context = navigate.context;
  if (!isRecord(context)) return { panelId, ...placement };
  let json: string;
  try {
    json = JSON.stringify(context) ?? "";
  } catch {
    return { panelId, ...placement };
  }
  // Over the ceiling drops the context and keeps the navigation: the user
  // pressed a button and should still land where it sent them.
  if (!json || pluginUtf8ByteLength(json) > PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES) {
    return { panelId, ...placement };
  }
  return { panelId, context, ...placement };
}

// ---------------------------------------------------------------------------
// Action-response composer edits
// ---------------------------------------------------------------------------

/**
 * Largest draft text an action may write into the composer.
 *
 * A liveness bound, not a permission: the string lands in a contenteditable
 * that re-renders and re-tokenizes on every change, and a plugin returning a
 * megabyte would wedge the renderer rather than fill a prompt. 32 KiB is an
 * enormous chat message and a small DOM edit. Over it, the edit is dropped and
 * the client says so — never truncated, because a prompt cut off mid-sentence
 * and then sent is worse than a prompt that never arrived.
 */
export const PLUGIN_COMPOSER_TEXT_MAX_BYTES = 32 * 1024;

/**
 * What a plugin action asks the composer to do with the draft when it finishes.
 *
 * The second piece of control flow a plugin has over ADE's own UI, alongside
 * {@link PluginActionNavigation}, and bounded the same way: it writes into the
 * one text box the user was already typing in, on the surface they just pressed
 * a button on. It cannot send the message — composing and sending stay the
 * user's.
 */
export type PluginActionComposerEdit =
  /** Insert at the caret, leaving the rest of the draft alone. */
  | { mode: "insert"; text: string }
  /** Replace the whole draft. An empty string clears it. */
  | { mode: "replace"; text: string };

/**
 * Read a composer edit out of whatever an action returned.
 *
 * Tolerant in the same way as {@link readPluginActionNavigation}: an action's
 * return value is the plugin's own shape, most carry no edit at all, and
 * anything unrecognizable is `null` rather than an error.
 *
 * `replaceText` wins when a plugin sends both. "Replace, then insert into the
 * replacement" is not what either verb means, and picking the more total one
 * makes the result a plugin can predict from its own payload.
 */
export function readPluginActionComposerEdit(result: unknown): PluginActionComposerEdit | null {
  if (!isRecord(result)) return null;
  const composer = result.composer;
  if (!isRecord(composer)) return null;
  const withinBudget = (text: string): boolean =>
    pluginUtf8ByteLength(text) <= PLUGIN_COMPOSER_TEXT_MAX_BYTES;
  // Empty is meaningful for replace (clear the draft) and a no-op for insert,
  // so only replace accepts it.
  if (typeof composer.replaceText === "string") {
    return withinBudget(composer.replaceText) ? { mode: "replace", text: composer.replaceText } : null;
  }
  if (typeof composer.insertText === "string" && composer.insertText.length > 0) {
    return withinBudget(composer.insertText) ? { mode: "insert", text: composer.insertText } : null;
  }
  return null;
}

/**
 * Whether an action's result asked for a composer edit at all, however
 * malformed.
 *
 * Separate from the reader because "the plugin said nothing about the composer"
 * and "the plugin asked for something this client refused" are different
 * events, and only the second is worth a warning in the console of the person
 * wondering why the button did nothing.
 */
export function hasPluginActionComposerRequest(result: unknown): boolean {
  return isRecord(result) && isRecord(result.composer);
}

// ---------------------------------------------------------------------------
// Action-response dialog edits
// ---------------------------------------------------------------------------

/**
 * Largest value an action may write into a dialog field.
 *
 * Sized for the one long field in the set — a PR body — and applied to all of
 * them, because a per-field ceiling would be a second table to keep in step
 * with the first. Over it the edit is dropped rather than truncated, the same
 * rule as the composer: a half-written branch name that then gets created is
 * worse than a field that stayed empty.
 */
export const PLUGIN_DIALOG_FIELD_VALUE_MAX_BYTES = 16 * 1024;

/**
 * What a plugin action asks one of ADE's dialogs to do when it finishes.
 *
 * The third piece of control flow a plugin has over ADE's own UI, and the most
 * tightly bounded of the three: it writes ONE allowlisted field of the dialog
 * the user opened, on the surface they just pressed a button in. It cannot
 * submit the dialog, cannot touch a confirmation control, and cannot name a
 * field the dialog does not advertise — see `PLUGIN_DIALOG_FIELDS`. Creating
 * the lane, or the PR, stays the user's.
 *
 * This is what makes "pick a Linear issue, fill in the lane name and base
 * branch" a thing a third-party plugin can do, rather than a thing only the
 * built-in integration can do.
 */
export type PluginActionDialogEdit<K extends PluginDialogKind = PluginDialogKind> = {
  field: PluginDialogField<K>;
  value: string;
};

/**
 * Read a dialog edit out of whatever an action returned.
 *
 * Takes the dialog it is being read FOR, because the allowlist is per dialog
 * and a create-lane section returning `{field: "body"}` is not a partial
 * success to be filtered later — it is an edit for a different dialog, and the
 * only place that can tell is the one holding the dialog kind.
 *
 * Tolerant in the same way as {@link readPluginActionNavigation}: unrecognized
 * shapes are `null`, never an error.
 */
export function readPluginActionDialogEdit<K extends PluginDialogKind>(
  result: unknown,
  dialog: K,
): PluginActionDialogEdit<K> | null {
  if (!isRecord(result)) return null;
  const request = result.dialog;
  if (!isRecord(request)) return null;
  const setField = request.setField;
  if (!isRecord(setField)) return null;
  const { field, value } = setField;
  if (!isPluginDialogField(dialog, field)) return null;
  if (typeof value !== "string") return null;
  if (pluginUtf8ByteLength(value) > PLUGIN_DIALOG_FIELD_VALUE_MAX_BYTES) return null;
  return { field, value };
}

/**
 * Whether an action's result asked to write a dialog field at all, however
 * malformed. Separate from the reader for the same reason as the composer's
 * pair: "said nothing" and "asked for something this dialog refused" are
 * different events, and only the second is worth a warning.
 */
export function hasPluginActionDialogRequest(result: unknown): boolean {
  return isRecord(result) && isRecord(result.dialog) && isRecord((result.dialog as Record<string, unknown>).setField);
}

// ---------------------------------------------------------------------------
// Action-response webview overlay
// ---------------------------------------------------------------------------

/**
 * The plugin-authored pointer an `openWebview` action may hand its own page.
 *
 * Bounded like {@link PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES}, and for the same
 * reason: it is a hint the page reads on open — "the drink you just poured is
 * #4" — not a data channel. The host injects the button's real subject (which
 * chat/lane/PR) separately and unforgeably; this is only the extra the plugin
 * chose to add.
 */
export const PLUGIN_WEBVIEW_POINTER_MAX_BYTES = PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES;

/**
 * Where a plugin action asks the client to open one of the plugin's OWN webview
 * surfaces, as a focused overlay over whatever the button sat on.
 *
 * The fourth piece of control flow a plugin has over ADE's own UI, beside
 * navigate, composer and dialog — and, like navigate, a request rather than a
 * command: `surfaceId` names a `webview` surface of the SAME plugin, so the
 * worst a bad value does is open the wrong page of the plugin the user just
 * pressed a button in. The host supplies the subject; a client that cannot host
 * a webview (web) shows that surface's required fallback panel instead.
 */
export type PluginActionWebview = {
  /** A `webview` surface of the same plugin. Anything else the host drops. */
  surfaceId: string;
  /** An optional pointer handed to the page as its context `pointer`. */
  context?: Record<string, unknown>;
};

/**
 * Read an overlay request out of whatever an action returned.
 *
 * Tolerant in the same way as {@link readPluginActionNavigation}: most results
 * carry no overlay request, so anything unrecognizable is null rather than an
 * error, and an over-ceiling pointer is dropped while the open is kept.
 */
export function readPluginActionWebview(result: unknown): PluginActionWebview | null {
  if (!isRecord(result)) return null;
  const request = result.openWebview;
  if (!isRecord(request)) return null;
  const surfaceId = request.surfaceId;
  if (typeof surfaceId !== "string" || !isValidPluginManifestIdentifier(surfaceId)) return null;
  const context = request.context;
  if (!isRecord(context)) return { surfaceId };
  let json: string;
  try {
    json = JSON.stringify(context) ?? "";
  } catch {
    return { surfaceId };
  }
  if (!json || pluginUtf8ByteLength(json) > PLUGIN_WEBVIEW_POINTER_MAX_BYTES) return { surfaceId };
  return { surfaceId, context };
}

/**
 * Whether an action's result asked to open a webview at all, however malformed.
 * The warning half of the pair, for the same reason the composer verb has one.
 */
export function hasPluginActionWebviewRequest(result: unknown): boolean {
  return isRecord(result) && isRecord(result.openWebview);
}

// ---------------------------------------------------------------------------
// Action-response outcome message
// ---------------------------------------------------------------------------

/** Longest outcome sentence a client shows. A banner, not a transcript. */
export const PLUGIN_ACTION_MESSAGE_MAX_CHARS = 400;

/** What an action said about how it went, and whether it went well. */
export type PluginActionMessage = { text: string; ok: boolean };

/**
 * Read the outcome sentence out of whatever an action returned.
 *
 * Two shapes reach the renderer and both are normal. Over sync, the host wraps
 * every handler return as `{ok, message?, result}`
 * (`syncRemoteCommandService.ts`), which is what the phone decodes. Over the
 * desktop's local IPC, `plugin.invoke` hands the handler's own return back
 * untouched. The same renderer draws both, so the message is read from either
 * — otherwise "Created lane 'x'." would appear in the web client and vanish on
 * desktop, from one line of plugin code.
 *
 * A bare string return is the message, which is the same reading the sync path
 * already applies before it builds the envelope.
 *
 * `null` when the action said nothing. Silence is not an outcome to draw: most
 * actions change something the panel then re-renders, and a "Done" banner on
 * every press would be noise rather than feedback.
 */
export function readPluginActionMessage(result: unknown): PluginActionMessage | null {
  if (typeof result === "string") {
    const text = result.trim();
    return text ? { text: text.slice(0, PLUGIN_ACTION_MESSAGE_MAX_CHARS), ok: true } : null;
  }
  if (!isRecord(result)) return null;
  const raw = result.message;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  // `ok` is the envelope's field and a handler may write it too; they mean the
  // same thing. Absent reads as success, because a handler that answered at all
  // did not fail — the error path is a thrown rejection.
  return {
    text: text.slice(0, PLUGIN_ACTION_MESSAGE_MAX_CHARS),
    ok: result.ok !== false,
  };
}

// ---------------------------------------------------------------------------
// Action-response external links
// ---------------------------------------------------------------------------

/**
 * Longest external URL an action may ask a client to open.
 *
 * The same number as a `markdown` node's links, because it is the same number:
 * both read {@link PLUGIN_URL_MAX_CHARS} in `parse.ts` rather than declaring a
 * ceiling of their own. A link a plugin may open from a button and a link it may
 * write into prose are one capability.
 */
export const PLUGIN_OPEN_URL_MAX_CHARS = PLUGIN_URL_MAX_CHARS;

/**
 * Where a plugin action asks the client to send the reader on the open web.
 *
 * The fifth piece of control flow a plugin has over ADE's UI, beside navigate,
 * composer, dialog and openWebview — and the only one that leaves ADE. It is
 * how a panel offers "All agents on cursor.com" or "Open PR", which no node can
 * express: `text` is plain text on every client and never linkified, and
 * `fallback.deeplink` draws only on the failure card.
 */
export type PluginActionOpenUrl = { url: string };

/**
 * Read an external-link request out of whatever an action returned.
 *
 * Tolerant in the same way as {@link readPluginActionNavigation}: most results
 * carry no link, so anything unrecognizable is `null` rather than an error.
 *
 * **`https:` only.** The URL comes from the plugin child, which is code the
 * user installed, so this is not a defence against the plugin — it closes the
 * two abuses that do not need one. `file:` would make a link a local-file read
 * on a client that renders what it opens. `javascript:` and `data:` would make
 * a link script. `ade:` is refused too, because in-app destinations are what
 * `navigate` and `fallback.deeplink` are for and a second route to them would
 * bypass the installed-and-enabled gate those pass. Plain `http:` is refused
 * because a plugin that knows its own URL knows its scheme, and a downgrade is
 * always a mistake rather than a choice.
 *
 * Case is not a way in: `URL` lowercases the protocol it parses, so `HTTPS:`
 * reads as `https:` and `JavaScript:` reads as `javascript:`.
 *
 * The scheme test itself is {@link httpsUrl} in `parse.ts`, shared with the
 * `markdown` node so a link refused on a button cannot be accepted in prose.
 */
export function readPluginActionOpenUrl(result: unknown): PluginActionOpenUrl | null {
  if (!isRecord(result)) return null;
  const request = result.openUrl;
  const raw = typeof request === "string" ? request : isRecord(request) ? request.url : undefined;
  const url = httpsUrl(raw, PLUGIN_OPEN_URL_MAX_CHARS);
  return url === null ? null : { url };
}

/**
 * Whether an action's result asked to open a URL at all, however malformed.
 * The warning half of the pair, so a refused scheme is a logged line rather
 * than a button that silently does nothing.
 */
export function hasPluginActionOpenUrlRequest(result: unknown): boolean {
  if (!isRecord(result)) return false;
  return typeof result.openUrl === "string" || isRecord(result.openUrl);
}

// ---------------------------------------------------------------------------
// Action-response sign-in
// ---------------------------------------------------------------------------

/**
 * "Present this sign-in", as a client reads it.
 *
 * The eighth action result, and the only one whose payload the HOST writes. A
 * plugin returns `{ authSession: { sessionId } }` and nothing else; the host
 * looks that id up in its own table of live flows and stamps `url`,
 * `transport` and `callbackScheme` on the way out. So the worst a forged
 * result can do is present one of this plugin's own declared, already-running
 * flows — it cannot name a URL, and there is no path by which a URL a plugin
 * typed reaches a browser.
 *
 * This is deliberately NOT `openUrl`. A URL opened in the system browser has no
 * way back on a phone, which is the whole of gap C1: the client has to know
 * this is a sign-in so it can use an in-app auth session and catch the
 * callback, and a result kind is how it knows.
 */
export type PluginActionAuthSession = {
  sessionId: string;
  /** Host-stamped. `https:`, and always the origin the manifest declared. */
  url: string;
  transport: PluginAuthCallbackKind;
  /**
   * The scheme the client's in-app auth session must watch for, on the `app`
   * transport. Absent for `loopback`, where the host catches the redirect
   * itself and the client's only job is to open a browser.
   */
  callbackScheme?: string;
};

/**
 * What a plugin may put in the result, before the host fills the rest in.
 *
 * A separate type from {@link PluginActionAuthSession} because the two shapes
 * are genuinely different: this one is a request naming a flow, and that one is
 * an instruction carrying a URL. Collapsing them would put a `url` field in
 * front of every plugin author, and a field a plugin can write is a field the
 * host has to be careful about forever.
 */
export type PluginActionAuthSessionRequest = { sessionId: string };

/** The plugin's half: a declared flow id, and nothing the host would trust. */
export function readPluginActionAuthSessionRequest(result: unknown): PluginActionAuthSessionRequest | null {
  if (!isRecord(result)) return null;
  const request = result.authSession;
  if (!isRecord(request)) return null;
  const sessionId = request.sessionId;
  return isValidPluginManifestIdentifier(sessionId) ? { sessionId } : null;
}

/**
 * The host's half: the stamped instruction a client presents.
 *
 * Tolerant like every other reader here — a client talking to an older host
 * that never stamped one sees `null` and draws nothing, rather than throwing on
 * a field it was not sent.
 */
export function readPluginActionAuthSession(result: unknown): PluginActionAuthSession | null {
  if (!isRecord(result)) return null;
  const request = result.authSession;
  if (!isRecord(request)) return null;
  const sessionId = request.sessionId;
  if (!isValidPluginManifestIdentifier(sessionId)) return null;
  const url = httpsUrl(request.url, PLUGIN_OPEN_URL_MAX_CHARS);
  if (url === null) return null;
  const transport = request.transport;
  if (transport !== "loopback" && transport !== "app") return null;
  const callbackScheme = typeof request.callbackScheme === "string" && request.callbackScheme
    ? request.callbackScheme
    : undefined;
  return { sessionId, url, transport, ...(callbackScheme ? { callbackScheme } : {}) };
}

/**
 * Whether a result asked for a sign-in at all, however malformed.
 *
 * The warning half of the pair, and it matters more here than for `openUrl`: a
 * sign-in that silently does nothing looks to the user exactly like a Connect
 * button that is broken, and the plugin author needs the logged line to find
 * out that the host retired the flow before the result reached the client.
 */
export function hasPluginActionAuthSessionRequest(result: unknown): boolean {
  return isRecord(result) && isRecord(result.authSession);
}

// ---------------------------------------------------------------------------
// Action-response prompt
// ---------------------------------------------------------------------------

/**
 * Longest answer a reader may type into a prompt.
 *
 * A liveness bound, like the composer's, and much smaller because this is one
 * field rather than a draft message: a line of text about what you are doing,
 * a bookmark title, a snippet name. Past it the client refuses the submit and
 * says so, rather than truncating — a note cut in half and then saved is worse
 * than one the reader was asked to shorten.
 */
export const PLUGIN_PROMPT_TEXT_MAX_BYTES = 4 * 1024;

/** Longest title, placeholder and submit label a prompt may carry. */
export const PLUGIN_PROMPT_TITLE_MAX_CHARS = 120;
export const PLUGIN_PROMPT_PLACEHOLDER_MAX_CHARS = 120;
export const PLUGIN_PROMPT_SUBMIT_LABEL_MAX_CHARS = 24;

/**
 * A one-field question an action asks before it can finish.
 *
 * The sixth piece of control flow a plugin has over ADE's UI, beside navigate,
 * composer, dialog, openWebview and openUrl — and the only one that comes BACK.
 * A button that answers `{prompt}` is re-invoked: the client asks the question,
 * and calls the SAME action again with the same arguments plus
 * {@link PluginActionPromptAnswer} under `args.prompt`.
 *
 * It exists because the ordinary request — "a Log it button that saves a
 * one-line note of what I'm doing" — had no shape at all. The workarounds were
 * logging the chat's auto-generated title (junk), navigating the reader off
 * what they were doing into a panel with a form, or a slash command they cannot
 * discover. One field, in place, is what the request actually was.
 *
 * ONE HOP. A re-invocation's own `{prompt}` is ignored by every client, so a
 * plugin cannot build a wizard out of it and cannot trap the reader in a loop
 * it keeps re-opening. A plugin needing a second field has a panel `form`.
 */
export type PluginActionPrompt = {
  /**
   * WHICH question this is.
   *
   * Required, and echoed back verbatim in the answer, because one action may
   * ask more than one thing across its branches — "what are you working on?"
   * and "what is blocking you?" are the same handler — and a handler that
   * cannot tell them apart has to keep the distinction somewhere the reader can
   * invalidate. Shaped like every other plugin identifier.
   */
  id: string;
  /** The question. Absent means the client uses the control's own label. */
  title?: string;
  /** Grey text in the empty field. */
  placeholder?: string;
  /** The confirm button's word. Absent means the client's own default. */
  submitLabel?: string;
  /**
   * A plugin-authored pointer, handed back untouched in the answer.
   *
   * Bounded like a navigation's context and used the same way: the handler
   * remembers which lane it was asking about without keeping per-reader state
   * between two invocations of itself.
   */
  context?: Record<string, unknown>;
};

/** What the client puts under `args.prompt` when it re-invokes the action. */
export type PluginActionPromptAnswer = {
  /** The `id` of the {@link PluginActionPrompt} this answers. */
  id: string;
  /** What the reader typed. Never longer than the ceiling; may be empty. */
  text: string;
  /** The prompt's own `context`, verbatim, when it carried one. */
  context?: Record<string, unknown>;
};

/**
 * Read a prompt request out of whatever an action returned.
 *
 * Tolerant in the same way as {@link readPluginActionNavigation}: most results
 * carry no prompt, so anything unrecognizable is `null` rather than an error.
 * An over-ceiling `context` drops the pointer and keeps the question, exactly
 * as a navigation keeps its destination.
 */
export function readPluginActionPrompt(result: unknown): PluginActionPrompt | null {
  if (!isRecord(result)) return null;
  const request = result.prompt;
  if (!isRecord(request)) return null;
  const id = request.id;
  if (typeof id !== "string" || !isValidPluginManifestIdentifier(id)) return null;
  const prompt: PluginActionPrompt = { id };
  const title = bounded(request.title, PLUGIN_PROMPT_TITLE_MAX_CHARS);
  if (title) prompt.title = title;
  const placeholder = bounded(request.placeholder, PLUGIN_PROMPT_PLACEHOLDER_MAX_CHARS);
  if (placeholder) prompt.placeholder = placeholder;
  const submitLabel = bounded(request.submitLabel, PLUGIN_PROMPT_SUBMIT_LABEL_MAX_CHARS);
  if (submitLabel) prompt.submitLabel = submitLabel;
  const context = request.context;
  if (!isRecord(context)) return prompt;
  let json: string;
  try {
    json = JSON.stringify(context) ?? "";
  } catch {
    return prompt;
  }
  if (!json || pluginUtf8ByteLength(json) > PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES) return prompt;
  prompt.context = context;
  return prompt;
}

/**
 * Whether an action's result asked a question at all, however malformed.
 * The warning half of the pair, so a prompt refused for a bad `id` is a logged
 * line rather than a button that silently does nothing.
 */
export function hasPluginActionPromptRequest(result: unknown): boolean {
  return isRecord(result) && isRecord(result.prompt);
}

/**
 * The answer, as the arguments frame the re-invocation carries.
 *
 * One builder for all four clients so the shape a handler reads cannot differ
 * between the desktop popover, the phone's alert and the terminal's input. The
 * text is REFUSED rather than truncated past the ceiling — `null` here means
 * the client must not re-invoke and should say why.
 */
export function buildPluginActionPromptAnswer(
  prompt: PluginActionPrompt,
  text: string,
): PluginActionPromptAnswer | null {
  if (pluginUtf8ByteLength(text) > PLUGIN_PROMPT_TEXT_MAX_BYTES) return null;
  return { id: prompt.id, text, ...(prompt.context ? { context: prompt.context } : {}) };
}

/**
 * What a plugin's entry module may export. Both hooks are optional: a plugin
 * that only registers CLI commands and panels needs neither.
 */
export type PluginModule = {
  activate?: (sdk: AdePluginSdk) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
  /** Named handlers reachable as `plugin.invoke {pluginId, action}`. */
  actions?: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>;
};

// ---------------------------------------------------------------------------
// Child transport (NDJSON over stdio — one JSON object per line)
// ---------------------------------------------------------------------------

/** Host → child. */
export type PluginHostFrame =
  | {
    type: "hello";
    sdkVersion: number;
    pluginId: string;
    pluginRoot: string;
    manifest: PluginManifest;
    config: Record<string, string | number | boolean | null>;
  }
  | { type: "invoke"; requestId: string; action: string; args: Record<string, unknown> }
  | { type: "event"; payload: PluginAnyEventPayload }
  /** Reply to a `sdk` frame the child sent. */
  | { type: "sdkResult"; requestId: string; result?: unknown; error?: PluginStructuralError }
  | { type: "shutdown" };

/**
 * Record a clip through ADE's microphone.
 *
 * A plugin child is a separate process with no audio device, so the app records
 * on its behalf and answers with a FILE PATH — a plain path on the same
 * machine, readable with `fs`, deliberately not inside any sandbox. Passing the
 * path rather than the bytes keeps a multi-megabyte clip out of the RPC
 * envelope, which would otherwise encode and decode it twice.
 *
 * ADE never interprets the audio. What the clip is for — a transcript, a memo,
 * a classifier — is entirely the plugin's business, and the host never learns
 * which it was.
 *
 * The user is always in control and always told who is asking: a capture puts
 * an attributed pill in ADE's chrome with the plugin's display name on it, and
 * the recording ends when the user stops it (or `maxDurationMs` elapses).
 * Dismissing the pill rejects the call with `audio_capture_cancelled`. There is
 * one microphone, so a capture requested while another is running is refused
 * with `audio_capture_busy` rather than queued — a plugin that waited its turn
 * would start recording at a moment the user has no reason to associate with it.
 *
 * The clip is CALLER-OWNED once handed over: read it, and it is yours. ADE
 * sweeps clips left behind by a crash on its next start, so a plugin that dies
 * mid-read does not leak audio onto the disk forever.
 */
export type PluginAudioCaptureOptions = {
  /** Stop and return what was captured after this long. */
  maxDurationMs?: number;
};

export type PluginAudioClip = {
  /** Absolute path to a 16 kHz mono 16-bit PCM WAV on this machine. */
  audioPath: string;
  durationMs: number;
};

/** Rejection codes `audio.captureClip` can answer with. */
export const PLUGIN_AUDIO_CAPTURE_ERROR_CODES = [
  "audio_capture_cancelled",
  "audio_capture_busy",
  "audio_capture_mic_unavailable",
  "audio_capture_empty",
  "audio_capture_failed",
] as const;

export type PluginAudioCaptureErrorCode = (typeof PLUGIN_AUDIO_CAPTURE_ERROR_CODES)[number];

export function isPluginAudioCaptureErrorCode(value: unknown): value is PluginAudioCaptureErrorCode {
  return PLUGIN_AUDIO_CAPTURE_ERROR_CODES.some((code) => code === value);
}

// ---------------------------------------------------------------------------
// Host capabilities — things the app does on a plugin's behalf
// ---------------------------------------------------------------------------

/**
 * Refusals from the capabilities below, as their own vocabulary.
 *
 * Same argument as {@link PLUGIN_AUDIO_CAPTURE_ERROR_CODES}: `code` is the only
 * field that survives the child boundary intact, and each of these is a normal
 * outcome rather than a fault. A plugin that read "the user closed the file
 * picker" as an internal error would log a crash for a deliberate act.
 */
export const PLUGIN_HOST_CAPABILITY_ERROR_CODES = [
  /** Nothing on this machine could show the notification — no desktop, no paired phone. */
  "notification_unavailable",
  /**
   * The capability needs ADE Desktop and none is attached.
   *
   * One code for every Electron-only verb (clipboard, file picker) rather than
   * one each: the plugin's remedy is identical — ask again when the app is
   * running — and the layer that discovered it is not the plugin's business.
   */
  "desktop_unavailable",
  /** The user dismissed the picker. Not a failure; nothing was chosen. */
  "dialog_cancelled",
  /**
   * The plugin asked for a host its manifest does not declare.
   *
   * Raised inside the child by the network guard rather than by the host, and
   * in this union anyway for the same reason as the rest: `code` is the only
   * field that survives the boundary, and "I am not allowed to call this" is an
   * outcome the plugin should report as a missing declaration rather than as a
   * network error the user might retry. See `shared/plugins/network.ts`.
   */
  "network_host_not_declared",
  /**
   * A sign-in for this flow is already running.
   *
   * Its own code because the remedy is neither "declare something" nor "try
   * again later" but "the user is already looking at a browser window you
   * opened". One live attempt per declared flow is the whole safety property:
   * two would race for one loopback port, and the second callback would arrive
   * carrying a `state` the host had already retired.
   */
  "auth_session_busy",
  /**
   * No client on this machine can present a sign-in right now.
   *
   * A headless brain with no desktop attached and no phone paired cannot open a
   * browser, and the honest answer is that the flow cannot start — not that it
   * started and will never finish. Same shape as `desktop_unavailable`: ask
   * again when something that can show a window is there.
   */
  "auth_unavailable",
] as const;

/**
 * The most parameters a plugin may add to an authorize URL, and the most bytes
 * each may carry.
 *
 * A real flow adds four or five — `client_id`, `scope`, `response_type`,
 * `code_challenge`, `code_challenge_method`. The ceiling is here because these
 * become the query string of a URL the host puts in front of the user, and a
 * plugin that could write an unbounded one could bury the origin off the end of
 * a phone's address bar.
 */
export const PLUGIN_AUTH_PARAMS_MAX = 12;
export const PLUGIN_AUTH_PARAM_VALUE_MAX = 512;

/**
 * The parameter names the HOST owns, which a plugin may not send.
 *
 * `redirect_uri` and `state` are the two halves of the safety property: the
 * host decides where the browser comes back to and what proves it is the same
 * flow. A plugin that could set either could point the redirect at its own
 * server or replay a `state` the host had retired, and the refusal is by name
 * rather than by silent overwrite so the author learns which of the two the
 * platform is holding.
 */
export const PLUGIN_AUTH_RESERVED_PARAMS: readonly string[] = ["redirect_uri", "state"] as const;

/**
 * What `ade.auth.beginSession` answers with.
 *
 * Note what is NOT here: the URL. The plugin does not need it — the host puts
 * it in front of the user — and giving it to the child would put a live
 * authorize URL, `state` and all, inside the one process this design keeps it
 * out of. A plugin returns `{ authSession: { sessionId } }` from its action and
 * the host fills the URL in on the way to the client.
 */
export type PluginAuthSessionStart = {
  sessionId: string;
  /** Ties a later `auth.completed` to THIS begin. Opaque; compare, never parse. */
  attempt: string;
  /** Which transport the host chose for the client that asked. */
  transport: PluginAuthCallbackKind;
  /**
   * The redirect the provider must have on file, so a plugin can say which one
   * to register — and so `ade plugin doctor` can print it for a plugin that is
   * installed and not running, which is exactly when the user is setting the
   * integration up.
   */
  redirectUri: string;
  /** ISO. After this the host answers a callback with `expired` and stops listening. */
  expiresAt: string;
};

/**
 * What became of an offer to hand a plugin a credential ADE already holds.
 *
 * Every value is FINAL for this install, and there is deliberately no "the card
 * is up" state. `requestHandoff` waits for the person's answer, and a second
 * call while one card is open joins the same wait rather than stacking another
 * card — so there is no moment at which the honest answer is "ask me later",
 * and a status saying so would only invite a plugin to poll for one.
 */
export type PluginCredentialHandoffStatus =
  /** The user agreed and the secrets are in this plugin's store NOW. */
  | "accepted"
  /** The user said no. Nothing was copied and asking again does not re-prompt. */
  | "declined"
  /** ADE holds no credential for that surface, so there is nothing to offer. */
  | "empty";

/**
 * ADE's OWN registered OAuth application for one provider, as a plugin sees it.
 *
 * Three fields and no fourth. There is deliberately no `clientSecret` slot in
 * this type, so a host that somehow resolved one has nowhere to put it: the
 * absence is structural rather than a rule somebody has to remember. See
 * {@link AdePluginSdk.auth}`.officialClient` for who may ask and why the id
 * alone is safe to give.
 */
export type PluginOfficialOAuthClient = {
  /** Echoed back lowercased, so a plugin can key a cache on the answer. */
  provider: string;
  /**
   * The public `client_id` of the app ADE registered with this provider.
   *
   * Public in the literal sense: it is a query parameter of every authorize URL
   * ADE has ever put in front of a user, so it is already readable by anyone
   * who has signed in once.
   */
  clientId: string;
  /**
   * Where this client's authorize endpoint lives, when ADE knows it.
   *
   * A convenience and never a requirement: the plugin's own manifest declares
   * the `authorizeUrl` the host actually sends the browser to, and this field
   * is here so a plugin can check that the two agree rather than discovering a
   * mismatch as a provider error page.
   */
  authorizeUrl?: string;
  /**
   * The scopes ADE's own integration asks for, when the app's registration
   * depends on them.
   *
   * Linear's is the case that forced this: an ADE-app authorization only
   * delivers data-change webhooks when it carries `admin`, so a plugin that
   * inherited the client id and then asked for a narrower grant would get a
   * connection whose webhooks silently never fire.
   */
  scopes?: string[];
};

export type PluginCredentialHandoffResult = {
  builtin: string;
  status: PluginCredentialHandoffStatus;
  /**
   * The secret names this plugin will find in its own store once accepted.
   *
   * Always present, including when `declined` and when `empty`, because it is
   * the plugin's documentation of what to read — and it names nothing
   * sensitive: these are the keys, never the values.
   */
  secretNames: string[];
};

export type PluginHostCapabilityErrorCode = (typeof PLUGIN_HOST_CAPABILITY_ERROR_CODES)[number];

export function isPluginHostCapabilityErrorCode(value: unknown): value is PluginHostCapabilityErrorCode {
  return PLUGIN_HOST_CAPABILITY_ERROR_CODES.some((code) => code === value);
}

/**
 * Post a notification the user sees outside ADE's window.
 *
 * ATTRIBUTED, always: the plugin supplies the words, the host supplies the
 * name. `title` and `body` are the plugin's; the requesting plugin's
 * `displayName` is stamped on by the host and cannot be claimed, spoofed or
 * omitted from the payload. This is the same rule the audio pill follows, for
 * the same reason — a notification that could name itself could name ADE.
 *
 * `target` says where: `"desktop"` is a native notification on this machine,
 * `"mobile"` is a push to the user's paired phones, `"both"` (the default) is
 * whichever of the two exists. A post that reached neither is refused with
 * `notification_unavailable`; a post that reached one of two asked-for targets
 * succeeds and says so in `delivered` — a plugin should not treat "your phone
 * is not paired" as an error it needs to report.
 */
export type PluginNotificationTarget = "desktop" | "mobile";

export const PLUGIN_NOTIFICATION_TARGETS = ["desktop", "mobile", "both"] as const;

export type PluginNotificationTargetRequest = (typeof PLUGIN_NOTIFICATION_TARGETS)[number];

export function isPluginNotificationTargetRequest(value: unknown): value is PluginNotificationTargetRequest {
  return PLUGIN_NOTIFICATION_TARGETS.some((target) => target === value);
}

/**
 * Bounds on the two strings, matching what a notification surface can render.
 *
 * A lock-screen alert shows roughly one line of title and two of body before
 * the OS truncates; iOS clips silently and macOS clips silently, so a plugin
 * that wrote an essay would get a mystery. Over the ceiling is refused with
 * `invalid_args` rather than trimmed — a sentence cut mid-word and then pushed
 * to someone's phone is worse than a rejected call the author sees in testing.
 */
export const PLUGIN_NOTIFICATION_TITLE_MAX_CHARS = 80;
export const PLUGIN_NOTIFICATION_BODY_MAX_CHARS = 240;

/**
 * How many notifications one plugin may post per UTC day.
 *
 * A notification is an interrupt on a device the user carries, so the ceiling
 * is set against *honest* use and not against capacity. The busiest plausible
 * notifier — one alert per failed CI run, per review comment, per incident —
 * lands in the tens on a bad day; 60 is past every one of those and still
 * bounds a runaway loop to 60 interruptions instead of a dead battery.
 *
 * The cost side, since these leave the machine: each post is one relay publish
 * per paired device. Eight installed plugins all pinned at this cap against
 * three paired devices is 60 × 8 × 3 = 1,440 relay requests a day — about 0.3%
 * of the relay's own 500,000/day spend backstop (`push-relay/src/relay.ts`), so
 * a plugin cannot spend the user's relay budget even by trying. At 1,000/day
 * per plugin that same fleet would be 24,000/day, still under the backstop but
 * now a meaningful fraction of it, and long past anything a person would read.
 *
 * Resets at UTC midnight rather than on a rolling 24 h window because the
 * counter has to survive restarts, and a day bucket is one comparison against a
 * stored date rather than a persisted event log.
 */
export const PLUGIN_NOTIFICATIONS_PER_DAY = 60;

/**
 * The burst ceiling, which is the one that actually stops a bug.
 *
 * The daily cap bounds the damage; this bounds how fast it arrives. Five in a
 * rolling minute covers every legitimate batch — a plugin reacting to four PRs
 * that merged together still gets all four through — while a loop posting on
 * every event tick is stopped inside the first second, before the phone has
 * buzzed more than five times.
 *
 * Deliberately not a token bucket with a refill rate: a bucket that refills
 * would let a wedged plugin settle into a steady drip forever, which is exactly
 * the failure a user reports as "my phone will not stop". A hard window plus a
 * hard day means the worst case is bounded in both dimensions.
 */
export const PLUGIN_NOTIFICATIONS_PER_BURST = 5;
export const PLUGIN_NOTIFICATION_BURST_WINDOW_MS = 60_000;

export type PluginNotificationInput = {
  title: string;
  body?: string;
  /** Omitted means `"both"` — see {@link PLUGIN_NOTIFICATION_TARGETS}. */
  target?: PluginNotificationTargetRequest;
  /**
   * Where tapping the notification lands. See
   * {@link readPluginNotificationDeeplink}.
   *
   * `ade://plugin/<this-plugin-id>/<panel-id>[?ctx=…]`, and only ever this
   * plugin's own. Omitted keeps the default — the plugin itself — which is what
   * every post did before the field existed.
   */
  deeplink?: string;
};

/**
 * The longest deeplink a notification may carry.
 *
 * Smaller than {@link PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES} would allow once
 * URL-encoded, and deliberately: a mobile post is an APNs payload with a 4 KiB
 * ceiling, and a batch that exceeds it fails as a batch — taking ADE's own
 * session alerts down with it. A notification's link is a pointer to a panel
 * ("the agent that finished is bc-1"); the panel reads the rest from the
 * plugin's collections.
 */
export const PLUGIN_NOTIFICATION_DEEPLINK_MAX_CHARS = 1_024;

/**
 * Read the deeplink a notification may carry, or `null`.
 *
 * **Only the posting plugin's own panels.** A notification is the one thing a
 * plugin puts in front of the user outside ADE's window, and a link in it is
 * the one thing the user taps without reading. Letting a plugin name another
 * plugin's panel — or any other deeplink target — would turn "Agent finished"
 * into a way to open somebody else's surface with somebody else's context.
 *
 * Everything else degrades to the default the post already had: tapping opens
 * the plugin. So a malformed link costs the destination, never the
 * notification.
 *
 * The `ctx` is not parsed here. It rides as written and the deeplink router
 * applies its own ceiling on the way in, which is the same treatment a link the
 * user pasted gets.
 */
export function readPluginNotificationDeeplink(raw: unknown, pluginId: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > PLUGIN_NOTIFICATION_DEEPLINK_MAX_CHARS) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ade:" || parsed.host !== "plugin") return null;
  // `ade://plugin/<pluginId>/<panelId>`: two path segments, both identifiers,
  // and the first one has to be the caller.
  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length !== 2) return null;
  const [linkPluginId, panelId] = segments;
  if (linkPluginId !== pluginId) return null;
  if (!panelId || !isValidPluginManifestIdentifier(panelId)) return null;
  return trimmed;
}

export type PluginNotificationResult = {
  /**
   * Which targets actually took it. Never empty — a post that reached nothing
   * rejects with `notification_unavailable` instead of resolving with `[]`,
   * so `await post(...)` succeeding always means somebody was told.
   */
  delivered: PluginNotificationTarget[];
};

/**
 * Text through the machine clipboard.
 *
 * Text only, and bounded: the clipboard is a user-facing buffer, not a
 * transport, and a plugin that pasted a megabyte into it would break the next
 * thing the user pressed ⌘V in. Images and other flavours are deliberately not
 * exposed — `readImage` would let a plugin harvest a screenshot the user copied
 * without ever asking for one.
 *
 * Be honest about what a read is: it returns whatever the user last copied,
 * which is frequently a password or a token they were moving between apps.
 * Installing a plugin grants it — the same grant that already lets its child
 * process read any file the user can — but a plugin should still read the
 * clipboard only in direct response to something the user just did, never on a
 * timer.
 */
export const PLUGIN_CLIPBOARD_TEXT_MAX_BYTES = 64 * 1024;

/**
 * Ask the user to choose a path, through the operating system's own picker.
 *
 * The dialog IS the consent: nothing is read, and the plugin learns no path it
 * was not handed. A dismissed picker rejects with `dialog_cancelled` rather
 * than resolving null, so "the user said no" cannot be mistaken for "the user
 * chose a file called nothing".
 *
 * The returned path is a plain path on this machine, readable with `fs`, the
 * same contract {@link PluginAudioClip} uses.
 */
export type PluginFilePickerOptions = {
  title?: string;
  defaultPath?: string;
  /** Pick a folder instead of a file. */
  directory?: boolean;
  /** e.g. `[{name: "Images", extensions: ["png", "jpg"]}]`. Ignored for `directory`. */
  filters?: { name: string; extensions: string[] }[];
};

export const PLUGIN_FILE_PICKER_FILTERS_MAX = 8;
export const PLUGIN_FILE_PICKER_EXTENSIONS_MAX = 24;

/**
 * A plugin's own durable memory: a reserved slice of its collections.
 *
 * Reserved rather than declared, so a plugin has somewhere to remember things
 * without having to predict them in `plugin.json` at publish time. The name is
 * refused through `collections.*` in both directions — a plugin cannot reach
 * this slice by naming it, and declaring it in a manifest does not open it —
 * which keeps one door on it and makes "what is in my memory" a question with a
 * single answer.
 *
 * It shares the plugin's collection budget (2 MiB / 4,000 rows / 64 KiB a
 * value), and it is dropped with everything else when the plugin is
 * uninstalled, because it lives in `plugin_collections` like any other row.
 *
 * WHAT IT IS NOT: this is not ADE's CTO memory, and nothing written here is
 * injected into any agent's prompt. CTO memory is spliced verbatim into the
 * CTO's system context every turn (`ctoStateService.buildReconstructionContext`)
 * and is CTO-only for exactly that reason — a plugin with write access to it
 * would be a plugin with write access to what the operator's agent believes.
 * Plugin memory is storage the plugin reads back itself.
 */
export const PLUGIN_MEMORY_COLLECTION = "ade.memory";

/**
 * True for the one collection name `collections.*` must refuse.
 *
 * A function rather than an inline comparison because both doors check it — the
 * declared-collection gate and the memory verbs' own scoping — and a second
 * spelling would mean one of them let the name through.
 */
export function isReservedPluginCollection(collection: string): boolean {
  return collection === PLUGIN_MEMORY_COLLECTION;
}

/**
 * A plugin-owned schedule: "call MY action later", not "type into a chat".
 *
 * The distinction is the whole point. A plugin can already reach ADE's chat
 * schedulers through `actions.invoke`, and doing so leaves a cron that belongs
 * to nobody: it carries no owner, no UI says which package created it, and
 * uninstalling the plugin leaves it firing a prompt into the user's chat
 * forever. A schedule created here belongs to the plugin by construction — it
 * is quota'd against it, listed under it, and deleted with it.
 *
 * When it fires, the host invokes the named action on the plugin's own child,
 * exactly as `plugin.invoke` would. The plugin decides what that means.
 */
export type PluginScheduleCreateInput = {
  /** An action the plugin's entry module exports. Checked when it fires, not before. */
  action: string;
  /** Five-field cron in the machine's local timezone. Recurring. */
  cron?: string;
  /** ISO-8601 with an explicit offset or `Z`. One-shot. */
  runAt?: string;
  /** Seconds from now. One-shot. */
  delaySeconds?: number;
  /** Passed to the action as its arguments. */
  args?: Record<string, unknown>;
  /** Shown to the user beside the schedule. */
  note?: string;
};

export type PluginSchedule = {
  id: string;
  pluginId: string;
  action: string;
  kind: "cron" | "once";
  cron?: string;
  args: Record<string, unknown>;
  note?: string;
  createdAt: string;
  /** Null once a one-shot has fired and is waiting to be swept. */
  nextRunAt: string | null;
  lastRunAt?: string;
  /** The last failure's message, so a silently broken schedule is visible. */
  lastError?: string;
};

/**
 * "This happened" — one firing of a trigger the plugin's manifest declares.
 *
 * The manifest supplies the VOCABULARY (so the rule builder can offer the
 * trigger before the plugin has ever fired) and this supplies the EVENT. The
 * plugin never says which rules should run: it names its own trigger, the
 * engine matches it against whatever the user authored, and a firing that
 * matches nothing is an ordinary outcome rather than a failure.
 */
export type PluginAutomationTriggerInput = {
  /** One of the plugin's `automationTriggers[].id`. Anything else is refused. */
  triggerId: string;
  /** Reachable from a rule's step arguments as `{{trigger.plugin.payload.<key>}}`. */
  payload?: Record<string, unknown>;
};

/**
 * Active schedules one plugin may hold.
 *
 * Small on purpose. A schedule is a standing claim on the machine's clock that
 * outlives every window, and a plugin that genuinely needs more than eight
 * distinct recurrences wants one schedule and its own dispatch table inside it.
 * Eight covers "hourly, daily, weekly, and a handful of one-shots the user
 * asked for" with room left over.
 *
 * Counted over live rows, not lifetime creations: a fired one-shot stops
 * counting once it is swept, so a plugin that schedules a reminder per user
 * action is limited by how many are pending at once, which is the thing that
 * actually costs anything.
 */
export const PLUGIN_SCHEDULES_MAX_PER_PLUGIN = 8;

/**
 * The floor between two fires of the same schedule.
 *
 * Cron's own granularity is a minute, so this binds nothing a cron string could
 * express; it exists for `delaySeconds`, where a plugin could otherwise ask to
 * be woken every second and turn a schedule into a busy loop with a persistence
 * file. One minute is also the point below which "schedule it" is the wrong
 * tool — a plugin that needs to run every ten seconds should hold its own timer
 * in its own process, where the user can see it stop when the plugin stops.
 */
export const PLUGIN_SCHEDULE_MIN_INTERVAL_MS = 60_000;

export const PLUGIN_SCHEDULE_NOTE_MAX_CHARS = 120;

/**
 * The `args` frame's ceiling, matching a contribution's.
 *
 * A schedule's arguments are a pointer — "run the daily report for repo X" —
 * not a payload: the plugin's own collections hold everything else, and args
 * big enough to carry a page would become a second unversioned data store that
 * the schedules file has to keep on disk forever.
 */
export const PLUGIN_SCHEDULE_ARGS_MAX_BYTES = 4 * 1024;

/**
 * An emitted trigger's `payload` ceiling, matching a schedule's `args` for the
 * same reason.
 *
 * A trigger payload is a pointer — "issue ADE-7 moved to In Review" — not the
 * issue. Every rule the firing matches resolves its step arguments out of it
 * and the whole thing is written into `automation_ingress_events` for the
 * retention window, so a payload big enough to carry a document would turn the
 * ingress log into an unversioned copy of the plugin's own store.
 */
export const PLUGIN_AUTOMATION_TRIGGER_PAYLOAD_MAX_BYTES = 4 * 1024;

/**
 * How often one plugin may fire its own automation triggers.
 *
 * The payload ceiling bounds what a firing CARRIES; this bounds what a firing
 * COSTS. Every emit runs each of the user's matching rules, and a rule can
 * start a lane, run a command or open a paid agent session — so an unbounded
 * emit is the one plugin verb that spends the user's money rather than their
 * attention, and it was the only new capability in this round without a
 * ceiling. Deliberately generous: a plugin bridging a webhook fires in bursts,
 * and the number that has to be wrong before this bites is a loop.
 */
export const PLUGIN_AUTOMATION_TRIGGERS_PER_BURST = 30;
export const PLUGIN_AUTOMATION_TRIGGER_BURST_WINDOW_MS = 60_000;

/**
 * A plugin-authored `ade_card`'s serialized ceiling.
 *
 * A card is a transcript ROW, and the transcript is uncapped and replays on
 * every client including a phone — so an unbounded card is unbounded growth in
 * a file the user cannot prune and unbounded bytes over the sync wire. Same
 * pointer-not-payload rule as {@link PLUGIN_AUTOMATION_TRIGGER_PAYLOAD_MAX_BYTES}:
 * a card summarizes ("14 tests failed") and its panel or deeplink carries the
 * detail. 4 KiB is past every legitimate card — the richest host-authored ones
 * (a CI run with a dozen rows and metrics) land under 2 KiB.
 *
 * Applies to plugin-authored cards only. Host-authored cards are ADE's own
 * chronology, written by code that already bounds itself (`rowsTruncated` is
 * that bound), and failing one of those would break a product surface rather
 * than an untrusted caller.
 */
export const PLUGIN_ADE_CARD_MAX_BYTES = 4 * 1024;

/**
 * The card panel's `$context` ceiling, matching
 * {@link PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES} because it is the same binding
 * arriving by a different door: a `plugin` deeplink spells it `?ctx=`, a card
 * spells it `panel.context`, and both end up as the panel's `$context`.
 * Checked before the whole-card cap so an oversized context is named as such.
 */
export const PLUGIN_ADE_CARD_PANEL_CONTEXT_MAX_BYTES = 2 * 1024;

/**
 * How many cards one chat session accepts from plugins in a rolling minute.
 *
 * The per-card cap bounds what one emit COSTS; this bounds how many arrive.
 * The unit is the chat session rather than the plugin because the session's
 * transcript is the resource being protected — it is what grows, what syncs to
 * the phone, and what the user has to read. Mirrors
 * {@link PLUGIN_AUTOMATION_TRIGGERS_PER_BURST}: generous enough that a plugin
 * updating a live card as a run progresses (each state change is one emit, and
 * an identical re-emit is deduped before it counts) never notices, low enough
 * that a loop is stopped within a second.
 */
export const PLUGIN_ADE_CARDS_PER_SESSION_BURST = 30;
export const PLUGIN_ADE_CARD_BURST_WINDOW_MS = 60_000;

/** The SDK calls a child can make back into the host. */
export type PluginSdkMethod =
  | "actions.invoke"
  | "collections.get"
  | "collections.put"
  | "collections.delete"
  | "collections.list"
  | "secrets.get"
  | "secrets.set"
  | "secrets.delete"
  | "secrets.getProviderKey"
  | "secrets.hasProviderKey"
  | "auth.beginSession"
  | "auth.cancelSession"
  | "auth.requestHandoff"
  | "auth.officialClient"
  | "contributions.publish"
  | "panels.update"
  | "config.get"
  | "config.set"
  | "audio.captureClip"
  | "notifications.post"
  | "schedules.create"
  | "schedules.list"
  | "schedules.delete"
  | "automations.emitTrigger"
  | "webhooks.url"
  | "webhooks.ack"
  | "chat.createSession"
  | "chat.appendAssistant"
  | "chat.appendUser"
  | "chat.emitStatus"
  | "chat.setArtifacts"
  | "chat.attachBranch"
  | "chat.hydrate"
  | "lanes.list"
  | "lanes.get"
  | "lanes.listSessionIssues"
  | "lanes.linkIssue"
  | "lanes.unlinkIssue"
  | "clipboard.read"
  | "clipboard.write"
  | "dialogs.pickFile"
  | "memory.get"
  | "memory.set"
  | "memory.delete"
  | "memory.list"
  /**
   * Tell the host this child does (or no longer does) want one event kind.
   *
   * Not a capability a plugin calls — `ade.events.on` sends it, and the SDK
   * surface has no other spelling for it. It exists because the host fans an
   * event out by writing one line per interested child, and `tool.before`
   * fires dozens of times a turn: without the child saying which kinds it
   * listens for, every running plugin would pay for every tool call in every
   * chat on the machine, forever, to feed listeners that do not exist.
   */
  | "events.subscribe";

/** Child → host. */
export type PluginChildFrame =
  | { type: "ready"; actions: string[] }
  | { type: "sdk"; requestId: string; method: PluginSdkMethod; params: Record<string, unknown> }
  | { type: "invokeResult"; requestId: string; result?: unknown; error?: PluginStructuralError }
  | { type: "log"; level: PluginLogLevel; message: string; fields?: Record<string, unknown> }
  | { type: "fatal"; error: PluginStructuralError };

/**
 * Encode one NDJSON frame. Exported so host and child share one encoder and a
 * newline can never sneak into the payload and split a frame in two.
 */
export function encodePluginFrame(frame: PluginHostFrame | PluginChildFrame): string {
  return `${JSON.stringify(frame).replace(/\n/g, "\\n")}\n`;
}

export function decodePluginFrame<T extends PluginHostFrame | PluginChildFrame>(line: string): T | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && "type" in parsed ? parsed as T : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Install registry + the `plugin` action domain
// ---------------------------------------------------------------------------

export type PluginInstallSource =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; ref?: string }
  | { kind: "builtin" };

/** One entry in `~/.ade/plugins/state.json` — the machine install registry. */
export type PluginInstallRecord = {
  pluginId: string;
  version: string;
  enabled: boolean;
  source: PluginInstallSource;
  installedAt: string;
  updatedAt: string;
  /**
   * Contribution ids the user switched off — see
   * {@link PluginSummary.disabledContributions} and
   * `shared/plugins/disabledContributions.ts` for the key namespaces. Optional
   * on the wire so a registry written by an older build parses; the reader
   * fills in `[]`.
   */
  disabledContributions?: string[];
};

export type PluginRuntimeStatus =
  | "idle"
  | "starting"
  | "running"
  | "restarting"
  | "crashed"
  | "stopped"
  | "no-entry";

/**
 * How a plugin lifecycle call (install, uninstall, enable, disable) was
 * authorized, reported back on the call's own result.
 *
 * It exists because an agent could not tell. Everything an agent could query —
 * `plugin.get`, `plugin.list`, the doctor, the transcript's card rows — showed
 * that an install had SUCCEEDED and said nothing about how it was allowed to.
 * A dogfood run inferred consent from wall-clock time (a ten-second install
 * "must" have been a person reading a card) and filed a false P0 saying
 * third-party code had installed with no consent surface. The card had worked
 * correctly the whole time.
 *
 * `decidedBy` is who authorized it, `required` is whether THIS call had to ask:
 *
 * - `{required: true, decidedBy: "card"}` — a card was raised for this call and
 *   a person answered it.
 * - `{required: false, decidedBy: "card"}` — a person already answered a card
 *   for this exact plugin, source and grant earlier in this ADE run, so the
 *   host did not ask twice. Consent is human, and it is remembered.
 * - `{required: false, decidedBy: "operator"}` — the caller was the machine
 *   operator, running from their own terminal at `cto`. No card was ever needed
 *   and none was raised.
 */
export type PluginApprovalOutcome = {
  required: boolean;
  decidedBy: "card" | "operator";
};

export type PluginSummary = {
  pluginId: string;
  version: string;
  displayName: string;
  description: string;
  icon: string | null;
  accent: string | null;
  enabled: boolean;
  status: PluginRuntimeStatus;
  /** Non-fatal manifest problems, surfaced in the UI rather than swallowed. */
  warnings: string[];
  /** Fatal manifest problems: the plugin is installed but cannot load. */
  errors: string[];
  /**
   * Present only on the result of a lifecycle call that went through the
   * approval gate — never on a `list` or `get` row, which describe an installed
   * plugin rather than a decision. Optional so a host that predates the field
   * simply omits it and a reader learns nothing false.
   */
  approval?: PluginApprovalOutcome;
  source: PluginInstallSource;
  installedAt: string;
  hasEntry: boolean;
  /**
   * Manifest surfaces, in manifest shape. The renderer's own `tabs` list is
   * derived from these at the preload boundary rather than duplicated here: a
   * second spelling of the same manifest fact is the drift this contract exists
   * to prevent.
   */
  surfaces: {
    kind: string;
    id: string;
    title: string;
    panelId: string;
    icon?: string;
    /**
     * Set when the surface gates a compiled-in tab instead of rendering a panel
     * (`PLUGIN_BUILTIN_SURFACE_IDS`). Optional on the wire: a host that predates
     * the field simply reports the surface without it, and the client then shows
     * the built-in tab as it always did rather than hiding a page it cannot
     * prove is owned.
     */
    builtin?: string;
    /**
     * `webview` surfaces only: the plugin-relative HTML the desktop guest loads.
     * Absent everywhere else, and absent from a host too old to report it —
     * which is why its absence means "render the panel", the answer that is
     * already correct on every surface that cannot host a webview.
     */
    entryHtml?: string;
  }[];
  /** Present only for theme plugins; the renderer's theme engine consumes it. */
  theme: { displayName: string; tokens: { dark?: Record<string, string>; light?: Record<string, string> } } | null;
  /**
   * Contribution ids the user switched OFF, from the machine install registry.
   *
   * Manifest SOCKET ids are stored bare; the four engine registrations are
   * stored kind-qualified (`search:issues`, `keybinding:openIssue`) so that two
   * declarations sharing a name stay independent. `shared/plugins/
   * disabledContributions.ts` owns both the keys and every reader's rule,
   * including the one `plugin.invoke` applies.
   *
   * A list of what is off rather than what is on, because contributions are on
   * by default: an empty list has to mean "everything this plugin declares is
   * live", and a list of enabled ids would read as "nothing is" on any plugin
   * installed before the field existed.
   *
   * Optional to match the renderer's `InstalledPlugin`, where absent and empty
   * mean the same thing — the host always populates it, so a caller that sees
   * `undefined` is talking to an older host, not to a plugin with everything
   * switched off.
   */
  disabledContributions?: string[];
  cli: string[];
  /**
   * The plugin's engine registrations, in manifest shape.
   *
   * Carried on the summary rather than fetched per plugin because every
   * consumer needs them for ALL installed plugins at once and needs them
   * without a child running: the automations rule builder draws one picker over
   * every plugin's triggers, the palette queries every provider, and the
   * keybinding matrix cannot decide who won a chord until it has seen everyone
   * who wanted it. A per-plugin `getManifest` round trip would make each of
   * those an N-call fan-out to answer one question.
   *
   * Optional on the wire for the usual reason: a host that predates the field
   * reports the plugin without it, and absent then means "this host has no
   * engine registrations", which is exactly right rather than merely safe.
   */
  automationTriggers?: PluginManifestAutomationTrigger[];
  automationSteps?: PluginManifestAutomationStep[];
  searchProviders?: PluginManifestSearchProvider[];
  keybindings?: PluginManifestKeybinding[];
  urlMatchers?: PluginManifestUrlMatcher[];
  restartCount: number;
  lastCrashAt: string | null;
};

/**
 * One plugin's install state on one machine in the account.
 *
 * Flattened per (machine, plugin) because that is the grain the Marketplace's
 * coverage matrix draws. `isThisMachine` is stamped by the HOST: the renderer
 * holds no machine key, and a wrong guess shows someone another machine's
 * install state as their own.
 */
export type PluginPresenceMachineRow = {
  machineKey: string;
  machineName: string;
  pluginId: string;
  version: string | null;
  enabled: boolean;
  /** False for a machine in the directory that is not reachable right now. */
  online: boolean;
  isThisMachine: boolean;
};

/**
 * One materialized socket contribution, joined to the surface it renders on.
 *
 * `surface` is not stored — `plugin_contributions` keys on the socket KIND, and
 * which surface that socket belongs to lives in the plugin's manifest. The host
 * performs that join so every client does not have to hold every manifest.
 */
export type PluginContributionRecord = {
  entityKind: PluginEntityKind;
  entityId: string;
  pluginId: string;
  socket: PluginSocketKind;
  surface: PluginSurfaceId;
  /** The manifest socket id this row fills, for ordering and per-socket toggles. */
  socketId: string;
  payload: unknown;
  updatedAt: string | null;
};

/** The plugin directory, as the Marketplace reads it. */
export type PluginMarketplaceIndex = {
  entries: PluginRegistryEntry[];
  /** When the bytes were last confirmed current. A 304 counts. */
  fetchedAt: string | null;
  origin: "network" | "cache";
};

/**
 * What the host learned by reading an install source without installing it.
 *
 * `manifest` is null for a source this machine cannot read without fetching it
 * (a git URL): the modal then shows what the directory claims instead. Reading
 * a source must never be the thing that puts code on the machine.
 */
export type PluginSourceInspection = {
  source: string;
  manifest: PluginManifest | null;
};

/**
 * A materialized `plugin_panels` row.
 *
 * `schema` is opaque here on purpose: this module never parses vocabulary, and
 * a client too old to understand `vocabVersion` renders the panel's declared
 * fallback rather than guessing at the body.
 */
export type PluginPanelRecord = {
  pluginId: string;
  panelId: string;
  title: string | null;
  schema: unknown;
  vocabVersion: number;
  updatedAt: string | null;
};

/**
 * The refresh action the host stamped onto a stored panel schema, if any.
 *
 * It rides inside `schema_json` rather than in a column because `plugin_panels`
 * is a CRR table with a frozen SQL shape — the same reason the resolved
 * `mobile` flag lives there. A client that predates the key ignores it and
 * renders the panel exactly as before, which is what "absent means no refresh
 * gesture" has to mean on four release trains.
 *
 * The value is the manifest's, never the plugin payload's: the writer strips
 * whatever a republished schema carried under this name and re-stamps the
 * declaration. So a plugin cannot mint a refresh gesture for an action it did
 * not declare.
 */
export function readPluginPanelRefreshAction(schema: unknown): string | null {
  if (!isRecord(schema)) return null;
  const raw = schema.refreshAction;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/**
 * The last time one plugin action was asked to run on this machine.
 *
 * Kept because "nothing happened when I pressed it" had no answer: a socket
 * that published no rows and a socket whose action never fired both read as
 * "0 rows published right now", so the only way to tell them apart was to
 * reproduce the press by hand. One row per action says which of the two it is.
 *
 * Every route is recorded — a press, a CLI word, an agent tool, a schedule —
 * because they all funnel through the one `plugin.invoke` the host owns. A
 * REFUSED invoke counts as an attempt and carries its code: "the action is
 * switched off" is the answer someone is looking for at that moment, and
 * dropping it would leave the same silence this exists to break.
 */
export type PluginActionInvokeRecord = {
  action: string;
  /** ISO timestamp of the attempt. */
  at: string;
  ok: boolean;
  /** The `PluginSdkError` code, when the attempt failed. Absent when it did not. */
  errorCode?: string;
};

export type PluginDetail = PluginSummary & {
  manifest: PluginManifest | null;
  settings: PluginManifestSetting[];
  config: Record<string, string | number | boolean | null>;
  root: string;
  logs: PluginLogEntry[];
  /**
   * The most recent attempt per action, newest first, since ADE started.
   *
   * Optional on the wire for the usual reason: a host that predates the field
   * reports the plugin without it, and a client must then say it cannot tell
   * rather than draw "never run" over a host that simply never counted.
   */
  lastInvokes?: PluginActionInvokeRecord[];
  /**
   * Each provider key the manifest declares, and whether one is connected.
   *
   * PRESENCE ONLY. The key itself reaches exactly one place — the reply to
   * `ade.secrets.getProviderKey`, inside the plugin's own child — and a detail
   * record is read by the doctor, the settings page and anything that can call
   * `plugin.get`, which is not a list a credential belongs on.
   *
   * Optional on the wire like `lastInvokes`, and for the same reason: a host
   * that predates the field reports the plugin without it, and the reader then
   * says it cannot tell rather than drawing "no key" over a host that never
   * looked.
   */
  providerKeys?: { provider: string; present: boolean }[];
};

export type PluginLogEntry = {
  at: string;
  level: PluginLogLevel;
  message: string;
  fields?: Record<string, unknown>;
};

export type PluginUsageSummaryEntry = {
  pluginId: string;
  collectionRows: number;
  collectionBytes: number;
  contributionRows: number;
  panelRows: number;
  /** Sync bytes attributed to this plugin's frames, when metering is on. */
  syncBytesOut: number;
  syncBytesIn: number;
};

/**
 * One declared ingress channel, as the host reports it.
 *
 * `url` is the whole point of the row: it is what a user pastes into a third
 * party, and it has to be readable on a machine where the plugin is installed
 * and not running, which is exactly when they are setting the integration up.
 * The relay SECRET is never part of this shape and never leaves the host.
 */
export type PluginWebhookChannelStatus = {
  channelId: string;
  label: string;
  description?: string;
  /** The public URL a third party posts to. */
  url: string;
  /** True when the channel declares its own `hmac-sha256` signature check. */
  verified: boolean;
  /**
   * Set when the channel declares `verify` and the named secret is NOT stored
   * on this machine. The channel's URL still works at the relay, so the honest
   * report is "arriving and being refused here", not "not set up".
   */
  missingSecretRef?: string;
  /** Newest delivery seen on this channel, ISO-8601. Null when none ever. */
  lastReceivedAt: string | null;
};

/**
 * Ingress health for one plugin: is it registered, is it draining, what is
 * queued, and what URLs does the user need.
 */
export type PluginWebhookIngressStatus = {
  pluginId: string;
  state: "undeclared" | "unconfigured" | "ready" | "error";
  relayBaseUrl: string;
  channels: PluginWebhookChannelStatus[];
  /** Newest delivery across every channel, ISO-8601. */
  lastReceivedAt: string | null;
  /** When the drain last completed a poll without throwing, ISO-8601. */
  lastPolledAt: string | null;
  /** The last drain failure, already redacted of anything secret. */
  lastError: string | null;
  /** Delivered, not yet acked. A number that only grows is a plugin bug. */
  pendingDeliveries: number;
  /** Deliveries abandoned past {@link PLUGIN_WEBHOOK_DELIVERY_ATTEMPTS_MAX}. */
  abandonedDeliveries: number;
};

export type PluginUsageSummary = {
  entries: PluginUsageSummaryEntry[];
  budgets: {
    collectionBytesPerPlugin: number;
    collectionRowsPerPlugin: number;
    contributionsPerPlugin: number;
    panelsPerPlugin: number;
  };
};

/**
 * The `plugin` action domain.
 *
 * ONE fixed domain, with `{pluginId, action, args}` inside — the action
 * envelope's domain enum is closed at both the RPC schema and iOS's
 * compile-time allowlist, so per-plugin domains are impossible by construction.
 * See D1 in the plugin platform design.
 */
/**
 * Which handler a `plugin.invoke` call named, under either spelling.
 *
 * Null when neither is a usable string, and the caller turns that into
 * {@link pluginInvokeActionMissingMessage} — which names BOTH, because an error
 * that mentions only the field you did not use tells you nothing about the one
 * you did.
 */
export function readPluginInvokeAction(args: unknown): string | null {
  if (!isRecord(args)) return null;
  for (const key of ["action", "actionId"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/** The refusal, naming both spellings so either one gets the reader unstuck. */
export function pluginInvokeActionMissingMessage(): string {
  return '"action" is required (its alias "actionId" is accepted too).';
}

/**
 * Read a schedule id from `schedules.delete` params under either spelling.
 *
 * The same trap as {@link readPluginInvokeAction}, one API over. The parameter
 * is called `scheduleId`, so that is the only spelling an author ever sees —
 * but a row of {@link PluginSchedule} names the field `id`. Iterating
 * `schedules.list()` and passing `row.scheduleId` therefore deletes
 * `undefined`, and the old refusal (`"scheduleId" must be a non-empty string`)
 * read as though the ARGUMENT was malformed rather than as though the wrong
 * field had been read. Unnoticed, the stale schedule survives every settings
 * save and walks into the live-schedule ceiling one change at a time.
 */
export function readPluginScheduleId(params: unknown): string | null {
  if (!isRecord(params)) return null;
  for (const key of ["scheduleId", "id"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/** The refusal, naming the row's field so the reader looks at the right one. */
export function pluginScheduleIdMissingMessage(): string {
  return '"scheduleId" is required (a schedule row spells this field "id", '
    + "and that spelling is accepted here too).";
}

export type PluginDomainService = {
  /**
   * Call a plugin's own named handler. Treated as MUTATING by the renderer.
   *
   * `timeoutMs` overrides the child supervisor's default round-trip budget for
   * this one call, clamped by `clampPluginInvokeTimeoutMs`. It is a SIBLING of
   * `args` rather than a key inside it: `args` is the plugin's own namespace,
   * and a host field hidden in there would collide with a plugin that happened
   * to name a parameter the same thing.
   */
  invoke(args: {
    pluginId: string;
    action: string;
    /**
     * The same field under the name the manifest uses for it.
     *
     * A `sockets[]` entry names its handler `actionId`, so that is the spelling
     * an author reads all day and the one they type into `plugin.invoke` —
     * which then refused with `"action" is required.` while the argument they
     * had passed sat right there. Accepted as an alias rather than renamed:
     * `action` is what every caller in the app sends and what the wire frame
     * carries, and two spellings of one field are cheaper than a migration of
     * every one of them. {@link readPluginInvokeAction} is the one reader.
     */
    actionId?: string;
    args?: Record<string, unknown>;
    argv?: string[];
    timeoutMs?: number;
    /**
     * Which kind of client is driving this call, when the caller knows.
     *
     * A hint, and it exists for exactly one decision: a sign-in the host has to
     * present. A `loopback` flow opens a browser on THIS machine, which is the
     * right answer for a desktop and a dead end for a phone — the user would
     * watch a window they cannot see finish a flow they cannot return from. The
     * phone's remote command sets `"mobile"`, the desktop's preload sets
     * `"desktop"`, and a caller that says nothing gets the host's default.
     *
     * A hint and never a permission: nothing is granted or refused on it, so a
     * caller that lies about it gains nothing.
     */
    client?: "desktop" | "mobile";
  }): Promise<unknown>;
  list(args?: { includeDisabled?: boolean }): Promise<PluginSummary[]>;
  get(args: { pluginId: string }): Promise<PluginDetail | null>;
  /**
   * Read a materialized panel schema. Every surface that renders a plugin panel
   * goes through here — a manifest only names a `schemaFile`, and the row is
   * what the plugin actually published.
   */
  getPanel(args: { pluginId: string; panelId: string }): Promise<PluginPanelRecord | null>;
  getCollection(
    args: { pluginId: string; collection: string; keyPrefix?: string; limit?: number },
  ): Promise<PluginCollectionRow[]>;
  /**
   * The plugin directory. Null when there is neither a network answer nor a
   * cache — distinct from an empty index, which means the directory is
   * reachable and lists nothing.
   */
  marketplaceIndex(args?: { refresh?: boolean }): Promise<PluginMarketplaceIndex | null>;
  /**
   * A plugin repository's live star count, or null when nobody can say.
   *
   * Separate from the directory read because the index's own `stars` figure is
   * only as fresh as the last crawl. Null is an ordinary answer — the GitHub
   * API is queried unauthenticated, so being rate limited is normal — and every
   * caller draws it as "unknown", never as zero.
   */
  repoStars(args: { repo: string }): Promise<number | null>;
  /**
   * Install state across the account's machines, from the synced presence
   * table. Empty on a machine with no sync host, which reads as
   * "this machine only" rather than as an error.
   */
  presence(): Promise<PluginPresenceMachineRow[]>;
  /**
   * Dynamic per-entity contributions for one surface.
   *
   * The half of the socket taxonomy that a manifest cannot express: static
   * sockets say a plugin CAN badge a lane, these rows say what it says about
   * lane 7 right now. Rows from disabled plugins and switched-off sockets are
   * filtered here, so no caller has to re-derive that.
   */
  listContributions(args: {
    surface: PluginSurfaceId;
    entityKind?: PluginEntityKind;
    entityIds?: string[];
  }): Promise<PluginContributionRecord[]>;
  /** An installed plugin's parsed manifest, or null when it has none readable. */
  getManifest(args: { pluginId: string }): Promise<PluginManifest | null>;
  /** An installed plugin's README, or null when it ships none. */
  getReadme(args: { pluginId: string }): Promise<string | null>;
  /** Recent log lines from the plugin's child process ring buffer. */
  openLogs(args: { pluginId: string }): Promise<PluginLogEntry[]>;
  /** Read an install source WITHOUT installing it. See {@link PluginSourceInspection}. */
  inspectSource(args: { source: string }): Promise<PluginSourceInspection | null>;
  /**
   * Turn one of a plugin's declared socket contributions off or on. Persisted
   * in the machine install registry, so it survives a restart and a reinstall.
   */
  setContributionEnabled(args: {
    pluginId: string;
    socketId: string;
    enabled: boolean;
  }): Promise<PluginSummary>;
  install(args: { source: string; ref?: string; enable?: boolean }): Promise<PluginSummary>;
  uninstall(args: { pluginId: string }): Promise<{ removed: boolean; approval?: PluginApprovalOutcome }>;
  enable(args: { pluginId: string }): Promise<PluginSummary>;
  disable(args: { pluginId: string }): Promise<PluginSummary>;
  usageSummary(args?: { pluginId?: string }): Promise<PluginUsageSummary>;
  /**
   * Webhook ingress health, for `ade plugin doctor` and the Marketplace page.
   *
   * Answers for one plugin, or for every plugin that declares `webhookIngress`
   * when no id is given. A plugin that declares none answers with
   * `state: "undeclared"` rather than being omitted, so a caller asking about a
   * named plugin always gets a row to render.
   */
  webhookIngress(args?: { pluginId?: string }): Promise<PluginWebhookIngressStatus[]>;
  /**
   * Write settings values for one plugin and return the plugin as it now reads.
   *
   * `values` is a PATCH: keys absent from it keep their stored value, and a key
   * set to `null` returns to the manifest's declared default. Every key is
   * checked against `manifest.settings` and an unknown one is refused rather
   * than stored — a typo that silently persists would read back as a setting
   * the plugin never sees, which is indistinguishable from a broken plugin.
   *
   * Deliberately NOT operator-gated: configuring an installed plugin is not
   * installing code. Denial (when it happens) is policy, so it surfaces as
   * `policyDenied`, never as a missing method.
   */
  setConfig(args: {
    pluginId: string;
    values: Record<string, string | number | boolean | null>;
  }): Promise<PluginDetail>;
  /** Re-read the manifest and restart the child. The `ade plugin dev` loop. */
  reload(args: { pluginId: string }): Promise<PluginSummary>;
};

/** Actions exposed through `ade actions` / the renderer bridge, in list order. */
export const PLUGIN_DOMAIN_ACTIONS = [
  "disable",
  "enable",
  "get",
  "getCollection",
  "getManifest",
  "getPanel",
  "getReadme",
  "inspectSource",
  "install",
  "invoke",
  "list",
  "listContributions",
  "marketplaceIndex",
  "openLogs",
  "presence",
  "reload",
  "repoStars",
  "setConfig",
  "setContributionEnabled",
  "uninstall",
  "usageSummary",
  "webhookIngress",
] as const;

export type PluginDomainAction = (typeof PLUGIN_DOMAIN_ACTIONS)[number];

/**
 * Read-only actions, for the renderer's mutating/read-only classification.
 * `invoke` is deliberately absent: a plugin handler may write anything, so the
 * safe default is MUTATING.
 */
export const PLUGIN_READ_ONLY_DOMAIN_ACTIONS: readonly PluginDomainAction[] = [
  "list",
  "get",
  "webhookIngress",
  "getPanel",
  "getCollection",
  "getReadme",
  "getManifest",
  "listContributions",
  "openLogs",
  // Reading a source is deliberately a READ: it parses a manifest the machine
  // can already see and never fetches or installs anything.
  "inspectSource",
  "marketplaceIndex",
  // A decoration on a public repository, cached for a day. Nothing about asking
  // for it changes any state, here or at GitHub.
  "repoStars",
  "presence",
  "usageSummary",
];

// ---------------------------------------------------------------------------
// Shared validation helpers (host and child agree by importing, not by copying)
// ---------------------------------------------------------------------------

export function assertPluginCollectionName(collection: unknown): string {
  if (typeof collection !== "string" || !PLUGIN_COLLECTION_NAME_PATTERN.test(collection)) {
    throw new PluginSdkError("invalid_args", `Invalid collection name: ${String(collection)}`);
  }
  return collection;
}

export function assertPluginCollectionKey(key: unknown): string {
  if (typeof key !== "string" || !PLUGIN_COLLECTION_KEY_PATTERN.test(key)) {
    throw new PluginSdkError("invalid_args", `Invalid collection key: ${String(key)}`);
  }
  return key;
}

export function assertPluginSecretName(name: unknown): string {
  if (typeof name !== "string" || !PLUGIN_SECRET_NAME_PATTERN.test(name)) {
    throw new PluginSdkError("invalid_args", `Invalid secret name: ${String(name)}`);
  }
  return name;
}

/**
 * Secret names the host owns, which a plugin may neither write nor delete.
 *
 * One name today: the relay registration secret. A plugin that overwrote it
 * would deauthorize its own ingress while the relay went on accepting posts it
 * could no longer read — a failure that looks like "the third party stopped
 * sending" and is not.
 */
export function isReservedPluginSecretName(name: string): boolean {
  return name === PLUGIN_WEBHOOK_SECRET_NAME;
}

/**
 * Filter and clamp webhook headers before they cross into a plugin child.
 *
 * The relay stores a wider set than this returns. That is deliberate: the relay
 * is minimizing what sits at rest, and THIS is the boundary that decides what
 * third-party code gets to read. Unknown keys leave without being named.
 */
export function sanitizePluginWebhookHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const headers: Record<string, string> = {};
  for (const name of PLUGIN_WEBHOOK_HEADER_ALLOWLIST) {
    const value = source[name];
    if (typeof value !== "string" || !value) continue;
    headers[name] = value.length > PLUGIN_WEBHOOK_HEADER_VALUE_MAX_CHARS
      ? value.slice(0, PLUGIN_WEBHOOK_HEADER_VALUE_MAX_CHARS)
      : value;
  }
  return headers;
}

/**
 * Clamp a webhook body to the delivery cap.
 *
 * Truncated rather than dropped, and the payload SAYS it was truncated, because
 * a plugin handed a silently-shortened JSON body would fail to parse it and
 * report a malformed webhook the sender never sent.
 */
export function clampPluginWebhookBody(body: string): { body: string; truncated: boolean } {
  if (pluginUtf8ByteLength(body) <= PLUGIN_WEBHOOK_BODY_MAX_BYTES) return { body, truncated: false };
  // Sliced by CODE UNIT after the byte check, then re-checked: a multi-byte tail
  // can leave the slice still over budget, and a delivery that overran the cap
  // it claims to enforce is worse than one character short of it.
  let clipped = body.slice(0, PLUGIN_WEBHOOK_BODY_MAX_BYTES);
  while (clipped.length > 0 && pluginUtf8ByteLength(clipped) > PLUGIN_WEBHOOK_BODY_MAX_BYTES) {
    clipped = clipped.slice(0, Math.floor(clipped.length * 0.9));
  }
  return { body: clipped, truncated: true };
}

/** `plugin:<pluginId>:<NAME>` — the machine credential store namespace. */
export function pluginSecretStoreKey(pluginId: string, name: string): string {
  return `plugin:${pluginId}:${name}`;
}

/** UTF-8 byte length. `TextEncoder` keeps this module usable in the renderer. */
export function pluginUtf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Serialize a value for a collection or contribution and enforce its ceiling in
 * the same step, so no caller can measure one encoding and store another.
 */
export function encodePluginJsonWithinBudget(value: unknown, budget: string, limitBytes: number): string {
  let json: string;
  try {
    json = JSON.stringify(value ?? null) ?? "null";
  } catch (error) {
    throw new PluginSdkError(
      "invalid_args",
      `Value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bytes = pluginUtf8ByteLength(json);
  if (bytes > limitBytes) throw budgetExceeded(budget, limitBytes, bytes);
  return json;
}

// ---------------------------------------------------------------------------
// Client wire types (renderer ⇄ preload ⇄ host)
// ---------------------------------------------------------------------------

/**
 * What the UI sees, as distinct from what the host holds.
 *
 * These are deliberately NOT the host types above. The client's runtime status
 * is a five-value union where the host's is seven; a collection row on the wire
 * carries `{key, value}` where the host's carries its collection and timestamp;
 * an inspected source reaches the UI with an unparsed manifest because parsing
 * it is the renderer's job. Folding either pair into one type would force one
 * side to carry fields it cannot fill.
 *
 * They live here rather than in `renderer/lib/pluginRuntimeBridge` because the
 * PRELOAD has to name them, and preload importing the renderer is a layering
 * inversion that `contextBridge.exposeInMainWorld`'s `any` signature was hiding:
 * nothing was checking that what preload publishes matches what the UI calls.
 * The bridge re-exports every one of these under its own historical name, so the
 * UI's imports are unchanged.
 *
 * `PluginClient` prefixes the ones whose host counterpart shares a name. The
 * prefix is not decoration — it is what makes importing both into one file, as
 * preload does, possible at all.
 */

/** Child-process health as the UI renders it. `none` = the plugin runs no code. */
export type PluginClientRuntimeStatus = "running" | "starting" | "stopped" | "crashed" | "none";

/** Token sets a theme plugin may set, per built-in base theme. */
export type PluginClientThemeTokens = Partial<Record<"dark" | "light", Record<string, string>>>;

/** One `tab` or `webview` surface, flattened for the rail. */
export type PluginClientTabDescriptor = {
  id: string;
  title: string;
  /**
   * How the desktop draws this tab. Absent means `"tab"`: a host that predates
   * the webview tier reports no kind, and a panel is what it was already
   * sending. Every other client ignores this and renders the panel regardless —
   * that is the whole cross-surface fallback.
   */
  kind?: PluginSurfaceKind;
  panelId: string;
  /** `webview` only: plugin-relative HTML served over `ade-plugin://`. */
  entryHtml?: string | null;
  /** Phosphor icon name; resolved through `pluginIcons.ts`, never rendered raw. */
  icon?: string | null;
  /**
   * Names a compiled-in tab this surface gates rather than renders — see
   * `PLUGIN_BUILTIN_SURFACE_IDS` in `./manifest`. Absent on every ordinary
   * plugin tab, and absent from a host too old to report it, so its absence
   * means "not a gate" and never "hidden".
   */
  builtin?: string | null;
};

export type PluginClientInstalled = {
  pluginId: string;
  displayName: string;
  version: string;
  enabled: boolean;
  icon: string | null;
  /** Hex accent from the manifest. Applied as a CSS variable, never inlined as a class. */
  accent: string | null;
  status: PluginClientRuntimeStatus;
  tabs: PluginClientTabDescriptor[];
  /** Present only for theme plugins. */
  theme: { displayName: string; tokens: PluginClientThemeTokens } | null;
  /**
   * Manifest socket ids the user has switched off. Absent means none are —
   * which is why it is a list of what is OFF: contributions are on by default,
   * and an absent field must not read as "everything is disabled".
   */
  disabledContributions?: readonly string[];
  /** Drives the nav dot. Off unless the plugin asks for attention. */
  attention?: boolean;
  /**
   * Live-search providers this plugin declares, carried straight off
   * {@link PluginSummary}.
   *
   * On the client shape rather than fetched per plugin because the palette asks
   * ONE question — "who wants to answer this keystroke?" — about every installed
   * plugin at once, and a `getManifest` round trip each would make that an
   * N-call fan-out on the surface with the tightest latency budget in the app.
   *
   * Optional for the usual reason: a host that predates the field reports the
   * plugin without it, and absent then means "no providers here", which is the
   * right answer rather than merely the safe one.
   */
  searchProviders?: readonly PluginManifestSearchProvider[];
  /**
   * Automation triggers and steps this plugin declares, carried straight off
   * {@link PluginSummary} for the same reason `searchProviders` is.
   *
   * The rule builder draws one picker across every installed plugin, and it has
   * to be able to describe a plugin that is installed and NOT running — which
   * is most of them most of the time, since a plugin's child starts on demand.
   * A list published by a live child would be empty exactly when someone is
   * building a rule against it.
   */
  automationTriggers?: readonly PluginManifestAutomationTrigger[];
  automationSteps?: readonly PluginManifestAutomationStep[];
  /**
   * Declared keyboard shortcuts, carried straight off {@link PluginSummary} for
   * the same reason the two above are — with one extra edge that makes it not
   * merely a latency argument.
   *
   * The collision matrix (`shared/plugins/keybindings.ts`) cannot rule on any
   * single plugin's chord until it has seen every other plugin that wanted it.
   * Fetched per plugin, the same manifest would win or lose depending on which
   * reads had landed by then, so the answer would change between renders.
   */
  keybindings?: readonly PluginManifestKeybinding[];
  /**
   * URL matchers this plugin declares, carried straight off
   * {@link PluginSummary} for a reason the three fields above only imply.
   *
   * A smart-link chip is drawn from a pasted URL alone, inside the composer's
   * keystroke handler, with no plugin running and no time to ask one anything.
   * The renderer therefore needs every installed plugin's matchers compiled and
   * in hand BEFORE the first character is typed — and it needs them for plugins
   * whose child is not started, which is most of them most of the time.
   *
   * Optional for the usual reason: a host that predates the field reports the
   * plugin without it, and absent means "this plugin claims no URLs", which is
   * the right answer rather than merely the safe one.
   */
  urlMatchers?: readonly PluginManifestUrlMatcher[];
  /**
   * ISO install timestamp from the machine registry — what makes the matrix's
   * "first installed wins" decidable rather than a coin flip on load order.
   *
   * Optional like the rest, and an absent value sorts first; that only affects
   * the tie-break between two plugins wanting one chord, and a host too old to
   * report it has no better answer to offer.
   */
  installedAt?: string;
};

/** One collection row as the UI reads it. The host's own row carries more. */
export type PluginClientCollectionRow = {
  key: string;
  value: unknown;
};

/** What changed, so a subscriber can decide whether it needs to refetch. */
export type PluginClientChangeEvent = {
  /**
   * Mirrors `main/services/plugins/pluginEvents.ts`'s `PluginChangeKind`.
   *
   * The daemon may send a kind this build has never heard of — the union is
   * open in practice and grows without a renderer release. Consumers must treat
   * an unrecognized kind as "refetch everything for this plugin" rather than
   * dropping it.
   */
  kind: "installs" | "panels" | "collections" | "contributions" | "status";
  pluginId?: string;
  panelId?: string;
  collection?: string;
};

/** The directory as the Marketplace receives it; entries stay unparsed. */
export type PluginClientMarketplaceIndex = {
  entries: unknown[];
  /** When the index was fetched. Null when it came from a cold cache. */
  fetchedAt: string | null;
  /** Whether these bytes came off the network or out of the etag cache. */
  origin: "network" | "cache";
};

/** A plugin's install state on one machine, as the coverage rail draws it. */
export type PluginClientPresenceRow = {
  machineKey: string;
  machineName: string;
  pluginId: string;
  version: string | null;
  enabled: boolean;
  /** False for a machine that is in the directory but not reachable now. */
  online: boolean;
  /**
   * Set by the host on rows for the machine this client runs on. The client
   * cannot work this out from the rows alone, and guessing wrong shows someone
   * another machine's install state as their own.
   */
  isThisMachine: boolean;
};

/** Storage and wire usage for one plugin, against its writer-enforced budget. */
export type PluginClientUsageRow = {
  pluginId: string;
  collectionBytes: number;
  collectionBudgetBytes: number;
  rows: number;
  rowBudget: number;
  /** Cumulative sync bytes attributed to this plugin. Null when unmetered. */
  syncBytesTotal: number | null;
};

export type PluginClientInstallRequest = {
  /** Git URL or directory path. The one field an install always has. */
  source: string;
  /** Known ahead of time for a directory entry; absent for install-from-URL. */
  pluginId?: string;
  /**
   * The directory version the user chose. Carried all the way to the host,
   * which is the only layer that knows how a version maps to a git ref.
   */
  version?: string;
  /** Install on another machine instead of this one. */
  machineKey?: string;
};

export type PluginClientInstallResult = {
  pluginId: string;
  version: string;
  displayName: string;
};

/** What the host learned by reading a source before installing it. */
export type PluginClientSourceInspection = {
  source: string;
  /** Raw manifest object — parsed by `./manifest`, never by the transport. */
  manifest: unknown;
};

// ---------------------------------------------------------------------------
// Service availability
// ---------------------------------------------------------------------------

/**
 * The one code every layer answers with when plugins are not available here.
 *
 * A headless brain, a build without the plugin host, and a desktop main process
 * whose `pluginHostService` was never assigned are all the same answer to the
 * caller: this computer cannot do plugins. Saying so in one typed code is what
 * lets a client degrade honestly — showing a machine-level Marketplace as
 * read-only — instead of surfacing a project-runtime error for a request that
 * has nothing to do with a project, or reporting a success that never happened.
 */
export const PLUGIN_SERVICE_UNAVAILABLE_CODE = "plugins_unavailable";

/** True when `error` is that refusal, however it was relayed. */
export function isPluginsUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === PLUGIN_SERVICE_UNAVAILABLE_CODE) return true;
  // Electron IPC strips custom Error properties, so the code arrives inside the
  // message (see `shared/codedError.ts` — `"<code>: <message>"`).
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes(PLUGIN_SERVICE_UNAVAILABLE_CODE);
}
