/**
 * The wire contract shared by the three Electron entry points.
 *
 * NO ELECTRON IMPORT, EVER. This package does not depend on `electron` at
 * build time or at run time, so every Electron object it touches is described
 * here as a structural interface. An embedder passes the real `ipcMain`,
 * `ipcRenderer` and `contextBridge`; TypeScript accepts them because they have
 * the members below, and the SDK never has to agree with the host on an
 * Electron version.
 *
 * This module also has NO VALUE IMPORTS of its own. The preload bundle inlines
 * it, and a preload that runs under `sandbox: true` cannot resolve modules at
 * all, so anything that reaches it must be self-contained.
 */

import type {
  InstructionsCapability,
  PermissionCapability,
  SettingSourcesCapability,
} from "../hostConfig.js";
import type { AgentChatEventEnvelope, McpCapabilityReport, ProviderStatus } from "../types.js";

/** Channel namespace. A host that runs two bridges gives each its own prefix. */
export const ADE_DEFAULT_CHANNEL_PREFIX = "ade";

/** Default `window` key the preload exposes the bridge under. */
export const ADE_DEFAULT_BRIDGE_KEY = "ade";

/** `<prefix>:invoke` — one `ipcMain.handle` for every method. */
export function invokeChannel(prefix: string): string {
  return `${prefix}:invoke`;
}

/** `<prefix>:event` — main pushes here, to the owning `webContents` only. */
export function eventChannel(prefix: string): string {
  return `${prefix}:event`;
}

/* -------------------------------------------------------------------------- */
/* Structural Electron interfaces                                              */
/* -------------------------------------------------------------------------- */

/**
 * The `webContents` members the bridge uses.
 *
 * Listener parameters are `any[]` on purpose: Electron types `on` and `once` as
 * a large overload set of literal event names, and a narrower structural type
 * here would reject the real object rather than describe it.
 */
export interface WebContentsLike {
  readonly id: number;
  send(channel: string, ...args: any[]): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  isDestroyed(): boolean;
}

/** The `IpcMainInvokeEvent` members the bridge uses. */
export interface IpcMainInvokeEventLike {
  readonly sender: WebContentsLike;
}

/** The `ipcMain` members the bridge uses. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** The `ipcRenderer` members the preload uses. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
  removeListener(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
}

/** The `contextBridge` members the preload uses. */
export interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: unknown): void;
}

/* -------------------------------------------------------------------------- */
/* Payloads                                                                    */
/* -------------------------------------------------------------------------- */

/** One call from a renderer. `args` is positional, matching the SDK method. */
export type AdeIpcInvokeRequest = {
  method: string;
  args: unknown[];
};

/**
 * A failure, flattened so it survives structured clone.
 *
 * `ipcMain.handle` rejections reach the renderer as a plain `Error` whose
 * message has been rewritten, which loses `AdeError.code` — the one field an
 * embedder branches on. So the handler never rejects: it resolves with this
 * envelope and the renderer rebuilds a real `AdeError`.
 */
export type AdeIpcErrorPayload = {
  __adeError: true;
  name: "AdeError";
  code: string;
  message: string;
};

export type AdeIpcInvokeResponse<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: AdeIpcErrorPayload };

/** A pushed envelope for one thread subscription. */
export type AdeIpcThreadEvent = {
  kind: "thread";
  subscriptionId: string;
  key: string;
  envelope: AgentChatEventEnvelope;
};

/** A pushed provider-status snapshot for one `providers.onChange` subscription. */
export type AdeIpcProvidersEvent = {
  kind: "providers";
  subscriptionId: string;
  statuses: Record<string, ProviderStatus>;
};

export type AdeIpcEventPayload = AdeIpcThreadEvent | AdeIpcProvidersEvent;

/**
 * What the preload puts on `window[key]`.
 *
 * Functions and plain data only. Nothing structured-cloned across
 * `contextBridge` keeps its prototype, so the renderer receives an id plus
 * functions and rebuilds every object shape on its own side.
 */
export type AdeBridge = {
  invoke(method: string, args: unknown[]): Promise<AdeIpcInvokeResponse>;
  onEvent(listener: (payload: AdeIpcEventPayload) => void): () => void;
};

/* -------------------------------------------------------------------------- */
/* Snapshots                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What `threads.open` returns across the bridge.
 *
 * The capability reports are read-only snapshots taken at open, typed with the
 * SDK's own report types. They are plain serializable objects that the main
 * side has ALREADY normalized (`hostConfig.ts`), so there is nothing left for
 * the renderer to validate — and typing them `unknown` here only moved four
 * unchecked casts to the far side of the wire. Forward compatibility is carried
 * by the report types themselves, which are open where it matters
 * (`HostConfigCapability` intersects `Record<string, unknown>`).
 *
 * Types only: this module still has no value import of its own.
 */
export type AdeIpcThreadSnapshot = {
  id: string;
  key: string;
  mcpCapability: McpCapabilityReport | null;
  instructionsCapability: InstructionsCapability | null;
  settingSourcesCapability: SettingSourcesCapability | null;
  permissionCapability: PermissionCapability | null;
};

/** `{ subscriptionId }`, returned by every subscribe method. */
export type AdeIpcSubscription = { subscriptionId: string };

/* -------------------------------------------------------------------------- */
/* Method names                                                                */
/* -------------------------------------------------------------------------- */

export const ADE_IPC_METHODS = [
  "providers.status",
  "providers.refresh",
  "providers.subscribe",
  "providers.unsubscribe",
  "models.list",
  "threads.open",
  "thread.send",
  "thread.steer",
  "thread.interrupt",
  "thread.history",
  "thread.setModel",
  "thread.approve",
  "thread.pendingApprovals",
  "thread.subscribe",
  "thread.unsubscribe",
] as const;

export type AdeIpcMethod = (typeof ADE_IPC_METHODS)[number];

/**
 * Methods whose first argument is a thread key, so `allowThreadKey` can gate
 * them without the dispatch table restating the rule per method.
 */
export const ADE_IPC_THREAD_KEY_METHODS: ReadonlySet<AdeIpcMethod> = new Set<AdeIpcMethod>([
  "threads.open",
  "thread.send",
  "thread.steer",
  "thread.interrupt",
  "thread.history",
  "thread.setModel",
  "thread.approve",
  "thread.pendingApprovals",
  "thread.subscribe",
]);

/* -------------------------------------------------------------------------- */
/* Envelope ordering                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The de-duplication key `@ade-dev/chat-ui` documents.
 *
 * History and the live stream overlap by design — an envelope emitted while
 * `history()` is in flight legitimately appears in both — so both sides key on
 * exactly this string and the overlap collapses instead of double-rendering.
 */
export function envelopeDedupeKey(
  envelope: AgentChatEventEnvelope,
  /**
   * How many earlier envelopes IN THE SAME ARRAY already produced this exact
   * key. Zero, and omitted, for the ordinary case.
   *
   * `sequence` is optional on the wire, and without it two `text` deltas in the
   * same millisecond produce one key and the second is dropped — a hole in the
   * transcript on a fast stream from a runtime that does not number its
   * envelopes. An occurrence index fixes that WITHOUT breaking the overlap
   * collapse this key exists for: history and the live buffer are counted
   * separately, so one envelope appearing in both is the first occurrence in
   * each and the two still meet on one key, while two genuinely distinct
   * deltas inside one array do not.
   *
   * BRIDGE-LOCAL. It means nothing outside the array it was counted in, which
   * is why `@ade-dev/chat-ui`'s mirror of this key does not carry it.
   */
  occurrence = 0,
): string {
  const sequence = typeof envelope.sequence === "number" ? String(envelope.sequence) : "?";
  const type = typeof envelope.event?.type === "string" ? envelope.event.type : "?";
  const base = `${envelope.sessionId}:${sequence}:${envelope.timestamp}:${type}`;
  return occurrence > 0 ? `${base}#${occurrence}` : base;
}

/** Keys one array's envelopes, numbering repeats of an identical key. */
function keyEnvelopes(envelopes: readonly AgentChatEventEnvelope[]): string[] {
  const counts = new Map<string, number>();
  return envelopes.map((envelope) => {
    const base = envelopeDedupeKey(envelope);
    const occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    return envelopeDedupeKey(envelope, occurrence);
  });
}

/**
 * Envelope order: numbered envelopes first, then `sequence`, then `timestamp`.
 *
 * Mirrors `sortEnvelopes` in `@ade-dev/chat-ui`. Provider clocks are not
 * trusted, which is why `sequence` wins whenever an envelope carries one. Two
 * envelopes with neither compare equal and a stable sort leaves them in
 * arrival order.
 */
export function compareEnvelopes(a: AgentChatEventEnvelope, b: AgentChatEventEnvelope): number {
  const aSeq = typeof a.sequence === "number" ? a.sequence : null;
  const bSeq = typeof b.sequence === "number" ? b.sequence : null;
  // Sequence is the primary key unconditionally, matching chat-ui's
  // `sortEnvelopes`. Comparing sequence only when BOTH sides carry one, then
  // falling through to timestamp, is intransitive on a mixed page
  // ({seq 1, t3}, {seq 2, t1}, {no seq, t2}) and Array.sort may then permute
  // the transcript. Numbered envelopes come first, in sequence order; timestamp
  // is consulted only inside the un-numbered group.
  if (aSeq !== null && bSeq === null) return -1;
  if (aSeq === null && bSeq !== null) return 1;
  if (aSeq !== null && bSeq !== null) {
    if (aSeq !== bSeq) return aSeq - bSeq;
    // Equal sequence: keep arrival order. chat-ui's `sortEnvelopes` does the
    // same via index; falling through to timestamp here is the one remaining
    // disagreement, and duplicate sequences are not on the wire.
    return 0;
  }
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return 0;
}

/**
 * Merge a history page with the live envelopes buffered while it was in flight.
 *
 * Each envelope is delivered once, in envelope order. This is the rule the
 * chat-ui README states in prose; keeping it in code means an embedder inherits
 * it instead of re-reading the paragraph.
 */
export function mergeHistoryWithBuffer(
  history: AgentChatEventEnvelope[],
  buffered: AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  const seen = new Set<string>();
  const merged: AgentChatEventEnvelope[] = [];
  // Each array keyed on its own, so repeats inside one array stay distinct
  // while the same envelope seen in both still meets on one key.
  const keys = [...keyEnvelopes(history), ...keyEnvelopes(buffered)];
  [...history, ...buffered].forEach((envelope, index) => {
    const key = keys[index]!;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(envelope);
  });
  return merged.sort(compareEnvelopes);
}
