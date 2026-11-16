import { useEffect, useRef, useState } from "react";
import type { CtoAvatarState } from "../../../../shared/types/cto";

/** How long the "done" hop and the "that failed" shake stay on screen. */
export const CTO_AVATAR_BLIP_MS = 1400;

export type CtoAvatarStateInput = {
  /**
   * The CTO session's status, as any ADE surface spells it: the chat session
   * status (`active`, `idle`, `ended`) or a work-row status (`running`,
   * `awaiting-input`, `failed`, ...).
   */
  status?: string | null;
  /** The CTO asked the person something and is blocked on the answer. */
  awaitingInput?: boolean;
  /** The live turn is writing its reply (text deltas are arriving). */
  streamingText?: boolean;
  /** The most recent turn ended in a failure. */
  lastTurnFailed?: boolean;
  /** The CTO's machine cannot be reached. */
  offline?: boolean;
  /** No model is picked, so the CTO cannot run at all. */
  noModel?: boolean;
};

const BUSY_STATUSES = new Set([
  "active", "running", "working", "busy", "queued", "starting", "streaming", "thinking", "in_progress", "in-progress",
]);
const WAITING_STATUSES = new Set([
  "awaiting-input", "awaiting_input", "waiting", "needs_input", "needs-input", "blocked", "requires_action",
]);
const FAILED_STATUSES = new Set(["failed", "error", "errored", "crashed"]);

/**
 * What the avatar shows for a session, without the short happy/error blips
 * (`useCtoAvatarState` adds those). Asleep beats everything: an offline or
 * model-less CTO cannot be working or waiting, whatever its last status said.
 */
export function deriveCtoAvatarState(input: CtoAvatarStateInput): CtoAvatarState {
  if (input.offline || input.noModel) return "asleep";
  const status = (input.status ?? "").trim().toLowerCase();
  if (input.awaitingInput || WAITING_STATUSES.has(status)) return "waiting";
  if (BUSY_STATUSES.has(status)) return input.streamingText ? "thinking" : "working";
  if (input.lastTurnFailed || FAILED_STATUSES.has(status)) return "error";
  return "idle";
}

const isBusy = (state: CtoAvatarState) => state === "working" || state === "thinking";
const isBlip = (state: CtoAvatarState) => state === "happy" || state === "error";

/**
 * Turns a steady state stream into what the avatar plays.
 *
 * - working/thinking → idle plays `happy` for 1.4 s, then idle;
 * - any change into `error` plays `error` for 1.4 s, then idle (a failed turn
 *   is a moment, not a mood: the avatar does not keep its x-eyes);
 * - a `happy` passed in (a model was just picked) plays once the same way.
 *
 * Any new busy, waiting or asleep state cuts a blip short; a caller that
 * passes `happy` for one render and then `idle` still gets the whole hop.
 */
export function useCtoAvatarState(base: CtoAvatarState): CtoAvatarState {
  const [blip, setBlip] = useState<{ state: CtoAvatarState; until: number } | null>(null);
  const previousRef = useRef<CtoAvatarState>(base);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = base;
    if (previous === base) return;
    const until = Date.now() + CTO_AVATAR_BLIP_MS;
    if (isBlip(base)) setBlip({ state: base, until });
    else if (base === "idle" && isBusy(previous)) setBlip({ state: "happy", until });
    else if (base === "idle" && isBlip(previous)) return;
    else setBlip(null);
  }, [base]);

  // The expiry lives in its own effect so a re-run (StrictMode, a re-render)
  // re-arms the timer instead of leaving a blip on screen forever.
  useEffect(() => {
    if (!blip) return undefined;
    const timer = window.setTimeout(() => setBlip(null), Math.max(0, blip.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [blip]);

  if (blip) return blip.state;
  return isBlip(base) ? "idle" : base;
}
