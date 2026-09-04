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
 * Request and answer shapes are ADE's (`webviewBridge.ts`):
 *
 * - `pickModel({ value, availableModelIds })` → `{ modelId, fastMode }`
 * - `pickLane({ value })` → `{ laneId, name }`
 * - `pickReasoningEffort({ model, value })` → `{ modelId, effort }`
 *
 * `availableModelIds` is how Cursor Cloud's catalog narrows ADE's picker: the
 * cloud list is not Cursor's local one, and without it the form would offer
 * models Enter then refuses.
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

import { bridge } from "../bridge";

/**
 * What one picker attempt answered.
 *
 * Three outcomes, and collapsing any two of them would be a bug:
 *
 * - `picked` — the reader chose a row. Take the id.
 * - `dismissed` — the reader closed the picker WITHOUT choosing. A real answer:
 *   the form must keep the value it had, not clear it.
 * - `inline` — the host has no such picker. The caller draws its own list.
 *
 * `fastMode` rides only on a model choice: ADE's picker sets the model and the
 * fast tier in one gesture, and dropping that flag would silently run standard.
 */
export type PickOutcome =
  | { kind: "picked"; id: string; label: string | null; fastMode?: boolean }
  | { kind: "dismissed" }
  | { kind: "inline" };

const INLINE: PickOutcome = { kind: "inline" };

async function attempt<T>(
  open: (() => Promise<T | null>) | undefined,
): Promise<T | null | "inline"> {
  if (typeof open !== "function") return "inline";
  try {
    return (await open()) ?? null;
  } catch {
    // The host has the verb but refused this one call — a placement that may
    // not open a popover, most often. The inline list is still correct.
    return "inline";
  }
}

export function pickerRectFromClick(event: { currentTarget: EventTarget }): {
  top: number;
  left: number;
  width: number;
  height: number;
} | undefined {
  const node = event.currentTarget;
  if (!(node instanceof Element)) return undefined;
  const box = node.getBoundingClientRect();
  return { top: box.top, left: box.left, width: box.width, height: box.height };
}

/** ADE's lane picker. `value` is the lane already on the form, so it opens there. */
export async function pickLane(
  value?: string | null,
  rect?: { top: number; left: number; width?: number; height?: number },
): Promise<PickOutcome> {
  const ui = bridge()?.ui;
  const result = await attempt(
    ui?.pickLane
      ? () => ui.pickLane!({ ...(value ? { value } : {}), ...(rect ? { rect } : {}) })
      : undefined,
  );
  if (result === "inline") return INLINE;
  if (!result || typeof result.laneId !== "string" || result.laneId.length === 0) {
    return { kind: "dismissed" };
  }
  return {
    kind: "picked",
    id: result.laneId,
    label: typeof result.name === "string" && result.name.length > 0 ? result.name : null,
  };
}

/**
 * ADE's model picker, scoped to Cursor Cloud's catalog.
 *
 * `availableModelIds` is required even though the host could infer Cursor from
 * the provider: Cursor's cloud catalog is not the same list as Cursor's local
 * one, and the child is the half that knows which models this account's cloud
 * can run. Omit it and ADE offers every model, including ones Enter then
 * refuses with "Choose a Cursor Cloud model first".
 */
export async function pickModel(args: {
  value?: string | null;
  availableModelIds: string[];
  rect?: { top: number; left: number; width?: number; height?: number };
}): Promise<PickOutcome> {
  const ui = bridge()?.ui;
  const result = await attempt(
    ui?.pickModel
      ? () => ui.pickModel!({
        ...(args.value ? { value: args.value } : {}),
        availableModelIds: args.availableModelIds,
        ...(args.rect ? { rect: args.rect } : {}),
      })
      : undefined,
  );
  if (result === "inline") return INLINE;
  if (!result || typeof result.modelId !== "string" || result.modelId.length === 0) {
    return { kind: "dismissed" };
  }
  return {
    kind: "picked",
    id: result.modelId,
    label: null,
    fastMode: result.fastMode === true,
  };
}

/**
 * The model's own reasoning rungs.
 *
 * `model` is required by the host — the ladder is per model, and a call
 * without one is refused rather than drawing an empty control. No model on
 * the form yet means the inline list, which is empty until one is picked.
 */
export async function pickReasoningEffort(
  model: string | null,
  selected?: string | null,
  rect?: { top: number; left: number; width?: number; height?: number },
): Promise<PickOutcome> {
  if (!model) return INLINE;
  const ui = bridge()?.ui;
  const result = await attempt(
    ui?.pickReasoningEffort
      ? () => ui.pickReasoningEffort!({
        model,
        ...(selected ? { value: selected } : {}),
        ...(rect ? { rect } : {}),
      })
      : undefined,
  );
  if (result === "inline") return INLINE;
  if (!result) return { kind: "dismissed" };
  // `effort: null` is a real choice ("no reasoning"), not a dismissal.
  const effort = typeof result.effort === "string" ? result.effort : "";
  return { kind: "picked", id: effort, label: null };
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
export async function pickProvider(): Promise<PickOutcome> {
  const ui = bridge()?.ui;
  const result = await attempt(
    ui?.pickProvider ? () => ui.pickProvider!({}) : undefined,
  );
  if (result === "inline") return INLINE;
  if (!result || typeof result.provider !== "string" || result.provider.length === 0) {
    return { kind: "dismissed" };
  }
  return { kind: "picked", id: result.provider, label: null };
}

export async function pickPermissionMode(provider: string): Promise<PickOutcome> {
  const ui = bridge()?.ui;
  const result = await attempt(
    ui?.pickPermissionMode
      ? () => ui.pickPermissionMode!({ provider })
      : undefined,
  );
  if (result === "inline") return INLINE;
  if (!result || typeof result.value !== "string" || result.value.length === 0) {
    return { kind: "dismissed" };
  }
  return { kind: "picked", id: result.value, label: null };
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
