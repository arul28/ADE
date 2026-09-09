import { describe, expect, it } from "vitest";

import { resolveInitialPeerCursor } from "./syncPeerCursorResolution";

describe("resolveInitialPeerCursor", () => {
  it("replays from zero when the host has no delivery record, even for a plausible claim", () => {
    // The finding that forced this rule: the poisoned claims seen in the field
    // sit BELOW the host's current db_version, so "claim > hostDbVersion" never
    // fires and the host cannot tell a poisoned claim from an honest one. The
    // absence of a watermark is the only signal it actually has.
    expect(resolveInitialPeerCursor({
      claimed: 4_100,
      hostWatermark: null,
      hostDbVersion: 4_120,
    })).toEqual({
      cursor: 0,
      reason: "no_watermark_full_replay",
      rewound: true,
      claimExceededHostDbVersion: false,
    });
  });

  it("still replays from zero for a claim past this DB's own version", () => {
    // The exact production shape: an iOS build folded its local write clock
    // into `dbVersionBySite[hostSiteId]`. Same outcome as any other
    // uncorroborated claim — the impossibility is only extra log detail.
    expect(resolveInitialPeerCursor({
      claimed: 60_210_853,
      hostWatermark: null,
      hostDbVersion: 4_120,
    })).toEqual({
      cursor: 0,
      reason: "no_watermark_full_replay",
      rewound: true,
      claimExceededHostDbVersion: true,
    });
  });

  it("clamps a claim above the host's delivered watermark down to the watermark", () => {
    expect(resolveInitialPeerCursor({
      claimed: 60_210_853,
      hostWatermark: 4_090,
      hostDbVersion: 4_120,
    })).toEqual({
      cursor: 4_090,
      reason: "watermark_clamp",
      rewound: true,
      claimExceededHostDbVersion: true,
    });
  });

  it("keeps a reinstalled phone's lower claim instead of pushing it up to the watermark", () => {
    // A wiped or reinstalled device legitimately restarts at 0. The watermark
    // is a ceiling, never a floor — raising it here would permanently skip the
    // backlog the fresh replica actually needs.
    expect(resolveInitialPeerCursor({
      claimed: 0,
      hostWatermark: 4_090,
      hostDbVersion: 4_120,
    })).toEqual({
      cursor: 0,
      reason: "watermark_clamp",
      rewound: false,
      claimExceededHostDbVersion: false,
    });
  });

  it("trusts a claim at or below the watermark once the host has a record of it", () => {
    // The steady state after the one-time replay: the host has delivered
    // through 4_120 and the peer resumes exactly where it left off.
    expect(resolveInitialPeerCursor({
      claimed: 4_100,
      hostWatermark: 4_120,
      hostDbVersion: 4_120,
    })).toEqual({
      cursor: 4_100,
      reason: "watermark_clamp",
      rewound: false,
      claimExceededHostDbVersion: false,
    });
  });

  it("resumes from a partial replay's watermark rather than restarting at zero", () => {
    // A phone that died mid-replay acked through 1_500. The host wrote that
    // watermark, so the reconnect resumes there instead of resending 1_500
    // rows it already applied.
    expect(resolveInitialPeerCursor({
      claimed: 60_210_853,
      hostWatermark: 1_500,
      hostDbVersion: 4_120,
    }).cursor).toBe(1_500);
  });

  it("treats a zero watermark as a real record, not a missing one", () => {
    // The seed row written at rewind time is exactly 0. If that were read as
    // "no watermark" the peer would be pinned to a full replay forever.
    expect(resolveInitialPeerCursor({
      claimed: 4_100,
      hostWatermark: 0,
      hostDbVersion: 4_120,
    })).toEqual({
      cursor: 0,
      reason: "watermark_clamp",
      rewound: true,
      claimExceededHostDbVersion: false,
    });
  });

  it("normalizes negative, fractional, and non-finite inputs", () => {
    expect(resolveInitialPeerCursor({ claimed: -5, hostWatermark: 10, hostDbVersion: 10 }).cursor).toBe(0);
    expect(resolveInitialPeerCursor({ claimed: 7.9, hostWatermark: 10, hostDbVersion: 10 }).cursor).toBe(7);
    expect(resolveInitialPeerCursor({ claimed: 9, hostWatermark: 8.9, hostDbVersion: 10 }).cursor).toBe(8);
    // A non-finite watermark is not a record at all.
    expect(resolveInitialPeerCursor({ claimed: 9, hostWatermark: Number.NaN, hostDbVersion: 10 }))
      .toEqual({
        cursor: 0,
        reason: "no_watermark_full_replay",
        rewound: true,
        claimExceededHostDbVersion: false,
      });
  });

  it("does not report a rewind for a zero claim the host cannot corroborate", () => {
    expect(resolveInitialPeerCursor({ claimed: 0, hostWatermark: null, hostDbVersion: 0 }))
      .toEqual({
        cursor: 0,
        reason: "no_watermark_full_replay",
        rewound: false,
        claimExceededHostDbVersion: false,
      });
  });
});
