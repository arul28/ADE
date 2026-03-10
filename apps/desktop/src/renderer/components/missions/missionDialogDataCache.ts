import type { PhaseCard, PhaseProfile } from "../../../shared/types";

const MISSION_DIALOG_DATA_TTL_MS = 5 * 60_000;

type CacheEntry<T> = {
  value: T;
  cachedAt: number;
};

let phaseProfilesEntry: CacheEntry<PhaseProfile[]> | null = null;
let phaseItemsEntry: CacheEntry<PhaseCard[]> | null = null;

function isFresh(entry: CacheEntry<unknown> | null): boolean {
  return entry != null && Date.now() - entry.cachedAt < MISSION_DIALOG_DATA_TTL_MS;
}

export function getCachedPhaseProfiles(): PhaseProfile[] | null {
  return phaseProfilesEntry?.value ?? null;
}

export function hasFreshPhaseProfiles(): boolean {
  return isFresh(phaseProfilesEntry);
}

export function setCachedPhaseProfiles(value: PhaseProfile[]): void {
  phaseProfilesEntry = { value, cachedAt: Date.now() };
}

export function getCachedPhaseItems(): PhaseCard[] | null {
  return phaseItemsEntry?.value ?? null;
}

export function hasFreshPhaseItems(): boolean {
  return isFresh(phaseItemsEntry);
}

export function setCachedPhaseItems(value: PhaseCard[]): void {
  phaseItemsEntry = { value, cachedAt: Date.now() };
}
