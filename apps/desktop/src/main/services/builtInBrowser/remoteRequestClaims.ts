/**
 * One forwarded `ade browser open`, one answering panel.
 *
 * A request published by a headless machine's daemon is delivered to every
 * desktop panel pinned to it. A request that names a lane or a chat is filtered
 * by the panels themselves, but one that names neither belongs to whichever
 * panel is willing to take it — and "whichever" was every panel at once. Two
 * ADE windows both showing the Browser tool for the same machine therefore both
 * navigated and both acked, so the URL opened twice and the second ack landed on
 * a requestId nobody was waiting on.
 *
 * The panels that race live in different renderers, so the arbitration has to
 * happen in the one process they share. First claim wins; every later claim for
 * the same id is refused.
 */

/** How long a claimed id is remembered. Long enough to outlive the requester's
 *  own 5s timeout and any retry that follows it, short enough that a desktop
 *  left open for a week is not remembering a day of ids. */
export const REMOTE_REQUEST_CLAIM_TTL_MS = 60_000;

/** Hard ceiling on remembered ids, so a flood cannot grow this without bound. */
export const REMOTE_REQUEST_CLAIM_MAX = 500;

export type RemoteRequestClaims = {
  /** True for the first caller with this id, false for every later one. */
  claim: (requestId: string) => boolean;
  /** Ids currently remembered. Tests only. */
  size: () => number;
};

export function createRemoteRequestClaims(options: {
  ttlMs?: number;
  max?: number;
  now?: () => number;
} = {}): RemoteRequestClaims {
  const ttlMs = Math.max(0, options.ttlMs ?? REMOTE_REQUEST_CLAIM_TTL_MS);
  const max = Math.max(1, options.max ?? REMOTE_REQUEST_CLAIM_MAX);
  const now = options.now ?? Date.now;
  /** Insertion-ordered, which is what makes the oldest entry the first one out. */
  const claimedAt = new Map<string, number>();

  const dropExpired = (at: number): void => {
    for (const [id, stamp] of claimedAt) {
      // Insertion order is chronological, so the first live entry ends the sweep.
      if (at - stamp < ttlMs) break;
      claimedAt.delete(id);
    }
  };

  return {
    claim(requestId: string): boolean {
      // An id we cannot tell apart from another cannot be arbitrated, and
      // refusing it would make an older daemon's unlabelled request unanswerable
      // by anyone. Let it through and keep today's behaviour.
      if (typeof requestId !== "string" || !requestId) return true;
      const at = now();
      dropExpired(at);
      if (claimedAt.has(requestId)) return false;
      claimedAt.set(requestId, at);
      while (claimedAt.size > max) {
        const oldest = claimedAt.keys().next();
        if (oldest.done) break;
        claimedAt.delete(oldest.value);
      }
      return true;
    },
    size: () => claimedAt.size,
  };
}
