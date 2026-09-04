import { useSyncExternalStore } from "react";

import {
  isPluginWebviewPickerVerb,
  pluginWebviewPickerImmediateNull,
  refusePluginWebviewPicker,
  type PluginWebviewPickerVerb,
  PLUGIN_WEBVIEW_PICKER_VERBS,
} from "./pluginWebviewPickerPolicy";

export {
  isPluginWebviewPickerVerb,
  PLUGIN_WEBVIEW_PICKER_VERBS,
  type PluginWebviewPickerVerb,
};

/**
 * The one ADE picker a plugin page may have standing.
 *
 * The five `ui.pick*` verbs open ADE's own controls — the model list, the lane
 * combobox, the permission pill, the reasoning ladder, the provider rail —
 * over the guest that asked. Null is "the reader dismissed it". A client that
 * cannot open a picker must refuse with a sentence instead of answering null,
 * which is why this store existing at all is the hosted web client's `ui.pick`.
 *
 * ## The answer is always delivered
 *
 * `settle` is called exactly once: a choice, a walk-away, Escape, or a second
 * picker replacing this one. Replacement settles the outgoing request `null`,
 * which is the reading a reader would give it — they never chose.
 */

export type PluginWebviewPickerRequest = {
  /** Bumped on every open, so the host remounts for a second question. */
  token: number;
  pluginId: string;
  guestKey: string;
  verb: PluginWebviewPickerVerb;
  args: Record<string, unknown>;
  /** Called exactly once with the choice, or null when dismissed. */
  settle: (value: unknown) => void;
};

let current: PluginWebviewPickerRequest | null = null;
let nextToken = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PluginWebviewPickerRequest | null {
  return current;
}

/** Ask the reader, using ADE's own picker. Returns the request token. */
export function openPluginWebviewPickerRequest(
  request: Omit<PluginWebviewPickerRequest, "token">,
): number {
  const replaced = current;
  const token = nextToken;
  nextToken += 1;
  current = { ...request, token };
  emit();
  replaced?.settle(null);
  return token;
}

/**
 * Open a picker and wait for the choice (or null). Used by the desktop relay
 * and by the hosted web client's `ui.pick`.
 */
export function openPluginWebviewPicker(input: {
  pluginId: string;
  guestKey: string;
  verb: PluginWebviewPickerVerb;
  args: Record<string, unknown>;
}): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: unknown): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openPluginWebviewPickerRequest({
      pluginId: input.pluginId,
      guestKey: input.guestKey,
      verb: input.verb,
      args: input.args,
      settle,
    });
  });
}

/**
 * The hosted web client's `options.ui.pick`. Same store as the desktop relay,
 * so a page that asks on either client gets ADE's own picker rather than a
 * second one.
 *
 * Throws when the method is not a picker verb: the bridge already gated the
 * name, and a stray call here is a host bug, not a dismissal.
 */
export function pickPluginWebviewUi(
  method: string,
  params: Record<string, unknown>,
  context: { pluginId: string; guestKey: string },
): Promise<unknown> {
  if (!isPluginWebviewPickerVerb(method)) {
    return Promise.reject(new Error("This client can’t open that picker yet."));
  }
  const refusal = refusePluginWebviewPicker(method, params);
  if (refusal) return Promise.reject(new Error(refusal));
  if (pluginWebviewPickerImmediateNull(method, params)) return Promise.resolve(null);
  return openPluginWebviewPicker({
    pluginId: context.pluginId,
    guestKey: context.guestKey,
    verb: method,
    args: params,
  });
}

/**
 * Answer and close. A no-op when nothing is open, and when `token` names a
 * picker a newer one has already replaced.
 */
export function settlePluginWebviewPicker(value: unknown, token?: number): void {
  const request = current;
  if (!request) return;
  if (token !== undefined && request.token !== token) return;
  current = null;
  emit();
  request.settle(value);
}

export function usePluginWebviewPicker(): PluginWebviewPickerRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getPluginWebviewPicker(): PluginWebviewPickerRequest | null {
  return current;
}

/** Test seam: cancel and forget whatever is open. */
export function resetPluginWebviewPicker(): void {
  const request = current;
  current = null;
  nextToken = 1;
  emit();
  request?.settle(null);
}
