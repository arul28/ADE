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

import { isRecord } from "./parse";
import { isValidPluginManifestIdentifier } from "./manifest";
import type {
  PluginManifest,
  PluginManifestAutomationStep,
  PluginManifestAutomationTrigger,
  PluginManifestKeybinding,
  PluginManifestSearchProvider,
  PluginManifestSetting,
  PluginSurfaceKind,
} from "./manifest";
import type { PluginRegistryEntry } from "./registryIndex";
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

export type PluginEventName = PluginChangeEventName | PluginRuntimeHookName;

export function isPluginEventName(value: unknown): value is PluginEventName {
  return value === "lane.changed"
    || value === "pr.changed"
    || value === "session.changed"
    || value === "install.changed"
    || isPluginRuntimeHookName(value);
}

export type PluginEventPayload = {
  event: PluginChangeEventName;
  /** Entity ids that changed since the last delivery, capped and deduped. */
  ids: string[];
  projectId: string | null;
  /**
   * `ids` was truncated at the delivery cap. Absent, never `false`, when it
   * was not — additive so a plugin compiled against the two-field payload
   * keeps working.
   *
   * `ids` is not a diff a listener can trust once this is set: more changed
   * than the cap carries, so the honest read is "the install set moved,
   * treat this the same as `install.changed` with no ids at all" — re-read
   * the roster (`plugin.list`) rather than acting only on the ids present.
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

/** Everything an `event` frame can carry. */
export type PluginAnyEventPayload = PluginEventPayload | PluginRuntimeHookPayload;

/** The payload shape one event name delivers. */
export type PluginEventPayloadFor<E extends PluginEventName> =
  E extends PluginRuntimeHookName ? Extract<PluginRuntimeHookPayload, { event: E }> : PluginEventPayload;

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
};

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
  const context = navigate.context;
  if (!isRecord(context)) return { panelId };
  let json: string;
  try {
    json = JSON.stringify(context) ?? "";
  } catch {
    return { panelId };
  }
  // Over the ceiling drops the context and keeps the navigation: the user
  // pressed a button and should still land where it sent them.
  if (!json || pluginUtf8ByteLength(json) > PLUGIN_NAVIGATE_CONTEXT_MAX_BYTES) return { panelId };
  return { panelId, context };
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
] as const;

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
};

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
  | "contributions.publish"
  | "panels.update"
  | "config.get"
  | "audio.captureClip"
  | "notifications.post"
  | "schedules.create"
  | "schedules.list"
  | "schedules.delete"
  | "automations.emitTrigger"
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
    args?: Record<string, unknown>;
    argv?: string[];
    timeoutMs?: number;
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
  uninstall(args: { pluginId: string }): Promise<{ removed: boolean }>;
  enable(args: { pluginId: string }): Promise<PluginSummary>;
  disable(args: { pluginId: string }): Promise<PluginSummary>;
  usageSummary(args?: { pluginId?: string }): Promise<PluginUsageSummary>;
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
