/**
 * ADE's own pickers, and the inline lists that stand in for them.
 *
 * The launch form would rather open the app's picker than draw its own select.
 * The reason is not aesthetics: ADE's model picker knows the fast-mode tier and
 * the reasoning ladder of every model in the catalog, it groups by provider,
 * and it is the list the reader already recognises from the composer. A plugin
 * has no way to know any of that, and a second list that disagreed with the
 * first would be worse than no list at all.
 *
 * Every picker is OPTIONAL on the bridge. A v1 host answers none of them, a
 * hosted web client may answer some, and the phone may answer others. So each
 * function here asks the host first and falls back to the caller's own inline
 * `<select>` when the host has nothing to open.
 *
 * **The fallback is not dead code.** It is the path a v1 desktop and every host
 * that has not shipped the picker verbs take, and it is the only reason the
 * launch form works at all on those. `pickOrFallback` answers `"inline"` there,
 * and the form draws the list it built from `CloudLaunchContext` — which is why
 * that context carries `lanes`, `models` and `reasoningOptions` even though a
 * host with pickers never reads them.
 */

import { bridge, type PluginWebviewPickResult } from "../bridge";

/**
 * What one picker attempt answered.
 *
 * Three outcomes, and collapsing any two of them would be a bug:
 *
 * - `picked` — the reader chose a row. Take the id.
 * - `dismissed` — the reader closed the picker WITHOUT choosing. A real answer:
 *   the form must keep the value it had, not clear it.
 * - `inline` — the host has no such picker. The caller draws its own list.
 */
export type PickOutcome =
  | { kind: "picked"; id: string; label: string | null }
  | { kind: "dismissed" }
  | { kind: "inline" };

const INLINE: PickOutcome = { kind: "inline" };

async function attempt(
  open: (() => Promise<PluginWebviewPickResult>) | undefined,
): Promise<PickOutcome> {
  if (typeof open !== "function") return INLINE;
  let result: PluginWebviewPickResult;
  try {
    result = await open();
  } catch {
    // The host has the verb but refused this one call — a placement that may
    // not open a popover, most often. The inline list is still correct.
    return INLINE;
  }
  if (!result || typeof result.id !== "string" || result.id.length === 0) {
    return { kind: "dismissed" };
  }
  return { kind: "picked", id: result.id, label: result.label ?? null };
}

/** ADE's lane picker, scoped to the lanes the child says can take this launch. */
export function pickLane(laneIds: string[]): Promise<PickOutcome> {
  const ui = bridge()?.ui;
  return attempt(ui?.pickLane ? () => ui.pickLane!({ laneIds }) : undefined);
}

/**
 * ADE's model picker, scoped to Cursor's own catalog.
 *
 * `modelIds` is passed even though the host could infer them from the provider:
 * Cursor's cloud catalog is not the same list as Cursor's local one, and the
 * child is the half that knows which models this account's cloud can run.
 */
export function pickModel(modelIds: string[]): Promise<PickOutcome> {
  const ui = bridge()?.ui;
  return attempt(ui?.pickModel ? () => ui.pickModel!({ provider: "cursor", modelIds }) : undefined);
}

export function pickReasoningEffort(model: string | null): Promise<PickOutcome> {
  const ui = bridge()?.ui;
  return attempt(
    ui?.pickReasoningEffort
      ? () => ui.pickReasoningEffort!({ provider: "cursor", model: model ?? undefined })
      : undefined,
  );
}

/**
 * The two pickers this page has no field for, kept for the map's sake.
 *
 * `pickProvider` and `pickPermissionMode` are the other half of ADE's picker
 * vocabulary, and both are meaningless on this surface: a Cursor Cloud launch
 * has exactly one provider, and Cursor's cloud runs with no permission ladder
 * to choose from — the compiled composer drew neither control. They are wired
 * anyway so that this file is the complete answer to "which host picker does
 * the page use for X", and so a later field does not reach for the global.
 */
export function pickProvider(): Promise<PickOutcome> {
  const ui = bridge()?.ui;
  return attempt(ui?.pickProvider ? () => ui.pickProvider!() : undefined);
}

export function pickPermissionMode(provider: string): Promise<PickOutcome> {
  const ui = bridge()?.ui;
  return attempt(
    ui?.pickPermissionMode ? () => ui.pickPermissionMode!({ provider }) : undefined,
  );
}

/**
 * Whether this host answers a given picker verb.
 *
 * Asked before the control is DRAWN rather than at the first press, because the
 * two shapes are different: a host with the verb gets a chip that opens ADE's
 * picker, and a host without it gets a real `<select>` the reader can use. A
 * chip that looked live and opened nothing would be the worst of the three.
 */
export function hasPicker(
  name: "pickModel" | "pickProvider" | "pickLane" | "pickPermissionMode" | "pickReasoningEffort",
): boolean {
  return typeof bridge()?.ui?.[name] === "function";
}
