import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import {
  ADE_LOGO_REVEAL_SECONDS,
  AdeLogoReveal,
  adeLogoRevealWordmarkBox,
  type AdeLogoRevealProps,
  type ScreenBox,
} from "../ui/LiquidGlassLogoReveal";

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
 *
 * The after-update "What's new" waits for the splash to go, then flies the
 * logo from where the splash left it (`afterBootSplash`, `bootSplashLogoBox`).
 */

// The logo texture takes a moment to build before the reveal starts; past that, the reveal's own length.
const HOLD_CAP_MS = 1500 + ADE_LOGO_REVEAL_SECONDS * 1000;
// A logo box older than this is stale: the splash left long enough ago that nothing on screen continues it.
const LOGO_BOX_FRESH_MS = 400;

let shownAt: number | null = null;
let playingSince: number | null = null;
let finished = false;
let mounted = 0;
let logoBox: ScreenBox | null = null;
let goneAt: number | null = null;
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

/** The boot splash is off screen for good: it finished and went, or it never showed. */
function bootSplashGone(): boolean {
  return mounted === 0 && (finished || shownAt === null);
}

/** Runs `run` once the boot splash is gone (at once when it already is). Returns a cancel. */
export function afterBootSplash(run: () => void): () => void {
  if (bootSplashGone()) {
    run();
    return () => undefined;
  }
  const listener = () => {
    if (!bootSplashGone()) return;
    listeners.delete(listener);
    run();
  };
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Where the wordmark sat in the splash that just went, or null when none went just now. */
export function bootSplashLogoBox(): ScreenBox | null {
  if (!logoBox || goneAt === null || performance.now() - goneAt > LOGO_BOX_FRESH_MS) return null;
  return logoBox;
}

export function BootSplashReveal({
  tileSize = 300,
  ...props
}: Omit<AdeLogoRevealProps, "startTime" | "onPlaying" | "onFinished">) {
  const boxRef = useRef<HTMLDivElement>(null);
  // Read once per mount: where the shared reveal is now.
  const [startTime] = useState(() => {
    if (finished) return ADE_LOGO_REVEAL_SECONDS;
    return playingSince === null ? 0 : (performance.now() - playingSince) / 1000;
  });
  // Before the guard's effects run, so its first re-render already holds.
  useLayoutEffect(() => {
    markShown();
    mounted += 1;
    const box = boxRef.current;
    return () => {
      // The last frame stays on screen until this unmounts, so this is where the logo was.
      if (box?.isConnected) {
        const rect = box.getBoundingClientRect();
        logoBox = adeLogoRevealWordmarkBox(rect, tileSize);
      }
      goneAt = performance.now();
      mounted -= 1;
      notify();
    };
  }, [tileSize]);
  return (
    <div ref={boxRef} className={props.className} style={props.style}>
      <AdeLogoReveal
        {...props}
        className="h-full w-full"
        style={undefined}
        tileSize={tileSize}
        startTime={startTime}
        onPlaying={() => markPlaying(startTime)}
        onFinished={markFinished}
      />
    </div>
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
