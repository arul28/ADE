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
import {
  CLOSE_BRIDGE_REJECTED,
  CLOSE_HOST_OFFLINE,
  CLOSE_PARTNER_CLOSED,
  CLOSE_PRE_PIPE_BUFFER_OVERFLOW,
  TunnelDurableObject,
} from "../src/tunnelDo";

const MACHINE_KEY = "a".repeat(48);
const SECRET = "s".repeat(48);

// Minimal Durable Object storage stand-in — enough to exercise the claim path
// and the pre-upgrade auth rejections without a live runtime. Socket pairing
// and hibernation are covered by the wrangler-dev smoke test (see README).
class FakeStorage {
  private map = new Map<string, unknown>();
  private alarm: number | null = null;
  setAlarmCalls = 0;
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
    this.setAlarmCalls += 1;
    this.alarm = time;
  }
}

type TestSocketRole = "control" | "client" | "pipe";

class FakeSocket {
  readonly sent: unknown[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  throwOnSend = false;

  constructor(
    readonly tags: string[],
    private attachment: { role: TestSocketRole; id?: string; ts: number },
  ) {}

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment as typeof this.attachment;
  }

  send(value: unknown): void {
    if (this.throwOnSend) throw new Error("socket is dead");
    this.sent.push(value);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
}

class FakeState {
  readonly storage = new FakeStorage();
  readonly sockets: FakeSocket[] = [];

  addSocket(role: TestSocketRole, id?: string, ts = Date.now()): FakeSocket {
    const tags = [role, ...(id ? [`conn:${id}`] : [])];
    const socket = new FakeSocket(tags, { role, id, ts });
    this.sockets.push(socket);
    return socket;
  }

  getWebSockets(tag?: string): WebSocket[] {
    const sockets = tag ? this.sockets.filter((socket) => socket.tags.includes(tag)) : this.sockets;
    return sockets as unknown as WebSocket[];
  }

  acceptWebSocket(): void {}
}

function makeDoHarness(): { durable: TunnelDurableObject; state: FakeState; storage: FakeStorage } {
  const state = new FakeState();
  const durable = new TunnelDurableObject(state as unknown as DurableObjectState, {} as TunnelRelayEnv);
  return { durable, state, storage: state.storage };
}

function makeDo(): TunnelDurableObject {
  const { durable } = makeDoHarness();
  return durable;
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

describe("durable socket lifecycle", () => {
  it("maps brain rejects to the waiting client and keeps unknown control types ignored", async () => {
    const { durable, state } = makeDoHarness();
    const control = state.addSocket("control");
    const client = state.addSocket("client", "abcdef01");

    await durable.webSocketMessage(
      control as unknown as WebSocket,
      JSON.stringify({
        t: "reject",
        id: "abcdef01",
        code: 4555,
        reason: `bridge\u0000 refused ${"é".repeat(100)}`,
      }),
    );
    expect(client.closes).toHaveLength(1);
    expect(client.closes[0]?.code).toBe(4555);
    expect(client.closes[0]?.reason).not.toContain("\u0000");
    expect(Buffer.byteLength(client.closes[0]?.reason ?? "", "utf8")).toBeLessThanOrEqual(123);

    const secondClient = state.addSocket("client", "abcdef02");
    await durable.webSocketMessage(
      control as unknown as WebSocket,
      JSON.stringify({ t: "reject", id: "abcdef02", code: 1006, reason: "bad code" }),
    );
    expect(secondClient.closes).toEqual([{ code: CLOSE_BRIDGE_REJECTED, reason: "bad code" }]);

    await durable.webSocketMessage(control as unknown as WebSocket, JSON.stringify({ t: "future-type" }));
    expect(control.sent).toEqual([]);
    expect(secondClient.closes).toHaveLength(1);
  });

  it("preserves application close details across a pair and falls back to 4000 otherwise", async () => {
    const first = makeDoHarness();
    const client = first.state.addSocket("client", "abcdef01");
    const pipe = first.state.addSocket("pipe", "abcdef01");
    await first.durable.webSocketClose(
      client as unknown as WebSocket,
      4666,
      "phone\tclosed",
      true,
    );
    expect(client.closes).toEqual([]);
    expect(pipe.closes).toEqual([{ code: 4666, reason: "phone closed" }]);

    const second = makeDoHarness();
    const normalClient = second.state.addSocket("client", "abcdef02");
    const normalPipe = second.state.addSocket("pipe", "abcdef02");
    await second.durable.webSocketClose(normalClient as unknown as WebSocket, 1000, "", true);
    expect(normalPipe.closes).toEqual([{ code: CLOSE_PARTNER_CLOSED, reason: "partner closed" }]);
  });

  it("closes an early client when its buffered frames exceed 256 KiB", async () => {
    const { durable, state } = makeDoHarness();
    const client = state.addSocket("client", "abcdef01");

    await durable.webSocketMessage(client as unknown as WebSocket, new ArrayBuffer(128 * 1024));
    expect(client.closes).toEqual([]);
    await durable.webSocketMessage(client as unknown as WebSocket, new ArrayBuffer(128 * 1024));
    expect(client.closes).toEqual([]);
    await durable.webSocketMessage(client as unknown as WebSocket, new ArrayBuffer(1));
    expect(client.closes).toEqual([{
      code: CLOSE_PRE_PIPE_BUFFER_OVERFLOW,
      reason: "pre-pipe buffer overflow",
    }]);
  });

  it("reschedules alarms for data sockets but not for an idle control socket", async () => {
    const { durable, state, storage } = makeDoHarness();
    state.addSocket("control");
    await durable.alarm();
    expect(storage.setAlarmCalls).toBe(0);
    expect(await storage.getAlarm()).toBeNull();

    state.addSocket("client", "abcdef01");
    await durable.alarm();
    expect(storage.setAlarmCalls).toBe(1);
    expect(await storage.getAlarm()).not.toBeNull();
  });

  it("closes the new client immediately when signaling the control socket throws", async () => {
    const { durable, state, storage } = makeDoHarness();
    const control = state.addSocket("control");
    control.throwOnSend = true;
    const testDurable = durable as unknown as {
      acceptSocket: (attachment: { role: TestSocketRole; id?: string }) => Promise<Response>;
    };
    testDurable.acceptSocket = async (attachment) => {
      state.addSocket(attachment.role, attachment.id);
      return new Response(null, { status: 200 });
    };

    const response = await durable.fetch(new Request(`https://relay.test/connect/${MACHINE_KEY}`, {
      headers: { Upgrade: "websocket" },
    }));
    const client = state.sockets.find((socket) => socket.tags.includes("client"));
    expect(response.status).toBe(200);
    expect(client?.closes).toEqual([{ code: CLOSE_HOST_OFFLINE, reason: "host offline" }]);
    expect(storage.setAlarmCalls).toBe(0);
  });
});
