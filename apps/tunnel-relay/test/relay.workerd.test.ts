import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src";
import {
  buildHostSignatureBase,
  buildPipeSignatureBase,
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
});
