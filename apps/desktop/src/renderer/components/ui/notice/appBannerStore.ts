import { useEffect, useRef, useSyncExternalStore } from "react";
import type { BannerModel } from "./Banner";

/**
 * The registry behind `AppBannerHost`: every app-wide banner joins through
 * `useAppBanner` / `useAppBanners` from wherever its state lives, and the one
 * host decides order, cap, placement and dismissal. No feature mounts its own
 * strip in `AppShell` any more — which is what used to leave five banner styles
 * stacked in whatever order someone happened to paste them.
 *
 * Owners register while mounted and unregister on unmount, so a banner lives
 * exactly as long as the state that raised it.
 */

export type AppBannerPlacement = "docked" | "floating";

/**
 * Lower sorts first. Pick the band that matches what the banner blocks; within
 * a band the more urgent tone wins, then first-registered.
 */
export const APP_BANNER_PRIORITY = {
  /** The account itself is unusable, or this computer was refused. */
  account: 0,
  /** Something about the open project is broken (missing folder, failed open). */
  project: 10,
  /** ADE itself needs attention (update stuck, background service recovered). */
  app: 20,
  /** An integration ADE talks to has an outage it cannot fix. */
  outage: 30,
  /** An integration the user can fix (GitHub, AI provider, relay). */
  integration: 50,
  /** A ready update should stay visible ahead of transient clipboard/PR prompts. */
  updatePrompt: 55,
  /** Short floating prompts. */
  prompt: 60,
  default: 100,
} as const;

export type AppBannerOptions = {
  placement?: AppBannerPlacement;
  priority?: number;
};

export type AppBannerEntry = {
  id: string;
  placement: AppBannerPlacement;
  priority: number;
  /** Registration order, for stable ties. */
  order: number;
  model: BannerModel;
};

/** The owner's latest model; callbacks read through it at call time. */
type Live = { model: BannerModel };

type Owned = AppBannerEntry & { owner: symbol; live: Live };

/**
 * The model the host draws: the owner's model with every callback routed
 * through `live`, so a re-registration that changes only closures (a
 * `navigate` that captured an older route) takes effect without re-rendering
 * the host.
 */
function liveModel(live: Live): BannerModel {
  const model = live.model;
  const dismiss = model.dismiss;
  return {
    ...model,
    actions: model.actions?.map((action, index) =>
      action.onClick ? { ...action, onClick: () => live.model.actions?.[index]?.onClick?.() } : action,
    ),
    dismiss: dismiss && "onDismiss" in dismiss
      ? {
          ...dismiss,
          onDismiss: () => {
            const latest = live.model.dismiss;
            if (latest && "onDismiss" in latest) latest.onDismiss();
          },
        }
      : dismiss,
  };
}

let entries: Owned[] = [];
let snapshot: readonly AppBannerEntry[] = [];
let nextOrder = 0;
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = entries.slice();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly AppBannerEntry[] {
  return snapshot;
}

function sameActions(a: BannerModel["actions"], b: BannerModel["actions"]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((action, i) => {
    const other = b[i];
    return (
      action.label === other.label &&
      action.variant === other.variant &&
      action.href === other.href &&
      Boolean(action.onClick) === Boolean(other.onClick) &&
      Object.is(action.icon, other.icon) &&
      Boolean(action.disabled) === Boolean(other.disabled) &&
      Boolean(action.busy) === Boolean(other.busy) &&
      action.title === other.title &&
      action.expanded === other.expanded
    );
  });
}

function sameDismiss(a: BannerModel["dismiss"], b: BannerModel["dismiss"]): boolean {
  if (!a || !b) return !a === !b;
  if ("key" in a && "key" in b) return a.key === b.key && a.fingerprint === b.fingerprint;
  if ("onDismiss" in a && "onDismiss" in b) return a.title === b.title && a.label === b.label;
  return false;
}

/** Whether re-registration leaves the host's rendered model intact. */
function sameRenderedModel(a: BannerModel, b: BannerModel): boolean {
  const text = (value: unknown) => typeof value === "string" || value == null;
  return (
    a.tone === b.tone &&
    // Plain-text fields compare by value; JSX (a logo, rich detail) is re-created
    // every render, so it compares by reference and simply re-renders the host.
    (text(a.title) && text(b.title) ? a.title === b.title : Object.is(a.title, b.title)) &&
    (text(a.detail) && text(b.detail) ? a.detail === b.detail : Object.is(a.detail, b.detail)) &&
    Object.is(a.icon, b.icon) &&
    Object.is(a.extra, b.extra) &&
    Boolean(a.busy) === Boolean(b.busy) &&
    a.ariaLabel === b.ariaLabel &&
    a.error === b.error &&
    sameActions(a.actions, b.actions) &&
    sameDismiss(a.dismiss, b.dismiss)
  );
}

/**
 * Replace everything `owner` registered with `next`. Callbacks are refreshed in
 * place without notifying, so actions always run the owner's latest closure
 * while the host only re-renders for visible changes.
 */
function syncOwner(owner: symbol, next: Array<{ model: BannerModel; options?: AppBannerOptions }>): void {
  let changed = false;
  const keepIds = new Set<string>();
  const updated: Owned[] = [];
  for (const entry of entries) {
    if (entry.owner !== owner) {
      updated.push(entry);
      continue;
    }
    const replacement = next.find((item) => item.model.id === entry.id);
    if (!replacement) {
      changed = true;
      continue;
    }
    keepIds.add(entry.id);
    const placement = replacement.options?.placement ?? "docked";
    const priority = replacement.options?.priority ?? APP_BANNER_PRIORITY.default;
    if (placement !== entry.placement || priority !== entry.priority || !sameRenderedModel(entry.model, replacement.model)) {
      changed = true;
      entry.live.model = replacement.model;
      updated.push({ ...entry, placement, priority, model: liveModel(entry.live) });
    } else {
      entry.live.model = replacement.model;
      updated.push(entry);
    }
  }
  for (const item of next) {
    if (keepIds.has(item.model.id)) continue;
    keepIds.add(item.model.id);
    // A second owner claiming an id another owner holds takes it over; the
    // first owner's later unregister will not remove the new claim.
    const collision = updated.findIndex((entry) => entry.id === item.model.id);
    if (collision >= 0) updated.splice(collision, 1);
    changed = true;
    const live: Live = { model: item.model };
    updated.push({
      id: item.model.id,
      owner,
      order: nextOrder++,
      placement: item.options?.placement ?? "docked",
      priority: item.options?.priority ?? APP_BANNER_PRIORITY.default,
      live,
      model: liveModel(live),
    });
  }
  entries = updated;
  if (changed) emit();
}

function releaseOwner(owner: symbol): void {
  const next = entries.filter((entry) => entry.owner !== owner);
  if (next.length === entries.length) return;
  entries = next;
  emit();
}

/**
 * Register a list of app banners owned by the calling component. Pass `[]` (or
 * leave models out) when nothing should show. Each item's `options` picks its
 * placement and priority band.
 */
export function useAppBanners(items: Array<{ model: BannerModel; options?: AppBannerOptions }>): void {
  const ownerRef = useRef<symbol | null>(null);
  if (ownerRef.current == null) ownerRef.current = Symbol("app-banner-owner");
  const owner = ownerRef.current;

  // Every render: cheap, and only emits when something visible changed.
  useEffect(() => {
    syncOwner(owner, items);
  });

  useEffect(() => () => releaseOwner(owner), [owner]);
}

/** Register one app banner while `model` is non-null. */
export function useAppBanner(model: BannerModel | null | false | undefined, options?: AppBannerOptions): void {
  useAppBanners(model ? [{ model, options }] : []);
}

export function useAppBannerEntries(): readonly AppBannerEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Imperative read for tests and diagnostics. */
export function getAppBannerEntries(): readonly AppBannerEntry[] {
  return snapshot;
}

/** Test-only: drop every registration. */
export function resetAppBannersForTests(): void {
  entries = [];
  nextOrder = 0;
  emit();
}
