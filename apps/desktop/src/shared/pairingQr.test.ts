import { describe, expect, it } from "vitest";
import type { SyncPairingConnectInfo, SyncPairingQrPayload } from "./types/sync";
import {
  PAIRING_QR_PAYLOAD_VERSION,
  PAIRING_QR_URL_BASE,
  buildPairingQrPayload,
  encodePairingQrUrl,
  parsePairingQrUrl,
} from "./pairingQr";

const connectInfo: SyncPairingConnectInfo = {
  hostIdentity: {
    deviceId: "device-123",
    siteId: "site-abc",
    name: "Arul's MacBook",
    platform: "macOS",
    deviceType: "desktop",
  },
  port: 8787,
  addressCandidates: [
    { host: "100.64.0.1", kind: "tailscale" },
    { host: "192.168.1.20", kind: "lan" },
    { host: "127.0.0.1", kind: "loopback" },
    { host: "relay.ade-app.dev", kind: "relay" },
  ],
};

describe("pairingQr codec", () => {
  it("round-trips build -> encode -> parse without losing addresses", () => {
    const payload = buildPairingQrPayload({ connectInfo });
    const url = encodePairingQrUrl(payload);

    expect(url.startsWith(`${PAIRING_QR_URL_BASE}#`)).toBe(true);

    const parsed = parsePairingQrUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(PAIRING_QR_PAYLOAD_VERSION);
    expect(parsed?.hostIdentity).toEqual(connectInfo.hostIdentity);
    expect(parsed?.port).toBe(connectInfo.port);
    expect(parsed?.addressCandidates).toEqual(connectInfo.addressCandidates);
  });

  it("carries the payload in the URL fragment so it never reaches a server", () => {
    const url = encodePairingQrUrl(buildPairingQrPayload({ connectInfo }));
    const parsedUrl = new URL(url);
    expect(parsedUrl.search).toBe("");
    expect(parsedUrl.hash.length).toBeGreaterThan(1);
  });

  it("preserves distinct optional relay, claim, and runtime-grant fields", () => {
    const bare = buildPairingQrPayload({ connectInfo });
    expect(bare.relayUrl).toBeUndefined();
    expect(bare.claimToken).toBeUndefined();
    expect(bare.runtimeHostGrant).toBeUndefined();

    const withRelay = buildPairingQrPayload({
      connectInfo,
      relayUrl: "wss://relay.ade-app.dev/tunnel/abc",
      claimToken: "claim-xyz",
      runtimeHostGrant: "runtime-grant-xyz",
    });
    const parsed = parsePairingQrUrl(encodePairingQrUrl(withRelay));
    expect(parsed?.relayUrl).toBe("wss://relay.ade-app.dev/tunnel/abc");
    expect(parsed?.claimToken).toBe("claim-xyz");
    expect(parsed?.runtimeHostGrant).toBe("runtime-grant-xyz");
  });

  it("round-trips an optional literal pinConfigured hint", () => {
    const absent = parsePairingQrUrl(encodePairingQrUrl(buildPairingQrPayload({ connectInfo })));
    const configured = parsePairingQrUrl(encodePairingQrUrl(buildPairingQrPayload({
      connectInfo,
      pinConfigured: true,
    })));
    const notConfigured = parsePairingQrUrl(encodePairingQrUrl(buildPairingQrPayload({
      connectInfo,
      pinConfigured: false,
    })));

    expect(absent?.pinConfigured).toBeUndefined();
    expect(configured?.pinConfigured).toBe(true);
    expect(notConfigured?.pinConfigured).toBe(false);
  });

  it("ignores a non-Boolean pinConfigured value", () => {
    const payload = {
      ...buildPairingQrPayload({ connectInfo }),
      pinConfigured: "false",
    } as unknown as Parameters<typeof encodePairingQrUrl>[0];

    expect(parsePairingQrUrl(encodePairingQrUrl(payload))?.pinConfigured).toBeUndefined();
  });

  it("drops a relayUrl that is not a wss:// URL", () => {
    const parsed = parsePairingQrUrl(
      encodePairingQrUrl(buildPairingQrPayload({ connectInfo, relayUrl: "http://evil.example" })),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.relayUrl).toBeUndefined();
  });

  it("tolerates unknown extra fields (old app scanning a newer QR)", () => {
    const payload = {
      ...buildPairingQrPayload({ connectInfo }),
      futureFeature: { nested: true },
      extraFlag: 42,
    } as unknown as SyncPairingQrPayload;
    const parsed = parsePairingQrUrl(encodePairingQrUrl(payload));
    expect(parsed).not.toBeNull();
    expect(parsed?.hostIdentity.deviceId).toBe("device-123");
    // Unknown fields are ignored, not surfaced.
    expect((parsed as Record<string, unknown>).futureFeature).toBeUndefined();
  });

  it("keeps pinConfigured additive for an old parser", () => {
    const url = encodePairingQrUrl(buildPairingQrPayload({
      connectInfo,
      pinConfigured: false,
    }));
    const fragment = url.slice(url.indexOf("#") + 1)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = fragment + "=".repeat((4 - (fragment.length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
    const legacyPayload = {
      version: decoded.version,
      hostIdentity: decoded.hostIdentity,
      port: decoded.port,
      addressCandidates: decoded.addressCandidates,
    };

    expect(legacyPayload).toEqual({
      version: PAIRING_QR_PAYLOAD_VERSION,
      hostIdentity: connectInfo.hostIdentity,
      port: connectInfo.port,
      addressCandidates: connectInfo.addressCandidates,
    });
  });

  it("accepts a bare base64url/JSON payload defensively", () => {
    const url = encodePairingQrUrl(buildPairingQrPayload({ connectInfo }));
    const fragment = url.slice(url.indexOf("#") + 1);
    const parsed = parsePairingQrUrl(fragment);
    expect(parsed?.hostIdentity.deviceId).toBe("device-123");
  });

  it("preserves browser host device types", () => {
    const parsed = parsePairingQrUrl(encodePairingQrUrl({
      ...buildPairingQrPayload({ connectInfo }),
      hostIdentity: {
        ...connectInfo.hostIdentity,
        deviceType: "browser",
      },
    }));

    expect(parsed?.hostIdentity.deviceType).toBe("browser");
  });

  it("returns null for garbage, wrong host, and missing identity", () => {
    expect(parsePairingQrUrl("")).toBeNull();
    expect(parsePairingQrUrl("not a url")).toBeNull();
    expect(parsePairingQrUrl("https://ade-app.dev/pair")).toBeNull();
    expect(parsePairingQrUrl("https://evil.example/pair#abc")).toBeNull();
    expect(parsePairingQrUrl("https://ade-app.dev/pair#%%%")).toBeNull();

    const noIdentity = encodePairingQrUrl({
      version: PAIRING_QR_PAYLOAD_VERSION,
      hostIdentity: { deviceId: "", siteId: "", name: "", platform: "unknown", deviceType: "unknown" },
      port: 8787,
      addressCandidates: [],
    } as unknown as SyncPairingQrPayload);
    expect(parsePairingQrUrl(noIdentity)).toBeNull();
  });

  it("rejects an out-of-range or non-numeric port", () => {
    const badPort = encodePairingQrUrl({
      ...buildPairingQrPayload({ connectInfo }),
      port: 70_000,
    });
    expect(parsePairingQrUrl(badPort)).toBeNull();
  });

  it("rejects an older payload version (forward-only)", () => {
    const stale = encodePairingQrUrl({
      ...buildPairingQrPayload({ connectInfo }),
      version: (PAIRING_QR_PAYLOAD_VERSION - 1) as SyncPairingQrPayload["version"],
    });
    expect(parsePairingQrUrl(stale)).toBeNull();
  });

  it("rejects an oversized payload", () => {
    const oversized = `${PAIRING_QR_URL_BASE}#${"A".repeat(9 * 1024)}`;
    expect(parsePairingQrUrl(oversized)).toBeNull();
  });
});
