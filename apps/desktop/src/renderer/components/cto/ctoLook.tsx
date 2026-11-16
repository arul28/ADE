import React, { createContext, useContext, useSyncExternalStore } from "react";
import { DEFAULT_CTO_AVATAR_LOOK, type CtoAvatarLook } from "../../../shared/types/cto";

/**
 * The CTO's look, where the page is not.
 *
 * Two readers sit outside the CTO page's own state: the calm chat rows inside
 * the CTO thread (they draw the 16px avatar), which get it from the context the
 * page provides, and the project sidebar's CTO entry, which reads the last look
 * the page saw for that project. The sidebar copy is kept in localStorage so
 * the entry wears the person's look from the first frame after a restart,
 * without a CTO read of its own.
 */

const CtoLookContext = createContext<CtoAvatarLook | null>(null);

export function CtoLookProvider({ look, children }: { look: CtoAvatarLook; children: React.ReactNode }) {
  return <CtoLookContext.Provider value={look}>{children}</CtoLookContext.Provider>;
}

/** Inside the CTO page: the CTO's look. Anywhere else: the default look. */
export function useCtoLook(): CtoAvatarLook {
  return useContext(CtoLookContext) ?? DEFAULT_CTO_AVATAR_LOOK;
}

/** The page accent: the avatar's colour. */
export function ctoAccentColor(look: CtoAvatarLook | null | undefined): string {
  const color = look?.color?.trim();
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_CTO_AVATAR_LOOK.color;
}

const STORAGE_KEY = "ade.cto.lookByProject.v1";
const listeners = new Set<() => void>();
let cache: Record<string, CtoAvatarLook> | null = null;

function readAll(): Record<string, CtoAvatarLook> {
  if (cache) return cache;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, CtoAvatarLook>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function sameLook(a: CtoAvatarLook | undefined, b: CtoAvatarLook): boolean {
  return Boolean(a) && a!.shape === b.shape && a!.color === b.color && a!.eyes === b.eyes && a!.energy === b.energy;
}

/** Called by the CTO page whenever its identity loads or changes. */
export function rememberCtoLook(scopeKey: string | null | undefined, look: CtoAvatarLook | null | undefined): void {
  if (!scopeKey) return;
  const next = look ?? DEFAULT_CTO_AVATAR_LOOK;
  const all = readAll();
  if (sameLook(all[scopeKey], next)) return;
  cache = { ...all, [scopeKey]: next };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked: the in-memory copy still serves this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The last look the CTO page saw for this project, or the default. */
export function useRememberedCtoLook(scopeKey: string | null | undefined): CtoAvatarLook {
  return useSyncExternalStore(
    subscribe,
    () => (scopeKey ? readAll()[scopeKey] : undefined) ?? DEFAULT_CTO_AVATAR_LOOK,
  );
}
