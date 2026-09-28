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
import type {
  AdeChatClient,
  AdeClientEvent,
  ThreadOpenOptions,
  ThreadResumeOptions,
} from "../client.js";
import type { AdeThread, HistoryPageOptions, ThreadUpdate, ThreadUpdateOptions } from "../thread.js";
import type { AgentChatEventEnvelope, AgentChatFileRef, ThreadSummary, Unsubscribe } from "../types.js";
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
   */
  allowThreadKey?: (key: string) => boolean;
  /**
   * The host decides how a thread is opened. Recommended for every host.
   *
   * Called for every renderer `threads.open`, with the key and whatever
   * options the renderer sent (for reading, never for trusting). Its result is
   * what the SDK opens with, and the renderer's options are ignored entirely.
   * Return undefined to reopen a key with its stored record and no options —
   * which fails with `invalid_option` for a key this home has never seen.
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
   * meant to offer.
   */
  allowModel?: (key: string, selection: { modelId: string }) => boolean;
  /** Optional line logger, matching the SDK's own `logger` option. */
  logger?: (line: string) => void;
};

/** The renderer `threads.open` fields the bridge forwards without an `openOptions` hook. */
export const ADE_IPC_RENDERER_OPEN_FIELDS = ["provider", "model", "title", "reasoningEffort"] as const;

/**
 * The client a bridge serves, or a function returning the current one.
 *
 * The function form is for a host that replaces its client — one per signed-in
 * account, disposed on sign-out. The bridge re-reads it on every call, and on
 * the first call after it changed it re-opens each renderer's threads on the
 * new client and moves their subscriptions across under the same ids, so the
 * renderer notices nothing. Events a replaced client would have pushed between
 * the swap and that first call are not replayed. A client with `autoRestart`
 * never changes identity and needs none of this.
 */
export type AdeChatClientSource = AdeChatClient | (() => AdeChatClient);

/** Per-renderer bookkeeping. One entry per live `webContents`. */
type RendererEntry = {
  webContents: WebContentsLike;
  /** The client this renderer's handles were opened on. */
  client: AdeChatClient | null;
  /** Threads this renderer opened, by key. */
  threads: Map<string, AdeThread>;
  /** The options each key was opened with, so a client swap can reopen it. */
  openedWith: Map<string, ThreadResumeOptions | undefined>;
  /** Thread-event subscriptions by id → key, so a client swap can move them. */
  threadSubscriptions: Map<string, string>;
  /** Client-event subscription ids, moved across a client swap likewise. */
  clientSubscriptions: Set<string>;
  /** In-flight opens, so two overlapping opens of one key share a subscription. */
  opening: Map<string, Promise<AdeThread>>;
  /** Live subscriptions, by the id the renderer holds. */
  subscriptions: Map<string, Unsubscribe>;
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
 * runtime.
 *
 * `clientSource` is the client, or a function returning the current one — see
 * {@link AdeChatClientSource} for what a swap does.
 */
export function registerAdeIpc(
  ipcMain: IpcMainLike,
  clientSource: AdeChatClientSource,
  opts: RegisterAdeIpcOptions = {},
): () => void {
  const currentClient = (): AdeChatClient => {
    const client = typeof clientSource === "function" ? clientSource() : clientSource;
    if (!client || typeof client !== "object" || !client.threads) {
      throw new AdeError("disposed", "The host has no ADE chat client to serve this call.");
    }
    return client;
  };
  const prefix = opts.channelPrefix?.trim() || ADE_DEFAULT_CHANNEL_PREFIX;
  const log = opts.logger ?? (() => {});
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
    for (const unsubscribe of entry.subscriptions.values()) {
      try {
        unsubscribe();
      } catch (error) {
        log(`[ade-electron] unsubscribe failed: ${errorMessage(error)}`);
      }
    }
    entry.subscriptions.clear();
    entry.threads.clear();
    entry.opening.clear();
    entry.openedWith.clear();
    entry.threadSubscriptions.clear();
    entry.clientSubscriptions.clear();
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
      openedWith: new Map(),
      threadSubscriptions: new Map(),
      clientSubscriptions: new Set(),
      opening: new Map(),
      subscriptions: new Map(),
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
    key: string,
    raw: unknown,
  ): Promise<ThreadResumeOptions | undefined> {
    const rendererOptions =
      raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    if (opts.openOptions) return (await opts.openOptions(key, rendererOptions)) ?? undefined;
    if (!rendererOptions) return undefined;
    const allowed = new Set<string>(ADE_IPC_RENDERER_OPEN_FIELDS);
    const filtered: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(rendererOptions)) {
      if (value === undefined) continue;
      if (!allowed.has(field)) {
        log(
          `[ade-electron] threads.open "${key}": dropped renderer option "${field}"; ` +
            `only ${ADE_IPC_RENDERER_OPEN_FIELDS.join(", ")} cross the bridge. Use the openOptions hook to configure threads.`,
        );
        continue;
      }
      if (typeof value !== "string") {
        log(`[ade-electron] threads.open "${key}": dropped renderer option "${field}" (not a string)`);
        continue;
      }
      filtered[field] = value;
    }
    if (typeof filtered.model === "string" && opts.allowModel && !opts.allowModel(key, { modelId: filtered.model })) {
      throw unauthorized(`threads.open with model "${filtered.model}"`);
    }
    return Object.keys(filtered).length > 0 ? (filtered as ThreadResumeOptions) : undefined;
  }

  async function openThread(
    entry: RendererEntry,
    key: string,
    options: ThreadResumeOptions | undefined,
  ): Promise<AdeThread> {
    const existing = entry.threads.get(key);
    if (existing) return existing;
    const pending = entry.opening.get(key);
    if (pending) return pending;

    const client = currentClient();
    // The SDK already collapses concurrent opens of one key into one session.
    // This collapses them again on the bridge so the main side never attaches
    // two listeners to that one session and broadcasts every envelope twice.
    const started = (async () => {
      const thread = await (options
        ? client.threads.open(key, options)
        : client.threads.open(key));
      if (!entry.disposed) {
        entry.threads.set(key, thread);
        entry.openedWith.set(key, options);
      }
      return thread;
    })().finally(() => {
      entry.opening.delete(key);
    });
    entry.opening.set(key, started);
    return started;
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
    const unsubscribe = thread.on("event", (envelope: AgentChatEventEnvelope) => {
      push(entry.webContents, { kind: "thread", subscriptionId, key, envelope });
    });
    entry.subscriptions.set(subscriptionId, unsubscribe);
    entry.threadSubscriptions.set(subscriptionId, key);
  }

  function attachClientSubscription(entry: RendererEntry, client: AdeChatClient, subscriptionId: string): void {
    const events: AdeClientEvent[] = ["exit", "transport", "restart"];
    const stops = events.map((event) =>
      client.on(event, (payload: unknown) => {
        push(entry.webContents, { kind: "client", subscriptionId, event, payload });
      }),
    );
    entry.subscriptions.set(subscriptionId, () => {
      for (const stop of stops) stop();
    });
    entry.clientSubscriptions.add(subscriptionId);
  }

  /**
   * Move a renderer onto the host's current client, when it changed.
   *
   * Every thread the renderer had open is reopened on the new client with the
   * options it was opened with, and every subscription is re-attached under the
   * SAME id, so the renderer's handles keep working. A key the new client
   * cannot open is dropped and its subscription released; the renderer's next
   * call on it gets `thread_not_found`.
   */
  async function syncClient(entry: RendererEntry): Promise<void> {
    const client = currentClient();
    if (entry.client === client) return;
    const previous = entry.client;
    entry.client = client;
    if (!previous) return;
    log(`[ade-electron] the host swapped its ADE client; moving renderer ${entry.webContents.id} across`);
    const threadSubscriptions = [...entry.threadSubscriptions];
    const clientSubscriptions = [...entry.clientSubscriptions];
    for (const unsubscribe of entry.subscriptions.values()) {
      try {
        unsubscribe();
      } catch {
        // The old client may already be disposed; its listeners died with it.
      }
    }
    entry.subscriptions.clear();
    entry.threadSubscriptions.clear();
    entry.clientSubscriptions.clear();
    const openedWith = new Map(entry.openedWith);
    entry.threads.clear();
    entry.openedWith.clear();
    for (const [key, options] of openedWith) {
      try {
        await openThread(entry, key, options);
      } catch (error) {
        log(`[ade-electron] could not reopen "${key}" on the new client: ${errorMessage(error)}`);
      }
    }
    for (const [subscriptionId, key] of threadSubscriptions) {
      const thread = entry.threads.get(key);
      if (thread) attachThreadSubscription(entry, thread, key, subscriptionId);
    }
    for (const subscriptionId of clientSubscriptions) attachClientSubscription(entry, client, subscriptionId);
  }

  /** Forget a key on every renderer after the thread itself is gone. */
  function forgetKeyEverywhere(key: string): void {
    for (const entry of renderers.values()) {
      entry.threads.delete(key);
      entry.openedWith.delete(key);
      for (const [subscriptionId, subscribedKey] of [...entry.threadSubscriptions]) {
        if (subscribedKey !== key) continue;
        entry.threadSubscriptions.delete(subscriptionId);
        const unsubscribe = entry.subscriptions.get(subscriptionId);
        entry.subscriptions.delete(subscriptionId);
        try {
          unsubscribe?.();
        } catch {
          // Already released.
        }
      }
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
      const unsubscribe = currentClient().providers.onChange((statuses) => {
        push(entry.webContents, { kind: "providers", subscriptionId, statuses });
      });
      entry.subscriptions.set(subscriptionId, unsubscribe);
      const result: AdeIpcSubscription = { subscriptionId };
      return result;
    },
    "providers.unsubscribe": (entry, args) => {
      const subscriptionId = requireString(args[0], "subscriptionId");
      const unsubscribe = entry.subscriptions.get(subscriptionId);
      if (unsubscribe) {
        entry.subscriptions.delete(subscriptionId);
        unsubscribe();
      }
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
      const subscriptionId = requireString(args[0], "subscriptionId");
      const unsubscribe = entry.subscriptions.get(subscriptionId);
      entry.clientSubscriptions.delete(subscriptionId);
      if (unsubscribe) {
        entry.subscriptions.delete(subscriptionId);
        unsubscribe();
      }
      return null;
    },
    "threads.open": async (entry, args) => {
      const key = requireString(args[0], "thread key");
      const options = await hostOpenOptions(key, args[1]);
      const thread = await openThread(entry, key, options);
      return snapshot(thread, key);
    },
    "threads.list": async () => {
      const rows: ThreadSummary[] = await currentClient().threads.list();
      // Host-wide, but not wider than the renderer may name: a key the host's
      // gate refuses would only be a row the renderer can do nothing with, and
      // its title may itself be private. A chat with no key (created outside
      // the SDK) is left out for the same reason.
      if (!opts.allowThreadKey) return rows;
      return rows.filter((row) => row.key !== null && opts.allowThreadKey!(row.key));
    },
    "threads.delete": async (_entry, args) => {
      const key = requireString(args[0], "thread key");
      await currentClient().threads.delete(key);
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
    "thread.historyPage": (entry, args) => {
      const key = requireString(args[0], "thread key");
      const options = (args[1] ?? undefined) as HistoryPageOptions | undefined;
      return requireThread(entry, key).historyPage(options ?? {});
    },
    "thread.send": async (entry, args) => {
      const key = requireString(args[0], "thread key");
      const text = typeof args[1] === "string" ? args[1] : "";
      const options = (args[2] ?? undefined) as
        | { attachments?: AgentChatFileRef[]; displayText?: string; reasoningEffort?: string | null }
        | undefined;
      await requireThread(entry, key).send(text, options);
      return null;
    },
    "thread.steer": async (entry, args) => {
      const key = requireString(args[0], "thread key");
      const text = typeof args[1] === "string" ? args[1] : "";
      const options = (args[2] ?? undefined) as { attachments?: AgentChatFileRef[] } | undefined;
      await requireThread(entry, key).steer(
        text,
        Array.isArray(options?.attachments) ? { attachments: options.attachments } : {},
      );
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
    "thread.setModel": (entry, args) => {
      const key = requireString(args[0], "thread key");
      const modelId = requireString(args[1], "modelId");
      if (opts.allowModel && !opts.allowModel(key, { modelId })) {
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
      const subscriptionId = requireString(args[0], "subscriptionId");
      entry.threadSubscriptions.delete(subscriptionId);
      const unsubscribe = entry.subscriptions.get(subscriptionId);
      if (unsubscribe) {
        entry.subscriptions.delete(subscriptionId);
        unsubscribe();
      }
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
      if (opts.allowThreadKey && ADE_IPC_THREAD_KEY_METHODS.has(known)) {
        const key = typeof args[0] === "string" ? args[0] : "";
        if (!opts.allowThreadKey(key)) throw unauthorized(method);
      }
      const handler = handlers[known];
      const entry = rendererFor(event);
      await syncClient(entry);
      const value = await handler(entry, args);
      return { ok: true, value: value ?? null };
    } catch (error) {
      log(`[ade-electron] ${method || "(no method)"} failed: ${errorMessage(error)}`);
      return { ok: false, error: serializeError(error) };
    }
  }

  ipcMain.handle(invokeChannel(prefix), (event: IpcMainInvokeEventLike, payload: unknown) =>
    dispatch(event, (payload ?? {}) as AdeIpcInvokeRequest),
  );

  return () => {
    if (disposed) return;
    disposed = true;
    ipcMain.removeHandler(invokeChannel(prefix));
    for (const id of [...renderers.keys()]) disposeRenderer(id);
  };
}
