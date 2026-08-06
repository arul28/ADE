import { describe, expect, it } from "vitest";
import { parseHelloPayload, parsePairingRequestPayload } from "./syncHelloProtocol";

const peer = (dbVersion: unknown) => ({
  deviceId: "device-1",
  deviceName: "Phone",
  siteId: "site-1",
  dbVersion,
});

describe("hello payload dbVersion normalization", () => {
  it("floors a peer's dbVersion claim to a finite, non-negative integer", () => {
    for (const [claimed, expected] of [
      [12, 12],
      [12.9, 12],
      ["7", 7],
      [-1, 0],
      ["not a number", 0],
      [Number.POSITIVE_INFINITY, 0],
      [null, 0],
      [undefined, 0],
    ] as Array<[unknown, number]>) {
      const parsed = parseHelloPayload({
        peer: peer(claimed),
        auth: { kind: "bootstrap", token: "t" },
      });
      expect(parsed?.peer.dbVersion, `hello dbVersion=${String(claimed)}`).toBe(expected);

      const paired = parsePairingRequestPayload({ code: "123456", peer: peer(claimed) });
      expect(paired?.peer.dbVersion, `pairing dbVersion=${String(claimed)}`).toBe(expected);
    }
  });
});
