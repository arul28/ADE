/**
 * Where a `{composer: {…}}` action response lands.
 *
 * A composer edit arrives at the END of an action, from the generic socket
 * invoke path, which has no idea a composer exists — the same path serves a
 * Lanes row menu and a PRs toolbar. So the composer registers itself here while
 * it is on screen and the invoke path asks this module to apply the edit, in
 * the same shape the app-global dictation target already uses for transcripts.
 *
 * Two consequences worth stating, because both are deliberate:
 *
 * 1. **Any composer-scoped invocation can carry an edit**, not just a
 *    `composer-action` button. A row menu item invoked from a chat, a detail
 *    section's action — if the invoking context names the session a live
 *    composer is bound to, the edit lands there. The verb belongs to the
 *    response, not to the socket kind.
 * 2. **An edit with nowhere to go is dropped with a warning**, never queued. A
 *    draft written into a composer the user has since navigated away from would
 *    appear under an unrelated chat minutes later, which is worse than nothing
 *    happening.
 */

import type { PluginActionComposerEdit } from "../../../../shared/plugins/sdk";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";

export type PluginComposerTarget = {
  /** The chat this composer sends to, or null before it has started one. */
  sessionId: string | null;
  /** Insert at the caret, preserving the surrounding draft. */
  insertText: (text: string) => void;
  /** Replace the whole draft. */
  replaceText: (text: string) => void;
};

type RegisteredTarget = PluginComposerTarget & { registeredAt: number };

const targets = new Map<string, RegisteredTarget>();

let registrationSequence = 0;

/**
 * Register a composer as an edit destination; returns the unregister function.
 *
 * Calling it again for the same `id` re-registers and moves the composer to the
 * front of the fallback order. That is how "the composer the user is actually
 * looking at" is expressed with split panes on screen: the active one
 * re-registers when it becomes active, exactly as it does for dictation.
 */
export function registerPluginComposerTarget(id: string, target: PluginComposerTarget): () => void {
  registrationSequence += 1;
  targets.set(id, { ...target, registeredAt: registrationSequence });
  return () => {
    targets.delete(id);
  };
}

/** Drop a registration by id. Safe to call for an id that never registered. */
export function unregisterPluginComposerTarget(id: string): void {
  targets.delete(id);
}

/**
 * The session a context is bound to, for routing an edit.
 *
 * A `composer` context names its own session; a `session` context IS one — a
 * row menu item on a chat row invokes with the latter, and an edit it returns
 * should reach that chat's composer rather than whichever one happens to be
 * frontmost. Everything else (a lane, a PR, a file, the surface itself) has no
 * composer of its own and falls back to the active one.
 */
export function pluginComposerSessionId(context: PluginSurfaceContext | null | undefined): string | null {
  if (!context) return null;
  if (context.kind === "composer") return context.sessionId;
  if (context.kind === "session") return context.id;
  return null;
}

/**
 * The composer an edit should reach: the one bound to `sessionId` if it is on
 * screen, otherwise the most recently registered one.
 *
 * The fallback is what makes a plugin's own composer button work before the
 * chat exists — a hero composer has no session id to match on, and refusing the
 * edit there would make the button dead on exactly the screen a prompt-template
 * plugin is most useful.
 */
function resolveTarget(sessionId: string | null): RegisteredTarget | null {
  if (targets.size === 0) return null;
  if (sessionId) {
    for (const target of targets.values()) {
      if (target.sessionId === sessionId) return target;
    }
  }
  let newest: RegisteredTarget | null = null;
  for (const target of targets.values()) {
    if (!newest || target.registeredAt > newest.registeredAt) newest = target;
  }
  return newest;
}

/**
 * Apply an edit, or report that there was nowhere to apply it.
 *
 * Returns whether it landed, so the caller can decide what a miss means. The
 * warning is here rather than at the call site because "there is no composer"
 * is a fact about this module, and the person reading the console is trying to
 * find out why a plugin button appeared to do nothing.
 */
export function applyPluginComposerEdit(
  edit: PluginActionComposerEdit,
  options: { context?: PluginSurfaceContext | null; pluginId: string; actionId: string },
): boolean {
  const target = resolveTarget(pluginComposerSessionId(options.context));
  if (!target) {
    console.warn(
      "[plugin composer] dropped a composer edit with no composer on screen",
      options.pluginId,
      options.actionId,
      edit.mode,
    );
    return false;
  }
  if (edit.mode === "replace") target.replaceText(edit.text);
  else target.insertText(edit.text);
  return true;
}

/** Test seam: forget every registration. */
export function resetPluginComposerTargets(): void {
  targets.clear();
  registrationSequence = 0;
}
