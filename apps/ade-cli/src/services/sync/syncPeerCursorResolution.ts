/**
 * Host-side resolution of the changeset cursor a replica peer claims in hello.
 *
 * The claim (`dbVersionBySite[hostSiteId]`) is peer-authored, and a peer can
 * inflate it: an iOS build folded its own local write clock into the value it
 * advertised for the HOST's site. The host exports only `db_version > cursor`,
 * so every host row inside the inflated span is skipped forever — reconnects
 * and the mobile replica reseed both start from the same poisoned claim.
 *
 * Crucially, a poisoned claim is usually *below* the host's current
 * `db_version`, not above it: the phone's CRR clock is seeded from the host's
 * own numbering, so an inflated claim looks exactly like an ordinary
 * up-to-date one. The host cannot tell them apart by inspection. The only
 * value it can trust is its own record of what it actually delivered — the
 * local-only `sync_peer_changeset_watermarks` table (see kvDb's
 * LOCAL_ONLY_CRR_EXCLUDED_TABLES): host-authored, never a CRR, never synced.
 *
 * So the rule is not "detect the bad claim", it is "never export from a claim
 * the host has no delivery record for".
 */

export type SyncPeerCursorReason =
  /** Host has a delivery record for this peer + site; the claim is capped by it. */
  | "watermark_clamp"
  /** No delivery record for this peer + site: one full replay, from 0. */
  | "no_watermark_full_replay";

export type SyncPeerCursorResolution = {
  cursor: number;
  reason: SyncPeerCursorReason;
  /** True when the resolved cursor is strictly below the claim. */
  rewound: boolean;
  /**
   * Log-only detail. A claim past this DB's own version is provably bogus, but
   * it is *not* a separate rule: the resolution is the same either way, and
   * relying on it was the bug — the field-observed poisoned claims sat below
   * `hostDbVersion` and sailed through.
   */
  claimExceededHostDbVersion: boolean;
};

function normalizeVersion(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

/**
 * Resolve the cursor the host will export from.
 *
 * - A host watermark exists for this peer + host site → `min(claimed,
 *   watermark)`. The watermark is a ceiling, never a floor: a reinstalled or
 *   reset phone legitimately claims LESS than the host once delivered, and
 *   that lower claim wins so it is reseeded rather than clamped forward.
 * - No watermark → `0`, regardless of the claim. The host has no evidence it
 *   ever sent this peer anything from this site, so it replays everything.
 *
 * Cost: exactly one full changeset replay per device per host site, on the
 * first connection after this host learned the rule. The host writes the
 * watermark row as soon as it resolves the cursor and advances it on every
 * ack, so the replay is not repeated on the next reconnect — and it resumes
 * from the last ack rather than restarting if the peer dies mid-replay.
 */
export function resolveInitialPeerCursor(args: {
  claimed: number;
  hostWatermark: number | null | undefined;
  hostDbVersion: number;
}): SyncPeerCursorResolution {
  const claimed = normalizeVersion(args.claimed) ?? 0;
  const hostWatermark = normalizeVersion(args.hostWatermark);
  const hostDbVersion = normalizeVersion(args.hostDbVersion) ?? 0;
  const claimExceededHostDbVersion = claimed > hostDbVersion;

  if (hostWatermark != null) {
    const cursor = Math.min(claimed, hostWatermark);
    return {
      cursor,
      reason: "watermark_clamp",
      rewound: cursor < claimed,
      claimExceededHostDbVersion,
    };
  }
  return {
    cursor: 0,
    reason: "no_watermark_full_replay",
    rewound: claimed > 0,
    claimExceededHostDbVersion,
  };
}
