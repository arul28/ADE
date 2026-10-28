import { useEffect, useLayoutEffect, useReducer, useState } from "react";
import { ADE_LOGO_REVEAL_SECONDS, AdeLogoReveal, type AdeLogoRevealProps } from "../ui/LiquidGlassLogoReveal";

/*
 * The boot splash shows for as long as the boot or its logo reveal, whichever
 * ends later, and never longer: a fast boot still sees the whole reveal, a slow
 * one sees the finished logo until it is done.
 *
 * The reveal plays once per window. One clock is shared by every splash the
 * window mounts (the boot guard, then a Suspense fallback), so a remount
 * carries on where the last one was instead of starting over. Only the boot
 * plays it: once the window shows real content, a later splash (a chunk
 * loading) shows the finished logo and holds nothing. A boot that never showed
 * a splash holds nothing either.
 *
 * Nothing waits when the reveal cannot play: reduced motion, no WebGL, or a
 * logo that failed to load all report "finished" at once. A reveal that cannot
 * finish (its canvas off screen) holds no longer than the cap.
 */

// The logo texture takes a moment to build before the reveal starts; past that, the reveal's own length.
const HOLD_CAP_MS = 1500 + ADE_LOGO_REVEAL_SECONDS * 1000;

let shownAt: number | null = null;
let playingSince: number | null = null;
let finished = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function markShown() {
  if (shownAt !== null || finished) return;
  shownAt = performance.now();
  notify();
}

function markPlaying(startTime: number) {
  if (playingSince !== null) return;
  playingSince = performance.now() - startTime * 1000;
}

function markFinished() {
  if (finished) return;
  finished = true;
  notify();
}

function holdRemainingMs(): number {
  if (shownAt === null || finished) return 0;
  return Math.max(0, shownAt + HOLD_CAP_MS - performance.now());
}

export function BootSplashReveal(props: Omit<AdeLogoRevealProps, "startTime" | "onPlaying" | "onFinished">) {
  // Read once per mount: where the shared reveal is now.
  const [startTime] = useState(() => {
    if (finished) return ADE_LOGO_REVEAL_SECONDS;
    return playingSince === null ? 0 : (performance.now() - playingSince) / 1000;
  });
  // Before the guard's effects run, so its first re-render already holds.
  useLayoutEffect(markShown, []);
  return (
    <AdeLogoReveal
      {...props}
      startTime={startTime}
      onPlaying={() => markPlaying(startTime)}
      onFinished={markFinished}
    />
  );
}

/**
 * True while the boot splash still owes its reveal, so the splash stays until
 * it ends. `booting` is whether the boot guard itself still wants the splash.
 */
export function useBootSplashHold(booting: boolean): boolean {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const remaining = holdRemainingMs();
  const held = remaining > 0;

  useEffect(() => {
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  useEffect(() => {
    if (!held) return;
    const timer = window.setTimeout(rerender, remaining + 16);
    return () => window.clearTimeout(timer);
  }, [held, remaining]);

  const showingSplash = booting || held;
  useEffect(() => {
    // Real content is on screen: the boot is over, whether or not the reveal ever played.
    if (!showingSplash) markFinished();
  }, [showingSplash]);

  return held;
}
