#!/usr/bin/env node

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureRuntime,
  jsonRpcRequestSequence,
  resolveDevAppVersion,
  resolveDevSocketPath,
  resolveProjectRoot,
} from "../../../scripts/dev-shared.mjs";

const bridgePath = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(bridgePath), "..");
const defaultPort = 18765;

function bridgeInitializeParams() {
  return {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "ade-browser-bridge", version: resolveDevAppVersion() },
    identity: {
      role: "external",
      callerId: `ade-browser-bridge:${process.pid}`,
      computerUsePolicy: {
        mode: "auto",
        allowLocalFallback: false,
        retainArtifacts: true,
      },
    },
  };
}

function readRuntimeInfo(value) {
  const runtimeInfo =
    value && typeof value === "object" && !Array.isArray(value)
      ? value.runtimeInfo
      : null;
  if (!runtimeInfo || typeof runtimeInfo !== "object" || Array.isArray(runtimeInfo)) {
    return { version: null };
  }
  const version = typeof runtimeInfo.version === "string" && runtimeInfo.version.trim()
    ? runtimeInfo.version.trim()
    : null;
  return { version };
}

function readProjectId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
  return projectId || null;
}

function unwrapActionResult(value, request) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = /** @type {Record<string, unknown>} */ (value);
    if (record.ok === false) {
      const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
        ? /** @type {Record<string, unknown>} */ (record.error)
        : {};
      throw new Error(typeof error.message === "string" ? error.message : "ADE runtime action failed.");
    }
    return record.result;
  }
  return value;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

function projectNameFromRoot(projectRoot) {
  return path.basename(projectRoot) || "ADE project";
}

async function rpcCall(socketPath, method, params, timeoutMs = 15_000) {
  return jsonRpcRequestSequence(
    socketPath,
    [
      { method: "ade/initialize", params: bridgeInitializeParams() },
      { method, params },
    ],
    { timeoutMs },
  );
}

async function createBridgeState() {
  const projectRoot = resolveProjectRoot();
  const socketPath = resolveDevSocketPath();
  await ensureRuntime(socketPath, projectRoot);

  const runtimeVersion = readRuntimeInfo(
    await jsonRpcRequestSequence(
      socketPath,
      [{ method: "ade/initialize", params: bridgeInitializeParams() }],
      { timeoutMs: 10_000 },
    ),
  ).version;

  const projectResult = await jsonRpcRequestSequence(
    socketPath,
    [
      { method: "ade/initialize", params: bridgeInitializeParams() },
      { method: "projects.add", params: { rootPath: projectRoot } },
    ],
    { timeoutMs: 10_000 },
  );
  const projectId = readProjectId(projectResult);
  if (!projectId) {
    throw new Error("ADE runtime did not return a projectId from projects.add.");
  }

  return {
    projectRoot,
    socketPath,
    projectId,
    runtimeVersion,
  };
}

async function callAction(state, request) {
  const value = await rpcCall(
    state.socketPath,
    "ade/actions/call",
    {
      projectId: state.projectId,
      name: "run_ade_action",
      arguments: {
        domain: request.domain,
        action: request.action,
        ...(request.args ? { args: request.args } : {}),
        ...(Object.prototype.hasOwnProperty.call(request, "arg") ? { arg: request.arg } : {}),
        ...(request.argsList ? { argsList: request.argsList } : {}),
      },
    },
    30_000,
  );
  return unwrapActionResult(value, request);
}

async function callSync(state, method, params = {}) {
  return rpcCall(
    state.socketPath,
    method,
    { projectId: state.projectId, ...params },
    15_000,
  );
}

async function main() {
  const port = Number.parseInt(process.env.ADE_BROWSER_BRIDGE_PORT ?? "", 10) || defaultPort;
  const state = await createBridgeState();

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          projectRoot: state.projectRoot,
          socketPath: state.socketPath,
          projectId: state.projectId,
          runtimeVersion: state.runtimeVersion,
          projectName: projectNameFromRoot(state.projectRoot),
        });
        return;
      }

      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method not allowed." });
        return;
      }

      const body = await readJsonBody(req);

      if (url.pathname === "/action") {
        const domain = typeof body.domain === "string" ? body.domain.trim() : "";
        const action = typeof body.action === "string" ? body.action.trim() : "";
        if (!domain || !action) {
          sendJson(res, 400, { ok: false, error: "domain and action are required." });
          return;
        }
        const result = await callAction(state, {
          domain,
          action,
          ...(body.args !== undefined ? { args: body.args } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "arg") ? { arg: body.arg } : {}),
          ...(body.argsList ? { argsList: body.argsList } : {}),
        });
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (url.pathname === "/sync") {
        const method = typeof body.method === "string" ? body.method.trim() : "";
        if (!method) {
          sendJson(res, 400, { ok: false, error: "method is required." });
          return;
        }
        const params = body.params && typeof body.params === "object" && !Array.isArray(body.params)
          ? body.params
          : {};
        const result = await callSync(state, method, params);
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (url.pathname === "/lane") {
        const action = typeof body.action === "string" ? body.action.trim() : "";
        if (!action) {
          sendJson(res, 400, { ok: false, error: "action is required." });
          return;
        }
        const result = await callAction(state, {
          domain: "lane",
          action,
          ...(body.args !== undefined ? { args: body.args } : {}),
        });
        sendJson(res, 200, { ok: true, result });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, error: message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  process.stdout.write(
    `[ade] browser runtime bridge listening on http://127.0.0.1:${port} (project ${state.projectRoot})\n`,
  );

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
