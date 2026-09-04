import {
  isPluginWebviewUiVerb,
  sanitizePluginWebviewEngineRect,
  sanitizePluginWebviewPageError,
  type PluginWebviewComposerAttach,
  type PluginWebviewConfirm,
  type PluginWebviewDialogSubmit,
  type PluginWebviewToast,
  type PluginWebviewUiRequest,
  type PluginWebviewUiResponse,
} from "../../../../shared/plugins/webviewBridge";
import { placeHostEngine, releaseHostEngine } from "../hostEngine/hostEngineStore";
import { invokePluginSocketAction } from "./contributionBridge";
import { recordPluginWebviewPageError } from "./pluginWebviewPageErrorStore";
import { findPluginWebviewSocket, listPluginWebviewSockets } from "./pluginWebviewSockets";
import type { PluginActionPrompt } from "../../../../shared/plugins/sdk";
import {
  buildPluginActionPromptAnswer,
  hasPluginActionWebviewRequest,
  readPluginActionComposerEdit,
  readPluginActionNavigation,
  readPluginActionWebview,
} from "../../../../shared/plugins/sdk";
import { dismissToast, showToast, type ToastTone } from "../../app/toast/toastStore";
import { applyPluginActionOpenSettings } from "../pluginActionOpenSettings";
import { showPluginActionMessage } from "../pluginActionToast";
import { rootAppStoreApi } from "../../../state/appStore";
import { applyPluginComposerEdit } from "./composerTarget";
import { applyPluginDialogEdit } from "./dialogTarget";
import { submitPluginWebviewDialogAnswer } from "./pluginWebviewDialogStore";
import { applyPluginActionNavigation, openPluginActionWebview } from "./pluginActionDispatch";
import { closePluginWebviewGuest, getPluginWebviewGuest } from "./pluginWebviewGuestRegistry";
import { openPluginWebviewConfirm } from "./pluginWebviewConfirmStore";
import { getPluginWebviewPopover } from "./pluginWebviewPopoverStore";
import { pickPluginWebviewUi } from "./pluginWebviewPickerStore";
import {
  closePluginPrompt,
  getPluginPrompt,
  openPluginPrompt,
  subscribePluginPrompt,
} from "./pluginPromptStore";

/**
 * The renderer half of the plugin-page relay.
 *
 * Main owns every question of permission — who asked, whether that guest's
 * surface is on screen, how long the page may wait. What is left over is the
 * part only this window can do: move a piece of ADE's own UI. This module is
 * that part, and it is deliberately a router over the appliers the SOCKET path
 * already uses rather than a second implementation of any of them. A page's
 * `composer.attach` reaches the same composer a `composer-action`'s
 * `{composer}` answer reaches, through the same function, so the two can never
 * drift into honouring different rules about which composer is meant.
 *
 * ## The one rule that is not negotiable
 *
 * EVERY request is answered exactly once. A verb this build does not know, a
 * guest that has already gone, an applier that refused — all of them answer
 * `{ ok: false, message }`. Nothing is dropped. On the other end of every
 * request is a page holding a promise, and main will hold it for ten seconds
 * (ten minutes for a question) before it rejects — which the reader experiences
 * as a button that did nothing for ten seconds and then complained.
 *
 * That is why {@link handlePluginWebviewUiRequest} returns a response rather
 * than sending one, and why {@link installPluginWebviewRelay} wraps the call in
 * a try/catch that still answers: a throw inside an applier must become a
 * refusal the page can read, not a promise nobody settles.
 */

/** The bridge members this module needs. See `preload/pluginBridge.ts`. */
export type PluginWebviewRelayBridge = {
  onUiRequest: (cb: (request: unknown) => void) => () => void;
  respondUi: (response: PluginWebviewUiResponse) => void;
};

/**
 * Narrow a payload that arrived over IPC into a request worth acting on.
 *
 * A channel is not a type. The payload is main's own, but it crosses as
 * `unknown` and is validated here for the same reason the guest's calls are
 * validated in main: an unrecognized shape must degrade to "ignored" rather
 * than to a renderer that throws inside an IPC callback and takes its listener
 * down with it.
 *
 * A request with no usable `requestId` is the one thing that CANNOT be
 * answered — there is nothing to echo — so it is the one thing dropped.
 */
export function readPluginWebviewUiRequest(payload: unknown): PluginWebviewUiRequest | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const requestId = record.requestId;
  if (typeof requestId !== "string" || requestId.length === 0) return null;
  const guestKey = typeof record.guestKey === "string" ? record.guestKey : "";
  const pluginId = typeof record.pluginId === "string" ? record.pluginId : "";
  if (!guestKey || !pluginId) return null;
  const verb = record.verb;
  if (!isPluginWebviewUiVerb(verb)) return null;
  const args = record.args;
  return {
    requestId,
    guestKey,
    pluginId,
    surfaceId: typeof record.surfaceId === "string" ? record.surfaceId : null,
    // Trusted, not re-derived: main captured it from the guest's source URL at
    // attach. A value this build does not know reads as null and the verbs that
    // care fall back to the registry, which knows where the guest actually is.
    placement: typeof record.placement === "string"
      ? (record.placement as PluginWebviewUiRequest["placement"])
      : null,
    verb,
    args: args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {},
  };
}

type Answer = { ok: true; value?: unknown } | { ok: false; message: string };

const okAnswer: Answer = { ok: true };

/** The plugin's display name, for a line the reader sees. Falls back to the id. */
function displayNameOf(pluginId: string): string {
  const installed = rootAppStoreApi.getState().installedPlugins
    .find((entry) => entry.pluginId === pluginId);
  return installed?.displayName ?? pluginId;
}

/**
 * A page's toast level, as ADE's own toast tones.
 *
 * `warning` folds into `info` rather than gaining a fourth tone: the toast
 * stack has three, and adding one for plugins alone would make a plugin's
 * warning look unlike every warning ADE raises about itself.
 */
function toastToneOf(level: PluginWebviewToast["level"]): ToastTone {
  if (level === "error") return "error";
  if (level === "success") return "success";
  return "info";
}

/**
 * The composer attachment a page asked for, as text the composer can hold.
 *
 * The socket path's `{composer}` answer carries text; `composer.attach` carries
 * a typed issue reference, because that is the shape a page has in hand after
 * the reader picks something. Flattened here rather than in `composerTarget`,
 * which has no business knowing what an issue is: the composer's contract is
 * "insert this string", and the identifier-plus-title-plus-URL rendering is a
 * decision about how an attachment READS, which belongs at the edge.
 */
export function pluginWebviewAttachmentText(issue: PluginWebviewComposerAttach): string {
  const label = issue.identifier || issue.issueId;
  const title = issue.title ? ` ${issue.title}` : "";
  const url = issue.url ? ` (${issue.url})` : "";
  return `${label}${title}${url}`.trim();
}

/**
 * Ask the reader a page's question, and answer the page exactly once.
 *
 * The dismissal path is the whole reason this is not three lines. `onSubmit`
 * fires on an answer and never on a walk-away, so the store is watched as well:
 * the moment the standing question stops being this one, the page is told
 * `null`. Both paths run through `settle`, which is idempotent, so a submit
 * that is immediately followed by the store clearing does not answer twice.
 */
function askPluginWebviewPrompt(
  pluginId: string,
  prompt: PluginActionPrompt,
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const settle = (value: unknown): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve(value);
    };
    const token = openPluginPrompt({
      pluginId,
      // No action asked this: the page did. Carried so the console warning the
      // prompt store's own path writes still names something findable.
      actionId: "webview:ui.prompt",
      prompt,
      fallbackTitle: displayNameOf(pluginId),
      anchor: null,
      onSubmit: (text) => {
        // Refused rather than truncated, the same rule the socket path applies:
        // the host caps the answer and a longer one is not the reader's word.
        settle(buildPluginActionPromptAnswer(prompt, text) ?? null);
      },
    });
    // A microtask behind the store, deliberately. `submitPluginPrompt` CLEARS
    // the request before it calls `onSubmit`, so a subscriber that settled the
    // moment the store emptied would answer `null` for every submitted answer.
    // Deferring lets the submit that follows the emit win, and leaves a genuine
    // dismissal — where nothing follows — still answering on the same turn.
    const settleIfGone = (): void => {
      if (getPluginPrompt()?.token === token) return;
      queueMicrotask(() => settle(null));
    };
    unsubscribe = subscribePluginPrompt(settleIfGone);
    // The store may already have moved on — a second question opened between
    // the two calls above — in which case the subscription will never fire.
    settleIfGone();
  });
}

/**
 * Do what one request asks, and say what the page should be told.
 *
 * Exported so every verb can be tested as what it is — a function from a
 * request to an answer — rather than through an IPC listener that needs a fake
 * channel to say anything at all.
 */
export async function handlePluginWebviewUiRequest(
  request: PluginWebviewUiRequest,
): Promise<Answer> {
  const { args, pluginId } = request;
  switch (request.verb) {
    case "openSettings": {
      const target = args.target;
      // Re-wrapped into the shape the socket reader takes, which is the ONLY
      // reader of a settings request in the app: a page that names a settings
      // entry this build does not open gets the same refusal a socket does.
      const applied = applyPluginActionOpenSettings(
        { openSettings: target },
        { pluginId, actionId: "webview:openSettings" },
      );
      return applied
        ? okAnswer
        : { ok: false, message: "ADE couldn’t open that settings page." };
    }

    case "surface.close": {
      const outcome = closePluginWebviewGuest(request.guestKey);
      // A tab, a pane and a drawer tab have no dismissal, and the contract says
      // so: `surface.close` is a documented no-op there. Answered `ok` because
      // nothing went wrong — the page asked for something reasonable and this
      // placement simply has nothing to close.
      if (outcome === "unknown") {
        return { ok: false, message: "That page is no longer on screen." };
      }
      return okAnswer;
    }

    case "composer.attach": {
      const issue = args.issue;
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
        return { ok: false, message: "That attachment was malformed." };
      }
      const text = pluginWebviewAttachmentText(issue as PluginWebviewComposerAttach);
      if (!text) return { ok: false, message: "That attachment was empty." };
      const landed = applyPluginComposerEdit(
        { mode: "insert", text },
        { pluginId, actionId: "webview:composer.attach" },
      );
      return landed
        ? okAnswer
        : { ok: false, message: "There is no composer on screen to attach that to." };
    }

    case "composer.insert": {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) return { ok: false, message: "There was nothing to insert." };
      const landed = applyPluginComposerEdit(
        { mode: "insert", text },
        { pluginId, actionId: "webview:composer.insert" },
      );
      return landed
        ? okAnswer
        : { ok: false, message: "There is no composer on screen to write to." };
    }

    case "ui.toast": {
      const toast = args.toast;
      if (!toast || typeof toast !== "object" || Array.isArray(toast)) {
        return { ok: false, message: "That toast was malformed." };
      }
      const typed = toast as PluginWebviewToast;
      if (typeof typed.message !== "string" || typed.message.length === 0) {
        return { ok: false, message: "That toast had no message." };
      }
      // The plugin's own name is the title. A page cannot write ADE's voice:
      // a toast that said only what the plugin chose would read as ADE's own
      // word about the product, which is the one thing a guest must not borrow.
      const id = showToast({
        title: displayNameOf(pluginId),
        message: typed.message,
        tone: toastToneOf(typed.level),
      });
      return { ok: true, value: { id } };
    }

    case "ui.dismissToast": {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) return { ok: false, message: "That toast id was malformed." };
      dismissToast(id);
      return okAnswer;
    }

    case "ui.prompt": {
      const prompt = args.prompt;
      if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
        return { ok: false, message: "That question was malformed." };
      }
      const value = await askPluginWebviewPrompt(pluginId, prompt as PluginActionPrompt);
      return { ok: true, value };
    }

    case "ui.confirm": {
      const confirm = args.confirm;
      if (!confirm || typeof confirm !== "object" || Array.isArray(confirm)) {
        return { ok: false, message: "That question was malformed." };
      }
      const typed = confirm as PluginWebviewConfirm;
      const confirmed = await new Promise<boolean>((resolve) => {
        openPluginWebviewConfirm({
          pluginId,
          displayName: displayNameOf(pluginId),
          confirm: typed,
          settle: resolve,
        });
      });
      return { ok: true, value: confirmed };
    }

    case "dialog.submit": {
      // The args key is read tolerantly on purpose. The bridge member takes one
      // `answer` object (`dialog.submit({issue})`), and main forwards a page's
      // params under whatever name the preload gave them — `{answer: {issue}}`
      // for a faithful forward, `{issue}` for a flattened one. Both mean the
      // same thing here, and a page whose promise hangs because two processes
      // disagreed about an envelope is the failure the relay contract exists to
      // prevent. Anything else is malformed and refused with a sentence.
      const envelope = args.answer;
      const payload = envelope && typeof envelope === "object" && !Array.isArray(envelope)
        ? envelope as Record<string, unknown>
        : args;
      const issue = payload.issue;
      // `null` is a real answer — the reader cleared the selection — so the
      // check is on the FIELD's presence, not its truthiness. A record is
      // passed through as the page sent it: reading its five facts is the
      // dialog's job, because the dialog is what knows which plugin owns the
      // link it is about to store.
      if (!("issue" in payload)) {
        return { ok: false, message: "That selection was malformed." };
      }
      if (issue !== null && (typeof issue !== "object" || Array.isArray(issue))) {
        return { ok: false, message: "That selection was malformed." };
      }
      const outcome = submitPluginWebviewDialogAnswer(request.guestKey, {
        issue: issue as PluginWebviewDialogSubmit["issue"],
      });
      if (outcome === "applied") return okAnswer;
      // Refused and unlistened are told apart because the plugin author can act
      // on the difference: one is a form that would not take the value, the
      // other is a page calling the verb from somewhere there is no form at all.
      return outcome === "refused"
        ? { ok: false, message: "This dialog couldn’t use that issue." }
        : { ok: false, message: "There is no dialog on screen to fill in." };
    }

    case "actionResult": {
      // The invoke path. Main has already handled `openUrl`, `authSession` and
      // `prompt` before it sent this, so those three are deliberately absent
      // here — acting on them again would open a link twice.
      const result = args.result;
      const actionId = typeof args.action === "string" ? args.action : "webview:invoke";
      showPluginActionMessage(result, pluginId, actionId);
      const edit = readPluginActionComposerEdit(result);
      if (edit) applyPluginComposerEdit(edit, { pluginId, actionId });
      applyPluginDialogEdit(result, { pluginId, actionId });
      const openedSettings = applyPluginActionOpenSettings(result, { pluginId, actionId });
      // `{openWebview}`, which this path used to drop on the floor.
      //
      // The socket press has honoured it since the page tier shipped; an invoke
      // from a PAGE did not, so a plugin whose own page answered `{openWebview}`
      // got nothing at all and no error anywhere. Linear's Attach is the case:
      // its issue popover answers `{openWebview:{surfaceId:"picker"}}`, and the
      // picker replaces that popover because both are the one anchored card the
      // popover store holds — stacking would leave the reader two things to
      // dismiss.
      //
      // Two differences from the socket path, both forced by where this runs.
      // The SUBJECT is null: a page's subject is main's word, captured at
      // attach and never carried on this verb, so the relay has none to pass on
      // and must not invent one from the calling guest. The ANCHOR comes from
      // the standing card when this guest IS that card, so a picker opens where
      // the control the reader pressed was rather than in the middle of the
      // window; a tab or pane guest has no anchor and answers null.
      const overlay = readPluginActionWebview(result);
      if (overlay) {
        const plugin = rootAppStoreApi.getState().installedPlugins
          .find((entry) => entry.pluginId === pluginId);
        // Checked against the plugin's REAL surfaces, exactly as the socket path
        // does, so an unresolvable id never opens an empty frame.
        const surfaceExists = plugin?.enabled
          && plugin.tabs.some((tab) => tab.id === overlay.surfaceId);
        if (surfaceExists) {
          const caller = getPluginWebviewGuest(request.guestKey);
          const standing = getPluginWebviewPopover();
          const anchor = caller
            && standing
            && standing.pluginId === caller.pluginId
            && standing.surfaceId === caller.surfaceId
            ? standing.anchor
            : null;
          openPluginActionWebview({
            pluginId,
            surfaceId: overlay.surfaceId,
            ...(overlay.placement ? { placement: overlay.placement } : {}),
            subject: null,
            ...(overlay.context ? { pointer: overlay.context } : {}),
            anchor,
          });
        } else {
          console.warn("[plugin webview] openWebview named an unknown surface", pluginId, overlay.surfaceId);
        }
      } else if (hasPluginActionWebviewRequest(result)) {
        console.warn("[plugin webview] ignored a malformed openWebview request", pluginId, actionId);
      }
      // The same one-destination rule the socket path applies: `{openSettings}`
      // and `{navigate}` in one result are one destination written twice, and
      // honouring both sends the reader to Settings over a tab they never chose.
      const navigation = openedSettings ? null : readPluginActionNavigation(result);
      if (navigation) {
        const guest = getPluginWebviewGuest(request.guestKey);
        applyPluginActionNavigation(navigation, {
          pluginId,
          // A page belongs to no row. The subject the guest was attached to is
          // main's to know and is not carried on this verb, so the navigation
          // resolves against the surface the same way a keybinding's does.
          context: null,
          anchor: null,
        });
        // A navigation out of an anchored page takes the reader somewhere else
        // entirely; leaving the card standing over the destination is a second
        // thing to dismiss. A tab or pane guest has no `close` and is untouched.
        if (guest?.close) guest.close();
      }
      return okAnswer;
    }

    case "sockets.list": {
      const socket = typeof args.socket === "string" ? args.socket : "";
      if (!socket) return { ok: false, message: "That socket kind was malformed." };
      // An unknown kind answers an empty list rather than a refusal: "nobody
      // published for that" and "this build has no such socket" are the same
      // thing to a page drawing an overlay, and a rejection would make a page
      // written against a newer host fail instead of drawing nothing.
      return { ok: true, value: await listPluginWebviewSockets(socket) };
    }

    case "sockets.invoke": {
      const socketId = typeof args.socketId === "string" ? args.socketId : "";
      if (!socketId) return { ok: false, message: "That socket id was malformed." };
      // Resolved by LISTING again, not from anything the page sent: the plugin
      // and the action come off the contribution, so a page can only press a
      // row the host would itself have drawn — and a row the publishing plugin
      // has since withdrawn stops being pressable rather than firing anyway.
      const row = await findPluginWebviewSocket(socketId);
      if (!row) return { ok: false, message: "That contribution is no longer published." };
      const actionId = typeof row.payload?.actionId === "string" ? row.payload.actionId : "";
      if (!actionId) return { ok: false, message: "That contribution has no action to run." };
      const invokeArgs = args.args && typeof args.args === "object" && !Array.isArray(args.args)
        ? args.args as Record<string, unknown>
        : {};
      const result = await invokePluginSocketAction(row.pluginId, actionId, invokeArgs);
      // The same control-flow reader the socket press itself gets, applied
      // against the PUBLISHING plugin rather than the calling page: a
      // `{navigate}` from someone else's handler goes where that plugin meant
      // it to, and the page that pressed the row does not get to redirect it.
      showPluginActionMessage(result, row.pluginId, actionId);
      const edit = readPluginActionComposerEdit(result);
      if (edit) applyPluginComposerEdit(edit, { pluginId: row.pluginId, actionId });
      const openedSettings = applyPluginActionOpenSettings(result, { pluginId: row.pluginId, actionId });
      const navigation = openedSettings ? null : readPluginActionNavigation(result);
      if (navigation) {
        applyPluginActionNavigation(navigation, {
          pluginId: row.pluginId,
          context: null,
          anchor: null,
        });
      }
      return { ok: true, value: result };
    }

    case "hostEngine.place": {
      const engineId = typeof args.engineId === "string" ? args.engineId : "";
      const rect = sanitizePluginWebviewEngineRect(args.rect);
      // Main already refused an engine this plugin does not own and a rect that
      // is not a rectangle. Both are re-read here because this function is the
      // unit under test and a relay request is `unknown` by the time it lands —
      // not because the window is a second authority on ownership.
      if (!engineId || !rect) return { ok: false, message: "That placement was malformed." };
      const outcome = placeHostEngine(request.guestKey, { engineId, rect });
      return outcome === "placed"
        ? okAnswer
        : { ok: false, message: "That tool isn’t available on this screen." };
    }

    case "hostEngine.release": {
      releaseHostEngine(request.guestKey);
      return okAnswer;
    }

    case "page.error": {
      const error = sanitizePluginWebviewPageError(args.error ?? args);
      // A malformed report is answered `ok` and dropped. The caller is a page's
      // own error handler, and refusing it would raise a second failure inside
      // the handler for the first.
      if (!error) return okAnswer;
      recordPluginWebviewPageError(request.guestKey, error);
      return okAnswer;
    }

    case "ui.pickModel":
    case "ui.pickLane":
    case "ui.pickPermissionMode":
    case "ui.pickReasoningEffort":
    case "ui.pickProvider": {
      // Same sequence the hosted web client uses: refuse with a sentence,
      // immediate-null for a known empty ladder, otherwise ADE's own picker.
      try {
        const value = await pickPluginWebviewUi(request.verb, args, {
          pluginId,
          guestKey: request.guestKey,
        });
        return { ok: true, value };
      } catch (cause) {
        const message = cause instanceof Error && cause.message
          ? cause.message
          : "ADE could not do that.";
        return { ok: false, message };
      }
    }

    default: {
      // Unreachable while `isPluginWebviewUiVerb` gates the read above, and
      // still answered: a verb added to the shared list before this switch
      // learns it must refuse rather than hang.
      const unknown: never = request.verb;
      return { ok: false, message: `This window can’t do “${String(unknown)}”.` };
    }
  }
}

/**
 * Serve the relay for as long as this window lives. Returns the uninstall
 * function.
 *
 * The bridge is passed in rather than reached for so a test can drive every
 * verb through a fake pair, and so a host with no relay members (an older
 * build, the hosted web client) is a null this caller can check instead of a
 * throw inside a mount effect.
 */
export function installPluginWebviewRelay(bridge: PluginWebviewRelayBridge): () => void {
  return bridge.onUiRequest((payload) => {
    const request = readPluginWebviewUiRequest(payload);
    // The only drop in the module, and only because there is no `requestId` to
    // echo. Main times this one out; nothing else can be done with it.
    if (!request) {
      console.warn("[plugin webview] ignored an unreadable relay request", payload);
      return;
    }
    void (async () => {
      let answer: Answer;
      try {
        answer = await handlePluginWebviewUiRequest(request);
      } catch (cause) {
        // A throw inside an applier becomes a refusal the page can read. The
        // alternative is a promise nobody settles.
        answer = {
          ok: false,
          message: cause instanceof Error ? cause.message : "ADE couldn’t do that.",
        };
      }
      bridge.respondUi(
        answer.ok
          ? { requestId: request.requestId, ok: true, ...(answer.value === undefined ? {} : { value: answer.value }) }
          : { requestId: request.requestId, ok: false, message: answer.message },
      );
    })();
  });
}

/** Take a standing prompt down, for a caller unmounting the relay. */
export function resetPluginWebviewRelayPrompts(): void {
  closePluginPrompt();
}
