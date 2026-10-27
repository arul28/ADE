import { useCallback, useEffect, useRef, useState } from "react";

import { stripElectronErrorWrapper } from "../../../shared/codedError";
import type { OpenProjectBinding } from "../../../shared/types/core";

export type LaneGitRemoteStatus = "idle" | "loading" | "ready" | "error";

export type LaneGitRemoteState = {
  remoteUrl: string | null;
  branch: string | null;
  status: LaneGitRemoteStatus;
  error: string | null;
  /** Restarts the read from the first attempt and clears any pending retry. */
  refetch: () => void;
};

/**
 * Backoff between automatic retries, in milliseconds. Three retries, then the
 * hook stops and waits for `refetch()`.
 */
export const LANE_GIT_REMOTE_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;

const NO_GIT_BRIDGE_MESSAGE = "Git is unavailable in this window.";

const LAST_GOOD_REMOTE_MAX = 64;

/**
 * Reads one lane's origin remote and current branch, and says which of the four
 * things is true: nothing asked yet, a read in flight, a finished read, or a
 * failed read with its message.
 *
 * The single boolean this replaces could not tell "this lane has no remote"
 * apart from "the read failed or has not finished". A transient failure at
 * window start therefore disabled Cursor Cloud with the sentence "This lane has
 * no GitHub remote", for a lane that has one, until the user switched lanes.
 *
 * A failed read retries on its own (1 s, 3 s, 8 s) while the lane stays
 * selected, then stops. `status` stays "error" across those retries so the
 * message the user reads does not flicker between the failure and "checking".
 * Every read is cancelled on a lane change and on unmount, so a slow answer for
 * the previous lane can never overwrite the current lane's values.
 */
export function useLaneGitRemote(
  laneId: string | null,
  pin?: OpenProjectBinding | null,
): LaneGitRemoteState {
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [status, setStatus] = useState<LaneGitRemoteStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  // The last good answer per lane and machine, for this caller. The Work chat
  // pane stays mounted across chat switches; switching back to a lane it has
  // read shows that answer at once while a re-read confirms it, instead of
  // going idle, loading, ready (three renders) for an answer that had not
  // changed. A failed re-read still reports its failure.
  const lastGoodRemoteByLaneRef = useRef(new Map<string, { remoteUrl: string | null; branch: string | null }>());

  // The pin object is rebuilt on every render by some callers, so the effect
  // keys off its stable `key` instead and reads the object itself from a ref.
  // A chat handed to another machine keeps its lane id, so the binding has to
  // be part of what restarts the read.
  const pinRef = useRef<OpenProjectBinding | null | undefined>(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;

  const refetch = useCallback(() => {
    setGeneration((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!laneId) {
      setRemoteUrl(null);
      setBranch(null);
      setStatus("idle");
      setError(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cacheKey = `${pinKey ?? ""}\u0000${laneId}`;
    const lastGoodRemoteByLane = lastGoodRemoteByLaneRef.current;
    const known = lastGoodRemoteByLane.get(cacheKey);

    // A new lane means the previous lane's answer is wrong, not stale-but-close;
    // this lane's own last answer is the one to show while it is re-read.
    setRemoteUrl(known ? known.remoteUrl : null);
    setBranch(known ? known.branch : null);
    setError(null);
    setStatus(known ? "ready" : "loading");

    const run = (attempt: number) => {
      const getOriginRemote = window.ade.git?.getOriginRemote;
      if (!getOriginRemote) {
        setStatus("error");
        setError(NO_GIT_BRIDGE_MESSAGE);
        return;
      }
      const activePin = pinRef.current;
      const request = activePin
        ? getOriginRemote({ laneId }, activePin)
        : getOriginRemote({ laneId });
      void request
        .then((info) => {
          if (cancelled) return;
          const next = { remoteUrl: info?.remoteUrl ?? null, branch: info?.branch ?? null };
          lastGoodRemoteByLane.delete(cacheKey);
          lastGoodRemoteByLane.set(cacheKey, next);
          if (lastGoodRemoteByLane.size > LAST_GOOD_REMOTE_MAX) {
            lastGoodRemoteByLane.delete(lastGoodRemoteByLane.keys().next().value!);
          }
          setRemoteUrl(next.remoteUrl);
          setBranch(next.branch);
          setError(null);
          setStatus("ready");
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          const raw = caught instanceof Error ? caught.message : String(caught);
          lastGoodRemoteByLane.delete(cacheKey);
          setError(stripElectronErrorWrapper(raw) || "The git remote read failed.");
          setStatus("error");
          const delay = LANE_GIT_REMOTE_RETRY_DELAYS_MS[attempt];
          if (delay == null) return;
          timer = setTimeout(() => {
            timer = null;
            if (cancelled) return;
            run(attempt + 1);
          }, delay);
        });
    };

    run(0);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [generation, laneId, pinKey]);

  return { remoteUrl, branch, status, error, refetch };
}
