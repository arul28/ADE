import { describe, expect, it } from "vitest";
import {
  buildHostSignatureBase,
  buildPipeSignatureBase,
  CONNECTION_ID_PATTERN,
  generateConnectionId,
  hmacSha256Hex,
  routeTunnelPath,
  verifySignedQuery,
  type TunnelRelayEnv,
} from "../src/relay";
import { TunnelDurableObject } from "../src/tunnelDo";

const MACHINE_KEY = "a".repeat(48);
const SECRET = "s".repeat(48);

// Minimal Durable Object storage stand-in — enough to exercise the claim path
// and the pre-upgrade auth rejections without a live runtime. Socket pairing
// and hibernation are covered by the wrangler-dev smoke test (see README).
class FakeStorage {
  private map = new Map<string, unknown>();
  private alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }
}

function makeDo(): TunnelDurableObject {
  const storage = new FakeStorage();
  const state = {
    storage,
    getWebSockets: () => [],
    acceptWebSocket: () => undefined,
  } as unknown as DurableObjectState;
  return new TunnelDurableObject(state, {} as TunnelRelayEnv);
}

function claimRequest(secret: unknown): Request {
  return new Request(`https://relay.test/machines/${MACHINE_KEY}/claim`, {
    method: "POST",
    body: JSON.stringify({ secret }),
    headers: { "content-type": "application/json" },
  });
}

describe("routeTunnelPath", () => {
  it("matches each tunnel route", () => {
    expect(routeTunnelPath(`/machines/${MACHINE_KEY}/claim`)).toEqual({ kind: "claim", machineKey: MACHINE_KEY });
    expect(routeTunnelPath(`/host/${MACHINE_KEY}`)).toEqual({ kind: "host", machineKey: MACHINE_KEY });
    expect(routeTunnelPath(`/host/${MACHINE_KEY}/pipe/abcdef01`)).toEqual({
      kind: "pipe",
      machineKey: MACHINE_KEY,
      id: "abcdef01",
    });
    expect(routeTunnelPath(`/connect/${MACHINE_KEY}`)).toEqual({ kind: "connect", machineKey: MACHINE_KEY });
  });

  it("rejects bad machine keys and connection ids", () => {
    expect(routeTunnelPath("/host/not-hex")).toBeNull();
    expect(routeTunnelPath(`/host/${MACHINE_KEY}/pipe/NOThex!`)).toBeNull();
    expect(routeTunnelPath(`/machines/${MACHINE_KEY}/publish`)).toBeNull();
    expect(routeTunnelPath("/unknown")).toBeNull();
  });
});

describe("verifySignedQuery", () => {
  it("accepts a correct signature within skew", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const base = buildHostSignatureBase(MACHINE_KEY, ts);
    const sig = await hmacSha256Hex(SECRET, base);
    expect(await verifySignedQuery({ secret: SECRET, base, timestamp: ts, signature: sig })).toEqual({ ok: true });
  });

  it("rejects a tampered signature", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const base = buildPipeSignatureBase(MACHINE_KEY, "abcdef01", ts);
    const sig = await hmacSha256Hex(SECRET, base);
    const result = await verifySignedQuery({
      secret: SECRET,
      base,
      timestamp: ts,
      signature: sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a signature signed for a different id", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signed = buildPipeSignatureBase(MACHINE_KEY, "aaaaaaaa", ts);
    const sig = await hmacSha256Hex(SECRET, signed);
    const attacked = buildPipeSignatureBase(MACHINE_KEY, "bbbbbbbb", ts);
    expect((await verifySignedQuery({ secret: SECRET, base: attacked, timestamp: ts, signature: sig })).ok).toBe(false);
  });

  it("rejects a stale timestamp", async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 60);
    const base = buildHostSignatureBase(MACHINE_KEY, ts);
    const sig = await hmacSha256Hex(SECRET, base);
    const result = await verifySignedQuery({ secret: SECRET, base, timestamp: ts, signature: sig });
    expect(result).toEqual({ ok: false, reason: "stale or invalid timestamp" });
  });

  it("rejects missing ts or sig", async () => {
    expect((await verifySignedQuery({ secret: SECRET, base: "x", timestamp: "", signature: "" })).ok).toBe(false);
  });
});

describe("generateConnectionId", () => {
  it("produces a hex id matching the route pattern", () => {
    for (let i = 0; i < 32; i += 1) {
      const id = generateConnectionId();
      expect(CONNECTION_ID_PATTERN.test(id)).toBe(true);
    }
  });
});

describe("machine claim", () => {
  it("claims once, is idempotent for the same secret, conflicts on a different one", async () => {
    const durable = makeDo();
    const first = await durable.fetch(claimRequest(SECRET));
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true, claimed: true });

    const again = await durable.fetch(claimRequest(SECRET));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, claimed: false });

    const conflict = await durable.fetch(claimRequest("d".repeat(48)));
    expect(conflict.status).toBe(409);
  });

  it("rejects an out-of-range secret", async () => {
    const durable = makeDo();
    const short = await durable.fetch(claimRequest("too-short"));
    expect(short.status).toBe(400);
  });

  it("rejects a non-POST claim", async () => {
    const durable = makeDo();
    const res = await durable.fetch(new Request(`https://relay.test/machines/${MACHINE_KEY}/claim`, { method: "GET" }));
    expect(res.status).toBe(405);
  });
});

describe("signed upgrade auth rejections", () => {
  it("requires a websocket upgrade header", async () => {
    const durable = makeDo();
    await durable.fetch(claimRequest(SECRET));
    const res = await durable.fetch(new Request(`https://relay.test/host/${MACHINE_KEY}?ts=1&sig=abc`));
    expect(res.status).toBe(426);
  });

  it("rejects an unknown (unclaimed) machine", async () => {
    const durable = makeDo();
    const res = await durable.fetch(
      new Request(`https://relay.test/host/${MACHINE_KEY}?ts=1&sig=abc`, { headers: { Upgrade: "websocket" } }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a /connect request that is not a websocket upgrade", async () => {
    const durable = makeDo();
    await durable.fetch(claimRequest(SECRET));
    const res = await durable.fetch(new Request(`https://relay.test/connect/${MACHINE_KEY}`));
    expect(res.status).toBe(426);
  });

  it("rejects a bad host signature after claim", async () => {
    const durable = makeDo();
    await durable.fetch(claimRequest(SECRET));
    const res = await durable.fetch(
      new Request(`https://relay.test/host/${MACHINE_KEY}?ts=${Math.floor(Date.now() / 1000)}&sig=deadbeef`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(res.status).toBe(401);
  });
});
