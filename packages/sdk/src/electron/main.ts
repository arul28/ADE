/**
 * `@ade-dev/sdk/electron` — the main-process half of the Electron bridge.
 *
 * `@ade-dev/sdk` spawns a child process and speaks over a Unix socket, so it
 * lives in the main process. `@ade-dev/chat-ui` is React and lives in the
 * renderer. They cannot share an object, and the glue between them is not
 * application logic — it is object-lifetime bookkeeping across a process
 * boundary, and it is the same in every app.
 *
 * THE LEAK THIS EXISTS TO PREVENT. `providers.onChange` and `thread.on` return
 * an `Unsubscribe` that only the main process can call. A renderer that reloads
 * (a React fast-refresh loop reloads it constantly) drops its side and leaves
 * main's listener attached. Nothing fails; the transcript simply starts showing
 * every envelope twice, then three times. So the registry below is keyed by
 * `webContents.id` and is torn down on `destroyed` AND on a real navigation.
 *
 * WHAT TEARDOWN DOES AND DOES NOT DO. It drops listeners and forgets the
 * bridge's handles. It does not end the conversation: the SDK's own
 * `liveSessions` keeps the thread, so the renderer reopens the same key and
 * resumes the same transcript.
 *
 * WHAT A RENDERER MAY CHOOSE. A thread key carries a tool surface, a policy
 * and a working directory, and the renderer is the least trusted process in
 * the app. So the renderer never configures a thread: either the host's
 * `openOptions` hook decides everything, or the bridge forwards only
 * `provider`, `model`, `title` and `reasoningEffort` and drops the rest.
 */

import { APPROVAL_DECISIONS, type ApprovalDecision } from "../approvals.js";
import { AdeError, errorMessage } from "../errors.js";
import type { AdeChatClient, ThreadOpenOptions, ThreadResumeOptions } from "../client.js";
import { ADE_CLIENT_EVENTS } from "../clientEvents.js";
import type { AdeThread, HistoryPageOptions, ThreadUpdate, ThreadUpdateOptions } from "../thread.js";
import type { AgentChatEventEnvelope, ThreadSummary, Unsubscribe } from "../types.js";
import {
  ADE_DEFAULT_CHANNEL_PREFIX,
  ADE_IPC_THREAD_KEY_METHODS,
  eventChannel,
  invokeChannel,
  type AdeIpcErrorPayload,
  type AdeIpcMethod,
  type AdeIpcEventPayload,
  type AdeIpcInvokeRequest,
  type AdeIpcInvokeResponse,
  type AdeIpcSubscription,
  type AdeIpcThreadSnapshot,
  type IpcMainInvokeEventLike,
  type IpcMainLike,
  type WebContentsLike,
} from "./protocol.js";
import { rendererOpenOptions, rendererSendOptions } from "./rendererOptions.js";

export type RegisterAdeIpcOptions = {
  /** Channel namespace. Defaults to `"ade"`, giving `ade:invoke` and `ade:event`. */
  channelPrefix?: string;
  /**
   * Gate every call before the SDK sees it.
   *
   * Runs first, on every method, with the raw positional arguments. Return
   * false and the renderer receives `AdeError("unauthorized")` and the SDK is
   * not called at all. This is where a host checks the sender frame and its own
   * sign-in state.
   */
  authorize?: (
    event: IpcMainInvokeEventLike,
    method: string,
    args: unknown[],
  ) => boolean | Promise<boolean>;
  /**
   * Restrict which thread keys a renderer may name.
   *
   * A thread key carries MCP servers, a permission policy and a working
   * directory, so a compromised renderer that can open an arbitrary key can
   * choose its own tool surface. Return false and the call is rejected with
   * `AdeError("unauthorized")`.
   *
   * May be async (SDK >= 0.4), so a host whose truth lives in the runtime can
   * answer from `client.threads.get(key)` instead of a hand-synced copy. It
   * runs on every keyed call, so keep an async gate cheap.
   */
  allowThreadKey?: (key: string) => boolean | Promise<boolean>;
  /**
   * The host decides how a thread is opened. Recommended for every host.
   *
   * Called for every renderer `threads.open`, with the key and whatever
   * options the renderer sent (for reading, never for trusting). Its result is
   * what the SDK opens with, and the renderer's options are ignored entirely.
   * Return undefined to reopen a key with its stored record and no options —
   * which fails with `invalid_option` for a key this home has never seen.
   *
   * `context` (SDK >= 0.4) says whether the runtime still has a session for
   * the key (`exists`) and gives its summary (`threads.get`). Use it to tell a
   * resume from a create: for `exists: true` return `{ refresh }` alone (or
   * undefined), and the stored provider, model and policy apply without one
   * "ignored field" log line per option; for `exists: false` return the full
   * create options (provider, model, the locked policy). `exists: false` also
   * covers a known key whose session the runtime lost, which the SDK then
   * recreates with these options.
   *
   * Put credentials here too: return `refresh: { mcpServers }` with the
   * current token and every renderer-driven open pushes it onto the thread.
   *
   * When this hook is NOT set, the bridge forwards only `provider`, `model`,
   * `title` and `reasoningEffort` from the renderer and logs one line per
   * field it dropped. Before 0.3 it forwarded everything, so a compromised
   * renderer could open an allowed key with `permissions: "always-allow"`,
   * its own MCP servers, or its own `cwd`.
   */
  openOptions?: (
    key: string,
    rendererOptions: Record<string, unknown> | undefined,
    context: AdeIpcOpenContext,
  ) =>
    | ThreadOpenOptions
    | ThreadResumeOptions
    | undefined
    | Promise<ThreadOpenOptions | ThreadResumeOptions | undefined>;
  /**
   * Gate the models a renderer may pick.
   *
   * Called for `thread.setModel`, and for a renderer-supplied `model` on
   * `threads.open` when there is no `openOptions` hook. Return false and the
   * call fails with `AdeError("unauthorized")`. Without it any model id the
   * catalog resolves is accepted — including one on a provider the host never
   * meant to offer. May be async (SDK >= 0.4).
   */
  allowModel?: (key: string, selection: { modelId: string }) => boolean | Promise<boolean>;
  /**
   * Called once for every delete or archive this client reports, whoever made
   * it: a renderer over the bridge, or main code calling
   * `client.threads.delete` / `client.threads.archive` (SDK 0.5).
   *
   * `kind` is `"deleted"` or `"archived"`. An unarchive is not reported: the
   * thread is back, not gone. The bridge has already released the renderer's
   * handles for the key when this runs, so your own list can drop the key.
   *
   * To STOP a renderer from deleting or archiving at all, refuse the method in
   * `authorize` — return false for `method === "threads.delete"` (or
   * `"threads.archive"`). There is deliberately no separate deny list.
   *
   * A callback that throws is logged and ignored; it does not fail the delete.
   */
  onThreadRemoved?: (key: string, kind: "deleted" | "archived") => void;
  /** Optional line logger, matching the SDK's own `logger` option. */
  logger?: (line: string) => void;
};

/** What the `openOptions` hook learns about the key being opened. */
export type AdeIpcOpenContext = {
  /** The runtime has a session for the key: this open is a resume. */
  exists: boolean;
  /** That session's summary (`client.threads.get`), or null when `exists` is false. */
  summary: ThreadSummary | null;
};

/**
 * `registerAdeIpc`'s result: call it to dispose the bridge (the pre-0.4
 * contract), and use `forget` to release a key's handles by hand.
 */
export type AdeIpcBridgeHandle = (() => void) & {
  /**
   * Release every renderer's handles and subscriptions for `key`. The bridge
   * already does this for a delete made through the client it serves (by the
   * renderer, or by main code calling `client.threads.delete`); call it for a
   * key you removed some other way. The conversation is not touched. SDK >= 0.4.
   */
  forget(key: string): void;
};

/**
 * The client a bridge serves, or a function returning the current one.
 *
 * The function form is for a host that replaces its client — one per signed-in
 * account, disposed on sign-out. The bridge re-reads it on every call, and on
 * the first call after it changed it moves each renderer across before that
 * call runs (a call that overlaps the move waits for it):
 *   - every key the renderer had open is checked again against
 *     `allowThreadKey` and reopened on the new client with options from the
 *     `openOptions` hook run AGAIN for the new client (or, without a hook, the
 *     renderer's own options filtered again) — never with options resolved for
 *     the old client. A key refused or failing there is dropped, with one log
 *     line, and its subscriptions end;
 *   - every subscription — thread, client-event and provider-status — is
 *     re-attached under the SAME id, so the renderer's handles keep working.
 * Events a replaced client would have pushed between the swap and that first
 * call are not replayed. A client with `autoRestart` never changes identity and
 * needs none of this.
 */
export type AdeChatClientSource = AdeChatClient | (() => AdeChatClient | null | undefined);

/** One subscription a renderer holds, by the id it holds it under. */
type SubscriptionEntry =
  | { kind: "thread"; /** The thread key. */ key: string; stop: Unsubscribe }
  | { kind: "client" | "providers"; stop: Unsubscribe };

/** Per-renderer bookkeeping. One entry per live `webContents`. */
type RendererEntry = {
  webContents: WebContentsLike;
  /** The client this renderer's handles were opened on. */
  client: AdeChatClient | null;
  /** Threads this renderer opened, by key. */
  threads: Map<string, AdeThread>;
  /**
   * What the renderer SENT for each key it opened — raw, before the hook or
   * the filter. A client swap resolves the options again from this, against
   * the new client, rather than replaying options resolved for the old one.
   */
  rendererOptions: Map<string, unknown>;
  /** In-flight opens, so two overlapping opens of one key share a subscription. */
  opening: Map<string, Promise<AdeThread>>;
  /** Every live subscription, by the id the renderer holds. */
  subscriptions: Map<string, SubscriptionEntry>;
  /** The move onto a swapped client, while it runs. Every call waits for it. */
  syncing: Promise<void> | null;
  /** Detaches the `destroyed` / navigation listeners. */
  detach: () => void;
  disposed: boolean;
};

let subscriptionCounter = 0;

function nextSubscriptionId(prefix: string): string {
  subscriptionCounter += 1;
  return `${prefix}-${subscriptionCounter}`;
}

/**
 * Read an `AdeError` code without `instanceof`.
 *
 * The Electron entries are separate bundles, so `AdeError` from
 * `@ade-dev/sdk` and `AdeError` from `@ade-dev/sdk/electron` are two classes
 * with one name. An `instanceof` check here would silently flatten every SDK
 * error to `rpc_error` — exactly the field this whole envelope exists to carry
 * — so the shape is read instead of the prototype.
 */
export function adeErrorCodeOf(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name !== "AdeError") return null;
  return typeof candidate.code === "string" ? candidate.code : null;
}

function serializeError(error: unknown): AdeIpcErrorPayload {
  return {
    __adeError: true,
    name: "AdeError",
    code: adeErrorCodeOf(error) ?? "rpc_error",
    message: errorMessage(error),
  };
}

function unauthorized(method: string): AdeError {
  return new AdeError("unauthorized", `The host refused ${method} for this renderer.`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdeError("invalid_option", `${label} must be a non-empty string.`);
  }
  return value;
}

const DECISIONS: ReadonlySet<string> = new Set<string>(APPROVAL_DECISIONS);

function requireApprovalDecision(value: unknown): ApprovalDecision {
  if (typeof value !== "string" || !DECISIONS.has(value)) {
    throw new AdeError(
      "invalid_option",
      `decision must be one of ${APPROVAL_DECISIONS.join(", ")}; got ${JSON.stringify(value)}.`,
    );
  }
  return value as ApprovalDecision;
}

function removeWebContentsListener(
  webContents: WebContentsLike,
  event: string,
  listener: (...args: any[]) => void,
): void {
  if (typeof webContents.removeListener === "function") {
    webContents.removeListener(event, listener);
    return;
  }
  if (typeof webContents.off === "function") webContents.off(event, listener);
}

/**
 * Decide whether a navigation event means "this renderer's world is gone".
 *
 * A hash change and an iframe navigation both raise `did-start-navigation`, and
 * neither destroys the renderer's JavaScript context. Tearing down on those
 * would silently kill a live transcript on an in-page route change. Electron
 * has passed these arguments two different ways across versions — a details
 * object in recent releases, four positional arguments before that — so both
 * shapes are read rather than assumed.
 */
export function navigationEndsRendererWorld(args: unknown[]): boolean {
  const [first, second, third, fourth] = args;
  if (first && typeof first === "object") {
    const details = first as Record<string, unknown>;
    if ("isSameDocument" in details || "isMainFrame" in details) {
      if (details.isSameDocument === true) return false;
      if (details.isMainFrame === false) return false;
      return true;
    }
  }
  // Legacy positional form: (event, url, isInPlace, isMainFrame).
  if (typeof second === "string") {
    if (third === true) return false;
    if (fourth === false) return false;
    return true;
  }
  return true;
}

/**
 * Attach the ADE chat surface to an `ipcMain`.
 *
 * Returns a disposer that removes the handler and tears down every renderer's
 * subscriptions. Call it before `client.dispose()` so no push races a closing
 * runtime. The disposer also carries `forget(key)` (see `AdeIpcBridgeHandle`).
 *
 * `clientSource` is the client, or a function returning the current one — see
 * {@link AdeChatClientSource} for what a swap does.
 */
export function registerAdeIpc(
  ipcMain: IpcMainLike,
  clientSource: AdeChatClientSource,
  opts: RegisterAdeIpcOptions = {},
): AdeIpcBridgeHandle {
  // The client whose `threadLifecycle` events this bridge follows: a static
  // client from registration on, and for a client getter the one it last
  // served (see `syncClient`). A delete made on it by host code in main
  // releases the renderers' handles for the key, as a delete over the bridge
  // does.
  let watchedClient: AdeChatClient | null = null;
  let stopWatching: Unsubscribe | null = null;
  const watchLifecycle = (client: AdeChatClient): void => {
    if (watchedClient === client) return;
    stopWatching?.();
    stopWatching = null;
    watchedClient = client;
    try {
      stopWatching = client.on("threadLifecycle", (payload) => {
        const key = payload?.key;
        if (typeof key !== "string") return;
        if (payload?.change === "deleted") forgetKeyEverywhere(key);
        // The one place this fires. Every delete and archive reaches it — the
        // renderer's `threads.delete`, and main code calling it on the client —
        // so a host callback is never called twice for one removal. A client
        // with no `threadLifecycle` event skips it, which is why the two
        // `threads.delete` / `threads.archive` handlers also do their own
        // cleanup (see `forgetKeyEverywhere` there).
        if (payload?.change === "deleted" || payload?.change === "archived") {
          notifyThreadRemoved(key, payload.change);
        }
      });
    } catch (error) {
      // A client from an SDK before 0.4 rejects the event name; its deletes
      // over the bridge are still released by the `threads.delete` handler.
      log(`[ade-electron] cannot follow thread deletes on this client: ${errorMessage(error)}`);
    }
  };
  const currentClient = (): AdeChatClient => {
    const client = typeof clientSource === "function" ? clientSource() : clientSource;
    if (!client || typeof client !== "object" || !client.threads) {
      throw new AdeError("disposed", "The host has no ADE chat client to serve this call.");
    }
    return client;
  };
  const prefix = opts.channelPrefix?.trim() || ADE_DEFAULT_CHANNEL_PREFIX;
  const log = opts.logger ?? (() => {});
  const { allowThreadKey } = opts;
  const renderers = new Map<number, RendererEntry>();
  let disposed = false;

  function push(webContents: WebContentsLike, payload: AdeIpcEventPayload): void {
    if (webContents.isDestroyed()) return;
    try {
      webContents.send(eventChannel(prefix), payload);
    } catch (error) {
      // A renderer that went away between the destroyed check and the send is
      // the normal case during a reload, not a fault worth propagating.
      log(`[ade-electron] push dropped: ${errorMessage(error)}`);
    }
  }

  function disposeRenderer(id: number): void {
    const entry = renderers.get(id);
    if (!entry || entry.disposed) return;
    entry.disposed = true;
    renderers.delete(id);
    for (const subscriptionId of [...entry.subscriptions.keys()]) releaseSubscription(entry, subscriptionId);
    entry.threads.clear();
    entry.opening.clear();
    entry.rendererOptions.clear();
    entry.detach();
    log(`[ade-electron] released renderer ${id}`);
  }

  function rendererFor(event: IpcMainInvokeEventLike): RendererEntry {
    const webContents = event.sender;
    const existing = renderers.get(webContents.id);
    if (existing) return existing;

    const id = webContents.id;
    const onDestroyed = () => disposeRenderer(id);
    const onNavigation = (...args: unknown[]) => {
      if (!navigationEndsRendererWorld(args)) return;
      disposeRenderer(id);
    };

    webContents.once("destroyed", onDestroyed);
    webContents.on("did-start-navigation", onNavigation);
    webContents.on("did-navigate", onNavigation);

    const entry: RendererEntry = {
      webContents,
      client: null,
      threads: new Map(),
      rendererOptions: new Map(),
      opening: new Map(),
      subscriptions: new Map(),
      syncing: null,
      disposed: false,
      detach: () => {
        removeWebContentsListener(webContents, "destroyed", onDestroyed);
        removeWebContentsListener(webContents, "did-start-navigation", onNavigation);
        removeWebContentsListener(webContents, "did-navigate", onNavigation);
      },
    };
    renderers.set(id, entry);
    return entry;
  }

  function snapshot(thread: AdeThread, key: string): AdeIpcThreadSnapshot {
    return {
      id: thread.id,
      key,
      title: thread.title ?? null,
      model: thread.model ?? null,
      mcpCapability: thread.mcpCapability ?? null,
      instructionsCapability: thread.instructionsCapability ?? null,
      settingSourcesCapability: thread.settingSourcesCapability ?? null,
      permissionCapability: thread.permissionCapability ?? null,
    };
  }

  /**
   * What the SDK opens a renderer's key with.
   *
   * The host hook when there is one — the renderer's options are then only
   * information. Otherwise the four fields a renderer may choose, with one log
   * line per field dropped, so a host upgrading from 0.2 can see what its
   * renderer was sending.
   */
  async function hostOpenOptions(
    client: AdeChatClient,
    key: string,
    raw: unknown,
  ): Promise<ThreadResumeOptions | undefined> {
    const rendererOptions =
      raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    if (opts.openOptions) {
      // A client without `threads.get` (a test double, a proxy) or a failed
      // read reports `exists: false`: the hook then returns full options, and
      // a resume logs the fields it ignored, as it did before 0.4.
      let summary: ThreadSummary | null = null;
      try {
        summary = typeof client.threads.get === "function" ? await client.threads.get(key) : null;
      } catch (error) {
        log(`[ade-electron] threads.open "${key}": could not read whether the key exists (${errorMessage(error)}); treating it as new`);
      }
      const context: AdeIpcOpenContext = { exists: summary !== null, summary };
      return (await opts.openOptions(key, rendererOptions, context)) ?? undefined;
    }
    const filtered = rendererOpenOptions(key, rendererOptions, log);
    if (!filtered) return undefined;
    if (typeof filtered.model === "string" && opts.allowModel && !(await opts.allowModel(key, { modelId: filtered.model }))) {
      throw unauthorized(`threads.open with model "${filtered.model}"`);
    }
    return filtered;
  }

  /**
   * Open a key for a renderer on `client`, sharing an open already in flight.
   * `raw` is what the renderer sent, kept so a client swap can resolve the
   * options again.
   */
  async function openThread(
    entry: RendererEntry,
    client: AdeChatClient,
    key: string,
    raw: unknown,
    options: ThreadResumeOptions | undefined,
  ): Promise<AdeThread> {
    const existing = entry.threads.get(key);
    if (existing) {
      // A held key still takes the hook's `refresh`: that is how a rotated MCP
      // credential reaches a live thread. The SDK applies it to the live
      // thread, skips a map it already sent, and logs (never throws) when the
      // runtime refuses it mid-turn.
      if (options?.refresh) await client.threads.open(key, { refresh: options.refresh });
      return existing;
    }
    const pending = entry.opening.get(key);
    if (pending) return pending;

    // The SDK already collapses concurrent opens of one key into one session.
    // This collapses them again on the bridge so the main side never attaches
    // two listeners to that one session and broadcasts every envelope twice.
    const started = (async () => {
      let target = client;
      let targetOptions = options;
      for (;;) {
        const thread = await (targetOptions
          ? target.threads.open(key, targetOptions)
          : target.threads.open(key));
        if (entry.disposed) return thread;
        // The host swapped its client while this open was in flight. A move
        // that ran meanwhile could not know this key yet, so it is moved
        // here: gated and resolved again for the client now in use, never
        // stored as a handle on the client that was replaced.
        const current = entry.client ?? target;
        if (current === target) {
          entry.threads.set(key, thread);
          entry.rendererOptions.set(key, raw);
          return thread;
        }
        if (allowThreadKey && !(await allowThreadKey(key))) throw unauthorized("threads.open");
        target = current;
        targetOptions = await hostOpenOptions(current, key, raw);
      }
    })().finally(() => {
      entry.opening.delete(key);
    });
    entry.opening.set(key, started);
    return started;
  }

  /** End one subscription and forget it. Safe on an id already released. */
  function releaseSubscription(entry: RendererEntry, subscriptionId: string): void {
    const subscription = entry.subscriptions.get(subscriptionId);
    if (!subscription) return;
    entry.subscriptions.delete(subscriptionId);
    try {
      subscription.stop();
    } catch (error) {
      // A client that was already disposed took its listeners with it.
      log(`[ade-electron] unsubscribe ${subscriptionId} failed: ${errorMessage(error)}`);
    }
  }

  /** Attach one main-side listener for a key's envelopes under a given id. */
  function attachThreadSubscription(
    entry: RendererEntry,
    thread: AdeThread,
    key: string,
    subscriptionId: string,
  ): void {
    // One main-side listener per key. The renderer refcounts its own
    // `on("event" | "status" | "usage")` listeners onto this one and applies
    // the channel split locally, so twenty React components still cost the
    // main process one subscription.
    const stop = thread.on("event", (envelope: AgentChatEventEnvelope) => {
      push(entry.webContents, { kind: "thread", subscriptionId, key, envelope });
    });
    entry.subscriptions.set(subscriptionId, { kind: "thread", key, stop });
  }

  function attachClientSubscription(entry: RendererEntry, client: AdeChatClient, subscriptionId: string): void {
    const stops = ADE_CLIENT_EVENTS.map((event) =>
      client.on(event, (payload) => {
        // The cast restores what `ADE_CLIENT_EVENTS.map` loses: the pairing of
        // `event` with its payload type. `client.on(event, …)` checked it.
        const message = { kind: "client", subscriptionId, event, payload } as AdeIpcEventPayload;
        // A lifecycle event names a key, and a key the gate refuses may itself
        // be private (the same rule `threads.list` follows).
        const key = event === "threadLifecycle" ? (payload as { key?: unknown }).key : undefined;
        if (!allowThreadKey || typeof key !== "string") {
          push(entry.webContents, message);
          return;
        }
        void Promise.resolve(allowThreadKey(key))
          .then((allowed) => {
            if (allowed && !entry.disposed) push(entry.webContents, message);
          })
          .catch((error: unknown) => log(`[ade-electron] allowThreadKey failed for "${key}": ${errorMessage(error)}`));
      }),
    );
    entry.subscriptions.set(subscriptionId, {
      kind: "client",
      stop: () => {
        for (const stop of stops) stop();
      },
    });
  }

  function attachProvidersSubscription(entry: RendererEntry, client: AdeChatClient, subscriptionId: string): void {
    const stop = client.providers.onChange((statuses) => {
      push(entry.webContents, { kind: "providers", subscriptionId, statuses });
    });
    entry.subscriptions.set(subscriptionId, { kind: "providers", stop });
  }

  /**
   * Bring a renderer onto the host's current client before a call runs.
   *
   * A call that arrives while a move is in progress waits for it, so it never
   * sees the half-moved state (no open threads yet) and fails with a spurious
   * `thread_not_found`.
   */
  async function syncClient(entry: RendererEntry): Promise<void> {
    while (entry.syncing) await entry.syncing;
    const client = currentClient();
    if (!disposed) watchLifecycle(client);
    if (entry.client === client) return;
    const move = moveToClient(entry, client).finally(() => {
      entry.syncing = null;
    });
    entry.syncing = move;
    await move;
  }

  /**
   * Move a renderer onto a swapped client. See {@link AdeChatClientSource}.
   *
   * Each key is authorized and its options resolved AGAIN, for the new client:
   * the old client's resolved options may carry the previous account's MCP
   * credentials, and the host's gate may no longer admit the key at all.
   */
  async function moveToClient(entry: RendererEntry, client: AdeChatClient): Promise<void> {
    const previous = entry.client;
    entry.client = client;
    if (!previous) return;
    log(`[ade-electron] the host swapped its ADE client; moving renderer ${entry.webContents.id} across`);
    const subscriptions = [...entry.subscriptions];
    for (const [subscriptionId] of subscriptions) releaseSubscription(entry, subscriptionId);
    const opened = [...entry.rendererOptions];
    entry.threads.clear();
    entry.rendererOptions.clear();
    for (const [key, raw] of opened) {
      if (entry.disposed) return;
      try {
        // Inside the `try`: a gate that throws is a refusal for this key, not
        // the end of the move for every key after it.
        if (allowThreadKey && !(await allowThreadKey(key))) {
          log(`[ade-electron] dropped "${key}" on the new client: allowThreadKey refused it; its subscriptions end`);
          continue;
        }
        await openThread(entry, client, key, raw, await hostOpenOptions(client, key, raw));
      } catch (error) {
        log(`[ade-electron] dropped "${key}" on the new client: ${errorMessage(error)}; its subscriptions end`);
      }
    }
    // A renderer that went away mid-move released nothing (the move had
    // already released it all), so anything attached now would never be
    // released and would keep the provider poll running.
    if (entry.disposed) return;
    for (const [subscriptionId, subscription] of subscriptions) {
      try {
        if (subscription.kind === "thread") {
          const thread = entry.threads.get(subscription.key);
          if (thread) attachThreadSubscription(entry, thread, subscription.key, subscriptionId);
        } else if (subscription.kind === "client") {
          attachClientSubscription(entry, client, subscriptionId);
        } else {
          attachProvidersSubscription(entry, client, subscriptionId);
        }
      } catch (error) {
        log(`[ade-electron] could not move subscription ${subscriptionId} to the new client: ${errorMessage(error)}`);
      }
    }
  }

  /** Forget a key on every renderer after the thread itself is gone. */
  function forgetKeyEverywhere(key: string): void {
    for (const entry of renderers.values()) {
      entry.threads.delete(key);
      entry.rendererOptions.delete(key);
      for (const [subscriptionId, subscription] of [...entry.subscriptions]) {
        if (subscription.kind === "thread" && subscription.key === key) releaseSubscription(entry, subscriptionId);
      }
    }
  }

  /** Tell the host one thread is gone, or archived. Never throws. */
  function notifyThreadRemoved(key: string, kind: "deleted" | "archived"): void {
    if (!opts.onThreadRemoved) return;
    try {
      opts.onThreadRemoved(key, kind);
    } catch (error) {
      // A host callback must not take down the bridge, and must not stop the
      // remaining renderers from being cleaned up.
      log(`[ade-electron] onThreadRemoved threw for "${key}": ${errorMessage(error)}`);
    }
  }

  function requireThread(entry: RendererEntry, key: string): AdeThread {
    const thread = entry.threads.get(key);
    if (!thread) {
      throw new AdeError(
        "thread_not_found",
        `This renderer has no open thread "${key}". Call threads.open first; a reload drops the bridge's handles but not the conversation.`,
      );
    }
    return thread;
  }

  /**
   * The dispatch table, typed `Record<AdeIpcMethod, …>`.
   *
   * Not `Record<string, …>`: the method list and the handler table are the two
   * halves of one contract, and typing the table against the list is what makes
   * adding a name to `ADE_IPC_METHODS` without a handler a compile error rather
   * than a renderer call that fails at run time.
   */
  const handlers: Record<
    AdeIpcMethod,
    (entry: RendererEntry, args: unknown[]) => unknown | Promise<unknown>
  > = {
    "providers.status": () => currentClient().providers.status(),
    "providers.refresh": () => currentClient().providers.refresh(),
    "providers.subscribe": (entry) => {
      const subscriptionId = nextSubscriptionId("providers");
      attachProvidersSubscription(entry, currentClient(), subscriptionId);
      const result: AdeIpcSubscription = { subscriptionId };
      return result;
    },
    "providers.unsubscribe": (entry, args) => {
      releaseSubscription(entry, requireString(args[0], "subscriptionId"));
      return null;
    },
    "models.list": () => currentClient().models.list(),
    "doctor": () => currentClient().doctor(),
    "client.subscribe": (entry) => {
      const subscriptionId = nextSubscriptionId("client");
      attachClientSubscription(entry, currentClient(), subscriptionId);
      const result: AdeIpcSubscription = { subscriptionId };
      return result;
    },
    "client.unsubscribe": (entry, args) => {
      releaseSubscription(entry, requireString(args[0], "subscriptionId"));
      return null;
    },
    "threads.open": async (entry, args) => {
      const key = requireString(args[0], "thread key");
      const client = currentClient();
      const options = await hostOpenOptions(client, key, args[1]);
      const thread = await openThread(entry, client, key, args[1], options);
      return snapshot(thread, key);
    },
    "threads.list": async () => {
      const rows: ThreadSummary[] = await currentClient().threads.list();
      // Host-wide, but not wider than the renderer may name: a key the host's
      // gate refuses would only be a row the renderer can do nothing with, and
      // its title may itself be private. A chat with no key (created outside
      // the SDK) is left out for the same reason.
      if (!allowThreadKey) return rows;
      const allowed = await Promise.all(
        rows.map(async (row) => row.key !== null && (await allowThreadKey(row.key))),
      );
      return rows.filter((_row, index) => allowed[index]);
    },
    "threads.get": (_entry, args) => {
      const key = requireString(args[0], "thread key");
      return currentClient().threads.get(key);
    },
    "threads.delete": async (_entry, args) => {
      const key = requireString(args[0], "thread key");
      await currentClient().threads.delete(key);
      // The client's `threadLifecycle` event does this too, and it is what
      // calls `onThreadRemoved`; doing the release here as well keeps a client
      // without that event (a test double) correct.
      forgetKeyEverywhere(key.trim());
      return null;
    },
    "threads.archive": async (_entry, args) => {
      const key = requireString(args[0], "thread key");
      await currentClient().threads.archive(key);
      return null;
    },
    "threads.unarchive": async (_entry, args) => {
      const key = requireString(args[0], "thread key");
      await currentClient().threads.unarchive(key);
      return null;
    },
    "thread.export": (_entry, args) => {
      const key = requireString(args[0], "thread key");
      return currentClient().exportThread(key);
    },
    "thread.update": async (entry, args) => {
      const key = requireString(args[0], "thread key");
      const patch = (args[1] ?? {}) as Record<string, unknown>;
      // Only the three documented fields cross; anything else a renderer adds
      // is not forwarded to `updateSession`, whose full argument set includes
      // permission modes a renderer must not reach.
      const safe: ThreadUpdate = {
        ...(patch.title === null || typeof patch.title === "string" ? { title: patch.title as string | null } : {}),
        ...(patch.reasoningEffort === null || typeof patch.reasoningEffort === "string"
          ? { reasoningEffort: patch.reasoningEffort as string | null }
          : {}),
        ...(typeof patch.fastMode === "boolean" ? { fastMode: patch.fastMode } : {}),
      };
      const options = (args[2] ?? undefined) as ThreadUpdateOptions | undefined;
      return requireThread(entry, key).update(safe, options?.force === true ? { force: true } : {});
    },
    "thread.retry": (entry, args) => {
      const key = requireString(args[0], "thread key");
      return requireThread(entry, key).retry();
    },
    "thread.editLast": (entry, args) => {
      const key = requireString(args[0], "thread key");
      const text = typeof args[1] === "string" ? args[1] : "";
      // Only displayText and attachments cross, validated like a send. An
      // explicit empty list crosses as one and drops the attachments.
      const { displayText, attachments } = rendererSendOptions("thread.editLast", key, args[2], log);
      return requireThread(entry, key).editLast(text, {
        ...(displayText !== undefined ? { displayText } : {}),
        ...(attachments ? { attachments } : {}),
      });
    },
    "thread.historyPage": (entry, args) => {
      const key = requireString(args[0], "thread key");
      const options = (args[1] ?? undefined) as HistoryPageOptions | undefined;
      return requireThread(entry, key).historyPage(options ?? {});
    },
    "thread.send": async (entry, args) => {
      const key = requireString(args[0], "thread key");
      const text = typeof args[1] === "string" ? args[1] : "";
      await requireThread(entry, key).send(text, rendererSendOptions("thread.send", key, args[2], log));
      return null;
    },
    "thread.steer": async (entry, args) => {
      const key = requireString(args[0], "thread key");
      const text = typeof args[1] === "string" ? args[1] : "";
      const attachments = rendererSendOptions("thread.steer", key, args[2], log).attachments;
      await requireThread(entry, key).steer(text, attachments ? { attachments } : {});
      return null;
    },
    "thread.interrupt": async (entry, args) => {
      const key = requireString(args[0], "thread key");
      await requireThread(entry, key).interrupt();
      return null;
    },
    "thread.history": (entry, args) => {
      const key = requireString(args[0], "thread key");
      const options = (args[1] ?? undefined) as { limit?: number } | undefined;
      return requireThread(entry, key).history(options);
    },
    "thread.setModel": async (entry, args) => {
      const key = requireString(args[0], "thread key");
      const modelId = requireString(args[1], "modelId");
      if (opts.allowModel && !(await opts.allowModel(key, { modelId }))) {
        throw unauthorized(`thread.setModel to "${modelId}"`);
      }
      const options = (args[2] ?? undefined) as { force?: boolean } | undefined;
      return requireThread(entry, key).setModel(modelId, options);
    },
    "thread.approve": async (entry, args) => {
      const key = requireString(args[0], "thread key");
      const itemId = requireString(args[1], "itemId");
      // Narrowed at the bridge rather than one call deeper, so the loose
      // string a renderer can send never reaches a parameter declared as a
      // three-member union. Same error code either way.
      const decision = requireApprovalDecision(args[2]);
      const responseText = typeof args[3] === "string" ? args[3] : undefined;
      await requireThread(entry, key).approve(itemId, decision, responseText);
      return null;
    },
    "thread.pendingApprovals": (entry, args) => {
      const key = requireString(args[0], "thread key");
      return requireThread(entry, key).pendingApprovals();
    },
    "thread.subscribe": (entry, args) => {
      const key = requireString(args[0], "thread key");
      const thread = requireThread(entry, key);
      const subscriptionId = nextSubscriptionId(`thread:${key}`);
      attachThreadSubscription(entry, thread, key, subscriptionId);
      const result: AdeIpcSubscription = { subscriptionId };
      return result;
    },
    "thread.unsubscribe": (entry, args) => {
      releaseSubscription(entry, requireString(args[0], "subscriptionId"));
      return null;
    },
  };

  async function dispatch(
    event: IpcMainInvokeEventLike,
    request: AdeIpcInvokeRequest,
  ): Promise<AdeIpcInvokeResponse> {
    const method = typeof request?.method === "string" ? request.method : "";
    const args = Array.isArray(request?.args) ? request.args : [];
    try {
      if (disposed) throw new AdeError("disposed", "The ADE IPC bridge has been disposed.");
      // `Object.hasOwn` rather than a bare lookup: a renderer that sends
      // `{ method: "constructor" }` must get "unknown method", not a prototype
      // member invoked with its arguments.
      if (!Object.hasOwn(handlers, method)) {
        throw new AdeError("invalid_option", `Unknown ADE bridge method "${method}".`);
      }
      // Own-property membership in the typed table is the proof that this
      // string is one of the declared methods.
      const known = method as AdeIpcMethod;
      if (opts.authorize && !(await opts.authorize(event, method, args))) {
        throw unauthorized(method);
      }
      if (allowThreadKey && ADE_IPC_THREAD_KEY_METHODS.has(known)) {
        const key = typeof args[0] === "string" ? args[0] : "";
        if (!(await allowThreadKey(key))) throw unauthorized(method);
      }
      // The gates above may have awaited. A bridge disposed, or a renderer
      // destroyed, meanwhile must not get a fresh registry entry: its
      // `destroyed` listener would never fire, and its subscriptions would leak.
      if (disposed) throw new AdeError("disposed", "The ADE IPC bridge has been disposed.");
      if (event.sender.isDestroyed()) throw new AdeError("disposed", "The renderer that made this call is gone.");
      const handler = handlers[known];
      const entry = rendererFor(event);
      // Waits out a client-swap move already in progress for this renderer.
      await syncClient(entry);
      const value = await handler(entry, args);
      return { ok: true, value: value ?? null };
    } catch (error) {
      log(`[ade-electron] ${method || "(no method)"} failed: ${errorMessage(error)}`);
      return { ok: false, error: serializeError(error) };
    }
  }

  if (typeof clientSource !== "function") watchLifecycle(clientSource);

  ipcMain.handle(invokeChannel(prefix), (event: IpcMainInvokeEventLike, payload: unknown) =>
    dispatch(event, (payload ?? {}) as AdeIpcInvokeRequest),
  );

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopWatching?.();
    stopWatching = null;
    watchedClient = null;
    ipcMain.removeHandler(invokeChannel(prefix));
    for (const id of [...renderers.keys()]) disposeRenderer(id);
  };
  return Object.assign(dispose, {
    forget: (key: string) => {
      if (typeof key === "string" && key.trim()) forgetKeyEverywhere(key.trim());
    },
  });
}
