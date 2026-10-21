import { useSyncExternalStore } from "react";
import { ONBOARDING_ANCHOR_ATTR } from "../../../onboarding/onboardingProgress";

/**
 * "Here it is": after something took the user to a place (ADE Tips' "Try it"),
 * a soft ring settles around the control or section that place is about, with
 * one short line beside it, and fades after a few seconds or on any click or
 * Escape. `SpotlightHost` draws it; this module only holds the one request.
 *
 * A request lists the places to ring, best first (the open chat's Tools
 * button, else a chat row, else the chats list): the first one on screen
 * wins, so the same request works whatever the page shows. It waits a
 * bounded time for one to appear (the page is still opening); if none does,
 * the user is simply left where they landed.
 */

export type SpotlightSpot = {
  /** A CSS selector for the element to ring. */
  selector: string;
  /** The line beside the ring: what to do here. */
  label: string;
};

export type SpotlightRequest = {
  spots: readonly SpotlightSpot[];
  /** Ring nothing until this holds (a new chat draft is the page on screen). */
  ready?: () => boolean;
  /** How long to wait for a spot to appear. */
  waitMs?: number;
};

type ActiveSpotlight = SpotlightRequest & { id: number };

let current: ActiveSpotlight | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Rings the first of `request.spots` that shows up. Replaces any spotlight already up. */
export function showSpotlight(request: SpotlightRequest): void {
  current = { ...request, id: nextId++ };
  emit();
}

/** Ends the spotlight `id` (or whichever is up). */
export function clearSpotlight(id?: number): void {
  if (!current || (id != null && current.id !== id)) return;
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = () => current;

export function useSpotlightRequest(): ActiveSpotlight | null {
  return useSyncExternalStore(subscribe, read, read);
}

/** The selector for a control marked `data-onboarding-anchor="<id>"`. */
export function anchorSelector(id: string): string {
  return `[${ONBOARDING_ANCHOR_ATTR}="${id}"]`;
}

/** The selector for a Settings card (`ModernSection` and friends carry both). */
export function settingsCardSelector(anchor: string): string {
  return `[data-settings-anchor="${anchor}"]`;
}
