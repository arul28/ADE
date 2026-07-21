import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHostSignatureBase,
  buildPipeSignatureBase,
  hmacSha256Hex,
} from "../src/relay";
import {
  CLOSE_BRIDGE_REJECTED,
  CLOSE_CLIENT_GONE,
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

async function establishEpochV2(keyDigit: string): Promise<{
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

  const open = nextMessage(control);
  const client = await upgrade(stub, `https://relay.test/connect/${key}?ready=${RELAY_READY_VERSION}`);
  expect(await nextMessage(client)).toBe(JSON.stringify({ t: "accepted", v: RELAY_READY_VERSION }));
  const openMessage = JSON.parse(String(await open)) as { t: string; id: string; epoch: string; readyVersion: number };
  expect(openMessage).toMatchObject({ t: "open", epoch: CONTROL_EPOCH, readyVersion: RELAY_READY_VERSION });

  const pipe = await openPipe({ stub, key, id: openMessage.id, epoch: CONTROL_EPOCH });
  const ready = nextMessage(client);
  control.send(JSON.stringify({ t: "ready", id: openMessage.id, epoch: CONTROL_EPOCH }));
  expect(await ready).toBe(JSON.stringify({ t: "ready", v: RELAY_READY_VERSION }));
  return { stub, control, client, pipe, id: openMessage.id };
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

  // Cloudflare pool 0.18.6's supported helper currently does not return for
  // this SQLite-backed namespace, even with no WebSockets. Keep the complete
  // proof runnable in place without hanging local or CI test jobs.
  it.skip("restores epoch-v2 attachments and routing across deterministic hibernation eviction", async () => {
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
});
