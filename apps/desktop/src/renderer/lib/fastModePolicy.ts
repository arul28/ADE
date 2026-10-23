/**
 * The renderer's copy of the account-wide Fast-mode permission.
 *
 * The brain owns the answer; this is only what the composer and the Settings
 * row draw. It is deliberately not in `ACCOUNT_SYNCED_SETTINGS`: that engine
 * refuses to write while signed out, and a person using ADE without an account
 * must still be able to turn Fast on. The write goes straight to the account
 * settings store, which keeps a local cache and queues the upload for when the
 * account returns.
 *
 * The value starts **false** (locked), so a cold window, a missing brain, or an
 * unreadable cache never accidentally unlocks a paid tier. `App` hydrates it
 * once, the Settings toggle writes it, and a window focus re-reads it in case
 * another machine changed the account.
 */

import { useSyncExternalStore } from "react";
import {
  FAST_MODE_SETTING_KEY,
  FAST_MODE_SETTING_SCOPE,
  isFastModeEnabledSetting,
} from "../../shared/fastModePolicy";

let enabled = false;
const listeners = new Set<() => void>();
let hydrateInFlight: Promise<void> | null = null;
/**
 * Bumped by every write. A read that started before a write must not apply its
 * stale answer over the optimistic value the person just chose.
 */
let writeGeneration = 0;
/**
 * True once the account API has answered (or a write landed through it). From
 * then on the account is the authority and a session's stamp may only tighten
 * it, never loosen it.
 */
let accountHydrated = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function writeLocal(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  emit();
}

export function getFastModeEnabled(): boolean {
  return enabled;
}

export function subscribeFastModeEnabled(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-read the account row. Best-effort: an unavailable brain keeps the last answer. */
export async function refreshFastModeEnabled(): Promise<void> {
  const generationAtStart = writeGeneration;
  const apply = (next: boolean) => {
    if (generationAtStart !== writeGeneration) return;
    accountHydrated = true;
    writeLocal(next);
  };
  // The hosted web client has no account-settings bridge; its chat adapter
  // carries the one setting over the sync host instead. The desktop preload
  // leaves that namespace absent and uses the account store directly.
  const host = window.ade?.agentChat?.fastModePolicy;
  if (host) {
    try {
      apply(await host.get());
    } catch {
      // Keep the fail-closed value.
    }
    return;
  }
  const api = window.ade?.accountSettings;
  if (!api) return;
  try {
    const result = await api.get({ scope: FAST_MODE_SETTING_SCOPE, key: FAST_MODE_SETTING_KEY });
    if (result.ok) apply(isFastModeEnabledSetting(result.value));
  } catch {
    // Keep the fail-closed value; the next focus or write retries.
  }
}

/** One coalesced read, for a boot effect or a window focus. */
export function hydrateFastModeEnabled(): Promise<void> {
  if (hydrateInFlight) return hydrateInFlight;
  hydrateInFlight = refreshFastModeEnabled().finally(() => {
    hydrateInFlight = null;
  });
  return hydrateInFlight;
}

/**
 * Turn Fast on or off for the account.
 *
 * Optimistic so the switch moves under the finger, then reverted if the store
 * could not take it. Returns false when nothing changed, which is what the
 * Settings row uses to explain the failure instead of leaving a switch that
 * claims something the brain does not believe.
 */
export async function setFastModeEnabled(next: boolean): Promise<boolean> {
  const previous = enabled;
  const generation = ++writeGeneration;
  writeLocal(next);
  const revert = () => {
    if (generation === writeGeneration) writeLocal(previous);
  };
  const host = window.ade?.agentChat?.fastModePolicy;
  if (host) {
    try {
      await host.set(next);
      if (generation === writeGeneration) accountHydrated = true;
      return true;
    } catch {
      revert();
      return false;
    }
  }
  const api = window.ade?.accountSettings;
  if (!api) {
    revert();
    return false;
  }
  try {
    const result = await api.set({
      scope: FAST_MODE_SETTING_SCOPE,
      key: FAST_MODE_SETTING_KEY,
      value: next,
    });
    if (result.ok) {
      if (generation === writeGeneration) accountHydrated = true;
      return true;
    }
  } catch {
    // Fall through to the revert.
  }
  revert();
  return false;
}

/** Read-only subscription. The boot effect and the Settings row do the I/O. */
export function useFastModeEnabled(): boolean {
  return useSyncExternalStore(subscribeFastModeEnabled, getFastModeEnabled, getFastModeEnabled);
}

/**
 * Adopt the answer the owning brain put on a session or on the machine's launch
 * defaults. The hosted web client cannot read the account store at all, and a
 * remote chat's brain is the authority on its own policy, so both surfaces feed
 * the store from what the host sent instead of from a local account read.
 */
export function noteFastModeAllowedFromHost(value: boolean | undefined): void {
  // Once the account itself has answered, a session's stamp may only tighten
  // the answer, never loosen it; the composer ANDs the two, so a stale "true"
  // from a remote chat cannot unlock a locally forbidden account.
  if (accountHydrated) return;
  if (typeof value === "boolean") writeLocal(value);
}
