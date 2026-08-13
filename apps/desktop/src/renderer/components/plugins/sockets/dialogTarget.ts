/**
 * Where a `{dialog: {setField}}` action response lands.
 *
 * A dialog edit arrives at the END of an action, and the two paths that can
 * carry one — the generic socket invoke and a panel's own button dispatch —
 * both know nothing about ADE's dialogs. So the dialog registers itself here
 * while it is on screen and those paths ask this module to apply the edit, in
 * the same shape `./composerTarget` already uses for the draft.
 *
 * Three consequences worth stating, because all three are deliberate:
 *
 * 1. **The invoking CONTEXT decides which allowlist applies.** A dialog section
 *    invokes with a `PluginDialogContext`, which names the dialog, and
 *    `readPluginActionDialogEdit` is read for exactly that dialog. Nothing here
 *    guesses from what happens to be on screen: an edit returned to a create-PR
 *    section can only ever be read against create-PR's fields.
 * 2. **A field the dialog cannot take is refused, not approximated.** The
 *    allowlist is the platform's gate; the control is the dialog's. A closed
 *    list — parent lane, template, machine, colour — takes only a value the
 *    user could have picked themselves, because writing an id that is not in
 *    the list would blank the control rather than fill it.
 * 3. **Nothing here can submit anything.** `setField` writes controlled state
 *    and returns; pressing Create stays the user's, which is the whole reason
 *    the confirmation controls are absent from `PLUGIN_DIALOG_FIELDS`.
 */

import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import {
  hasPluginActionDialogRequest,
  readPluginActionDialogEdit,
} from "../../../../shared/plugins/sdk";
import type { PluginDialogField, PluginDialogKind } from "../../../../shared/plugins/sockets";

export type PluginDialogTarget = {
  /** The dialog on screen. Only an edit read for this kind reaches it. */
  dialog: PluginDialogKind;
  /**
   * Write one allowlisted field into the dialog's controlled state.
   *
   * Returns whether the value landed. `false` means the control refused it —
   * the honest answer for a closed list handed something not in it — and the
   * section shows its quiet error state rather than pretending.
   */
  setField: (field: PluginDialogField, value: string) => boolean;
  /** Told when an edit for this dialog arrived and could not be written. */
  onRefused?: () => void;
};

type RegisteredTarget = PluginDialogTarget & { registeredAt: number };

const targets = new Map<string, RegisteredTarget>();

let registrationSequence = 0;

/**
 * Register a dialog as an edit destination; returns the unregister function.
 *
 * Registering the same `id` again moves it to the front of the fallback order,
 * which is how "the dialog the user is actually looking at" is expressed when a
 * second one opens over the first.
 */
export function registerPluginDialogTarget(id: string, target: PluginDialogTarget): () => void {
  registrationSequence += 1;
  targets.set(id, { ...target, registeredAt: registrationSequence });
  return () => {
    targets.delete(id);
  };
}

/** Drop a registration by id. Safe to call for an id that never registered. */
export function unregisterPluginDialogTarget(id: string): void {
  targets.delete(id);
}

/** The dialog an invocation was made from, or `null` for every other context. */
export function pluginDialogKindForContext(
  context: PluginSurfaceContext | null | undefined,
): PluginDialogKind | null {
  return context && context.kind === "dialog" ? context.dialog : null;
}

/** The most recently registered dialog of one kind. */
function resolveTarget(dialog: PluginDialogKind): RegisteredTarget | null {
  let newest: RegisteredTarget | null = null;
  for (const target of targets.values()) {
    if (target.dialog !== dialog) continue;
    if (!newest || target.registeredAt > newest.registeredAt) newest = target;
  }
  return newest;
}

/**
 * Apply whatever dialog edit an action's result asked for.
 *
 * Returns whether one landed. A result that said nothing about a dialog, and an
 * invocation that did not come from one, are both a quiet `false` — most
 * actions carry no edit and that is not an event. A result that ASKED and was
 * refused warns and tells the section, because the person wondering why a
 * plugin button appeared to do nothing is the one who can act on it.
 */
export function applyPluginDialogEdit(
  result: unknown,
  options: { context?: PluginSurfaceContext | null; pluginId: string; actionId: string },
): boolean {
  const dialog = pluginDialogKindForContext(options.context);
  if (!dialog) return false;
  const target = resolveTarget(dialog);
  // Read for THIS dialog: a create-lane section returning `{field: "body"}` is
  // not a partial success, it is an edit for a different dialog.
  const edit = readPluginActionDialogEdit(result, dialog);
  if (!edit) {
    // Asked and refused: a field this dialog does not advertise, a non-string
    // value, or one over PLUGIN_DIALOG_FIELD_VALUE_MAX_BYTES.
    if (hasPluginActionDialogRequest(result)) {
      console.warn("[plugin dialog] ignored a field this dialog does not accept", options.pluginId, options.actionId);
      target?.onRefused?.();
    }
    return false;
  }
  if (!target) {
    console.warn("[plugin dialog] dropped an edit with no dialog on screen", options.pluginId, options.actionId);
    return false;
  }
  if (target.setField(edit.field, edit.value)) return true;
  console.warn("[plugin dialog] the dialog refused a value for", edit.field, options.pluginId, options.actionId);
  target.onRefused?.();
  return false;
}

/**
 * Say that a value could not be written, for a dialog that could not answer at
 * the moment it was asked.
 *
 * Manage-lane is the case: its restack fields live behind a tab, so a write for
 * a control that is not mounted opens that tab and lands when the control
 * registers — after `applyPluginDialogEdit` has already returned. Without this
 * the deferred half of that path could refuse a value in silence, which is the
 * one thing the quiet error state exists to prevent.
 */
export function reportPluginDialogRefusal(dialog: PluginDialogKind): void {
  resolveTarget(dialog)?.onRefused?.();
}

/** Test seam: forget every registration. */
export function resetPluginDialogTargets(): void {
  targets.clear();
  registrationSequence = 0;
}
