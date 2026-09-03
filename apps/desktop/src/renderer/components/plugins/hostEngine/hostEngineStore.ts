import React from "react";

import {
  clampPluginWebviewEngineRect,
  pluginWebviewHostEngineOwner,
  type PluginWebviewEngineRect,
} from "../../../../shared/plugins/webviewBridge";

/**
 * Where the host paints one of its OWN engines, on a plugin page's say-so.
 *
 * ## The problem this solves
 *
 * Two of ADE's tools cannot move into a guest and are not going to. The
 * Electron Control inspector drives a real `webContents` through a debugger
 * protocol, and the iOS simulator mirror streams frames off a device the host
 * owns; both need main-process capabilities no sandboxed page can be handed.
 * The DAG canvases are in the same position until their ports finish. But the
 * SURFACES around them — the toolbars, the run lists, the settings — are
 * exactly what the page tier is for.
 *
 * So the layout and the engine are split. The page draws everything except a
 * hole, measures the hole, and says where it is. The host paints its own
 * component into that hole, above the guest, and keeps every input the engine
 * takes. A page positions an engine; it never reaches into one.
 *
 * ## What keeps it honest
 *
 * 1. **Ownership.** `PLUGIN_WEBVIEW_HOST_ENGINE_OWNERS` binds an engine id to
 *    the plugin that owns its builtin surface, and MAIN checks the caller
 *    against it before a request reaches this window — the check is made
 *    against the plugin id main derived from the guest's origin, which a page
 *    cannot forge.
 * 2. **Clamping.** The page reports coordinates in its own layout, which it can
 *    make any size it likes. The host owns the frame, so the host intersects
 *    the rect with it: an engine can never be painted over ADE's own chrome.
 * 3. **A registered renderer.** An engine is only placeable where the app
 *    actually mounts it — a component with a lane, a runtime pin and a project
 *    root in hand registers itself, and a placement with nobody registered is
 *    REFUSED rather than silently drawing an empty box. That is what makes
 *    "the simulator is not available on this screen" a sentence the page can
 *    show instead of a hole nothing fills.
 */

export type HostEnginePlacement = {
  engineId: string;
  /** As the page reported it, in the page's own coordinates. Unclamped. */
  rect: PluginWebviewEngineRect;
};

/** Why a placement did not happen, or that it did. */
export type HostEnginePlaceOutcome = "placed" | "unavailable";

type Listener = () => void;

const placements = new Map<string, HostEnginePlacement>();
const bounds = new Map<string, { width: number; height: number }>();
const renderers = new Map<string, () => React.ReactNode>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One subscriber throwing must not strand the others.
    }
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Offer an engine for placement, for as long as the offering component lives.
 *
 * Registered by the component that HOLDS the engine's inputs — the lane, the
 * runtime pin, the project root — because those are what make the engine
 * mountable at all, and a store that tried to hold them would be a second copy
 * of the surface's state. Last registration wins: one window draws one Work
 * rail, so a second registration means the first component unmounted out of
 * order rather than that two are competing.
 */
export function registerHostEngineRenderer(
  engineId: string,
  render: () => React.ReactNode,
): () => void {
  renderers.set(engineId, render);
  emit();
  return () => {
    if (renderers.get(engineId) === render) {
      renderers.delete(engineId);
      // A placement of an engine nobody can draw any more is dropped rather
      // than left standing: the page would otherwise keep a hole open around a
      // component that has gone.
      for (const [guestKey, placement] of [...placements]) {
        if (placement.engineId === engineId) placements.delete(guestKey);
      }
      emit();
    }
  };
}

/** Whether an engine can be painted right now. Read before a placement. */
export function hostEngineAvailable(engineId: string): boolean {
  return renderers.has(engineId);
}

/**
 * Record where a page wants an engine, or refuse.
 *
 * The ownership check is main's — it is made against a plugin id a page cannot
 * forge, and repeating it here would be a weaker copy of the same rule. What
 * this adds is the check main cannot make: whether this WINDOW is currently
 * drawing a surface that offers the engine at all.
 */
export function placeHostEngine(
  guestKey: string,
  placement: HostEnginePlacement,
): HostEnginePlaceOutcome {
  if (!pluginWebviewHostEngineOwner(placement.engineId)) return "unavailable";
  if (!renderers.has(placement.engineId)) return "unavailable";
  const existing = placements.get(guestKey);
  if (
    existing
    && existing.engineId === placement.engineId
    && existing.rect.x === placement.rect.x
    && existing.rect.y === placement.rect.y
    && existing.rect.width === placement.rect.width
    && existing.rect.height === placement.rect.height
  ) {
    // A `ResizeObserver` fires on every layout tick, and most of them report
    // the rect that is already applied. Emitting on those would re-render the
    // engine — a live inspector or a video mirror — once per tick.
    return "placed";
  }
  placements.set(guestKey, placement);
  emit();
  return "placed";
}

/** Take an engine back down. A no-op when nothing was placed for this guest. */
export function releaseHostEngine(guestKey: string): void {
  if (!placements.delete(guestKey)) return;
  bounds.delete(guestKey);
  emit();
}

/**
 * The frame the host actually drew for one guest.
 *
 * Reported by the page host as its own container resizes, and used only to
 * clamp. Kept apart from the placement because the two move independently: a
 * window resize changes the bounds without the page saying anything, and the
 * engine must follow.
 */
export function setHostEngineBounds(
  guestKey: string,
  next: { width: number; height: number } | null,
): void {
  if (!next) {
    if (bounds.delete(guestKey)) emit();
    return;
  }
  const current = bounds.get(guestKey);
  if (current && current.width === next.width && current.height === next.height) return;
  bounds.set(guestKey, next);
  if (placements.has(guestKey)) emit();
}

/** Test seam, and the reset a window performs when its relay unmounts. */
export function resetHostEngines(): void {
  placements.clear();
  bounds.clear();
  renderers.clear();
  emit();
}

/**
 * What one guest should paint, clamped to its own frame — or null.
 *
 * Null covers three states the caller treats identically: nothing placed, no
 * renderer for what was placed, and a rect that does not intersect the frame
 * (the element the page measured has scrolled out of view). All three mean
 * "paint nothing right now", and none of them is an error.
 */
export function hostEnginePaint(
  guestKey: string,
): { engineId: string; rect: PluginWebviewEngineRect; render: () => React.ReactNode } | null {
  const placement = placements.get(guestKey);
  if (!placement) return null;
  const render = renderers.get(placement.engineId);
  if (!render) return null;
  const frame = bounds.get(guestKey);
  // No bounds yet means the host has not measured its container. Painting the
  // page's own unclamped rect then would be the one case where an engine could
  // reach past the frame, so it waits for the first measurement instead.
  if (!frame) return null;
  const rect = clampPluginWebviewEngineRect(placement.rect, frame);
  if (!rect) return null;
  return { engineId: placement.engineId, rect, render };
}

/** Subscribe a component to one guest's paint. */
export function useHostEnginePaint(
  guestKey: string | null,
): { engineId: string; rect: PluginWebviewEngineRect; render: () => React.ReactNode } | null {
  const getSnapshot = React.useCallback(
    () => (guestKey ? hostEnginePaint(guestKey) : null),
    [guestKey],
  );
  // `useSyncExternalStore` compares with `Object.is`, and `hostEnginePaint`
  // builds a fresh record every call, so the snapshot is memoized against the
  // store's own version counter rather than returned raw — otherwise every
  // unrelated emit would re-render every page host in the window.
  const version = React.useSyncExternalStore(subscribe, () => versionOf(guestKey));
  return React.useMemo(() => getSnapshot(), [getSnapshot, version]);
}

/**
 * A cheap, comparable stamp of one guest's paint.
 *
 * The alternative — returning the record and memoizing on its fields — puts the
 * comparison in every caller. A string is `Object.is`-comparable, which is what
 * `useSyncExternalStore` wants, and building it is four reads.
 */
function versionOf(guestKey: string | null): string {
  if (!guestKey) return "";
  const placement = placements.get(guestKey);
  if (!placement) return "";
  const frame = bounds.get(guestKey);
  const hasRenderer = renderers.has(placement.engineId) ? "1" : "0";
  return [
    placement.engineId,
    hasRenderer,
    placement.rect.x,
    placement.rect.y,
    placement.rect.width,
    placement.rect.height,
    frame?.width ?? -1,
    frame?.height ?? -1,
  ].join(":");
}
