import { describe, expect, it } from "vitest";
import {
  buildPairingQrPayload,
  encodePairingQrUrl,
} from "../../../shared/pairingQr";
import type { SyncPairingConnectInfo } from "../../../shared/types/sync";
import { parseRemoteRuntimePairingInput } from "./pairingInput";

const connectInfo: SyncPairingConnectInfo = {
  hostIdentity: {
    deviceId: "host-1",
    siteId: "site-1",
    name: "Studio",
    platform: "macOS",
    deviceType: "desktop",
  },
  port: 8787,
  addressCandidates: [
    { host: "100.70.0.2", kind: "tailscale" },
    { host: "192.168.1.20", kind: "lan" },
  ],
};

describe("parseRemoteRuntimePairingInput", () => {
  it("normalizes a full pairing URL", () => {
    const parsed = parseRemoteRuntimePairingInput(encodePairingQrUrl(
      buildPairingQrPayload({
        connectInfo,
        relayUrl: "wss://relay.example/connect/machine-1",
      }),
    ));

    expect(parsed).toEqual({
      hostIdentity: connectInfo.hostIdentity,
      machineName: "Studio",
      endpoints: [
        "ws://192.168.1.20:8787/",
        "ws://100.70.0.2:8787/",
        "wss://relay.example/connect/machine-1",
      ],
      relayUrl: "wss://relay.example/connect/machine-1",
      requiresPin: true,
    });
  });

  it("accepts the bare encoded payload", () => {
    const url = encodePairingQrUrl(buildPairingQrPayload({ connectInfo }));
    const parsed = parseRemoteRuntimePairingInput(url.split("#")[1]!);
    expect(parsed.hostIdentity.deviceId).toBe("host-1");
    expect(parsed.endpoints).toEqual([
      "ws://192.168.1.20:8787/",
      "ws://100.70.0.2:8787/",
    ]);
  });

  it("preserves the server-issued runtime host grant", () => {
    const url = encodePairingQrUrl(buildPairingQrPayload({
      connectInfo,
      runtimeHostGrant: "runtime-grant-1",
    }));
    expect(parseRemoteRuntimePairingInput(url).runtimeHostGrant).toBe("runtime-grant-1");
  });

  it("rejects garbage", () => {
    expect(() => parseRemoteRuntimePairingInput("not-a-pairing-code"))
      .toThrow(/invalid ADE pairing link or code/i);
  });
});
