/**
 * Durable, fingerprint-aware dismissal for the consolidated integration banners.
 *
 * The old connection/health banners each dismissed into an in-memory Zustand map
 * that was lost on restart — so a banner the user knowingly dismissed would flash
 * back the next time they opened ADE. This store is backed by localStorage
 * (durable in the Electron renderer) so a dismissal survives restart, project
 * close/reopen, and app updates.
 *
 * A dismissal is scoped to a `fingerprint`: a short string describing the exact
 * state the user dismissed (e.g. the GitHub App block kind, or the gh-token
 * sub-state). When the underlying state regresses to something different — or the
 * same problem returns after being healthy — the fingerprint no longer matches
 * and the banner resurfaces. A dismissal also auto-expires after a grace window,
 * so a still-broken integration re-nudges the user roughly every two weeks.
 *
 * Modeled on `staleCliNoticeSnooze.ts` (see that file for the localStorage
 * pattern). All storage access is wrapped in try/catch so it is safe under the
 * browser-mock renderer and test environments that lack real storage.
 */

import { useCallback, useState } from "react";

const STORAGE_KEY = "ade.bannerDismiss.v1";

/** Default resurface window: a dismissed-but-still-broken banner returns after ~2 weeks. */
export const BANNER_DISMISS_GRACE_MS = 14 * 24 * 3_600e3;

type DismissEntry = { fingerprint: string; dismissedAt: number };
type DismissMap = Record<string, DismissEntry>;

function readMap(): DismissMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: DismissMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      const fingerprint = entry.fingerprint;
      const dismissedAt = entry.dismissedAt;
      if (typeof fingerprint === "string" && typeof dismissedAt === "number" && Number.isFinite(dismissedAt)) {
        out[key] = { fingerprint, dismissedAt };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: DismissMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // best effort — storage may be unavailable
  }
}

/**
 * Record that the user dismissed `key` while it was showing `fingerprint`. Also
 * prunes entries older than the grace window so the map can't grow unbounded.
 */
export function dismissBanner(key: string, fingerprint: string, nowMs: number = Date.now()): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  const map = readMap();
  map[trimmed] = { fingerprint, dismissedAt: nowMs };
  for (const [k, entry] of Object.entries(map)) {
    if (k !== trimmed && nowMs - entry.dismissedAt >= BANNER_DISMISS_GRACE_MS) delete map[k];
  }
  writeMap(map);
}

/**
 * Remove any dismissal recorded for `key`. Called when a banner's underlying
 * condition becomes healthy so a later regression to the SAME state resurfaces a
 * fresh banner (instead of staying suppressed under the old fingerprint for the
 * rest of the grace window). No-op when the key is absent; storage-guarded.
 */
export function clearBannerDismissal(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  try {
    const map = readMap();
    if (!(trimmed in map)) return;
    delete map[trimmed];
    writeMap(map);
  } catch {
    // best effort — storage may be unavailable
  }
}

/**
 * True only when the user dismissed this exact `fingerprint` within `graceMs`.
 * A differing fingerprint (state changed/regressed) or an elapsed grace window
 * both resurface the banner.
 */
export function isBannerDismissed(
  key: string,
  fingerprint: string,
  graceMs: number = BANNER_DISMISS_GRACE_MS,
  nowMs: number = Date.now(),
): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  const entry = readMap()[trimmed];
  if (!entry) return false;
  if (entry.fingerprint !== fingerprint) return false;
  return nowMs - entry.dismissedAt < graceMs;
}

/**
 * Fingerprint-agnostic check: was `key` dismissed at all within `graceMs`? Used
 * by lazy-load heuristics (e.g. delaying GitHub status polling for users who
 * already dismissed the GitHub banner) where the current fingerprint isn't known
 * yet at decision time.
 */
export function hasRecentBannerDismissal(
  key: string,
  graceMs: number = BANNER_DISMISS_GRACE_MS,
  nowMs: number = Date.now(),
): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  const entry = readMap()[trimmed];
  if (!entry) return false;
  return nowMs - entry.dismissedAt < graceMs;
}

export type BannerDismissals = {
  isDismissed: (key: string, fingerprint: string) => boolean;
  dismiss: (key: string, fingerprint: string) => void;
  clear: (key: string) => void;
};

/**
 * Hook wrapper over the durable store. Holds a small version counter so a
 * dismissal (or a clear) re-renders the host (which re-reads the store during
 * render and filters the just-dismissed banner out).
 */
export function useBannerDismissals(): BannerDismissals {
  const [, bump] = useState(0);
  const isDismissed = useCallback(
    (key: string, fingerprint: string) => isBannerDismissed(key, fingerprint),
    [],
  );
  const dismiss = useCallback((key: string, fingerprint: string) => {
    dismissBanner(key, fingerprint);
    bump((n) => n + 1);
  }, []);
  const clear = useCallback((key: string) => {
    // Only re-render when there was actually a live dismissal to clear — keeps
    // the "clear-on-healthy" effect from bumping on every state change.
    const hadDismissal = hasRecentBannerDismissal(key);
    clearBannerDismissal(key);
    if (hadDismissal) bump((n) => n + 1);
  }, []);
  return { isDismissed, dismiss, clear };
}
