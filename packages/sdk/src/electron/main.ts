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
 */

import { APPROVAL_DECISIONS, type ApprovalDecision } from "../approvals.js";
import { AdeError, errorMessage } from "../errors.js";
import type { AdeChatClient, ThreadOpenOptions } from "../client.js";
import type { AdeThread } from "../thread.js";
import type { AgentChatEventEnvelope, AgentChatFileRef, Unsubscribe } from "../types.js";
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
  /** Optional line logger, matching the SDK's own `logger` option. */
  logger?: (line: string) => void;
};

/** Per-renderer bookkeeping. One entry per live `webContents`. */
type RendererEntry = {
  webContents: WebContentsLike;
  /** Threads this renderer opened, by key. */
  threads: Map<string, AdeThread>;
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
 */
export function registerAdeIpc(
  ipcMain: IpcMainLike,
  client: AdeChatClient,
  opts: RegisterAdeIpcOptions = {},
): () => void {
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
      threads: new Map(),
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
      mcpCapability: thread.mcpCapability ?? null,
      instructionsCapability: thread.instructionsCapability ?? null,
      settingSourcesCapability: thread.settingSourcesCapability ?? null,
      permissionCapability: thread.permissionCapability ?? null,
    };
  }

  async function openThread(
    entry: RendererEntry,
    key: string,
    options: ThreadOpenOptions | undefined,
  ): Promise<AdeThread> {
    const existing = entry.threads.get(key);
    if (existing) return existing;
    const pending = entry.opening.get(key);
    if (pending) return pending;

    // The SDK already collapses concurrent opens of one key into one session.
    // This collapses them again on the bridge so the main side never attaches
    // two listeners to that one session and broadcasts every envelope twice.
    const started = (async () => {
      const thread = await (options
        ? client.threads.open(key, options)
        : client.threads.open(key));
      if (!entry.disposed) entry.threads.set(key, thread);
      return thread;
    })().finally(() => {
      entry.opening.delete(key);
    });
    entry.opening.set(key, started);
    return started;
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
    "providers.status": () => client.providers.status(),
    "providers.refresh": () => client.providers.refresh(),
    "providers.subscribe": (entry) => {
      const subscriptionId = nextSubscriptionId("providers");
      const unsubscribe = client.providers.onChange((statuses) => {
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
    "models.list": () => client.models.list(),
    "threads.open": async (entry, args) => {
      const key = requireString(args[0], "thread key");
      const options = (args[1] ?? undefined) as ThreadOpenOptions | undefined;
      const thread = await openThread(entry, key, options);
      return snapshot(thread, key);
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
      await requireThread(entry, key).steer(text);
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
      // One main-side listener per key. The renderer refcounts its own
      // `on("event" | "status" | "usage")` listeners onto this one and applies
      // the channel split locally, so twenty React components still cost the
      // main process one subscription.
      const unsubscribe = thread.on("event", (envelope: AgentChatEventEnvelope) => {
        push(entry.webContents, { kind: "thread", subscriptionId, key, envelope });
      });
      entry.subscriptions.set(subscriptionId, unsubscribe);
      const result: AdeIpcSubscription = { subscriptionId };
      return result;
    },
    "thread.unsubscribe": (entry, args) => {
      const subscriptionId = requireString(args[0], "subscriptionId");
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
      const value = await handler(rendererFor(event), args);
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
