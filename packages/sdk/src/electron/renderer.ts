/**
 * `@ade-dev/sdk/electron/renderer` — the renderer half of the Electron bridge.
 *
 * Turns `window.ade` (what the preload exposed) back into an object shaped like
 * an SDK client, so it drops straight into `adaptSdkClient` with no host glue
 * and no `as any`:
 *
 *   import { createAdeIpcClient } from "@ade-dev/sdk/electron/renderer";
 *   import { adaptSdkClient, AdeChat } from "@ade-dev/chat-ui";
 *
 *   const sdkLike = createAdeIpcClient(window.ade);
 *   const client = adaptSdkClient(sdkLike, { providerFilter: ["claude", "codex"] });
 *
 * BROWSER ONLY. Nothing here touches Node: no `node:` import, no `process`, no
 * `Buffer`. It is bundled for the browser platform and runs inside a strict CSP
 * with no `eval` and no remote fetch.
 *
 * TWO RULES THIS FILE OWNS SO EMBEDDERS DO NOT HAVE TO.
 *
 *   1. ONE MAIN-SIDE LISTENER PER THREAD. `on()` is refcounted here: the first
 *      listener for a key subscribes across IPC, the last one to leave
 *      unsubscribes. A React tree with twelve components watching one thread
 *      costs the main process one subscription, and closing them all leaves
 *      none behind.
 *   2. HISTORY AND LIVE EVENTS DO NOT RACE. `history()` subscribes first, then
 *      asks, then merges — so an envelope emitted while the request was in
 *      flight is delivered exactly once, in envelope order, whether it arrived
 *      live or in the page.
 */

import type { ApprovalDecision, ApprovalRequest } from "../approvals.js";
import { AdeError, readAdeErrorCode } from "../errors.js";
import type {
  InstructionsCapability,
  PermissionCapability,
  SettingSourcesCapability,
} from "../hostConfig.js";
import type {
  SendOptions,
  SetModelOptions,
  ThreadEventChannel,
  ThreadModelSelection,
} from "../thread.js";
import {
  STATUS_EVENT_TYPES,
  USAGE_EVENT_TYPES,
  type AgentChatEventEnvelope,
  type McpCapabilityReport,
  type ModelCatalogEntry,
  type ProviderStatus,
  type Unsubscribe,
} from "../types.js";
import {
  mergeHistoryWithBuffer,
  type AdeBridge,
  type AdeIpcErrorPayload,
  type AdeIpcEventPayload,
  type AdeIpcInvokeResponse,
  type AdeIpcSubscription,
  type AdeIpcThreadSnapshot,
} from "./protocol.js";

const USAGE = new Set<string>(USAGE_EVENT_TYPES);
const STATUS = new Set<string>(STATUS_EVENT_TYPES);

/**
 * A thread handle over IPC.
 *
 * Every member is typed with the SDK's own type, not a loosened copy, so this
 * interface satisfies `SdkLikeThread` from `@ade-dev/chat-ui` structurally and
 * `adaptSdkClient` takes it with no cast. The capability reports are read-only
 * snapshots taken at open: a proxy cannot re-derive one after `setModel` the
 * way a real thread does, so re-open the key if you need a fresh verdict.
 */
export interface AdeIpcThread {
  readonly id: string;
  readonly key: string;
  readonly mcpCapability: McpCapabilityReport | null;
  readonly instructionsCapability: InstructionsCapability | null;
  readonly settingSourcesCapability: SettingSourcesCapability | null;
  readonly permissionCapability: PermissionCapability | null;
  send(text: string, opts?: SendOptions): Promise<void>;
  steer(text: string): Promise<void>;
  interrupt(): Promise<void>;
  setModel(modelId: string, opts?: SetModelOptions): Promise<ThreadModelSelection>;
  history(opts?: { limit?: number }): Promise<AgentChatEventEnvelope[]>;
  approve(itemId: string, decision: ApprovalDecision, responseText?: string): Promise<void>;
  pendingApprovals(): Promise<ApprovalRequest[]>;
  on(channel: ThreadEventChannel, cb: (envelope: AgentChatEventEnvelope) => void): Unsubscribe;
}

/** A client over IPC. Satisfies `SdkLikeChatClient` from `@ade-dev/chat-ui`. */
export interface AdeIpcClient {
  providers: {
    status(): Promise<Record<string, ProviderStatus>>;
    refresh(): Promise<Record<string, ProviderStatus>>;
    onChange(cb: (statuses: Record<string, ProviderStatus>) => void): Unsubscribe;
  };
  models: { list(): Promise<ModelCatalogEntry[]> };
  threads: { open(key: string, opts?: Record<string, unknown>): Promise<AdeIpcThread> };
}

/**
 * Rebuild a real `AdeError` from the flattened payload.
 *
 * Takes the error member, not the union: the caller has already narrowed, and
 * typing the parameter as the union only bought a branch for a case that cannot
 * occur. The code is VALIDATED rather than cast — it is a bare string that
 * crossed a process boundary, and `serializeError` on the main side already
 * defaults anything unrecognised to `"rpc_error"`, so a value that is still not
 * a declared code came from somewhere else and must not be presented as one.
 */
function rehydrate(error: AdeIpcErrorPayload): never {
  throw new AdeError(readAdeErrorCode(error.code) ?? "rpc_error", error.message);
}

/** One buffered envelope, plus whether the `"event"` channel already got it. */
type BufferedEnvelope = { envelope: AgentChatEventEnvelope; deliveredLive: boolean };

/** Per-key state: the snapshot, the live listener sets, and the IPC subscription. */
type ThreadState = {
  snapshot: AdeIpcThreadSnapshot;
  listeners: Map<ThreadEventChannel, Set<(envelope: AgentChatEventEnvelope) => void>>;
  /** How many `on()` handles and in-flight `history()` calls hold the subscription. */
  refCount: number;
  subscriptionId: string | null;
  subscribing: Promise<void> | null;
  /**
   * Envelopes seen while a `history()` request is in flight, each tagged with
   * whether the `"event"` CHANNEL already received it. Only the untagged ones
   * are folded into the returned page, which is what makes delivery exactly
   * once rather than merely de-duplicable.
   *
   * Per channel, not per envelope. One flag for the whole envelope meant a
   * `token_usage` delivered to a `usage` meter counted as delivered, and the
   * transcript — which is what `history()` seeds, and which subscribes on
   * `"event"` — never saw it at all. That is the ordinary mount order, not an
   * edge case: `history()` runs before the transcript attaches its listener.
   */
  buffers: Set<BufferedEnvelope[]>;
};

/**
 * Build an SDK-shaped client on top of the preload bridge.
 *
 * `bridge` is whatever `exposeAdeBridge` put on `window` — `window.ade` by
 * default. Nothing else is required of the host.
 */
export function createAdeIpcClient(bridge: AdeBridge): AdeIpcClient {
  if (!bridge || typeof bridge.invoke !== "function" || typeof bridge.onEvent !== "function") {
    throw new AdeError(
      "invalid_option",
      "createAdeIpcClient needs the object exposeAdeBridge exposed (window.ade by default).",
    );
  }

  const threads = new Map<string, ThreadState>();
  const opening = new Map<string, Promise<AdeIpcThread>>();
  const providerListeners = new Set<(statuses: Record<string, ProviderStatus>) => void>();
  let providerSubscriptionId: string | null = null;
  let providerSubscribing: Promise<void> | null = null;
  let detachBridge: (() => void) | null = null;

  async function call<T>(method: string, args: unknown[]): Promise<T> {
    const response = (await bridge.invoke(method, args)) as AdeIpcInvokeResponse<T>;
    if (!response || typeof response !== "object" || !("ok" in response)) {
      throw new AdeError("protocol_error", `The ADE bridge returned no result for ${method}.`);
    }
    if (!response.ok) rehydrate(response.error);
    return response.value;
  }

  function routeThreadEvent(subscriptionId: string, envelope: AgentChatEventEnvelope): void {
    for (const state of threads.values()) {
      if (state.subscriptionId !== subscriptionId) continue;
      let deliveredToEventChannel = false;
      const type = typeof envelope.event?.type === "string" ? envelope.event.type : "";
      for (const [channel, set] of state.listeners) {
        if (set.size === 0) continue;
        if (channel === "usage" && !USAGE.has(type)) continue;
        if (channel === "status" && !STATUS.has(type)) continue;
        // Only the `"event"` channel counts: it is the transcript stream, and
        // it is the one `history()` must neither double- nor under-deliver.
        if (channel === "event") deliveredToEventChannel = true;
        for (const cb of [...set]) cb(envelope);
      }
      for (const buffer of state.buffers) {
        buffer.push({ envelope, deliveredLive: deliveredToEventChannel });
      }
      return;
    }
  }

  function ensureBridgeListener(): void {
    if (detachBridge) return;
    detachBridge = bridge.onEvent((payload: AdeIpcEventPayload) => {
      if (!payload || typeof payload !== "object") return;
      if (payload.kind === "thread") {
        routeThreadEvent(payload.subscriptionId, payload.envelope);
        return;
      }
      if (payload.kind === "providers") {
        if (payload.subscriptionId !== providerSubscriptionId) return;
        for (const cb of [...providerListeners]) cb(payload.statuses);
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Providers                                                               */
  /* ---------------------------------------------------------------------- */

  function providersOnChange(
    cb: (statuses: Record<string, ProviderStatus>) => void,
  ): Unsubscribe {
    ensureBridgeListener();
    providerListeners.add(cb);
    if (!providerSubscriptionId && !providerSubscribing) {
      providerSubscribing = call<AdeIpcSubscription>("providers.subscribe", [])
        .then((result) => {
          if (providerListeners.size === 0) {
            // Everybody left while the subscribe was in flight. Release it
            // rather than holding a main-side listener nobody reads.
            void call("providers.unsubscribe", [result.subscriptionId]).catch(() => {});
            return;
          }
          providerSubscriptionId = result.subscriptionId;
        })
        .catch(() => {})
        .finally(() => {
          providerSubscribing = null;
        });
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      providerListeners.delete(cb);
      if (providerListeners.size > 0) return;
      const id = providerSubscriptionId;
      providerSubscriptionId = null;
      if (id) void call("providers.unsubscribe", [id]).catch(() => {});
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Threads                                                                 */
  /* ---------------------------------------------------------------------- */

  function stateFor(key: string): ThreadState {
    const existing = threads.get(key);
    if (existing) return existing;
    throw new AdeError("thread_not_found", `No open thread "${key}" in this renderer.`);
  }

  async function acquireSubscription(key: string): Promise<void> {
    const state = stateFor(key);
    state.refCount += 1;
    ensureBridgeListener();
    if (state.subscriptionId) return;
    if (!state.subscribing) {
      state.subscribing = call<AdeIpcSubscription>("thread.subscribe", [key])
        .then((result) => {
          if (state.refCount === 0) {
            void call("thread.unsubscribe", [result.subscriptionId]).catch(() => {});
            return;
          }
          state.subscriptionId = result.subscriptionId;
        })
        .catch(() => {})
        .finally(() => {
          state.subscribing = null;
        });
    }
    await state.subscribing;
  }

  function releaseSubscription(key: string): void {
    const state = threads.get(key);
    if (!state) return;
    state.refCount = Math.max(0, state.refCount - 1);
    if (state.refCount > 0) return;
    const id = state.subscriptionId;
    state.subscriptionId = null;
    if (id) void call("thread.unsubscribe", [id]).catch(() => {});
  }

  function buildThread(key: string): AdeIpcThread {
    const state = stateFor(key);
    // Every snapshot field reads through `state`, not through a captured
    // object: reopening a key refreshes the snapshot and an old handle must
    // report the new capability rather than the one it was born with.
    return {
      get id() {
        return state.snapshot.id;
      },
      key,
      get mcpCapability() {
        return state.snapshot.mcpCapability;
      },
      get instructionsCapability() {
        return state.snapshot.instructionsCapability;
      },
      get settingSourcesCapability() {
        return state.snapshot.settingSourcesCapability;
      },
      get permissionCapability() {
        return state.snapshot.permissionCapability;
      },
      async send(text, opts) {
        await call<null>("thread.send", [key, text, opts ?? null]);
      },
      async steer(text) {
        await call<null>("thread.steer", [key, text]);
      },
      async interrupt() {
        await call<null>("thread.interrupt", [key]);
      },
      setModel(modelId, opts) {
        return call<ThreadModelSelection>("thread.setModel", [key, modelId, opts ?? null]);
      },
      async approve(itemId, decision, responseText) {
        await call<null>("thread.approve", [key, itemId, decision, responseText ?? null]);
      },
      pendingApprovals() {
        return call<ApprovalRequest[]>("thread.pendingApprovals", [key]);
      },
      async history(opts) {
        // Subscribe BEFORE asking. An envelope emitted between the request and
        // its answer would otherwise fall in the gap: too late for the page,
        // too early for a subscriber that had not attached yet.
        await acquireSubscription(key);
        const buffer: BufferedEnvelope[] = [];
        state.buffers.add(buffer);
        try {
          const page = await call<AgentChatEventEnvelope[]>("thread.history", [key, opts ?? null]);
          const missed = buffer.filter((row) => !row.deliveredLive).map((row) => row.envelope);
          return mergeHistoryWithBuffer(Array.isArray(page) ? page : [], missed);
        } finally {
          state.buffers.delete(buffer);
          releaseSubscription(key);
        }
      },
      on(channel, cb) {
        let set = state.listeners.get(channel);
        if (!set) {
          set = new Set();
          state.listeners.set(channel, set);
        }
        set.add(cb);
        void acquireSubscription(key);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          set.delete(cb);
          releaseSubscription(key);
        };
      },
    };
  }

  async function openThread(key: string, opts?: Record<string, unknown>): Promise<AdeIpcThread> {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed) throw new AdeError("invalid_option", "threads.open needs a non-empty key.");
    if (threads.has(trimmed)) return buildThread(trimmed);
    const pending = opening.get(trimmed);
    if (pending) return pending;

    // Idempotent per key, with the same in-flight collapse the SDK does: a
    // re-running React effect opens the same key twice and must not create two
    // handles onto one conversation.
    const started = (async () => {
      const snapshot = await call<AdeIpcThreadSnapshot>("threads.open", [trimmed, opts ?? null]);
      const existing = threads.get(trimmed);
      if (existing) {
        existing.snapshot = snapshot;
      } else {
        threads.set(trimmed, {
          snapshot,
          listeners: new Map(),
          refCount: 0,
          subscriptionId: null,
          subscribing: null,
          buffers: new Set(),
        });
      }
      return buildThread(trimmed);
    })().finally(() => {
      opening.delete(trimmed);
    });
    opening.set(trimmed, started);
    return started;
  }

  return {
    providers: {
      status: () => call<Record<string, ProviderStatus>>("providers.status", []),
      refresh: () => call<Record<string, ProviderStatus>>("providers.refresh", []),
      onChange: providersOnChange,
    },
    models: { list: () => call<ModelCatalogEntry[]>("models.list", []) },
    threads: { open: openThread },
  };
}

export type { AdeBridge } from "./protocol.js";
export {
  compareEnvelopes,
  envelopeDedupeKey,
  mergeHistoryWithBuffer,
} from "./protocol.js";
/**
 * The same `AdeError` class the renderer half throws.
 *
 * Import it from here rather than from `@ade-dev/sdk` if you want `instanceof`
 * to hold: the subpaths are separate bundles and the root entry is Node-only,
 * so it does not belong in a renderer at all. `error.code` is the stable check
 * and survives regardless.
 */
export { AdeError, type AdeErrorCode } from "../errors.js";
