/**
 * Host-side resolution of the changeset cursor a replica peer claims in hello.
 *
 * The claim (`dbVersionBySite[hostSiteId]`) is peer-authored, and a peer can
 * inflate it: an iOS build folded its own local write clock into the value it
 * advertised for the HOST's site. The host exports only `db_version > cursor`,
 * so every host row inside the inflated span is skipped forever — reconnects
 * and the mobile replica reseed both start from the same poisoned claim.
 *
 * The host therefore never trusts the claim above its own record of what it
 * actually delivered. That record is the local-only
 * `sync_peer_changeset_watermarks` table (see kvDb's
 * LOCAL_ONLY_CRR_EXCLUDED_TABLES): host-authored, never a CRR, never synced.
 */

export type SyncPeerCursorReason =
  /** Host has a delivery record and the claim exceeded it. */
  | "watermark_clamp"
  /** No delivery record, and the claim is past anything this DB has ever had. */
  | "impossible_claim"
  /** Claim is at or below what the host knows it sent; take the peer at its word. */
  | "claim_trusted";

export type SyncPeerCursorResolution = {
  cursor: number;
  reason: SyncPeerCursorReason;
  /** True when the resolved cursor is strictly below the claim. */
  rewound: boolean;
};

function normalizeVersion(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

/**
 * Resolve the cursor the host will export from.
 *
 * - A host watermark exists → `min(claimed, watermark)`. A reinstalled or
 *   reset phone legitimately claims LESS than the host once delivered, and
 *   that lower claim wins so it is reseeded rather than clamped forward.
 * - No watermark and `claimed > hostDbVersion` → 0. This DB never produced
 *   that version, so the claim is poisoned and the peer needs a full replay.
 * - Otherwise → the claim.
 */
export function resolveInitialPeerCursor(args: {
  claimed: number;
  hostWatermark: number | null | undefined;
  hostDbVersion: number;
}): SyncPeerCursorResolution {
  const claimed = normalizeVersion(args.claimed) ?? 0;
  const hostWatermark = normalizeVersion(args.hostWatermark);
  const hostDbVersion = normalizeVersion(args.hostDbVersion) ?? 0;

  if (hostWatermark != null) {
    const cursor = Math.min(claimed, hostWatermark);
    return { cursor, reason: "watermark_clamp", rewound: cursor < claimed };
  }
  if (claimed > hostDbVersion) {
    return { cursor: 0, reason: "impossible_claim", rewound: claimed > 0 };
  }
  return { cursor: claimed, reason: "claim_trusted", rewound: false };
}
