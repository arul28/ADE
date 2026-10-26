/** DataDesk host process. The SDK owns the chat WebSocket protocol. */

import { AdeError, createAdeChat } from "@ade-dev/sdk";
import { createAdeServer } from "@ade-dev/sdk/server";
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
const rendererMethods = new Set([
  "app.config", "doctor", "providers.status", "providers.refresh", "models.list",
  "threads.open", "threads.list", "threads.get", "threads.delete", "threads.archive", "threads.unarchive",
  "thread.export", "thread.send", "thread.steer", "thread.interrupt", "thread.setModel",
  "thread.update", "thread.retry", "thread.editLast", "thread.history", "thread.historyPage",
  "thread.approve", "thread.pendingApprovals", "thread.usage", "thread.updateMcpServers", "thread.refreshMcpHeaders",
  "datadesk.thread.setModel",
]);
const client = await createAdeChat({
  home,
  ...(binaryPath ? { binaryPath } : {}),
  logger: (line) => process.stderr.write(`[host] ${line}\n`),
});
log("ade sdk client ready");

const bridge = createAdeServer({
  client,
  authorize: (_socket, method) => rendererMethods.has(method),
  allowThreadKey: (key) => key === "main",
  openOptions: async (_key, rendererOptions, { exists }) => {
    if (exists) return rendererOptions ?? {};
    const defaults = rendererOptions ?? {};
    const model = typeof defaults.model === "string"
      ? defaults.model
      : pickCheapestModel(await client.models.list(), "claude")?.id;
    if (!model) throw new Error("DataDesk could not find an available model.");
    return {
      ...defaults,
      provider: typeof defaults.provider === "string" ? defaults.provider : "claude",
      model,
      permissions: "always-allow",
      title: typeof defaults.title === "string" ? defaults.title : "DataDesk",
      mcpServers: { demodata: { type: "http", url: mcpUrl } },
    };
  },
  methods: {
    "app.config": async () => ({
      mcpUrl,
      threadKey: "main",
      defaultModelId: pickCheapestModel(await client.models.list(), "claude")?.id ?? null,
      defaults: {
        provider: "claude",
        permissions: "always-allow",
        title: "DataDesk",
        mcpServers: { demodata: { type: "http", url: mcpUrl } },
      },
    }),
    "datadesk.thread.setModel": async ({ key, modelId }) => {
      if (typeof key !== "string" || key !== "main") throw new Error("DataDesk thread not found.");
      if (typeof modelId !== "string" || !modelId.trim()) throw new Error("No model was selected.");
      const thread = await client.threads.open(key);
      try {
        return await thread.setModel(modelId);
      } catch (error) {
        if (error instanceof AdeError && error.code === "invalid_option") {
          throw new Error("DataDesk is still answering. It will switch models once this reply finishes.");
        }
        throw error;
      }
    },
  },
  logger: log,
});

const server = new WebSocketServer({ port, host: "127.0.0.1" });
let openConnections = 0;
server.on("connection", (socket) => {
  openConnections += 1;
  log(`renderer connected (${openConnections} open)`);
  const detach = bridge.handleConnection(socket);
  socket.on("close", () => {
    openConnections = Math.max(0, openConnections - 1);
    log(`renderer disconnected (${openConnections} open)`);
    detach();
  });
});

server.on("listening", () => log(`bridge listening on ws://127.0.0.1:${port}`));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  bridge.close();
  server.close();
  await client.dispose().catch(() => {});
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
