#!/usr/bin/env node
/**
 * "demodata" — a toy MCP server over the streamable-HTTP transport.
 *
 * It stands in for a third-party app's own backend: two read-only tools over
 * fake, in-memory business data. Nothing here touches ADE, the developer's real
 * `~/.ade`, or the network.
 *
 * Hand-rolled on `node:http` rather than `@modelcontextprotocol/sdk` so the
 * demo package has zero dependencies and the exact bytes on the wire are
 * visible in one file. The transport contract implemented:
 *
 *   POST /mcp   JSON-RPC request  -> `application/json` response, or 202 with
 *                                    no body for a notification.
 *   GET  /mcp   -> 405. The optional server->client SSE channel is not needed:
 *                 this server never initiates a message.
 *   DELETE /mcp -> 200, session forgotten.
 *
 * Every `tools/call` is appended to the call log (`--log <path>`, default
 * `<cwd>/mcp-calls.jsonl`) so a test can assert the tool was really reached
 * rather than hallucinated by the model.
 *
 * Usage:
 *   node mcp-server.mjs [--port 0] [--log /tmp/calls.jsonl] [--host 127.0.0.1]
 *
 * On listen it prints one line of JSON to stdout:
 *   {"ready":true,"url":"http://127.0.0.1:53211/mcp","port":53211,"log":"..."}
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = "2025-06-18";

/* -------------------------------------------------------------------------- */
/* Fake data                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Dates are computed relative to "now" so "changed this week" stays true
 * whenever the demo runs. INV-0007 is the single invoice inside the window;
 * every assertion about "which invoice changed this week" keys off it.
 */
function fakeInvoices(now = new Date()) {
  const daysAgo = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();
  return [
    {
      id: "INV-0007",
      customer: "Northwind Trading",
      amountUsd: 12_400.0,
      status: "overdue",
      updatedAt: daysAgo(2), // inside the last 7 days — the changed one
      changeNote: "Status moved from sent to overdue after the due date passed.",
    },
    {
      id: "INV-0012",
      customer: "Blue Harbour Labs",
      amountUsd: 3_150.5,
      status: "paid",
      updatedAt: daysAgo(23),
      changeNote: null,
    },
    {
      id: "INV-0019",
      customer: "Cedar & Co",
      amountUsd: 890.0,
      status: "draft",
      updatedAt: daysAgo(41),
      changeNote: null,
    },
  ];
}

function fakeActivity(now = new Date()) {
  const hoursAgo = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  return [
    { at: hoursAgo(48), actor: "billing-bot", action: "invoice.status_changed", subject: "INV-0007", detail: "sent -> overdue" },
    { at: hoursAgo(120), actor: "avery@example.test", action: "invoice.viewed", subject: "INV-0012", detail: "opened the PDF" },
    { at: hoursAgo(500), actor: "avery@example.test", action: "invoice.created", subject: "INV-0019", detail: "draft created" },
  ];
}

const TOOLS = [
  {
    name: "get_invoices",
    title: "Get invoices",
    description:
      "List the workspace's invoices with their id, customer, amount, status and last-updated timestamp. Use this to answer any question about invoices, including which ones changed recently.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Optional status filter: draft, sent, paid or overdue.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_activity",
    title: "Get activity",
    description:
      "Recent activity log entries for the workspace, newest first. Use this to explain why something changed.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Maximum entries to return.", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
];

function runTool(name, args) {
  if (name === "get_invoices") {
    const status = typeof args?.status === "string" ? args.status.toLowerCase() : null;
    const rows = fakeInvoices().filter((row) => !status || row.status === status);
    return { invoices: rows, count: rows.length, generatedAt: new Date().toISOString() };
  }
  if (name === "get_activity") {
    const limit = Number.isInteger(args?.limit) ? Math.max(1, Math.min(50, args.limit)) : 20;
    const rows = fakeActivity().slice(0, limit);
    return { activity: rows, count: rows.length };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Server                                                                      */
/* -------------------------------------------------------------------------- */

function readArg(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

const argv = process.argv.slice(2);
const host = readArg(argv, "--host", "127.0.0.1");
const port = Number(readArg(argv, "--port", "0"));
const logPath = path.resolve(readArg(argv, "--log", path.join(process.cwd(), "mcp-calls.jsonl")));

fs.mkdirSync(path.dirname(logPath), { recursive: true });
// Truncate so a run never inherits a previous run's evidence.
fs.writeFileSync(logPath, "");

function appendLog(entry) {
  try {
    fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (error) {
    process.stderr.write(`demodata: could not write the call log: ${String(error)}\n`);
  }
}

const sessions = new Set();

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function handleMessage(message, sessionId) {
  const { id, method, params } = message ?? {};

  switch (method) {
    case "initialize":
      return jsonRpcResult(id, {
        // Echo the client's protocol version when we can speak it; the client
        // aborts on a version it did not offer.
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "demodata", version: "0.1.0" },
        instructions:
          "Fake invoice and activity data for the DataDesk demo. All values are synthetic.",
      });

    case "ping":
      return jsonRpcResult(id, {});

    case "tools/list":
      return jsonRpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const output = runTool(name, args);
      appendLog({ kind: "tools/call", tool: name, args, sessionId, ok: output !== null });
      if (output === null) {
        return jsonRpcResult(id, {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${String(name)}` }],
        });
      }
      return jsonRpcResult(id, {
        // `structuredContent` is the modern field; the text block keeps older
        // clients (and any model reading raw text) working unchanged.
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
        isError: false,
      });
    }

    // Everything else the client may probe for. Answering "method not found"
    // is correct and the client treats it as "capability absent".
    default:
      if (typeof method === "string" && method.startsWith("notifications/")) return null;
      return jsonRpcError(id, -32601, `Method not found: ${String(method)}`);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, tools: TOOLS.map((tool) => tool.name), log: logPath }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  if (req.method === "GET") {
    // No server-initiated messages, so the optional SSE channel is declined.
    res.writeHead(405, { allow: "POST, DELETE" });
    res.end();
    return;
  }

  if (req.method === "DELETE") {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") sessions.delete(sessionId);
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST, DELETE" });
    res.end();
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
      return;
    }

    const batch = Array.isArray(payload) ? payload : [payload];
    const isInitialize = batch.some((message) => message?.method === "initialize");
    let sessionId =
      typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : null;
    if (isInitialize) {
      sessionId = randomUUID();
      sessions.add(sessionId);
    }

    const responses = batch
      .map((message) => handleMessage(message, sessionId))
      .filter((entry) => entry !== null);

    const headers = { "content-type": "application/json" };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    if (responses.length === 0) {
      // A batch of pure notifications gets an accepted-with-no-body reply.
      res.writeHead(202, sessionId ? { "mcp-session-id": sessionId } : {});
      res.end();
      return;
    }

    res.writeHead(200, headers);
    res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
  });
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      url: `http://${host}:${actualPort}/mcp`,
      port: actualPort,
      log: logPath,
    })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Do not wait forever on keep-alive sockets during teardown.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
