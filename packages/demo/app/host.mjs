/**
 * DataDesk host process.
 *
 * `@ade-dev/sdk` is a Node library — it spawns and owns an ADE runtime child
 * process — so it cannot live in the renderer. This is the shape a real desktop
 * or local-first app ends up with: the SDK on one side of a process boundary,
 * the UI on the other, and a thin RPC in between. Here it is a WebSocket; in an
 * Electron app it would be `ipcMain`/`ipcRenderer`, and nothing else changes.
 *
 * The bridge deliberately mirrors `AdeChatClient`/`AdeThread` one method at a
 * time rather than inventing an app-specific protocol. That is the point: the
 * renderer then builds a proxy that satisfies the same interface, and
 * `adaptSdkClient()` from `@ade-dev/chat-ui` accepts the proxy exactly as it would
 * accept the real client — which is the proof that the interface is
 * transport-agnostic.
 *
 * Wire format:
 *   in   { id, method, params }
 *   out  { id, ok: true, result } | { id, ok: false, error }
 *   push { push: "event", key, envelope } | { push: "providers", statuses }
 *
 * Environment:
 *   DATADESK_PORT     bridge port           (default 4318)
 *   DATADESK_MCP_URL  toy MCP server url    (required)
 *   DATADESK_HOME     isolated ADE home     (required)
 *   ADE_BINARY_PATH   the `ade` build to run
 */

import { AdeError, createAdeChat } from "@ade-dev/sdk";
import { WebSocketServer } from "ws";
import { pickCheapestModel } from "../lib/pickModel.mjs";

const port = Number(process.env.DATADESK_PORT ?? 4318);
const mcpUrl = process.env.DATADESK_MCP_URL;
const home = process.env.DATADESK_HOME;
const binaryPath = process.env.ADE_BINARY_PATH;

if (!mcpUrl || !home) {
  process.stderr.write("DATADESK_MCP_URL and DATADESK_HOME are required.\n");
  process.exit(2);
}

const log = (line) => process.stdout.write(`[host] ${line}\n`);

const client = await createAdeChat({
  home,
  ...(binaryPath ? { binaryPath } : {}),
  logger: (line) => process.stderr.write(`[host] ${line}\n`),
});
log("ade sdk client ready");

/** Open threads by key, plus the fan-out that turns SDK events into pushes. */
const threads = new Map();
/**
 * In-flight opens, so overlapping `threads.open` calls from one renderer share
 * a single subscription. The SDK already collapses them into one session; this
 * stops the HOST from attaching three `on("event")` listeners to it and
 * broadcasting every envelope three times.
 */
const opening = new Map();
const sockets = new Set();

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

function ensureThread(key, opts) {
  const existing = threads.get(key);
  if (existing) return Promise.resolve(existing);
  const pending = opening.get(key);
  if (pending) return pending;

  const started = (async () => {
    const thread = await client.threads.open(key, opts ?? {});
    // One subscription per thread, fanned out to whoever is connected. A
    // renderer reload must not orphan a subscription or double up on a new one.
    const stop = thread.on("event", (envelope) => {
      broadcast({ push: "event", key, envelope });
    });
    const entry = { thread, stop };
    threads.set(key, entry);
    log(`thread "${key}" open (session ${thread.id}, mcp ${thread.mcpCapability?.level ?? "none"})`);
    return entry;
  })().finally(() => opening.delete(key));

  opening.set(key, started);
  return started;
}

function requireThread(key) {
  const entry = threads.get(key);
  if (!entry) throw new Error(`No open thread for key "${key}".`);
  return entry;
}

const methods = {
  /** Everything the renderer needs to construct its open options. */
  "app.config": async () => ({
    mcpUrl,
    threadKey: "main",
    // DataDesk pins a cheap model rather than inheriting whatever the catalog
    // lists first. The picker still offers the rest — this is only the default.
    defaultModelId: pickCheapestModel(await client.models.list(), "claude")?.id ?? null,
    defaults: {
      provider: "claude",
      permissions: "always-allow",
      title: "DataDesk",
      mcpServers: { demodata: { type: "http", url: mcpUrl } },
    },
  }),
  "doctor": () => client.doctor(),
  "providers.status": () => client.providers.status(),
  "models.list": () => client.models.list(),
  "threads.open": async ({ key, opts }) => {
    const { thread } = await ensureThread(key, opts);
    return { id: thread.id, key: thread.key, mcpCapability: thread.mcpCapability };
  },
  "thread.send": async ({ key, text, attachments }) => {
    await requireThread(key).thread.send(text, attachments ? { attachments } : {});
    return { ok: true };
  },
  "thread.steer": async ({ key, text }) => {
    await requireThread(key).thread.steer(text);
    return { ok: true };
  },
  "thread.interrupt": async ({ key }) => {
    await requireThread(key).thread.interrupt();
    return { ok: true };
  },
  /**
   * Switch the open thread's model.
   *
   * DataDesk never passes `{ force: true }`. The SDK refuses a mid-turn switch
   * because tearing the runtime down kills the in-flight turn without emitting
   * `error` or `done`, and a silently truncated answer is worse than a refused
   * click. `@ade-dev/chat-ui` already keeps the picker disabled while a turn runs,
   * so this path should not be reachable — but if it ever is, the SDK's message
   * is written for a developer ("pass { force: true }") and this host is the
   * last place that can stop that string from being rendered to a customer.
   */
  "thread.setModel": async ({ key, modelId }) => {
    const entry = requireThread(key);
    // Rejected here so the only `invalid_option` that can come back from the
    // SDK below is the mid-turn refusal, and the translation stays exact.
    if (typeof modelId !== "string" || !modelId.trim()) {
      throw new Error("No model was selected.");
    }
    try {
      return await entry.thread.setModel(modelId);
    } catch (error) {
      if (error instanceof AdeError && error.code === "invalid_option") {
        throw new Error("DataDesk is still answering. It will switch models once this reply finishes.");
      }
      throw error;
    }
  },
  "thread.history": async ({ key }) => requireThread(key).thread.history(),
};

// Provider changes are pushed rather than polled by the renderer, so a browser
// tab left open overnight still shows a provider that logged out.
const stopProviderWatch = client.providers.onChange((statuses) => {
  broadcast({ push: "providers", statuses });
});

const server = new WebSocketServer({ port, host: "127.0.0.1" });

server.on("connection", (socket) => {
  sockets.add(socket);
  log(`renderer connected (${sockets.size} open)`);
  socket.on("close", () => {
    sockets.delete(socket);
    log(`renderer disconnected (${sockets.size} open)`);
  });
  socket.on("message", async (raw) => {
    let request;
    try {
      request = JSON.parse(String(raw));
    } catch {
      return;
    }
    const handler = methods[request.method];
    if (!handler) {
      socket.send(JSON.stringify({ id: request.id, ok: false, error: `Unknown method: ${request.method}` }));
      return;
    }
    try {
      const result = await handler(request.params ?? {});
      socket.send(JSON.stringify({ id: request.id, ok: true, result: result ?? null }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`${request.method} failed: ${message}`);
      socket.send(JSON.stringify({ id: request.id, ok: false, error: message }));
    }
  });
});

server.on("listening", () => log(`bridge listening on ws://127.0.0.1:${port}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  stopProviderWatch();
  for (const entry of threads.values()) entry.stop();
  server.close();
  // Disposing the client stops the ADE runtime child it spawned.
  await client.dispose().catch(() => {});
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
