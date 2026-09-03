/**
 * The host half of the plugin page bridge in the hosted web client.
 *
 * Where the desktop puts a preload behind `contextBridge` and answers in the
 * main process, this answers `postMessage` in the renderer that drew the frame.
 * The verb list is the same closed list — `PLUGIN_WEBVIEW_METHODS` — because it
 * IS the permission model: a page gets what is named there and nothing else,
 * and a method this client cannot serve is refused with a sentence rather than
 * quietly resolving.
 *
 * Three rules this file exists to keep:
 *
 * 1. **The plugin id is bound at creation.** It comes from the surface the
 *    renderer drew, never off a message. There is no `pluginId` field on the
 *    wire to ignore.
 * 2. **Every message is checked twice** — the sending window must be this
 *    guest's own `contentWindow`, and the nonce must be the one minted for it.
 *    See `pageProtocol.ts` for why neither alone is enough.
 * 3. **Every request is answered exactly once.** A verb that throws answers
 *    `ok:false` with the message; a verb this client does not serve answers
 *    `ok:false` too. A dropped request is a promise the page waits on forever,
 *    which the reader experiences as a button that does nothing.
 */

import {
  PLUGIN_WEBVIEW_BRIDGE_VERSION,
  PLUGIN_WEBVIEW_CONFIRM_BODY_MAX_CHARS,
  PLUGIN_WEBVIEW_CONFIRM_TITLE_MAX_CHARS,
  PLUGIN_WEBVIEW_CHAT_TURNS_MAX,
  PLUGIN_WEBVIEW_HOST_COALESCE_MS,
  PLUGIN_WEBVIEW_HOST_IDS_MAX,
  PLUGIN_WEBVIEW_LIST_MAX_ROWS,
  PLUGIN_WEBVIEW_TOAST_LABEL_MAX_CHARS,
  clampPluginWebviewHeight,
  PLUGIN_WEBVIEW_TOAST_MESSAGE_MAX_CHARS,
  isPluginWebviewHostKind,
  isPluginWebviewMethod,
  isPluginWebviewToastLevel,
  type PluginWebviewChatTurn,
  type PluginWebviewComposerAttach,
  type PluginWebviewConfirm,
  type PluginWebviewDialogSubmit,
  type PluginWebviewContext,
  type PluginWebviewEventName,
  type PluginWebviewHostEvent,
  type PluginWebviewHostKind,
  type PluginWebviewThemeSnapshot,
  type PluginWebviewToast,
} from "../../../shared/plugins/webviewBridge";
import type { PluginActionPrompt, PluginActionPromptAnswer } from "../../../shared/plugins/sdk";
import type { PluginSurfaceContext } from "../../../shared/plugins/context";
import {
  PLUGIN_PAGE_MAX_HOST_SUBSCRIPTIONS,
  PLUGIN_PAGE_MAX_INFLIGHT_REQUESTS,
  pluginPageEnvelope,
  readPluginPageEnvelope,
  type PluginPageBootPayload,
} from "./pageProtocol";
import type { PluginPageBundle } from "./pageAssets";
import { applyPluginPageActionAnswers } from "./pageActionResult";

/** The pieces of ADE's own UI a page may move. Supplied by the React host. */
export type PluginPageUiHandlers = {
  toast: (toast: PluginWebviewToast) => { id: string };
  dismissToast: (id: string) => void;
  prompt: (prompt: PluginActionPrompt) => Promise<PluginActionPromptAnswer | null>;
  confirm: (request: PluginWebviewConfirm) => Promise<boolean>;
  /** Close the popover, overlay or picker. A no-op in a tab, by placement. */
  closeSurface: () => void;
  composerInsert: (text: string) => boolean;
  /**
   * Attach an issue chip to the composer, or false when this client has no
   * chip target. Absent today — see the note on `composer.attach` below.
   */
  composerAttach?: (issue: PluginWebviewComposerAttach) => boolean;
  openSettings: (target: { entryId: string } | { socketId: string }) => boolean;
  openDeeplink: (url: string) => void;
  /**
   * Hand a `dialog-picker` guest's chosen issue to the dialog drawing it.
   *
   * Three outcomes rather than a boolean, and the page hears a different
   * sentence for each: the dialog took it, the dialog turned it down, or no
   * dialog is listening on this guest at all. Absent on a client with no
   * dialog store — the verb is then refused rather than resolving quietly.
   */
  dialogSubmit?: (answer: PluginWebviewDialogSubmit) => "applied" | "refused" | "unlistened";
  /**
   * Content height of a size-to-content guest, already capped by the host.
   *
   * Honoured in `settings-section` and `dialog-picker` — the two placements
   * that sit inside a taller ADE surface. Every other placement fills a frame
   * the host already sized, and the React host drops the report there.
   */
  resize?: (height: number) => void;
};

/** The plugin data plane. Defaults ride `window.ade.plugin`; tests inject fakes. */
export type PluginPageDataHandlers = {
  invoke: (action: string, args: Record<string, unknown>) => Promise<unknown>;
  collectionsGet: (collection: string, key: string) => Promise<unknown>;
  collectionsList: (
    collection: string,
    options: { keyPrefix?: string; limit?: number; after?: string },
  ) => Promise<{ key: string; value: unknown }[]>;
  collectionsPut?: (collection: string, key: string, value: unknown) => Promise<void>;
  configGet: () => Promise<Record<string, unknown>>;
  configSet: (values: Record<string, string | number | boolean | null>) => Promise<Record<string, unknown>>;
};

export type PluginPageHostOptions = {
  /**
   * The window messages must come from — the guest frame's `contentWindow`,
   * read on EVERY message rather than captured once.
   *
   * It has to be a function, and the reason is a race that a captured window
   * loses: the guest posts its first request while its bootstrap runs, which is
   * before the frame's `load` event and therefore before any code that waited
   * for `load` could have a window to capture. So the host is built and
   * listening BEFORE the frame is navigated, when `contentWindow` is still the
   * blank document's. Reading it per message also means a frame that navigates
   * again is compared against what it is now, not what it was.
   */
  guestWindow: () => Window | null;
  /** Where messages are listened for. The app's own window. */
  hostWindow: Pick<Window, "addEventListener" | "removeEventListener">;
  nonce: string;
  pluginId: string;
  context: PluginWebviewContext;
  bundle: PluginPageBundle;
  theme: () => PluginWebviewThemeSnapshot | null;
  ui: PluginPageUiHandlers;
  data: PluginPageDataHandlers;
  clipboard?: Pick<Clipboard, "readText" | "writeText">;
  /** Live host entities. Returns an unsubscribe. */
  subscribeHostEntities?: (kinds: PluginWebviewHostKind[], deliver: (event: PluginWebviewHostEvent) => void) => () => void;
  /** Milliseconds; the host-event coalescing window. Injected only by tests. */
  coalesceMs?: number;
};

export type PluginPageHost = {
  /** Push a `theme`, `changed` or `host` frame into the guest. */
  publish: (event: PluginWebviewEventName, payload: unknown) => void;
  /** True once the guest has taken its bytes. */
  readonly booted: boolean;
  dispose: () => void;
};

/**
 * The subject a control-flow verb is applied against.
 *
 * A page mounted on a chat carries that chat; a full tab carries nothing, and
 * `applyPluginComposerEdit` falls back to the composer on screen exactly as it
 * does for a socket press from a surface with no subject.
 */
function subjectOf(context: PluginWebviewContext): PluginSurfaceContext | null {
  return context.subject ?? null;
}

export function createPluginPageHost(options: PluginPageHostOptions): PluginPageHost {
  const { guestWindow, hostWindow, nonce, pluginId } = options;
  let disposed = false;
  let booted = false;
  let inflight = 0;
  const hostSubscriptions = new Map<string, () => void>();

  const send = (body: Record<string, unknown>): void => {
    if (disposed) return;
    const view = guestWindow();
    if (!view) return;
    // `"*"` is forced by the guest's opaque origin: there is no origin string
    // that names it. The frame is one this host created and holds the only
    // reference to, and the payload is that plugin's own data, so the target
    // set is exactly one window either way.
    view.postMessage(pluginPageEnvelope(nonce, body), "*");
  };

  const answer = (id: number, value: unknown): void => send({ kind: "response", id, ok: true, value });
  const refuse = (id: number, message: string): void => send({ kind: "response", id, ok: false, message });

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    if (!event.source || event.source !== guestWindow()) return;
    const message = readPluginPageEnvelope(event.data, nonce);
    if (!message) return;
    if (message.kind === "ready") return;
    if (message.kind === "resize") {
      // The SHARED clamp, so a settings section is the same height on desktop
      // and on web. Null means the page said nothing usable, which is different
      // from asking to be invisible and is dropped rather than applied as zero.
      const height = clampPluginWebviewHeight(message.height);
      if (height !== null) options.ui.resize?.(height);
      return;
    }
    if (message.kind !== "request") return;
    const id = typeof message.id === "number" ? message.id : null;
    if (id === null) return;
    const method = message.method;
    const params = (message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params
      : {}) as Record<string, unknown>;

    if (inflight >= PLUGIN_PAGE_MAX_INFLIGHT_REQUESTS) {
      refuse(id, "Too many requests in flight.");
      return;
    }
    if (method !== "page.boot" && !isPluginWebviewMethod(method)) {
      refuse(id, "That method isn’t part of the bridge.");
      return;
    }
    inflight += 1;
    void dispatch(String(method), params)
      .then((value) => answer(id, value))
      .catch((error: unknown) => refuse(id, errorMessage(error)))
      .finally(() => {
        inflight -= 1;
      });
  };

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "page.boot":
        return boot();
      case "collections.get":
        return options.data.collectionsGet(stringArg(params.collection), stringArg(params.key));
      case "collections.list": {
        const limit = typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.min(PLUGIN_WEBVIEW_LIST_MAX_ROWS, Math.trunc(params.limit)))
          : PLUGIN_WEBVIEW_LIST_MAX_ROWS;
        return options.data.collectionsList(stringArg(params.collection), {
          ...(typeof params.keyPrefix === "string" ? { keyPrefix: params.keyPrefix } : {}),
          ...(typeof params.after === "string" ? { after: params.after } : {}),
          limit,
        });
      }
      case "collections.put": {
        const put = options.data.collectionsPut;
        // Absent rather than failing silently. The sync transport has no
        // generic collection write — a browser peer reads rows out of the panel
        // snapshots it already subscribed to — so a page that writes must say
        // so to the reader instead of dropping the row on the floor. See the
        // `plugin.collections.put` dependency in the platform report.
        if (!put) throw new Error("This client can’t save plugin data yet.");
        await put(stringArg(params.collection), stringArg(params.key), params.value);
        return undefined;
      }
      case "config.get":
        return options.data.configGet();
      case "config.set": {
        const values = typeof params.key === "string"
          ? { [params.key]: params.value as string | number | boolean | null }
          : (params.values as Record<string, string | number | boolean | null>);
        if (!values || typeof values !== "object") throw new Error("That setting isn’t writable.");
        return options.data.configSet(values);
      }
      case "invoke":
        return invoke(stringArg(params.action), asRecord(params.args));
      case "openDeeplink": {
        const url = stringArg(params.url);
        if (!isOpenableUrl(url)) throw new Error("That link can’t be opened from a plugin page.");
        options.ui.openDeeplink(url);
        return undefined;
      }
      case "openSettings": {
        const target = readSettingsTarget(params.target);
        if (!target) throw new Error("That settings destination isn’t one this page may open.");
        if (!options.ui.openSettings(target)) throw new Error("That settings page isn’t available here.");
        return undefined;
      }
      case "surface.close":
        options.ui.closeSurface();
        return undefined;
      case "dialog.submit": {
        // Placement first, and it is the host's own word about where it drew
        // this guest — never the page's claim. A tab that could name the issue
        // for a dialog nobody opened would be writing into a form the reader is
        // not looking at, which is why the contract refuses it everywhere else.
        if (options.context.placement !== "dialog-picker") {
          throw new Error("Only a page drawn inside a dialog can answer it.");
        }
        const answer = readDialogSubmit(params);
        if (!answer) throw new Error("That issue can’t be handed to the dialog.");
        const submit = options.ui.dialogSubmit;
        if (!submit) throw new Error("This client can’t answer a dialog from a page yet.");
        const verdict = submit(answer);
        if (verdict === "unlistened") throw new Error("That dialog isn’t open any more.");
        if (verdict === "refused") throw new Error("The dialog didn’t accept that issue.");
        return undefined;
      }
      case "composer.insert": {
        const text = stringArg(params.text);
        if (!text) throw new Error("There was nothing to insert.");
        if (!options.ui.composerInsert(text)) throw new Error("There’s no composer on screen to write into.");
        return undefined;
      }
      case "composer.attach": {
        const issue = readComposerAttach(params.issue);
        if (!issue) throw new Error("That issue can’t be attached.");
        const attach = options.ui.composerAttach;
        if (!attach) throw new Error("This client can’t attach an issue chip yet.");
        if (!attach(issue)) throw new Error("There’s no composer on screen to attach to.");
        return undefined;
      }
      case "ui.toast": {
        const toast = readToast(params.toast);
        if (!toast) throw new Error("That notice couldn’t be shown.");
        return options.ui.toast(toast);
      }
      case "ui.dismissToast":
        options.ui.dismissToast(stringArg(params.id));
        return undefined;
      case "ui.prompt": {
        const prompt = params.prompt;
        if (!prompt || typeof prompt !== "object") throw new Error("That question couldn’t be asked.");
        return options.ui.prompt(prompt as PluginActionPrompt);
      }
      case "ui.confirm": {
        const request = readConfirm(params.confirm);
        if (!request) throw new Error("That question couldn’t be asked.");
        return options.ui.confirm(request);
      }
      case "clipboard.read": {
        const clipboard = options.clipboard;
        if (!clipboard) throw new Error("The clipboard isn’t readable here.");
        return clipboard.readText();
      }
      case "clipboard.write": {
        const clipboard = options.clipboard;
        if (!clipboard) throw new Error("The clipboard isn’t writable here.");
        await clipboard.writeText(stringArg(params.text));
        return undefined;
      }
      case "theme.get":
        return options.theme() ?? { scheme: "dark", tokens: {} };
      case "host.subscribe":
        return subscribeHost(params.kinds);
      case "host.unsubscribe": {
        const token = stringArg(params.token);
        const stop = hostSubscriptions.get(token);
        if (stop) {
          stop();
          hostSubscriptions.delete(token);
        }
        return undefined;
      }
      default:
        throw new Error("That method isn’t part of the bridge.");
    }
  }

  function boot(): PluginPageBootPayload {
    booted = true;
    return {
      bridgeVersion: PLUGIN_WEBVIEW_BRIDGE_VERSION,
      pluginId,
      context: options.context,
      theme: options.theme(),
      entry: options.bundle.entry,
      files: options.bundle.files.map((file) => ({
        path: file.path,
        mime: file.mime,
        // A copy, so the guest cannot hold a view onto a buffer this client
        // still reads from, and so a detached buffer cannot break a second boot
        // after a reload.
        bytes: file.bytes.slice().buffer as ArrayBuffer,
      })),
    };
  }

  /**
   * The page's own action, with the socket path's answers applied.
   *
   * One prompt hop, exactly as the desktop does it: the question is asked, the
   * action is re-invoked once carrying the answer, and the page's promise
   * resolves with the SECOND result — what the handler finally returned, not
   * the question it asked on the way.
   */
  async function invoke(action: string, args: Record<string, unknown>): Promise<unknown> {
    if (!action) throw new Error("That action has no name.");
    const context = subjectOf(options.context);
    const result = await options.data.invoke(action, args);
    const { prompt } = applyPluginPageActionAnswers(result, {
      pluginId,
      actionId: action,
      context,
      answeringPrompt: args.prompt !== undefined,
    });
    if (!prompt) return result;
    const answered = await options.ui.prompt(prompt);
    if (!answered) return result;
    const second = await options.data.invoke(action, { ...args, prompt: answered });
    applyPluginPageActionAnswers(second, { pluginId, actionId: action, context, answeringPrompt: true });
    return second;
  }

  function subscribeHost(rawKinds: unknown): string {
    const subscribe = options.subscribeHostEntities;
    if (!subscribe) throw new Error("Live updates aren’t available here.");
    if (hostSubscriptions.size >= PLUGIN_PAGE_MAX_HOST_SUBSCRIPTIONS) {
      throw new Error("Too many live subscriptions.");
    }
    const kinds = (Array.isArray(rawKinds) ? rawKinds : []).filter(isPluginWebviewHostKind);
    if (kinds.length === 0) throw new Error("Name at least one kind to follow.");
    const token = `host-${hostSubscriptions.size}-${Date.now()}`;
    const coalesced = coalesceHostEvents(
      (event) => send({ kind: "event", event: "host", payload: event }),
      options.coalesceMs ?? PLUGIN_WEBVIEW_HOST_COALESCE_MS,
    );
    const stop = subscribe(kinds, coalesced.deliver);
    hostSubscriptions.set(token, () => {
      coalesced.cancel();
      stop();
    });
    return token;
  }

  hostWindow.addEventListener("message", onMessage as EventListener);

  return {
    publish(event, payload) {
      send({ kind: "event", event, payload });
    },
    get booted() {
      return booted;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      hostWindow.removeEventListener("message", onMessage as EventListener);
      for (const stop of hostSubscriptions.values()) stop();
      hostSubscriptions.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Argument readers. Every one of these is reading a message an untrusted page
// wrote, so each returns null rather than repairing what it was given.
// ---------------------------------------------------------------------------

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "That didn’t work.";
}

/**
 * `ade:` deeplinks and real web links, and nothing else.
 *
 * `http:` alongside `https:` because a plugin's own dev server is an ordinary
 * thing to link to, exactly as the desktop bridge allows. `javascript:`,
 * `file:`, `data:` and `blob:` are the four a page would reach for to run
 * something in the app's own origin, and none of them is on this list.
 */
function isOpenableUrl(raw: string): boolean {
  try {
    const scheme = new URL(raw).protocol;
    return scheme === "ade:" || scheme === "https:" || scheme === "http:";
  } catch {
    return false;
  }
}

function readSettingsTarget(value: unknown): { entryId: string } | { socketId: string } | null {
  const record = asRecord(value);
  if (typeof record.entryId === "string" && record.entryId) return { entryId: record.entryId };
  if (typeof record.socketId === "string" && record.socketId) return { socketId: record.socketId };
  return null;
}

function readToast(value: unknown): PluginWebviewToast | null {
  const record = asRecord(value);
  if (!isPluginWebviewToastLevel(record.level)) return null;
  const message = typeof record.message === "string" ? record.message.slice(0, PLUGIN_WEBVIEW_TOAST_MESSAGE_MAX_CHARS) : "";
  if (!message) return null;
  const actionLabel = typeof record.actionLabel === "string"
    ? record.actionLabel.slice(0, PLUGIN_WEBVIEW_TOAST_LABEL_MAX_CHARS)
    : undefined;
  const actionId = typeof record.actionId === "string" ? record.actionId : undefined;
  return {
    level: record.level,
    message,
    ...(actionLabel ? { actionLabel } : {}),
    ...(actionId ? { actionId } : {}),
  };
}

function readConfirm(value: unknown): PluginWebviewConfirm | null {
  const record = asRecord(value);
  const title = typeof record.title === "string" ? record.title.slice(0, PLUGIN_WEBVIEW_CONFIRM_TITLE_MAX_CHARS) : "";
  if (!title) return null;
  const body = typeof record.body === "string" ? record.body.slice(0, PLUGIN_WEBVIEW_CONFIRM_BODY_MAX_CHARS) : undefined;
  return {
    title,
    ...(body ? { body } : {}),
    ...(typeof record.confirmLabel === "string" ? { confirmLabel: record.confirmLabel.slice(0, 40) } : {}),
    ...(typeof record.cancelLabel === "string" ? { cancelLabel: record.cancelLabel.slice(0, 40) } : {}),
    ...(record.destructive === true ? { destructive: true } : {}),
  };
}

/**
 * A `dialog.submit` payload, in the shape main's own bridge server reads it.
 *
 * `{issue}` at the top level of `params`, not nested under an `answer` key, so
 * one page calls one verb the same way on both clients. `issue: null` is a real
 * answer — the reader cleared the selection — and is distinguished from a
 * malformed record, which is refused.
 */
function readDialogSubmit(params: Record<string, unknown>): PluginWebviewDialogSubmit | null {
  if (params.issue === null) return { issue: null };
  const issue = readComposerAttach(params.issue);
  return issue ? { issue } : null;
}

function readComposerAttach(value: unknown): PluginWebviewComposerAttach | null {
  const record = asRecord(value);
  const provider = stringArg(record.provider);
  const issueId = stringArg(record.issueId);
  const identifier = stringArg(record.identifier);
  if (!provider || !issueId || !identifier) return null;
  return {
    provider,
    issueId,
    identifier,
    title: stringArg(record.title),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
  };
}

/**
 * Gather entity changes for a moment, then send the union.
 *
 * A rebase moves a dozen lanes in a few milliseconds. Delivered raw that is a
 * dozen wake-ups of a frame that will redraw once either way, so the frames are
 * merged on the same budget the desktop relay uses. Past
 * `PLUGIN_WEBVIEW_HOST_IDS_MAX` the frame says `overflow` and the page refetches
 * the family rather than patching the ids it happened to be handed.
 */
export function coalesceHostEvents(
  emit: (event: PluginWebviewHostEvent) => void,
  windowMs: number,
): { deliver: (event: PluginWebviewHostEvent) => void; cancel: () => void } {
  const pending = new Map<
    PluginWebviewHostKind,
    { ids: Set<string>; overflow: boolean; turns: Map<string, PluginWebviewChatTurn> }
  >();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    for (const [kind, entry] of pending) {
      const turns = [...entry.turns.values()];
      emit({
        kind,
        ids: [...entry.ids],
        overflow: entry.overflow,
        ...(turns.length > 0 ? { turns } : {}),
      });
    }
    pending.clear();
  };

  return {
    deliver(event) {
      const entry = pending.get(event.kind)
        ?? { ids: new Set<string>(), overflow: false, turns: new Map<string, PluginWebviewChatTurn>() };
      for (const id of event.ids) {
        if (entry.ids.size >= PLUGIN_WEBVIEW_HOST_IDS_MAX) {
          entry.overflow = true;
          break;
        }
        entry.ids.add(id);
      }
      // Last state wins, per turn. Within one coalescing window a turn can go
      // started → failed, and the page must be told where it ENDED up: sending
      // both would have it draw a spinner it then has to unwind, and sending
      // the first would leave a dead turn drawn as running. Keyed by session
      // and turn together so two turns of one session do not overwrite one
      // another.
      for (const turn of event.turns ?? []) {
        const key = `${turn.sessionId}\u0000${turn.turnId ?? ""}`;
        if (!entry.turns.has(key) && entry.turns.size >= PLUGIN_WEBVIEW_CHAT_TURNS_MAX) {
          // Past the cap the frame stops carrying turns and says so: the page
          // refetches the sessions it watches rather than patching a partial
          // list it cannot tell is partial.
          entry.overflow = true;
          continue;
        }
        entry.turns.set(key, turn);
      }
      if (event.overflow) entry.overflow = true;
      pending.set(event.kind, entry);
      if (timer === null) timer = setTimeout(flush, windowMs);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
