import { env } from "cloudflare:workers";
import { createExecutionContext, evictDurableObject, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src";
import {
  buildHostSignatureBase,
  buildPipeSignatureBase,
  handleRequest,
  hmacSha256Hex,
} from "../src/relay";
import {
  CLOSE_BRIDGE_REJECTED,
  CLOSE_CLIENT_GONE,
  CLOSE_FORWARD_FAILED,
  CLOSE_IDLE,
  LEGACY_CONTROL_EPOCH,
  RELAY_READY_VERSION,
  TunnelDurableObject,
} from "../src/tunnelDo";

const SECRET = "s".repeat(48);
const CONTROL_EPOCH = "e".repeat(32);
const openSockets = new Set<WebSocket>();

type Attachment = {
  role: "control" | "client" | "pipe";
  id?: string;
  epoch?: string;
  readyVersion?: number;
  established?: boolean;
  ts: number;
};

afterEach(() => {
  for (const socket of openSockets) {
    try {
      socket.close(1000, "test complete");
    } catch {
      // The runtime already closed this side of the pair.
    }
  }
  openSockets.clear();
});

function machineKey(digit: string): string {
  return digit.repeat(48);
}

function stubFor(key: string): DurableObjectStub {
  return env.TUNNEL.get(env.TUNNEL.idFromName(key));
}

async function claim(stub: DurableObjectStub, key: string): Promise<void> {
  const response = await stub.fetch(`https://relay.test/machines/${key}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET }),
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ ok: true, claimed: true });
}

async function upgrade(stub: DurableObjectStub, url: string): Promise<WebSocket> {
  const response = await stub.fetch(url, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  expect(response.webSocket).not.toBeNull();
  const socket = response.webSocket!;
  socket.accept();
  openSockets.add(socket);
  return socket;
}

async function openControl(args: {
  stub: DurableObjectStub;
  key: string;
  epoch?: string;
}): Promise<WebSocket> {
  const ts = String(Math.floor(Date.now() / 1_000));
  const base = args.epoch
    ? buildHostSignatureBase(args.key, args.epoch, ts)
    : buildHostSignatureBase(args.key, ts);
  const sig = await hmacSha256Hex(SECRET, base);
  const query = new URLSearchParams({ ts, sig });
  if (args.epoch) query.set("epoch", args.epoch);
  return upgrade(args.stub, `https://relay.test/host/${args.key}?${query}`);
}

async function openPipe(args: {
  stub: DurableObjectStub;
  key: string;
  id: string;
  epoch?: string;
}): Promise<WebSocket> {
  const ts = String(Math.floor(Date.now() / 1_000));
  const base = args.epoch
    ? buildPipeSignatureBase(args.key, args.id, args.epoch, ts)
    : buildPipeSignatureBase(args.key, args.id, ts);
  const sig = await hmacSha256Hex(SECRET, base);
  const query = new URLSearchParams({ ts, sig });
  if (args.epoch) query.set("epoch", args.epoch);
  return upgrade(args.stub, `https://relay.test/host/${args.key}/pipe/${args.id}?${query}`);
}

function nextMessage(socket: WebSocket): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup();
      resolve(event.data as string | ArrayBuffer);
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new Error(`socket closed before message: ${event.code} ${event.reason}`));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}

function collectMessages(socket: WebSocket, count: number): Promise<Array<string | ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const messages: Array<string | ArrayBuffer> = [];
    const onMessage = (event: MessageEvent) => {
      messages.push(event.data as string | ArrayBuffer);
      if (messages.length === count) {
        cleanup();
        resolve(messages);
      }
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new Error(`socket closed after ${messages.length}/${count} messages: ${event.code} ${event.reason}`));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => resolve(event), { once: true });
  });
}

async function attachments(stub: DurableObjectStub): Promise<Attachment[]> {
  return runInDurableObject<TunnelDurableObject, Attachment[]>(stub, (_instance, state) => (
    state.getWebSockets().map((socket) => socket.deserializeAttachment() as Attachment)
  ));
}

/** Opens one ready-v2 tunnel over an already-registered control socket. */
async function openTunnel(args: {
  stub: DurableObjectStub;
  key: string;
  control: WebSocket;
}): Promise<{ client: WebSocket; pipe: WebSocket; id: string }> {
  const open = nextMessage(args.control);
  const client = await upgrade(args.stub, `https://relay.test/connect/${args.key}?ready=${RELAY_READY_VERSION}`);
  expect(await nextMessage(client)).toBe(JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION }));
  const openMessage = JSON.parse(String(await open)) as { t: string; id: string; epoch: string; readyVersion: number };
  expect(openMessage).toMatchObject({ t: "open", epoch: CONTROL_EPOCH, readyVersion: RELAY_READY_VERSION });

  const pipe = await openPipe({ stub: args.stub, key: args.key, id: openMessage.id, epoch: CONTROL_EPOCH });
  const ready = nextMessage(client);
  args.control.send(JSON.stringify({ t: "ready", id: openMessage.id, epoch: CONTROL_EPOCH }));
  expect(await ready).toBe(JSON.stringify({ t: "ready", v: RELAY_READY_VERSION }));
  return { client, pipe, id: openMessage.id };
}

/** A claimed machine with a control socket and one established tunnel. */
async function establishEpochV2(keyDigit: string): Promise<{
  key: string;
  stub: DurableObjectStub;
  control: WebSocket;
  client: WebSocket;
  pipe: WebSocket;
  id: string;
}> {
  const key = machineKey(keyDigit);
  const stub = stubFor(key);
  await claim(stub, key);
  const control = await openControl({ stub, key, epoch: CONTROL_EPOCH });
  return { key, stub, control, ...(await openTunnel({ stub, key, control })) };
}

async function prewarm(stub: DurableObjectStub, key: string): Promise<unknown> {
  const response = await stub.fetch(`https://relay.test/prewarm/${key}`);
  expect(response.status).toBe(200);
  return response.json();
}

describe("TunnelDurableObject in workerd", () => {
  it("preserves actual attachments and ordered routing for an established epoch-v2 triple", async () => {
    const { stub, client, pipe, id } = await establishEpochV2("a");
    expect(await attachments(stub)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "control", epoch: CONTROL_EPOCH }),
      expect.objectContaining({ role: "client", id, epoch: CONTROL_EPOCH, established: true }),
      expect.objectContaining({ role: "pipe", id, epoch: CONTROL_EPOCH, established: true }),
    ]));

    const atPipe = collectMessages(pipe, 3);
    client.send("client-1");
    client.send("client-2");
    client.send("client-3");
    expect(await atPipe).toEqual(["client-1", "client-2", "client-3"]);

    const atClient = collectMessages(client, 3);
    pipe.send("pipe-1");
    pipe.send("pipe-2");
    pipe.send("pipe-3");
    expect(await atClient).toEqual(["pipe-1", "pipe-2", "pipe-3"]);

    expect(await attachments(stub)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "control", epoch: CONTROL_EPOCH }),
      expect.objectContaining({ role: "client", id, epoch: CONTROL_EPOCH, established: true }),
      expect.objectContaining({ role: "pipe", id, epoch: CONTROL_EPOCH, established: true }),
    ]));
  });

  it("restores epoch-v2 attachments and routing across deterministic hibernation eviction", async () => {
    const { stub, control, client, pipe, id } = await establishEpochV2("f");

    await evictDurableObject(stub, { webSockets: "hibernate" });

    const pong = nextMessage(control);
    control.send(JSON.stringify({ t: "ping" }));
    expect(await pong).toBe(JSON.stringify({ t: "pong" }));

    const atPipe = collectMessages(pipe, 3);
    client.send("client-1");
    client.send("client-2");
    client.send("client-3");
    expect(await atPipe).toEqual(["client-1", "client-2", "client-3"]);

    const atClient = collectMessages(client, 3);
    pipe.send("pipe-1");
    pipe.send("pipe-2");
    pipe.send("pipe-3");
    expect(await atClient).toEqual(["pipe-1", "pipe-2", "pipe-3"]);

    expect(await attachments(stub)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "control", epoch: CONTROL_EPOCH }),
      expect.objectContaining({ role: "client", id, epoch: CONTROL_EPOCH, established: true }),
      expect.objectContaining({ role: "pipe", id, epoch: CONTROL_EPOCH, established: true }),
    ]));
  });

  it("migrates a pre-epoch control, sends bare open, and readies a v2 client after a legacy pipe", async () => {
    const key = machineKey("b");
    const stub = stubFor(key);
    await claim(stub, key);
    const control = await openControl({ stub, key });

    await runInDurableObject<TunnelDurableObject, void>(stub, (_instance, state) => {
      const serverControl = state.getWebSockets("control")[0];
      expect(serverControl).toBeDefined();
      serverControl!.serializeAttachment({ role: "control", ts: Date.now() });
    });
    // A pre-epoch attachment only ever reaches this code the way it does in
    // production: the previous Worker accepted the socket, the object
    // hibernated, and the deployed code wakes to an attachment it never wrote.
    await evictDurableObject(stub, { webSockets: "hibernate" });

    const open = nextMessage(control);
    const client = await upgrade(stub, `https://relay.test/connect/${key}?ready=${RELAY_READY_VERSION}`);
    expect(await nextMessage(client)).toBe(JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION }));
    const openMessage = JSON.parse(String(await open)) as Record<string, unknown> & { id: string };
    expect(openMessage).toEqual({ t: "open", id: openMessage.id });

    const ready = nextMessage(client);
    const pipe = await openPipe({ stub, key, id: openMessage.id });
    expect(await ready).toBe(JSON.stringify({ t: "ready", v: RELAY_READY_VERSION }));

    expect(await attachments(stub)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "control", epoch: LEGACY_CONTROL_EPOCH }),
      expect.objectContaining({ role: "client", id: openMessage.id, epoch: LEGACY_CONTROL_EPOCH, established: true }),
      expect.objectContaining({ role: "pipe", id: openMessage.id, epoch: LEGACY_CONTROL_EPOCH, established: true }),
    ]));

    const routed = nextMessage(pipe);
    client.send("legacy-control-ready-v2");
    expect(await routed).toBe("legacy-control-ready-v2");
  });

  it("flushes an old client's ordered pre-ready frames after a new epoch control becomes ready", async () => {
    const key = machineKey("c");
    const stub = stubFor(key);
    await claim(stub, key);
    const control = await openControl({ stub, key, epoch: CONTROL_EPOCH });

    const open = nextMessage(control);
    const client = await upgrade(stub, `https://relay.test/connect/${key}`);
    const openMessage = JSON.parse(String(await open)) as { id: string; epoch: string };
    expect(openMessage).toMatchObject({ epoch: CONTROL_EPOCH });
    expect(openMessage).not.toHaveProperty("readyVersion");

    client.send("legacy-hello-1");
    client.send("legacy-hello-2");
    const pipe = await openPipe({ stub, key, id: openMessage.id, epoch: CONTROL_EPOCH });
    const routed = collectMessages(pipe, 2);
    control.send(JSON.stringify({ t: "ready", id: openMessage.id, epoch: CONTROL_EPOCH }));

    expect(await routed).toEqual(["legacy-hello-1", "legacy-hello-2"]);
    expect(await attachments(stub)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "client", id: openMessage.id, epoch: CONTROL_EPOCH, established: true }),
      expect.objectContaining({ role: "pipe", id: openMessage.id, epoch: CONTROL_EPOCH, established: true }),
    ]));
  });

  it("closes an orphan pipe when the client disappears during pipe/ready", async () => {
    const key = machineKey("d");
    const stub = stubFor(key);
    await claim(stub, key);
    const control = await openControl({ stub, key, epoch: CONTROL_EPOCH });

    const open = nextMessage(control);
    const client = await upgrade(stub, `https://relay.test/connect/${key}?ready=${RELAY_READY_VERSION}`);
    expect(await nextMessage(client)).toBe(JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION }));
    const openMessage = JSON.parse(String(await open)) as { id: string };
    const pipe = await openPipe({ stub, key, id: openMessage.id, epoch: CONTROL_EPOCH });
    const pipeClosed = nextClose(pipe);

    await runInDurableObject<TunnelDurableObject, void>(stub, async (instance, state) => {
      const serverClient = state.getWebSockets(`conn:${openMessage.id}`).find((socket) => (
        (socket.deserializeAttachment() as Attachment).role === "client"
      ));
      const serverControl = state.getWebSockets("control")[0];
      expect(serverClient).toBeDefined();
      expect(serverControl).toBeDefined();
      serverClient!.close(CLOSE_CLIENT_GONE, "client gone");
      await instance.webSocketMessage(serverControl!, JSON.stringify({
        t: "ready",
        id: openMessage.id,
        epoch: CONTROL_EPOCH,
      }));
    });

    const close = await pipeClosed;
    expect(close.code).toBe(CLOSE_BRIDGE_REJECTED);
    expect(close.reason).toBe("relay client unavailable");
  });

  it("keeps concurrent tunnels on one machine independently paired across hibernation", async () => {
    const { key, stub, control, ...firstTunnel } = await establishEpochV2("1");
    const first = firstTunnel;
    const second = await openTunnel({ stub, key, control });
    expect(first.id).not.toBe(second.id);

    const atFirstPipe = nextMessage(first.pipe);
    const atSecondPipe = nextMessage(second.pipe);
    first.client.send("to-first");
    second.client.send("to-second");
    expect(await atFirstPipe).toBe("to-first");
    expect(await atSecondPipe).toBe("to-second");

    // Hibernation wipes the instance's pairing cache; each side has to rebuild
    // its own partner from the durable attachments, not inherit its neighbour's.
    await evictDurableObject(stub, { webSockets: "hibernate" });

    const atFirstClient = nextMessage(first.client);
    const atSecondClient = nextMessage(second.client);
    first.pipe.send("from-first");
    second.pipe.send("from-second");
    expect(await atFirstClient).toBe("from-first");
    expect(await atSecondClient).toBe("from-second");

    // Tearing one pair down must not disturb the other pair's cached partner.
    const firstClientClosed = nextClose(first.client);
    first.pipe.close(4000, "done");
    await firstClientClosed;

    const stillRouting = nextMessage(second.pipe);
    second.client.send("second-survives");
    expect(await stillRouting).toBe("second-survives");
  });

  it("hands back a stable socket object, which is what makes caching possible", async () => {
    const { stub, id } = await establishEpochV2("6");

    // The instance caches attachment and partner state keyed by the socket
    // object. If the runtime ever returned a fresh wrapper per lookup, both
    // caches would silently never hit and every other test would still pass.
    await runInDurableObject<TunnelDurableObject, void>(stub, (_instance, state) => {
      expect(state.getWebSockets(`conn:${id}`)[0]).toBe(state.getWebSockets(`conn:${id}`)[0]);
      expect(state.getWebSockets("control")[0]).toBe(state.getWebSockets("control")[0]);
    });
  });

  it("reports an unavailable partner rather than forwarding into a closing socket", async () => {
    const { stub, client, pipe, id } = await establishEpochV2("5");

    // Forward one frame first so the pair is cached in instance memory.
    const warmed = nextMessage(pipe);
    client.send("warm-up");
    expect(await warmed).toBe("warm-up");

    const clientClosed = nextClose(client);
    // Close the pipe and deliver the next frame in the same synchronous turn,
    // before the close handler can drop the pairing. A cached partner must be
    // re-checked on every read, or this frame is forwarded into a dead socket.
    await runInDurableObject<TunnelDurableObject, void>(stub, async (instance, state) => {
      const paired = state.getWebSockets(`conn:${id}`);
      const serverClient = paired.find((s) => (s.deserializeAttachment() as Attachment).role === "client");
      const serverPipe = paired.find((s) => (s.deserializeAttachment() as Attachment).role === "pipe");
      expect(serverClient).toBeDefined();
      expect(serverPipe).toBeDefined();
      serverPipe!.close(CLOSE_IDLE, "idle timeout");
      await instance.webSocketMessage(serverClient!, "into-the-void");
    });

    const close = await clientClosed;
    expect(close.code).toBe(CLOSE_FORWARD_FAILED);
    expect(close.reason).toBe("relay partner unavailable");
  });

  it("prewarms a hibernated object without disturbing its live tunnel", async () => {
    const { key, stub, client, pipe, id } = await establishEpochV2("2");

    await evictDurableObject(stub, { webSockets: "hibernate" });
    expect(await prewarm(stub, key)).toEqual({ ok: true, control: true });

    // The probe is inert: the pair is still established and still routes.
    expect(await attachments(stub)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "client", id, epoch: CONTROL_EPOCH, established: true }),
      expect.objectContaining({ role: "pipe", id, epoch: CONTROL_EPOCH, established: true }),
    ]));
    const routed = nextMessage(pipe);
    client.send("after-prewarm");
    expect(await routed).toBe("after-prewarm");
  });

  it("reports whether a host control socket is registered, and rejects writes", async () => {
    const key = machineKey("3");
    const stub = stubFor(key);
    await claim(stub, key);
    expect(await prewarm(stub, key)).toEqual({ ok: true, control: false });

    await openControl({ stub, key, epoch: CONTROL_EPOCH });
    expect(await prewarm(stub, key)).toEqual({ ok: true, control: true });

    await runInDurableObject<TunnelDurableObject, void>(stub, (_instance, state) => {
      for (const socket of state.getWebSockets("control")) socket.close(1000, "host stopped");
    });
    expect(await prewarm(stub, key)).toEqual({ ok: true, control: false });

    const posted = await stub.fetch(`https://relay.test/prewarm/${key}`, { method: "POST" });
    expect(posted.status).toBe(405);
  });

  it("routes prewarm for an unknown machine without creating any state", async () => {
    const key = machineKey("4");
    const response = await worker.fetch(new Request(`https://relay.test/prewarm/${key}`), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, control: false });

    // Nothing was persisted, so the machine key is still free to be claimed.
    await claim(stubFor(key), key);
  });

  it("keeps ADE MCP shut until the brain turns it on, forwards by rid, and fails a pending request when the host drops", async () => {
    const key = machineKey("e");
    const stub = stubFor(key);
    await claim(stub, key);
    const control = await openControl({ stub, key, epoch: CONTROL_EPOCH });
    // The public address carries the brain's endpoint key, never the relay key.
    const endpointKey = "7".repeat(40);
    const mcpAt = (urlKey: string, body: string): Promise<Response> => worker.fetch(new Request(`https://relay.test/m/${urlKey}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body,
    }), env);
    const mcp = (body: string): Promise<Response> => mcpAt(endpointKey, body);

    // Before the brain registers it, the address is unknown.
    const unknown = await mcp("{}");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "ade_mcp_off" });

    // Registered but off: answered at the relay, nothing sent to the machine.
    control.send(JSON.stringify({ t: "mcp_state", enabled: false, endpointKey }));
    const registered = nextMessage(control);
    control.send(JSON.stringify({ t: "ping" }));
    expect(await registered).toBe(JSON.stringify({ t: "pong" }));
    const off = await mcp("{}");
    expect(off.status).toBe(404);
    expect(await off.json()).toMatchObject({ error: "ade_mcp_off" });

    control.send(JSON.stringify({ t: "mcp_state", enabled: true, endpointKey }));
    const pong = nextMessage(control);
    control.send(JSON.stringify({ t: "ping" }));
    expect(await pong).toBe(JSON.stringify({ t: "pong" }));

    // On: the request reaches the brain as the first frame since the socket
    // opened (so the earlier request never did), and its answer comes back.
    const frame = nextMessage(control);
    const answered = mcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    const forwarded = JSON.parse(await frame as string) as { t: string; rid: string; method: string; path: string; body: string };
    expect(forwarded).toMatchObject({ t: "http", method: "POST", path: "/mcp" });
    expect(JSON.parse(forwarded.body)).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
    control.send(JSON.stringify({
      t: "http_res",
      rid: forwarded.rid,
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "dropped=1" },
      body: "{\"ok\":true}",
    }));
    const response = await answered;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{\"ok\":true}");
    expect(response.headers.get("set-cookie")).toBeNull();

    // The relay key itself is not an ADE MCP address.
    const byRelayKey = await mcpAt(key, "{}");
    expect(byRelayKey.status).toBe(404);

    // A request in flight when the machine's socket goes is failed at once.
    const second = nextMessage(control);
    const pending = mcp("{}");
    await second;
    control.close(1000, "brain stopped");
    const failed = await pending;
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: "offline" });
  });

  it("serves an ADE MCP account from whichever of its computers is online, and lets a computer leave", async () => {
    const secretOne = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0u_-";
    const secretTwo = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm_-";
    const accountOne = (await hmacSha256Hex(secretOne, "ade-mcp-account")).slice(0, 40);
    const accountTwo = (await hmacSha256Hex(secretTwo, "ade-mcp-account")).slice(0, 40);
    const [keyF, keyG] = [machineKey("7"), machineKey("8")];
    const accountState = async (accountKey: string): Promise<{ members: string[]; front: string | null }> => (
      (await stubFor(`mcp-account:${accountKey}`).fetch("https://relay.internal/__mcp-account")).json()
    );
    // Membership changes travel to another object; wait on the account's own answer.
    const accountReaches = async (accountKey: string, members: string[]): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (JSON.stringify((await accountState(accountKey)).members) === JSON.stringify(members)) return;
      }
      expect((await accountState(accountKey)).members).toEqual(members);
    };
    const online = async (key: string): Promise<WebSocket> => {
      const stub = stubFor(key);
      await claim(stub, key);
      return openControl({ stub, key, epoch: CONTROL_EPOCH });
    };
    const mcpState = (control: WebSocket, state: Record<string, unknown>): void => {
      control.send(JSON.stringify({ t: "mcp_state", ...state }));
    };
    const accountCall = async (accountKey: string, headers: Record<string, string> = {}) => {
      // The Worker's own router without Sentry's wrapper, so the execution
      // context holds only the relay's own work (recording the front).
      const ctx = createExecutionContext();
      const response = handleRequest(new Request(`https://relay.test/a/${accountKey}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer t", ...headers },
        body: "{\"jsonrpc\":\"2.0\",\"id\":1}",
      }), env, ctx);
      return { response, settled: async () => { await response; await waitOnExecutionContext(ctx); } };
    };
    type HttpFrame = { t: string; rid: string; path: string; headers: Record<string, string>; mount?: unknown };
    const answer = async (control: WebSocket, frame: Promise<string | ArrayBuffer>, text: string): Promise<HttpFrame> => {
      const parsed = JSON.parse(String(await frame)) as HttpFrame;
      control.send(JSON.stringify({ t: "http_res", rid: parsed.rid, status: 200, headers: {}, body: text }));
      return parsed;
    };

    try {
      const controlF = await online(keyF);
      mcpState(controlF, { enabled: true, endpointKey: "5".repeat(40), account: { secret: secretOne } });
      await accountReaches(accountOne, [keyF]);
      const controlG = await online(keyG);
      mcpState(controlG, { enabled: true, endpointKey: "6".repeat(40), account: { secret: secretOne } });
      await accountReaches(accountOne, [keyF, keyG]);

      // No front yet: the newest computer answers, with the account as its mount
      // and no internal header, whatever the client sent.
      const first = await accountCall(accountOne, { "x-ade-mcp-mount": `a/${accountTwo}` });
      const toG = await answer(controlG, nextMessage(controlG), "from G");
      expect(toG).toMatchObject({ t: "http", path: "/mcp", mount: { kind: "account", key: accountOne } });
      expect(Object.keys(toG.headers)).not.toContain("x-ade-mcp-mount");
      expect(await (await first.response).text()).toBe("from G");
      await first.settled();
      expect(await accountState(accountOne)).toEqual({ members: [keyF, keyG], front: keyG });

      // The per-machine address never carries a mount, even when a client asks.
      const direct = worker.fetch(new Request(`https://relay.test/m/${"5".repeat(40)}/mcp`, {
        method: "POST",
        headers: { "x-ade-mcp-mount": `a/${accountOne}` },
        body: "{}",
      }), env);
      const toFDirect = await answer(controlF, nextMessage(controlF), "direct");
      expect(toFDirect).not.toHaveProperty("mount");
      expect((await direct).status).toBe(200);

      // The front goes offline: the request goes to the next computer instead,
      // and that one becomes the front.
      controlG.close(1000, "brain stopped");
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!((await prewarm(stubFor(keyG), keyG)) as { control: boolean }).control) break;
      }
      expect(await prewarm(stubFor(keyG), keyG)).toEqual({ ok: true, control: false });
      const second = await accountCall(accountOne);
      await answer(controlF, nextMessage(controlF), "from F");
      expect(await (await second.response).text()).toBe("from F");
      await second.settled();
      expect(await accountState(accountOne)).toEqual({ members: [keyF, keyG], front: keyF });

      // F moves to another account: it leaves the first and joins the second.
      mcpState(controlF, { enabled: true, endpointKey: "5".repeat(40), account: { secret: secretTwo } });
      await accountReaches(accountTwo, [keyF]);
      expect(await accountState(accountOne)).toEqual({ members: [keyG], front: null });
      const viaTwo = await accountCall(accountTwo);
      expect(await answer(controlF, nextMessage(controlF), "two")).toMatchObject({ mount: { kind: "account", key: accountTwo } });
      expect((await viaTwo.response).status).toBe(200);
      await viaTwo.settled();

      // Even listed on the first account again, F does not answer for it.
      await stubFor(`mcp-account:${accountOne}`).fetch("https://relay.internal/__mcp-account", {
        method: "PUT",
        body: JSON.stringify({ machineKey: keyF, op: "add" }),
      });
      const stale = await accountCall(accountOne);
      const staleResponse = await stale.response;
      expect(staleResponse.status).toBe(503);
      expect(staleResponse.headers.get("retry-after")).toBe("30");
      expect(await staleResponse.json()).toMatchObject({ error: "offline" });
      await stale.settled();
      const pong = nextMessage(controlF);
      controlF.send(JSON.stringify({ t: "ping" }));
      expect(await pong).toBe(JSON.stringify({ t: "pong" }));

      // Turning ADE MCP off leaves the account, even with the secret still sent;
      // nobody is left to answer.
      mcpState(controlF, { enabled: false, endpointKey: "5".repeat(40), account: { secret: secretTwo } });
      await accountReaches(accountTwo, []);
      const offCall = await accountCall(accountTwo);
      const off = await offCall.response;
      await offCall.settled();
      expect(off.status).toBe(404);
      expect(await off.json()).toMatchObject({ error: "ade_mcp_off" });
    } finally {
      // A control socket left idle at the end keeps workerd from shutting down.
      for (const key of [keyF, keyG]) {
        await runInDurableObject<TunnelDurableObject, void>(stubFor(key), (_instance, state) => {
          for (const socket of state.getWebSockets()) socket.close(1000, "test complete");
        });
      }
    }
  });
});
