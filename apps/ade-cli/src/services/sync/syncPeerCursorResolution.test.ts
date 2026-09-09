import { describe, expect, it } from "vitest";

import { resolveInitialPeerCursor } from "./syncPeerCursorResolution";

describe("resolveInitialPeerCursor", () => {
  it("rejects a claim past this DB's own version when the host has no delivery record", () => {
    // The exact production shape: an iOS build folded its local write clock
    // into `dbVersionBySite[hostSiteId]`, so it advertised a host cursor no
    // host row ever occupied. Trusting it skipped every host row below it.
    expect(resolveInitialPeerCursor({
      claimed: 60_210_853,
      hostWatermark: null,
      hostDbVersion: 4_120,
    })).toEqual({ cursor: 0, reason: "impossible_claim", rewound: true });
  });

  it("clamps a claim above the host's delivered watermark down to the watermark", () => {
    expect(resolveInitialPeerCursor({
      claimed: 60_210_853,
      hostWatermark: 4_090,
      hostDbVersion: 4_120,
    })).toEqual({ cursor: 4_090, reason: "watermark_clamp", rewound: true });
  });

  it("keeps a reinstalled phone's lower claim instead of pushing it up to the watermark", () => {
    // A wiped or reinstalled device legitimately restarts at 0. The watermark
    // is a ceiling, never a floor — raising it here would permanently skip the
    // backlog the fresh replica actually needs.
    expect(resolveInitialPeerCursor({
      claimed: 0,
      hostWatermark: 4_090,
      hostDbVersion: 4_120,
    })).toEqual({ cursor: 0, reason: "watermark_clamp", rewound: false });
  });

  it("trusts an ordinary claim at or below the host's current version", () => {
    expect(resolveInitialPeerCursor({
      claimed: 4_100,
      hostWatermark: null,
      hostDbVersion: 4_120,
    })).toEqual({ cursor: 4_100, reason: "claim_trusted", rewound: false });
    expect(resolveInitialPeerCursor({
      claimed: 4_120,
      hostWatermark: null,
      hostDbVersion: 4_120,
    })).toEqual({ cursor: 4_120, reason: "claim_trusted", rewound: false });
  });

  it("normalizes negative, fractional, and non-finite inputs", () => {
    expect(resolveInitialPeerCursor({ claimed: -5, hostWatermark: null, hostDbVersion: 10 }).cursor).toBe(0);
    expect(resolveInitialPeerCursor({ claimed: 7.9, hostWatermark: null, hostDbVersion: 10 }).cursor).toBe(7);
    expect(resolveInitialPeerCursor({ claimed: 9, hostWatermark: Number.NaN, hostDbVersion: 10 }))
      .toEqual({ cursor: 9, reason: "claim_trusted", rewound: false });
  });

  it("does not report a rewind for a zero claim the host cannot corroborate", () => {
    expect(resolveInitialPeerCursor({ claimed: 0, hostWatermark: null, hostDbVersion: 0 }))
      .toEqual({ cursor: 0, reason: "claim_trusted", rewound: false });
  });
});
