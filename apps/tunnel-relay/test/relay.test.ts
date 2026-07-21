import { describe, expect, it, vi } from "vitest";
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
  CLOSE_FORWARD_FAILED,
  CLOSE_HOST_OFFLINE,
  CLOSE_NOT_READY,
  CLOSE_PARTNER_CLOSED,
  CLOSE_PRE_PIPE_BUFFER_OVERFLOW,
  CLOSE_STALE_PIPE,
  LEGACY_CONTROL_EPOCH,
  RELAY_READY_VERSION,
  TunnelDurableObject,
} from "../src/tunnelDo";

const MACHINE_KEY = "a".repeat(48);
const SECRET = "s".repeat(48);
const CONTROL_EPOCH = "e".repeat(32);

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
  readyState = 1;
  readonly sent: unknown[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  throwOnSend = false;

  constructor(
    readonly tags: string[],
    private attachment: {
      role: TestSocketRole;
      id?: string;
      epoch?: string;
      readyVersion?: typeof RELAY_READY_VERSION;
      established?: boolean;
      legacyBuffered?: true;
      legacyStateUnknown?: true;
      ts: number;
    },
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
    this.readyState = 3;
  }
}

class FakeState {
  readonly storage = new FakeStorage();
  readonly sockets: FakeSocket[] = [];

  addSocket(
    role: TestSocketRole,
    id?: string,
    ts = Date.now(),
    options: {
      epoch?: string;
      omitEpoch?: boolean;
      readyVersion?: typeof RELAY_READY_VERSION;
      established?: boolean;
      legacyBuffered?: boolean;
    } = {},
  ): FakeSocket {
    const epoch = options.epoch ?? CONTROL_EPOCH;
    const tags = [role, ...(id ? [`conn:${id}`] : []), ...(options.omitEpoch ? [] : [`epoch:${epoch}`])];
    const socket = new FakeSocket(tags, {
      role,
      id,
      ...(!options.omitEpoch ? { epoch } : {}),
      ...(options.readyVersion ? { readyVersion: options.readyVersion } : {}),
      ...(options.established ? { established: true } : {}),
      ...(options.legacyBuffered ? { legacyBuffered: true as const } : {}),
      ts,
    });
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

function installAcceptSocketStub(durable: TunnelDurableObject, state: FakeState): void {
  const testDurable = durable as unknown as {
    acceptSocket: (
      attachment: {
        role: TestSocketRole;
        id?: string;
        epoch?: string;
        readyVersion?: typeof RELAY_READY_VERSION;
      },
      afterAccept?: (socket: WebSocket) => void,
    ) => Promise<Response>;
  };
  testDurable.acceptSocket = async (attachment, afterAccept) => {
    const socket = state.addSocket(attachment.role, attachment.id, Date.now(), {
      epoch: attachment.epoch,
      readyVersion: attachment.readyVersion,
    });
    afterAccept?.(socket as unknown as WebSocket);
    return new Response(null, { status: 200 });
  };
}

async function signedPipeRequest(args: {
  id: string;
  epoch?: string;
}): Promise<Request> {
  const ts = String(Math.floor(Date.now() / 1_000));
  const base = args.epoch
    ? buildPipeSignatureBase(MACHINE_KEY, args.id, args.epoch, ts)
    : buildPipeSignatureBase(MACHINE_KEY, args.id, ts);
  const sig = await hmacSha256Hex(SECRET, base);
  const query = new URLSearchParams({ ts, sig });
  if (args.epoch) query.set("epoch", args.epoch);
  return new Request(`https://relay.test/host/${MACHINE_KEY}/pipe/${args.id}?${query}`, {
    headers: { Upgrade: "websocket" },
  });
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

  it.each(["legacy", "epoch"] as const)("accepts %s host and pipe HMAC bases", async (mode) => {
    const { durable, state, storage } = makeDoHarness();
    installAcceptSocketStub(durable, state);
    await storage.put("secret", SECRET);
    const ts = String(Math.floor(Date.now() / 1_000));
    const epoch = mode === "epoch" ? CONTROL_EPOCH : undefined;
    const hostBase = epoch
      ? buildHostSignatureBase(MACHINE_KEY, epoch, ts)
      : buildHostSignatureBase(MACHINE_KEY, ts);
    const hostSig = await hmacSha256Hex(SECRET, hostBase);
    const hostQuery = new URLSearchParams({ ts, sig: hostSig });
    if (epoch) hostQuery.set("epoch", epoch);
    const hostResponse = await durable.fetch(new Request(
      `https://relay.test/host/${MACHINE_KEY}?${hostQuery}`,
      { headers: { Upgrade: "websocket" } },
    ));
    expect(hostResponse.status).toBe(200);

    const controlEpoch = epoch ?? LEGACY_CONTROL_EPOCH;
    const id = "abcdef01";
    state.addSocket("client", id, Date.now(), { epoch: controlEpoch });
    const pipeResponse = await durable.fetch(await signedPipeRequest({ id, epoch }));
    expect(pipeResponse.status).toBe(200);
    expect(state.sockets.some((socket) => socket.tags.includes("pipe"))).toBe(true);
  });
});

describe("durable socket lifecycle", () => {
  it("migrates a hibernated legacy control attachment without reporting host offline", async () => {
    const { durable, state, storage } = makeDoHarness();
    await storage.put("secret", SECRET);
    installAcceptSocketStub(durable, state);
    const control = state.addSocket("control", undefined, Date.now(), { omitEpoch: true });

    const response = await durable.fetch(new Request(
      `https://relay.test/connect/${MACHINE_KEY}?ready=2`,
      { headers: { Upgrade: "websocket" } },
    ));

    expect(response.status).toBe(200);
    expect(control.closes).toEqual([]);
    expect(control.deserializeAttachment()).toMatchObject({ role: "control", epoch: LEGACY_CONTROL_EPOCH });
    const open = JSON.parse(String(control.sent[0])) as { t: string; id: string };
    expect(control.sent).toEqual([JSON.stringify({ t: "open", id: open.id })]);
    const client = state.sockets.find((socket) => socket.tags.includes("client"))!;
    expect(client.sent).toEqual([JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION })]);

    const pipeResponse = await durable.fetch(await signedPipeRequest({ id: open.id }));
    expect(pipeResponse.status).toBe(200);
    expect(client.sent).toEqual([
      JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION }),
      JSON.stringify({ t: "ready", v: RELAY_READY_VERSION }),
    ]);
  });

  it.each([
    { controlEpoch: LEGACY_CONTROL_EPOCH, readyV2: false, name: "old/old" },
    { controlEpoch: LEGACY_CONTROL_EPOCH, readyV2: true, name: "old/new" },
    { controlEpoch: CONTROL_EPOCH, readyV2: false, name: "new/old" },
    { controlEpoch: CONTROL_EPOCH, readyV2: true, name: "new/new" },
  ])("establishes the $name control/client compatibility path", async ({ controlEpoch, readyV2 }) => {
    const { durable, state, storage } = makeDoHarness();
    await storage.put("secret", SECRET);
    installAcceptSocketStub(durable, state);
    const control = state.addSocket("control", undefined, Date.now(), { epoch: controlEpoch });
    await durable.fetch(new Request(
      `https://relay.test/connect/${MACHINE_KEY}${readyV2 ? "?ready=2" : ""}`,
      { headers: { Upgrade: "websocket" } },
    ));
    const open = JSON.parse(String(control.sent.at(-1))) as { id: string; epoch: string };
    const client = state.sockets.find((socket) => socket.tags.includes("client"))!;
    if (!readyV2) await durable.webSocketMessage(client as unknown as WebSocket, "ade-hello");

    await durable.fetch(await signedPipeRequest({
      id: open.id,
      ...(controlEpoch === LEGACY_CONTROL_EPOCH ? {} : { epoch: controlEpoch }),
    }));
    const pipe = state.sockets.find((socket) => socket.tags.includes("pipe"))!;
    if (controlEpoch !== LEGACY_CONTROL_EPOCH) {
      if (readyV2) {
        expect(client.sent).toEqual([JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION })]);
      } else {
        expect(pipe.sent).toEqual([]);
      }
      await durable.webSocketMessage(control as unknown as WebSocket, JSON.stringify({
        t: "ready",
        id: open.id,
        epoch: controlEpoch,
      }));
    }

    if (readyV2) {
      expect(client.sent).toEqual([
        JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION }),
        JSON.stringify({ t: "ready", v: RELAY_READY_VERSION }),
      ]);
    } else {
      expect(pipe.sent).toEqual(["ade-hello"]);
    }
    expect(client.deserializeAttachment()).toMatchObject({ established: true, epoch: controlEpoch });
    expect(pipe.deserializeAttachment()).toMatchObject({ established: true, epoch: controlEpoch });
  });

  it.each([
    { name: "lost in-memory marker data", options: { epoch: LEGACY_CONTROL_EPOCH, legacyBuffered: true } },
    { name: "pre-deploy unknown attachment", options: { omitEpoch: true } },
  ])("closes a legacy pair when $name cannot be proven after hibernation", async ({ options }) => {
    const { state, storage } = makeDoHarness();
    await storage.put("secret", SECRET);
    state.addSocket("control", undefined, Date.now(), { epoch: LEGACY_CONTROL_EPOCH });
    const client = state.addSocket("client", "abcdef01", Date.now(), options);
    const reconstructed = new TunnelDurableObject(
      state as unknown as DurableObjectState,
      {} as TunnelRelayEnv,
    );
    installAcceptSocketStub(reconstructed, state);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await reconstructed.fetch(await signedPipeRequest({ id: "abcdef01" }));

    const pipe = state.sockets.find((socket) => socket.tags.includes("pipe"))!;
    expect(client.closes).toEqual([{
      code: CLOSE_FORWARD_FAILED,
      reason: expect.stringContaining("legacy"),
    }]);
    expect(pipe.closes).toEqual([{
      code: CLOSE_FORWARD_FAILED,
      reason: expect.stringContaining("legacy"),
    }]);
    expect(client.sent).toEqual([]);
    expect(client.deserializeAttachment()).not.toMatchObject({ established: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"kind":"forward_failed"'));
    log.mockRestore();
  });

  it("migrates a proven pre-deploy client/pipe pair after hibernation", async () => {
    const { state } = makeDoHarness();
    const client = state.addSocket("client", "abcdef01", Date.now(), { omitEpoch: true });
    const pipe = state.addSocket("pipe", "abcdef01", Date.now(), { omitEpoch: true });
    const reconstructed = new TunnelDurableObject(
      state as unknown as DurableObjectState,
      {} as TunnelRelayEnv,
    );

    await reconstructed.webSocketMessage(client as unknown as WebSocket, "hello");

    expect(pipe.sent).toEqual(["hello"]);
    expect(client.closes).toEqual([]);
    expect(pipe.closes).toEqual([]);
    expect(client.deserializeAttachment()).toMatchObject({
      epoch: LEGACY_CONTROL_EPOCH,
      established: true,
    });
    expect(pipe.deserializeAttachment()).toMatchObject({
      epoch: LEGACY_CONTROL_EPOCH,
      established: true,
    });
  });

  it("maps brain rejects to the waiting client and keeps unknown control types ignored", async () => {
    const { durable, state } = makeDoHarness();
    const control = state.addSocket("control");
    const client = state.addSocket("client", "abcdef01");

    await durable.webSocketMessage(
      control as unknown as WebSocket,
      JSON.stringify({
        t: "reject",
        id: "abcdef01",
        epoch: CONTROL_EPOCH,
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
      JSON.stringify({ t: "reject", id: "abcdef02", epoch: CONTROL_EPOCH, code: 1006, reason: "bad code" }),
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

  it("logs and propagates a host pipe 4003 close without frame or token data", async () => {
    const { durable, state } = makeDoHarness();
    const client = state.addSocket("client", "abcdef01", Date.now(), { established: true });
    const pipe = state.addSocket("pipe", "abcdef01", Date.now(), { established: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await durable.webSocketClose(pipe as unknown as WebSocket, 4003, "account proof expired", true);

    expect(client.closes).toEqual([{ code: 4003, reason: "account proof expired" }]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(
      /"kind":"socket_closed".*"role":"pipe".*"epochMode":"epoch".*"code":4003.*"reason":"account proof expired".*"established":true/,
    ));
    log.mockRestore();
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

  it("closes both established peers with a recoverable code when forwarding throws", async () => {
    const { durable, state } = makeDoHarness();
    const client = state.addSocket("client", "abcdef01", Date.now(), { established: true });
    const pipe = state.addSocket("pipe", "abcdef01", Date.now(), { established: true });
    pipe.throwOnSend = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await durable.webSocketMessage(client as unknown as WebSocket, "hello");

    expect(client.closes).toEqual([{
      code: CLOSE_FORWARD_FAILED,
      reason: "relay forwarding failed",
    }]);
    expect(pipe.closes).toEqual([{
      code: CLOSE_FORWARD_FAILED,
      reason: "relay forwarding failed",
    }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"kind":"forward_failed"'));
    log.mockRestore();
  });

  it("closes only unestablished clients when their host control socket is lost", async () => {
    const { durable, state } = makeDoHarness();
    const control = state.addSocket("control");
    const pending = state.addSocket("client", "abcdef01");
    const established = state.addSocket("client", "abcdef02", Date.now(), { established: true });
    state.addSocket("pipe", "abcdef02", Date.now(), { established: true });

    await durable.webSocketClose(control as unknown as WebSocket, 1006, "", false);

    expect(pending.closes).toEqual([{ code: CLOSE_HOST_OFFLINE, reason: "host offline" }]);
    expect(established.closes).toEqual([]);
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
      acceptSocket: (attachment: { role: TestSocketRole; id?: string; epoch: string }) => Promise<Response>;
    };
    testDurable.acceptSocket = async (attachment) => {
      state.addSocket(attachment.role, attachment.id, Date.now(), { epoch: attachment.epoch });
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
